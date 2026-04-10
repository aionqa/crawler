/**
 * URL path suggests a direct image/svg asset (not an HTML document).
 * Used so we avoid fullPage when page.evaluate is unavailable or flaky.
 */
function urlSuggestsStandaloneImageDocument(pageUrl) {
  if (!pageUrl || typeof pageUrl !== 'string') return false;
  const pathOnly = pageUrl.split(/[?#]/)[0];
  const lower = pathOnly.toLowerCase();
  if (lower.endsWith('.svg')) return true;
  return /\.(svg|png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(pathOnly);
}

/**
 * Resolves whether Playwright should use fullPage for a screenshot.
 * Standalone SVG/image documents (non-HTML) often cause fullPage captures to hang
 * until the step timeout (Chromium rasterizing unbounded or mis-sized scroll areas).
 */
export async function resolveScreenshotFullPage(page, config = {}) {
  const wantsFull = config.fullPage !== false;
  if (!wantsFull) return false;
  if (config.allowRiskyFullPageOnImageDocument === true) return true;

  let urlLooksLikeAsset = false;
  try {
    urlLooksLikeAsset = urlSuggestsStandaloneImageDocument(page.url());
  } catch {
    // ignore
  }
  if (urlLooksLikeAsset) return false;

  try {
    const useViewportOnly = await page.evaluate(() => {
      const ct = (document.contentType || '').toLowerCase();
      if (ct === 'image/svg+xml') return true;
      if (ct.startsWith('image/')) return true;
      const root = document.documentElement;
      if (root?.tagName?.toLowerCase() === 'svg') return true;
      return false;
    });
    if (useViewportOnly) return false;
  } catch {
    try {
      if (urlSuggestsStandaloneImageDocument(page.url())) return false;
    } catch {
      // ignore
    }
    // Transient navigation / closed page: keep full-page for normal HTML when URL is not an obvious asset.
  }
  return true;
}
