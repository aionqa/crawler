/**
 * Syntax repairs for AI-generated Playwright scripts executed via `new Function` on the
 * main workflow (login, execute-code) path. Mirrors the high-signal early passes of
 * `workflow/analysis/workflow-analyzer.js` `cleanScript` / `sanitizeAiPlaywrightScript`
 * so generated login scripts do not fall back with `Unexpected token ')'` from unquoted
 * CSS-like tokens or common LLM glitches. General — no site/URL allowlists.
 */

import { stripCommonAiTypeScriptCasts } from './normalize-playwright-network-idle.js';

/**
 * @param {string} script
 * @returns {string}
 */
export function applyAiPlaywrightExecutionRepairs(script) {
  if (!script || typeof script !== 'string') return script;
  let cleaned = script.trim();
  if (!cleaned) return cleaned;

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
      const hadAwait = /^await\s+/i.test(lead);
      const selector = String(sel || '').trim();
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
  cleaned = stripCommonAiTypeScriptCasts(cleaned);
  return cleaned;
}
