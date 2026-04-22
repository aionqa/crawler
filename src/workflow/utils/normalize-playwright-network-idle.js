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

/**
 * Upper bound for page.setDefaultTimeout / setDefaultNavigationTimeout in AI journey scripts (ms).
 * 120s allowed multi-minute stalls on overlay/stacked-modal clicks (each locator can consume a full
 * default timeout). 45s matches journey screenshot / executor tightening elsewhere and reduces
 * whole-job timeout risk on SPA surfaces without site-specific tuning.
 */
const MAX_DEFAULT_PLAYWRIGHT_MS = 45000;

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

/**
 * Remove simple TypeScript `as` casts that `new Function` cannot parse ("Unexpected identifier 'as'").
 * Intentionally narrow: only `) as <identifier>` and `) as const` (common in AI output).
 * Broader "as" stripping risks corrupting natural-language strings or valid JS.
 */
export function stripCommonAiTypeScriptCasts(source) {
  if (typeof source !== 'string' || !source) return source;
  let s = source;
  s = s.replace(/\)\s+as\s+const\b/g, ')');
  for (let i = 0; i < 50; i++) {
    const next = s.replace(/\)\s+as\s+[A-Za-z_][A-Za-z0-9_]*\b/g, ')');
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * Wrap every literal-selector `await page.click("…")` / `await page.fill("…", …)` (and the
 * locator() variant `page.locator("…").click()`) with a fast pre-flight existence check so AI
 * scripts that target hallucinated selectors fail in <1s instead of stalling for the full
 * per-action default timeout. The screencast otherwise burns 5-30s of duplicate frames per
 * missing selector, mpdecimate trims them down, and the player shows the same screenshot
 * end-to-end ("nothing happens"). When the locator returns 0 elements we log a clear marker
 * (`__pre_flight_skip__`) and return early so the iteration loop can pick another selector.
 *
 * Only literal string selectors are wrapped — variable references / template literals /
 * computed expressions pass through unchanged because we cannot statically count them. Calls
 * that already include an explicit `{ timeout: N }` option pass through unchanged so the
 * author's intent is preserved.
 */
export function injectJourneyClickExistencePreflight(source) {
  if (typeof source !== 'string' || !source) return source;
  const PRE_FLIGHT_HELPER = `const __jrn_preflightSelector = async (sel, label) => {
  try {
    const cnt = await page.locator(sel).count();
    if (!cnt) {
      try { console.log('[journey-preflight] selector ' + JSON.stringify(sel) + ' not present in DOM (' + label + ')'); } catch (_) {}
      return false;
    }
  } catch (_) { return true; }
  return true;
};
`;
  let s = source;
  let injected = false;

  // page.click("…")  /  page.click('…')  with no options object
  s = s.replace(
    /\bawait\s+page\.click\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*\)\s*;?/g,
    (_full, q, sel) => {
      // Selectors like button:has-text("X") contain `)` inside the string. The naive `(?:\\.|(?!\\1).)*`
      // + `\s*\)` terminator can match the `)` that closes :has-text(...) instead of page.click(...),
      // producing invalid JS ("missing ) after argument list") and bogus preflight literals.
      if (sel.includes('(') || sel.includes(')')) {
        return _full;
      }
      injected = true;
      const literal = `${q}${sel}${q}`;
      return `if (await __jrn_preflightSelector(${literal}, 'click')) { await page.click(${literal}, { timeout: 8000 }).catch((__e) => ({ click_error: String(__e && __e.message || __e) })); }`;
    }
  );

  if (!injected) return source;
  return PRE_FLIGHT_HELPER + s;
}
