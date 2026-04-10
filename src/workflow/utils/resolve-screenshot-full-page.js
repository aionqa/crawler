/**
 * Resolves whether Playwright should use fullPage for a screenshot.
 * Standalone SVG/image documents (non-HTML) often cause fullPage captures to hang
 * until the step timeout (Chromium rasterizing unbounded or mis-sized scroll areas).
 */
export async function resolveScreenshotFullPage(page, config = {}) {
  const wantsFull = config.fullPage !== false;
  if (!wantsFull) return false;
  if (config.allowRiskyFullPageOnImageDocument === true) return true;

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
    // Keep full-page if the document check fails (e.g. transient navigation)
  }
  return true;
}
