/**
 * AI-Driven Login Operations
 * Dedicated service for login automation
 * NO STATIC SELECTORS - ALL analysis driven by AI
 * 
 * Logging: Uses backend-logger.js (same as unified-crawler) for structured logging
 * - appendJobLog() for job-level logs
 * - appendPageLog() for page-specific logs (login page)
 * - appendAIChatLog() for AI conversation logs via shared ai-conversation-logger
 */

import * as backendLogger from './backend-logger.js';
import { humanType } from './human-typing.js';
import WorkflowAnalyzer from './workflow-analyzer.js';

// Import AI conversation logger (same as unified-crawler pattern)
let aiLogger = null;
try {
  const aiModule = await import('/app/shared/ai-conversation-logger.js');
  aiLogger = aiModule.aiConversationLogger;
  console.log('[LOGIN-SERVICE] ✅ Shared AI logger initialized');
} catch (error) {
  console.error('[LOGIN-SERVICE] ❌ Shared AI logger not available:', error.message);
}

/**
 * Clean script to remove markdown code blocks and function declarations
 */
function cleanScript(script) {
  if (!script || typeof script !== 'string') {
    return script;
  }
  
  let cleaned = script.trim();
  
  // First, extract code from markdown code blocks if present
  const codeBlockRegex = /```[\w]*\s*\n?([\s\S]*?)\n?```/g;
  const codeBlockMatches = [...cleaned.matchAll(codeBlockRegex)];
  if (codeBlockMatches.length > 0) {
    cleaned = codeBlockMatches.map(match => match[1]).join('\n\n');
  } else {
    cleaned = cleaned.replace(/^```[\w]*\s*\n?/gm, '');
    cleaned = cleaned.replace(/\n?\s*```$/gm, '');
    cleaned = cleaned.replace(/^\s*```[\w]*\s*$/gm, '');
    cleaned = cleaned.replace(/```[\w]*/g, '');
  }
  
  // Extract function bodies instead of removing functions completely
  const extractFunctionBodies = (text) => {
    const patterns = [
      /async\s+function\s*\([^)]*\)\s*\{/g,
      /async\s+function\s+\w+\s*\([^)]*\)\s*\{/g,
      /function\s*\([^)]*\)\s*\{/g,
      /function\s+\w+\s*\([^)]*\)\s*\{/g
    ];
    
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const start = match.index;
        const openBracePos = match.index + match[0].length - 1;
        let braceCount = 1;
        let pos = openBracePos + 1;
        const bodyStart = pos;
        
        while (braceCount > 0 && pos < text.length) {
          if (text[pos] === '{') braceCount++;
          else if (text[pos] === '}') braceCount--;
          pos++;
        }
        
        if (braceCount === 0) {
          const bodyEnd = pos - 1;
          const functionBody = text.slice(bodyStart, bodyEnd).trim();
          text = text.slice(0, start) + functionBody + text.slice(pos);
          pattern.lastIndex = 0;
        }
      }
    }
    
    return text;
  };
  
  cleaned = extractFunctionBodies(cleaned);
  
  // Remove IIFE wrappers
  cleaned = cleaned.replace(/\(async\s*\([^)]*\)\s*=>\s*\{/g, '');
  cleaned = cleaned.replace(/\(async\s+function\s*\([^)]*\)\s*\{[^}]*\}\)\s*\(\)/g, '');
  cleaned = cleaned.replace(/\(async\s*\(\)\s*=>\s*\{[^}]*\}\)\s*\(\)/g, '');
  
  // Remove require statements
  cleaned = cleaned.replace(/const\s+\{[^}]*\}\s*=\s*require\s*\([^)]*\)\s*;?\s*/g, '');
  cleaned = cleaned.replace(/const\s+\w+\s*=\s*require\s*\([^)]*\)\s*;?\s*/g, '');
  cleaned = cleaned.replace(/require\s*\([^)]*\)\s*;?\s*/g, '');
  
  // Remove module.exports
  cleaned = cleaned.replace(/module\.exports\s*=\s*[^;]+;?\s*/g, '');
  cleaned = cleaned.replace(/module\.exports\s*=\s*async\s+function[^}]*\}/g, '');
  
  // Remove browser/page creation
  cleaned = cleaned.replace(/const\s+browser\s*=\s*await\s+chromium\.launch[^;]+;?\s*/g, '');
  cleaned = cleaned.replace(/const\s+page\s*=\s*await\s+browser\.newPage[^;]+;?\s*/g, '');
  cleaned = cleaned.replace(/const\s+context\s*=\s*await\s+browser\.newContext[^;]+;?\s*/g, '');
  cleaned = cleaned.replace(/const\s+page\s*=\s*await\s+context\.newPage[^;]+;?\s*/g, '');
  cleaned = cleaned.replace(/await\s+browser\.close[^;]+;?\s*/g, '');
  cleaned = cleaned.replace(/await\s+context\.close[^;]+;?\s*/g, '');
  
  // Remove template variables
  cleaned = cleaned.replace(/\{\{[^}]+\}\}/g, '');
  
  // Remove comments
  cleaned = cleaned.replace(/\/\/[^\n]*/g, '');
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
  
  // Clean up extra whitespace
  cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n');
  cleaned = cleaned.trim();
  
  // If the script is wrapped in braces, unwrap them
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  
  return cleaned;
}

/**
 * Step 1: Find login form using OpenAI
 */
export async function findLoginForm(page, jobId, pageUrl) {
  if (!aiLogger) {
    throw new Error('AI logger not available');
  }

  try {
    console.log(`[LOGIN-SERVICE] Finding login form on: ${pageUrl}`);

    // Take screenshot
    const screenshot = await page.screenshot({ 
      fullPage: true,
      type: 'png' 
    });

    // Get HTML content
    const htmlContent = await page.content();
    
    // Extract page description and interactive elements
    const pageDescription = await page.evaluate(() => {
      const metaDescription = document.querySelector('meta[name="description"]');
      return metaDescription ? metaDescription.content : '';
    });
    
    const interactiveElements = await page.evaluate(() => {
      const elements = [];
      const inputs = document.querySelectorAll('input, button, select, textarea');
      inputs.forEach(el => {
        elements.push({
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          id: el.id || '',
          name: el.name || '',
          placeholder: el.placeholder || '',
          text: el.textContent?.trim().substring(0, 50) || ''
        });
      });
      return JSON.stringify(elements.slice(0, 20)); // Limit to first 20 elements
    });

    const response = await aiLogger.makeAICallWithPrompt(
      'find-login-form',
      {
        page_url: pageUrl,
        page_title: await page.title(),
        page_description: pageDescription || 'No description available',
        interactive_elements: interactiveElements || '[]',
        html_content: htmlContent.substring(0, 50000),
        screenshot: screenshot.toString('base64')
      },
      jobId,
      'login-service',
      pageUrl
    );

    if (!response || !response.form_found) {
      throw new Error('No login form found on page');
    }

    console.log(`[LOGIN-SERVICE] ✅ Login form found: ${response.form_type}`);
    return response;
  } catch (error) {
    console.error(`[LOGIN-SERVICE] ❌ Failed to find login form: ${error.message}`);
    throw error;
  }
}

/**
 * Deterministic login for practice/testautomation sites.
 * Fills credentials, submits, collects cookies/local/session, logs steps.
 */

/**
 * Step 2: Fill form field with retry
 */
export async function fillFieldWithRetry(page, jobId, pageUrl, field, value, maxRetries = 2) {
  let attempt = 0;
  let lastError = null;

  while (attempt < maxRetries) {
    try {
      console.log(`[LOGIN-SERVICE] Filling field attempt ${attempt + 1}/${maxRetries}: ${field.field_name}`);

      // Take before screenshot
      const beforeScreenshot = await page.screenshot({ type: 'png' });

      // Try main selector first
      const selector = field.selector;
      await page.waitForSelector(selector, { timeout: 5000 });
      
      // Use humanized typing instead of instant fill
      console.log(`[LOGIN-SERVICE] 🤖 Using humanized typing for ${field.field_name}`);
      await humanType(page, selector, value, {
        minDelay: 100,
        maxDelay: 300,
        typoChance: 0.10, // 10% chance of typo
        pauseChance: 0.15, // 15% chance of pause
        moveMouseFirst: true
      });

      // Take after screenshot
      const afterScreenshot = await page.screenshot({ type: 'png' });

      console.log(`[LOGIN-SERVICE] ✅ Field filled successfully: ${field.field_name}`);
      
      return {
        success: true,
        attempt: attempt + 1,
        selector: selector,
        beforeScreenshot,
        afterScreenshot
      };

    } catch (error) {
      console.error(`[LOGIN-SERVICE] ❌ Attempt ${attempt + 1} failed: ${error.message}`);
      lastError = error;

      // Try alternative selectors if available
      if (field.alternative_selectors && attempt < maxRetries - 1) {
        const altSelector = field.alternative_selectors[attempt];
        if (altSelector) {
          console.log(`[LOGIN-SERVICE] Trying alternative selector: ${altSelector}`);
          field.selector = altSelector;
        }
      }

      attempt++;
    }
  }

  return {
    success: false,
    attempt: attempt,
    error: lastError?.message || 'Unknown error',
    selector: field.selector
  };
}

/**
 * Step 3: Detect and handle captcha
 */
export async function detectAndHandleCaptcha(page, jobId, pageUrl, maxAttempts = 10) {
  if (!aiLogger) {
    throw new Error('AI logger not available');
  }

  try {
    console.log(`[LOGIN-SERVICE] Checking for captcha`);

    const screenshot = await page.screenshot({ 
      fullPage: true,
      type: 'png' 
    });

    const htmlContent = await page.content();

    const response = await aiLogger.makeAICallWithPrompt(
      'solve-captcha',
      {
        page_url: pageUrl,
        captcha_image: screenshot.toString('base64'),
        html_content: htmlContent.substring(0, 30000)
      },
      jobId,
      'login-service',
      pageUrl
    );

    if (!response.captcha_detected) {
      console.log(`[LOGIN-SERVICE] ✅ No captcha detected`);
      return { captchaPresent: false };
    }

    console.log(`[LOGIN-SERVICE] ⚠️  Captcha detected: ${response.captcha_type}`);

    if (response.requires_manual_intervention) {
      console.log(`[LOGIN-SERVICE] ⚠️  Manual intervention required for captcha`);
      return {
        captchaPresent: true,
        requiresManual: true,
        captchaType: response.captcha_type,
        recommendedApproach: response.recommended_approach
      };
    }

    // Try to solve captcha programmatically
    let solved = false;
    let attemptCount = 0;

    while (!solved && attemptCount < maxAttempts) {
      attemptCount++;
      console.log(`[LOGIN-SERVICE] Attempting to solve captcha (${attemptCount}/${maxAttempts})`);

      try {
        // Execute playwright code if provided (handle both field names)
        const playwrightCode = response.playwright_code || response.code;
        if (playwrightCode) {
          // Wrap in async IIFE to support return statements
          // Clean the code before execution
          let cleanedCode = cleanScript(playwrightCode);
          if (!cleanedCode || cleanedCode.trim().length === 0) {
            throw new Error('Script is empty after cleaning');
          }
          const wrappedCode = `(async function() { ${cleanedCode} })()`;
          await page.evaluate(wrappedCode);
          
          // Wait a bit and check if captcha is still present
          await page.waitForTimeout(2000);
          
          const newHtml = await page.content();
          if (!newHtml.includes('captcha') && !newHtml.includes('recaptcha')) {
            solved = true;
            console.log(`[LOGIN-SERVICE] ✅ Captcha solved on attempt ${attemptCount}`);
          }
        } else {
          // No automated solution available
          break;
        }
      } catch (error) {
        console.error(`[LOGIN-SERVICE] Captcha solve attempt ${attemptCount} failed: ${error.message}`);
      }
    }

    return {
      captchaPresent: true,
      requiresManual: !solved,
      captchaType: response.captcha_type,
      solved: solved,
      attempts: attemptCount
    };

  } catch (error) {
    console.error(`[LOGIN-SERVICE] ❌ Failed to handle captcha: ${error.message}`);
    return {
      captchaPresent: false,
      error: error.message
    };
  }
}

/**
 * Step 4: Validate login success
 */
export async function validateLoginSuccess(page, jobId, beforeState, credentials) {
  if (!aiLogger) {
    throw new Error('AI logger not available');
  }

  try {
    console.log(`[LOGIN-SERVICE] Validating login success`);

    // Get after state
    const afterUrl = page.url();
    const afterTitle = await page.title();
    const afterHtml = await page.content();
    const afterScreenshot = await page.screenshot({ type: 'png' });
    const cookies = await page.context().cookies();

    const response = await aiLogger.makeAICallWithPrompt(
      'validate-login-success',
      {
        before_url: beforeState.url,
        before_title: beforeState.title,
        before_screenshot: beforeState.screenshot.toString('base64'),
        after_url: afterUrl,
        after_title: afterTitle,
        after_html: afterHtml.substring(0, 30000),
        after_screenshot: afterScreenshot.toString('base64'),
        screenshot_base64: afterScreenshot.toString('base64'), // For vision API
        credentials_used: `username: ${credentials.username}`,
        cookies_set: JSON.stringify(cookies.map(c => c.name))
      },
      jobId,
      'login-service',
      afterUrl
    );

    console.log(`[LOGIN-SERVICE] ✅ Validation complete: ${response.login_successful ? 'SUCCESS' : 'FAILED'}`);
    console.log(`[LOGIN-SERVICE] Confidence: ${response.confidence}`);
    console.log(`[LOGIN-SERVICE] Analysis: ${response.analysis}`);

    // Extract auth tokens from page
    const authTokens = await page.evaluate(() => {
      const tokens = {
        localStorage: {},
        sessionStorage: {},
        cookies: []
      };

      // Get localStorage safely
      try {
        const storage = {};
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          storage[key] = window.localStorage.getItem(key);
        }
        tokens.localStorage = storage;
      } catch (error) {
        console.warn('localStorage access denied:', error.message);
        tokens.localStorage = {};
      }

      // Get sessionStorage safely
      try {
        const storage = {};
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const key = window.sessionStorage.key(i);
          storage[key] = window.sessionStorage.getItem(key);
        }
        tokens.sessionStorage = storage;
      } catch (error) {
        console.warn('sessionStorage access denied:', error.message);
        tokens.sessionStorage = {};
      }

      return tokens;
    });

    authTokens.cookies = cookies;

    return {
      ...response,
      authTokens
    };
  } catch (error) {
    console.error(`[LOGIN-SERVICE] ❌ Failed to validate login: ${error.message}`);
    throw error;
  }
}

/**
 * Main workflow: Perform login with AI-driven approach
 * Uses attempt-login prompt which combines all steps
 */
export async function performLogin(page, jobId, pageUrl, username, password, maxLoginAttempts = 2) {
  console.log(`[LOGIN-SERVICE] 🔐 Starting AI-driven login for: ${pageUrl}`);

  let loginAttempt = 0;
  let loginSuccess = false;
  let lastError = null;

  while (!loginSuccess && loginAttempt < maxLoginAttempts) {
    loginAttempt++;
    console.log(`[LOGIN-SERVICE] Login attempt ${loginAttempt}/${maxLoginAttempts}`);

    try {
      // Navigate to page
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Check if DOM is ready after 30s, continue anyway if not
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {
        console.warn(`[LOGIN-SERVICE] Page DOM not fully loaded after 30s, continuing anyway`);
      });

      // Save before state
      const beforeUrl = page.url();
      const beforeTitle = await page.title();
      const beforeHtml = await page.content();

      // Take screenshot
      const screenshot = await page.screenshot({ fullPage: true, type: 'png' });

      // Fetch previous job logs to help AI learn from failures
      let previousLogs = '';
      try {
        const backendUrl = process.env.BACKEND_URL || 'http://back:4000';
        const logsResponse = await fetch(`${backendUrl}/jobs/${jobId}/logs?limit=50`);
        if (logsResponse.ok) {
          const logs = await logsResponse.json();
          // Filter for relevant error logs and AI responses
          const relevantLogs = logs.filter(log => 
            log.level === 'error' || 
            log.message?.includes('AI') || 
            log.message?.includes('Script execution failed') ||
            log.message?.includes('Illegal return statement') ||
            log.message?.includes('SyntaxError')
          );
          if (relevantLogs.length > 0) {
            previousLogs = '\n\nPREVIOUS ATTEMPTS AND ERRORS:\n' + 
              relevantLogs.map(log => `[${log.timestamp}] ${log.level.toUpperCase()}: ${log.message}`).join('\n');
          }
        }
      } catch (logError) {
        console.log(`[LOGIN-SERVICE] Could not fetch previous logs: ${logError.message}`);
      }

      // Analyze page with Playwright to get form elements
      console.log(`[LOGIN-SERVICE] Analyzing page structure with Playwright...`);
      const playwrightAnalysis = await page.evaluate(() => {
        const forms = [];
        document.querySelectorAll('form').forEach((form, idx) => {
          const formData = {
            index: idx,
            action: form.action || '',
            method: form.method || 'get',
            fields: []
          };
          form.querySelectorAll('input, select, textarea').forEach(field => {
            formData.fields.push({
              type: field.type || field.tagName.toLowerCase(),
              name: field.name || '',
              id: field.id || '',
              placeholder: field.placeholder || '',
              required: field.required || false,
              selector: `${field.tagName.toLowerCase()}${field.id ? `#${field.id}` : ''}${field.name ? `[name="${field.name}"]` : ''}`
            });
          });
          forms.push(formData);
        });
        
        return {
          forms: forms,
          inputs: Array.from(document.querySelectorAll('input')).map(input => ({
            type: input.type,
            name: input.name,
            id: input.id,
            placeholder: input.placeholder,
            selector: `input${input.id ? `#${input.id}` : ''}${input.name ? `[name="${input.name}"]` : ''}`
          })),
          buttons: Array.from(document.querySelectorAll('button, input[type="submit"]')).map(btn => ({
            type: btn.type,
            text: btn.textContent || btn.value || '',
            id: btn.id,
            selector: `${btn.tagName.toLowerCase()}${btn.id ? `#${btn.id}` : ''}`
          }))
        };
      });
      
      console.log(`[LOGIN-SERVICE] Found ${playwrightAnalysis.forms.length} forms, ${playwrightAnalysis.inputs.length} inputs`);

      // Use attempt-login prompt which handles everything
      console.log(`[LOGIN-SERVICE] Calling AI for login analysis and script...`);
      const screenshotBase64 = screenshot.toString('base64');
      const loginResponse = await aiLogger.makeAICallWithPrompt(
        'attempt-login',
        {
          page_url: pageUrl,
          page_title: beforeTitle,
          html_content: beforeHtml.substring(0, 50000),
          screenshot: screenshotBase64,
          screenshot_base64: screenshotBase64, // For vision API
          playwright_analysis: JSON.stringify(playwrightAnalysis, null, 2),
          credentials: JSON.stringify({ username, password }),
          username: username,
          password: password,
          previous_attempts: previousLogs
        },
        jobId,
        'login-service',
        pageUrl
      );

      // Check for playwright_code, code, or script fields
      const playwrightCode = loginResponse.playwright_code || loginResponse.code || loginResponse.script;
      
      if (!loginResponse) {
        throw new Error('AI returned empty response');
      }
      
      if (!playwrightCode) {
        // Log detailed error with AI response
        console.error(`[LOGIN-SERVICE] ❌ AI response missing Playwright code. Response keys: ${Object.keys(loginResponse).join(', ')}`);
        console.error(`[LOGIN-SERVICE] Full AI response:`, JSON.stringify(loginResponse, null, 2));
        throw new Error(`AI did not return Playwright code for login. Response contained: ${Object.keys(loginResponse).join(', ')}`);
      }
      
      console.log(`[LOGIN-SERVICE] ✅ AI provided login script, executing...`);
      console.log(`[LOGIN-SERVICE] Code preview: ${playwrightCode.substring(0, 100)}...`);

      // Execute the playwright code - wrap in async function to allow return statements
      try {
        // Wrap the AI-generated code in an async IIFE to support return statements
        // Clean the code before execution
        let cleanedCode = cleanScript(playwrightCode);
        if (!cleanedCode || cleanedCode.trim().length === 0) {
          throw new Error('Script is empty after cleaning');
        }
        const wrappedCode = `(async function() { ${cleanedCode} })()`;
        const result = await page.evaluate(wrappedCode);
        console.log(`[LOGIN-SERVICE] ✅ Script executed successfully:`, result);
        console.log(`[LOGIN-SERVICE] ✅ Login script executed`);
      } catch (execError) {
        throw new Error(`Script execution failed: ${execError.message}`);
      }

      // Wait for navigation or page changes
      await page.waitForTimeout(3000);

      // Get after state
      const afterUrl = page.url();
      const afterTitle = await page.title();
      const afterHtml = await page.content();
      const afterScreenshot = await page.screenshot({ type: 'png' });
      const cookies = await page.context().cookies();

      // Validate login success
      console.log(`[LOGIN-SERVICE] Validating login result...`);
      const validation = await aiLogger.makeAICallWithPrompt(
        'validate-login-success',
        {
          before_url: beforeUrl,
          before_title: beforeTitle,
          after_url: afterUrl,
          after_title: afterTitle,
          after_html: afterHtml.substring(0, 30000),
          after_screenshot: afterScreenshot.toString('base64'),
          screenshot_base64: afterScreenshot.toString('base64'), // For vision API
          credentials_used: `username: ${username}`,
          cookies_set: JSON.stringify(cookies.map(c => c.name))
        },
        jobId,
        'login-service',
        afterUrl
      );

      // Debug: Log full response
      console.log(`[LOGIN-SERVICE] Validation response keys: ${Object.keys(validation).join(', ')}`);
      console.log(`[LOGIN-SERVICE] Validation response values:`, JSON.stringify({
        login_successful: validation.login_successful,
        success: validation.success,
        is_successful: validation.is_successful,
        validated: validation.validated
      }));
      
      // Handle multiple field names for login success
      const isLoginSuccessful = validation.login_successful || 
                                 validation.success || 
                                 validation.is_successful ||
                                 validation.validated;
      
      console.log(`[LOGIN-SERVICE] Login successful: ${isLoginSuccessful}`);
      
      if (isLoginSuccessful) {
        loginSuccess = true;
        console.log(`[LOGIN-SERVICE] ✅ Login successful! Confidence: ${validation.confidence || 'N/A'}`);

        // Extract auth tokens
        // Get localStorage and sessionStorage safely
        const localStorage = await page.evaluate(() => {
          try {
            const storage = {};
            for (let i = 0; i < window.localStorage.length; i++) {
              const key = window.localStorage.key(i);
              storage[key] = window.localStorage.getItem(key);
            }
            return storage;
          } catch (error) {
            console.warn('localStorage access denied:', error.message);
            return {};
          }
        });
        
        const sessionStorage = await page.evaluate(() => {
          try {
            const storage = {};
            for (let i = 0; i < window.sessionStorage.length; i++) {
              const key = window.sessionStorage.key(i);
              storage[key] = window.sessionStorage.getItem(key);
            }
            return storage;
          } catch (error) {
            console.warn('sessionStorage access denied:', error.message);
            return {};
          }
        });
        
        const authTokens = {
          localStorage,
          sessionStorage
        };
        authTokens.cookies = cookies;

        return {
          success: true,
          attempt: loginAttempt,
          validation: validation,
          finalUrl: afterUrl,
          finalTitle: afterTitle,
          cookies: cookies,
          authTokens: authTokens,
          captchaEncountered: false,
          captchaSolved: false
        };
      } else {
        console.log(`[LOGIN-SERVICE] ❌ Login validation failed: ${validation.analysis}`);
        lastError = new Error(`Login validation failed: ${validation.analysis}`);
      }

    } catch (error) {
      console.error(`[LOGIN-SERVICE] ❌ Login attempt ${loginAttempt} failed: ${error.message}`);
      lastError = error;

      // If not last attempt, wait and retry
      if (loginAttempt < maxLoginAttempts) {
        console.log(`[LOGIN-SERVICE] Will retry...`);
        await page.waitForTimeout(2000);
        // Try to navigate back to login page
        try {
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Check if DOM is ready after 30s, continue anyway if not
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {
        console.warn(`[LOGIN-SERVICE] Page DOM not fully loaded after 30s, continuing anyway`);
      });
        } catch (e) {
          console.error(`[LOGIN-SERVICE] Failed to navigate back to login page: ${e.message}`);
        }
      }
    }
  }

  // All attempts failed
  return {
    success: false,
    attempt: loginAttempt,
    error: lastError?.message || 'Unknown error',
    finalUrl: page.url(),
    finalTitle: await page.title().catch(() => 'Unknown')
  };
}

/**
 * NEW: Workflow-based login using same architecture as WorkflowAnalyzer
 * Integrates login into unified-crawler using workflow templates
 */
export async function performLoginWithWorkflow(
  page,
  jobId,
  pageUrl,
  username,
  password,
  openaiApiKey,
  workflowContext = {}
) {
  const BACKEND_URL = process.env.BACKEND_URL || 'http://back:4000';
  const previousUsernameEnv = process.env.LOGIN_USERNAME;
  const previousPasswordEnv = process.env.LOGIN_PASSWORD;

  try {
    const axios = (await import('axios')).default;

    if (typeof username === 'string' && username.length > 0) {
      process.env.LOGIN_USERNAME = username;
    } else {
      delete process.env.LOGIN_USERNAME;
    }

    if (typeof password === 'string' && password.length > 0) {
      process.env.LOGIN_PASSWORD = password;
    } else {
      delete process.env.LOGIN_PASSWORD;
    }

    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    console.log(`[LOGIN-WORKFLOW] 🔐 Starting workflow-based login for ${pageUrl}`);
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);

    let context = {};
    if (workflowContext && typeof workflowContext === 'object' && !Array.isArray(workflowContext)) {
      context = { ...workflowContext };
    } else if (typeof workflowContext === 'string') {
      context = { workflow_template_id: workflowContext };
    }

    const workflowTemplateId =
      context.workflow_template_id ||
      context.workflowTemplateId ||
      context.workflowId ||
      null;

    if (!workflowTemplateId) {
      throw new Error('workflow_template_id is required - all login jobs must use workflows stored in MongoDB');
    }

    const projectId = context.project_id || context.projectId || null;

    const normalizedContext = {
      ...context,
      workflow_template_id: workflowTemplateId,
      project_id: projectId,
      projectId,
      job_id: jobId,
      jobId,
      page_url: pageUrl,
      username,
      password,
      credentials: context.credentials || { username, password },
      runner_token: context.runner_token, // Preserve runner token for API authentication
      options: {
        ...(context.options || {})
      }
    };

    if (openaiApiKey) {
      normalizedContext.openai_api_key = openaiApiKey;
      normalizedContext.options.openai_api_key = openaiApiKey;
    }

    if (normalizedContext.options.execute_workflow === undefined) {
      normalizedContext.options.execute_workflow = true;
    }

    let conversationLogger = aiLogger;
    if (!conversationLogger) {
      const { AIConversationLogger } = await import('/app/shared/ai-conversation-logger.js');
      conversationLogger = new AIConversationLogger(BACKEND_URL);
    }

    await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
      jobId,
      level: 'info',
      message: `🔄 WORKFLOW: Using login workflow ${workflowTemplateId}`,
      component: 'LOGIN-WORKFLOW',
      metadata: {
        workflow_decision: true,
        workflow_id: workflowTemplateId,
        page_url: pageUrl,
        timestamp: new Date().toISOString()
      }
    }).catch(() => {});

    const workflowAnalyzer = new WorkflowAnalyzer(BACKEND_URL, conversationLogger, normalizedContext);
    const analysisResult = await workflowAnalyzer.analyzePage(page, jobId, null, projectId);

    // Extract determine_completion result from multiple possible locations
    // CRITICAL: The while-loop stores determine_completion in each iteration, need to get from last iteration
    let determineResult = null;
    
    // Strategy 1: Check if it was promoted to top level after loop completion
    determineResult = 
      analysisResult?.determine_completion?.result ||
      analysisResult?.results?.determine_completion?.result ||
      analysisResult?.context?.determine_completion?.result ||
      analysisResult?.context?.determine_completion ||
      null;
    
    // Strategy 2: Extract from while-loop's last iteration (most reliable)
    if (!determineResult || (!determineResult.status && !determineResult.completion_status)) {
      const performLoginAttempts = 
        analysisResult?.perform_login_attempts ||
        analysisResult?.results?.perform_login_attempts ||
        analysisResult?.context?.perform_login_attempts ||
        analysisResult?.perform_login_attempts?.result ||
        analysisResult?.results?.perform_login_attempts?.result ||
        {};
      
      // Check if determine_completion is in the loop result
      if (performLoginAttempts.determine_completion) {
        determineResult = performLoginAttempts.determine_completion.result ||
                         performLoginAttempts.determine_completion ||
                         determineResult;
      }
      
      // Check loop history (last iteration)
      if ((!determineResult || (!determineResult.status && !determineResult.completion_status)) && 
          performLoginAttempts.loopHistory && Array.isArray(performLoginAttempts.loopHistory)) {
        const lastIteration = performLoginAttempts.loopHistory[performLoginAttempts.loopHistory.length - 1];
        
        // Check multiple paths in last iteration
        determineResult = 
          lastIteration?.lastResult?.determine_completion?.result ||
          lastIteration?.lastResult?.determine_completion ||
          lastIteration?.determine_completion?.result ||
          lastIteration?.determine_completion ||
          determineResult;
      }
      
      // Check context for determine_completion from last execution
      if (!determineResult || (!determineResult.status && !determineResult.completion_status)) {
        determineResult =
          analysisResult?.context?.lastExecutionResult?.determine_completion?.result ||
          analysisResult?.lastExecutionResult?.determine_completion?.result ||
          analysisResult?.lastExecutionResult?.determine_completion ||
          determineResult;
      }
    }
    
    // Fallback to empty object if nothing found
    if (!determineResult) {
      determineResult = {};
    }
    
    console.log(`[LOGIN-WORKFLOW] 🔍 Extracted determineResult:`, JSON.stringify({
      status: determineResult.status,
      completion_status: determineResult.completion_status,
      is_complete: determineResult.is_complete
    }));

    // Extract cookies from multiple possible locations FIRST
    const iterationCookies =
      analysisResult?.collect_iteration_cookies?.result?.cookies ||
      analysisResult?.iterationCookies ||
      analysisResult?.context?.iterationCookies ||
      [];

    // Try multiple paths to find final cookies
    let finalCookies =
      analysisResult?.collect_final_cookies?.result?.cookies ||
      analysisResult?.finalCookies ||
      analysisResult?.context?.finalCookies ||
      analysisResult?.collectedCookies ||  // From cookie-collect step
      analysisResult?.context?.collectedCookies ||
      iterationCookies ||
      [];

    // If no cookies found, try to get them from browser context directly
    if (!finalCookies || finalCookies.length === 0) {
      try {
        const browserCookies = await page.context().cookies();
        if (browserCookies && browserCookies.length > 0) {
          console.log(`[LOGIN-WORKFLOW] 🔍 No cookies in workflow result, collecting from browser: ${browserCookies.length} cookies`);
          finalCookies = browserCookies;
        }
      } catch (cookieError) {
        console.warn(`[LOGIN-WORKFLOW] ⚠️ Failed to collect cookies from browser: ${cookieError.message}`);
      }
    }

    const finalUrl = page.url();
    
    // CRITICAL: Rely ONLY on AI response from determine_completion step in workflow
    // Do NOT use static URL patterns - workflows must work on different websites
    // The AI in determine_completion step analyzes the page state and determines success
    
    console.log(`[LOGIN-WORKFLOW] 🔍 Checking AI-determined login status from determine_completion step`);
    console.log(`[LOGIN-WORKFLOW] determineResult:`, JSON.stringify({
      status: determineResult?.status,
      completion_status: determineResult?.completion_status,
      is_complete: determineResult?.is_complete,
      reason: determineResult?.reason?.substring(0, 100)
    }));
    console.log(`[LOGIN-WORKFLOW] Full determineResult keys:`, determineResult ? Object.keys(determineResult) : 'null');
    console.log(`[LOGIN-WORKFLOW] analysisResult keys:`, analysisResult ? Object.keys(analysisResult) : 'null');
    if (analysisResult?.perform_login_attempts) {
      console.log(`[LOGIN-WORKFLOW] perform_login_attempts keys:`, Object.keys(analysisResult.perform_login_attempts));
    }
    
    // Extract login status from AI response (determine_completion step result)
    // The AI analyzes the page and determines if login was successful
    const loginStatus =
      determineResult.status ||  // Primary: status from AI (success/failure/continue/stuck)
      determineResult.completion_status ||  // Alternative: completion_status (complete/in_progress/failed/needs_iteration/stuck)
      analysisResult?.login_status ||  // Fallback: explicit login_status if set elsewhere
      analysisResult?.context?.login_status ||
      analysisResult?.loginStatus ||
      null;

    // Determine success based ONLY on AI response
    // AI sets status='success' when it determines authentication is successful
    const loginSuccess =
      loginStatus === 'success' ||  // AI determined success
      (determineResult.status === 'success') ||  // Explicit success status
      (determineResult.completion_status === 'complete' && loginStatus !== 'failure') ||  // Completion with no failure
      (determineResult.is_complete === true && determineResult.status !== 'failure');  // Complete without failure
    
    console.log(`[LOGIN-WORKFLOW] 🔍 Final login status: ${loginStatus}, success: ${loginSuccess}`);
    
    console.log(`[LOGIN-WORKFLOW] 🔍 Final inference: loginStatus=${loginStatus}, loginSuccess=${loginSuccess}`);


    let finalTitle = 'Unknown';
    try {
      finalTitle = await page.title();
    } catch (titleError) {
      console.warn(`[LOGIN-WORKFLOW] ⚠️ Unable to read page title: ${titleError.message}`);
    }

    await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
      jobId,
      level: loginSuccess ? 'info' : 'warn',
      message: loginSuccess
        ? `✅ LOGIN WORKFLOW: Completed successfully`
        : `❌ LOGIN WORKFLOW: Login not confirmed`,
      component: 'LOGIN-WORKFLOW',
      metadata: {
        login_status: loginStatus || 'unknown',
        cookies_collected: finalCookies.length,
        final_url: finalUrl,
        final_title: finalTitle,
        timestamp: new Date().toISOString()
      }
    }).catch(() => {});

    return {
      success: loginSuccess,
      loginStatus: loginStatus || 'unknown',
      finalUrl,
      finalTitle,
      cookies: finalCookies,
      iterationCookies,
      workflow_template_id: workflowTemplateId,
      workflowResult: analysisResult
    };
  } catch (error) {
    console.error(`[LOGIN-WORKFLOW] Login workflow failed: ${error.message}`);
    let finalTitle = 'Unknown';
    try {
      finalTitle = await page.title();
    } catch (_) {
      // ignore
    }
    return {
      success: false,
      error: error.message,
      finalUrl: page.url(),
      finalTitle
    };
  } finally {
    if (previousUsernameEnv !== undefined) {
      process.env.LOGIN_USERNAME = previousUsernameEnv;
    } else {
      delete process.env.LOGIN_USERNAME;
    }

    if (previousPasswordEnv !== undefined) {
      process.env.LOGIN_PASSWORD = previousPasswordEnv;
    } else {
      delete process.env.LOGIN_PASSWORD;
    }
  }
}


export default {
  findLoginForm,
  fillFieldWithRetry,
  detectAndHandleCaptcha,
  validateLoginSuccess,
  performLogin,
  performLoginWithWorkflow
};

