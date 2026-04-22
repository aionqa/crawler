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
 *
 * Job and page lines are **batched** in memory and sent as `entries[]` every
 * `LOG_CHUNK_FLUSH_INTERVAL_SEC` seconds (clamped 10–300, default 30). Call
 * {@link flushAllBufferedLogs} on shutdown. AI chat logs stay unbuffered.
 */

import { getRunnerBackendUrl } from './utils/runner-service-urls.js';

const BACKEND_URL = getRunnerBackendUrl();

// Retry policy for backend writes from the crawler.
const BACKEND_MAX_ATTEMPTS = Number(process.env.BACKEND_MAX_ATTEMPTS || 4);
const BACKEND_RETRY_AFTER_CAP_MS = Number(process.env.BACKEND_RETRY_AFTER_CAP_MS || 60_000);
const BACKEND_BASE_BACKOFF_MS = Number(process.env.BACKEND_BASE_BACKOFF_MS || 1000);

const LOG_CHUNK_FLUSH_INTERVAL_SEC = Math.min(
  300,
  Math.max(10, Number(process.env.LOG_CHUNK_FLUSH_INTERVAL_SEC || 30) || 30)
);
const MAX_BUFFERED_LINES_PER_POST = 200;

const _jobLogBuffers = new Map();
/** @type {Map<string, { jobId: string, pageUrl: string, pageLogId: string|null, entries: object[] }>} */
const _pageLogBuffers = new Map();
let _logFlushTimer = null;

function _pageBufferKey(jobId, pageUrl, pageLogId) {
  const pl = pageLogId != null ? String(pageLogId) : '';
  return `${jobId}\u0000${pageUrl}\u0000${pl}`;
}

function _ensureLogFlushTimer() {
  if (_logFlushTimer != null) return;
  const ms = LOG_CHUNK_FLUSH_INTERVAL_SEC * 1000;
  _logFlushTimer = setInterval(() => {
    flushAllBufferedLogs().catch((err) => console.warn(`[LOG-BUFFER] ${err.message}`));
  }, ms);
  if (typeof _logFlushTimer.unref === 'function') _logFlushTimer.unref();
}

function _splitIntoBatches(arr, maxPer) {
  const batches = [];
  for (let i = 0; i < arr.length; i += maxPer) {
    batches.push(arr.slice(i, i + maxPer));
  }
  return batches.length ? batches : [[]];
}

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
 * Flush all buffered job/page log lines to the backend (awaitable).
 */
export async function flushAllBufferedLogs() {
  for (const [jobId, lines] of [..._jobLogBuffers.entries()]) {
    if (!lines.length) {
      _jobLogBuffers.delete(jobId);
      continue;
    }
    const chunk = lines.splice(0, lines.length);
    if (!chunk.length) {
      _jobLogBuffers.delete(jobId);
      continue;
    }
    for (const batch of _splitIntoBatches(chunk, MAX_BUFFERED_LINES_PER_POST)) {
      if (!batch.length) continue;
      await postBackend(
        '/api/logs/jobs/append',
        { jobId, entries: batch },
        { label: 'appendJobLogChunk' }
      );
    }
    if (!lines.length) _jobLogBuffers.delete(jobId);
  }

  for (const [key, bundle] of [..._pageLogBuffers.entries()]) {
    if (!bundle.entries.length) {
      _pageLogBuffers.delete(key);
      continue;
    }
    const chunk = bundle.entries.splice(0, bundle.entries.length);
    if (!chunk.length) {
      _pageLogBuffers.delete(key);
      continue;
    }
    const { jobId, pageUrl, pageLogId } = bundle;
    for (const batch of _splitIntoBatches(chunk, MAX_BUFFERED_LINES_PER_POST)) {
      if (!batch.length) continue;
      await postBackend(
        '/api/logs/pages/append',
        { jobId, pageUrl, pageLogId, entries: batch },
        { label: 'appendPageLogChunk' }
      );
    }
    if (!bundle.entries.length) _pageLogBuffers.delete(key);
  }
}

/**
 * Create a job log context
 */
export async function createJobLogContext(jobId, metadata = {}) {
  const data = await postBackend('/api/logs/jobs/create', { jobId, metadata }, { label: 'createJobLogContext' });
  return data ?? { ok: false };
}

/**
 * Append a log entry to a job (buffered; see flushAllBufferedLogs).
 */
export async function appendJobLog(jobId, level, message, component = 'unified-crawler', metadata = {}) {
  const jobIdStr = jobId != null ? String(jobId) : null;
  if (!jobIdStr) return { ok: false };
  _ensureLogFlushTimer();
  if (!_jobLogBuffers.has(jobIdStr)) _jobLogBuffers.set(jobIdStr, []);
  _jobLogBuffers.get(jobIdStr).push({
    level,
    message,
    component,
    metadata: metadata || {},
    timestamp: new Date(),
  });
  return { ok: true, buffered: true };
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
 * Append a log entry to a page (buffered; see flushAllBufferedLogs).
 */
export async function appendPageLog(jobId, pageUrl, level, message, pageLogId = null, component = 'unified-crawler', metadata = {}) {
  const jobIdStr = jobId != null ? String(jobId) : null;
  if (!jobIdStr || !pageUrl) return { ok: false };
  _ensureLogFlushTimer();
  const key = _pageBufferKey(jobIdStr, String(pageUrl), pageLogId != null ? String(pageLogId) : null);
  if (!_pageLogBuffers.has(key)) {
    _pageLogBuffers.set(key, {
      jobId: jobIdStr,
      pageUrl: String(pageUrl),
      pageLogId: pageLogId != null ? String(pageLogId) : null,
      entries: [],
    });
  }
  _pageLogBuffers.get(key).entries.push({
    level,
    message,
    component,
    metadata: metadata || {},
    timestamp: new Date(),
  });
  return { ok: true, buffered: true };
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
