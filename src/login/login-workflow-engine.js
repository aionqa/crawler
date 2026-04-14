import WorkflowAnalyzer from '../workflow/workflow-analyzer.js';
import { AIConversationLogger } from '../../shared/ai-conversation-logger.js';
import * as backendLogger from '../backend-logger.js';
import { evaluateLoginSessionEvidenceOverride } from '../workflow/utils/login-session-evidence-override.js';

/**
 * Login Workflow Engine
 *
 * Purpose:
 * - Execute login workflows (workflow templates) without mixing in crawl / recursion logic.
 * - Keep login execution isolated from page testing execution.
 *
 * This module is intentionally small and delegates workflow execution to WorkflowAnalyzer,
 * which executes the workflow template steps inside the runner.
 */
export async function executeLoginWithWorkflow(page, jobId, pageUrl, openaiApiKey, workflowContext) {
  const backendUrl = process.env.BACKEND_URL || 'http://back:4000';

  // Capture browser diagnostics to explain "client-side exception" screenshots.
  // Keep best-effort and bounded to avoid log spam.
  try {
    if (page && !page.__aionqaDiagnosticsAttached) {
      page.__aionqaDiagnosticsAttached = true;
      let consoleCount = 0;
      const maxConsole = 140;
      let netCount = 0;
      const maxNet = 40;
      let navCount = 0;
      const maxNav = 30;

      const redact = (value) => {
        try {
          let s = String(value || '');
          // Redact common token query params
          s = s.replace(/(accessToken=)[^&\\s]+/gi, '$1[REDACTED]');
          s = s.replace(/(token=)[^&\\s]+/gi, '$1[REDACTED]');
          s = s.replace(/(id_token=)[^&\\s]+/gi, '$1[REDACTED]');
          s = s.replace(/(refresh_token=)[^&\\s]+/gi, '$1[REDACTED]');
          // Redact JWT-like strings
          s = s.replace(/eyJ[a-zA-Z0-9_\\-]{20,}\\.[a-zA-Z0-9_\\-]{10,}\\.[a-zA-Z0-9_\\-]{10,}/g, '[REDACTED_JWT]');
          // Redact bearer tokens
          s = s.replace(/\\bBearer\\s+[a-zA-Z0-9._\\-]{20,}\\b/g, 'Bearer [REDACTED]');
          return s;
        } catch (_) {
          return '[REDACTED]';
        }
      };

      page.__aionqaTargetAssetSignals = { http5xxScript: 0, chunkOrModuleErrors: 0 };

      page.on('pageerror', async (err) => {
        try {
          const msg = (err && (err.stack || err.message)) ? String(err.stack || err.message) : String(err);
          try {
            const m = msg.toLowerCase();
            if (
              /chunkload|loading chunk|failed to load module|import\(\) failed|dynamic import|__next_error__/.test(
                m
              )
            ) {
              page.__aionqaTargetAssetSignals.chunkOrModuleErrors =
                (Number(page.__aionqaTargetAssetSignals.chunkOrModuleErrors) || 0) + 1;
            }
          } catch (_) {}
          await backendLogger.appendJobLog(jobId, 'error', `🧨 [PAGEERROR] ${redact(msg)}`.slice(0, 4000), 'BROWSER');
        } catch (_) {}
      });

      page.on('console', async (msg) => {
        try {
          if (consoleCount >= maxConsole) return;
          const type = msg.type();
          consoleCount++;
          const text = msg.text();
          const level = type === 'error'
            ? 'error'
            : (type === 'warning' ? 'warn' : 'info');
          await backendLogger.appendJobLog(
            jobId,
            level,
            `🗯️ [CONSOLE.${type}] ${redact(text)}`.slice(0, 2500),
            'BROWSER',
            {
              page_url: (() => { try { return page.url(); } catch { return null; } })()
            }
          );
        } catch (_) {}
      });

      // Track navigations to explain whether the script actually leaves login page.
      page.on('framenavigated', async (frame) => {
        try {
          if (navCount >= maxNav) return;
          if (!frame || frame !== page.mainFrame()) return;
          navCount++;
          const nextUrl = frame.url();
          await backendLogger.appendJobLog(
            jobId,
            'info',
            `🧭 [NAVIGATED] Main frame navigated to ${redact(nextUrl)}`.slice(0, 2000),
            'BROWSER'
          );
        } catch (_) {}
      });

      // Network failures / blocked resources frequently explain Next.js "__next_error__".
      page.on('requestfailed', async (req) => {
        try {
          if (netCount >= maxNet) return;
          netCount++;
          const url = redact(req.url());
          const method = req.method();
          const rt = req.resourceType();
          const err = req.failure()?.errorText || 'requestfailed';
          await backendLogger.appendJobLog(jobId, 'warn', `🌐 [REQUESTFAILED] ${method} ${rt} ${url} :: ${redact(err)}`.slice(0, 2000), 'BROWSER');
        } catch (_) {}
      });

      page.on('response', async (resp) => {
        try {
          const status = resp.status();
          if (status < 400) return;
          if (netCount >= maxNet) return;
          // Focus on likely-to-break-app resources
          const req = resp.request();
          const rt = req.resourceType();
          if (!['script', 'xhr', 'fetch', 'document'].includes(rt)) return;
          netCount++;
          const url = redact(resp.url());
          const ct = resp.headers()?.['content-type'] || '';
          if (status >= 500 && ['script', 'fetch', 'xhr'].includes(rt)) {
            page.__aionqaTargetAssetSignals.http5xxScript =
              (Number(page.__aionqaTargetAssetSignals.http5xxScript) || 0) + 1;
          }
          await backendLogger.appendJobLog(jobId, 'warn', `🚫 [HTTP ${status}] ${rt} ${url} (content-type=${redact(ct)})`.slice(0, 2000), 'BROWSER');
        } catch (_) {}
      });
    }
  } catch (_) {
    // never fail login because diagnostics hooking failed
  }

  const context = (workflowContext && typeof workflowContext === 'object' && !Array.isArray(workflowContext))
    ? { ...workflowContext }
    : {};

  const workflowTemplateId =
    context.workflow_template_id ||
    context.workflowTemplateId ||
    context.workflowId ||
    null;

  if (!workflowTemplateId) {
    throw new Error('workflow_template_id is required - all login jobs must use workflows stored in MongoDB');
  }

  if (!context.credentials || !context.credentials.username || !context.credentials.password) {
    throw new Error('credentials are required in context.credentials for login workflows');
  }

  const projectId = context.project_id || context.projectId || null;

  // Ensure login jobs never trigger crawl/link discovery paths.
  const normalizedContext = {
    ...context,
    job_id: jobId,
    page_url: pageUrl,
    workflow_template_id: workflowTemplateId,
    jobType: 'login',
    job_type: 'login',
    isLoginJob: true,
    preventCrawling: true,
    preventLinkDiscovery: true,
    openai_api_key: openaiApiKey || context.openai_api_key,
    options: {
      ...(context.options || {}),
      openai_api_key: openaiApiKey || context.options?.openai_api_key || context.openai_api_key
    }
  };

  // Pass normalized job context so AI logger can resolve ai_services/llm endpoint
  // for helper-driven login jobs without relying on implicit globals.
  const aiLogger = new AIConversationLogger(backendUrl, normalizedContext.runner_token, normalizedContext);

  const analyzer = new WorkflowAnalyzer(backendUrl, aiLogger, normalizedContext);
  const analysisResult = await analyzer.analyzePage(page, jobId, null, projectId);

  // CRITICAL: Check both determine_completion (from while-loop) AND validate_login_success (final validation)
  // The validate_login_success step is the final check after the while-loop completes
  // It should be the authoritative source for login success
  // The result structure can be: analysisResult.validate_login_success.result.content or analysisResult.validate_login_success.result
  let validateResult = null;
  if (analysisResult?.validate_login_success) {
    const vls = analysisResult.validate_login_success;
    validateResult = vls.result?.content || vls.result || vls.content || vls;
  }
  if (!validateResult && analysisResult?.results?.validate_login_success) {
    const vls = analysisResult.results.validate_login_success;
    validateResult = vls.result?.content || vls.result || vls.content || vls;
  }
  if (!validateResult && analysisResult?.context?.validate_login_success) {
    const vls = analysisResult.context.validate_login_success;
    validateResult = vls.result?.content || vls.result || vls.content || vls;
  }

  let determineResult = null;
  if (analysisResult?.determine_completion) {
    const dc = analysisResult.determine_completion;
    determineResult = dc.result?.content || dc.result || dc.content || dc;
  }
  if (!determineResult && analysisResult?.results?.determine_completion) {
    const dc = analysisResult.results.determine_completion;
    determineResult = dc.result?.content || dc.result || dc.content || dc;
  }
  if (!determineResult && analysisResult?.context?.determine_completion) {
    const dc = analysisResult.context.determine_completion;
    determineResult = dc.result?.content || dc.result || dc.content || dc;
  }

  // CRITICAL: Prefer validate_login_success over determine_completion for final status
  // validate_login_success is the final validation step after the while-loop
  // determine_completion is used inside the loop to decide if we should continue
  const finalResult = validateResult || determineResult;
  
  const extractStatusLikeValue = (value) => {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return null;
    if (typeof value.value === 'string') return value.value;
    if (typeof value.status === 'string') return value.status;
    if (value.status && typeof value.status === 'object' && typeof value.status.value === 'string') return value.status.value;
    if (typeof value.completion_status === 'string') return value.completion_status;
    if (value.completion_status && typeof value.completion_status === 'object' && typeof value.completion_status.value === 'string') {
      return value.completion_status.value;
    }
    return null;
  };

  // CRITICAL: Extract status as string - handle nested structures
  let loginStatus = null;
  if (finalResult) {
    // Try direct status field first
    const directStatus = extractStatusLikeValue(finalResult.status);
    if (directStatus) {
      loginStatus = directStatus;
    } 
    // Try nested status (e.g., result.status.status)
    else if (finalResult.status && typeof finalResult.status === 'object') {
      if (typeof finalResult.status.status === 'string') {
        loginStatus = finalResult.status.status;
      } else if (typeof finalResult.status.value === 'string') {
        loginStatus = finalResult.status.value;
      } else if (typeof finalResult.status.completion_status === 'string') {
        loginStatus = finalResult.status.completion_status;
      }
    }
    // Try completion_status field
    else {
      const completionStatus = extractStatusLikeValue(finalResult.completion_status);
      if (completionStatus) {
        loginStatus = completionStatus;
      }
    }
  }
  
  // CRITICAL: If loginStatus is still null, try extracting from determineResult directly
  // (This handles cases where finalResult extraction failed but determineResult has the status)
  if (!loginStatus && determineResult) {
    const determineStatus = extractStatusLikeValue(determineResult.status);
    if (determineStatus) {
      loginStatus = determineStatus;
    } else if (determineResult.status && typeof determineResult.status === 'object') {
      if (typeof determineResult.status.status === 'string') {
        loginStatus = determineResult.status.status;
      } else if (typeof determineResult.status.value === 'string') {
        loginStatus = determineResult.status.value;
      } else if (typeof determineResult.status.completion_status === 'string') {
        loginStatus = determineResult.status.completion_status;
      }
    } else {
      const determineCompletionStatus = extractStatusLikeValue(determineResult.completion_status);
      if (determineCompletionStatus) {
        loginStatus = determineCompletionStatus;
      }
    }
  }
  
  let success = loginStatus === 'success' || (finalResult?.is_complete === true && loginStatus !== 'failure');

  // Guard: AI can mis-read /verify-email when the API returned 400 and the UI shows "Verification Failed".
  try {
    if (success && page && typeof page.url === 'function') {
      const u = String(page.url() || '').toLowerCase();
      if (u.includes('/verify-email')) {
        const bodyText = ((await page.textContent('body')) || '').toLowerCase();
        if (
          /verification failed|email verification failed|failed to verify|invalid token|expired|unable to verify|could not verify/.test(
            bodyText
          )
        ) {
          console.warn(
            '🔒 Login success overridden: /verify-email page shows a failure state in the DOM'
          );
          success = false;
          loginStatus = 'failure';
        }
      }
    }
  } catch (guardErr) {
    console.warn(`⚠️ verify-email DOM guard skipped: ${guardErr?.message || guardErr}`);
  }

  const validateStatus = validateResult ? (typeof validateResult.status === 'string' ? validateResult.status : (validateResult.status?.status || 'N/A')) : 'N/A';
  const determineStatus = determineResult ? (typeof determineResult.status === 'string' ? determineResult.status : (determineResult.status?.status || 'N/A')) : 'N/A';
  console.log(`🔍 Login status check: validate_login_success=${validateStatus}, determine_completion=${determineStatus}, final=${loginStatus}, success=${success}`);

  // CRITICAL: Extract cookies from workflow result
  // The login workflow has a "collect_final_cookies" step that stores cookies in "finalCookies"
  // It also has "collect_iteration_cookies" that stores in "iterationCookies"
  // Cookies can be in multiple places in the workflow result
  let cookies = [];
  
  // First, check the top-level collectedCookies (from workflow result - most reliable)
  if (analysisResult?.collectedCookies && Array.isArray(analysisResult.collectedCookies) && analysisResult.collectedCookies.length > 0) {
    cookies = analysisResult.collectedCookies;
    console.log(`🍪 Found ${cookies.length} cookie(s) in analysisResult.collectedCookies`);
  }
  // Try to get cookies from workflowState (where cookie-collect steps store them)
  else {
    const workflowState = analysisResult?.workflowState || analysisResult?.context?.workflowState || {};
    
    // Check finalCookies first (from collect_final_cookies step)
    if (workflowState.finalCookies && Array.isArray(workflowState.finalCookies) && workflowState.finalCookies.length > 0) {
      cookies = workflowState.finalCookies;
      console.log(`🍪 Found ${cookies.length} cookie(s) in workflowState.finalCookies`);
    }
    // Check iterationCookies (from collect_iteration_cookies step)
    else if (workflowState.iterationCookies && Array.isArray(workflowState.iterationCookies) && workflowState.iterationCookies.length > 0) {
      cookies = workflowState.iterationCookies;
      console.log(`🍪 Found ${cookies.length} cookie(s) in workflowState.iterationCookies`);
    }
    // Check collectedCookies (generic cookie collection)
    else if (workflowState.collectedCookies && Array.isArray(workflowState.collectedCookies) && workflowState.collectedCookies.length > 0) {
      cookies = workflowState.collectedCookies;
      console.log(`🍪 Found ${cookies.length} cookie(s) in workflowState.collectedCookies`);
    }
    // Check step results directly
    else if (analysisResult?.collect_final_cookies?.cookies && Array.isArray(analysisResult.collect_final_cookies.cookies) && analysisResult.collect_final_cookies.cookies.length > 0) {
      cookies = analysisResult.collect_final_cookies.cookies;
      console.log(`🍪 Found ${cookies.length} cookie(s) in collect_final_cookies step result`);
    }
    else if (analysisResult?.collect_iteration_cookies?.cookies && Array.isArray(analysisResult.collect_iteration_cookies.cookies) && analysisResult.collect_iteration_cookies.cookies.length > 0) {
      cookies = analysisResult.collect_iteration_cookies.cookies;
      console.log(`🍪 Found ${cookies.length} cookie(s) in collect_iteration_cookies step result`);
    }
    else if (analysisResult?.cookie_collect?.cookies && Array.isArray(analysisResult.cookie_collect.cookies) && analysisResult.cookie_collect.cookies.length > 0) {
      cookies = analysisResult.cookie_collect.cookies;
      console.log(`🍪 Found ${cookies.length} cookie(s) in cookie_collect step result`);
    }
  }

  // If no cookies found in workflow result, try to collect from page context
  // This is a fallback - the workflow should have collected cookies via cookie-collect step
  if (cookies.length === 0 && page) {
    try {
      const contextCookies = await page.context().cookies();
      if (contextCookies && Array.isArray(contextCookies) && contextCookies.length > 0) {
        cookies = contextCookies;
        console.log(`🍪 Collected ${cookies.length} cookie(s) from page context as fallback`);
      }
    } catch (cookieError) {
      console.warn(`⚠️ Failed to collect cookies from page context: ${cookieError.message}`);
    }
  }

  // When validators disagree but the browser session + target asset degradation match login reality,
  // align with workflow-analyzer session_runtime_override semantics (shared util).
  try {
    if (!success) {
      const override = evaluateLoginSessionEvidenceOverride({
        page,
        workflowState: {
          collectedCookies: cookies,
          pageUrl: page && typeof page.url === 'function' ? String(page.url() || '') : '',
        },
        validatePayload: validateResult,
        determineResult,
        cleanExecution: true,
        seedUrl: pageUrl || normalizedContext.seed_url || normalizedContext.page_url,
      });
      if (override?.confirm) {
        success = true;
        loginStatus = 'success';
        console.log(`✅ Login success inferred from runtime/session evidence: ${override.reason}`);
      }
    }
  } catch (heuristicError) {
    console.warn(`⚠️ Login session-evidence override skipped: ${heuristicError?.message || heuristicError}`);
  }

  return {
    success,
    loginStatus: loginStatus || (success ? 'success' : 'unknown'),
    determineResult,
    workflowResult: analysisResult,
    cookies: cookies, // CRITICAL: Return cookies so they can be saved to project
    cookiesCollected: cookies.length
  };
}







