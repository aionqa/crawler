/**
 * Unified Runner
 * Polls backend for both login and crawl jobs and executes them
 * Works similar to GitHub Actions runners
 */

import { startCrawl } from './unified-operations.js';
import { performLogin } from './login-operations.js';
import axios from 'axios';
import { randomUUID } from 'crypto';
import VideoStreamManager from './video-stream-manager.js';
import VideoRecorder from './video-recorder.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://back:4000';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '3000'); // 3 seconds default
const RUNNER_ID = process.env.RUNNER_ID || `unified-runner-${randomUUID().substring(0, 8)}`;
const STREAM_INTERVAL = 2000; // Stream browser frame every 2 seconds

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
  setCurrentPage: (page) => { currentPage = page; }
};

/**
 * Poll backend for next available job (login or crawl)
 */
async function pollForJob() {
  // Try to get a crawl job first
  try {
    const response = await axios.get(`${BACKEND_URL}/api/runner/jobs/next`, {
      params: { type: 'crawl', runnerId: RUNNER_ID },
      timeout: 5000
    });

    if (response.data && response.data.job) {
      return { ...response.data.job, jobType: 'crawl' };
    }
  } catch (error) {
    // 404 means no crawl jobs available, continue to check login jobs
    if (error.response?.status !== 404) {
      console.error(`❌ [UNIFIED-RUNNER] Error polling for crawl jobs:`, error.message);
    }
  }

  // If no crawl job, try to get a login job
  try {
    const response = await axios.get(`${BACKEND_URL}/api/runner/jobs/next`, {
      params: { type: 'login', runnerId: RUNNER_ID },
      timeout: 5000
    });

    if (response.data && response.data.job) {
      return { ...response.data.job, jobType: 'login' };
    }
  } catch (error) {
    // 404 means no login jobs available
    if (error.response?.status !== 404) {
      console.error(`❌ [UNIFIED-RUNNER] Error polling for login jobs:`, error.message);
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
        runnerId: RUNNER_ID,
        reason: `Job status is ${initialStatus}, expected 'pending' or 'running'`
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
    context: job.context || {}
  };

  console.log(`[DEBUG] Extracted credentials: url=${url}, username=${username}, password=${password ? '***' : 'undefined'}`);

  if (!url || !username || !password) {
    throw new Error('Missing required fields: url, username, password');
  }

  const openaiApiKey = jobContext.openai_api_key || process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    throw new Error('OpenAI API key not provided');
  }

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
    // Use workflow-based login (NEW - using WorkflowAnalyzer approach)
    const { performLoginWithWorkflow } = await import('./login-operations.js');
    
    const result = await performLoginWithWorkflow(
      page, 
      job.id, 
      url, 
      username, 
      password,
      openaiApiKey,
      jobContext.workflow_template_id // Pass workflow template ID
    );

    // Extract auth tokens if successful
    if (result.success) {
      const cookies = await context.cookies();
      const localStorage = await page.evaluate(() => {
        const items = {};
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          items[key] = window.localStorage.getItem(key);
        }
        return items;
      });
      const sessionStorage = await page.evaluate(() => {
        const items = {};
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const key = window.sessionStorage.key(i);
          items[key] = window.sessionStorage.getItem(key);
        }
        return items;
      });

      result.authTokens = {
        cookies,
        localStorage,
        sessionStorage
      };
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
  // Extract job parameters
  const { url, cookies = [], context = {} } = job;
  const openaiApiKey = context.openai_api_key || process.env.OPENAI_API_KEY;

  if (!openaiApiKey) {
    throw new Error('OpenAI API key not provided');
  }

  // Set job_id in context for logging and pass stream callback
  const executionContext = {
    ...context,
    job_id: job.id,
    useRemoteBrowser: false, // Use local browser (embedded)
    runnerId: RUNNER_ID,
    onPageReady: (page) => {
      // Start real-time video streaming when page is ready
      currentPage = page;
      startVideoStream(page, job.id);
    },
    onContextReady: (context, page) => {
      // Start video recording when context is ready
      videoRecorder.startRecording(job.id, context, page);
      console.log(`[UNIFIED-RUNNER] Video recording and streaming started for crawl job ${job.id}`);
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
    console.log(`[UNIFIED-RUNNER] Finalizing video recording for crawl job ${job.id}...`);
    const videoInfo = await videoRecorder.stopRecording(job.id);
    if (videoInfo) {
      console.log(`✅ [UNIFIED-RUNNER] Video uploaded: ${videoInfo.videoKey} (${videoInfo.sizeMB} MB, ${videoInfo.duration}s)`);
    }
  }
}

/**
 * Report job completion to backend
 */
async function reportJobComplete(jobId, result) {
  try {
    await axios.post(`${BACKEND_URL}/api/runner/jobs/${jobId}/complete`, {
      runnerId: RUNNER_ID,
      result,
      timestamp: new Date().toISOString()
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
      runnerId: RUNNER_ID,
      error: errorMessage,
      stack: errorStack,
      timestamp: new Date().toISOString()
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
process.on('SIGINT', () => {
  console.log(`\n⏹️  [UNIFIED-RUNNER] Received SIGINT, shutting down gracefully...`);
  if (currentJobId) {
    console.log(`⚠️  [UNIFIED-RUNNER] Job ${currentJobId} still running, waiting for completion...`);
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log(`\n⏹️  [UNIFIED-RUNNER] Received SIGTERM, shutting down gracefully...`);
  if (currentJobId) {
    console.log(`⚠️  [UNIFIED-RUNNER] Job ${currentJobId} still running, waiting for completion...`);
  }
  process.exit(0);
});

// Start the runner
runLoop().catch(error => {
  console.error(`❌ [UNIFIED-RUNNER] Fatal error:`, error);
  process.exit(1);
});

