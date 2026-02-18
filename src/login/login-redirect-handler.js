/**
 * Login Redirect Handler
 * Detects login page redirections during crawling and handles them
 */

import * as backendLogger from '../backend-logger.js';

/**
 * Send log to backend (wrapper for backendLogger)
 */
async function sendLog(jobId, level, message, data = {}) {
  try {
    const componentName = data.component || 'LOGIN-REDIRECT-HANDLER';
    const metadata = { ...data };
    
    // Determine if this is a page log or job log
    if (data.page_url) {
      await backendLogger.appendPageLog(
        jobId,
        data.page_url,
        level,
        message,
        null,
        componentName,
        metadata
      );
    } else {
      await backendLogger.appendJobLog(
        jobId,
        level,
        message,
        componentName,
        metadata
      );
    }
  } catch (error) {
    console.error(`Failed to send log: ${error.message}`);
  }
}

/**
 * Detect if current page is a login page
 * Configuration-based: Only uses login_url from context if provided
 * No hardcoded patterns - relies on configuration
 */
export async function detectLoginPage(page, jobId, currentUrl, openaiClient, loginUrl = null) {
  try {
    const pageUrl = page.url();
    
    // ONLY check if login_url is explicitly configured (no hardcoded patterns)
    if (loginUrl) {
      try {
        const loginUrlObj = new URL(loginUrl);
        const currentUrlObj = new URL(pageUrl);
        
        // Check if current URL matches configured login URL (same origin + pathname)
        if (loginUrlObj.origin === currentUrlObj.origin && 
            currentUrlObj.pathname === loginUrlObj.pathname) {
          return { isLoginPage: true, confidence: 'high', reason: 'URL matches configured login URL' };
        }

        // Some apps bounce between subdomains (e.g. webapp.* -> auth.*) but keep the same login path.
        // Treat "same pathname as configured login_url" as a login-page hit as well.
        if (currentUrlObj.pathname === loginUrlObj.pathname) {
          return { isLoginPage: true, confidence: 'medium', reason: 'Pathname matches configured login URL (origin differs)' };
        }
      } catch (urlError) {
        // Invalid URL format, skip
        console.warn(`[LOGIN-REDIRECT] Invalid login URL format: ${loginUrl}`);
      }
    }
    
    // No hardcoded detection - return false if no configured login URL matches
    return { isLoginPage: false, confidence: 'low', reason: 'No configured login URL match' };
  } catch (error) {
    console.error(`[LOGIN-REDIRECT] Error detecting login page: ${error.message}`);
    return { isLoginPage: false, confidence: 'low', reason: `Error: ${error.message}` };
  }
}

/**
 * Get most recent login job cookies from backend
 */
export async function getLatestLoginCookies(backendUrl, projectId, runnerToken = null) {
  try {
    const axios = (await import('axios')).default;
    const response = await axios.get(`${backendUrl}/api/projects/${projectId}/latest-cookies`, {
      headers: runnerToken ? { 'Authorization': `Bearer ${runnerToken}` } : {},
      timeout: 10000
    });
    
    return Array.isArray(response.data) ? response.data : [];
  } catch (error) {
    console.error(`[LOGIN-REDIRECT] Failed to get latest cookies: ${error.message}`);
    return [];
  }
}

/**
 * Handle login page redirection during crawling
 * Returns new cookies if re-authentication is needed, or null if should fail
 */
export async function handleLoginRedirect(
  page,
  jobId,
  currentUrl,
  intendedUrl,
  context,
  openaiClient,
  handleLoginRedirect = 'auto_retry'
) {
  const backendUrl = process.env.BACKEND_URL || 'http://back:4000';
  const projectId = context.project_id || context.projectId;
  const loginUrl = context.login_url || null;
  const runnerToken = context.runner_token || null;
  
  // Detect if current page is a login page
  await sendLog(jobId, 'info', `🔍 Checking if page is a login page: ${currentUrl}`);
  const loginDetection = await detectLoginPage(page, jobId, currentUrl, openaiClient, loginUrl);
  
  if (!loginDetection.isLoginPage) {
    return null; // Not a login page, continue normally
  }
  
  await sendLog(jobId, 'warn', `⚠️ Login page detected (${loginDetection.confidence} confidence): ${loginDetection.reason}`);
  
  // Check how to handle the redirect
  if (handleLoginRedirect === 'fail') {
    await sendLog(jobId, 'error', `❌ Login redirect detected - failing crawl as configured`);
    throw new Error(`Login page detected at ${currentUrl} - crawl failed (handle_login_redirect: fail)`);
  }
  
  // Auto-retry: Get latest login job cookies and re-authenticate
  if (handleLoginRedirect === 'auto_retry') {
    await sendLog(jobId, 'info', `🔄 Auto-retry enabled - login page detected, triggering a login job to refresh cookies...`);

    // Ask backend to start a login job (runner-auth protected).
    const axios = (await import('axios')).default;
    const refreshResp = await axios.post(
      `${backendUrl}/api/runner/jobs/${jobId}/refresh-login`,
      { reason: 'login_redirect', intended_url: intendedUrl || null },
      {
        headers: runnerToken ? { 'Authorization': `Bearer ${runnerToken}` } : {},
        timeout: 10000
      }
    );

    const loginJobId = refreshResp?.data?.login_job_id;
    if (!loginJobId) {
      throw new Error('Backend did not return login_job_id for refresh-login');
    }

    await sendLog(jobId, 'info', `⏳ Waiting for login job ${loginJobId} to complete...`);

    // Poll login job status via runner-auth `/api/jobs/:id`
    const deadline = Date.now() + 3 * 60 * 1000; // 3 minutes
    while (Date.now() < deadline) {
      const statusResp = await axios.get(`${backendUrl}/api/jobs/${loginJobId}`, {
        headers: runnerToken ? { 'Authorization': `Bearer ${runnerToken}` } : {},
        timeout: 10000
      });
      const status = statusResp?.data?.status;
      if (status === 'completed') break;
      if (status === 'failed' || status === 'error' || status === 'cancelled') {
        throw new Error(`Login refresh job ${loginJobId} ended with status=${status}`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    // Fetch cookies after the login job completes
    const latestCookies = await getLatestLoginCookies(backendUrl, projectId, runnerToken);
    if (!latestCookies || latestCookies.length === 0) {
      throw new Error('Login refresh completed but no cookies found');
    }
    
    await sendLog(jobId, 'info', `🍪 Found ${latestCookies.length} cookies from most recent login job`);
    
    // Set cookies in browser context
    try {
      await page.context().addCookies(latestCookies);
      await sendLog(jobId, 'info', `✅ Set ${latestCookies.length} cookies in browser context`);
    } catch (cookieError) {
      await sendLog(jobId, 'warn', `⚠️ Failed to set some cookies: ${cookieError.message}`);
    }
    
    // Navigate back to the intended URL (preferred) or fall back to root.
    const fallbackRoot = context.start_url || new URL(currentUrl).origin;
    const returnUrl = intendedUrl || fallbackRoot;
    await sendLog(jobId, 'info', `🔄 Navigating after re-authentication: ${returnUrl}`);
    
    try {
      await page.goto(returnUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2000); // Wait for page to stabilize
      
      const newUrl = page.url();
      await sendLog(jobId, 'info', `✅ Navigated to ${newUrl} with fresh cookies`);
      
      // Check if we're still on a login page
      const recheck = await detectLoginPage(page, jobId, newUrl, openaiClient, loginUrl);
      if (recheck.isLoginPage) {
        await sendLog(jobId, 'error', `❌ Still on login page after re-authentication - cookies may be expired`);
        throw new Error(`Re-authentication failed - still on login page at ${newUrl}`);
      }
      
      // Return the new cookies to update context
      return {
        cookies: latestCookies,
        newUrl: newUrl,
        reauthenticated: true
      };
    } catch (navError) {
      await sendLog(jobId, 'error', `❌ Failed to navigate to root path: ${navError.message}`);
      throw new Error(`Failed to re-authenticate: ${navError.message}`);
    }
  }
  
  return null;
}

