import { chat } from './client.js';

export function buildCodegenMessages(promptText) {
  return [
    { role: 'system', content: 'You generate Playwright JavaScript. Return ONLY executable statements, no wrapper, no imports, no comments.' },
    { role: 'user', content: promptText }
  ];
}

export async function generateActionStatements(promptText) {
  const messages = buildCodegenMessages(promptText);
  return await chat(messages);
}
