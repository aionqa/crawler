/**
 * Login Redirect Handler
 * Detects login page redirections during crawling and handles them
 */

import * as backendLogger from '../backend-logger.js';
import { executeLoginWithWorkflow } from './login-workflow-engine.js';

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

    // Fallback (best-effort): if login_url is missing from job context, still detect common SSO login pages.
    // This prevents us from silently skipping re-auth on crawls when backend didn't include login_url.
    try {
      const u = new URL(pageUrl);
      const path = (u.pathname || '').toLowerCase();
      const host = (u.hostname || '').toLowerCase();
      if (path === '/login' && (host.startsWith('auth.') || host.includes('.auth.') || host.includes('auth'))) {
        const hasLoginForm = await page.locator('#login-form, form[id*=\"login\"], input#email, input[name=\"email\"], #next-button').first().isVisible().catch(() => false);
        if (hasLoginForm) {
          return { isLoginPage: true, confidence: 'low', reason: 'Fallback login detection (/login on auth host with login form)' };
        }
      }
    } catch (_) {
      // ignore
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
    const axios = (await import('axios')).default;
    await sendLog(jobId, 'info', `🔄 Auto-retry enabled - login page detected, attempting in-session login workflow...`);

    if (!runnerToken) {
      throw new Error('runner_token missing from crawl context; cannot fetch login config');
    }
    if (!projectId) {
      throw new Error('project_id missing from crawl context; cannot fetch login config');
    }

    // Fetch login config (credentials + workflow id) from backend (runner-auth).
    const loginConfigResp = await axios.get(`${backendUrl}/api/runner/projects/${projectId}/login-config`, {
      headers: { 'Authorization': `Bearer ${runnerToken}` },
      timeout: 10000
    });
    const loginConfig = loginConfigResp?.data || {};
    const creds = loginConfig?.credentials;
    const loginWorkflowId =
      loginConfig?.login_workflow_id ||
      context.login_workflow_id ||
      context.login_workflow_template_id ||
      'json-login-default-login-workflow';

    if (!creds?.username || !creds?.password) {
      throw new Error('Backend did not return credentials for login-config');
    }

    // Run login workflow inside the SAME browser session. This is required for SSO flows
    // that depend on local/session storage and redirect state.
    const openaiApiKey = context.openai_api_key || process.env.OPENAI_API_KEY || null;
    const loginContext = {
      ...context,
      project_id: projectId,
      login_url: loginConfig?.login_url || context.login_url || null,
      workflow_template_id: loginWorkflowId,
      runner_token: runnerToken,
      credentials: { username: creds.username, password: creds.password }
    };

    const loginExec = await executeLoginWithWorkflow(
      page,
      jobId,
      currentUrl,
      openaiApiKey,
      loginContext
    );

    const latestCookies = Array.isArray(loginExec?.cookies) ? loginExec.cookies : [];
    await sendLog(jobId, 'info', `🍪 In-session login completed (success=${!!loginExec?.success}); cookies=${latestCookies.length}`, {
      action: 'in_session_login_complete'
    });

    // If we land on a Next.js error shell (common when a chunk fails to load transiently),
    // do one hard reload to recover and avoid "Application error: a client-side exception..." screenshots.
    try {
      const htmlId = await page.evaluate(() => document?.documentElement?.id || '').catch(() => '');
      const bodyText = await page.textContent('body').catch(() => '');
      const isNextError = htmlId === '__next_error__' || /client-side exception/i.test(String(bodyText || ''));
      if (isNextError) {
        await sendLog(jobId, 'warn', `♻️ Detected Next.js error page after login; reloading once to recover`, {
          action: 'nextjs_error_reload',
          html_id: htmlId,
          page_url: page.url()
        });
        await page.reload({ waitUntil: 'networkidle', timeout: 45000 }).catch(() => page.reload().catch(() => {}));
        await page.waitForTimeout(1500);
      }
    } catch (_) {
      // ignore
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

