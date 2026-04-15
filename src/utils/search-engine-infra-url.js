/**
 * Crawler/indexing infrastructure URLs — not human-facing HTML app shells.
 * Includes robots/sitemaps, well-known, and PWA/build JSON manifests (not crawl targets).
 * Skip for crawl queue, link discovery, recursive crawl targets, SEO/content steps, and backend discover.
 */
export function isSearchEngineInfraUrl(urlString) {
  if (urlString == null || urlString === '') return false;
  const raw = String(urlString).trim();
  if (!raw) return false;
  let pathname = '';
  try {
    const u = raw.includes('://') ? new URL(raw) : new URL(raw, 'https://placeholder.invalid');
    pathname = u.pathname || '/';
  } catch {
    return false;
  }
  const path = pathname.toLowerCase();

  if (path === '/robots.txt' || path.endsWith('/robots.txt')) return true;
  if (path === '/llms.txt' || path.endsWith('/llms.txt')) return true;
  if (path === '/ai.txt' || path.endsWith('/ai.txt')) return true;
  if (path === '/humans.txt' || path.endsWith('/humans.txt')) return true;
  if (path === '/ads.txt' || path.endsWith('/ads.txt')) return true;
  if (path === '/app-ads.txt' || path.endsWith('/app-ads.txt')) return true;
  if (path === '/security.txt' || path.endsWith('/security.txt')) return true;
  if (path.startsWith('/.well-known/')) return true;

  if (/sitemap[^/]*\.xml(\.gz)?$/i.test(path)) return true;
  if (path === '/sitemap.txt' || path.endsWith('/sitemap.txt')) return true;

  if (path.endsWith('/manifest.json') || path === '/manifest.json') return true;
  if (path.endsWith('.webmanifest') || path.endsWith('/site.webmanifest')) return true;
  if (/\/asset-manifest\.json$/i.test(path)) return true;
  if (/\/build-manifest\.json$/i.test(path)) return true;
  if (/\/precache-manifest\.json$/i.test(path)) return true;

  return false;
}
