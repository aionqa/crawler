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
 */

import { getRunnerBackendUrl } from './utils/runner-service-urls.js';

const BACKEND_URL = getRunnerBackendUrl();

/**
 * Create a job log context
 * @param {string} jobId - Job ID
 * @param {object} metadata - Additional metadata
 * @returns {Promise<object>} Response with jobLogId
 */
export async function createJobLogContext(jobId, metadata = {}) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/logs/jobs/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, metadata })
    });
    
    if (!response.ok) {
      console.error(`❌ Failed to create job log context: ${response.status}`);
      return { ok: false, error: `HTTP ${response.status}` };
    }
    
    return await response.json();
  } catch (error) {
    console.error(`❌ Error creating job log context:`, error);
    return { ok: false, error: error.message };
  }
}

/**
 * Append a log entry to a job
 * @param {string} jobId - Job ID
 * @param {string} level - Log level (debug, info, warn, error)
 * @param {string} message - Log message
 * @param {string} component - Component name (default: 'unified-crawler')
 * @param {object} metadata - Additional metadata
 * @returns {Promise<object>} Response
 */
export async function appendJobLog(jobId, level, message, component = 'unified-crawler', metadata = {}) {
  try {
    const jobIdStr = jobId != null ? String(jobId) : null;
    if (!jobIdStr) return { ok: false };
    const response = await fetch(`${BACKEND_URL}/api/logs/jobs/append`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: jobIdStr, level, message, component, metadata })
    });
    
    if (!response.ok) {
      console.error(`❌ Failed to append job log: ${response.status}`);
      return { ok: false };
    }
    
    return await response.json();
  } catch (error) {
    console.error(`❌ Error appending job log:`, error);
    return { ok: false };
  }
}

/**
 * Create a page log context
 * @param {string} jobId - Job ID
 * @param {string} pageUrl - Page URL
 * @param {string} pageTitle - Page title (optional)
 * @param {string} pageId - Page document ID (optional)
 * @param {object} metadata - Additional metadata
 * @returns {Promise<object>} Response with pageLogId
 */
export async function createPageLogContext(jobId, pageUrl, pageTitle = null, pageId = null, metadata = {}) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/logs/pages/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, pageUrl, pageTitle, pageId, metadata })
    });
    
    if (!response.ok) {
      console.error(`❌ Failed to create page log context: ${response.status}`);
      return { ok: false, error: `HTTP ${response.status}` };
    }
    
    return await response.json();
  } catch (error) {
    console.error(`❌ Error creating page log context:`, error);
    return { ok: false, error: error.message };
  }
}

/**
 * Append a log entry to a page
 * @param {string} jobId - Job ID
 * @param {string} pageUrl - Page URL
 * @param {string} level - Log level (debug, info, warn, error)
 * @param {string} message - Log message
 * @param {string} pageLogId - Page log context ID (optional, will be created if not provided)
 * @param {string} component - Component name (default: 'unified-crawler')
 * @param {object} metadata - Additional metadata
 * @returns {Promise<object>} Response
 */
export async function appendPageLog(jobId, pageUrl, level, message, pageLogId = null, component = 'unified-crawler', metadata = {}) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/logs/pages/append`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, pageUrl, pageLogId, level, message, component, metadata })
    });
    
    if (!response.ok) {
      console.error(`❌ Failed to append page log: ${response.status}`);
      return { ok: false };
    }
    
    return await response.json();
  } catch (error) {
    console.error(`❌ Error appending page log:`, error);
    return { ok: false };
  }
}

/**
 * Create an AI chat log context
 * @param {string} jobId - Job ID
 * @param {string} pageUrl - Page URL
 * @param {string} conversationId - Conversation ID
 * @param {string} pageLogId - Page log context ID (optional)
 * @param {string} purpose - Purpose of the AI chat (optional)
 * @param {object} metadata - Additional metadata
 * @returns {Promise<object>} Response with aichatId
 */
export async function createAIChatLogContext(jobId, pageUrl, conversationId, pageLogId = null, purpose = null, metadata = {}) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/logs/aichats/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, pageUrl, conversationId, pageLogId, purpose, metadata })
    });
    
    if (!response.ok) {
      console.error(`❌ Failed to create AI chat log context: ${response.status}`);
      return { ok: false, error: `HTTP ${response.status}` };
    }
    
    return await response.json();
  } catch (error) {
    console.error(`❌ Error creating AI chat log context:`, error);
    return { ok: false, error: error.message };
  }
}

/**
 * Append a log entry to an AI chat
 * @param {string} jobId - Job ID
 * @param {string} pageUrl - Page URL
 * @param {string} conversationId - Conversation ID
 * @param {string} level - Log level (debug, info, warn, error)
 * @param {string} message - Log message
 * @param {string} aichatId - AI chat context ID (optional, will be created if not provided)
 * @param {string} component - Component name (default: 'ai-conversation')
 * @param {object} metadata - Additional metadata
 * @param {object} requestPayload - AI request payload (optional)
 * @param {object} responsePayload - AI response payload (optional)
 * @returns {Promise<object>} Response
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
  try {
    const response = await fetch(`${BACKEND_URL}/api/logs/aichats/append`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
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
      })
    });
    
    if (!response.ok) {
      console.error(`❌ Failed to append AI chat log: ${response.status}`);
      return { ok: false };
    }
    
    return await response.json();
  } catch (error) {
    console.error(`❌ Error appending AI chat log:`, error);
    return { ok: false };
  }
}

/**
 * Prepare screenshot upload (get presigned URL and key)
 * @param {string} jobId - Job ID
 * @param {string} pageUrl - Page URL (optional)
 * @param {object} metadata - Additional metadata
 * @returns {Promise<object>} Response with key and uploadUrl
 */
export async function prepareScreenshotUpload(jobId, pageUrl = null, metadata = {}) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/files/prepare-screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, pageUrl, metadata })
    });
    
    if (!response.ok) {
      console.error(`❌ Failed to prepare screenshot upload: ${response.status}`);
      return { ok: false, error: `HTTP ${response.status}` };
    }
    
    return await response.json();
  } catch (error) {
    console.error(`❌ Error preparing screenshot upload:`, error);
    return { ok: false, error: error.message };
  }
}

/**
 * Upload screenshot using presigned URL
 * @param {string} uploadUrl - Presigned PUT URL
 * @param {Buffer} screenshotBuffer - Screenshot image buffer
 * @returns {Promise<boolean>} Success status
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
 * @param {object} opts
 * @param {string} opts.jobId
 * @param {Buffer} opts.screenshotBuffer
 * @param {string} [opts.backendUrl]
 * @param {Record<string, string>} [opts.authHeaders] Authorization Bearer for register-screenshot
 * @param {object} [opts.metadata]
 * @returns {Promise<string|null>} fileId or null
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
  try {
    const headers = { 'Content-Type': 'application/json', ...authHeaders };
    const reg = await fetch(`${backendUrl}/api/upload/register-screenshot`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jobId,
        objectName: prep.key,
        url: prep.publicUrl,
        metadata,
      }),
    });
    if (!reg.ok) {
      const errText = await reg.text();
      console.error('[SCREENSHOT-FLOW] register failed', reg.status, errText);
      return null;
    }
    const data = await reg.json();
    return data.fileId || null;
  } catch (e) {
    console.error('[SCREENSHOT-FLOW] register error', e.message);
    return null;
  }
}

/**
 * Prepare video upload (get presigned URL and key)
 * @param {string} jobId - Job ID
 * @param {object} metadata - Additional metadata
 * @returns {Promise<object>} Response with key and uploadUrl
 */
export async function prepareVideoUpload(jobId, metadata = {}) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/files/prepare-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, metadata })
    });
    
    if (!response.ok) {
      console.error(`❌ Failed to prepare video upload: ${response.status}`);
      return { ok: false, error: `HTTP ${response.status}` };
    }
    
    return await response.json();
  } catch (error) {
    console.error(`❌ Error preparing video upload:`, error);
    return { ok: false, error: error.message };
  }
}

/**
 * Upload video using presigned URL
 * @param {string} uploadUrl - Presigned PUT URL
 * @param {Buffer} videoBuffer - Video file buffer
 * @returns {Promise<boolean>} Success status
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
 * @param {string} jobId - Job ID
 * @param {string} mediaType - 'screenshot' or 'video'
 * @param {object} fileInfo - File information
 * @returns {Promise<object>} Response
 */
export async function trackMediaUpload(jobId, mediaType, fileInfo) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/media/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, mediaType, fileInfo })
    });
    
    if (!response.ok) {
      console.error(`❌ Failed to track ${mediaType} media: ${response.status}`);
      return { ok: false, error: `HTTP ${response.status}` };
    }
    
    return await response.json();
  } catch (error) {
    console.error(`❌ Error tracking ${mediaType} media:`, error);
    return { ok: false, error: error.message };
  }
}
