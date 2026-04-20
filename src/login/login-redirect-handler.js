/**
 * Login Redirect Handler
 * Detects login page redirections during crawling and handles them
 */

import * as backendLogger from '../backend-logger.js';
import { executeLoginWithWorkflow } from './login-workflow-engine.js';
import { getRunnerBackendUrl } from '../utils/runner-service-urls.js';

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
 * Configuration-first with scoped heuristics for auth hosts.
 */
export async function detectLoginPage(page, jobId, currentUrl, openaiClient, loginUrl = null, context = null) {
  try {
    const pageUrl = page.url();
    const currentUrlObj = new URL(pageUrl);

    const normalizeHost = (value) => String(value || '').trim().toLowerCase().replace(/^www\./, '');
    const normalizePath = (value) => {
      const p = String(value || '/').replace(/\/+$/, '');
      return p || '/';
    };
    const hostMatches = (host, domain) => {
      const h = normalizeHost(host);
      const d = normalizeHost(domain);
      if (!h || !d) return false;
      return h === d || h.endsWith(`.${d}`);
    };
    const parseUrl = (value) => {
      try {
        const raw = String(value || '').trim();
        if (!raw) return null;
        return new URL(raw.includes('://') ? raw : `https://${raw}`);
      } catch {
        return null;
      }
    };

    const configuredLoginUrls = [
      ...(loginUrl ? [loginUrl] : []),
      ...(Array.isArray(context?.login_urls) ? context.login_urls : []),
    ]
      .map(parseUrl)
      .filter(Boolean);

    const currentPath = normalizePath(currentUrlObj.pathname);

    // Strict match for explicitly configured absolute login URL(s).
    const strictConfiguredMatch = configuredLoginUrls.some((candidate) =>
      candidate.origin === currentUrlObj.origin && normalizePath(candidate.pathname) === currentPath
    );
    if (strictConfiguredMatch) {
      return { isLoginPage: true, confidence: 'high', reason: 'URL matches configured login URL' };
    }

    // Scoped fallback: if redirected to a configured project/api host and the URL shape is auth-like,
    // treat it as login so auto-retry can refresh session in the same browser context.
    const configuredDomains = [
      ...(Array.isArray(context?.api_domains) ? context.api_domains : []),
      ...(Array.isArray(context?.project_domains) ? context.project_domains : []),
      ...(Array.isArray(context?.options?.api_domains) ? context.options.api_domains : []),
      ...(Array.isArray(context?.options?.project_domains) ? context.options.project_domains : []),
      ...configuredLoginUrls.map((u) => u.hostname),
      parseUrl(context?.start_url)?.hostname,
      parseUrl(context?.options?.start_url)?.hostname,
    ]
      .map(normalizeHost)
      .filter(Boolean);
    const currentHost = normalizeHost(currentUrlObj.hostname);
    const hostInConfiguredSurface =
      configuredDomains.length > 0 && configuredDomains.some((domain) => hostMatches(currentHost, domain));

    const looksLikeLoginPath =
      /(^|\/)(login|signin|sign-in|auth)(\/|$)/i.test(currentUrlObj.pathname || '') ||
      /(?:^|[?&])(redirect|client_id|response_type)=/i.test(currentUrlObj.search || '');

    let hasPasswordField = false;
    try {
      const passwordInput = page.locator('input[type="password"]');
      const count = await passwordInput.count();
      if (count > 0) {
        hasPasswordField = await passwordInput.first().isVisible().catch(() => false);
      }
    } catch {
      hasPasswordField = false;
    }

    if (hostInConfiguredSurface && (looksLikeLoginPath || hasPasswordField)) {
      return {
        isLoginPage: true,
        confidence: 'medium',
        reason: 'Auth-like redirect on configured project/api host',
      };
    }

    return { isLoginPage: false, confidence: 'low', reason: 'No configured login surface match' };
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
  const backendUrl = getRunnerBackendUrl();
  const projectId = context.project_id || context.projectId;
  const loginUrl = context.login_url || null;
  const runnerToken = context.runner_token || null;
  
  // Detect if current page is a login page
  await sendLog(jobId, 'info', `🔍 Checking if page is a login page: ${currentUrl}`);
  const loginDetection = await detectLoginPage(page, jobId, currentUrl, openaiClient, loginUrl, context);
  
  if (!loginDetection.isLoginPage) {
    return null; // Not a login page, continue normally
  }
  
  await sendLog(jobId, 'warn', `⚠️ Login page detected (${loginDetection.confidence} confidence): ${loginDetection.reason}`);
  
  // Check how to handle the redirect
  if (handleLoginRedirect === 'fail') {
    await sendLog(jobId, 'error', `❌ Login redirect detected - failing crawl as configured`);
    throw new Error(`Login page detected at ${currentUrl} - crawl failed (handle_login_redirect: fail)`);
  }

  // Warn and ignore: log warning and continue crawl without re-authenticating
  if (handleLoginRedirect === 'warn_ignore') {
    await sendLog(jobId, 'warn', `⚠️ Login redirect ignored (warn_ignore) - continuing crawl without re-authentication`, {
      current_url: currentUrl,
      intended_url: intendedUrl
    });
    return null;
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
      context.login_workflow_template_id;

    if (!creds?.username || !creds?.password) {
      throw new Error('Backend did not return credentials for login-config');
    }
    if (!loginWorkflowId) {
      throw new Error('login_workflow_id missing from login config/context; cannot use static fallback workflow');
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
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => page.reload().catch(() => {}));
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

      // Next.js sometimes lands on a client-side exception screen in automation even though the app works manually.
      // If we detect that exact screen, do a one-time reload and re-check.
      const nextJsClientError = await page
        .locator('text=Application error: a client-side exception has occurred')
        .first()
        .isVisible()
        .catch(() => false);
      if (nextJsClientError) {
        await sendLog(jobId, 'warn', `⚠️ Detected Next.js client-side exception screen after login; reloading once...`, {
          component: 'LOGIN-REDIRECT-HANDLER',
          action: 'nextjs_client_error_reload',
          page_url: page.url()
        });
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
      
      const newUrl = page.url();
      await sendLog(jobId, 'info', `✅ Navigated to ${newUrl} with fresh cookies`);
      
      // Check if we're still on a login page
      const recheck = await detectLoginPage(page, jobId, newUrl, openaiClient, loginUrl, context);
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

