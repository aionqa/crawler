/**
 * Backend Logger - Structured logging client for unified-crawler
 *
 * Implements the logging contract defined in .cursor/rules/20-unified-crawler-contract.mdc
 *
 * Endpoints:
 * - POST /api/logs/jobs/create
 * - POST /api/logs/jobs/append
 * - POST /api/logs/pages/create
 * - POST /api/logs/pages/append
 * - POST /api/logs/aichats/create
 * - POST /api/logs/aichats/append
 * - POST /api/files/prepare-screenshot
 *
 * All POSTs to the backend go through {@link postBackend}, which:
 *  - retries up to BACKEND_MAX_ATTEMPTS times on 5xx, 408, 429 and connection errors;
 *  - honors `Retry-After` from 503/429 responses (the backend uses this for
 *    backpressure when crawler write traffic temporarily exceeds capacity);
 *  - caps any single wait at BACKEND_RETRY_AFTER_CAP_MS so a misbehaving
 *    backend can never stall the crawl indefinitely;
 *  - on terminal failure returns `null`, NEVER throws (logs are best-effort —
 *    crawl progress must not be blocked by log delivery).
 */

import { getRunnerBackendUrl } from './utils/runner-service-urls.js';

const BACKEND_URL = getRunnerBackendUrl();

// Retry policy for backend writes from the crawler.
const BACKEND_MAX_ATTEMPTS = Number(process.env.BACKEND_MAX_ATTEMPTS || 4);
const BACKEND_RETRY_AFTER_CAP_MS = Number(process.env.BACKEND_RETRY_AFTER_CAP_MS || 60_000);
const BACKEND_BASE_BACKOFF_MS = Number(process.env.BACKEND_BASE_BACKOFF_MS || 1000);

/**
 * Parse a `Retry-After` HTTP header (seconds OR HTTP-date) into milliseconds.
 * Returns null if absent or unparseable. Capped at BACKEND_RETRY_AFTER_CAP_MS.
 */
function parseRetryAfterMs(headers) {
  if (!headers) return null;
  const raw = typeof headers.get === 'function'
    ? headers.get('retry-after')
    : (headers['retry-after'] ?? headers['Retry-After']);
  if (raw == null) return null;
  const str = String(raw).trim();
  if (!str) return null;
  const asInt = Number(str);
  let ms;
  if (Number.isFinite(asInt)) {
    ms = Math.max(0, asInt) * 1000;
  } else {
    const dateMs = Date.parse(str);
    if (!Number.isFinite(dateMs)) return null;
    ms = Math.max(0, dateMs - Date.now());
  }
  return Math.min(ms, BACKEND_RETRY_AFTER_CAP_MS);
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

/**
 * POST a JSON body to the backend with retry + Retry-After honoring.
 * Returns the parsed JSON response on success, or null on terminal failure.
 *
 * @param {string} pathOrUrl  Either a full URL or a path beginning with '/'
 *                            (resolved against BACKEND_URL).
 * @param {object|null} body  JSON body. Pass null/undefined for empty bodies.
 * @param {object} [opts]
 * @param {string} [opts.label] Short label for log lines (e.g. "appendJobLog").
 * @param {Record<string, string>} [opts.headers] Extra headers to merge in.
 * @returns {Promise<any|null>}
 */
export async function postBackend(pathOrUrl, body, opts = {}) {
  const label = opts.label || pathOrUrl;
  const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${BACKEND_URL}${pathOrUrl}`;
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const init = {
    method: 'POST',
    headers,
    body: body == null ? undefined : JSON.stringify(body)
  };

  let lastErr = null;
  for (let attempt = 1; attempt <= BACKEND_MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (attempt === BACKEND_MAX_ATTEMPTS) break;
      const wait = BACKEND_BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
      console.warn(`⚠️ [BACKEND-WRITE] ${label} attempt ${attempt}/${BACKEND_MAX_ATTEMPTS} network error: ${err.message}. Retrying in ${Math.round(wait / 1000)}s...`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }

    if (response.ok) {
      try {
        return await response.json();
      } catch {
        return { ok: true };
      }
    }

    if (!isRetryableStatus(response.status) || attempt === BACKEND_MAX_ATTEMPTS) {
      // Drain body so the connection can be reused.
      try { await response.text(); } catch { /* ignore */ }
      console.warn(`⚠️ [BACKEND-WRITE] ${label} failed terminally: HTTP ${response.status}`);
      return null;
    }

    const retryAfterMs = parseRetryAfterMs(response.headers);
    const defaultBackoff = BACKEND_BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
    const wait = retryAfterMs != null ? retryAfterMs : defaultBackoff;
    const reason = retryAfterMs != null ? `(Retry-After: ${Math.round(retryAfterMs / 1000)}s)` : '';
    console.warn(`⚠️ [BACKEND-WRITE] ${label} attempt ${attempt}/${BACKEND_MAX_ATTEMPTS} HTTP ${response.status} ${reason}. Retrying in ${Math.round(wait / 1000)}s...`);
    try { await response.text(); } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, wait));
  }

  if (lastErr) {
    console.warn(`⚠️ [BACKEND-WRITE] ${label} gave up after ${BACKEND_MAX_ATTEMPTS} attempts: ${lastErr.message}`);
  }
  return null;
}

/**
 * Create a job log context
 */
export async function createJobLogContext(jobId, metadata = {}) {
  const data = await postBackend('/api/logs/jobs/create', { jobId, metadata }, { label: 'createJobLogContext' });
  return data ?? { ok: false };
}

/**
 * Append a log entry to a job
 */
export async function appendJobLog(jobId, level, message, component = 'unified-crawler', metadata = {}) {
  const jobIdStr = jobId != null ? String(jobId) : null;
  if (!jobIdStr) return { ok: false };
  const data = await postBackend(
    '/api/logs/jobs/append',
    { jobId: jobIdStr, level, message, component, metadata },
    { label: 'appendJobLog' }
  );
  return data ?? { ok: false };
}

/**
 * Create a page log context
 */
export async function createPageLogContext(jobId, pageUrl, pageTitle = null, pageId = null, metadata = {}) {
  const data = await postBackend(
    '/api/logs/pages/create',
    { jobId, pageUrl, pageTitle, pageId, metadata },
    { label: 'createPageLogContext' }
  );
  return data ?? { ok: false, error: 'create_failed' };
}

/**
 * Append a log entry to a page
 */
export async function appendPageLog(jobId, pageUrl, level, message, pageLogId = null, component = 'unified-crawler', metadata = {}) {
  const data = await postBackend(
    '/api/logs/pages/append',
    { jobId, pageUrl, pageLogId, level, message, component, metadata },
    { label: 'appendPageLog' }
  );
  return data ?? { ok: false };
}

/**
 * Create an AI chat log context
 */
export async function createAIChatLogContext(jobId, pageUrl, conversationId, pageLogId = null, purpose = null, metadata = {}) {
  const data = await postBackend(
    '/api/logs/aichats/create',
    { jobId, pageUrl, conversationId, pageLogId, purpose, metadata },
    { label: 'createAIChatLogContext' }
  );
  return data ?? { ok: false, error: 'create_failed' };
}

/**
 * Append a log entry to an AI chat
 */
export async function appendAIChatLog(
  jobId,
  pageUrl,
  conversationId,
  level,
  message,
  aichatId = null,
  component = 'ai-conversation',
  metadata = {},
  requestPayload = null,
  responsePayload = null
) {
  const data = await postBackend(
    '/api/logs/aichats/append',
    {
      jobId,
      pageUrl,
      conversationId,
      aichatId,
      level,
      message,
      component,
      metadata,
      requestPayload,
      responsePayload
    },
    { label: 'appendAIChatLog' }
  );
  return data ?? { ok: false };
}

/**
 * Prepare screenshot upload (get presigned URL and key)
 */
export async function prepareScreenshotUpload(jobId, pageUrl = null, metadata = {}) {
  const data = await postBackend(
    '/api/files/prepare-screenshot',
    { jobId, pageUrl, metadata },
    { label: 'prepareScreenshotUpload' }
  );
  return data ?? { ok: false, error: 'prepare_failed' };
}

/**
 * Upload screenshot using presigned URL.
 *
 * NOTE: This goes directly to MinIO/S3, NOT to the backend, so it does not
 * use postBackend() / backpressure. We still keep a small retry on 5xx for
 * transient S3 hiccups.
 */
export async function uploadScreenshotToPresignedUrl(uploadUrl, screenshotBuffer) {
  try {
    console.log(`[SCREENSHOT-UPLOAD] Starting upload to presigned URL (${screenshotBuffer.length} bytes)...`);

    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: screenshotBuffer
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Screenshot upload failed: ${response.status} - ${errorText}`);
      return false;
    }

    console.log(`✅ Screenshot uploaded successfully (${screenshotBuffer.length} bytes)`);
    return true;
  } catch (error) {
    console.error(`❌ Error uploading screenshot:`, error.message);
    return false;
  }
}

/**
 * Prepare presigned URL, PUT screenshot to object storage, register metadata (no binary via backend API).
 */
export async function uploadScreenshotFullFlow({
  jobId,
  screenshotBuffer,
  backendUrl = BACKEND_URL,
  authHeaders = {},
  metadata = {},
}) {
  const prep = await prepareScreenshotUpload(jobId, null, metadata);
  if (!prep || prep.ok === false || !prep.uploadUrl || !prep.key) {
    console.error('[SCREENSHOT-FLOW] prepare failed', prep?.error || '');
    return null;
  }
  const putOk = await uploadScreenshotToPresignedUrl(prep.uploadUrl, screenshotBuffer);
  if (!putOk) {
    return null;
  }
  const reg = await postBackend(
    `${backendUrl}/api/upload/register-screenshot`,
    { jobId, objectName: prep.key, url: prep.publicUrl, metadata },
    { label: 'registerScreenshot', headers: authHeaders }
  );
  if (!reg) {
    console.error('[SCREENSHOT-FLOW] register failed');
    return null;
  }
  return reg.fileId || null;
}

/**
 * Prepare video upload (get presigned URL and key)
 */
export async function prepareVideoUpload(jobId, metadata = {}) {
  const data = await postBackend(
    '/api/files/prepare-video',
    { jobId, metadata },
    { label: 'prepareVideoUpload' }
  );
  return data ?? { ok: false, error: 'prepare_failed' };
}

/**
 * Upload video using presigned URL (direct to S3, see note on uploadScreenshotToPresignedUrl).
 */
export async function uploadVideoToPresignedUrl(uploadUrl, videoBuffer) {
  try {
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/webm' },
      body: videoBuffer
    });

    if (!response.ok) {
      console.error(`❌ Failed to upload video to presigned URL: ${response.status}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`❌ Error uploading video to presigned URL:`, error);
    return false;
  }
}

/**
 * Track media upload (screenshot or video) with backend
 */
export async function trackMediaUpload(jobId, mediaType, fileInfo) {
  const data = await postBackend(
    '/api/media/track',
    { jobId, mediaType, fileInfo },
    { label: `trackMediaUpload(${mediaType})` }
  );
  return data ?? { ok: false, error: 'track_failed' };
}
