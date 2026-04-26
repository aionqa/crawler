/**
 * Syntax repairs for AI-generated Playwright scripts executed via `new Function` on the
 * main workflow (login, execute-code) path. Mirrors the high-signal early passes of
 * `workflow/analysis/workflow-analyzer.js` `cleanScript` / `sanitizeAiPlaywrightScript`
 * so generated login scripts do not fall back with `Unexpected token ')'` from unquoted
 * CSS-like tokens or common LLM glitches. General — no site/URL allowlists.
 */

import { stripCommonAiTypeScriptCasts } from './normalize-playwright-network-idle.js';

/** Private-use placeholder so `//` inside `https://` is not treated as a line comment. */
const URL_SCHEME_SLASHES_PLACEHOLDER = '\uE000AIONQA_SCHEME_SLASHES\uE001';

/**
 * Strip `// ...` line comments without corrupting `http(s)://`, `ws(s)://`, or `ftp://` inside literals.
 * A naive global regex that removes from `//` to newline also matches the slashes inside `https://`
 * host text and breaks `new Function` parsing (must mask URL schemes before stripping).
 * @param {string} script
 * @returns {string}
 */
export function stripLineCommentsPreservingUrlSchemes(script) {
  if (!script || typeof script !== 'string') return script;
  const masked = script.replace(/\b(https?|wss?|ftp)(:\/\/)/gi, (_, scheme) => `${scheme}${URL_SCHEME_SLASHES_PLACEHOLDER}`);
  return masked.replace(/\/\/[^\n]*/g, '').split(URL_SCHEME_SLASHES_PLACEHOLDER).join('://');
}

/**
 * Find the closing `)` matching an opening `(` at `fromOpen`, respecting strings and line/block comments.
 * @param {string} s
 * @param {number} fromOpen index of `(`
 * @returns {number} index of `)` or -1
 */
function findMatchingCloseParen(s, fromOpen) {
  if (!s || fromOpen < 0 || fromOpen >= s.length || s[fromOpen] !== '(') return -1;
  let depth = 1;
  let inStr = null; // ' | " | `
  let esc = false;
  for (let i = fromOpen + 1; i < s.length; i++) {
    const c = s[i];
    const c2 = s[i + 1];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === '\\' && inStr !== '`') {
        esc = true;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      continue;
    }
    if (c === '/' && c2 === '/') {
      i += 1;
      while (i + 1 < s.length && s[i + 1] !== '\n' && s[i + 1] !== '\r') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i + 1 < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Remove `page.goto` / `await page.goto` calls for login jobs. A non-greedy `([\\s\\S]*?)\\)`
 * match stops at the first `)` and corrupts `page.goto(url, { waitUntil: ... })` and URLs with
 * `)`, leaving stray tokens that make `new Function` throw "Unexpected token ')'".
 * @param {string} script
 * @returns {string}
 */
export function stripPageGotoCallsForLoginScript(script) {
  if (!script || typeof script !== 'string') return script;
  const re = /\b(?:await\s+)?page\.goto\s*\(/g;
  let s = script;
  let m;
  while ((m = re.exec(s)) !== null) {
    const openParen = m.index + m[0].length - 1;
    const closeParen = findMatchingCloseParen(s, openParen);
    if (closeParen < 0) {
      re.lastIndex = m.index + 1;
      continue;
    }
    let end = closeParen + 1;
    while (end < s.length && /[\s\t]/.test(s[end])) end += 1;
    if (s[end] === ';') end += 1;
    s = s.slice(0, m.index) + s.slice(end);
    re.lastIndex = Math.max(0, m.index);
  }
  return s;
}

/**
 * LLMs sometimes emit an extra `)` inside a quoted Playwright selector (or a surplus `)` after
 * .catch(() => null)) which makes `new Function` throw "Unexpected token ')'".
 * Mirrors `workflow/analysis/workflow-analyzer.js` repairLocatorQuotedSelectorParenBalance, plus
 * `page.goto` (URL strings) and a trailing `.catch` cleanup.
 * @param {string} script
 * @returns {string}
 */
export function repairQuotedSelectorParenBalanceInAiScript(script) {
  if (!script || typeof script !== 'string') return script;
  const fixInner = (inner) => {
    let s = inner;
    while (s.length > 0 && s.endsWith(')')) {
      const opens = (s.match(/\(/g) || []).length;
      const closes = (s.match(/\)/g) || []).length;
      if (closes <= opens) break;
      s = s.slice(0, -1);
    }
    return s;
  };
  let s = script;
  s = s.replace(
    /\b([A-Za-z_$][\w$]*)\.(locator|frameLocator)\s*\(\s*(['"])((?:\\.|(?!\3).)*)\3/g,
    (full, obj, method, q, body) => {
      const fixed = fixInner(body);
      return fixed === body ? full : `${obj}.${method}(${q}${fixed}${q}`;
    }
  );
  const pageSelectorMethods =
    'click|dblclick|fill|check|uncheck|hover|tap|press|focus|selectOption|waitForSelector|locator|getByPlaceholder|getByText|getByLabel|getByTitle|getByAltText|goto';
  s = s.replace(
    new RegExp(
      `\\bpage\\.(${pageSelectorMethods})\\s*\\(\\s*(['"])((?:\\\\.|(?!\\2).)*)\\2`,
      'g',
    ),
    (full, method, q, body) => {
      const fixed = fixInner(body);
      return fixed === body ? full : `page.${method}(${q}${fixed}${q}`;
    }
  );
  // Surplus closing paren after a null-returning .catch (common in AI login scripts)
  s = s.replace(
    /\.catch\s*\(\s*\(\s*\)\s*=>\s*(?:null|undefined)\s*\)\s*\)\s*$/gm,
    '.catch(() => null)',
  );
  s = s.replace(
    /\.catch\s*\(\s*\(\s*\)\s*=>\s*(?:null|undefined)\s*\)\s*\)\s*;/g,
    '.catch(() => null);',
  );
  // `)).catch(() => null)` on promise chains (extra `)` before .catch) — keep single closing paren
  s = s.replace(
    /\)\s*\)\s*(\.catch\s*\(\s*\(\s*\)\s*=>\s*(?:null|undefined)\s*\))/g,
    ')$1',
  );
  return s;
}

/**
 * @param {string} script
 * @returns {string}
 */
/**
 * LLMs sometimes emit `.catch` then a newline and a bare `await` statement, omitting the required
 * `(handler)` — often followed by a stray `});` left from a half-erased arrow function. That makes
 * `new Function` throw `Unexpected token ')'` before any runtime execution.
 * @param {string} script
 * @returns {string}
 */
export function repairMangledMultilineCatchMissingOpenParen(script) {
  if (!script || typeof script !== 'string') return script;
  let s = script;
  for (let i = 0; i < 12; i += 1) {
    const next = s.replace(
      /\.catch\s*\r?\n\s*(await\s+[^;]+;)\s*\r?\n\s*\}\s*\)\s*;/g,
      '.catch(async () => { $1 });',
    );
    if (next === s) break;
    s = next;
  }
  // Same glitch but closing is only `);` (no extra `}` before `)`)
  for (let i = 0; i < 12; i += 1) {
    const next = s.replace(
      /\.catch\s*\r?\n\s*(await\s+[^;]+;)\s*\r?\n\s*\)\s*;/g,
      '.catch(async () => { $1 });',
    );
    if (next === s) break;
    s = next;
  }
  // `return` variant (same structural bug)
  for (let i = 0; i < 12; i += 1) {
    const next = s.replace(
      /\.catch\s*\r?\n\s*(return\s+[^;]+;)\s*\r?\n\s*\}\s*\)\s*;/g,
      '.catch(() => { $1 });',
    );
    if (next === s) break;
    s = next;
  }
  return s;
}

export function applyAiPlaywrightExecutionRepairs(script) {
  if (!script || typeof script !== 'string') return script;
  let cleaned = script.trim();
  if (!cleaned) return cleaned;

  cleaned = repairMangledMultilineCatchMissingOpenParen(cleaned);

  // Models often duplicate the closing `)` after `.catch(() => null)` mid-script (not only EOL) → Unexpected token ')'.
  for (let i = 0; i < 16; i += 1) {
    const next = cleaned.replace(
      /\.catch\s*\(\s*\(\s*\)\s*=>\s*(?:null|undefined)\s*\)\s*\)+/g,
      '.catch(() => null)',
    );
    if (next === cleaned) break;
    cleaned = next;
  }

  // Extra `)` after page.goto when the URL arg is a simple identifier (e.g. `await page.goto(link))`).
  cleaned = cleaned.replace(/\b(await\s+)?page\.goto\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\)/g, (_m, aw, id) =>
    `${aw ? 'await ' : ''}page.goto(${id})`,
  );
  // Same for quoted URL literals: `page.goto('https://...'))`
  cleaned = cleaned.replace(
    /\b(await\s+)?page\.goto\s*\(\s*(['"])((?:\\.|(?!\2).)*)\2\s*\)\s*\)/g,
    (_m, aw, q, body) => `${aw ? 'await ' : ''}page.goto(${q}${body}${q})`,
  );

  cleaned = cleaned.replace(/\u2018|\u2019/g, "'").replace(/\u201C|\u201D/g, '"').replace(/\u2026/g, '...');
  cleaned = cleaned.replace(/page\.locator\(\s*text\s*=\s*"([^"]+)"\s*\)/g, "page.locator('text=\"$1\"')");
  cleaned = cleaned.replace(/page\.locator\(\s*text\s*=\s*'([^']+)'\s*\)/g, "page.locator('text=$1')");
  cleaned = cleaned.replace(
    /(^|\n)(\s*)((?:await\s+)?page\.fill\(\s*)(#[A-Za-z0-9_-]+)\s*\)/g,
    (m, lineStart, indent, lead, id) => {
      const hadAwait = /^await\s+/i.test(lead);
      const inner = `page.fill(${JSON.stringify(String(id || ''))})`;
      return `${lineStart}${indent}${hadAwait ? `await ${inner}` : inner}`;
    }
  );
  cleaned = cleaned.replace(
    /(^|\n)(\s*)((?:await\s+)?page\.fill\(\s*)(#[A-Za-z0-9_-]+)\s*,/g,
    (m, lineStart, indent, lead, id) => {
      const hadAwait = /^await\s+/i.test(lead);
      const inner = `page.fill(${JSON.stringify(String(id || ''))},`;
      return `${lineStart}${indent}${hadAwait ? `await ${inner}` : inner}`;
    }
  );
  cleaned = cleaned.replace(
    /(^|\n)(\s*)((?:await\s+)?page\.selectOption\(\s*)(#[A-Za-z0-9_-]+)\s*,/g,
    (m, lineStart, indent, lead, id) => {
      const hadAwait = /^await\s+/i.test(lead);
      const inner = `page.selectOption(${JSON.stringify(String(id || ''))},`;
      return `${lineStart}${indent}${hadAwait ? `await ${inner}` : inner}`;
    }
  );
  cleaned = cleaned.replace(
    /\b((?:await\s+)?page\.(click|dblclick|hover|tap|check|uncheck)\(\s*)([a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z][a-zA-Z0-9_-]*)+)\s*\)/g,
    (m, lead, method, sel) => {
      const hadAwait = /^await\s+/i.test(lead);
      const call = `page.${method}('${String(sel).replace(/'/g, "\\'")}')`;
      return `${hadAwait ? 'await ' : ''}${call}`;
    }
  );
  cleaned = cleaned.replace(
    /\b((?:await\s+)?page\.fill\(\s*)([a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z][a-zA-Z0-9_-]*)+)\s*,/g,
    (m, lead, sel) => {
      const hadAwait = /^await\s+/i.test(lead);
      const call = `page.fill('${String(sel).replace(/'/g, "\\'")}',`;
      return `${hadAwait ? 'await ' : ''}${call}`;
    }
  );
  cleaned = cleaned.replace(
    /(^|\n)(\s*)((?:await\s+)?page\.(click|fill|check|uncheck|isVisible|waitForSelector)\(\s*)([a-zA-Z][^'"`)\n]*(?:\[[^\)\n]+\]|:[^)\n]+)[^)\n]*)\s*\)/g,
    (m, lineStart, indent, lead, method, sel) => {
      const selector = String(sel || '').trim();
      // Multi-arg calls (options object, timeout, state) must not be collapsed into one quoted string —
      // that breaks parsing with errors like `Unexpected token ')'` (e.g. waitForSelector(selector, { state: ... })).
      if (selector.includes(',')) return m;
      // Bare JS identifier = variable holding a selector handle, not a CSS literal to quote.
      if (/^[A-Za-z_$][\w$]*$/.test(selector)) return m;
      const hadAwait = /^await\s+/i.test(lead);
      const call = `page.${method}('${selector.replace(/'/g, "\\'")}')`;
      return `${lineStart}${indent}${hadAwait ? `await ${call}` : call}`;
    }
  );
  cleaned = cleaned.replace(
    /page\.waitForSelector\(\s*([^'"`][^)\n]*)\s*\)/g,
    (m, raw) => {
      const value = String(raw || '').trim();
      if (!value || value.startsWith('{')) return m;
      if (value.includes(',')) {
        return `page.waitForSelector(${value})`;
      }
      if (/^[a-zA-Z_$][\w$]*$/.test(value)) {
        return `page.waitForSelector(${value})`;
      }
      return `page.waitForSelector('${value.replace(/'/g, "\\'")}')`;
    }
  );
  // Cypress/jQuery :contains → Playwright :has-text
  cleaned = cleaned.replace(/:contains\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g, ':has-text("$1")');
  cleaned = cleaned.replace(/:contains\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g, ":has-text('$1')");
  // `page.goto(https://...)` / `await page.goto(https://...)` without a string literal
  cleaned = cleaned.replace(
    /(\bawait\s+)?page\.goto\(\s*(https?:\/\/[^,)\s]+)\s*,/gi,
    (m, aw, url) => `${aw || ''}page.goto(${JSON.stringify(String(url))},`
  );
  cleaned = cleaned.replace(
    /(\bawait\s+)?page\.goto\(\s*(https?:\/\/[^)\s]+)\s*\)/gi,
    (m, aw, url) => `${aw || ''}page.goto(${JSON.stringify(String(url))})`
  );
  // Bare load-state tokens (invalid JS / parse errors): waitForLoadState(domcontentloaded)
  cleaned = cleaned.replace(
    /\b(await\s+)?page\.waitForLoadState\s*\(\s*(domcontentloaded|networkidle|load)\s*\)/gi,
    (_m, aw, state) => {
      const lit = JSON.stringify(String(state || '').toLowerCase());
      return `${aw ? 'await ' : ''}page.waitForLoadState(${lit})`;
    },
  );
  // Truncated first arg to waitForSelector (unterminated string) — breaks `new Function` parsing
  cleaned = cleaned.replace(
    /^\s*await\s+page\.waitForSelector\(\s*(['"])(?:\\.|(?!\1).)*$/gm,
    (full) => {
      const indent = String(full.match(/^\s*/)?.[0] || '');
      return `${indent}await page.waitForTimeout(500); /* repaired unterminated waitForSelector */`;
    }
  );
  // Multiselector union typos with a surplus `)` (analysis/workflow-analyzer)
  cleaned = cleaned.replace(
    /(button\[type=(?:['"]submit['"]|\\"submit\\")\]\s*,\s*button)\)/gi,
    '$1',
  );
  cleaned = cleaned.replace(
    /(input\[type=(?:['"]submit['"]|\\"submit\\")\]\s*,\s*(?:button|input))\)/gi,
    '$1',
  );
  cleaned = repairQuotedSelectorParenBalanceInAiScript(cleaned);
  cleaned = stripCommonAiTypeScriptCasts(cleaned);
  cleaned = repairQuotedSelectorParenBalanceInAiScript(cleaned);
  return cleaned;
}
