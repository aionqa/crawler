/**
 * Login Redirect Handler
 * Detects login page redirections during crawling and handles them
 */

import * as backendLogger from '../backend-logger.js';
import { executeLoginWithWorkflow } from './login-workflow-engine.js';
import { getRunnerBackendUrl } from '../utils/runner-service-urls.js';
import { navigationTargetKey } from '../utils/url-navigation-target-key.js';

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
 *
 * @param {string|null} intendedNavUrl - URL we navigated from / intended before redirects.
 *   When set, a visible password field alone does not imply a session gate if the rendered
 *   URL still matches the intended URL (e.g. crawling a static login-form demo page).
 * @param {{ skipIntendedUrlComparison?: boolean }} [detectionOptions]
 */
export async function detectLoginPage(
  page,
  jobId,
  currentUrl,
  openaiClient,
  loginUrl = null,
  context = null,
  intendedNavUrl = null,
  detectionOptions = null
) {
  try {
    /** Prefer explicit crawl `finalUrl` when valid; `page.url()` can lag or differ during navigation. */
    const parseHttpUrl = (raw) => {
      try {
        const rawStr = String(raw || '').trim();
        if (!rawStr) return null;
        const u = new URL(rawStr.includes('://') ? rawStr : `https://${rawStr}`);
        if (u.protocol === 'http:' || u.protocol === 'https:') return u;
      } catch {
        /* ignore */
      }
      return null;
    };

    const fromPage = parseHttpUrl(page.url());
    const fromExplicit = parseHttpUrl(currentUrl);
    /** Rendered surface for strict login URL + host/path heuristics (what the user actually sees). */
    const surfaceUrlObj = fromPage || fromExplicit;
    if (!surfaceUrlObj) {
      return { isLoginPage: false, confidence: 'low', reason: 'No navigable URL for login detection' };
    }

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

    const currentPath = normalizePath(surfaceUrlObj.pathname);

    // Strict match for explicitly configured absolute login URL(s).
    const strictConfiguredMatch = configuredLoginUrls.some((candidate) =>
      candidate.origin === surfaceUrlObj.origin && normalizePath(candidate.pathname) === currentPath
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
    const currentHost = normalizeHost(surfaceUrlObj.hostname);
    const hostInConfiguredSurface =
      configuredDomains.length > 0 && configuredDomains.some((domain) => hostMatches(currentHost, domain));

    const looksLikeLoginPath =
      /(^|\/)(login|signin|sign-in|auth)(\/|$)/i.test(surfaceUrlObj.pathname || '') ||
      /(?:^|[?&])(redirect|client_id|response_type)=/i.test(surfaceUrlObj.search || '');

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

    // Public registration / sign-up flows commonly include a password field on the same
    // project host as the app login surface. Treating them as "login pages" triggers
    // unnecessary in-session login workflows (often 4xx) and noisy self-monitor signals.
    const pathCandidates = new Set();
    const pushPath = (u) => {
      if (!u) return;
      try {
        pathCandidates.add(normalizePath(u.pathname).toLowerCase());
      } catch {
        /* ignore */
      }
    };
    pushPath(fromExplicit);
    pushPath(fromPage);
    // Include the URL we intended to navigate to (seed / queue URL). `page.url()` can lag or
    // omit path detail during early post-navigation probes; registration seeds must still classify
    // as registration-like even when the rendered surface URL object is incomplete.
    const intendedObj = parseHttpUrl(
      intendedNavUrl ?? context?.login_redirect_intended_url ?? context?.start_url ?? context?.options?.start_url
    );
    pushPath(intendedObj);
    if (pathCandidates.size === 0) pushPath(surfaceUrlObj);

    const pathLooksLikeRegistration = (pathLower) => {
      if (!pathLower) return false;
      return (
        /\b(register|registration|signup|sign[\s_-]?up|create[\s_-]?account)\b/i.test(pathLower) ||
        /\/account\/(?:create|new|register)(?:\/|$)/i.test(pathLower) ||
        // Filenames / segments: registration-form.html, register-form, sign-up-page (hyphens break \b-only patterns)
        /(^|\/)(register|registration|signup|sign-up|sign_up)([-._/]|\.[a-z]+$|$)/i.test(pathLower) ||
        /(register|signup|registration)[-_]form/i.test(pathLower)
      );
    };
    const looksLikeRegistrationPath = [...pathCandidates].some(pathLooksLikeRegistration);

    let registrationLikeDom = false;
    try {
      registrationLikeDom = await page.evaluate(() => {
        try {
          const pwdInputs = document.querySelectorAll('input[type="password"]');
          if (pwdInputs.length >= 2) {
            return true;
          }
          const newPwd = document.querySelector('input[type="password"][autocomplete="new-password"]');
          if (newPwd) {
            return true;
          }
          const confirmPwd = document.querySelector(
            'input[type="password"][name="confirm_password"], input[type="password"][name="password_confirmation"], #confirm_password'
          );
          if (confirmPwd) {
            return true;
          }
          const heading = `${document.querySelector('h1')?.textContent || ''} ${
            document.querySelector('h2')?.textContent || ''
          }`.toLowerCase();
          if (
            /\bregistration\b/.test(heading) ||
            /\bsign\s*up\b/.test(heading) ||
            /\bcreate\s+(an?\s+)?account\b/.test(heading)
          ) {
            return true;
          }
          const controls = Array.from(
            document.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])')
          );
          for (const el of controls) {
            const label = `${el.innerText || ''} ${el.value || ''}`.toLowerCase();
            if (
              /\b(register|sign\s*up|create\s*account|join\s+now|submit\s+registration)\b/.test(label)
            ) {
              return true;
            }
          }
        } catch (_) {
          /* ignore */
        }
        return false;
      });
    } catch {
      registrationLikeDom = false;
    }

    const registrationLikeSurface = looksLikeRegistrationPath || registrationLikeDom;

    const skipIntendedComparison = Boolean(detectionOptions?.skipIntendedUrlComparison);
    /**
     * Use the same canonical shape as workflow queue keys (`urlKeyForDedupe` / `canonicalizeUrl`)
     * so trivial serialization differences between `page.url()` and the queued crawl URL never
     * look like an auth redirect when the browser surface is still the requested page.
     */
    const urlsDifferFromIntended = (() => {
      if (skipIntendedComparison) return true;
      const rawIntended =
        intendedNavUrl ??
        context?.login_redirect_intended_url ??
        context?.seed_url ??
        context?.start_url ??
        context?.options?.start_url ??
        null;
      if (!rawIntended) return false;
      try {
        const intendedKey = navigationTargetKey(rawIntended);
        const surfaceKey = navigationTargetKey(surfaceUrlObj.href);
        if (!intendedKey || !surfaceKey) return false;
        return intendedKey !== surfaceKey;
      } catch {
        return false;
      }
    })();

    // Password fields are common on registration pages (handled), demo HTML fixtures, and
    // in-flow forms. Only treat auth-shaped paths/queries (login segments, OAuth query keys)
    // or password fields as a *redirect* gate on the project/api host when the browser surface
    // actually diverged from the URL we asked to visit. Otherwise, an intentional crawl of a
    // public "/login/..." or credentials fixture (same intended vs final URL) is mis-labeled
    // as "Auth-like redirect" and strict_stop fails the job spuriously.
    const looksLikeAuthPathOrQuery = looksLikeLoginPath;
    const scopedAuthSurface =
      (looksLikeAuthPathOrQuery && urlsDifferFromIntended) || (hasPasswordField && urlsDifferFromIntended);

    if (hostInConfiguredSurface && !registrationLikeSurface && scopedAuthSurface) {
      return {
        isLoginPage: true,
        confidence: 'medium',
        reason: 'Auth-like surface on configured project/api host (intended URL diverged from rendered URL)',
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
  const loginDetection = await detectLoginPage(page, jobId, currentUrl, openaiClient, loginUrl, context, intendedUrl);
  
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
      const recheck = await detectLoginPage(page, jobId, newUrl, openaiClient, loginUrl, context, newUrl, {
        skipIntendedUrlComparison: true,
      });
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

