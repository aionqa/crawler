import { chat } from './client.js';

export function buildPromptForActionCoder({ pageDoc, action, project }) {
  const creds = project?.credentials || null;
  const looksLogin = /login|sign\s*in|authenticate/i.test(String(pageDoc?.page_summary||'')) ||
    hasLoginShape(action);
  const credHint = looksLogin && creds?.username && creds?.password
    ? 'Use project.credentials.username/password.'
    : 'If creds missing, use example_value or safe defaults.';

  return [
    { role: 'system', content: 'You are a senior prompt engineer. Craft a crisp prompt for a coding LLM.' },
    { role: 'user', content:
`Context:
- Page summary: ${pageDoc?.page_summary || 'N/A'}
- URL: ${pageDoc?.url || 'N/A'}
- Action JSON:
${JSON.stringify(action, null, 2)}
- Project credentials present: ${!!creds}

Goal: Write ONE instruction prompt that yields Playwright JS statements for async body { page, action, project, helpers }.

Constraints:
1) Navigate only if needed (caller already loaded).
2) Use action.selectors (prefer .best or .css).
3) ${credHint}
4) Click the action's submit when present.
5) Wait appropriately (navigation/networkidle).
6) No imports; only "page".
7) Use await.
8) No comments; just statements.
9) Idempotent & robust.

Return ONLY the prompt text.` }
  ];
}

function hasLoginShape(action) {
  const fields = (action?.inputs||[]).map(i =>
    `${(i?.name||'').toLowerCase()} ${(i?.id||'').toLowerCase()} ${(i?.label||'').toLowerCase()}`
  ).join(' ');
  return /(user|email|login)/i.test(fields) && /pass(word)?/i.test(fields);
}

export async function generateActionCoderPrompt(ctx) {
  const messages = buildPromptForActionCoder(ctx);
  return await chat(messages);
}
