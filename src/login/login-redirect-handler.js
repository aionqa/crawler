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
 * Uses AI analysis to detect login pages dynamically
 * Falls back to configuration-based detection if login_url is provided
 */
export async function detectLoginPage(page, jobId, currentUrl, openaiClient, loginUrl = null) {
  try {
    const pageUrl = page.url();
    
    // Strategy 1: Check if login_url is explicitly configured
    if (loginUrl) {
      try {
        const loginUrlObj = new URL(loginUrl);
        const currentUrlObj = new URL(pageUrl);
        
        // Check if current URL matches configured login URL (same origin + pathname)
        if (loginUrlObj.origin === currentUrlObj.origin && 
            currentUrlObj.pathname === loginUrlObj.pathname) {
          return { isLoginPage: true, confidence: 'high', reason: 'URL matches configured login URL' };
        }
      } catch (urlError) {
        // Invalid URL format, skip
        console.warn(`[LOGIN-REDIRECT] Invalid login URL format: ${loginUrl}`);
      }
    }
    
    // Strategy 2: Use AI to detect login page by analyzing page content
    if (openaiClient) {
      try {
        // Get page content for analysis
        const pageTitle = await page.title().catch(() => '');
        const visibleText = await page.evaluate(() => {
          return document.body?.innerText?.substring(0, 1000) || '';
        }).catch(() => '');
        
        // Check for common login indicators in URL and content
        const urlLower = pageUrl.toLowerCase();
        const titleLower = pageTitle.toLowerCase();
        const textLower = visibleText.toLowerCase();
        
        const loginIndicators = [
          urlLower.includes('/login'),
          urlLower.includes('/signin'),
          urlLower.includes('/auth'),
          titleLower.includes('login'),
          titleLower.includes('sign in'),
          textLower.includes('username') && textLower.includes('password'),
          textLower.includes('email') && textLower.includes('password') && (textLower.includes('sign in') || textLower.includes('log in'))
        ];
        
        const loginIndicatorCount = loginIndicators.filter(Boolean).length;
        
        if (loginIndicatorCount >= 2) {
          return { 
            isLoginPage: true, 
            confidence: loginIndicatorCount >= 3 ? 'high' : 'medium', 
            reason: `Login indicators detected: ${loginIndicators.filter(Boolean).length} matches (URL, title, or content)` 
          };
        }
      } catch (aiError) {
        console.warn(`[LOGIN-REDIRECT] Error in AI-based login detection: ${aiError.message}`);
      }
    }
    
    // No login page detected
    return { isLoginPage: false, confidence: 'low', reason: 'No login indicators found' };
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
  context,
  openaiClient,
  handleLoginRedirect = 'auto_retry'
) {
  const backendUrl = process.env.BACKEND_URL || 'http://back:4000';
  const projectId = context.project_id || context.projectId;
  const loginUrl = context.login_url || null;
  
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
    await sendLog(jobId, 'info', `🔄 Auto-retry enabled - fetching latest login cookies and re-authenticating...`);
    
    // Get most recent login job cookies
    const latestCookies = await getLatestLoginCookies(backendUrl, projectId, context.runner_token);
    
    if (!latestCookies || latestCookies.length === 0) {
      await sendLog(jobId, 'error', `❌ No login cookies found - cannot re-authenticate`);
      throw new Error(`Login page detected but no login cookies available for re-authentication`);
    }
    
    await sendLog(jobId, 'info', `🍪 Found ${latestCookies.length} cookies from most recent login job`);
    
    // Set cookies in browser context
    try {
      await page.context().addCookies(latestCookies);
      await sendLog(jobId, 'info', `✅ Set ${latestCookies.length} cookies in browser context`);
    } catch (cookieError) {
      await sendLog(jobId, 'warn', `⚠️ Failed to set some cookies: ${cookieError.message}`);
    }
    
    // Navigate to root path to restart crawl
    const rootUrl = context.start_url || new URL(currentUrl).origin;
    await sendLog(jobId, 'info', `🔄 Navigating to root path: ${rootUrl}`);
    
    try {
      await page.goto(rootUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
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

