// ai.js
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Parse AI_VARS from .env
let aiVars = {};
try {
    aiVars = JSON.parse(process.env.AI_VARS || '{}');
} catch (err) {
    console.error('❌ Failed to parse AI_VARS from .env:', err.message);
}

export async function analyzePageWithActions({ url, title, content, links, fields }) {
    const prompt = `
You are an intelligent automation agent using Playwright.

Your task is to analyze a webpage and return **only executable JavaScript code** for Playwright that performs actions like filling in forms, clicking buttons, and waiting for navigation.

⚠️ You must:
- Use only the fields provided.
- Reference selectors like input#username, input[name='password'], etc.
- Use vars.username / vars.password as values.
- Track navigation using \`navigationOccurred = true\`.
- Strictly DO NOT include markdown code blocks or any text like "javascript".

✅ Example:
await page.fill('input#username', vars.username);
await page.fill('input#password', vars.password);

⚠️ Output ONLY valid JavaScript. Do NOT return explanations or JSON.
Only output raw JavaScript code.

Page Info:
- URL: ${url}
- Title: ${title}
- Total Links: ${links.length}
- Fields: ${JSON.stringify(fields.slice(0, 10), null, 2)}
- Content Snippet:
${content.slice(0, 1500)}
`;

    const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2
    });

    const message = completion.choices[0].message.content.trim();

    if (message.includes('```')) {
        // Remove any accidental code fences
        return message.replace(/```(js)?/g, '').trim();
    }

    return message;
}
