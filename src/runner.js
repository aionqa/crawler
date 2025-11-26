/**
 * Unified Runner
 * Polls backend for both login and crawl jobs and executes them
 * Works similar to GitHub Actions runners
 */

import { startCrawl } from './unified-operations.js';
import { performLogin } from './login-operations.js';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { hostname } from 'os';
import express from 'express';
import VideoStreamManager from './video-stream-manager.js';
import VideoRecorder from './video-recorder.js';
// Minimal HTTP server for ECS health checks only (not for workflow endpoints - rule 51-runner-architecture.mdc)

const BACKEND_URL = process.env.BACKEND_URL || 'http://back:4000';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '3000'); // 3 seconds default
const RUNNER_TOKEN = process.env.RUNNER_TOKEN; // GitHub Actions-style runner token
const MAX_SITEMAP_SCAN_DEPTH = 5;
const MAX_SITEMAP_SCAN_CHILD_SITEMAPS = 25;
const MAX_SITEMAP_SCAN_ENTRIES = 5000;
const DEFAULT_AVAILABILITY_TIMEOUT_MS = 10000;
// Generate unique runner ID if not provided (includes hostname and UUID for uniqueness)
const RUNNER_ID = process.env.RUNNER_ID || `unified-runner-${hostname()}-${randomUUID().substring(0, 8)}`;
const STREAM_INTERVAL = 2000; // Stream browser frame every 2 seconds
// WORKFLOW_API_PORT removed - runners do not expose HTTP endpoints (rule 51-runner-architecture.mdc)

// Validate runner token is configured
if (!RUNNER_TOKEN) {
  console.error('❌ [UNIFIED-RUNNER] RUNNER_TOKEN environment variable is required');
  console.error('    Generate a token in the UI: Settings > Runners > Generate Token');
  process.exit(1);
}

console.log(`🤖 [UNIFIED-RUNNER] Runner ID: ${RUNNER_ID}`);

// Initialize video stream manager for real-time streaming
const videoStreamManager = new VideoStreamManager(BACKEND_URL, RUNNER_ID);

// Initialize video recorder for full recording
const videoRecorder = new VideoRecorder(BACKEND_URL, RUNNER_ID);

console.log(`🚀 [UNIFIED-RUNNER] Starting runner ${RUNNER_ID}`);
console.log(`🔗 [UNIFIED-RUNNER] Backend URL: ${BACKEND_URL}`);
console.log(`⏱️  [UNIFIED-RUNNER] Poll interval: ${POLL_INTERVAL}ms`);
console.log(`📹 [UNIFIED-RUNNER] Stream interval: ${STREAM_INTERVAL}ms`);

let isProcessing = false;
let currentJobId = null;
let currentPage = null; // Track current page for streaming

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
  console.log(`❤️  [UNIFIED-RUNNER] Health check server listening on port ${HEALTH_CHECK_PORT}`);
});
console.log(`✅ [UNIFIED-RUNNER] Health check endpoint available at http://localhost:${HEALTH_CHECK_PORT}/health`);

/**
 * Get axios headers with authentication
 */
function getAuthHeaders() {
  return {
    'Authorization': `Bearer ${RUNNER_TOKEN}`
  };
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
    console.error(`[UNIFIED-RUNNER] Failed to append log for job ${jobId}:`, error.message);
  }
}

/**
 * Poll backend for next available job (login or crawl)
 */
async function pollForJob() {
  // Try to get a crawl job first
  try {
    const response = await axios.get(`${BACKEND_URL}/api/runner/jobs/next`, {
      params: { type: 'crawl', runner_id: RUNNER_ID },
      headers: getAuthHeaders(),
      timeout: 5000
    });

    if (response.data && response.data.job) {
      return { ...response.data.job, jobType: 'crawl' };
    }
  } catch (error) {
    // 404 means no crawl jobs available, continue to check login jobs
    if (error.response?.status === 404) {
      // Normal - no jobs available
    } else if (error.response?.status === 401) {
      console.error(`❌ [UNIFIED-RUNNER] Authentication failed when polling for crawl jobs!`);
      console.error(`   Status: 401 Unauthorized`);
      console.error(`   Error: ${error.response?.data?.error || error.message}`);
      console.error(`   Runner ID: ${RUNNER_ID}`);
      console.error(`   Token configured: ${RUNNER_TOKEN ? 'Yes (length: ' + RUNNER_TOKEN.length + ')' : 'NO - THIS IS THE PROBLEM!'}`);
      console.error(`   Fix: Set RUNNER_TOKEN environment variable to a valid token from Settings > Runners`);
    } else {
      console.error(`❌ [UNIFIED-RUNNER] Error polling for crawl jobs:`, error.message);
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        console.error(`   Response:`, error.response.data);
      }
    }
  }

  // If no crawl job, try to get a login job
  try {
    const response = await axios.get(`${BACKEND_URL}/api/runner/jobs/next`, {
      params: { type: 'login', runner_id: RUNNER_ID },
      headers: getAuthHeaders(),
      timeout: 5000
    });

    if (response.data && response.data.job) {
      return { ...response.data.job, jobType: 'login' };
    }
  } catch (error) {
    // 404 means no login jobs available
    if (error.response?.status === 404) {
      // Normal - no jobs available
    } else if (error.response?.status === 401) {
      console.error(`❌ [UNIFIED-RUNNER] Authentication failed when polling for login jobs!`);
      console.error(`   Status: 401 Unauthorized`);
      console.error(`   Error: ${error.response?.data?.error || error.message}`);
      console.error(`   Runner ID: ${RUNNER_ID}`);
      console.error(`   Token configured: ${RUNNER_TOKEN ? 'Yes (length: ' + RUNNER_TOKEN.length + ')' : 'NO - THIS IS THE PROBLEM!'}`);
      console.error(`   Fix: Set RUNNER_TOKEN environment variable to a valid token from Settings > Runners`);
    } else {
      console.error(`❌ [UNIFIED-RUNNER] Error polling for login jobs:`, error.message);
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
  console.log(`📹 [UNIFIED-RUNNER] Starting real-time video stream for job ${jobId}`);
  videoStreamManager.startStream(jobId, page, {
    interval: 200 // 5 FPS for smooth streaming
  });
}

/**
 * Stop video streaming for a job
 */
function stopVideoStream(jobId) {
  console.log(`⏹️  [UNIFIED-RUNNER] Stopping video stream for job ${jobId}`);
  videoStreamManager.stopStream(jobId);
}

/**
 * Check job status from backend
 */
async function checkJobStatus(jobId) {
  try {
    const response = await axios.get(`${BACKEND_URL}/jobs/${jobId}`, {
      timeout: 5000
    });
    return response.data?.status || 'unknown';
  } catch (error) {
    console.error(`❌ [UNIFIED-RUNNER] Error checking job status:`, error.message);
    return 'unknown';
  }
}

/**
 * Execute a job (login or crawl)
 */
async function executeJob(job) {
  currentJobId = job.id;
  let streamInterval = null;
  
  console.log(`\n🎯 [UNIFIED-RUNNER] Executing ${job.jobType} job ${job.id}`);
  console.log(`📍 [UNIFIED-RUNNER] URL: ${job.url}`);
  console.log(`[DEBUG] Job object at start:`, JSON.stringify(job, null, 2));

  // Check job status before starting - accept both 'pending' and 'running'
  const initialStatus = await checkJobStatus(job.id);
  if (initialStatus !== 'running' && initialStatus !== 'pending') {
    console.log(`⚠️  [UNIFIED-RUNNER] Job ${job.id} status is ${initialStatus}, skipping execution`);
    // Report to backend to release the assignment
    try {
      await axios.post(`${BACKEND_URL}/api/runner/jobs/${job.id}/skip`, {
        reason: `Job status is ${initialStatus}, expected 'pending' or 'running'`,
        runner_id: RUNNER_ID
      }, {
        headers: getAuthHeaders()
      });
      console.log(`✅ [UNIFIED-RUNNER] Reported skipped job ${job.id} to backend`);
    } catch (error) {
      console.error(`❌ [UNIFIED-RUNNER] Error reporting skipped job:`, error.message);
    }
    return false;
  }

  try {
    // Update job status from 'pending' to 'running' when runner picks it up
    try {
      await fetch(`${BACKEND_URL}/jobs/${job.id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'running' })
      });
      console.log(`🔄 [UNIFIED-RUNNER] Updated job ${job.id} status to 'running'`);
    } catch (statusError) {
      console.warn(`⚠️  [UNIFIED-RUNNER] Failed to update job status: ${statusError.message}`);
    }

    if (job.jobType === 'login') {
      // Execute login job
      console.log(`[DEBUG] About to execute login job, job object keys:`, Object.keys(job));
      console.log(`[DEBUG] job.url=${job.url}, job.username=${job.username}, job.login_data=`, job.login_data);
      const result = await executeLoginJob(job, streamInterval);
      await reportJobComplete(job.id, result);
      console.log(`✅ [UNIFIED-RUNNER] Login job ${job.id} completed successfully`);
      return true;
    } else {
      // Execute crawl job
      const result = await executeCrawlJob(job, streamInterval);
      await reportJobComplete(job.id, result);
      console.log(`✅ [UNIFIED-RUNNER] Crawl job ${job.id} completed successfully`);
      return true;
    }

  } catch (error) {
    console.error(`❌ [UNIFIED-RUNNER] Job ${job.id} failed:`, error.message);
    
    // Report failure to backend
    await reportJobFailed(job.id, error.message, error.stack);
    
    return false;
  } finally {
    // Stop video streaming
    stopVideoStream(job.id);
    
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
  
  // Extract login credentials from job.login_data or fallback to top-level fields
  const loginData = job.login_data || {};
  const { url, username, password, maxAttempts = 2, context: jobContext = {} } = {
    url: loginData.url || job.url,
    username: loginData.username || job.username,
    password: loginData.password || job.password,
    maxAttempts: job.maxAttempts || 2,
    context: {
      ...job.context,
      workflow_template_id: job.context?.workflow_template_id || job.workflow_template_id || job.options?.workflow_template_id
    }
  };

  console.log(`[DEBUG] Extracted credentials: url=${url}, username=${username}, password=${password ? '***' : 'undefined'}`);

  if (!url || !username || !password) {
    throw new Error('Missing required fields: url, username, password');
  }

  const openaiApiKey = jobContext.openai_api_key || process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    throw new Error('OpenAI API key not provided');
  }

  const workflowExecutionContext = {
    ...jobContext,
    workflow_template_id: jobContext.workflow_template_id,
    project_id: job.project_id || jobContext.project_id || job.projectId || null,
    projectId: job.project_id || jobContext.projectId || null,
    credentials: jobContext.credentials || { username, password },
    options: {
      ...(jobContext.options || {}),
      openai_api_key: openaiApiKey
    },
    openai_api_key: openaiApiKey,
    runner_token: RUNNER_TOKEN // Add runner token for API authentication
  };

  // Launch local browser (embedded) - SAME as crawl jobs
  console.log(`🌐 [UNIFIED-RUNNER] Launching local Chromium browser for login`);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    recordVideo: {
      dir: '/tmp/aionqa_videos',
      size: { width: 1920, height: 1080 }
    }
  });

  const page = await context.newPage();

  // Start video recording (full video for playback)
  videoRecorder.startRecording(job.id, context, page);
  
  // Start real-time video streaming (live frames)
  startVideoStream(page, job.id);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Check if DOM is ready after 30s, continue anyway if not
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {
      console.warn(`[UNIFIED-RUNNER] Page DOM not fully loaded after 30s, continuing anyway`);
    });
    await page.waitForTimeout(1000);
    console.log(`[DEBUG] Navigated to login URL: ${page.url()}`);

    const { performLoginWithWorkflow } = await import('./login-operations.js');
    console.log(
      `[DEBUG] About to execute performLoginWithWorkflow with context:`,
      JSON.stringify({
        workflow_template_id: workflowExecutionContext.workflow_template_id,
        project_id: workflowExecutionContext.project_id
      })
    );
    const result = await performLoginWithWorkflow(
      page,
      job.id,
      url,
      username,
      password,
      openaiApiKey,
      workflowExecutionContext
    );

    if (result.success) {
      const { safeGetLocalStorage, safeGetSessionStorage } = await import('./unified-operations.js');

      let cookies = Array.isArray(result.cookies) ? result.cookies : [];
      if ((!cookies || cookies.length === 0) && Array.isArray(result.iterationCookies)) {
        cookies = result.iterationCookies;
      }
      if (!cookies || cookies.length === 0) {
        console.log(`[LOGIN-WORKFLOW] No cookies returned from workflow result, collecting from current page context`);
        cookies = await context.cookies();
      }

      const localStorage = await safeGetLocalStorage(page);
      const sessionStorage = await safeGetSessionStorage(page);

      result.authTokens = {
        cookies,
        localStorage,
        sessionStorage,
        finalUrl: page.url()
      };
    } else {
      console.log(`[LOGIN-WORKFLOW] Workflow execution failed: ${result.error || 'Unknown error'}`);
    }

    return result;
  } finally {
    // Stop video streaming
    stopVideoStream(job.id);
    
    // Stop video recording and upload
    console.log(`[UNIFIED-RUNNER] Finalizing video recording for job ${job.id}...`);
    const videoInfo = await videoRecorder.stopRecording(job.id);
    if (videoInfo) {
      console.log(`✅ [UNIFIED-RUNNER] Video uploaded: ${videoInfo.videoKey} (${videoInfo.sizeMB} MB, ${videoInfo.duration}s)`);
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

  // Extract job parameters
  // CRITICAL: URL can be at job.url or job.start_url (from runner_jobs structure)
  const url = job.url || job.start_url || null;
  const cookies = job.cookies || [];
  const rawContext = job.context || {};
  const jobOptions = job.options || {};
  
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

  const normalizedContext = {
    ...rawContext,
    execute_workflow: executeWorkflowFlag,
    single_action_only: Boolean(singleActionOnlyValue),
    options: {
      ...mergedOptions,
      execute_workflow: executeWorkflowFlag,
      single_action_only: Boolean(singleActionOnlyValue)
    }
  };

  const openaiApiKey = normalizedContext.openai_api_key || process.env.OPENAI_API_KEY;

  if (!openaiApiKey) {
    throw new Error('OpenAI API key not provided');
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
    job_id: job.id,
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
      console.log(`[UNIFIED-RUNNER] Video recording and streaming started for crawl job ${job.id}`);
    },
    beforeBrowserClose: async () => {
      try {
        recordedVideoInfo = recordedVideoInfo || await videoRecorder.stopRecording(job.id);
      } catch (error) {
        console.error(`[UNIFIED-RUNNER] Failed to finalize video before browser close for job ${job.id}:`, error.message);
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
        console.log(`[UNIFIED-RUNNER] Finalizing video recording for crawl job ${job.id}...`);
        recordedVideoInfo = await videoRecorder.stopRecording(job.id);
      }
      if (recordedVideoInfo) {
        console.log(`✅ [UNIFIED-RUNNER] Video uploaded: ${recordedVideoInfo.videoKey} (${recordedVideoInfo.sizeMB} MB, ${recordedVideoInfo.duration}s)`);
      } else {
        console.warn(`[UNIFIED-RUNNER] No video recorded for crawl job ${job.id}`);
      }
    } catch (videoError) {
      console.error(`[UNIFIED-RUNNER] Error finalizing video recording for crawl job ${job.id}:`, videoError.message);
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

/**
 * Report job completion to backend
 */
async function reportJobComplete(jobId, result) {
  try {
    await axios.post(`${BACKEND_URL}/api/runner/jobs/${jobId}/complete`, {
      result,
      runner_id: RUNNER_ID,
      timestamp: new Date().toISOString()
    }, {
      headers: getAuthHeaders()
    });
  } catch (error) {
    console.error(`❌ [UNIFIED-RUNNER] Error reporting job completion:`, error.message);
  }
}

/**
 * Report job failure to backend
 */
async function reportJobFailed(jobId, errorMessage, errorStack) {
  try {
    await axios.post(`${BACKEND_URL}/api/runner/jobs/${jobId}/fail`, {
      error: errorMessage,
      stack: errorStack,
      runner_id: RUNNER_ID,
      timestamp: new Date().toISOString()
    }, {
      headers: getAuthHeaders()
    });
  } catch (error) {
    console.error(`❌ [UNIFIED-RUNNER] Error reporting job failure:`, error.message);
  }
}

/**
 * Main polling loop
 */
async function runLoop() {
  console.log(`🔄 [UNIFIED-RUNNER] Starting polling loop...`);

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
        console.log(`📥 [UNIFIED-RUNNER] Received ${job.jobType} job ${job.id}`);
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
      console.error(`❌ [UNIFIED-RUNNER] Error in main loop:`, error.message);
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
  console.log(`\n⏹️  [UNIFIED-RUNNER] Shutting down gracefully...`);
  if (currentJobId) {
    console.log(`⚠️  [UNIFIED-RUNNER] Job ${currentJobId} still running, waiting for completion...`);
  }
  healthServer.close(() => {
    console.log(`✅ [UNIFIED-RUNNER] Health check server closed`);
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the runner
runLoop().catch(error => {
  console.error(`❌ [UNIFIED-RUNNER] Fatal error:`, error);
  process.exit(1);
});

