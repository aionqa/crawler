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

export async function analyzePageWithActions({ url, title, content, links, fields }, prompt) {
    const aiVarKeys = Object.keys(aiVars);

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
