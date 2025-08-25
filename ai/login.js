import { chat } from './client.js';

export function buildLoginMessages({ loginUrl }) {
  return [
    { role: 'system', content:
`You generate Playwright JavaScript for robust login. Return ONLY executable statements, no wrapping function, no imports, no comments.
Constraints:
- Do NOT hardcode element IDs or names. Discover elements generically.
- Find a visible form with a password input.
- In the same form, find username/email by heuristics.
- Fill with project.credentials.username/password.
- Click submit (type=submit or text /log\\s*in|sign\\s*in|continue|next|submit/i).
- Wait for navigation, URL change, or networkidle.`},
    { role: 'user', content: `The login page URL is: ${loginUrl}\nVariables: { page, project, helpers }` }
  ];
}

export async function generateLoginStatements({ loginUrl }) {
  const messages = buildLoginMessages({ loginUrl });
  return await chat(messages);
}
