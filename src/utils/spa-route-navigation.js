/**
 * SPA route navigation helpers for crawlers.
 * Ensures queued client-side routes (Vue/React router) reach the requested path
 * instead of being misclassified as redirect aliases to a default landing route.
 */

import { navigationPathKey, ensureUrlHasScheme } from './url-navigation-target-key.js';

export const SPA_CRAWL_SESSION_KEY = 'aionqa_spa_crawl';

/** localStorage keys that force client routers back to a saved path (e.g. /stats). */
export const SPA_PERSISTED_ROUTE_STORAGE_KEYS = ['aionqa_route_state'];

/**
 * Runs before any page script on every navigation in the browser context.
 */
export function getSpaCrawlContextInitScript() {
  const sessionKey = SPA_CRAWL_SESSION_KEY;
  const storageKeys = SPA_PERSISTED_ROUTE_STORAGE_KEYS;
  return () => {
    try {
      sessionStorage.setItem(sessionKey, '1');
    } catch {
      // ignore
    }
    for (const key of storageKeys) {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
    }
  };
}

export async function applySpaCrawlContextInit(browserContext) {
  if (!browserContext || typeof browserContext.addInitScript !== 'function') return;
  await browserContext.addInitScript(getSpaCrawlContextInitScript());
}

export function spaPathKeysMatch(urlA, urlB) {
  const a = navigationPathKey(urlA);
  const b = navigationPathKey(urlB);
  return Boolean(a && b && a === b);
}

/**
 * Same origin, different pathname — typical SPA menu route vs default landing route.
 * Excludes cross-origin (true HTTP redirects / SSO).
 */
export function isSpaSameOriginPathMismatch(requestedUrl, actualUrl) {
  const req = ensureUrlHasScheme(requestedUrl);
  const act = ensureUrlHasScheme(actualUrl);
  if (!req || !act) return false;
  try {
    const r = new URL(req);
    const a = new URL(act);
    if (r.origin !== a.origin) return false;
    const reqPath = navigationPathKey(req);
    const actPath = navigationPathKey(act);
    return Boolean(reqPath && actPath && reqPath !== actPath);
  } catch {
    return false;
  }
}

async function clearSpaPersistedRouteState(page) {
  const sessionKey = SPA_CRAWL_SESSION_KEY;
  const storageKeys = SPA_PERSISTED_ROUTE_STORAGE_KEYS;
  await page.evaluate(
    ({ sessionKey: sk, storageKeys: keys }) => {
      try {
        sessionStorage.setItem(sk, '1');
      } catch {
        // ignore
      }
      for (const key of keys) {
        try {
          localStorage.removeItem(key);
        } catch {
          // ignore
        }
      }
    },
    { sessionKey, storageKeys },
  ).catch(() => {});
}

async function readBrowserPathKey(page) {
  try {
    return navigationPathKey(page.url());
  } catch {
    return '';
  }
}

/**
 * Navigate to targetUrl and recover when the browser lands on a different same-origin path
 * (SPA route-restore / default landing route).
 *
 * @returns {Promise<{ success: boolean, finalUrl: string, recovered: boolean, targetKey: string, actualKey: string }>}
 */
export async function navigateToSpaRouteTarget(page, targetUrl, opts = {}) {
  const {
    waitUntil = 'domcontentloaded',
    timeout = 30000,
    settlementMs = 2500,
    maxRecoveryAttempts = 2,
    onLog = null,
  } = opts;

  const target = ensureUrlHasScheme(targetUrl);
  const targetKey = navigationPathKey(target);
  if (!target || !targetKey) {
    return { success: false, finalUrl: '', recovered: false, targetKey: '', actualKey: '' };
  }

  const log = (message, extra = {}) => {
    if (typeof onLog === 'function') {
      onLog(message, extra);
    }
  };

  async function attemptGoto(url, label) {
    await clearSpaPersistedRouteState(page);
    let response = null;
    try {
      response = await page.goto(url, { waitUntil, timeout });
    } catch (navErr) {
      log(`SPA nav ${label} goto error: ${navErr.message}`, { label, url });
    }
    await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeout, 30000) }).catch(() => {});
    await page.waitForTimeout(settlementMs);

    // Poll briefly — client routers may update the URL after domcontentloaded.
    const pollUntil = Date.now() + Math.min(settlementMs, 4000);
    let actualKey = await readBrowserPathKey(page);
    while (Date.now() < pollUntil && actualKey !== targetKey) {
      await page.waitForTimeout(200);
      actualKey = await readBrowserPathKey(page);
    }

    log(`SPA nav ${label}: target=${targetKey} actual=${actualKey}`, { label, url, actualKey, targetKey });
    return { response, actualKey, matched: actualKey === targetKey };
  }

  let last = await attemptGoto(target, 'primary');
  if (last.matched) {
    return {
      success: true,
      finalUrl: page.url(),
      recovered: false,
      targetKey,
      actualKey: last.actualKey,
      response: last.response ?? null,
    };
  }

  for (let i = 0; i < maxRecoveryAttempts; i++) {
    last = await attemptGoto(target, `recovery-${i + 1}`);
    if (last.matched) {
      return {
        success: true,
        finalUrl: page.url(),
        recovered: true,
        targetKey,
        actualKey: last.actualKey,
        response: last.response ?? null,
      };
    }
  }

  return {
    success: false,
    finalUrl: (() => {
      try {
        return page.url();
      } catch {
        return target;
      }
    })(),
    recovered: false,
    targetKey,
    actualKey: last.actualKey,
    response: last.response ?? null,
  };
}
