/**
 * Normalize Playwright scripts away from waitUntil/waitForLoadState "networkidle".
 * SPAs, OAuth redirects, SockJS/WebSockets, analytics, and third-party scripts keep
 * the network busy indefinitely or cause spurious ERR_ABORTED during navigation —
 * a general automation limitation, not a per-site special case.
 */
export function replaceNetworkIdleWithDomContentLoadedForAutomation(source) {
  if (typeof source !== 'string' || !source) return source;
  let s = source;
  s = s.replace(/\bwaitForLoadState\s*\(\s*(['"])networkidle\1/gi, 'waitForLoadState($1domcontentloaded$1');
  s = s.replace(/\bwaitForLoadState\s*\(\s*`networkidle`\s*\)/gi, 'waitForLoadState(`domcontentloaded`)');
  s = s.replace(/\bwaitUntil\s*:\s*(['"])networkidle\1/gi, 'waitUntil: $1domcontentloaded$1');
  s = s.replace(/\bwaitUntil\s*:\s*`networkidle`/gi, 'waitUntil: `domcontentloaded`');
  // Rare AI output: load state passed as identifier without quotes
  s = s.replace(/\bwaitForLoadState\s*\(\s*networkidle\s*\)/gi, 'waitForLoadState(`domcontentloaded`)');
  return s;
}

/** Upper bound for page.setDefaultTimeout / setDefaultNavigationTimeout in AI journey scripts (ms). */
const MAX_DEFAULT_PLAYWRIGHT_MS = 120000;

/** Upper bound for waitForLoadState('domcontentloaded', …) — long values consume whole crawl budgets. */
const MAX_DOMCONTENTLOADED_WAIT_MS = 30000;

/**
 * Models often append setDefaultTimeout(900000) then waitForLoadState('domcontentloaded') with no per-call
 * cap, so Playwright inherits 15-minute action timeouts and workflow crawls hit the job ceiling while
 * journeys stay in-flight. Cap defaults and domcontentloaded waits generically.
 */
export function capPlaywrightAutomationTimeouts(source) {
  if (typeof source !== 'string' || !source) return source;
  let s = source;

  const capNumericPageMethod = (text, methodName) => {
    const re = new RegExp(
      `(\\b(?:await\\s+)?page\\.${methodName}\\s*\\(\\s*)(\\d+)(\\s*\\))`,
      'gi'
    );
    return text.replace(re, (_full, pre, numStr, post) => {
      const n = parseInt(String(numStr), 10);
      if (!Number.isFinite(n)) return `${pre}${numStr}${post}`;
      const capped = Math.min(n, MAX_DEFAULT_PLAYWRIGHT_MS);
      return `${pre}${capped}${post}`;
    });
  };

  s = capNumericPageMethod(s, 'setDefaultTimeout');
  s = capNumericPageMethod(s, 'setDefaultNavigationTimeout');

  s = s.replace(
    /\.waitForLoadState\s*\(\s*(['"`])domcontentloaded\1\s*,\s*\{\s*timeout\s*:\s*(\d+)\s*\}\s*\)/gi,
    (_full, q, numStr) => {
      const n = parseInt(String(numStr), 10);
      const capped = Number.isFinite(n) ? Math.min(n, MAX_DOMCONTENTLOADED_WAIT_MS) : MAX_DOMCONTENTLOADED_WAIT_MS;
      return `.waitForLoadState(${q}domcontentloaded${q}, { timeout: ${capped} })`;
    }
  );

  s = s.replace(
    /\.waitForLoadState\s*\(\s*(['"`])domcontentloaded\1\s*\)/gi,
    `.waitForLoadState($1domcontentloaded$1, { timeout: ${MAX_DOMCONTENTLOADED_WAIT_MS} })`
  );

  s = s.replace(
    /\.waitForLoadState\s*\(\s*domcontentloaded\s*\)/gi,
    `.waitForLoadState('domcontentloaded', { timeout: ${MAX_DOMCONTENTLOADED_WAIT_MS} })`
  );

  return s;
}
