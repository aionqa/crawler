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
