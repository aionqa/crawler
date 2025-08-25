import { chat } from './client.js';

export function buildJudgeMessages({ preUrl, postUrl, html, originalPageSummary, action }) {
  const trimmedHtml = String(html||'').replace(/\s+/g,' ').slice(0, 5000);
  return [
    { role: 'system', content:
`Strict QA judge. Reply compact JSON with keys:
{ classification: ["expected_result","failed_on_load","unexpected_result","infinite_error","continuation"],
  summary: <=30 words, expected: boolean, continuation: boolean, reasoning: <=60 words }` },
    { role: 'user', content:
`Initial URL: ${preUrl}
Result URL: ${postUrl}
Original page summary: ${originalPageSummary}
Action JSON:
${JSON.stringify(action, null, 2)}

Result HTML (truncated, ws-collapsed):
${trimmedHtml}

Heuristics:
- Success → expected_result.
- Same page but next step suggested → continuation=true.
- Explicit errors → unexpected_result.
- Never loaded → failed_on_load.

Return ONLY the JSON.` }
  ];
}

export async function judgeOutcome(ctx) {
  const messages = buildJudgeMessages(ctx);
  const raw = await chat(messages);
  try { return JSON.parse(raw); } catch { return { classification: 'unexpected_result', summary: 'Non-JSON', continuation: false }; }
}
