/**
 * When AI login validators return failure but the browser already holds a credible session
 * and the target app showed gateway/chunk/module load degradation, prefer runtime session
 * evidence over a degraded-render UI judgment. Domain-agnostic (no per-tenant shortcuts).
 */

export function evaluateLoginSessionEvidenceOverride({
  page,
  workflowState,
  validatePayload,
  determineResult,
  cleanExecution,
  seedUrl,
}) {
  try {
    if (!cleanExecution) return null;

    const cookies =
      (Array.isArray(workflowState?.collectedCookies) && workflowState.collectedCookies) ||
      (Array.isArray(workflowState?.finalCookies) && workflowState.finalCookies) ||
      [];
    if (!Array.isArray(cookies) || cookies.length < 2) return null;

    let currentUrl = '';
    try {
      currentUrl = page && typeof page.url === 'function' ? String(page.url() || '') : '';
    } catch (_) {}
    if (!currentUrl) {
      currentUrl = String(
        workflowState?.pageUrl ||
          workflowState?.lastKnownPageUrl ||
          workflowState?.expectedLoginUrl ||
          ''
      );
    }
    if (!currentUrl) return null;

    let urlObj;
    try {
      urlObj = new URL(currentUrl);
    } catch {
      return null;
    }

    const pathLower = urlObj.pathname.toLowerCase();
    const urlLower = currentUrl.toLowerCase();

    if (/\/(login|sign-?in|sign-?on|signup|sign-?up|register)(\/|$|\?)/i.test(pathLower)) return null;
    if (/[?&]error=(access_denied|invalid|login_required)/i.test(urlLower)) return null;

    const vText = `${validatePayload?.reason || ''} ${validatePayload?.what_happened || ''}`.toLowerCase();
    const dText = `${determineResult?.reason || ''} ${determineResult?.what_happened || ''}`.toLowerCase();
    const combined = `${vText} ${dText}`;
    const explicitAuthFailure =
      /\b(wrong|invalid|incorrect|bad)\s+(password|credentials|username|email)\b/.test(combined) ||
      /\b(invalid\s+credentials|authentication\s+failed|login\s+failed|access\s+denied|account\s+locked)\b/.test(
        combined
      ) ||
      /\b(incorrect\s+username|incorrect\s+password)\b/.test(combined);
    if (explicitAuthFailure) return null;

    const looksSessionish = (c) => {
      const name = String(c?.name || '');
      if (!name) return false;
      if (/^(session|sess|sid|jwt|auth|token|id_token|refresh|sso|connect\.sid)/i.test(name)) return true;
      if (c?.httpOnly === true && String(c?.value || '').length >= 16) return true;
      return false;
    };
    const sessionishCookies = cookies.filter(looksSessionish);

    const signals =
      page && typeof page === 'object' && page.__aionqaTargetAssetSignals && typeof page.__aionqaTargetAssetSignals === 'object'
        ? page.__aionqaTargetAssetSignals
        : null;
    const assetDegraded =
      signals &&
      ((Number(signals.http5xxScript) || 0) >= 1 || (Number(signals.chunkOrModuleErrors) || 0) >= 1);

    const validatorMentionsLoadBreakage =
      /\b(502|503|504|5xx|chunk|failed to load|could not load|load chunk|chunkload|bundle|bad gateway|degraded|incomplete|\brsc\b)\b/i.test(
        combined
      ) ||
      /\b(no interactive|not interactive|empty page|blank|broken ui)\b/i.test(combined) ||
      /\b(unable|not\s+able)\s+to\s+confirm\b.*\b(authenticated|session|login)\b/i.test(combined) ||
      /\b(cannot|could\s+not)\s+(reliably\s+)?(verify|confirm)\b.*\b(authenticated|session|login)\b/i.test(
        combined
      );

    const segments = urlObj.pathname.split('/').filter(Boolean);
    const pathDepth = segments.length;
    if (pathDepth < 2) return null;

    let seedHost = '';
    try {
      if (seedUrl) seedHost = new URL(String(seedUrl)).hostname.toLowerCase();
    } catch (_) {}
    const pageHost = urlObj.hostname.toLowerCase();
    const cookieHosts = new Set(
      cookies.map((c) => String(c?.domain || '').replace(/^\./, '').toLowerCase()).filter(Boolean)
    );
    const hostRelated =
      !seedHost ||
      pageHost === seedHost ||
      pageHost.endsWith(`.${seedHost}`) ||
      seedHost.endsWith(`.${pageHost}`) ||
      [...cookieHosts].some((h) => pageHost === h || pageHost.endsWith(`.${h}`));
    if (!hostRelated) return null;

    if (!(assetDegraded || validatorMentionsLoadBreakage)) return null;

    const hasSessionSignal = sessionishCookies.length >= 1 || cookies.length >= 4;
    if (!hasSessionSignal) return null;

    return {
      confirm: true,
      reason:
        'Login inferred from browser session while UI validator was negative: target asset degradation (HTTP 5xx/chunk/RSC/module failures) and post-auth URL with credible cookies — prefer runtime session over degraded-render AI judgment.',
    };
  } catch {
    return null;
  }
}
