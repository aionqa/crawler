/**
 * Unified Crawler Runner
 * Polls backend for crawl jobs and executes them
 * Works similar to GitHub Actions runners
 */

import { startCrawl } from './unified-operations.js';
import axios from 'axios';
import { randomUUID } from 'crypto';

const BACKEND_URL = process.env.BACKEND_URL || 'http://back:4000';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '3000'); // 3 seconds default
const RUNNER_ID = process.env.RUNNER_ID || `crawler-runner-${randomUUID().substring(0, 8)}`;
const RUNNER_TYPE = 'crawl';
const STREAM_INTERVAL = 2000; // Stream browser frame every 2 seconds

console.log(`🚀 [CRAWLER-RUNNER] Starting runner ${RUNNER_ID}`);
console.log(`🔗 [CRAWLER-RUNNER] Backend URL: ${BACKEND_URL}`);
console.log(`⏱️  [CRAWLER-RUNNER] Poll interval: ${POLL_INTERVAL}ms`);
console.log(`📹 [CRAWLER-RUNNER] Stream interval: ${STREAM_INTERVAL}ms`);

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
 * Poll backend for next available job
 */
async function pollForJob() {
  try {
    const response = await axios.get(`${BACKEND_URL}/api/runner/jobs/next`, {
      params: { type: RUNNER_TYPE, runnerId: RUNNER_ID },
      timeout: 5000
    });

    if (response.data && response.data.job) {
      return response.data.job;
    }
    return null;
  } catch (error) {
    if (error.response?.status === 404) {
      // No jobs available - this is normal
      return null;
    }
    console.error(`❌ [CRAWLER-RUNNER] Error polling for jobs:`, error.message);
    return null;
  }
}

/**
 * Stream browser frame to backend
 */
async function streamBrowserFrame(page, jobId) {
  try {
    if (!page || page.isClosed()) return;
    
    const screenshot = await page.screenshot({ 
      type: 'jpeg', 
      quality: 60, // Lower quality for streaming
      fullPage: false // Just viewport for performance
    });
    
    const frame = screenshot.toString('base64');
    
    await axios.post(`${BACKEND_URL}/api/runners/${RUNNER_ID}/stream-frame`, {
      jobId,
      frame,
      timestamp: new Date().toISOString()
    }, {
      timeout: 3000
    });
  } catch (error) {
    // Silently fail streaming errors - don't interrupt job execution
    if (error.code !== 'ECONNREFUSED') {
      console.error(`⚠️  [CRAWLER-RUNNER] Streaming error:`, error.message);
    }
  }
}

/**
 * Execute a crawl job
 */
async function executeJob(job) {
  currentJobId = job.id;
  let streamInterval = null;
  
  console.log(`\n🎯 [CRAWLER-RUNNER] Executing job ${job.id}`);
  console.log(`📍 [CRAWLER-RUNNER] URL: ${job.url}`);

  try {
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
        // Start streaming when page is ready
        currentPage = page;
        if (!streamInterval) {
          console.log(`📹 [CRAWLER-RUNNER] Starting browser stream for job ${job.id}`);
          streamInterval = setInterval(() => {
            if (currentPage && !currentPage.isClosed()) {
              streamBrowserFrame(currentPage, job.id);
            }
          }, STREAM_INTERVAL);
        }
      }
    };

    // Execute crawl using existing function
    const result = await startCrawl(url, cookies, executionContext, openaiApiKey);

    // Report success to backend
    await reportJobComplete(job.id, result);
    
    console.log(`✅ [CRAWLER-RUNNER] Job ${job.id} completed successfully`);
    return true;

  } catch (error) {
    console.error(`❌ [CRAWLER-RUNNER] Job ${job.id} failed:`, error.message);
    
    // Report failure to backend
    await reportJobFailed(job.id, error.message, error.stack);
    
    return false;
  } finally {
    // Stop streaming
    if (streamInterval) {
      clearInterval(streamInterval);
      streamInterval = null;
      console.log(`🛑 [CRAWLER-RUNNER] Stopped browser stream for job ${job.id}`);
    }
    currentJobId = null;
    currentPage = null;
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
    console.error(`❌ [CRAWLER-RUNNER] Error reporting job completion:`, error.message);
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
    console.error(`❌ [CRAWLER-RUNNER] Error reporting job failure:`, error.message);
  }
}

/**
 * Main polling loop
 */
async function runLoop() {
  console.log(`🔄 [CRAWLER-RUNNER] Starting polling loop...`);

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
        console.log(`📥 [CRAWLER-RUNNER] Received job ${job.id}`);
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
      console.error(`❌ [CRAWLER-RUNNER] Error in main loop:`, error.message);
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
  console.log(`\n⏹️  [CRAWLER-RUNNER] Received SIGINT, shutting down gracefully...`);
  if (currentJobId) {
    console.log(`⚠️  [CRAWLER-RUNNER] Job ${currentJobId} still running, waiting for completion...`);
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log(`\n⏹️  [CRAWLER-RUNNER] Received SIGTERM, shutting down gracefully...`);
  if (currentJobId) {
    console.log(`⚠️  [CRAWLER-RUNNER] Job ${currentJobId} still running, waiting for completion...`);
  }
  process.exit(0);
});

// Start the runner
runLoop().catch(error => {
  console.error(`❌ [CRAWLER-RUNNER] Fatal error:`, error);
  process.exit(1);
});

