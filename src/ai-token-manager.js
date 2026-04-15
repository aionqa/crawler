/**
 * AI Service Token Manager
 * Manages 24-hour AI service tokens issued by backend
 */

import { createBackendAxiosWithRetries } from './utils/backend-http-retry.js';
import { getRunnerBackendUrl } from './utils/runner-service-urls.js';

const axios = createBackendAxiosWithRetries({ maxRetries: 10, capDelayMs: 25000 });

const BACKEND_URL = getRunnerBackendUrl();
const RUNNER_TOKEN = process.env.RUNNER_TOKEN;

// Token cache: job_id -> { token, expires_at, project_id }
const tokenCache = new Map();

/**
 * Get AI service token for a job
 * Requests from backend if not cached or expired
 */
export async function getAIServiceToken(projectId, jobId) {
  return getAIServiceTokenInternal(projectId, jobId, false);
}

/**
 * Clear cached token for a job (forces re-issue on next call).
 */
export function invalidateAIServiceToken(jobId) {
  if (!jobId) return;
  tokenCache.delete(jobId);
}

/**
 * Get AI service token for a job.
 * @param {string} projectId
 * @param {string} jobId
 * @param {boolean} forceRefresh - when true, bypasses cache and requests a new token
 */
export async function getAIServiceTokenInternal(projectId, jobId, forceRefresh = false) {
  // Check cache first
  const cached = forceRefresh ? null : tokenCache.get(jobId);
  if (cached) {
    const expiresAt = new Date(cached.expires_at);
    // If token expires in more than 1 hour, use cached token
    if (expiresAt > new Date(Date.now() + 60 * 60 * 1000)) {
      return cached.token;
    }
    // Token expires soon, remove from cache
    tokenCache.delete(jobId);
  }
  
  // Request new token from backend
  try {
    if (!RUNNER_TOKEN) {
      throw new Error('RUNNER_TOKEN is required to request AI service token');
    }
    
    console.log(`[AI-TOKEN] Requesting AI service token for project ${projectId}, job ${jobId}...`);
    const response = await axios.post(
      `${BACKEND_URL}/api/ai/issue-token`,
      {
        project_id: projectId, // Backend expects snake_case
        job_id: jobId // Backend expects snake_case
      },
      {
        headers: {
          'Authorization': `Bearer ${RUNNER_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    const { token, expires_at, project_id } = response.data;
    
    // Cache token
    tokenCache.set(jobId, {
      token,
      expires_at,
      project_id
    });
    
    console.log(`[AI-TOKEN] Issued new token for job ${jobId}, expires at ${expires_at}`);
    
    return token;
  } catch (error) {
    console.error(`[AI-TOKEN] Failed to get token from backend:`, error.message);
    if (error.response) {
      console.error(`  Status: ${error.response.status}`);
      console.error(`  Response:`, error.response.data);
    }
    throw error;
  }
}

/**
 * Clear expired tokens from cache
 */
export function clearExpiredTokens() {
  const now = Date.now();
  for (const [jobId, data] of tokenCache.entries()) {
    const expiresAt = new Date(data.expires_at);
    if (expiresAt <= now) {
      tokenCache.delete(jobId);
    }
  }
}

// Clean up cache every 5 minutes
setInterval(clearExpiredTokens, 5 * 60 * 1000);
