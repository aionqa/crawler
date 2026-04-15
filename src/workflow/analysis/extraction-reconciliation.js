/**
 * Evidence-based reconciliation: compare Playwright DOM inventory with viewport screenshot + raw DOM
 * primitives before optionally augmenting from full HTML via AI. No site-specific URL lists — signals
 * are driven by mismatch between extraction and what the screenshot / DOM suggest.
 */

const HTML_SNIPPET_MAX = 200_000;

/** Wait for redirect chain to settle and SPA hydration windows before inventory. */
export async function settlePageUrlAfterNavigation(page, logFn = null) {
  if (!page || typeof page.url !== 'function') return;
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  } catch (_) {}
  let last = '';
  try {
    last = page.url();
  } catch (_) {
    return;
  }
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 400));
    let next = '';
    try {
      next = page.url();
    } catch (_) {
      break;
    }
    if (next === last) break;
    last = next;
  }
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  } catch (_) {}
  if (logFn) logFn(`[EXTRACTION_RECONCILIATION] settle_complete url=${last}`);
}

/** Cheap DOM primitive counts (cross-check vs Playwright structured extractors). */
export async function getDomInventoryPrimitives(page) {
  if (!page || typeof page.evaluate !== 'function') {
    return {
      approximateInteractiveNodes: 0,
      anchorCount: 0,
      buttonInputCount: 0,
      roleControlCount: 0,
    };
  }
  try {
    return await page.evaluate(() => {
      const q = (sel) => document.querySelectorAll(sel).length;
      const anchors = q('a[href]');
      const bi = q('button') + q('input') + q('select') + q('textarea');
      const roles = q('[role="button"]') + q('[role="link"]') + q('[role="menuitem"]');
      const approx = anchors + bi + roles;
      return {
        approximateInteractiveNodes: approx,
        anchorCount: anchors,
        buttonInputCount: bi,
        roleControlCount: roles,
      };
    });
  } catch {
    return {
      approximateInteractiveNodes: 0,
      anchorCount: 0,
      buttonInputCount: 0,
      roleControlCount: 0,
    };
  }
}

export function summarizePlaywrightInventoryScore(analysis) {
  if (!analysis || typeof analysis !== 'object') return 0;
  const forms = Array.isArray(analysis.forms) ? analysis.forms.length : 0;
  const links = Array.isArray(analysis.links) ? analysis.links.length : 0;
  const menus = Array.isArray(analysis.menu_items) ? analysis.menu_items.length : 0;
  const ie = Array.isArray(analysis.interactive_elements) ? analysis.interactive_elements.length : 0;
  return forms + links + menus + ie;
}

export function playwrightInventoryIsEmpty(analysis) {
  return summarizePlaywrightInventoryScore(analysis) === 0;
}

const VISION_TEMPLATE = {
  system_message:
    'You compare a browser viewport screenshot to structured crawler inventory. Reply with JSON only.',
  user_message_template: `You are assessing whether the VISIBLE UI in the screenshot looks like a rich web application (navigation, multiple controls, dashboard chrome) versus a bare page, raw JSON/text view, error interstitial, or trivial landing.

Playwright-structured inventory total score (forms+links+menus+interactive): {{playwright_score}}
Approximate DOM primitive interactive node count (anchors+inputs+buttons+roles): {{dom_primitive_nodes}}

Return strict JSON:
{"ui_surface_likelihood":"minimal|moderate|high","appears_like_raw_json_or_error_page":true|false,"visible_app_chrome_estimate":0,"reasoning":"short"}`,
  response_schema_description:
    '{"ui_surface_likelihood":"minimal|moderate|high","appears_like_raw_json_or_error_page":boolean,"visible_app_chrome_estimate":number,"reasoning":"string"}',
};

const HTML_EXTRACT_TEMPLATE = {
  system_message:
    'You extract link targets and interactive UI candidates from HTML for automation. Prefer id, name, role, href, data-testid. JSON only.',
  user_message_template: `The following is truncated page HTML. Extract candidate navigation links and interactive controls the same way a DOM walker would — do not invent elements not suggested by tags/attributes.

Page URL: {{page_url}}

HTML (truncated):
{{html_snippet}}

Return strict JSON:
{"links":[{"href":"string","text":"string","selector_hint":"string"}],"interactive_elements":[{"type":"string","selector_hint":"string","label":"string"}],"notes":"string"}`,
  response_schema_description:
    '{"links":[{"href":"string","text":"string","selector_hint":"string"}],"interactive_elements":[{"type":"string","selector_hint":"string","label":"string"}],"notes":"string"}',
};

/**
 * Vision assessment: screenshot vs inventory counts (uses aiLogger.makeAICallWithPrompt).
 */
export async function assessScreenshotVsPlaywrightInventory({
  aiLogger,
  jobId,
  pageUrl,
  screenshotBase64,
  playwrightScore,
  domPrimitives,
  projectId,
}) {
  if (!aiLogger || typeof aiLogger.makeAICallWithPrompt !== 'function' || !screenshotBase64) {
    return null;
  }
  const payload = {
    page_url: pageUrl,
    screenshot_base64: screenshotBase64,
    playwright_score: playwrightScore,
    dom_primitive_nodes: domPrimitives?.approximateInteractiveNodes ?? 0,
    project_id: projectId || null,
    projectId: projectId || null,
    text_format: 'json_object',
  };
  try {
    const raw = await aiLogger.makeAICallWithPrompt(
      'extraction_screenshot_inventory_check',
      payload,
      jobId,
      'extraction-reconciliation',
      pageUrl,
      null,
      payload,
      VISION_TEMPLATE,
      1,
      null,
      null,
      false,
      false,
    );
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return null;
  } catch (e) {
    console.warn('[extraction-reconciliation] vision assessment failed:', e?.message || e);
    return null;
  }
}

/**
 * When Playwright inventory is thin but HTML still contains structure, ask AI to list candidates.
 * Merged rows are tagged with provenance html_ai_reconciliation.
 */
export async function augmentInventoryFromHtmlAi({
  aiLogger,
  jobId,
  pageUrl,
  html,
  projectId,
}) {
  if (!aiLogger || typeof aiLogger.makeAICallWithPrompt !== 'function' || !html || !html.trim()) {
    return null;
  }
  const snippet = html.length > HTML_SNIPPET_MAX ? html.slice(0, HTML_SNIPPET_MAX) : html;
  const payload = {
    page_url: pageUrl,
    html_snippet: snippet,
    project_id: projectId || null,
    projectId: projectId || null,
    text_format: 'json_object',
  };
  try {
    const raw = await aiLogger.makeAICallWithPrompt(
      'extraction_html_inventory_fallback',
      payload,
      jobId,
      'extraction-reconciliation',
      pageUrl,
      null,
      payload,
      HTML_EXTRACT_TEMPLATE,
      1,
      null,
      null,
      false,
      false,
    );
    let obj = raw;
    if (typeof raw === 'string') {
      try {
        obj = JSON.parse(raw);
      } catch {
        return null;
      }
    }
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  } catch (e) {
    console.warn('[extraction-reconciliation] HTML AI augmentation failed:', e?.message || e);
    return null;
  }
}

/**
 * Merge HTML-AI candidates into existing analysis (does not remove Playwright rows).
 */
export function mergeHtmlAiCandidatesIntoAnalysis(analysis, htmlAiResult) {
  if (!analysis || typeof analysis !== 'object') return analysis;
  if (!htmlAiResult || typeof htmlAiResult !== 'object') return analysis;
  const out = { ...analysis };
  if (!Array.isArray(out.links)) out.links = [];
  if (!Array.isArray(out.interactive_elements)) out.interactive_elements = [];

  const seenH = new Set(out.links.map((l) => String(l?.href || '').trim()).filter(Boolean));

  const linksIn = Array.isArray(htmlAiResult.links) ? htmlAiResult.links : [];
  for (const L of linksIn) {
    if (!L || typeof L !== 'object') continue;
    const href = String(L.href || '').trim();
    if (!href || seenH.has(href)) continue;
    seenH.add(href);
    out.links.push({
      href,
      text: String(L.text || '').slice(0, 500),
      selector: String(L.selector_hint || '').slice(0, 500),
      provenance: 'html_ai_reconciliation',
    });
  }

  const ieIn = Array.isArray(htmlAiResult.interactive_elements) ? htmlAiResult.interactive_elements : [];
  let addIdx = 0;
  for (const E of ieIn) {
    if (!E || typeof E !== 'object') continue;
    const sel = String(E.selector_hint || '').trim();
    if (!sel) continue;
    addIdx += 1;
    out.interactive_elements.push({
      type: String(E.type || 'control').slice(0, 80),
      selector: sel.slice(0, 500),
      text: String(E.label || '').slice(0, 500),
      provenance: 'html_ai_reconciliation',
      html_ai_index: addIdx,
    });
  }

  out.extraction_sources = {
    ...(out.extraction_sources && typeof out.extraction_sources === 'object' ? out.extraction_sources : {}),
    html_ai_reconciliation: true,
  };
  return out;
}

export function shouldAttemptReconciliation({
  playwrightScore,
  domPrimitives,
  vision,
}) {
  const domN = domPrimitives?.approximateInteractiveNodes ?? 0;
  if (playwrightScore >= 8) return false;
  if (domN >= 14 && playwrightScore <= 3) return true;
  if (vision && typeof vision === 'object') {
    if (vision.appears_like_raw_json_or_error_page === true) return false;
    const lik = String(vision.ui_surface_likelihood || '').toLowerCase();
    if ((lik === 'moderate' || lik === 'high') && playwrightScore <= 4) return true;
  }
  return false;
}
