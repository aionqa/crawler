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
    const aiVarKeys = Object.keys(aiVars);
    const prompt = `
You are an intelligent automation agent using Playwright.

Your task is to analyze a webpage and return only executable JavaScript code for Playwright that performs actions like filling in forms, clicking buttons, and waiting for results.

⚠️ You must:
- Do not use require(), import statements, or external modules.
- Use selectors to interact with form elements and buttons.
- Use provided variable keys if appropriate for field inputs.
- After submitting the form, you must wait and observe what happens — the outcome is unknown.
- You must detect or infer the result by analyzing page behavior, DOM changes, or network responses.
- You must **collect the result** after submission (e.g. visible message, status text, navigation result) and store or log it clearly.
- Handle multiple possible outcomes (e.g. success, error, redirect).
- Do not use eval, unnecessary browser logs, or hardcoded content.
- Output only valid, executable JavaScript code — no markdown, no explanations.

keys from object "vars" ${aiVarKeys.join(', ')}

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

    if (message.includes('```') || message.toLowerCase().startsWith('javascript')) {
        // Remove code fences and any leading 'javascript' line
        return message
            .replace(/```(js|javascript)?/gi, '') // remove ```js or ```javascript
            .replace(/^javascript\s*/i, '')       // remove 'javascript' if it's the first word
            .trim();
    }


    return message;
}
