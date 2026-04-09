/**
 * Unified Runner
 * Polls backend for both login and crawl jobs and executes them
 * Works similar to GitHub Actions runners
 */

import { startCrawl } from './crawling/unified-operations.js';
import { executeLoginWithWorkflow } from './login/login-workflow-engine.js';
import { runZapBaseline } from './security/zap-runner.js';
import { readFile, writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import axios from 'axios';
import https from 'https';
import { promises as dnsPromises } from 'dns';
import { randomUUID } from 'crypto';
import { hostname } from 'os';
import express from 'express';
import VideoStreamManager from './browser/video-stream-manager.js';
import VideoRecorder from './browser/video-recorder.js';
// Minimal HTTP server for ECS health checks only (not for workflow endpoints - rule 51-runner-architecture.mdc)

const BACKEND_URL = process.env.BACKEND_URL || 'http://back:4000';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '3000'); // 3 seconds default
const RUNNER_TOKEN = process.env.RUNNER_TOKEN; // GitHub Actions-style runner token
const RUNNER_TYPE = process.env.RUNNER_TYPE || 'user-managed'; // 'service-managed' or 'user-managed'
const TASK_MODE = process.env.TASK_MODE || 'polling'; // 'single-job' or 'polling'
const JOB_ID = process.env.JOB_ID; // Job ID when in single-job mode
const MAX_SITEMAP_SCAN_DEPTH = 5;
const MAX_SITEMAP_SCAN_CHILD_SITEMAPS = 25;
const MAX_SITEMAP_SCAN_ENTRIES = 5000;
const DEFAULT_AVAILABILITY_TIMEOUT_MS = 10000;
// Generate unique runner ID if not provided (includes hostname and UUID for uniqueness)
// For service-managed runners, include type in ID
const RUNNER_ID = process.env.RUNNER_ID || (RUNNER_TYPE === 'service-managed' 
  ? `service-runner-${hostname()}-${randomUUID().substring(0, 8)}`
  : `unified-runner-${hostname()}-${randomUUID().substring(0, 8)}`);
const STREAM_INTERVAL = 2000; // Stream browser frame every 2 seconds
// WORKFLOW_API_PORT removed - runners do not expose HTTP endpoints (rule 51-runner-architecture.mdc)

// Validate runner token is configured
if (!RUNNER_TOKEN) {
  console.error('❌ RUNNER_TOKEN environment variable is required');
  console.error('    Generate a token in the UI: Settings > Runners > Generate Token');
  process.exit(1);
}

console.log(`🤖 Runner ID: ${RUNNER_ID}`);
console.log(`🤖 Runner Type: ${RUNNER_TYPE} (${RUNNER_TYPE === 'service-managed' ? 'spawned by backend service' : 'user-managed'})`);
// Version info for image update verification
const CRAWLER_VERSION = process.env.CRAWLER_VERSION || process.env.IMAGE_TAG || 'unknown';
const CRAWLER_BUILD_DATE = process.env.BUILD_DATE || new Date().toISOString();
console.log(`🏷️  Crawler Version: ${CRAWLER_VERSION}`);
console.log(`📅 Crawler Build Date: ${CRAWLER_BUILD_DATE}`);

// Initialize video stream manager for real-time streaming
const videoStreamManager = new VideoStreamManager(BACKEND_URL, RUNNER_ID, RUNNER_TOKEN);

// Initialize video recorder for full recording
const videoRecorder = new VideoRecorder(BACKEND_URL, RUNNER_ID, RUNNER_TOKEN);

console.log(`🚀 Starting runner ${RUNNER_ID}`);
console.log(`🔗 Backend URL: ${BACKEND_URL}`);
console.log(`⏱️  Poll interval: ${POLL_INTERVAL}ms`);
console.log(`📹 Stream interval: ${STREAM_INTERVAL}ms`);

let isProcessing = false;
let currentJobId = null;
let currentPage = null; // Track current page for streaming

// Log capture for container logs
const jobLogs = new Map(); // jobId -> array of log entries
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info,
  debug: console.debug
};

/**
 * Start capturing console logs for a job
 */
function startLogCapture(jobId) {
  if (!jobId) return;
  
  jobLogs.set(jobId, []);
  
  const logEntry = (level, args) => {
    const timestamp = new Date().toISOString();
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    
    const entry = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
    const logs = jobLogs.get(jobId);
    if (logs) {
      logs.push(entry);
    }
    
    // Also output to original console
    originalConsole[level](...args);
  };
  
  console.log = (...args) => logEntry('log', args);
  console.error = (...args) => logEntry('error', args);
  console.warn = (...args) => logEntry('warn', args);
  console.info = (...args) => logEntry('info', args);
  console.debug = (...args) => logEntry('debug', args);
}

/**
 * Stop capturing console logs for a job
 */
function stopLogCapture(jobId) {
  if (!jobId) return;
  
  // Restore original console methods
  console.log = originalConsole.log;
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  console.info = originalConsole.info;
  console.debug = originalConsole.debug;
}

/**
 * Get captured logs for a job
 */
function getCapturedLogs(jobId) {
  const logs = jobLogs.get(jobId) || [];
  return logs.join('');
}

/**
 * Clear captured logs for a job
 */
function clearCapturedLogs(jobId) {
  jobLogs.delete(jobId);
}

/**
 * Upload file using presigned URL helper (similar to uploadFileForDownload)
 */
async function uploadFileForDownload(jobId, content, fileName, contentType) {
  try {
    // Convert content to buffer if it's a string
    const buffer = Buffer.isBuffer(content) ? Buffer.from(content, 'utf8') : Buffer.from(content, 'utf8');

    // Request presigned URL from backend
    const jobIdStr = jobId != null ? String(jobId) : '';
    if (!jobIdStr) {
      console.error('❌ uploadFileForDownload: jobId is required');
      return null;
    }
    const presignedResponse = await axios.post(`${BACKEND_URL}/api/upload/presigned-url`, {
      type: 'file',
      jobId: jobIdStr,
      contentType: contentType || 'application/octet-stream',
      fileName: fileName
    }, {
      timeout: 10000,
      headers: getAuthHeaders()
    });

    const { url: presignedUrl, key, publicUrl: returnedUrl } = presignedResponse.data;

    // Upload file to presigned URL
    await axios.put(presignedUrl, buffer, {
      headers: { 'Content-Type': contentType },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 30000
    });

    console.log(`✅ File uploaded for download: ${returnedUrl}`);
    return returnedUrl || null;
  } catch (error) {
    console.error(`❌ Failed to upload file for download: ${error.message}`);
    return null;
  }
}

/**
 * Upload container logs for a job
 */
async function uploadContainerLogs(jobId) {
  try {
    const logs = getCapturedLogs(jobId);
    if (!logs || logs.length === 0) {
      console.log(`ℹ️  No logs captured for job ${jobId}`);
      return null;
    }
    
    const fileName = `crawler-logs-${jobId}-${Date.now()}.txt`;
    const logUrl = await uploadFileForDownload(jobId, logs, fileName, 'text/plain');
    
    if (logUrl) {
      // Attach the log file to the job by updating job with attachment reference
      try {
        await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
          jobId,
          level: 'info',
          message: `📄 Container logs uploaded: ${fileName}`,
          component: 'RUNNER',
          metadata: {
            attachment_type: 'container_logs',
            attachment_url: logUrl,
            attachment_filename: fileName,
            attachment_size: logs.length
          }
        }, {
          headers: getAuthHeaders(),
          timeout: 10000
        });
        console.log(`✅ Container logs uploaded and attached to job ${jobId}`);
      } catch (attachError) {
        console.warn(`⚠️  Failed to attach log file reference to job: ${attachError.message}`);
      }
    }
    
    return logUrl;
  } catch (error) {
    console.error(`❌ Failed to upload container logs for job ${jobId}:`, error.message);
    return null;
  }
}

// Export for unified-operations to use
export const runnerContext = {
  RUNNER_ID,
  BACKEND_URL,
  setCurrentPage: (page) => { 
    currentPage = page;
    // No global currentPage needed - workflow execution happens internally
  }
};

// Minimal HTTP server for ECS health checks only (not for workflow endpoints - rule 51-runner-architecture.mdc)
const HEALTH_CHECK_PORT = process.env.HEALTH_CHECK_PORT || 8080;
const healthApp = express();
healthApp.get('/health', (_req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    runner_id: RUNNER_ID,
    timestamp: new Date().toISOString() 
  });
});

const healthServer = healthApp.listen(HEALTH_CHECK_PORT, () => {
  console.log(`❤️  Health check server listening on port ${HEALTH_CHECK_PORT}`);
});
console.log(`✅ Health check endpoint available at http://localhost:${HEALTH_CHECK_PORT}/health`);

/**
 * Get axios headers with authentication
 */
function getAuthHeaders() {
  return {
    'Authorization': `Bearer ${RUNNER_TOKEN}`
  };
}

/** Backend retry delays: 10s, 30s, 3min. Runners continue without interruption when backend restarts; only admin explicit cleanup clears state. */
const BACKEND_RETRY_DELAYS_MS = [10 * 1000, 30 * 1000, 3 * 60 * 1000];
const BACKEND_RETRY_ATTEMPTS = 1 + BACKEND_RETRY_DELAYS_MS.length;

function isRetryableBackendError(error) {
  if (!error) return false;
  const code = error.code || '';
  const status = error.response?.status;
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'ENETUNREACH'].includes(code)) return true;
  if (status >= 500 || status === 408) return true;
  return false;
}

/**
 * Run a backend request with retries: 10s, 30s, 3min. Log after all attempts if still failing.
 */
async function withBackendRetry(fn, label) {
  let lastError;
  for (let attempt = 1; attempt <= BACKEND_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableBackendError(error) || attempt === BACKEND_RETRY_ATTEMPTS) break;
      const delayMs = BACKEND_RETRY_DELAYS_MS[attempt - 1];
      console.warn(`⚠️ [BACKEND-RETRY] ${label} attempt ${attempt}/${BACKEND_RETRY_ATTEMPTS} failed: ${error.message}. Retrying in ${delayMs / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  console.error(`❌ [BACKEND-RETRY] Request failed after ${BACKEND_RETRY_ATTEMPTS} attempts: ${label}: ${lastError?.message || lastError}`);
  if (lastError?.response) {
    console.error(`   Status: ${lastError.response.status}; Response:`, lastError.response.data);
    if (lastError.response.status >= 500 && lastError.response.data) {
      console.error(`   Backend/proxy body: ${typeof lastError.response.data === 'object' ? JSON.stringify(lastError.response.data) : lastError.response.data}`);
    }
  }
  throw lastError;
}

async function appendJobLog(jobId, level, message, metadata = {}) {
  try {
    await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
      jobId,
      level,
      message,
      component: 'sitemap-runner',
      metadata
    }, {
      timeout: 10000
    });
  } catch (error) {
    console.error(`Failed to append log for job ${jobId}:`, error.message);
  }
}

/**
 * Poll backend for next available job (login or crawl)
 * Uses retries (10s, 30s, 3min) when backend is not responding so runner continues without interruption.
 */
async function pollForJob() {
  // Try to get a crawl job first
  try {
    const response = await withBackendRetry(() => axios.get(`${BACKEND_URL}/api/runner/jobs/next`, {
      params: { type: 'crawl', runner_id: RUNNER_ID },
      headers: getAuthHeaders(),
      timeout: 5000
    }), 'poll/crawl');

    if (response.data && response.data.job) {
      return { ...response.data.job, jobType: 'crawl' };
    }
  } catch (error) {
    // 404 means no crawl jobs available, continue to check login jobs
    if (error.response?.status === 404) {
      // Normal - no jobs available
    } else if (error.response?.status === 401) {
      console.error(`❌ Authentication failed when polling for crawl jobs!`);
      console.error(`   Status: 401 Unauthorized`);
      console.error(`   Error: ${error.response?.data?.error || error.message}`);
      console.error(`   Runner ID: ${RUNNER_ID}`);
      console.error(`   Token configured: ${RUNNER_TOKEN ? 'Yes (length: ' + RUNNER_TOKEN.length + ')' : 'NO - THIS IS THE PROBLEM!'}`);
      console.error(`   Fix: Set RUNNER_TOKEN environment variable to a valid token from Settings > Runners`);
    } else {
      // Connection/timeout/5xx already logged by withBackendRetry
      console.error(`❌ Error polling for crawl jobs:`, error.message);
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        console.error(`   Response:`, error.response.data);
      }
      // Backend looks degraded/unreachable; avoid tripling load by probing other queues immediately.
      if (isRetryableBackendError(error)) {
        return null;
      }
    }
  }

  // If no crawl job, try to get a security job
  try {
    const response = await withBackendRetry(() => axios.get(`${BACKEND_URL}/api/runner/jobs/next`, {
      params: { type: 'security', runner_id: RUNNER_ID },
      headers: getAuthHeaders(),
      timeout: 5000
    }), 'poll/security');

    if (response.data && response.data.job) {
      return { ...response.data.job, jobType: 'security' };
    }
  } catch (error) {
    if (error.response?.status === 404) {
      // Normal - no jobs available
    } else if (error.response?.status === 401) {
      console.error(`❌ Authentication failed when polling for security jobs!`);
    } else {
      console.error(`❌ Error polling for security jobs:`, error.message);
      if (isRetryableBackendError(error)) {
        return null;
      }
    }
  }

  // If no security job, try to get a login job
  try {
    const response = await withBackendRetry(() => axios.get(`${BACKEND_URL}/api/runner/jobs/next`, {
      params: { type: 'login', runner_id: RUNNER_ID },
      headers: getAuthHeaders(),
      timeout: 5000
    }), 'poll/login');

    if (response.data && response.data.job) {
      return { ...response.data.job, jobType: 'login' };
    }
  } catch (error) {
    if (error.response?.status === 404) {
      // Normal - no jobs available
    } else if (error.response?.status === 401) {
      console.error(`❌ Authentication failed when polling for login jobs!`);
      console.error(`   Status: 401 Unauthorized`);
      console.error(`   Error: ${error.response?.data?.error || error.message}`);
      console.error(`   Runner ID: ${RUNNER_ID}`);
      console.error(`   Token configured: ${RUNNER_TOKEN ? 'Yes (length: ' + RUNNER_TOKEN.length + ')' : 'NO - THIS IS THE PROBLEM!'}`);
      console.error(`   Fix: Set RUNNER_TOKEN environment variable to a valid token from Settings > Runners`);
    } else {
      console.error(`❌ Error polling for login jobs:`, error.message);
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        console.error(`   Response:`, error.response.data);
      }
    }
  }

  return null;
}

/**
 * Start real-time video streaming for a job
 * Uses VideoStreamManager for continuous streaming with buffer
 */
function startVideoStream(page, jobId) {
  console.log(`📹 Starting real-time video stream for job ${jobId}`);
  videoStreamManager.startStream(jobId, page, {
    interval: 200 // 5 FPS for smooth streaming
  });
}

/**
 * Stop video streaming for a job
 */
function stopVideoStream(jobId) {
  console.log(`⏹️  Stopping video stream for job ${jobId}`);
  videoStreamManager.stopStream(jobId);
}

/**
 * Check job status from backend
 */
async function checkJobStatus(jobId) {
  try {
    // Use /api/jobs/:id endpoint with RUNNER_TOKEN authentication
    const response = await axios.get(`${BACKEND_URL}/api/jobs/${jobId}`, {
      headers: getAuthHeaders(), // Required: sends RUNNER_TOKEN for authentication
      timeout: 5000
    });
    return response.data?.status || 'unknown';
  } catch (error) {
    console.error(`❌ Error checking job status:`, error.message);
    if (error.response?.status === 401) {
      console.error(`   Status: 401 Unauthorized - Authentication failed`);
      console.error(`   Runner ID: ${RUNNER_ID}`);
      console.error(`   Token configured: ${RUNNER_TOKEN ? 'Yes (length: ' + RUNNER_TOKEN.length + ')' : 'NO - THIS IS THE PROBLEM!'}`);
      console.error(`   Fix: Ensure RUNNER_TOKEN environment variable is set and token exists in database`);
    }
    return 'unknown';
  }
}

/**
 * Execute a job (login or crawl)
 */
async function executeJob(job) {
  currentJobId = job.id;
  let streamInterval = null;
  
  // Start capturing container logs for this job
  startLogCapture(job.id);
  
  console.log(`\n🎯 Executing ${job.jobType} job ${job.id}`);
  const jobUrl = job.url || job.start_url || job.context?.start_url || 'undefined';
  console.log(`📍 URL: ${jobUrl}`);
  console.log(`[DEBUG] Job object at start:`, JSON.stringify(job, null, 2));

  // Check job status before starting - accept 'pending', 'running', 'queued', and 'unknown'
  // 'unknown' can happen if job was just created and not yet in database (timing issue)
  // Retry a few times with delay to handle race conditions
  let initialStatus = await checkJobStatus(job.id);
  let retries = 0;
  const maxRetries = 3;
  
  while (initialStatus === 'unknown' && retries < maxRetries) {
    console.log(`⏳ Job ${job.id} status is 'unknown', retrying in 2 seconds... (attempt ${retries + 1}/${maxRetries})`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    initialStatus = await checkJobStatus(job.id);
    retries++;
  }
  
  const validStatuses = ['running', 'pending', 'queued'];
  if (!validStatuses.includes(initialStatus) && initialStatus !== 'unknown') {
    console.log(`⚠️  Job ${job.id} status is ${initialStatus}, skipping execution`);
    // Report to backend to release the assignment
    try {
      await axios.post(`${BACKEND_URL}/api/runner/jobs/${job.id}/skip`, {
        reason: `Job status is ${initialStatus}, expected 'pending', 'running', 'queued', or 'unknown'`,
        runner_id: RUNNER_ID
      }, {
        headers: getAuthHeaders()
      });
      console.log(`✅ Reported skipped job ${job.id} to backend`);
    } catch (error) {
      console.error(`❌ Error reporting skipped job:`, error.message);
    }
    // Stop log capture and upload logs even for skipped jobs
    try {
      stopLogCapture(job.id);
      await uploadContainerLogs(job.id);
      clearCapturedLogs(job.id);
    } catch (logError) {
      console.error(`❌ Error handling container logs: ${logError.message}`);
    }
    return false;
  }
  
  // If still unknown after retries, log warning but proceed (job might be newly created)
  if (initialStatus === 'unknown') {
    console.log(`⚠️  Job ${job.id} status is still 'unknown' after ${maxRetries} retries, proceeding anyway (job may be newly created)`);
  }

  try {
    // Update job status from 'pending'/'queued' to 'running' when runner picks it up
    try {
      await fetch(`${BACKEND_URL}/jobs/${job.id}/status`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify({ status: 'running' })
      });
      console.log(`🔄 Updated job ${job.id} status from '${initialStatus}' to 'running'`);
    } catch (statusError) {
      console.warn(`⚠️  Failed to update job status: ${statusError.message}`);
    }

    if (job.health_check || job.context?.health_check) {
      const result = await executeHealthCheckJob(job);
      await reportJobComplete(job.id, result);
      console.log(`✅ Health check job ${job.id} completed`);
      return true;
    }
    if (job.jobType === 'security') {
      const result = await executeSecurityJob(job);
      await reportJobComplete(job.id, result);
      console.log(`✅ Security scan job ${job.id} completed`);
      return true;
    }
    if (job.jobType === 'k6_load_test') {
      const result = await executeK6LoadTestJob(job);
      await reportJobComplete(job.id, result);
      console.log(`✅ K6 load test job ${job.id} ${result.success ? 'completed' : 'failed'}`);
      return result.success;
    }
    if (job.jobType === 'login') {
      // Execute login job
      console.log(`[DEBUG] About to execute login job, job object keys:`, Object.keys(job));
      console.log(`[DEBUG] job.url=${job.url}, job.username=${job.username}, job.login_data=`, job.login_data);
      const result = await executeLoginJob(job, streamInterval);
      await reportJobComplete(job.id, result);
      console.log(`✅ Login job ${job.id} completed successfully`);
      return true;
    } else {
      // Execute crawl job
      const result = await executeCrawlJob(job, streamInterval);
      await reportJobComplete(job.id, result);
      console.log(`✅ Crawl job ${job.id} completed successfully`);
      return true;
    }

  } catch (error) {
    console.error(`❌ Job ${job.id} failed:`, error.message);
    
    // Report failure to backend
    await reportJobFailed(job.id, error.message, error.stack);
    
    return false;
  } finally {
    // Stop video streaming
    stopVideoStream(job.id);
    
    // Stop log capture and upload logs
    try {
      stopLogCapture(job.id);
      await uploadContainerLogs(job.id);
      clearCapturedLogs(job.id);
    } catch (logError) {
      console.error(`❌ Error handling container logs: ${logError.message}`);
    }
    
    currentJobId = null;
    currentPage = null;
  }
}

/**
 * Execute a login job
 */
async function executeLoginJob(job, streamInterval) {
  // Debug: Log the job object to see what we're receiving
  console.log(`[DEBUG] Received job object:`, JSON.stringify(job, null, 2));
  console.log(`[DEBUG] job.context:`, job.context);
  console.log(`[DEBUG] job.context.credentials:`, job.context?.credentials);
  console.log(`[DEBUG] job.options:`, job.options);
  console.log(`[DEBUG] job.options.credentials:`, job.options?.credentials);
  
  // Extract login credentials from job.login_data or fallback to top-level fields
  const loginData = job.login_data || {};
  const { url, username, password, maxAttempts = 2, context: jobContext = {} } = {
    url: loginData.url || job.url,
    username: loginData.username || job.username,
    password: loginData.password || job.password,
    maxAttempts: job.maxAttempts || 2,
    context: {
      ...job.context,
      options: {
        ...(job.options || {}),
        ...(job.context?.options || {})
      },
      generated_email:
        (job.context?.generated_email && typeof job.context.generated_email === 'object')
          ? job.context.generated_email
          : ((job.options?.generated_email && typeof job.options.generated_email === 'object')
              ? job.options.generated_email
              : null),
      workflow_template_id: job.context?.workflow_template_id || job.workflow_template_id || job.options?.workflow_template_id
    }
  };
  
  console.log(`[DEBUG] Extracted jobContext:`, jobContext);
  console.log(`[DEBUG] jobContext.credentials:`, jobContext.credentials);
  console.log(`[DEBUG] Top-level username:`, job.username);
  console.log(`[DEBUG] Top-level password:`, job.password ? '***' : 'MISSING');

  console.log(`[DEBUG] Extracted credentials: url=${url}, username=${username}, password=${password ? '***' : 'undefined'}`);

  if (!url || !username || !password) {
    throw new Error('Missing required fields: url, username, password');
  }

  const openaiApiKey = jobContext.openai_api_key || process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    throw new Error('OpenAI API key not provided');
  }

  // CRITICAL: ALWAYS extract credentials from available sources, regardless of what's in jobContext
  // This ensures we get valid credentials even if jobContext has "MISSING" values
  console.log(`[DEBUG] 🔍 Extracting credentials from all available sources...`);
  
  // Try to get credentials from multiple sources (in priority order)
  const credsFromContext = jobContext?.credentials && 
    jobContext.credentials.username !== 'MISSING' && jobContext.credentials.username !== 'missing' &&
    jobContext.credentials.password !== 'MISSING' && jobContext.credentials.password !== 'missing' ?
    jobContext.credentials : null;
  const credsFromOptions = job.options?.credentials && 
    job.options.credentials.username !== 'MISSING' && job.options.credentials.username !== 'missing' &&
    job.options.credentials.password !== 'MISSING' && job.options.credentials.password !== 'missing' ?
    job.options.credentials : null;
  const credsFromTopLevel = job.username && job.password && 
    job.username !== 'MISSING' && job.username !== 'missing' &&
    job.password !== 'MISSING' && job.password !== 'missing' ?
    { username: job.username, password: job.password } : null;
  const credsFromLoginData = loginData.username && loginData.password && 
    loginData.username !== 'MISSING' && loginData.username !== 'missing' &&
    loginData.password !== 'MISSING' && loginData.password !== 'missing' ?
    { username: loginData.username, password: loginData.password } : null;
  
  // Use extracted credentials (priority: context > options > top-level > login_data > function params)
  const extractedCreds = credsFromContext || credsFromOptions || credsFromTopLevel || credsFromLoginData || 
    (username && password && username !== 'MISSING' && password !== 'MISSING' ? { username, password } : null);
  
  console.log(`[DEBUG] Credential sources:`, {
    fromContext: !!credsFromContext,
    fromOptions: !!credsFromOptions,
    fromTopLevel: !!credsFromTopLevel,
    fromLoginData: !!credsFromLoginData,
    fromParams: !!(username && password),
    finalExtracted: !!extractedCreds
  });
  
  if (!extractedCreds || !extractedCreds.username || !extractedCreds.password ||
      extractedCreds.username === 'MISSING' || extractedCreds.username === 'missing' ||
      extractedCreds.password === 'MISSING' || extractedCreds.password === 'missing') {
    console.error(`[DEBUG] ❌ CREDENTIALS MISSING or INVALID from all sources!`);
    console.error(`[DEBUG] jobContext.credentials:`, jobContext?.credentials);
    console.error(`[DEBUG] job.options.credentials:`, job.options?.credentials);
    console.error(`[DEBUG] job.username/password:`, { username: job.username, password: job.password ? '***' : 'MISSING' });
    console.error(`[DEBUG] loginData:`, loginData);
    throw new Error('Credentials are required and must not contain placeholder values');
  }
  
  // ALWAYS set credentials in jobContext, overriding any existing (possibly "MISSING") values
  // CRITICAL: Ensure credentials are set correctly - don't use spread operator if credentials are MISSING
  if (!jobContext.credentials || 
      jobContext.credentials.username === 'MISSING' || jobContext.credentials.username === 'missing' ||
      jobContext.credentials.password === 'MISSING' || jobContext.credentials.password === 'missing') {
    jobContext.credentials = {
      username: extractedCreds.username,
      password: extractedCreds.password
    };
  } else {
    // Override with extracted credentials to ensure they're correct
    jobContext.credentials.username = extractedCreds.username;
    jobContext.credentials.password = extractedCreds.password;
  }
  console.log(`[DEBUG] ✅ Credentials extracted and set in jobContext: username=${extractedCreds.username}, password=***`);
  
  const finalCredentials = jobContext.credentials;
  const isValidGeneratedEmail = (value) => (
    !!value &&
    typeof value === 'object' &&
    typeof value.address === 'string' &&
    value.address.trim().length > 0 &&
    typeof value.inbox_id === 'string' &&
    value.inbox_id.trim().length > 0
  );
  const resolvedGeneratedEmail = isValidGeneratedEmail(jobContext.generated_email)
    ? jobContext.generated_email
    : isValidGeneratedEmail(jobContext.options?.generated_email)
        ? jobContext.options.generated_email
        : isValidGeneratedEmail(job.options?.generated_email)
            ? job.options.generated_email
            : isValidGeneratedEmail(jobContext.context?.generated_email)
                ? jobContext.context.generated_email
                : null;
  
  console.log(`[DEBUG] ✅ Credentials found: username=${finalCredentials.username}, password=${finalCredentials.password ? '***' : 'MISSING'}`);
  
  // CRITICAL: Create workflowExecutionContext with explicit credentials (don't rely on spread)
  const workflowExecutionContext = {
    ...jobContext,
    workflow_template_id: jobContext.workflow_template_id,
    project_id: job.project_id || jobContext.project_id || job.projectId || null,
    projectId: job.project_id || jobContext.projectId || null,
    generated_email: resolvedGeneratedEmail,
    // CRITICAL: Explicitly set credentials (don't rely on spread from jobContext)
    credentials: {
      username: finalCredentials.username,
      password: finalCredentials.password
    },
    username: finalCredentials.username, // Also set top-level for fallback
    password: finalCredentials.password, // Also set top-level for fallback
    options: {
      ...(jobContext.options || {}),
      ...(resolvedGeneratedEmail ? { generated_email: resolvedGeneratedEmail } : {}),
      openai_api_key: openaiApiKey,
      // CRITICAL: Also set credentials in options
      credentials: {
        username: finalCredentials.username,
        password: finalCredentials.password
      }
    },
    openai_api_key: openaiApiKey,
    runner_token: RUNNER_TOKEN // Add runner token for API authentication
  };
  
  console.log(`[DEBUG] ✅ workflowExecutionContext.credentials:`, { 
    username: workflowExecutionContext.credentials.username, 
    password: workflowExecutionContext.credentials.password ? '***' : 'MISSING' 
  });
  console.log(`[DEBUG] ✅ workflowExecutionContext.generated_email:`, {
    address: workflowExecutionContext.generated_email?.address || 'MISSING',
    inbox_id: workflowExecutionContext.generated_email?.inbox_id || 'MISSING'
  });

  // Launch local browser (embedded) - viewport from project (strict 1920x1080 default)
  const viewport = (jobContext.viewport && typeof jobContext.viewport.width === 'number' && typeof jobContext.viewport.height === 'number')
    ? { width: jobContext.viewport.width, height: jobContext.viewport.height }
    : { width: 1920, height: 1080 };
  console.log(`🌐 Launching local Chromium browser for login (viewport ${viewport.width}x${viewport.height})`);
  const { chromium } = await import('playwright');
  
  // Import stealth configuration
  const { 
    getStealthLaunchArgs, 
    getStealthContextOptions, 
    injectStealthScripts 
  } = await import('./browser/stealth-config.js');
  
  const browser = await chromium.launch({ 
    headless: true,
    args: getStealthLaunchArgs(viewport)
  });

  const context = await browser.newContext(
    getStealthContextOptions({
      viewport,
      recordVideo: {
        dir: '/tmp/aionqa_videos',
        size: viewport
      }
    })
  );

  const page = await context.newPage();
  
  // Inject stealth scripts to hide automation
  await injectStealthScripts(page);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Check if DOM is ready after 30s, continue anyway if not
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {
      console.warn(`Page DOM not fully loaded after 30s, continuing anyway`);
    });
    await page.waitForTimeout(1000);
    console.log(`[DEBUG] Navigated to login URL: ${page.url()}`);

    // Start video recording (full video for playback) - AFTER page navigation
    videoRecorder.startRecording(job.id, context, page);
    
    // Start real-time video streaming (live frames)
    startVideoStream(page, job.id);

    console.log(
      `[DEBUG] About to execute login workflow with context:`,
      JSON.stringify({
        workflow_template_id: workflowExecutionContext.workflow_template_id,
        project_id: workflowExecutionContext.project_id
      })
    );

    const result = await executeLoginWithWorkflow(
      page,
      job.id,
      url,
      openaiApiKey,
      workflowExecutionContext
    );

    // CRITICAL: Ensure result has all required fields for login jobs
    // Extract cookies from multiple possible locations
    let cookies = [];
    if (Array.isArray(result.cookies)) {
      cookies = result.cookies;
      console.log(`🍪 Found ${cookies.length} cookie(s) in result.cookies`);
    } else if (Array.isArray(result.iterationCookies)) {
      cookies = result.iterationCookies;
      console.log(`🍪 Found ${cookies.length} cookie(s) in result.iterationCookies`);
    } else if (result.workflowResult?.workflowState?.finalCookies && Array.isArray(result.workflowResult.workflowState.finalCookies)) {
      cookies = result.workflowResult.workflowState.finalCookies;
      console.log(`🍪 Found ${cookies.length} cookie(s) in workflowState.finalCookies`);
    } else if (result.workflowResult?.workflowState?.iterationCookies && Array.isArray(result.workflowResult.workflowState.iterationCookies)) {
      cookies = result.workflowResult.workflowState.iterationCookies;
      console.log(`🍪 Found ${cookies.length} cookie(s) in workflowState.iterationCookies`);
    }
    
    // If no cookies found in result, try to collect from page context
    if (cookies.length === 0) {
      console.log(`🍪 No cookies in result, collecting from current page context`);
      try {
        cookies = await context.cookies();
        console.log(`🍪 Collected ${cookies.length} cookie(s) from page context`);
      } catch (cookieError) {
        console.warn(`⚠️ Failed to collect cookies from page context: ${cookieError.message}`);
      }
    }

    // CRITICAL: Ensure result has all required fields
    const finalResult = {
      success: result.success || false,
      loginStatus: result.loginStatus || (result.success ? 'success' : 'unknown'),
      determineResult: result.determineResult || null,
      cookies: cookies, // CRITICAL: Always include cookies array
      cookiesCollected: cookies.length, // CRITICAL: Include count
      workflowResult: result.workflowResult || null,
      error: result.error || null
    };

    if (result.success && cookies.length > 0) {
      const { safeGetLocalStorage, safeGetSessionStorage } = await import('./crawling/unified-operations.js');

      const localStorage = await safeGetLocalStorage(page);
      const sessionStorage = await safeGetSessionStorage(page);

      finalResult.authTokens = {
        cookies,
        localStorage,
        sessionStorage,
        finalUrl: page.url()
      };
      
      console.log(`✅ Login successful: ${cookies.length} cookie(s) collected, loginStatus: ${finalResult.loginStatus}`);
    } else {
      console.log(`⚠️ Login result: success=${result.success}, cookies=${cookies.length}, loginStatus=${finalResult.loginStatus}`);
      if (result.error) {
        console.log(`   Error: ${result.error}`);
      }
    }

    return finalResult;
  } finally {
    // Stop video streaming
    stopVideoStream(job.id);
    
    // Stop video recording and upload
    console.log(`Finalizing video recording for job ${job.id}...`);
    const videoInfo = await videoRecorder.stopRecording(job.id);
    if (videoInfo) {
      console.log(`✅ Video uploaded: ${videoInfo.videoKey} (${videoInfo.sizeMB} MB, ${videoInfo.duration}s)`);
    }
    
    // Clean up
    await context.close();
    await browser.close();
  }
}

/**
 * Execute a crawl job
 */
async function executeCrawlJob(job, streamInterval) {
  const operation = job.operation || job.options?.operation || job.context?.operation;
  if (operation === 'sitemap_scan') {
    return executeSitemapScanJob(job);
  }
  if (operation === 'availability_check') {
    return executeAvailabilityCheckJob(job);
  }
  if (operation === 'dns_certificate_scan') {
    return executeDnsCertificateScanJob(job);
  }
  if (operation === 'complexities_scan') {
    return executeComplexitiesScanJob(job);
  }

  // Extract job parameters
  // CRITICAL: URL can be at job.url, job.start_url, or job.seed_url (from jobs collection)
  let url = job.url || job.start_url || job.seed_url || null;
  // Ensure URL has scheme (page.goto fails with "invalid URL" for e.g. "tests.aionqa.com")
  if (url && typeof url === 'string') {
    const t = url.trim();
    if (t && !t.startsWith('http://') && !t.startsWith('https://')) {
      url = `https://${t}`;
    }
  }
  const rawContext = job.context || {};
  const jobOptions = job.options || {};
  const projectId = rawContext.project_id || job.project_id || null;

  if (!rawContext.project_id && projectId) {
    rawContext.project_id = projectId;
  }

  if (!rawContext.llm_config && projectId) {
    try {
      const llmResponse = await axios.get(`${BACKEND_URL}/api/projects/${projectId}/llm-config`, {
        headers: getAuthHeaders(),
        timeout: 10000
      });
      rawContext.llm_config = llmResponse.data;
      console.log(`[DEBUG] ✅ Loaded LLM config for project ${projectId} via backend`);
    } catch (error) {
      console.warn(`⚠️  Failed to load LLM config for project ${projectId}: ${error.message}`);
    }
  }
  
  // CRITICAL: Get cookies from context first (from credentials/login_job), then fall back to job.cookies
  const cookies = rawContext?.cookies || job.cookies || [];
  
  // CRITICAL: Get login redirection handling config
  const handleLoginRedirect = rawContext?.handle_login_redirect || jobOptions?.handle_login_redirect || 'auto_retry';
  const credentialsId = rawContext?.credentials_id || null;
  const loginJobId = rawContext?.login_job_id || null;
  
  // CRITICAL: Always extract credentials from top-level fields and override any "MISSING" values
  const credsFromOptions = jobOptions?.credentials;
  const credsFromTopLevel = job.username && job.password && 
    job.username !== 'MISSING' && job.password !== 'MISSING' ? 
    { username: job.username, password: job.password } : null;
  const credsFromLoginData = job.login_data?.username && job.login_data?.password && 
    job.login_data.username !== 'MISSING' && job.login_data.password !== 'MISSING' ? 
    { username: job.login_data.username, password: job.login_data.password } : null;
  
  const extractedCreds = credsFromOptions || credsFromTopLevel || credsFromLoginData;
  
  // CRITICAL: Always set credentials in context, overriding any "MISSING" values
  if (extractedCreds && extractedCreds.username && extractedCreds.password &&
      extractedCreds.username !== 'MISSING' && extractedCreds.password !== 'MISSING') {
    rawContext.credentials = {
      username: extractedCreds.username,
      password: extractedCreds.password
    };
    console.log(`[DEBUG] ✅ Credentials extracted for crawl job from top-level: username=${extractedCreds.username}, password=***`);
  } else if (!rawContext.credentials || 
      rawContext.credentials.username === 'MISSING' || rawContext.credentials.password === 'MISSING') {
    console.warn(`[DEBUG] ⚠️ No valid credentials found in job for crawl job ${job.id}`);
    console.warn(`[DEBUG] job.username:`, job.username);
    console.warn(`[DEBUG] job.password:`, job.password ? '***' : 'MISSING');
    console.warn(`[DEBUG] job.options.credentials:`, credsFromOptions);
  }
  
  if (!url) {
    throw new Error(`Missing URL in job object. Available keys: ${Object.keys(job).join(', ')}`);
  }
  const executeWorkflowFlag =
    rawContext?.execute_workflow !== undefined
      ? rawContext.execute_workflow
      : (jobOptions?.execute_workflow !== undefined
          ? jobOptions.execute_workflow
          : true);

  const singleActionOnlyValue =
    rawContext?.single_action_only !== undefined
      ? rawContext.single_action_only
      : (rawContext?.options?.single_action_only !== undefined
          ? rawContext.options.single_action_only
          : (jobOptions?.single_action_only !== undefined
              ? jobOptions.single_action_only
              : false));

  const mergedOptions = {
    ...jobOptions,
    ...(rawContext?.options || {})
  };

  // CRITICAL: Ensure credentials are in rawContext before building normalizedContext
  if (extractedCreds && extractedCreds.username && extractedCreds.password &&
      extractedCreds.username !== 'MISSING' && extractedCreds.password !== 'MISSING') {
    rawContext.credentials = {
      username: extractedCreds.username,
      password: extractedCreds.password
    };
    console.log(`[DEBUG] ✅ Credentials set in rawContext: username=${extractedCreds.username}, password=***`);
  }
  
  const normalizedContext = {
    ...rawContext,
    execute_workflow: executeWorkflowFlag,
    single_action_only: Boolean(singleActionOnlyValue),
    // Ensure redirect handling config is always present for unified-operations
    handle_login_redirect: handleLoginRedirect,
    // CRITICAL: Ensure credentials are explicitly set in normalizedContext
    credentials: rawContext.credentials || (extractedCreds && extractedCreds.username !== 'MISSING' ? extractedCreds : undefined),
    // CRITICAL: For login jobs, ensure jobType is set in context so login redirect handler can skip them
    // Check top-level job.jobType and set it in context if it's a login job
    jobType: rawContext.jobType || (job.jobType === 'login' ? 'login' : undefined),
    job_type: rawContext.job_type || (job.jobType === 'login' ? 'login' : undefined),
    isLoginJob: rawContext.isLoginJob || (job.jobType === 'login' ? true : undefined),
    preventCrawling: rawContext.preventCrawling || (job.jobType === 'login' ? true : undefined),
    options: {
      ...mergedOptions,
      execute_workflow: executeWorkflowFlag,
      single_action_only: Boolean(singleActionOnlyValue),
      handle_login_redirect: handleLoginRedirect
    }
  };
  
  // CRITICAL: Final check - ensure credentials are in normalizedContext
  if (normalizedContext.credentials && 
      (normalizedContext.credentials.username === 'MISSING' || normalizedContext.credentials.password === 'MISSING')) {
    if (extractedCreds && extractedCreds.username !== 'MISSING' && extractedCreds.password !== 'MISSING') {
      normalizedContext.credentials = {
        username: extractedCreds.username,
        password: extractedCreds.password
      };
      console.log(`[DEBUG] ✅ Credentials overridden in normalizedContext: username=${extractedCreds.username}, password=***`);
    }
  }
  
  console.log(`[DEBUG] normalizedContext.credentials:`, normalizedContext.credentials ? 
    { username: normalizedContext.credentials.username, password: normalizedContext.credentials.password ? '***' : 'MISSING' } : 
    'MISSING');

  // Crawl jobs can run without OpenAI configured (deterministic workflows / fallbacks).
  // Login jobs still require an AI provider, but crawl jobs should degrade gracefully.
  const openaiApiKey = normalizedContext.openai_api_key || process.env.OPENAI_API_KEY || null;
  if (!openaiApiKey) {
    console.warn(`⚠️ OpenAI API key not provided for crawl job ${job.id} - continuing without AI provider`);
  }

  // Track final video info so we can log once
  let recordedVideoInfo = null;

  // Set job_id in context for logging and pass stream callback
  // Ensure project_id is in context (it might be at job.project_id or in context)
  // CRITICAL: Extract workflow_template_id from job object (can be at multiple locations)
  const workflowTemplateId = 
    normalizedContext.workflow_template_id || 
    job.workflow_template_id || 
    job.context?.workflow_template_id || 
    jobOptions.workflow_template_id || 
    mergedOptions.workflow_template_id || 
    null;
  
  const executionContext = {
    ...normalizedContext,
    job_id: job.id != null ? String(job.id) : null,
    project_id: job.project_id || normalizedContext.project_id || job.context?.project_id || null,
    projectId: job.project_id || normalizedContext.projectId || job.context?.projectId || null,
    workflow_template_id: workflowTemplateId, // CRITICAL: Must be set for workflow mode
    useRemoteBrowser: false, // Use local browser (embedded)
    runnerId: RUNNER_ID,
    runner_token: RUNNER_TOKEN, // Add runner token for API calls
    videoRecorder,
    onPageReady: (page) => {
      // Start real-time video streaming when page is ready
      currentPage = page;
      startVideoStream(page, job.id);
    },
    onContextReady: (context, page) => {
      // Start video recording when context is ready
      videoRecorder.startRecording(job.id, context, page);
      console.log(`Video recording and streaming started for crawl job ${job.id}`);
    },
    beforeBrowserClose: async () => {
      try {
        recordedVideoInfo = recordedVideoInfo || await videoRecorder.stopRecording(job.id);
      } catch (error) {
        console.error(`Failed to finalize video before browser close for job ${job.id}:`, error.message);
      }
    }
  };

  try {
    // Execute crawl using existing function
    const result = await startCrawl(url, cookies, executionContext, openaiApiKey);
    return result;
  } finally {
    // Stop video streaming
    stopVideoStream(job.id);
    
    // Stop video recording and upload
    try {
      if (!recordedVideoInfo) {
        console.log(`Finalizing video recording for crawl job ${job.id}...`);
        recordedVideoInfo = await videoRecorder.stopRecording(job.id);
      }
      if (recordedVideoInfo) {
        console.log(`✅ Video uploaded: ${recordedVideoInfo.videoKey} (${recordedVideoInfo.sizeMB} MB, ${recordedVideoInfo.duration}s)`);
      } else {
        console.warn(`No video recorded for crawl job ${job.id}`);
      }
    } catch (videoError) {
      console.error(`Error finalizing video recording for crawl job ${job.id}:`, videoError.message);
    }
  }
}

async function executeSitemapScanJob(job) {
  const jobId = job.id;
  const context = job.context || {};
  const projectId = job.project_id || context.project_id || job.projectId || null;
  const baseUrl = context.base_url || job.start_url || job.url;
  if (!baseUrl) {
    throw new Error('Sitemap scan job missing base_url');
  }

  await appendJobLog(jobId, 'info', `🗺️ Starting sitemap scan for ${baseUrl}`, { project_id: projectId });

  const includeImages = context.include_images === true || job.options?.include_images === true;
  const sitemapUrl = await discoverSitemapUrl(jobId, baseUrl, context.sitemap_url);
  const xmlContent = await fetchSitemapXml(jobId, sitemapUrl);
  const parsed = await parseSitemapDocument(jobId, xmlContent, sitemapUrl, includeImages);

  const snapshotPayload = {
    project_id: projectId,
    job_id: jobId,
    sitemap_url: sitemapUrl,
    include_images: includeImages,
    entries: parsed.entries,
    entry_count: parsed.totalEntries,
    image_count: parsed.imageCount,
    raw_xml: xmlContent
  };

  await axios.post(`${BACKEND_URL}/sitemaps/snapshots`, snapshotPayload, {
    timeout: 20000,
    headers: getAuthHeaders()
  });

  await appendJobLog(jobId, 'info', `✅ Sitemap scan completed (${parsed.entries.length}/${parsed.totalEntries} URLs stored)`, {
    sitemap_url: sitemapUrl,
    total_entries: parsed.totalEntries,
    stored_entries: parsed.entries.length,
    image_count: parsed.imageCount,
    truncated: parsed.truncated
  });

  return {
    success: true,
    sitemap_url: sitemapUrl,
    entry_count: parsed.totalEntries,
    stored_entries: parsed.entries.length,
    image_count: parsed.imageCount,
    truncated: parsed.truncated
  };
}

async function discoverSitemapUrl(jobId, baseUrl, overrideUrl) {
  if (overrideUrl) {
    return overrideUrl;
  }

  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch (error) {
    throw new Error(`Invalid base URL: ${baseUrl}`);
  }

  const candidates = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemaps.xml`
  ];

  for (const candidate of candidates) {
    try {
      const response = await axios.head(candidate, {
        timeout: 5000,
        validateStatus: () => true
      });
      if (response.status >= 200 && response.status < 400) {
        await appendJobLog(jobId, 'info', `🔎 Found sitemap at ${candidate}`);
        return candidate;
      }
    } catch (error) {
      // Continue to next candidate
    }
  }

  throw new Error(`Could not find sitemap at common locations`);
}

async function fetchSitemapXml(jobId, sitemapUrl) {
  try {
    const response = await axios.get(sitemapUrl, {
      timeout: 30000,
      responseType: 'text',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AionQA/1.0)'
      }
    });
    if (!response.data) {
      throw new Error('Sitemap response is empty');
    }
    return typeof response.data === 'string' ? response.data : response.data.toString();
  } catch (error) {
    await appendJobLog(jobId, 'error', `❌ Failed to fetch sitemap ${sitemapUrl}: ${error.message}`);
    throw new Error(`Failed to fetch sitemap: ${error.message}`);
  }
}

async function parseSitemapDocument(jobId, xmlContent, sitemapUrl, includeImages, depth = 0, visited = new Set()) {
  if (!xmlContent || typeof xmlContent !== 'string') {
    throw new Error('Invalid sitemap content');
  }

  const entries = [];
  let totalEntries = 0;
  let imageCount = 0;
  let truncated = false;
  visited.add(sitemapUrl);

  const isIndex = /<\s*sitemapindex/i.test(xmlContent);
  if (isIndex && depth < MAX_SITEMAP_SCAN_DEPTH) {
    const sitemapMatches = xmlContent.match(/<\s*loc>([\s\S]*?)<\/\s*loc>/gi) || [];
    for (const match of sitemapMatches.slice(0, MAX_SITEMAP_SCAN_CHILD_SITEMAPS)) {
      const childUrl = extractXmlTagValue(match, 'loc');
      if (!childUrl) continue;
      if (visited.has(childUrl)) {
        continue;
      }
      try {
        const childXml = await fetchSitemapXml(jobId, childUrl);
        const childParsed = await parseSitemapDocument(jobId, childXml, childUrl, includeImages, depth + 1, visited);
        totalEntries += childParsed.totalEntries;
        imageCount += childParsed.imageCount;
        truncated = truncated || childParsed.truncated;
        for (const entry of childParsed.entries) {
          if (entries.length >= MAX_SITEMAP_SCAN_ENTRIES) {
            truncated = true;
            break;
          }
          entries.push(entry);
        }
        if (entries.length >= MAX_SITEMAP_SCAN_ENTRIES) {
          break;
        }
      } catch (error) {
        await appendJobLog(jobId, 'warn', `⚠️ Failed to parse child sitemap ${childUrl}: ${error.message}`);
      }
    }
  } else {
    const urlBlocks = xmlContent.match(/<\s*url\b[\s\S]*?<\/\s*url>/gi) || [];
    totalEntries = urlBlocks.length;
    for (const block of urlBlocks) {
      if (entries.length >= MAX_SITEMAP_SCAN_ENTRIES) {
        truncated = true;
        break;
      }
      const pageUrl = extractXmlTagValue(block, 'loc');
      if (!pageUrl) continue;

      entries.push({
        url: pageUrl.trim(),
        type: 'page',
        lastmod: extractXmlTagValue(block, 'lastmod'),
        changefreq: extractXmlTagValue(block, 'changefreq'),
        priority: extractXmlTagValue(block, 'priority')
      });

      if (includeImages) {
        const imageBlocks = block.match(/<\s*image:image[\s\S]*?<\/\s*image:image>/gi) || [];
        imageCount += imageBlocks.length;
      }
    }
  }

  return {
    entries,
    totalEntries,
    imageCount,
    truncated
  };
}

function extractXmlTagValue(content, tagName) {
  if (!content || !tagName) {
    return null;
  }
  const escapedTag = tagName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const regex = new RegExp(`<\\s*${escapedTag}[^>]*>([\\s\\S]*?)<\\s*/\\s*${escapedTag}>`, 'i');
  const match = content.match(regex);
  if (match && match[1]) {
    return match[1].trim();
  }
  return null;
}

async function executeAvailabilityCheckJob(job) {
  const jobId = job.id;
  const context = job.context || {};
  const snapshotId = context.snapshot_id;
  const urls = Array.isArray(context.urls) ? context.urls.filter(Boolean) : [];
  if (!snapshotId || urls.length === 0) {
    throw new Error('Availability job missing snapshot_id or urls');
  }

  const timeoutMs = Number(job.options?.timeout_ms) || DEFAULT_AVAILABILITY_TIMEOUT_MS;
  await appendJobLog(jobId, 'info', `🔍 Checking availability for ${urls.length} URLs`, { snapshot_id: snapshotId, timeout_ms: timeoutMs });

  const results = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const index = i + 1;
    await appendJobLog(jobId, 'info', `🔍 [${index}/${urls.length}] Checking: ${url}`, { 
      snapshot_id: snapshotId, 
      url_index: index,
      total_urls: urls.length,
      url: url
    });
    
    const result = await checkSingleUrlAvailability(url, timeoutMs);
    results.push(result);
    
    // Log result
    if (result.ok) {
      await appendJobLog(jobId, 'info', `✅ [${index}/${urls.length}] ${url} - Status: ${result.status} (${result.response_time_ms}ms)`, {
        snapshot_id: snapshotId,
        url_index: index,
        total_urls: urls.length,
        url: url,
        status: result.status,
        response_time_ms: result.response_time_ms,
        ok: true
      });
    } else {
      await appendJobLog(jobId, 'warn', `❌ [${index}/${urls.length}] ${url} - Failed: ${result.error || `Status ${result.status}`} (${result.response_time_ms}ms)`, {
        snapshot_id: snapshotId,
        url_index: index,
        total_urls: urls.length,
        url: url,
        status: result.status,
        response_time_ms: result.response_time_ms,
        error: result.error,
        ok: false
      });
    }
  }

  await axios.post(`${BACKEND_URL}/api/runner/sitemaps/${snapshotId}/availability-results`, {
    job_id: jobId,
    results
  }, {
    headers: getAuthHeaders(),
    timeout: 20000
  });

  const upCount = results.filter(r => r.ok).length;
  const downCount = results.filter(r => !r.ok).length;

  await appendJobLog(jobId, 'info', `✅ Availability check complete (up: ${upCount}, down: ${downCount})`, {
    snapshot_id: snapshotId,
    total: results.length,
    up: upCount,
    down: downCount
  });

  return {
    success: true,
    snapshot_id: snapshotId,
    checked: results.length,
    up: upCount,
    down: downCount
  };
}

async function checkSingleUrlAvailability(url, timeoutMs) {
  const startedAt = Date.now();
  try {
    let response = await axios.head(url, {
      timeout: timeoutMs,
      validateStatus: () => true
    });

    if (!response || response.status === 405 || response.status === 501) {
      response = await axios.get(url, {
        timeout: timeoutMs,
        maxContentLength: 0,
        validateStatus: () => true
      });
    }

    const ok = response.status >= 200 && response.status < 400;
    return {
      url,
      status: response.status,
      ok,
      response_time_ms: Date.now() - startedAt,
      error: null
    };
  } catch (error) {
    return {
      url,
      status: null,
      ok: false,
      response_time_ms: Date.now() - startedAt,
      error: error.message
    };
  }
}

function normalizeScanTargetUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) {
    throw new Error('Missing target URL');
  }
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return new URL(withScheme);
}

function buildDnsError(error) {
  if (!error) return null;
  return {
    code: error.code || null,
    message: String(error.message || error)
  };
}

async function resolveDnsRecords(hostname) {
  const lookupStartedAt = Date.now();
  let lookup = [];
  let lookupError = null;
  try {
    lookup = await dnsPromises.lookup(hostname, { all: true });
  } catch (error) {
    lookupError = buildDnsError(error);
  }

  const recordResolvers = {
    A: async () => dnsPromises.resolve4(hostname),
    AAAA: async () => dnsPromises.resolve6(hostname),
    CNAME: async () => dnsPromises.resolveCname(hostname),
    MX: async () => dnsPromises.resolveMx(hostname),
    NS: async () => dnsPromises.resolveNs(hostname),
    TXT: async () => dnsPromises.resolveTxt(hostname)
  };

  const records = {};
  const errors = {};

  await Promise.all(Object.entries(recordResolvers).map(async ([recordType, resolver]) => {
    try {
      const values = await resolver();
      if (recordType === 'TXT') {
        records[recordType] = values.map((chunk) => Array.isArray(chunk) ? chunk.join('') : String(chunk));
      } else if (recordType === 'MX') {
        records[recordType] = values
          .map((mx) => ({ exchange: mx.exchange || null, priority: Number(mx.priority) || 0 }))
          .sort((a, b) => a.priority - b.priority);
      } else {
        records[recordType] = values;
      }
    } catch (error) {
      records[recordType] = [];
      errors[recordType] = buildDnsError(error);
    }
  }));

  const addressMap = new Map();
  const addAddress = (address, family, source) => {
    if (!address) return;
    const key = `${String(address)}|${Number(family) || 0}`;
    if (addressMap.has(key)) return;
    addressMap.set(key, {
      address: String(address),
      family: Number(family) || null,
      source
    });
  };

  for (const row of lookup) {
    addAddress(row?.address, row?.family, 'lookup');
  }
  for (const ip of records.A || []) {
    addAddress(ip, 4, 'A');
  }
  for (const ip of records.AAAA || []) {
    addAddress(ip, 6, 'AAAA');
  }

  const addresses = Array.from(addressMap.values());
  const hasAnyRecords = addresses.length > 0 || Object.values(records).some((entry) => Array.isArray(entry) && entry.length > 0);

  return {
    ok: hasAnyRecords,
    checked_at: new Date().toISOString(),
    hostname,
    lookup_time_ms: Date.now() - lookupStartedAt,
    lookup,
    addresses,
    records,
    errors: {
      ...(lookupError ? { lookup: lookupError } : {}),
      ...errors
    }
  };
}

async function collectCertificateInfo(targetUrl, timeoutMs) {
  const checkedAt = new Date().toISOString();
  if (!(targetUrl instanceof URL)) {
    return {
      ok: false,
      status: 'invalid_target',
      message: 'Invalid URL',
      checked_at: checkedAt
    };
  }
  if (targetUrl.protocol !== 'https:') {
    return {
      ok: false,
      status: 'invalid_target',
      message: 'Certificate check requires HTTPS URL',
      checked_url: targetUrl.toString(),
      checked_at: checkedAt
    };
  }

  const startedAt = Date.now();
  return new Promise((resolve) => {
    const req = https.request({
      hostname: targetUrl.hostname,
      port: targetUrl.port || 443,
      path: `${targetUrl.pathname || '/'}${targetUrl.search || ''}`,
      method: 'GET',
      timeout: timeoutMs,
      rejectUnauthorized: false
    }, (res) => {
      const responseTimeMs = Date.now() - startedAt;
      const socket = res.socket;
      const cert = socket?.getPeerCertificate?.();

      if (!cert || Object.keys(cert).length === 0) {
        resolve({
          ok: false,
          status: 'no_certificate',
          message: 'No peer certificate',
          checked_url: targetUrl.toString(),
          response_time_ms: responseTimeMs,
          checked_at: checkedAt
        });
        return;
      }

      const now = new Date();
      const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
      const validFrom = cert.valid_from ? new Date(cert.valid_from) : null;
      const isExpired = validTo ? now > validTo : true;
      const notYetValid = validFrom ? now < validFrom : false;
      const ok = !isExpired && !notYetValid;

      resolve({
        ok,
        status: ok ? 'ok' : (isExpired ? 'expired' : 'not_yet_valid'),
        checked_url: targetUrl.toString(),
        hostname: targetUrl.hostname,
        http_status: Number.isFinite(Number(res.statusCode)) ? Number(res.statusCode) : null,
        response_time_ms: responseTimeMs,
        protocol: socket?.getProtocol?.() || null,
        cipher: socket?.getCipher?.() || null,
        subject: cert.subject || null,
        issuer: cert.issuer || null,
        subject_alt_name: cert.subjectaltname || null,
        serial_number: cert.serialNumber || null,
        fingerprint_sha1: cert.fingerprint || null,
        fingerprint_sha256: cert.fingerprint256 || null,
        valid_from: validFrom ? validFrom.toISOString() : null,
        valid_to: validTo ? validTo.toISOString() : null,
        days_until_expiry: validTo ? Math.floor((validTo - now) / (24 * 60 * 60 * 1000)) : null,
        checked_at: checkedAt
      });
    });

    req.on('error', (error) => {
      resolve({
        ok: false,
        status: 'error',
        message: String(error.message || error),
        checked_url: targetUrl.toString(),
        response_time_ms: Date.now() - startedAt,
        checked_at: checkedAt
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        ok: false,
        status: 'timeout',
        message: 'Connection timeout',
        checked_url: targetUrl.toString(),
        response_time_ms: Date.now() - startedAt,
        checked_at: checkedAt
      });
    });

    req.end();
  });
}

async function executeDnsCertificateScanJob(job) {
  const jobId = job.id;
  const context = job.context || {};
  const timeoutMs = Math.min(Math.max(Number(job.options?.timeout_ms) || DEFAULT_AVAILABILITY_TIMEOUT_MS, 1000), 60000);

  const targetUrl = normalizeScanTargetUrl(
    context.target_url ||
    job.start_url ||
    job.url ||
    context.base_url ||
    ''
  );

  const host = targetUrl.hostname;
  await appendJobLog(jobId, 'info', `🌐 Starting DNS + certificate scan for ${targetUrl.toString()}`, {
    target_url: targetUrl.toString(),
    hostname: host,
    timeout_ms: timeoutMs
  });

  const dns = await resolveDnsRecords(host);
  const certificate = await collectCertificateInfo(targetUrl, timeoutMs);

  await appendJobLog(
    jobId,
    dns.ok ? 'info' : 'warn',
    `🌐 DNS info collected (${dns.addresses.length} address${dns.addresses.length === 1 ? '' : 'es'})`,
    {
      hostname: host,
      addresses: dns.addresses.length,
      has_lookup_error: !!dns.errors?.lookup
    }
  );

  await appendJobLog(
    jobId,
    certificate.ok ? 'info' : 'warn',
    `🔐 Certificate check ${certificate.ok ? 'passed' : `reported ${certificate.status || 'unknown status'}`}`,
    {
      target_url: targetUrl.toString(),
      cert_status: certificate.status || null,
      valid_to: certificate.valid_to || null,
      days_until_expiry: certificate.days_until_expiry ?? null
    }
  );

  const healthy = dns.ok && certificate.ok;
  return {
    success: true,
    dns_certificate: {
      checked_at: new Date().toISOString(),
      target_url: targetUrl.toString(),
      hostname: host,
      timeout_ms: timeoutMs,
      healthy,
      dns,
      certificate
    }
  };
}

const LEGACY_STACK_RULES = [
  {
    key: 'angularjs-1x',
    label: 'AngularJS 1.x',
    severity: 'high',
    scriptRegex: /(?:^|[\/._-])angular(?:\.min)?\.js(?:\?|$)/i,
    htmlRegex: /\bng-app\b|angular\.module\s*\(/i
  },
  {
    key: 'jquery-1x-2x',
    label: 'jQuery 1.x/2.x',
    severity: 'high',
    scriptRegex: /jquery(?:[-.]|\.min\.)(?:1|2)\./i,
    htmlRegex: /\$\.(?:browser|live|delegate)\s*\(|jQuery\.(?:browser|fn\.live)\b/i
  },
  {
    key: 'backbone',
    label: 'Backbone.js',
    severity: 'medium',
    scriptRegex: /backbone(?:\.min)?\.js/i,
    htmlRegex: /\bBackbone\./i
  },
  {
    key: 'prototype-js',
    label: 'Prototype.js',
    severity: 'high',
    scriptRegex: /(?:^|[\/._-])prototype(?:\.min)?\.js(?:\?|$)/i,
    htmlRegex: /\bPrototype\./i
  },
  {
    key: 'dojo',
    label: 'Dojo',
    severity: 'medium',
    scriptRegex: /(?:^|[\/._-])dojo(?:\.min)?\.js(?:\?|$)|\/dojo\/dojo\.js/i,
    htmlRegex: /require\s*\(\s*\[\s*["']dojo\//i
  },
  {
    key: 'mootools',
    label: 'MooTools',
    severity: 'medium',
    scriptRegex: /mootools(?:\.min)?\.js/i,
    htmlRegex: /\bMooTools\b/i
  },
  {
    key: 'extjs',
    label: 'Ext JS',
    severity: 'high',
    scriptRegex: /ext(?:\.all)?(?:\.min)?\.js/i,
    htmlRegex: /\bExt\./i
  },
  {
    key: 'requirejs',
    label: 'RequireJS/AMD bootstrap',
    severity: 'medium',
    scriptRegex: /require(?:\.min)?\.js/i,
    htmlRegex: /\bdefine\s*\(\s*\[|\brequirejs\b/i
  },
  {
    key: 'document-write',
    label: 'document.write usage',
    severity: 'medium',
    htmlRegex: /document\.write\s*\(/i
  }
];

function normalizeUrlForComplexityMatching(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const value = rawUrl.trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return value.split('#')[0].split('?')[0].trim().replace(/\/+$/, '');
  }
}

function extractHtmlAttr(tagSource, attrName) {
  if (!tagSource || !attrName) return '';
  const escaped = String(attrName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const attrRegex = new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`, 'i');
  const match = String(tagSource).match(attrRegex);
  if (!match) return '';
  return (match[1] || match[2] || match[3] || '').trim();
}

function truncateEvidence(value, maxLength = 180) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function severityRank(severity) {
  const map = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
  return map[String(severity || '').toLowerCase()] || 0;
}

function detectLegacyStackSignals({ html, scriptSources = [] }) {
  const htmlText = String(html || '');
  const joinedScripts = scriptSources.join('\n');
  const hits = [];
  for (const rule of LEGACY_STACK_RULES) {
    let evidence = '';
    let matched = false;

    if (rule.scriptRegex) {
      for (const src of scriptSources) {
        if (rule.scriptRegex.test(src)) {
          matched = true;
          evidence = src;
          break;
        }
      }
      if (!matched && rule.scriptRegex.test(joinedScripts)) {
        matched = true;
      }
    }

    if (!matched && rule.htmlRegex && rule.htmlRegex.test(htmlText)) {
      matched = true;
      evidence = rule.key;
    }

    if (matched) {
      hits.push({
        key: rule.key,
        label: rule.label,
        severity: rule.severity,
        evidence: truncateEvidence(evidence || rule.label, 180)
      });
    }
  }
  return hits;
}

function buildComplexitySeverity(score) {
  if (score >= 24) return 'critical';
  if (score >= 14) return 'high';
  if (score >= 7) return 'medium';
  if (score > 0) return 'low';
  return 'none';
}

function analyzeComplexityForPage(pageLike, wsBucket = null) {
  const pageId = pageLike?._id ? String(pageLike._id) : '';
  const pageUrl = String(pageLike?.url || '').trim();
  const pageTitle = String(pageLike?.title || '').trim();
  const html = typeof pageLike?.content === 'string' ? pageLike.content : '';
  const existingComplexities = pageLike?.complexities_analysis && typeof pageLike.complexities_analysis === 'object'
    ? pageLike.complexities_analysis
    : null;

  const wsMessageCount = Number(wsBucket?.message_count) || 0;
  const wsEndpointsFromMessages = Array.isArray(wsBucket?.endpoints)
    ? wsBucket.endpoints.filter(Boolean).slice(0, 25)
    : [];

  if (!html && wsMessageCount === 0 && existingComplexities) {
    return {
      ...existingComplexities,
      page_id: pageId || String(existingComplexities.page_id || ''),
      url: pageUrl || String(existingComplexities.url || ''),
      title: pageTitle || String(existingComplexities.title || ''),
      analyzed_at: new Date().toISOString(),
      source: 'existing_analysis'
    };
  }

  let pageOrigin = '';
  try {
    pageOrigin = new URL(pageUrl).origin;
  } catch {
    pageOrigin = '';
  }

  const iframeTags = html ? (html.match(/<iframe\b[^>]*>/gi) || []) : [];
  const iframeSamples = [];
  let iframeExternalCount = 0;
  for (const tag of iframeTags.slice(0, 60)) {
    const rawSrc = extractHtmlAttr(tag, 'src');
    if (!rawSrc) continue;
    let normalizedSrc = rawSrc;
    let isExternal = false;
    try {
      const resolved = new URL(rawSrc, pageUrl || undefined);
      normalizedSrc = resolved.toString();
      isExternal = Boolean(pageOrigin && resolved.origin && resolved.origin !== pageOrigin);
    } catch {
      isExternal = false;
    }
    if (isExternal) iframeExternalCount += 1;
    if (iframeSamples.length < 12) {
      iframeSamples.push({
        src: truncateEvidence(normalizedSrc, 220),
        external: isExternal
      });
    }
  }

  const scriptSrcMatches = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)];
  const scriptSources = [...new Set(scriptSrcMatches.map((m) => String(m?.[1] || '').trim()).filter(Boolean))].slice(0, 200);
  const inlineScriptCount = (html.match(/<script\b(?![^>]*\bsrc=)[^>]*>/gi) || []).length;
  const inlineEventHandlerCount = (html.match(/\son[a-z]+\s*=/gi) || []).length;

  let thirdPartyScriptCount = 0;
  for (const src of scriptSources) {
    try {
      const resolved = new URL(src, pageUrl || undefined);
      if (pageOrigin && resolved.origin && resolved.origin !== pageOrigin) {
        thirdPartyScriptCount += 1;
      }
    } catch {
      // Ignore malformed script URLs.
    }
  }

  const staticWsLiterals = [...new Set(
    (html.match(/wss?:\/\/[^\s"'<>`]+/gi) || [])
      .map((entry) => entry.trim())
      .filter(Boolean)
  )].slice(0, 30);
  const staticWsCtorCount = (html.match(/new\s+WebSocket\s*\(/gi) || []).length;

  const websocketEndpointSet = new Set([...wsEndpointsFromMessages, ...staticWsLiterals]);
  const websocketEndpoints = [...websocketEndpointSet].slice(0, 30);
  const websocketEndpointCount = websocketEndpointSet.size;

  const legacyHits = detectLegacyStackSignals({ html, scriptSources }).slice(0, 20);
  const highLegacyHits = legacyHits.filter((hit) => hit.severity === 'high').length;

  const findings = [];
  if (iframeTags.length > 0) {
    findings.push({
      key: 'iframes',
      severity: iframeExternalCount > 0 ? 'high' : 'medium',
      summary: `${iframeTags.length} iframe(s), ${iframeExternalCount} external`,
      evidence: iframeSamples.slice(0, 6)
    });
  }
  if (legacyHits.length > 0) {
    findings.push({
      key: 'legacy_stack',
      severity: highLegacyHits > 0 ? 'high' : 'medium',
      summary: `${legacyHits.length} legacy stack signal(s) detected`,
      evidence: legacyHits.slice(0, 8)
    });
  }
  if (websocketEndpointCount > 0 || wsMessageCount > 0) {
    findings.push({
      key: 'websockets',
      severity: wsMessageCount >= 400 ? 'high' : 'medium',
      summary: `${websocketEndpointCount} endpoint(s), ${wsMessageCount} captured message(s)`,
      evidence: websocketEndpoints.slice(0, 8).map((entry) => ({ endpoint: truncateEvidence(entry, 220) }))
    });
  }
  if (inlineScriptCount >= 20 || inlineEventHandlerCount >= 12) {
    findings.push({
      key: 'inline_behavior',
      severity: inlineScriptCount >= 60 || inlineEventHandlerCount >= 30 ? 'high' : 'medium',
      summary: `${inlineScriptCount} inline script tag(s), ${inlineEventHandlerCount} inline event handler(s)`,
      evidence: []
    });
  }
  if (thirdPartyScriptCount >= 10) {
    findings.push({
      key: 'third_party_scripts',
      severity: thirdPartyScriptCount >= 20 ? 'high' : 'medium',
      summary: `${thirdPartyScriptCount} third-party script source(s)`,
      evidence: scriptSources.slice(0, 8).map((entry) => ({ src: truncateEvidence(entry, 220) }))
    });
  }

  let score = 0;
  score += Math.min(iframeTags.length, 12);
  score += Math.min(iframeExternalCount * 2, 12);
  score += Math.min(legacyHits.length * 3, 15);
  score += Math.min(websocketEndpointCount, 8);
  if (wsMessageCount >= 50) score += 2;
  if (wsMessageCount >= 250) score += 3;
  if (wsMessageCount >= 1000) score += 3;
  if (inlineScriptCount >= 20) score += 2;
  if (inlineScriptCount >= 50) score += 3;
  if (inlineEventHandlerCount >= 12) score += 2;
  if (inlineEventHandlerCount >= 30) score += 3;
  if (thirdPartyScriptCount >= 10) score += 2;
  if (thirdPartyScriptCount >= 20) score += 3;
  score = Math.min(score, 100);

  const severity = buildComplexitySeverity(score);

  return {
    page_id: pageId,
    url: pageUrl,
    title: pageTitle,
    score,
    severity,
    findings,
    metrics: {
      iframe_total: iframeTags.length,
      iframe_external: iframeExternalCount,
      legacy_signal_count: legacyHits.length,
      legacy_signals: legacyHits,
      websocket_endpoint_count: websocketEndpointCount,
      websocket_message_count: wsMessageCount,
      websocket_static_literal_count: staticWsLiterals.length,
      websocket_ctor_count: staticWsCtorCount,
      script_src_count: scriptSources.length,
      third_party_script_count: thirdPartyScriptCount,
      inline_script_count: inlineScriptCount,
      inline_event_handler_count: inlineEventHandlerCount
    },
    analyzed_at: new Date().toISOString(),
    source: html ? 'page_content' : 'partial_content'
  };
}

function buildComplexitiesSummary(pageResults, websocketStats, targetUrl) {
  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0, none: 0 };
  const totals = {
    iframes: 0,
    external_iframes: 0,
    legacy_signals: 0,
    websocket_endpoints: 0,
    websocket_messages: 0,
    inline_scripts: 0,
    inline_event_handlers: 0,
    third_party_scripts: 0
  };
  const findingRollup = new Map();

  for (const page of pageResults) {
    const sev = String(page?.severity || 'none').toLowerCase();
    if (severityCounts[sev] == null) severityCounts.none += 1;
    else severityCounts[sev] += 1;

    const m = page?.metrics || {};
    totals.iframes += Number(m.iframe_total) || 0;
    totals.external_iframes += Number(m.iframe_external) || 0;
    totals.legacy_signals += Number(m.legacy_signal_count) || 0;
    totals.websocket_endpoints += Number(m.websocket_endpoint_count) || 0;
    totals.websocket_messages += Number(m.websocket_message_count) || 0;
    totals.inline_scripts += Number(m.inline_script_count) || 0;
    totals.inline_event_handlers += Number(m.inline_event_handler_count) || 0;
    totals.third_party_scripts += Number(m.third_party_script_count) || 0;

    const findings = Array.isArray(page?.findings) ? page.findings : [];
    for (const finding of findings) {
      const key = String(finding?.key || 'other');
      if (!findingRollup.has(key)) {
        findingRollup.set(key, {
          key,
          pages_affected: 0,
          highest_severity: 'none'
        });
      }
      const bucket = findingRollup.get(key);
      bucket.pages_affected += 1;
      if (severityRank(finding?.severity) > severityRank(bucket.highest_severity)) {
        bucket.highest_severity = finding.severity;
      }
    }
  }

  const pagesWithFindings = pageResults.filter((page) => Array.isArray(page?.findings) && page.findings.length > 0).length;
  const topFindings = [...findingRollup.values()]
    .sort((a, b) => {
      if (b.pages_affected !== a.pages_affected) return b.pages_affected - a.pages_affected;
      return severityRank(b.highest_severity) - severityRank(a.highest_severity);
    })
    .slice(0, 12);

  const pagesSorted = [...pageResults]
    .sort((a, b) => {
      if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
      const bFindings = Array.isArray(b.findings) ? b.findings.length : 0;
      const aFindings = Array.isArray(a.findings) ? a.findings.length : 0;
      if (bFindings !== aFindings) return bFindings - aFindings;
      return String(a.url || '').localeCompare(String(b.url || ''));
    })
    .slice(0, 200);

  return {
    generated_at: new Date().toISOString(),
    target_url: targetUrl,
    pages_analyzed: pageResults.length,
    pages_with_findings: pagesWithFindings,
    severity_counts: severityCounts,
    totals,
    websocket_source: {
      total_messages: Number(websocketStats?.total_messages) || 0,
      sampled_messages: Number(websocketStats?.sampled_messages) || 0,
      unique_endpoints: Number(websocketStats?.unique_endpoints) || 0
    },
    top_findings: topFindings,
    pages: pagesSorted
  };
}

async function persistComplexitiesAnalysis(jobId, pageResults) {
  let saved = 0;
  let failed = 0;

  for (const page of pageResults) {
    const pageId = String(page?.page_id || '').trim();
    if (!pageId) continue;

    try {
      await axios.post(
        `${BACKEND_URL}/api/pages/${pageId}/save-analysis`,
        {
          saveLegs: false,
          saveInteractiveElements: false,
          saveNonInteractiveElements: false,
          saveLinks: false,
          saveCookies: false,
          saveSeoData: false,
          saveContentData: false,
          saveAccessibilityData: false,
          saveComplianceData: false,
          saveComplexitiesData: true,
          complexitiesData: page,
          job_id: jobId
        },
        {
          headers: getAuthHeaders(),
          timeout: 20000
        }
      );
      saved += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[COMPLEXITIES] Failed to persist page ${pageId}: ${error.message}`);
    }
  }

  return { saved, failed };
}

async function collectFallbackComplexityPage(targetUrl) {
  if (!targetUrl) return null;
  try {
    const response = await axios.get(targetUrl, {
      timeout: 20000,
      maxContentLength: 2 * 1024 * 1024,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AionQA-Complexities/1.0)' },
      responseType: 'text',
      validateStatus: (status) => status >= 200 && status < 500
    });
    const body = typeof response.data === 'string' ? response.data : '';
    if (!body) return null;
    const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? String(titleMatch[1] || '').replace(/\s+/g, ' ').trim() : '';
    return {
      url: targetUrl,
      title,
      content: body
    };
  } catch (error) {
    return null;
  }
}

async function executeComplexitiesScanJob(job) {
  const jobId = job.id;
  const context = job.context || {};
  const rawProjectId = job.project_id || context.project_id || job.projectId || null;
  const projectId = rawProjectId && typeof rawProjectId === 'object'
    ? (rawProjectId.$oid || rawProjectId.toString?.() || '')
    : String(rawProjectId || '');
  if (!projectId) {
    throw new Error('Complexities scan job missing project_id');
  }

  const maxPages = Math.min(Math.max(Number(context.max_pages || job.options?.max_pages) || 200, 1), 1000);
  const includeExistingPages = context.include_existing_pages !== false && job.options?.include_existing_pages !== false;

  const targetUrl = normalizeScanTargetUrl(
    context.target_url ||
    job.start_url ||
    job.url ||
    context.base_url ||
    ''
  ).toString();

  await appendJobLog(jobId, 'info', `🧠 Starting complexities scan for ${targetUrl}`, {
    project_id: projectId,
    target_url: targetUrl,
    max_pages: maxPages,
    include_existing_pages: includeExistingPages
  });

  const sourceResponse = await axios.get(
    `${BACKEND_URL}/api/runner/projects/${projectId}/complexities-source`,
    {
      params: { limit: maxPages },
      headers: getAuthHeaders(),
      timeout: 90000
    }
  );

  const source = sourceResponse.data || {};
  const sourcePages = Array.isArray(source.pages) ? source.pages : [];
  const websocketStats = source.websocket || {};
  const wsByPage = new Map();
  const wsByPageRows = Array.isArray(websocketStats.by_page) ? websocketStats.by_page : [];
  for (const row of wsByPageRows) {
    const key = normalizeUrlForComplexityMatching(row?.normalized_page_url || row?.page_url || '');
    if (!key) continue;
    wsByPage.set(key, row);
  }

  await appendJobLog(jobId, 'info', `🧠 Source snapshot loaded (${sourcePages.length} page(s), ${Number(websocketStats.total_messages) || 0} websocket message(s))`, {
    pages: sourcePages.length,
    websocket_messages: Number(websocketStats.total_messages) || 0,
    websocket_sampled: Number(websocketStats.sampled_messages) || 0
  });

  const pageResults = [];
  if (includeExistingPages) {
    for (const page of sourcePages) {
      const pageKey = normalizeUrlForComplexityMatching(page?.url || '');
      const wsBucket = pageKey ? wsByPage.get(pageKey) : null;
      const analyzed = analyzeComplexityForPage(page, wsBucket);
      if (analyzed) pageResults.push(analyzed);
    }
  }

  if (pageResults.length === 0) {
    const fallbackPage = await collectFallbackComplexityPage(targetUrl);
    if (fallbackPage) {
      const fallbackAnalyzed = analyzeComplexityForPage(fallbackPage, null);
      if (fallbackAnalyzed) {
        try {
          const discover = await axios.post(
            `${BACKEND_URL}/api/pages/discover`,
            {
              project_id: projectId,
              job_id: String(jobId),
              url: fallbackPage.url,
              title: fallbackPage.title || 'Scanned page',
              content: fallbackPage.content,
              analyzed: true
            },
            {
              headers: getAuthHeaders(),
              timeout: 30000
            }
          );
          const fallbackPageId = discover?.data?.page?._id ? String(discover.data.page._id) : '';
          fallbackAnalyzed.page_id = fallbackPageId;
        } catch (persistError) {
          console.warn(`[COMPLEXITIES] Failed to upsert fallback page: ${persistError.message}`);
        }
        pageResults.push(fallbackAnalyzed);
      }
    }
  }

  const persistStats = await persistComplexitiesAnalysis(jobId, pageResults);
  const summary = buildComplexitiesSummary(pageResults, websocketStats, targetUrl);

  await appendJobLog(jobId, 'info', `✅ Complexities scan completed (${summary.pages_analyzed} page(s), ${summary.pages_with_findings} with findings)`, {
    pages_analyzed: summary.pages_analyzed,
    pages_with_findings: summary.pages_with_findings,
    severity_counts: summary.severity_counts,
    pages_saved: persistStats.saved,
    pages_failed: persistStats.failed
  });

  return {
    success: true,
    complexities_summary: summary,
    pages_saved: persistStats.saved,
    pages_failed: persistStats.failed
  };
}

/**
 * Execute a K6 load test job: write script to temp file and run `k6 run script.js`.
 * Returns { success, stdout?, stderr?, exitCode?, error? }.
 */
async function executeK6LoadTestJob(job) {
  const script = job.context?.k6_script;
  if (!script || typeof script !== 'string') {
    return { success: false, error: 'No k6_script in job context' };
  }
  const runtimeLimitMsRaw = Number(
    job.context?.k6_timeout_ms ??
    job.options?.k6_timeout_ms ??
    process.env.K6_MAX_RUNTIME_MS ??
    (20 * 60 * 1000)
  );
  const runtimeLimitMs = Number.isFinite(runtimeLimitMsRaw)
    ? Math.max(60 * 1000, Math.min(90 * 60 * 1000, Math.floor(runtimeLimitMsRaw)))
    : 20 * 60 * 1000;
  const scriptPath = join(tmpdir(), `k6-load-test-${job.id}-${Date.now()}.js`);
  try {
    await writeFile(scriptPath, script, 'utf8');
  } catch (writeErr) {
    return { success: false, error: `Failed to write script: ${writeErr.message}` };
  }
  return new Promise((resolve) => {
    const child = spawn('k6', ['run', scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const complete = async (result) => {
      if (settled) return;
      settled = true;
      try {
        await unlink(scriptPath);
      } catch (_) {
        // Ignore temp file cleanup failures.
      }
      resolve(result);
    };
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      void complete({
        success: false,
        stdout: stdout.slice(-8000),
        stderr: stderr.slice(-8000),
        error: `k6 runtime exceeded ${Math.round(runtimeLimitMs / 1000)}s and was terminated`,
        timed_out: true
      });
    }, runtimeLimitMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      const success = code === 0;
      if (!success) {
        console.error(`[K6] Exit code ${code}, signal ${signal}`);
        console.error(`[K6] stderr: ${stderr.slice(-2000)}`);
      }
      void complete({
        success,
        stdout: stdout.slice(-8000),
        stderr: stderr.slice(-8000),
        exitCode: code,
        signal: signal || undefined,
        error: success ? undefined : (stderr || stdout || `k6 exited with code ${code}`)
      });
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      void complete({
        success: false,
        error: err.message || 'Failed to spawn k6 (is k6 installed?)',
        stdout,
        stderr
      });
    });
  });
}

/**
 * Execute a scheduled health check (availability, certificate, sitemap, content_check) on the crawler.
 * Returns result in the shape expected by the backend: { success, schedule_result: { ok, status, ... } }.
 */
async function executeHealthCheckJob(job) {
  const hc = job.health_check || job.context?.health_check || {};
  const kind = hc.kind || 'availability';
  const url = hc.target?.url || job.start_url || job.url || '';
  const options = hc.options || {};
  const timeoutMs = Number(options.request_timeout_ms) || DEFAULT_AVAILABILITY_TIMEOUT_MS;
  const checkedAt = new Date();

  if (!url) {
    return {
      success: false,
      schedule_result: { ok: false, status: 'invalid_target', message: 'No target URL', checked_at: checkedAt }
    };
  }

  try {
    if (kind === 'availability') {
      const start = Date.now();
      const response = await axios.get(url, { timeout: timeoutMs, maxRedirects: 5, validateStatus: () => true, responseType: 'text' });
      const ok = response.status >= 200 && response.status < 400;
      return {
        success: true,
        schedule_result: {
          ok,
          status: ok ? 'ok' : 'bad_status',
          http_status: response.status,
          response_time_ms: Date.now() - start,
          checked_url: url,
          checked_at: checkedAt
        }
      };
    }

    if (kind === 'certificate') {
      const start = Date.now();
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return {
          success: false,
          schedule_result: { ok: false, status: 'invalid_target', message: 'Invalid URL', checked_at: checkedAt }
        };
      }
      if (parsed.protocol !== 'https:') {
        return {
          success: false,
          schedule_result: { ok: false, status: 'invalid_target', message: 'Certificate check requires HTTPS', checked_url: url, checked_at: checkedAt }
        };
      }
      const result = await new Promise((resolve) => {
        const req = https.request({
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: parsed.pathname || '/',
          method: 'GET',
          timeout: timeoutMs,
          rejectUnauthorized: false
        }, (res) => {
          const responseTimeMs = Date.now() - start;
          const cert = res.socket?.getPeerCertificate?.();
          if (!cert || Object.keys(cert).length === 0) {
            resolve({ ok: false, status: 'no_certificate', message: 'No peer certificate', response_time_ms: responseTimeMs });
            return;
          }
          const now = new Date();
          const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
          const validFrom = cert.valid_from ? new Date(cert.valid_from) : null;
          const isExpired = validTo ? now > validTo : true;
          const notYetValid = validFrom ? now < validFrom : false;
          const ok = !isExpired && !notYetValid;
          resolve({
            ok,
            status: ok ? 'ok' : (isExpired ? 'expired' : 'not_yet_valid'),
            checked_url: url,
            response_time_ms: responseTimeMs,
            valid_from: validFrom ? validFrom.toISOString() : null,
            valid_to: validTo ? validTo.toISOString() : null,
            days_until_expiry: validTo && !isExpired ? Math.floor((validTo - now) / (24 * 60 * 60 * 1000)) : null,
            checked_at: checkedAt
          });
        });
        req.on('error', (err) => {
          resolve({ ok: false, status: 'error', message: String(err.message), response_time_ms: Date.now() - start, checked_at: checkedAt });
        });
        req.on('timeout', () => {
          req.destroy();
          resolve({ ok: false, status: 'timeout', message: 'Connection timeout', response_time_ms: Date.now() - start, checked_at: checkedAt });
        });
        req.end();
      });
      return { success: true, schedule_result: { ...result, checked_at: checkedAt } };
    }

    if (kind === 'sitemap') {
      const sitemapUrl = (options.sitemap_url && String(options.sitemap_url).trim()) || (() => {
        try {
          const base = new URL(url);
          return `${base.origin}/sitemap.xml`;
        } catch {
          return '';
        }
      })();
      if (!sitemapUrl) {
        return {
          success: false,
          schedule_result: { ok: false, status: 'invalid_target', message: 'No sitemap URL', checked_at: checkedAt }
        };
      }
      const start = Date.now();
      const response = await axios.get(sitemapUrl, { timeout: timeoutMs, maxRedirects: 3, validateStatus: () => true, responseType: 'text' });
      const xml = String(response.data || '');
      const locMatches = xml.match(/<loc>([^<]+)<\/loc>/gi) || [];
      const ok = response.status >= 200 && response.status < 400 && locMatches.length > 0;
      return {
        success: true,
        schedule_result: {
          ok,
          status: ok ? 'ok' : (response.status >= 200 && response.status < 400 ? 'empty' : 'bad_status'),
          http_status: response.status,
          response_time_ms: Date.now() - start,
          sitemap_url: sitemapUrl,
          url_count: locMatches.length,
          checked_at: checkedAt
        }
      };
    }

    if (kind === 'content_check') {
      const mustInclude = String(options.content_must_include || '').trim();
      const start = Date.now();
      const response = await axios.get(url, { timeout: timeoutMs, maxRedirects: 5, validateStatus: () => true, responseType: 'text' });
      const body = String(response.data || '');
      const ok = response.status >= 200 && response.status < 400 && (!mustInclude || body.includes(mustInclude));
      return {
        success: true,
        schedule_result: {
          ok,
          status: ok ? 'ok' : (response.status >= 200 && response.status < 400 ? 'missing_content' : 'bad_status'),
          http_status: response.status,
          response_time_ms: Date.now() - start,
          checked_url: url,
          must_include: mustInclude || null,
          checked_at: checkedAt
        }
      };
    }

    return {
      success: false,
      schedule_result: { ok: false, status: 'unsupported', message: `Unsupported check kind: ${kind}`, checked_at: checkedAt }
    };
  } catch (err) {
    return {
      success: false,
      schedule_result: {
        ok: false,
        status: 'error',
        message: String(err.message || err),
        checked_url: url,
        checked_at: checkedAt
      }
    };
  }
}

/**
 * Execute a security scan job (OWASP ZAP baseline).
 * Runs ZAP against job URL, uploads report, returns result with report_url and summary.
 */
async function executeSecurityJob(job) {
  const targetUrl = job.url || job.start_url || job.context?.start_url || job.context?.url || '';
  if (!targetUrl || !targetUrl.startsWith('http')) {
    return {
      success: false,
      error: 'No valid target URL for security scan',
      security_report: null
    };
  }

  console.log(`🔒 Running ZAP baseline scan for ${targetUrl}`);
  const reportPath = `/tmp/zap-report-${job.id}-${Date.now()}.json`;

  const zapResult = await runZapBaseline(targetUrl, reportPath);
  if (!zapResult.success) {
    return {
      success: false,
      error: zapResult.error || 'ZAP scan failed',
      security_report: null
    };
  }

  let reportUrl = null;
  try {
    const reportContent = await readFile(reportPath, 'utf8');
    const fileName = `zap-security-report-${job.id}.json`;
    reportUrl = await uploadFileForDownload(job.id, reportContent, fileName, 'application/json');
  } catch (err) {
    console.error(`❌ Failed to upload ZAP report: ${err.message}`);
  }

  return {
    success: true,
    security_report: {
      report_url: reportUrl,
      target_url: targetUrl,
      summary: zapResult.summary || { high: 0, medium: 0, low: 0, informational: 0, total: 0 },
      duration_ms: zapResult.duration_ms
    }
  };
}

/**
 * Report job completion to backend (retries 10s, 30s, 3min when backend not responding)
 */
async function reportJobComplete(jobId, result) {
  try {
    await withBackendRetry(() => axios.post(`${BACKEND_URL}/api/runner/jobs/${jobId}/complete`, {
      result,
      runner_id: RUNNER_ID,
      timestamp: new Date().toISOString()
    }, {
      headers: getAuthHeaders(),
      timeout: 120000
    }), `jobs/${jobId}/complete`);
  } catch (error) {
    console.error(`❌ Error reporting job completion after retries:`, error?.message);
  }
}

/**
 * Report job failure to backend (retries 10s, 30s, 3min when backend not responding)
 */
async function reportJobFailed(jobId, errorMessage, errorStack) {
  try {
    await withBackendRetry(() => axios.post(`${BACKEND_URL}/api/runner/jobs/${jobId}/fail`, {
      error: errorMessage,
      stack: errorStack,
      runner_id: RUNNER_ID,
      timestamp: new Date().toISOString()
    }, {
      headers: getAuthHeaders(),
      timeout: 60000
    }), `jobs/${jobId}/fail`);
  } catch (error) {
    console.error(`❌ Error reporting job failure after retries:`, error?.message);
  }
}

/**
 * Main polling loop
 */
async function runLoop() {
  console.log(`🔄 Starting polling loop...`);

  while (true) {
    try {
      // Skip polling if already processing a job
      if (isProcessing) {
        await sleep(POLL_INTERVAL);
        continue;
      }

      // Poll for next job
      const job = await pollForJob();

      if (job) {
        console.log(`📥 Received ${job.jobType} job ${job.id}`);
        isProcessing = true;
        
        // Execute job (don't await - let it run async)
        executeJob(job).finally(() => {
          isProcessing = false;
        });
      } else {
        // No job available, wait before next poll
        await sleep(POLL_INTERVAL);
      }

    } catch (error) {
      console.error(`❌ Error in main loop:`, error.message);
      await sleep(POLL_INTERVAL);
    }
  }
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Graceful shutdown
 */
function shutdown() {
  console.log(`\n⏹️  Shutting down gracefully...`);
  if (currentJobId) {
    console.log(`⚠️  Job ${currentJobId} still running, waiting for completion...`);
  }
  healthServer.close(() => {
    console.log(`✅ Health check server closed`);
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/**
 * Execute a single job and exit (for ECS task-per-job mode)
 * Fetches job data from backend API to avoid ECS container overrides length limit
 */
async function executeSingleJob() {
  console.log(`🎯 Running in single-job mode`);
  
  if (!JOB_ID) {
    console.error(`❌ JOB_ID is required in single-job mode`);
    process.exit(1);
  }

  try {
    await appendJobLog(JOB_ID, 'info', `Single-job mode starting for job ${JOB_ID}`, { component: 'RUNNER' });
  } catch (earlyLogErr) {
    console.warn('Could not send early log to backend:', earlyLogErr.message);
  }

  try {
    // Fetch job data from backend API instead of environment variable
    // This avoids ECS container overrides 8192 character limit
    console.log(`📥 Fetching job data from backend API for job ${JOB_ID}`);
    const response = await axios.get(`${BACKEND_URL}/api/jobs/${JOB_ID}`, {
      headers: getAuthHeaders(),
      timeout: 10000
    });
    
    if (!response.data) {
      console.error(`❌ Job ${JOB_ID} not found in backend`);
      process.exit(1);
    }
    
    const jobData = response.data;
    
    // CRITICAL: Get job type from database if available (passed via environment)
    const dbJobType = process.env.JOB_TYPE || null;
    
    const job = {
      id: JOB_ID,
      ...jobData,
      // CRITICAL: Check jobType, type, database type, and environment variable
      jobType: jobData.jobType || dbJobType || (jobData.type === 'login' ? 'login' : 'crawl') || 'crawl'
    };
    
    console.log(`[DEBUG] Fetched job from API:`, {
      id: job.id,
      jobType: job.jobType,
      jobDataJobType: jobData.jobType,
      dbJobType: dbJobType,
      hasUsername: !!job.username,
      hasPassword: !!job.password,
      hasContextCredentials: !!job.context?.credentials,
      contextCredentialsUsername: job.context?.credentials?.username
    });
    
    console.log(`📥 Executing job ${JOB_ID} (type: ${job.jobType})`);
    
    // Execute the job
    const success = await executeJob(job);
    
    if (success) {
      console.log(`✅ Job ${JOB_ID} completed successfully`);
      process.exit(0);
    } else {
      // executeJob() already reports failure state back to backend.
      // Exiting with non-zero here can overwrite the job outcome as a generic
      // container failure ("Container exited with code 1"), hiding root cause.
      console.error(`❌ Job ${JOB_ID} failed (already reported to backend)`);
      process.exit(0);
    }
  } catch (error) {
    console.error(`❌ Fatal error executing job:`, error.message);
    
    // Detailed error logging
    if (error.response) {
      console.error(`   HTTP Status: ${error.response.status}`);
      console.error(`   Response: ${JSON.stringify(error.response.data)}`);
      
      if (error.response.status === 404) {
        console.error(`   ❌ Job ${JOB_ID} not found in backend`);
        console.error(`   This could mean:`);
        console.error(`   - Job was not created in runner_jobs collection`);
        console.error(`   - Job ID is incorrect`);
        console.error(`   - Backend API endpoint /api/jobs/:id is not working correctly`);
      } else if (error.response.status === 401) {
        console.error(`   ❌ Authentication failed`);
        console.error(`   RUNNER_TOKEN: ${RUNNER_TOKEN ? 'Set (length: ' + RUNNER_TOKEN.length + ')' : 'NOT SET'}`);
        console.error(`   BACKEND_URL: ${BACKEND_URL}`);
        console.error(`   Fix: Ensure RUNNER_TOKEN is set correctly in environment`);
      } else if (error.response.status === 500) {
        console.error(`   ❌ Backend server error`);
        console.error(`   The backend encountered an error while fetching job data`);
      } else if (error.response.status === 502 || error.response.status === 503) {
        console.error(`   ❌ Backend gateway error (${error.response.status})`);
        console.error(`   The backend gateway is unavailable or timing out`);
        console.error(`   This could mean:`);
        console.error(`   - Backend service is down or restarting`);
        console.error(`   - Gateway timeout (backend taking too long to respond)`);
        console.error(`   - Load balancer issue`);
        console.error(`   Fix: Check backend service status and logs`);
      }
    } else if (error.request) {
      console.error(`   ❌ Network error - could not reach backend`);
      console.error(`   BACKEND_URL: ${BACKEND_URL}`);
      console.error(`   Error: ${error.message}`);
      console.error(`   Fix: Check network connectivity and BACKEND_URL configuration`);
    } else {
      console.error(`   ❌ Error: ${error.message}`);
      console.error(`   Stack: ${error.stack}`);
    }
    
    // Try to report the error to backend before exiting
    try {
      await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
        jobId: JOB_ID,
        level: 'error',
        message: `❌ Failed to fetch job data from API: ${error.message}`,
        component: 'RUNNER',
        metadata: {
          error_type: error.response ? 'http_error' : 'network_error',
          status_code: error.response?.status,
          backend_url: BACKEND_URL,
          has_runner_token: !!RUNNER_TOKEN
        }
      }, {
        headers: getAuthHeaders(),
        timeout: 5000
      });
    } catch (logError) {
      // Silent fail - backend might not be reachable
      console.warn(`   ⚠️  Could not log error to backend: ${logError.message}`);
    }
    
    process.exit(1);
  }
}

// Start the runner
if (TASK_MODE === 'single-job') {
  console.log(`🚀 Starting in single-job mode`);
  executeSingleJob().catch(error => {
    console.error(`❌ Fatal error:`, error);
    process.exit(1);
  });
} else {
  console.log(`🚀 Starting in polling mode`);
  runLoop().catch(error => {
    console.error(`❌ Fatal error:`, error);
    process.exit(1);
  });
}

