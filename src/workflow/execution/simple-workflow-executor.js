import axios from 'axios';
import fetch from 'node-fetch';
import { analyzePageWithLighthouse } from '../../lighthouse-analyzer.js';

/**
 * SimpleWorkflowExecutor
 * Simplified workflow executor that works with the current workflow template structure
 * Handles execution of workflow steps with basic retry logic
 */
class SimpleWorkflowExecutor {
  constructor(backendUrl, aiLogger, backendLogger, context = {}) {
    this.backendUrl = backendUrl;
    this.aiLogger = aiLogger;
    this.backendLogger = backendLogger;
    this.context = context;
    this.workflowTemplate = null;
  }

  /**
   * Send log to backend
   */
  async sendLog(level, message, metadata = {}) {
    try {
      const jobId = this.context.jobId || this.context.job_id;
      console.log(`[SimpleWorkflowExecutor] 📤 Sending log: ${message}`);
      console.log(`[SimpleWorkflowExecutor] 📤 Job ID: ${jobId}`);
      
      const response = await fetch(`${this.backendUrl}/api/logs/jobs/append`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: jobId,
          level: level,
          message: message,
          metadata: metadata
        })
      });
      
      if (!response.ok) {
        console.error(`[SimpleWorkflowExecutor] Failed to send log: ${response.status}`);
      } else {
        console.log(`[SimpleWorkflowExecutor] ✅ Log sent successfully`);
      }
    } catch (error) {
      console.error(`[SimpleWorkflowExecutor] Error sending log:`, error.message);
    }
  }

  /**
   * Execute a workflow
   */
  async executeWorkflow(page, jobId, workflowId) {
    console.log(`[SimpleWorkflowExecutor] Executing workflow: ${workflowId}`);
    console.log(`[SimpleWorkflowExecutor] 🔍 About to call sendLog for workflow start`);
    await this.sendLog('info', `🔄 Starting workflow execution: ${workflowId}`);
    console.log(`[SimpleWorkflowExecutor] 🔍 sendLog called for workflow start`);

    // Get workflow template
    const workflow = await this.getWorkflow(workflowId);
    
    if (!workflow || !workflow.steps) {
      throw new Error('Workflow not found or has no steps');
    }

    console.log(`[SimpleWorkflowExecutor] Found workflow with ${workflow.steps.length} steps`);
    await this.sendLog('info', `📋 Workflow loaded: ${workflow.name} with ${workflow.steps.length} steps`);

    const results = [];

    // Execute each step sequentially
    for (const step of workflow.steps) {
      console.log(`[SimpleWorkflowExecutor] Executing step: ${step.id} - ${step.name}`);
      await this.sendLog('info', `🔄 WORKFLOW STEP ${step.order || '?'}: Starting "${step.name}" (${step.type})`);
      
      try {
        const result = await this.executeStep(page, jobId, workflowId, step);
        results.push(result);
        
        if (result.success) {
          await this.sendLog('info', `✅ WORKFLOW STEP ${step.order || '?'}: Completed "${step.name}" (${step.type})`);
        } else {
          await this.sendLog('warn', `⚠️ WORKFLOW STEP ${step.order || '?'}: Failed "${step.name}" (${step.type}) - ${result.error}`);
        }
        
        // If step failed and doesn't allow continuing on error, stop
        if (!result.success && !step.continueOnError) {
          console.log(`[SimpleWorkflowExecutor] Step ${step.id} failed and doesn't allow continuing, stopping workflow`);
          await this.sendLog('error', `❌ WORKFLOW STEP ${step.order || '?'}: Stopping workflow due to failure in "${step.name}"`);
          break;
        }
      } catch (error) {
        console.error(`[SimpleWorkflowExecutor] Error executing step ${step.id}:`, error.message);
        await this.sendLog('error', `❌ WORKFLOW STEP ${step.order || '?'}: Error in "${step.name}" - ${error.message}`);
        
        results.push({
          step_id: step.id,
          success: false,
          error: error.message
        });
        
        // If step doesn't allow continuing on error, stop
        if (!step.continueOnError) {
          console.log(`[SimpleWorkflowExecutor] Step ${step.id} failed and doesn't allow continuing, stopping workflow`);
          await this.sendLog('error', `❌ WORKFLOW STEP ${step.order || '?'}: Stopping workflow due to error in "${step.name}"`);
          break;
        }
      }
    }

    // Determine overall success
    const success = results.every(r => r.success);
    const lastError = results.find(r => !r.success)?.error;

    return {
      workflow_id: workflowId,
      success: success,
      error: lastError,
      results: results
    };
  }

  /**
   * Execute a single step
   */
  async executeStep(page, jobId, workflowId, step) {
    console.log(`[SimpleWorkflowExecutor] Executing step: ${step.id} - ${step.name} (${step.type})`);

    try {
      let result = null;

      switch (step.type) {
        case 'playwright-analysis':
          result = await this.executePlaywrightAnalysis(page, step);
          break;
        case 'screenshot':
          result = await this.executeScreenshot(page, step);
          break;
        case 'unlighthouse':
          result = await this.executeUnlighthouse(page, step);
          break;
        case 'ai-request':
          result = await this.executeAiRequest(page, step);
          break;
        case 'log-to-history':
          result = await this.executeLogToHistory(page, step);
          break;
        case 'execute-code':
          result = await this.executeCode(page, step);
          break;
        case 'validate-response':
          result = await this.executeValidateResponse(page, step);
          break;
        default:
          throw new Error(`Unknown step type: ${step.type}`);
      }

      return {
        step_id: step.id,
        success: true,
        result: result
      };
    } catch (error) {
      console.error(`[SimpleWorkflowExecutor] Error executing step ${step.id}:`, error.message);
      return {
        step_id: step.id,
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Execute playwright analysis step
   */
  async executePlaywrightAnalysis(page, step) {
    const config = step.config || {};
    const result = {};

    if (config.collectForms) {
      const forms = await page.$$('form');
      result.forms = forms.length;
    }

    if (config.collectLinks) {
      const links = await page.$$('a');
      result.links = links.length;
    }

    if (config.collectInteractiveElements) {
      const interactiveElements = await page.$$('input, button, select, textarea');
      if (config.onlyVisibleInteractiveElements === true) {
        let visibleCount = 0;
        for (const element of interactiveElements) {
          try {
            if (await element.isVisible()) {
              visibleCount += 1;
            }
          } catch (visibilityError) {
            console.warn('[SimpleWorkflowExecutor] Unable to determine element visibility:', visibilityError.message);
            visibleCount += 1;
          }
        }
        result.interactiveElements = visibleCount;
      } else {
        // Default: include all interactive elements (including hidden)
        result.interactiveElements = interactiveElements.length;
      }
    }

    if (config.collectDOM) {
      result.dom = await page.content();
    }

    if (config.collectShortenedDOM) {
      const body = await page.$('body');
      if (body) {
        result.shortenedDOM = await body.innerHTML();
      }
    }

    if (config.collectHTML) {
      result.html = await page.content();
    }

    if (config.collectScreenshots) {
      const screenshot = await page.screenshot({ fullPage: true });
      result.screenshot = screenshot.toString('base64');
    }

    return result;
  }

  /**
   * Execute screenshot step
   */
  async executeScreenshot(page, step) {
    const config = step.config || {};
    const screenshot = await page.screenshot({ 
      fullPage: config.fullPage !== false
    });
    
    return {
      screenshot: screenshot.toString('base64'),
      fullPage: config.fullPage !== false
    };
  }

  async executeUnlighthouse(page, step) {
    const jobId = this.context.jobId || this.context.job_id || 'unknown-job';
    const config = step.config || {};
    const categories = Array.isArray(config.categories) && config.categories.length > 0
      ? config.categories
      : ['performance', 'accessibility', 'best-practices', 'seo'];
    const device = typeof config.device === 'string' ? config.device : 'desktop';
    const saveReport = config.saveReport !== false;
    const pageUrl = page.url();

    await this.sendLog('info', `📊 Running Unlighthouse audit (${device})`, {
      step_type: step.type,
      categories,
      device,
      saveReport
    });

    const analysisResult = await analyzePageWithLighthouse(page, jobId, pageUrl, {
      categories,
      device,
      saveReport
    });

    if (analysisResult.success) {
      await this.sendLog('info', `✅ Unlighthouse audit complete (performance ${analysisResult.metrics?.performance ?? 'n/a'}/100)`, {
        categories,
        device,
        metrics: analysisResult.metrics,
        analysis_duration_ms: analysisResult.analysisDuration
      });
    } else {
      await this.sendLog('warn', `⚠️ Unlighthouse audit failed: ${analysisResult.error}`, {
        categories,
        device,
        error: analysisResult.error
      });
    }

    return analysisResult;
  }

  /**
   * Execute AI request step
   */
  async executeAiRequest(page, step) {
    const config = step.config || {};
    const prompt = config.prompt || '';

    console.log(`[SimpleWorkflowExecutor] 🤖 Making OpenAI request for step: ${step.name}`);
    console.log(`[SimpleWorkflowExecutor] Prompt: ${prompt.substring(0, 200)}...`);
    await this.sendLog('info', `🤖 AI REQUEST: Starting "${step.name}" - Analyzing page for login strategy`);
    
    try {
      // Import aiConversationLogger
      const { aiConversationLogger } = await import('../../../shared/ai-conversation-logger.js');
      
      // Get OpenAI API key from environment
      const openaiApiKey = process.env.OPENAI_API_KEY;
      if (!openaiApiKey) {
        throw new Error('OPENAI_API_KEY environment variable is required');
      }
      
      // Use configured endpoint if available
      const { createOpenAIClient } = await import('../../openai-client-factory.js');
      const openaiClient = createOpenAIClient(this.context, openaiApiKey);
      
      // Get current page context
      const pageUrl = page.url();
      const pageTitle = await page.title();
      
      // Take screenshot for AI analysis
      const screenshot = await page.screenshot({ type: 'png', fullPage: true });
      const screenshotBase64 = screenshot.toString('base64');
      
      // Get page elements for context
      const elements = await page.$$eval('form, input, button, a, select, textarea', elements => 
        elements.map(el => ({
          tag: el.tagName.toLowerCase(),
          type: el.type || null,
          id: el.id || null,
          name: el.name || null,
          placeholder: el.placeholder || null,
          text: el.textContent?.trim().substring(0, 100) || null,
          selector: el.id ? `#${el.id}` : el.name ? `[name="${el.name}"]` : el.tagName.toLowerCase()
        }))
      );
      
      // Create enhanced prompt with page context
      const enhancedPrompt = `${prompt}

PAGE CONTEXT:
- URL: ${pageUrl}
- Title: ${pageTitle}
- Interactive Elements Found: ${elements.length}
- Elements: ${JSON.stringify(elements, null, 2)}

Please analyze this login page and provide a detailed response in JSON format.`;

      // Make OpenAI request using the new method
      const completion = await aiConversationLogger.makeAICallWithPrompt(
        'workflow_ai_request', // promptSlug
        {
          prompt: enhancedPrompt,
          screenshot_base64: screenshotBase64,
          page_url: pageUrl,
          page_title: pageTitle,
          elements: elements,
          elements_count: elements.length,
          has_forms: elements.some(el => el.tag === 'form'),
          has_inputs: elements.some(el => el.tag === 'input'),
          has_buttons: elements.some(el => el.tag === 'button'),
          step_name: step.name,
          step_id: step.id
        },
        (this.context.jobId || this.context.job_id),
        'unified-crawler',
        pageUrl,
        null, // screenshotId
        {
          step_name: step.name,
          step_id: step.id,
          elements_count: elements.length,
          has_forms: elements.some(el => el.tag === 'form'),
          has_inputs: elements.some(el => el.tag === 'input'),
          has_buttons: elements.some(el => el.tag === 'button')
        },
        enhancedPrompt // customTemplate
      );
      
      // The new method returns the parsed response directly
      console.log(`[SimpleWorkflowExecutor] 🔍 Full completion object:`, JSON.stringify(completion, null, 2));
      
      // Extract the response from the completion object
      let aiResponse;
      if (completion.content) {
        aiResponse = completion.content;
      } else if (completion.response) {
        aiResponse = completion.response;
      } else if (completion.choices && completion.choices[0] && completion.choices[0].message) {
        aiResponse = completion.choices[0].message.content;
      } else if (typeof completion === 'string') {
        aiResponse = completion;
      } else {
        // If completion is already a parsed object, use it directly
        aiResponse = completion;
      }
      
      console.log(`[SimpleWorkflowExecutor] ✅ OpenAI response received: ${typeof aiResponse === 'string' ? aiResponse.substring(0, 200) : JSON.stringify(aiResponse).substring(0, 200)}...`);
      console.log(`[SimpleWorkflowExecutor] 🔍 Response type: ${typeof aiResponse}, length: ${typeof aiResponse === 'string' ? aiResponse.length : 'N/A'}`);
      await this.sendLog('info', `✅ AI REQUEST: OpenAI response received (${typeof aiResponse === 'string' ? aiResponse.length : 'object'} chars)`);
      
      // Parse the response
      let parsedResponse;
      try {
        if (typeof aiResponse === 'string') {
          if (aiResponse.trim() === '') {
            throw new Error('Empty response received from AI');
          }
          parsedResponse = JSON.parse(aiResponse);
        } else if (typeof aiResponse === 'object' && aiResponse !== null) {
          parsedResponse = aiResponse;
        } else {
          throw new Error(`Unexpected response type: ${typeof aiResponse}`);
        }
      } catch (parseError) {
        console.error(`[SimpleWorkflowExecutor] ❌ Failed to parse OpenAI response:`, parseError);
        console.error(`[SimpleWorkflowExecutor] ❌ Raw response:`, aiResponse);
        console.error(`[SimpleWorkflowExecutor] ❌ Completion object:`, completion);
        throw new Error(`Failed to parse OpenAI response: ${parseError.message}`);
      }
      
      // Store the AI analysis in context for use by subsequent steps
      this.context.aiAnalysis = parsedResponse;
      
      return {
        prompt: prompt,
        response: aiResponse,
        parsedResponse: parsedResponse,
        inputPlaceholders: config.inputPlaceholders || {},
        outputSchema: config.outputSchema || {},
        elements: elements,
        pageUrl: pageUrl,
        pageTitle: pageTitle
      };
      
    } catch (error) {
      console.error(`[SimpleWorkflowExecutor] ❌ OpenAI request failed:`, error);
      throw new Error(`AI request failed: ${error.message}`);
    }
  }

  /**
   * Execute log to history step
   */
  async executeLogToHistory(page, step) {
    const config = step.config || {};
    const message = config.message || 'Step completed';
    const level = config.level || 'info';
    
    console.log(`[SimpleWorkflowExecutor] Log: [${level}] ${message}`);
    
    return {
      message: message,
      level: level,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Execute code step
   */
  async executeCode(page, step) {
    const config = step.config || {};
    let code = config.code || '';

    if (!code) {
      throw new Error('No code provided for execute-code step');
    }

    await this.sendLog('info', `🔧 CODE EXECUTION: Starting "${step.name}"`);

    // Special handling: robust cookie clearing regardless of user code
    if ((step.name || '').toLowerCase().includes('clear all cookies')) {
      try {
        const ctx = page.context();
        const all = await ctx.cookies();
        if (all && all.length) {
          const deletions = all.map(c => ({
            name: c.name,
            value: '',
            domain: c.domain,
            path: c.path || '/',
            expires: 0,
            httpOnly: !!c.httpOnly,
            secure: !!c.secure,
            sameSite: c.sameSite || 'Lax'
          }));
          await ctx.addCookies(deletions);
        }
        await this.sendLog('info', `🧹 Cookies cleared: ${all ? all.length : 0}`);
        return { cleared: all ? all.length : 0 };
      } catch (e) {
        await this.sendLog('error', `Failed to clear cookies: ${e.message}`);
        throw e;
      }
    }

    // If this is an AI-guided login step, use the AI analysis
    if (step.name && step.name.includes('AI-Guided') && this.context.aiAnalysis) {
      console.log(`[SimpleWorkflowExecutor] 🤖 Using AI analysis for login execution`);
      console.log(`[SimpleWorkflowExecutor] AI Analysis:`, JSON.stringify(this.context.aiAnalysis, null, 2));
      await this.sendLog('info', `🤖 CODE EXECUTION: Using AI analysis for login - ${this.context.aiAnalysis.loginType} (confidence: ${this.context.aiAnalysis.confidence})`);
      
      // Generate code based on AI analysis
      const aiAnalysis = this.context.aiAnalysis;

      // Sanitize selector strings coming from AI (remove annotations, parentheses, line breaks)
      const sanitizeSelector = (sel) => {
        if (!sel) return sel;
        let s = String(sel);
        s = s.replace(/\n/g, ' ');
        s = s.replace(/\([^)]*\)/g, ''); // remove parenthetical notes
        s = s.replace(/\s{2,}/g, ' ').trim();
        return s;
      };

      // CRITICAL: No static fallbacks - AI must provide selectors
      const emailSelector = sanitizeSelector(aiAnalysis.emailSelector);
      const passwordSelector = sanitizeSelector(aiAnalysis.passwordSelector);
      const submitSelector = sanitizeSelector(aiAnalysis.submitSelector);
      
      if (!emailSelector || !passwordSelector || !submitSelector) {
        throw new Error('AI analysis must provide emailSelector, passwordSelector, and submitSelector. Cannot use static fallbacks.');
      }
      
      // Determine OAuth from AI analysis or context, not URL patterns
      const isOAuth = aiAnalysis.isOAuth || false;
      
      console.log(`[SimpleWorkflowExecutor] Generated selectors: email=${emailSelector}, password=${passwordSelector}, submit=${submitSelector}, isOAuth=${isOAuth}`);
      
      // Escape selectors for template string
      const escapedEmailSelector = emailSelector.replace(/'/g, "\\'");
      const escapedPasswordSelector = passwordSelector.replace(/'/g, "\\'");
      const escapedSubmitSelector = submitSelector.replace(/'/g, "\\'");
      
      // Generate dynamic code based on AI analysis
      code = `
        console.log('🤖 Executing AI-guided login based on analysis...');
        console.log('AI Analysis:', ${JSON.stringify(aiAnalysis)});
        
        const emailSelector = '${escapedEmailSelector}';
        const passwordSelector = '${escapedPasswordSelector}';
        let submitSelector = '${escapedSubmitSelector}';
        const isOAuth = ${isOAuth};
        
        console.log('Using selectors:', { emailSelector, passwordSelector, submitSelector, isOAuth });
        
        if (isOAuth) {
          console.log('Handling OAuth login flow');
          
          // Step 1: Fill email field
          const emailField = await page.$(emailSelector);
          if (emailField) {
            await emailField.fill('test@example.com');
            console.log('✅ Filled email field');
          } else {
            throw new Error('Email field not found with selector: ' + emailSelector);
          }
          
          // Step 2: Click continue/submit button
          // Use AI-provided selector only - no static fallbacks
          const submitButton = await page.$(submitSelector);
          if (submitButton) {
            await submitButton.click();
            console.log('✅ Clicked submit button');
            
            // Wait for page to load
            await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {
              console.warn('Page DOM not fully loaded after 30s, continuing anyway');
            });
            await page.waitForTimeout(3000);
            
            // Step 3: Check if password field appears
            const passwordField = await page.$(passwordSelector);
            if (passwordField) {
              console.log('Password field found, filling it');
              await passwordField.fill('testpassword');
              
              // Use AI-provided submit selector - no static fallbacks
              const finalSubmit = await page.$(submitSelector);
              if (finalSubmit) {
                await finalSubmit.click();
                console.log('✅ Clicked final submit button');
                await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {
              console.warn('Page DOM not fully loaded after 30s, continuing anyway');
            });
                await page.waitForTimeout(3000);
              }
            } else {
              console.log('No password field found, might be magic link login');
            }
          } else {
            throw new Error('Submit button not found with selector: ' + submitSelector);
          }
        } else {
          console.log('Handling regular form login');
          
          // Regular form login
          // Use AI-provided selectors only - no static fallbacks
          const emailField = await page.$(emailSelector);
          const passwordField = await page.$(passwordSelector);
          const submitButton = await page.$(submitSelector);
          
          if (emailField) {
            await emailField.fill('test@example.com');
            console.log('✅ Filled email field');
          }
          
          if (passwordField) {
            await passwordField.fill('testpassword');
            console.log('✅ Filled password field');
          }
          
          if (submitButton) {
            await submitButton.click();
            console.log('✅ Clicked submit button');
            await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {
              console.warn('Page DOM not fully loaded after 30s, continuing anyway');
            });
            await page.waitForTimeout(3000);
          }
        }
        
        console.log('✅ AI-guided login execution completed');
        return { success: true, finalUrl: page.url() };
      `;
    }

    console.log(`[SimpleWorkflowExecutor] 🔧 Executing code for step: ${step.name}`);
    console.log(`[SimpleWorkflowExecutor] Code preview: ${code.substring(0, 200)}...`);

    // Always execute step code in Node.js context with page + real BrowserContext
    // Provide three args: page (Playwright Page), context (Playwright BrowserContext), jobContext (runner/job context)
    // Inject shims (e.g., clearCookies fallback) before user code
    const prelude = `
      // Helper to clear all cookies for this BrowserContext
      async function __clearAllCookies(ctx) {
        if (typeof ctx.cookies !== 'function' || typeof ctx.addCookies !== 'function') return;
        const all = await ctx.cookies();
        if (!all || all.length === 0) return;
        const deletions = all.map(c => ({
          name: c.name,
          value: '',
          domain: c.domain,
          path: c.path || '/',
          expires: 0,
          httpOnly: !!c.httpOnly,
          secure: !!c.secure,
          sameSite: c.sameSite || 'Lax'
        }));
        await ctx.addCookies(deletions);
      }
    `;
    // Rewrite legacy calls to context.clearCookies() into our helper (tolerate whitespace)
    const rewritten = code
      .replace(/context\s*\.\s*clearCookies\s*\(\s*\)/g, '__clearAllCookies(context)')
      .replace(/await\s+context\s*\.\s*clearCookies\s*\(\s*\)\s*;/g, 'await __clearAllCookies(context);');
    const finalCode = `${prelude}\n${rewritten}`;
    const runStep = new Function('page', 'context', 'jobContext', `return (async () => {\n${finalCode}\n})()`);
    const result = await runStep(page, page.context(), this.context);
    
    // If step performed navigation, log the final URL for UI visibility
    if (code.includes('page.goto(')) {
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
        const currentUrl = page.url();
        await this.sendLog('info', `🌐 Navigated to: ${currentUrl}`);
      } catch (e) {
        await this.sendLog('warn', `🌐 Navigation log failed: ${e.message}`);
      }
    }

    return {
      code: code,
      result: result
    };
    
    // If this is a cookie collection step, also collect cookies from the browser context
    if (code.includes('cookies') || code.includes('localStorage') || code.includes('sessionStorage')) {
      try {
        const context = page.context();
        const cookies = await context.cookies();
        
        // Get localStorage and sessionStorage with error handling
        let localStorage = {};
        let sessionStorage = {};
        
        try {
          localStorage = await page.evaluate(() => {
            try {
              const storage = {};
              for (let i = 0; i < window.localStorage.length; i++) {
                const key = window.localStorage.key(i);
                storage[key] = window.localStorage.getItem(key);
              }
              return storage;
            } catch (e) {
              console.log('localStorage access denied:', e.message);
              return {};
            }
          });
        } catch (error) {
          console.log('[SimpleWorkflowExecutor] localStorage access denied:', error.message);
        }

        try {
          sessionStorage = await page.evaluate(() => {
            try {
              const storage = {};
              for (let i = 0; i < window.sessionStorage.length; i++) {
                const key = window.sessionStorage.key(i);
                storage[key] = window.sessionStorage.getItem(key);
              }
              return storage;
            } catch (e) {
              console.log('sessionStorage access denied:', e.message);
              return {};
            }
          });
        } catch (error) {
          console.log('[SimpleWorkflowExecutor] sessionStorage access denied:', error.message);
        }

        console.log(`[SimpleWorkflowExecutor] Collected auth tokens: ${cookies.length} cookies, ${Object.keys(localStorage).length} localStorage items, ${Object.keys(sessionStorage).length} sessionStorage items`);

        return {
          code: code,
          result: result,
          cookies: cookies,
          localStorage: localStorage,
          sessionStorage: sessionStorage,
          finalUrl: page.url()
        };
      } catch (error) {
        console.error('[SimpleWorkflowExecutor] Error collecting auth tokens:', error.message);
        return {
          code: code,
          result: result,
          error: error.message
        };
      }
    }
    
    return {
      code: code,
      result: result
    };
  }

  /**
   * Execute validate response step
   */
  async executeValidateResponse(page, step) {
    const config = step.config || {};
    const successIndicators = config.successIndicators || [];
    const failureIndicators = config.failureIndicators || [];
    
    let success = false;
    let failure = false;
    
    // Check success indicators
    for (const indicator of successIndicators) {
      try {
        const result = await page.evaluate(new Function(`return ${indicator}`));
        if (result) {
          success = true;
          break;
        }
      } catch (error) {
        // Ignore evaluation errors
      }
    }
    
    // Check failure indicators
    for (const indicator of failureIndicators) {
      try {
        const result = await page.evaluate(new Function(`return ${indicator}`));
        if (result) {
          failure = true;
          break;
        }
      } catch (error) {
        // Ignore evaluation errors
      }
    }
    
    return {
      success: success,
      failure: failure,
      successIndicators: successIndicators,
      failureIndicators: failureIndicators
    };
  }

  /**
   * Get authentication headers for API calls
   */
  getAuthHeaders() {
    const headers = {};
    if (this.context.runner_token) {
      headers['Authorization'] = `Bearer ${this.context.runner_token}`;
    }
    return headers;
  }

  /**
   * Get workflow from backend
   */
  async getWorkflow(workflowId) {
    try {
      const response = await axios.get(`${this.backendUrl}/api/workflow-templates/${workflowId}`, {
        headers: this.getAuthHeaders()
      });
      return response.data;
    } catch (error) {
      console.error('[SimpleWorkflowExecutor] Error getting workflow:', error.message);
      throw error;
    }
  }
}

export default SimpleWorkflowExecutor;
