/**
 * Canonical navigation target string for comparing "requested URL" vs "rendered URL".
 * Mirrors workflow queue canonicalization in unified-operations (`canonicalizeUrl` + ensureUrlHasScheme).
 */

export function ensureUrlHasScheme(url) {
  if (!url || typeof url !== 'string') return url;
  const t = url.trim();
  if (t.startsWith('http://') || t.startsWith('https://')) return t;
  return `https://${t}`;
}

function normalizeHashRouteFragment(fragmentRaw) {
  const fragment = String(fragmentRaw || '').replace(/^#/, '').trim();
  if (!fragment) return '';
  if (fragment.startsWith('/') || fragment.startsWith('!/')) return fragment;
  if (fragment.startsWith('!') && fragment.length > 1) return fragment;
  if (/^[a-z0-9][a-z0-9._~/-]*\/[a-z0-9._~/-]+$/i.test(fragment)) return fragment;
  return '';
}

/**
 * @param {string|null|undefined} url
 * @returns {string} stable key, or '' if not a normalizable http(s) URL
 */
export function navigationTargetKey(url) {
  const withScheme = ensureUrlHasScheme(url);
  if (!withScheme) return '';
  try {
    const u = new URL(withScheme);
    const routeHash = normalizeHashRouteFragment(u.hash);
    u.hash = '';
    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
      u.port = '';
    }
    const normalizedPath = u.pathname.replace(/\/+$/, '') || '/';
    const base = `${u.protocol}//${u.host}${normalizedPath}${u.search}`;
    return routeHash ? `${base}#${routeHash}` : base;
  } catch {
    const raw = String(withScheme);
    const noHash = raw.split('#')[0];
    const routeHash = normalizeHashRouteFragment(raw.includes('#') ? raw.split('#').slice(1).join('#') : '');
    const base = noHash.replace(/\/+$/, '') || noHash;
    return routeHash ? `${base}#${routeHash}` : base;
  }
}
