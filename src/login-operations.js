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
      await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 30000 });

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
          await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 30000 });
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
export async function performLoginWithWorkflow(page, jobId, pageUrl, username, password, openaiApiKey, workflowTemplateId = null) {
  const BACKEND_URL = process.env.BACKEND_URL || 'http://back:4000';
  
  // Store original URL for OAuth redirect detection
  const originalLoginUrl = pageUrl;
  
  try {
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    console.log(`[LOGIN-WORKFLOW] 🔐 LOGIN STEP 1: INITIALIZE WORKFLOW`);
    console.log(`[LOGIN-WORKFLOW] Starting workflow-based login for ${pageUrl}`);
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    
    // Log step 1
    const axios = (await import('axios')).default;
    await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
      jobId: jobId,
      level: 'info',
      message: `🔐 LOGIN STEP 1: Initializing workflow-based login for ${pageUrl}`,
      component: 'LOGIN-WORKFLOW',
      metadata: {
        login_step: 1,
        step_name: 'INITIALIZE_WORKFLOW',
        page_url: pageUrl,
        workflow_template_id: workflowTemplateId,
        timestamp: new Date().toISOString()
      }
    });
    
    // Initialize AI logger with workflow support
    const { AIConversationLogger } = await import('/app/shared/ai-conversation-logger.js');
    const aiLogger = new AIConversationLogger(BACKEND_URL);
    
    // Load workflow template (MANDATORY - no default prompts)
    let workflowTemplate = null;
    if (!workflowTemplateId) {
      console.error(`[LOGIN-WORKFLOW] ❌ No workflow template ID provided - workflows are mandatory!`);
      throw new Error('login_workflow_id is required - all jobs must use workflows stored in MongoDB');
    }
    
    try {
      const axios = (await import('axios')).default;
      const response = await axios.get(`${BACKEND_URL}/api/workflow-templates/${workflowTemplateId}`);
      workflowTemplate = response.data;
      console.log(`[LOGIN-WORKFLOW] ✅ Loaded workflow: "${workflowTemplate.name}" (ID: ${workflowTemplateId})`);
      console.log(`[LOGIN-WORKFLOW] 📄 Workflow contains ${workflowTemplate.steps?.length || 0} steps`);
      
      // Log workflow usage
      await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'info',
        message: `🔄 WORKFLOW: Using workflow "${workflowTemplate.name}" (ID: ${workflowTemplateId})`,
        component: 'LOGIN-WORKFLOW',
        metadata: {
          workflow_decision: true,
          workflow_id: workflowTemplateId,
          workflow_name: workflowTemplate.name,
          details: `Workflow contains ${workflowTemplate.steps?.length || 0} steps`,
          prompts_count: workflowTemplate.steps?.filter(s => s?.config?.prompt || s?.config?.template || s?.config?.prompt_content)?.length || 0,
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      console.error(`[LOGIN-WORKFLOW] ❌ Failed to load workflow template: ${error.message}`);
      throw new Error(`Failed to load workflow template ${workflowTemplateId}: ${error.message}`);
    }
    
    // Helper to get custom template with logging
    const promptIndex = new Map();
    if (workflowTemplate?.steps && Array.isArray(workflowTemplate.steps)) {
      for (const step of workflowTemplate.steps) {
        const config = step?.config || {};
        const promptText = config.prompt || config.template || config.prompt_content;
        if (!promptText) continue;
        const entry = {
          template: promptText,
          attachments: Array.isArray(config.attachments) ? config.attachments : [],
          step
        };
        const addKey = (key) => {
          if (!key) return;
          promptIndex.set(String(key).toLowerCase(), entry);
        };
        addKey(step.id);
        addKey(step.name);
        addKey(step.type);
        addKey(config.slug);
        addKey(config.prompt_slug);
        // Custom aliases for known login workflow prompts
        if (step.type === 'ai-prompt' && /login/i.test(step.name || '')) {
          addKey('attempt-login');
        }
        if (step.type === 'page-description' && /page description/i.test(step.name || '')) {
          addKey('find-login-form');
          addKey('page-description');
        }
      }
    }

    const getCustomTemplate = async (promptName) => {
      const key = String(promptName || '').toLowerCase();
      const entry = promptIndex.get(key);
      if (!entry) {
        throw new Error(`Prompt "${promptName}" is not configured in workflow steps. Please define it in the workflow builder.`);
      }

      console.log(`[LOGIN-WORKFLOW] ✅ Using workflow step "${entry.step.name}" for prompt "${promptName}"`);
      console.log(`[LOGIN-WORKFLOW] 📝 Prompt text: ${entry.template.substring(0, 100)}...`);

      try {
        const axios = (await import('axios')).default;
        await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
          jobId: jobId,
          level: 'info',
          message: `📝 PROMPT USAGE: "${promptName}" from workflow step "${entry.step.name}"`,
          component: 'LOGIN-WORKFLOW',
          metadata: {
            prompt_usage: true,
            prompt_name: promptName,
            prompt_source: 'workflow-step',
            prompt_text_preview: entry.template.substring(0, 200),
            workflow_template_id: workflowTemplateId,
            workflow_template_name: workflowTemplate.name,
            workflow_step_id: entry.step.id,
            workflow_step_type: entry.step.type,
            attachments: entry.attachments,
            timestamp: new Date().toISOString()
          }
        });
      } catch (logError) {
        console.error(`[LOGIN-WORKFLOW] Error logging prompt usage: ${logError.message}`);
      }

      return entry.template;
    };
    
    // Iterative AI-driven loop: scan → prompt → execute → rescan until cookies or attempts
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    console.log(`[LOGIN-WORKFLOW] 🔄 EXECUTING ITERATIVE LOGIN LOOP`);
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);

    const maxAttemptsFromWorkflow = (workflowTemplate.settings && workflowTemplate.settings.maxAttempts) ||
      (workflowTemplate.config && workflowTemplate.config.maxAttempts) || 3;
    let attemptIndex = 0;
    let collectedCookies = [];
    let lastAIResponse = null;

    while (attemptIndex < maxAttemptsFromWorkflow) {
      attemptIndex++;
      await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'info',
        message: `🔁 Iteration ${attemptIndex}/${maxAttemptsFromWorkflow}: Scan → AI → Execute → Rescan`,
        component: 'LOGIN-WORKFLOW',
        metadata: { iteration: attemptIndex, max: maxAttemptsFromWorkflow }
      });

      // Scan page (screenshot + html + interactive elements)
      const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
      const htmlContent = await page.content();
      const interactiveElements = await page.evaluate(() => {
        const elements = [];
        const inputs = document.querySelectorAll('input, button, select, textarea, a');
        inputs.forEach(el => {
          elements.push({
            tag: el.tagName.toLowerCase(),
            type: el.type || '',
            id: el.id || '',
            name: el.name || '',
            placeholder: el.placeholder || '',
            text: (el.textContent || '').trim().substring(0, 80)
          });
        });
        return JSON.stringify(elements.slice(0, 100));
      });

      // Ask OpenAI to attempt login and return playwright code
      const customTemplate = await getCustomTemplate('attempt-login');
      const aiResponse = await aiLogger.makeAICallWithPrompt(
        'attempt-login',
        {
          page_url: pageUrl,
          page_title: await page.title(),
          html_content: htmlContent.substring(0, 50000),
          screenshot: screenshot.toString('base64'),
          screenshot_base64: screenshot.toString('base64'),
          interactive_elements: interactiveElements,
          username,
          password
        },
        jobId,
        'login-workflow',
        pageUrl,
        null,
        null,
        customTemplate
      );
      lastAIResponse = aiResponse;

      let codeToRun = aiResponse?.playwright_code || aiResponse?.code || aiResponse?.script;
      if (codeToRun) {
        try {
          // Clean the code to remove markdown code blocks and function declarations
          codeToRun = cleanScript(codeToRun);
          
          if (!codeToRun || codeToRun.trim().length === 0) {
            console.warn(`[LOGIN-WORKFLOW] Iteration ${attemptIndex}: code is empty after cleaning`);
          } else {
            const fn = new Function('page', `return (async () => { ${codeToRun}\n })()`);
            await fn(page);
          }
        } catch (e) {
          console.error(`[LOGIN-WORKFLOW] Iteration ${attemptIndex}: code execution error: ${e.message}`);
          console.error(`[LOGIN-WORKFLOW] Code (first 200 chars): ${codeToRun?.substring(0, 200)}`);
        }
      } else {
        console.log(`[LOGIN-WORKFLOW] Iteration ${attemptIndex}: no code returned by AI`);
      }

      // Rescan and check cookies
      await page.waitForTimeout(2000);
      const cookiesNow = await page.context().cookies();
      collectedCookies = cookiesNow;
      const hasAuthCookies = cookiesNow.some(c =>
        (c.name || '').toLowerCase().includes('session') ||
        (c.name || '').toLowerCase().includes('token') ||
        (c.name || '').toLowerCase().includes('auth') ||
        (c.name || '').toLowerCase().includes('jwt')
      );

      await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
        jobId: jobId,
        level: hasAuthCookies ? 'info' : 'warn',
        message: hasAuthCookies ? `✅ Cookies detected after iteration ${attemptIndex}` : `❌ No auth cookies yet after iteration ${attemptIndex}`,
        component: 'LOGIN-WORKFLOW',
        metadata: { iteration: attemptIndex, cookies_count: cookiesNow.length }
      });

      if (hasAuthCookies) {
        break;
      }
    }

    if (collectedCookies.length === 0) {
      console.log(`[LOGIN-WORKFLOW] ⚠️ Iterations finished without cookies; proceeding to legacy path`);
    }
    
    // Navigate to login page (keep existing logic for compatibility)
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    console.log(`[LOGIN-WORKFLOW] 🔐 LOGIN STEP 2: NAVIGATE TO LOGIN PAGE`);
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 30000 });
    
    // Wait a bit to allow OAuth redirects
    await page.waitForTimeout(2000);
    
    const currentUrl = page.url();
    const initialDomain = new URL(pageUrl).hostname;
    const currentDomain = new URL(currentUrl).hostname;
    
    console.log(`[LOGIN-WORKFLOW] Navigated to login page. Initial domain: ${initialDomain}, Current domain: ${currentDomain}`);
    
    // Detect OAuth redirect (domain changed)
    if (currentDomain !== initialDomain) {
      console.log(`[LOGIN-WORKFLOW] 🔄 OAuth redirect detected: ${initialDomain} → ${currentDomain}`);
      
      await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'info',
        message: `🔄 OAuth redirect detected: redirected from ${initialDomain} to ${currentDomain}`,
        component: 'LOGIN-WORKFLOW',
        metadata: {
          login_step: 2,
          step_name: 'OAUTH_REDIRECT_DETECTED',
          original_url: pageUrl,
          redirected_url: currentUrl,
          original_domain: initialDomain,
          oauth_domain: currentDomain,
          timestamp: new Date().toISOString()
        }
      });
      
      // The actual login form is on the OAuth domain, so update pageUrl
      pageUrl = currentUrl;
    }
    
    await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
      jobId: jobId,
      level: 'info',
      message: `🔐 LOGIN STEP 2: Successfully navigated to login page ${currentUrl}`,
      component: 'LOGIN-WORKFLOW',
      metadata: {
        login_step: 2,
        step_name: 'NAVIGATE_TO_LOGIN_PAGE',
        page_url: currentUrl,
        page_title: await page.title(),
        oauth_redirect: currentDomain !== initialDomain,
        timestamp: new Date().toISOString()
      }
    });
    
    // Step 3: Find login form using AI
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    console.log(`[LOGIN-WORKFLOW] 🔐 LOGIN STEP 3: FIND LOGIN FORM USING AI`);
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
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
    
    const findFormTemplate = await getCustomTemplate('find-login-form');
    const formAnalysis = await aiLogger.makeAICallWithPrompt(
      'find-login-form',
      {
        page_url: pageUrl,
        page_title: await page.title(),
        page_description: pageDescription || 'No description available',
        interactive_elements: interactiveElements || '[]',
        html_content: htmlContent.substring(0, 50000)
      },
      jobId,
      'login-workflow',
      pageUrl,
      null,
      null,
      findFormTemplate
    );
    
    if (!formAnalysis || !formAnalysis.form_found) {
      throw new Error('No login form found on page');
    }
    
    console.log(`[LOGIN-WORKFLOW] Form found - Username: ${formAnalysis.username_selector}, Password: ${formAnalysis.password_selector}`);
    
    await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
      jobId: jobId,
      level: 'info',
      message: `🔐 LOGIN STEP 3: Login form found successfully - Username field: ${formAnalysis.username_selector}, Password field: ${formAnalysis.password_selector}`,
      component: 'LOGIN-WORKFLOW',
      metadata: {
        login_step: 3,
        step_name: 'FIND_LOGIN_FORM_COMPLETE',
        username_selector: formAnalysis.username_selector,
        password_selector: formAnalysis.password_selector,
        submit_selector: formAnalysis.submit_selector,
        timestamp: new Date().toISOString()
      }
    });
    
    // Step 4: Fill the form
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    console.log(`[LOGIN-WORKFLOW] 🔐 LOGIN STEP 4: FILL LOGIN CREDENTIALS`);
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    
    // Extract first selector if AI returned multiple with commas, then simplify
    // Add null checks before calling split
    if (!formAnalysis.username_selector || !formAnalysis.submit_selector) {
      const errorMsg = `AI returned incomplete selectors: username="${formAnalysis.username_selector}", password="${formAnalysis.password_selector}", submit="${formAnalysis.submit_selector}". Form found: ${formAnalysis.form_found}`;
      console.error(`[LOGIN-WORKFLOW] ❌ ${errorMsg}`);
      throw new Error(errorMsg);
    }
    
    // Handle empty strings for username and submit (these are required)
    if (formAnalysis.username_selector.trim() === '' || formAnalysis.submit_selector.trim() === '') {
      const errorMsg = `AI returned empty selectors: username="${formAnalysis.username_selector}", password="${formAnalysis.password_selector}", submit="${formAnalysis.submit_selector}"`;
      console.error(`[LOGIN-WORKFLOW] ❌ ${errorMsg}`);
      throw new Error(errorMsg);
    }
    
    // Password selector can be empty for multi-step login forms (email-first)
    const isMultiStepLogin = !formAnalysis.password_selector || formAnalysis.password_selector.trim() === '';
    
    if (isMultiStepLogin) {
      console.log(`[LOGIN-WORKFLOW] 🔐 Multi-step login detected (email-first, password comes later)`);
    }
    
    let usernameSelector = formAnalysis.username_selector.split(',')[0].trim();
    let passwordSelector = formAnalysis.password_selector ? formAnalysis.password_selector.split(',')[0].trim() : '';
    let submitSelector = formAnalysis.submit_selector.split(',')[0].trim();
    
    // If selector is complex (contains spaces or attributes), try to extract just the ID or simple selector
    if (usernameSelector.includes(' ') || usernameSelector.includes('[')) {
      const match = usernameSelector.match(/#[\w-]+/);
      if (match) usernameSelector = match[0];
    }
    if (passwordSelector && (passwordSelector.includes(' ') || passwordSelector.includes('['))) {
      const match = passwordSelector.match(/#[\w-]+/);
      if (match) passwordSelector = match[0];
    }
    if (submitSelector.includes(' ') || submitSelector.includes('[')) {
      const match = submitSelector.match(/#[\w-]+/);
      if (match) {
        submitSelector = match[0];
      } else {
        // If no ID found, try simple button selector or keep as is
        submitSelector = 'button[type="submit"], #submit, button';
      }
    }
    
    console.log(`[LOGIN-WORKFLOW] Using username selector: ${usernameSelector}`);
    console.log(`[LOGIN-WORKFLOW] Using password selector: ${passwordSelector || 'N/A (multi-step)'}`);
    console.log(`[LOGIN-WORKFLOW] Using submit selector: ${submitSelector}`);
    
    await page.fill(usernameSelector, username);
    console.log(`[LOGIN-WORKFLOW] ✓ Username filled`);
    await page.waitForTimeout(500);
    
    // Only fill password if not multi-step login
    if (!isMultiStepLogin && passwordSelector) {
      await page.fill(passwordSelector, password);
      console.log(`[LOGIN-WORKFLOW] ✓ Password filled`);
      await page.waitForTimeout(500);
    } else {
      console.log(`[LOGIN-WORKFLOW] ⏭️ Skipping password (multi-step login - password field will appear after email submission)`);
    }
    
    await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
      jobId: jobId,
      level: 'info',
      message: `🔐 LOGIN STEP 4: Credentials filled successfully${isMultiStepLogin ? ' (email-only multi-step login)' : ' (username and password)'}`,
      component: 'LOGIN-WORKFLOW',
      metadata: {
        login_step: 4,
        step_name: 'FILL_CREDENTIALS_COMPLETE',
        username_filled: true,
        password_filled: !isMultiStepLogin,
        is_multi_step: isMultiStepLogin,
        timestamp: new Date().toISOString()
      }
    });
    
    // Step 5: Submit
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    console.log(`[LOGIN-WORKFLOW] 🔐 LOGIN STEP 5: SUBMIT LOGIN FORM`);
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    
    const urlBeforeSubmit = page.url();
    await page.click(submitSelector);
    console.log(`[LOGIN-WORKFLOW] ✓ Form submitted`);
    
    // Wait for navigation (important for OAuth flows)
    try {
      console.log(`[LOGIN-WORKFLOW] ⏳ Waiting for navigation...`);
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 });
      console.log(`[LOGIN-WORKFLOW] ✓ Navigation complete`);
    } catch (navError) {
      console.log(`[LOGIN-WORKFLOW] ⚠️ Navigation timeout or didn't happen: ${navError.message}`);
      // Wait a bit anyway
      await page.waitForTimeout(3000);
    }
    
    // Wait additional time for OAuth redirects to complete
    await page.waitForTimeout(2000);
    
    const urlAfterSubmit = page.url();
    console.log(`[LOGIN-WORKFLOW] URL before submit: ${urlBeforeSubmit}`);
    console.log(`[LOGIN-WORKFLOW] URL after submit: ${urlAfterSubmit}`);
    
    await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
      jobId: jobId,
      level: 'info',
      message: `🔐 LOGIN STEP 5: Login form submitted${urlBeforeSubmit !== urlAfterSubmit ? ` - redirected to ${urlAfterSubmit}` : ''}`,
      component: 'LOGIN-WORKFLOW',
      metadata: {
        login_step: 5,
        step_name: 'SUBMIT_FORM_COMPLETE',
        submit_selector: submitSelector,
        url_before_submit: urlBeforeSubmit,
        url_after_submit: urlAfterSubmit,
        navigation_occurred: urlBeforeSubmit !== urlAfterSubmit,
        timestamp: new Date().toISOString()
      }
    });
    
    // Handle multi-step login: If password field appears after email submission, fill and submit again
    if (isMultiStepLogin) {
      console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
      console.log(`[LOGIN-WORKFLOW] 🔐 LOGIN STEP 5B: HANDLE MULTI-STEP LOGIN (PASSWORD STEP)`);
      console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
      
      // Wait a bit for the password field to appear
      await page.waitForTimeout(2000);
      
      // Check if there's a password field on the page now
      const passwordFields = await page.$$('input[type="password"]');
      
      if (passwordFields.length > 0) {
        console.log(`[LOGIN-WORKFLOW] ✓ Password field detected after email submission`);
        
        // Get the password field selector
        const passwordFieldInfo = await page.evaluate(() => {
          const field = document.querySelector('input[type="password"]');
          if (field) {
            return {
              id: field.id || '',
              name: field.name || '',
              placeholder: field.placeholder || ''
            };
          }
          return null;
        });
        
        // Try to use ID, name, or fallback to type selector
        let secondPasswordSelector = 'input[type="password"]';
        if (passwordFieldInfo && passwordFieldInfo.id) {
          secondPasswordSelector = `#${passwordFieldInfo.id}`;
        } else if (passwordFieldInfo && passwordFieldInfo.name) {
          secondPasswordSelector = `input[name="${passwordFieldInfo.name}"]`;
        }
        
        console.log(`[LOGIN-WORKFLOW] Using password selector: ${secondPasswordSelector}`);
        
        // Fill password
        await page.fill(secondPasswordSelector, password);
        console.log(`[LOGIN-WORKFLOW] ✓ Password filled`);
        await page.waitForTimeout(500);
        
        // Find and click submit button
        // Look for submit buttons with different strategies
        let submitFound = false;
        let secondSubmitSelector = null;
        const buttonSelectors = [
          'button[type="submit"]',
          'input[type="submit"]',
          'button:has-text("Sign in")',
          'button:has-text("Login")',
          'button:has-text("Continue")',
          'button:has-text("Submit")'
        ];
        
        for (const selector of buttonSelectors) {
          try {
            const buttons = await page.$$(selector);
            if (buttons.length > 0) {
              const buttonInfo = await page.evaluate((button) => {
                return {
                  id: button.id || '',
                  class: button.className || '',
                  text: button.textContent?.trim() || ''
                };
              }, buttons[0]);
              
              secondSubmitSelector = selector;
              if (buttonInfo.id) {
                secondSubmitSelector = `#${buttonInfo.id}`;
              }
              
              console.log(`[LOGIN-WORKFLOW] Using submit selector: ${secondSubmitSelector}`);
              
              // Submit password form
              await page.click(secondSubmitSelector);
              console.log(`[LOGIN-WORKFLOW] ✓ Password form submitted`);
              submitFound = true;
              break;
            }
          } catch (err) {
            // Skip this selector and try next
            continue;
          }
        }
        
        if (!submitFound) {
          // Fallback: try to find any button and click it
          const allButtons = await page.$$('button');
          if (allButtons.length > 0) {
            secondSubmitSelector = 'button (fallback)';
            console.log(`[LOGIN-WORKFLOW] Using fallback: clicking first button found`);
            await allButtons[0].click();
            console.log(`[LOGIN-WORKFLOW] ✓ Password form submitted (fallback)`);
            submitFound = true;
          }
        }
        
        if (submitFound) {
          
          // Wait for navigation
          try {
            console.log(`[LOGIN-WORKFLOW] ⏳ Waiting for navigation after password submission...`);
            await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 });
            console.log(`[LOGIN-WORKFLOW] ✓ Navigation complete after password`);
          } catch (navError) {
            console.log(`[LOGIN-WORKFLOW] ⚠️ Navigation timeout after password: ${navError.message}`);
            await page.waitForTimeout(3000);
          }
          
          await page.waitForTimeout(2000);
          
          await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'info',
            message: `🔐 LOGIN STEP 5B: Multi-step password submitted successfully`,
            component: 'LOGIN-WORKFLOW',
            metadata: {
              login_step: '5B',
              step_name: 'MULTI_STEP_PASSWORD_SUBMIT_COMPLETE',
              password_selector: secondPasswordSelector,
              submit_selector: secondSubmitSelector,
              final_url: page.url(),
              timestamp: new Date().toISOString()
            }
          });
        } else {
          console.log(`[LOGIN-WORKFLOW] ⚠️ No submit button found for password step`);
        }
      } else {
        console.log(`[LOGIN-WORKFLOW] ⚠️ No password field found after email submission - assuming single-step or different flow`);
      }
    }
    
    // Step 6: Validate success (simple heuristic - URL change indicates success)
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    console.log(`[LOGIN-WORKFLOW] 🔐 LOGIN STEP 6: VALIDATE LOGIN SUCCESS`);
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    
    const finalUrl = page.url();
    const finalTitle = await page.title();
    const cookies = await page.context().cookies();
    
    // For OAuth flows, success means we're back on the original domain (not on login page)
    const originalDomain = new URL(originalLoginUrl).hostname;
    const finalDomain = new URL(finalUrl).hostname;
    const isBackOnOriginalDomain = finalDomain === originalDomain;
    const isStillOnAuthDomain = finalDomain.includes('auth.');
    const isOnLoginPage = finalUrl.includes('/login');
    
    // Collect cookies from all domains
    const cookiesByDomain = {};
    cookies.forEach(cookie => {
      const domain = cookie.domain || 'unknown';
      if (!cookiesByDomain[domain]) {
        cookiesByDomain[domain] = [];
      }
      cookiesByDomain[domain].push(cookie);
    });
    
    console.log(`[LOGIN-WORKFLOW] Cookies by domain:`, Object.keys(cookiesByDomain).map(d => `${d}: ${cookiesByDomain[d].length}`).join(', '));
    
    // Validation: Success if we have cookies and are not on login page anymore
    const hasCookies = cookies.length > 0;
    const notOnLoginPage = !isOnLoginPage;
    
    // Check for OAuth redirects - success if we have auth cookies and are on OAuth domain (not login page)
    const hasAuthCookies = cookies.some(c => 
      c.name.toLowerCase().includes('session') || 
      c.name.toLowerCase().includes('token') || 
      c.name.toLowerCase().includes('auth')
    );
    const isOAuthRedirect = !isBackOnOriginalDomain && !isStillOnAuthDomain && !isOnLoginPage && hasCookies && hasAuthCookies;
    
    // Success if: (not on login page AND has cookies) OR (OAuth redirect with auth cookies)
    const validationSuccess = (hasCookies && notOnLoginPage) || (isOAuthRedirect && hasAuthCookies);
    
    let validationReason = '';
    if (isBackOnOriginalDomain && notOnLoginPage) {
      validationReason = `Successfully authenticated on ${originalDomain} with ${cookies.length} cookies`;
    } else if (isOAuthRedirect && hasAuthCookies) {
      validationReason = `OAuth redirect successful - authenticated cookies collected, redirected to ${finalDomain} (${cookies.length} cookies)`;
    } else if (isStillOnAuthDomain && notOnLoginPage) {
      validationReason = `Still on auth domain ${finalDomain} but not on login page (${cookies.length} cookies collected)`;
    } else if (isOnLoginPage) {
      validationReason = `Still on login page at ${finalUrl} - authentication failed`;
    } else {
      validationReason = `Unknown state: ${finalUrl} (${cookies.length} cookies)`;
    }
    
    console.log(`[LOGIN-WORKFLOW] Login validation: ${validationSuccess ? 'SUCCESS' : 'FAILED'} - ${validationReason}`);
    
    await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
      jobId: jobId,
      level: validationSuccess ? 'info' : 'warn',
      message: `🔐 LOGIN STEP 6: Validation complete - ${validationSuccess ? '✅ LOGIN APPEARS SUCCESSFUL' : '⚠️ INCONCLUSIVE'} - ${validationReason}`,
      component: 'LOGIN-WORKFLOW',
      metadata: {
        login_step: 6,
        step_name: 'VALIDATE_LOGIN_COMPLETE',
        success: validationSuccess,
        reason: validationReason,
        final_url: finalUrl,
        final_title: finalTitle,
        cookies_count: cookies.length,
        cookies_by_domain: cookiesByDomain,
        original_domain: originalDomain,
        final_domain: finalDomain,
        is_back_on_original: isBackOnOriginalDomain,
        timestamp: new Date().toISOString()
      }
    });
    
    // Step 7: Print collected cookies
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    console.log(`[LOGIN-WORKFLOW] 🍪 LOGIN STEP 7: COLLECTED COOKIES`);
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    console.log(`[LOGIN-WORKFLOW] Total cookies collected: ${cookies.length}`);
    
    // Detailed cookie information
    const cookieDetails = cookies.map((cookie, index) => {
      const cookieInfo = `Cookie ${index + 1}: ${cookie.name}
  Value: ${cookie.value.substring(0, 100)}${cookie.value.length > 100 ? '...' : ''}
  Domain: ${cookie.domain || 'N/A'}
  Path: ${cookie.path || '/'}
  Expires: ${cookie.expires ? new Date(cookie.expires * 1000).toISOString() : 'Session'}
  HttpOnly: ${cookie.httpOnly || false}
  Secure: ${cookie.secure || false}
  SameSite: ${cookie.sameSite || 'N/A'}`;
      console.log(`[LOGIN-WORKFLOW] ${cookieInfo}`);
      return cookieInfo;
    }).join('\n\n');
    
    // Identify important cookies (likely authentication tokens)
    const importantCookies = cookies.filter(c => 
      c.name.toLowerCase().includes('session') || 
      c.name.toLowerCase().includes('token') || 
      c.name.toLowerCase().includes('auth') ||
      c.name.toLowerCase().includes('jwt') ||
      c.name.toLowerCase().includes('access')
    );
    
    if (importantCookies.length > 0) {
      console.log(`[LOGIN-WORKFLOW] 🔑 IMPORTANT COOKIES (likely auth tokens): ${importantCookies.map(c => c.name).join(', ')}`);
    }
    
    await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
      jobId: jobId,
      level: 'info',
      message: `🍪 LOGIN STEP 7: Collected ${cookies.length} cookies${importantCookies.length > 0 ? ` (${importantCookies.length} important auth cookies)` : ''} from ${Object.keys(cookiesByDomain).length} domain(s)`,
      component: 'LOGIN-WORKFLOW',
      metadata: {
        login_step: 7,
        step_name: 'COOKIES_COLLECTED',
        cookies_count: cookies.length,
        important_cookies_count: importantCookies.length,
        important_cookies: importantCookies.map(c => c.name),
        cookies_by_domain: cookiesByDomain,
        domains_count: Object.keys(cookiesByDomain).length,
        oauth_flow: isBackOnOriginalDomain !== undefined,
        cookies: cookies.map(c => ({ 
          name: c.name, 
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite
        })),
        timestamp: new Date().toISOString()
      }
    });
    
    // Step 8: Validate cookies with AI to check if they'll work
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    console.log(`[LOGIN-WORKFLOW] 🤖 LOGIN STEP 8: VALIDATE COOKIES WITH AI`);
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    
    let cookieValidation = { isValid: true, reason: 'Cookies will work for authentication' };
    
    if (cookies.length > 0 && aiLogger) {
      try {
        const cookieNames = cookies.map(c => c.name).join(', ');
        const cookieSummary = cookies.map(c => `${c.name} (domain: ${c.domain || 'N/A'}, ${c.httpOnly ? 'httpOnly' : ''}, ${c.secure ? 'secure' : ''})`).join('; ');
        
        cookieValidation = await aiLogger.makeAICallWithPrompt(
          'verify-workflow-leg',
          {
            leg_name: 'Cookie validation',
            leg_action: 'Check if collected cookies will work for authentication',
            expected_outcome: 'Cookies contain valid authentication tokens',
            before_url: pageUrl,
            before_title: 'Login page',
            after_url: finalUrl,
            after_title: finalTitle,
            after_visible_text: `Cookies collected: ${cookieNames}`,
            dom_snapshot: JSON.stringify({ cookies_count: cookies.length, cookie_names: cookieNames })
          },
          jobId,
          'login-workflow',
          finalUrl
        );
        
        console.log(`[LOGIN-WORKFLOW] 🤖 AI Cookie Validation: ${cookieValidation.success ? '✅ VALID' : '❌ INVALID'} - ${cookieValidation.description || cookieValidation.reason}`);
      } catch (error) {
        console.error(`[LOGIN-WORKFLOW] ❌ AI cookie validation failed: ${error.message}`);
        cookieValidation = { success: true, reason: 'Could not validate with AI, but cookies were collected' };
      }
    }
    
    await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
      jobId: jobId,
      level: cookieValidation.success ? 'info' : 'warn',
      message: `🤖 LOGIN STEP 8: Cookie validation ${cookieValidation.success ? '✅ PASSED' : '❌ FAILED'} - ${cookieValidation.description || cookieValidation.reason}`,
      component: 'LOGIN-WORKFLOW',
      metadata: {
        login_step: 8,
        step_name: 'COOKIE_VALIDATION_COMPLETE',
        cookies_valid: cookieValidation.success,
        validation_reason: cookieValidation.description || cookieValidation.reason,
        evidence: cookieValidation.evidence || [],
        timestamp: new Date().toISOString()
      }
    });
    
    // Step 9: Test login by navigating back to the site
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    console.log(`[LOGIN-WORKFLOW] 🧪 LOGIN STEP 9: TEST LOGIN BY NAVIGATING BACK`);
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    
    // Skip navigation test if OAuth redirect was successful (cookies are valid, just on different domain)
    let loginTestSuccess = false;
    let skipNavigationTest = false;
    
    console.log(`[LOGIN-WORKFLOW] Debug: isOAuthRedirect=${isOAuthRedirect}, hasAuthCookies=${hasAuthCookies}, finalUrl=${finalUrl}`);
    
    if (isOAuthRedirect && hasAuthCookies) {
      console.log(`[LOGIN-WORKFLOW] ⏭️ Skipping navigation test - OAuth redirect successful with auth cookies`);
      loginTestSuccess = true;
      skipNavigationTest = true;
      
      await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'info',
        message: `✅ LOGIN TEST SKIPPED - OAuth redirect successful, authentication cookies validated`,
        component: 'LOGIN-WORKFLOW',
        metadata: {
          login_step: 9,
          step_name: 'LOGIN_TEST_SKIPPED',
          test_passed: true,
          reason: 'OAuth redirect with valid auth cookies',
          final_url: finalUrl,
          cookies_count: cookies.length,
          timestamp: new Date().toISOString()
        }
      });
    }
    
    let maxRetries = 3;
    let retryCount = 0;
    
    while (!loginTestSuccess && retryCount < maxRetries) {
      retryCount++;
      console.log(`[LOGIN-WORKFLOW] 🧪 Test attempt ${retryCount}/${maxRetries}`);
      
      try {
        // Navigate to the original domain (not OAuth domain)
        const originalUrlObj = new URL(originalLoginUrl);
        const testUrl = `${originalUrlObj.protocol}//${originalUrlObj.hostname}/`;
        console.log(`[LOGIN-WORKFLOW] Navigating to original domain: ${testUrl}`);
        await page.goto(testUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);
        
        const testUrlAfter = page.url();
        const testTitleAfter = await page.title();
        
        // Check if we're still on the login page (bad) or somewhere else (good)
        const stillOnLoginPage = testUrlAfter.includes('/login') || testTitleAfter.toLowerCase().includes('login');
        const testDomain = new URL(testUrlAfter).hostname;
        const isBackOnOriginalDomain = testDomain === originalDomain;
        
        if (!stillOnLoginPage && isBackOnOriginalDomain) {
          loginTestSuccess = true;
          console.log(`[LOGIN-WORKFLOW] ✅ Login test PASSED - authenticated on original domain ${testUrlAfter}`);
          
          await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'info',
            message: `✅ LOGIN TEST PASSED on attempt ${retryCount} - User is authenticated on original domain`,
            component: 'LOGIN-WORKFLOW',
            metadata: {
              login_step: 9,
              step_name: 'LOGIN_TEST_COMPLETE',
              test_passed: true,
              attempt: retryCount,
              test_url: testUrlAfter,
              test_title: testTitleAfter,
              test_domain: testDomain,
              back_on_original: isBackOnOriginalDomain,
              timestamp: new Date().toISOString()
            }
          });
        } else {
          const reason = stillOnLoginPage ? 'still on login page' : `on wrong domain ${testDomain} (expected ${originalDomain})`;
          console.log(`[LOGIN-WORKFLOW] ❌ Login test FAILED - ${reason} at ${testUrlAfter}`);
          
          await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'warn',
            message: `⚠️ LOGIN TEST FAILED on attempt ${retryCount} - ${reason}`,
            component: 'LOGIN-WORKFLOW',
            metadata: {
              login_step: 9,
              step_name: 'LOGIN_TEST_FAILED',
              test_passed: false,
              attempt: retryCount,
              test_url: testUrlAfter,
              test_domain: testDomain,
              expected_domain: originalDomain,
              still_on_login: stillOnLoginPage,
              timestamp: new Date().toISOString()
            }
          });
          
          // If this is not the last attempt, wait a bit before retrying
          if (retryCount < maxRetries) {
            console.log(`[LOGIN-WORKFLOW] ⏳ Waiting 2 seconds before retry...`);
            await page.waitForTimeout(2000);
          }
        }
      } catch (error) {
        console.error(`[LOGIN-WORKFLOW] ❌ Login test error: ${error.message}`);
        
        await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
          jobId: jobId,
          level: 'error',
          message: `❌ LOGIN TEST ERROR on attempt ${retryCount}: ${error.message}`,
          component: 'LOGIN-WORKFLOW',
          metadata: {
            login_step: 9,
            step_name: 'LOGIN_TEST_ERROR',
            test_passed: false,
            attempt: retryCount,
            error: error.message,
            timestamp: new Date().toISOString()
          }
        });
      }
    }
    
    // Consider OAuth redirect successful if cookies validated
    const isOAuthSuccess = skipNavigationTest && hasAuthCookies;
    // If login test passed, consider it successful even if validation had issues (e.g., 503 during validation)
    const workflowSuccess = loginTestSuccess || isOAuthSuccess;
    
    if (workflowSuccess) {
      console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
      console.log(`[LOGIN-WORKFLOW] ✅ LOGIN WORKFLOW COMPLETED SUCCESSFULLY!`);
      console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
      
      const successMessage = isOAuthSuccess 
        ? `✅ LOGIN WORKFLOW COMPLETED SUCCESSFULLY - OAuth authentication with valid cookies (redirected to ${finalDomain})`
        : `✅ LOGIN WORKFLOW COMPLETED SUCCESSFULLY - User is now authenticated and tested`;
      
      await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'info',
        message: successMessage,
        component: 'LOGIN-WORKFLOW',
        metadata: {
          workflow_complete: true,
          success: true,
          cookies_collected: cookies.length,
          login_tested: loginTestSuccess,
          oauth_redirect: isOAuthSuccess,
          final_url: finalUrl,
          final_title: finalTitle,
          timestamp: new Date().toISOString()
        }
      });
    } else {
      console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
      console.log(`[LOGIN-WORKFLOW] ⚠️ LOGIN WORKFLOW INCONCLUSIVE`);
      console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
      
      await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'warn',
        message: `⚠️ LOGIN WORKFLOW INCONCLUSIVE - ${validationReason} (test passed: ${loginTestSuccess})`,
        component: 'LOGIN-WORKFLOW',
        metadata: {
          workflow_complete: true,
          success: loginTestSuccess,
          reason: validationReason,
          login_tested: true,
          test_passed: loginTestSuccess,
          final_url: finalUrl,
          final_title: finalTitle,
          timestamp: new Date().toISOString()
        }
      });
    }
    
    return {
      success: workflowSuccess, // Include OAuth success
      finalUrl: finalUrl,
      finalTitle: finalTitle,
      reason: validationReason,
      cookies: cookies,
      cookieValidation: cookieValidation,
      loginTestPassed: loginTestSuccess,
      oauthRedirect: isOAuthSuccess,
      attempts: retryCount
    };
    
  } catch (error) {
    console.error(`[LOGIN-WORKFLOW] Login failed: ${error.message}`);
    return {
      success: false,
      error: error.message,
      finalUrl: page.url(),
      finalTitle: await page.title().catch(() => 'Unknown')
    };
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

