import { chat } from './client.js';

export function buildAnalyzePageMessages({ url, html, screenshotDataUrl }) {
  return [
    { role: 'system', content: 'You are a meticulous UI analyzer. Output STRICT JSON per schema. No prose.' },
    { role: 'user', content: [
        { type: 'text', text:
`Analyze ONLY this page.
- "page_summary": ≤ 40 words.
- "interactive_elements": each <form> is ONE action (container selectors, inputs[], submit_button).
- Include non-form buttons/links that matter.
Return STRICT JSON per schema, no commentary.` },
        { type: 'text', text: `URL: ${url}` },
        { type: 'text', text: `HTML (truncated):\n${html.slice(0,150000)}` },
        { type: 'image_url', image_url: { url: screenshotDataUrl, detail: 'low' } },
    ]},
  ];
}

export async function analyzePage({ url, html, screenshotDataUrl, response_format }) {
  const messages = buildAnalyzePageMessages({ url, html, screenshotDataUrl });
  const json = await chat(messages, { response_format });
  return json;
}
