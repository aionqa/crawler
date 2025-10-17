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

    const response = await aiLogger.makeAICallWithPrompt(
      'find-login-form',
      {
        page_url: pageUrl,
        page_title: await page.title(),
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
          const wrappedCode = `(async function() { ${playwrightCode} })()`;
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

      // Get localStorage
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        tokens.localStorage[key] = localStorage.getItem(key);
      }

      // Get sessionStorage
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        tokens.sessionStorage[key] = sessionStorage.getItem(key);
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
        const wrappedCode = `(async function() { ${playwrightCode} })()`;
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
        const authTokens = await page.evaluate(() => {
          const tokens = {
            localStorage: {},
            sessionStorage: {}
          };
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            tokens.localStorage[key] = localStorage.getItem(key);
          }
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            tokens.sessionStorage[key] = sessionStorage.getItem(key);
          }
          return tokens;
        });
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
    
    // Load workflow template if provided
    let workflowTemplate = null;
    if (workflowTemplateId) {
      try {
        const axios = (await import('axios')).default;
        const response = await axios.get(`${BACKEND_URL}/api/workflow-templates/${workflowTemplateId}`);
        workflowTemplate = response.data;
        console.log(`[LOGIN-WORKFLOW] ✅ Loaded workflow template: "${workflowTemplate.name}" (ID: ${workflowTemplateId})`);
        console.log(`[LOGIN-WORKFLOW] 📄 Template contains ${workflowTemplate.prompts?.length || 0} custom prompts`);
        
        // Log workflow decision to job history
        await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
          jobId: jobId,
          level: 'info',
          message: `🔄 WORKFLOW DECISION: Using workflow template "${workflowTemplate.name}"`,
          component: 'LOGIN-WORKFLOW',
          metadata: {
            workflow_decision: true,
            decision: `Using workflow template: ${workflowTemplate.name}`,
            details: `Template ID: ${workflowTemplateId}, Prompts: ${workflowTemplate.prompts?.length || 0}`,
            template_id: workflowTemplateId,
            template_name: workflowTemplate.name,
            timestamp: new Date().toISOString()
          }
        });
      } catch (error) {
        console.warn(`[LOGIN-WORKFLOW] ⚠️ Failed to load workflow template, using default prompts: ${error.message}`);
        
        // Log fallback to defaults
        try {
          const axios = (await import('axios')).default;
          await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'info',
            message: `🔄 WORKFLOW DECISION: Using default prompts (template load failed)`,
            component: 'LOGIN-WORKFLOW',
            metadata: {
              workflow_decision: true,
              decision: 'Using default prompts',
              details: `Template load failed: ${error.message}`,
              template_id: null,
              template_name: 'Default Prompts',
              timestamp: new Date().toISOString()
            }
          });
        } catch (logError) {
          console.error(`[LOGIN-WORKFLOW] Error logging workflow decision: ${logError.message}`);
        }
      }
    } else {
      console.log(`[LOGIN-WORKFLOW] 📋 No workflow template specified, using default prompts from database`);
      
      // Log default prompts usage
      try {
        const axios = (await import('axios')).default;
        await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
          jobId: jobId,
          level: 'info',
          message: `🔄 WORKFLOW DECISION: Using default prompts from database`,
          component: 'LOGIN-WORKFLOW',
          metadata: {
            workflow_decision: true,
            decision: 'Using default prompts',
            details: 'No workflow template ID provided',
            template_id: null,
            template_name: 'Default Prompts',
            timestamp: new Date().toISOString()
          }
        });
      } catch (logError) {
        console.error(`[LOGIN-WORKFLOW] Error logging workflow decision: ${logError.message}`);
      }
    }
    
    // Helper to get custom template with logging
    const getCustomTemplate = async (promptName) => {
      if (!workflowTemplate || !workflowTemplate.prompts) {
        console.log(`[LOGIN-WORKFLOW] 📋 Using DEFAULT prompt from database: "${promptName}"`);
        return null;
      }
      
      const prompt = workflowTemplate.prompts.find(p => p.name === promptName);
      if (prompt && prompt.template) {
        console.log(`[LOGIN-WORKFLOW] ✅ Using CUSTOM prompt from workflow template: "${promptName}"`);
        console.log(`[LOGIN-WORKFLOW] 📝 Prompt text: ${prompt.template.substring(0, 100)}...`);
        
        // Log prompt usage
        try {
          const axios = (await import('axios')).default;
          await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'info',
            message: `📝 PROMPT USAGE: "${promptName}" from workflow-template`,
            component: 'LOGIN-WORKFLOW',
            metadata: {
              prompt_usage: true,
              prompt_name: promptName,
              prompt_source: 'workflow-template',
              prompt_text_preview: prompt.template.substring(0, 200),
              workflow_template_id: workflowTemplateId,
              workflow_template_name: workflowTemplate.name,
              timestamp: new Date().toISOString()
            }
          });
        } catch (logError) {
          console.error(`[LOGIN-WORKFLOW] Error logging prompt usage: ${logError.message}`);
        }
        
        return prompt.template;
      } else {
        console.log(`[LOGIN-WORKFLOW] 📋 Prompt "${promptName}" not found in template, using DEFAULT from database`);
        
        // Log default usage
        try {
          const axios = (await import('axios')).default;
          await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'info',
            message: `📝 PROMPT USAGE: "${promptName}" from database (not in template)`,
            component: 'LOGIN-WORKFLOW',
            metadata: {
              prompt_usage: true,
              prompt_name: promptName,
              prompt_source: 'database',
              prompt_text_preview: 'Default from database',
              workflow_template_id: workflowTemplateId,
              workflow_template_name: workflowTemplate.name,
              timestamp: new Date().toISOString()
            }
          });
        } catch (logError) {
          console.error(`[LOGIN-WORKFLOW] Error logging prompt usage: ${logError.message}`);
        }
        
        return null;
      }
    };
    
    // Navigate to login page
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    console.log(`[LOGIN-WORKFLOW] 🔐 LOGIN STEP 2: NAVIGATE TO LOGIN PAGE`);
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 30000 });
    console.log(`[LOGIN-WORKFLOW] Navigated to login page`);
    
    await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
      jobId: jobId,
      level: 'info',
      message: `🔐 LOGIN STEP 2: Successfully navigated to login page ${pageUrl}`,
      component: 'LOGIN-WORKFLOW',
      metadata: {
        login_step: 2,
        step_name: 'NAVIGATE_TO_LOGIN_PAGE',
        page_url: pageUrl,
        page_title: await page.title(),
        timestamp: new Date().toISOString()
      }
    });
    
    // Step 3: Find login form using AI
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    console.log(`[LOGIN-WORKFLOW] 🔐 LOGIN STEP 3: FIND LOGIN FORM USING AI`);
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    const htmlContent = await page.content();
    
    const findFormTemplate = await getCustomTemplate('find-login-form');
    const formAnalysis = await aiLogger.makeAICallWithPrompt(
      'find-login-form',
      {
        page_url: pageUrl,
        page_title: await page.title(),
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
    let usernameSelector = formAnalysis.username_selector.split(',')[0].trim();
    let passwordSelector = formAnalysis.password_selector.split(',')[0].trim();
    let submitSelector = formAnalysis.submit_selector.split(',')[0].trim();
    
    // If selector is complex (contains spaces or attributes), try to extract just the ID or simple selector
    if (usernameSelector.includes(' ') || usernameSelector.includes('[')) {
      const match = usernameSelector.match(/#[\w-]+/);
      if (match) usernameSelector = match[0];
    }
    if (passwordSelector.includes(' ') || passwordSelector.includes('[')) {
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
    console.log(`[LOGIN-WORKFLOW] Using password selector: ${passwordSelector}`);
    console.log(`[LOGIN-WORKFLOW] Using submit selector: ${submitSelector}`);
    
    await page.fill(usernameSelector, username);
    console.log(`[LOGIN-WORKFLOW] ✓ Username filled`);
    await page.waitForTimeout(500);
    await page.fill(passwordSelector, password);
    console.log(`[LOGIN-WORKFLOW] ✓ Password filled`);
    await page.waitForTimeout(500);
    
    await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
      jobId: jobId,
      level: 'info',
      message: `🔐 LOGIN STEP 4: Credentials filled successfully (username and password)`,
      component: 'LOGIN-WORKFLOW',
      metadata: {
        login_step: 4,
        step_name: 'FILL_CREDENTIALS_COMPLETE',
        username_filled: true,
        password_filled: true,
        timestamp: new Date().toISOString()
      }
    });
    
    // Step 5: Submit
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    console.log(`[LOGIN-WORKFLOW] 🔐 LOGIN STEP 5: SUBMIT LOGIN FORM`);
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    
    await page.click(submitSelector);
    console.log(`[LOGIN-WORKFLOW] ✓ Form submitted`);
    await page.waitForTimeout(3000); // Wait for login response
    
    await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
      jobId: jobId,
      level: 'info',
      message: `🔐 LOGIN STEP 5: Login form submitted successfully`,
      component: 'LOGIN-WORKFLOW',
      metadata: {
        login_step: 5,
        step_name: 'SUBMIT_FORM_COMPLETE',
        submit_selector: submitSelector,
        timestamp: new Date().toISOString()
      }
    });
    
    // Step 6: Validate success using AI
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    console.log(`[LOGIN-WORKFLOW] 🔐 LOGIN STEP 6: VALIDATE LOGIN SUCCESS WITH AI`);
    console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
    const screenshotAfter = await page.screenshot({ fullPage: true, type: 'png' });
    const htmlAfter = await page.content();
    
    const validateTemplate = await getCustomTemplate('validate-login-success');
    const validationResult = await aiLogger.makeAICallWithPrompt(
      'validate-login-success',
      {
        page_url: page.url(),
        page_title: await page.title(),
        html_after_login: htmlAfter.substring(0, 50000)
      },
      jobId,
      'login-workflow',
      page.url(),
      null,
      null,
      validateTemplate
    );
    
    console.log(`[LOGIN-WORKFLOW] Login validation: ${validationResult.success ? 'SUCCESS' : 'FAILED'} - ${validationResult.reason}`);
    
    await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
      jobId: jobId,
      level: validationResult.success ? 'info' : 'error',
      message: `🔐 LOGIN STEP 6: Validation complete - ${validationResult.success ? '✅ LOGIN SUCCESSFUL' : '❌ LOGIN FAILED'} - ${validationResult.reason}`,
      component: 'LOGIN-WORKFLOW',
      metadata: {
        login_step: 6,
        step_name: 'VALIDATE_LOGIN_COMPLETE',
        success: validationResult.success,
        reason: validationResult.reason,
        evidence: validationResult.evidence,
        final_url: page.url(),
        final_title: await page.title(),
        timestamp: new Date().toISOString()
      }
    });
    
    if (validationResult.success) {
      console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
      console.log(`[LOGIN-WORKFLOW] ✅ LOGIN WORKFLOW COMPLETED SUCCESSFULLY!`);
      console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
      
      await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'info',
        message: `✅ LOGIN WORKFLOW COMPLETED SUCCESSFULLY - User is now authenticated`,
        component: 'LOGIN-WORKFLOW',
        metadata: {
          workflow_complete: true,
          success: true,
          final_url: page.url(),
          final_title: await page.title(),
          timestamp: new Date().toISOString()
        }
      });
    } else {
      console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
      console.log(`[LOGIN-WORKFLOW] ❌ LOGIN WORKFLOW FAILED`);
      console.log(`[LOGIN-WORKFLOW] ═══════════════════════════════════════════════════════`);
      
      await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'error',
        message: `❌ LOGIN WORKFLOW FAILED - ${validationResult.reason}`,
        component: 'LOGIN-WORKFLOW',
        metadata: {
          workflow_complete: true,
          success: false,
          reason: validationResult.reason,
          final_url: page.url(),
          final_title: await page.title(),
          timestamp: new Date().toISOString()
        }
      });
    }
    
    return {
      success: validationResult.success,
      finalUrl: page.url(),
      finalTitle: await page.title(),
      reason: validationResult.reason,
      evidence: validationResult.evidence
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

