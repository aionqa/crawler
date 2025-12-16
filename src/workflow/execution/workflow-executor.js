import axios from 'axios';

/**
 * WorkflowExecutor
 * Handles execution of workflow legs with iterative OpenAI testing
 * Each leg is tested until OpenAI confirms completion or failure
 */
class WorkflowExecutor {
  constructor(backendUrl, aiLogger, backendLogger, context = {}, videoRecorder = null) {
    this.backendUrl = backendUrl;
    this.aiLogger = aiLogger;
    this.backendLogger = backendLogger;
    this.context = context;
    this.videoRecorder = videoRecorder;
    this.workflowTemplate = null;
    // CRITICAL: 1 job = 1 attempt per leg (strictly enforced - no retries)
    this.maxIterations = 1;
    this.maxAiRequestsPerLeg = 2; // Maximum AI requests per leg (1 iteration × 2 requests: script generation + verification)

    // Track executed legs per job to prevent running the same action multiple times in a single job
    this.executedLegsPerJob = new Map();
  }

  /**
   * Append a human-readable captcha log to job timeline
   */
  async logCaptcha(jobId, level, message, metadata = {}) {
    if (!jobId || !this.backendLogger) {
      return;
    }
    const pageUrl = await (async () => {
      try {
        return metadata.page_url || (await metadata.page?.url?.());
      } catch {
        return undefined;
      }
    })();

    await this.backendLogger.appendJobLog(
      jobId,
      level,
      message,
      'WORKFLOW-EXECUTOR',
      {
        ...metadata,
        page_url: pageUrl || undefined
      }
    );
  }

  /**
   * Detect captcha element on the current page
   */
  async detectCaptchaOnPage(page) {
    const captchaSelectors = [
      // reCAPTCHA
      'iframe[src*="recaptcha"]',
      'div.g-recaptcha',
      'div[class*="recaptcha"]',
      // hCaptcha
      'iframe[src*="hcaptcha"]',
      'div.h-captcha',
      'div[class*="hcaptcha"]',
      // Cloudflare Turnstile
      'iframe[src*="turnstile"]',
      'div[class*="turnstile"]',
      // Generic indicators
      'div[id*="captcha"]',
      'div[class*="captcha"]',
      'img[src*="captcha"]',
      'input[name*="captcha"]'
    ];

    for (const selector of captchaSelectors) {
      const element = await page.$(selector).catch(() => null);
      if (element) {
        const type = selector.includes('recaptcha')
          ? 'reCAPTCHA'
          : selector.includes('hcaptcha')
            ? 'hCaptcha'
            : selector.includes('turnstile')
              ? 'Cloudflare Turnstile'
              : 'Generic Captcha';
        return { selector, type };
      }
    }
    return null;
  }

  /**
   * Attempt to solve a captcha once with human-like behavior
   */
  async attemptCaptchaSolve(page, jobId, captchaInfo, attempt, maxAttempts) {
    await this.logCaptcha(
      jobId,
      'warn',
      `⚠️ CAPTCHA detected (${captchaInfo.type}) attempt ${attempt}/${maxAttempts}`,
      {
        captcha_type: captchaInfo.type,
        captcha_selector: captchaInfo.selector,
        attempt,
        max_attempts: maxAttempts
      }
    );

    // Add small human-like movements to avoid bot detection
    try {
      const scrollAmount = 80 + Math.random() * 120;
      await page.evaluate(amount => window.scrollBy(0, amount), scrollAmount);
      await page.waitForTimeout(300 + Math.random() * 700);
      await page.mouse.move(
        100 + Math.random() * 400,
        100 + Math.random() * 400,
        { steps: 8 }
      );
      await page.waitForTimeout(200 + Math.random() * 400);
    } catch {
      // Non-blocking
    }

    // Try to click the captcha container or frame
    try {
      const element = await page.$(captchaInfo.selector).catch(() => null);
      if (element) {
        const box = await element.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
          await page.waitForTimeout(300 + Math.random() * 500);
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(1500 + Math.random() * 1500);
        }
      }
    } catch (interactionError) {
      await this.logCaptcha(
        jobId,
        'warn',
        `⚠️ CAPTCHA interaction warning: ${interactionError.message}`,
        {
          captcha_type: captchaInfo.type,
          captcha_selector: captchaInfo.selector,
          attempt,
          max_attempts: maxAttempts
        }
      );
    }
  }

  /**
   * Resolve captcha with up to 10 attempts during a leg execution
   */
  async resolveCaptchaWithRetries(page, jobId, maxAttempts = 10, phase = 'pre-leg') {
    let detectedAtLeastOnce = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const captchaInfo = await this.detectCaptchaOnPage(page);
      if (!captchaInfo) {
        if (detectedAtLeastOnce) {
          await this.logCaptcha(
            jobId,
            'info',
            `✅ CAPTCHA cleared during ${phase}`,
            { phase, attempts_used: attempt - 1 }
          );
        }
        return { detected: detectedAtLeastOnce, resolved: true, attempts: attempt - 1 };
      }

      detectedAtLeastOnce = true;
      await this.attemptCaptchaSolve(page, jobId, captchaInfo, attempt, maxAttempts);

      const stillPresent = await page.$(captchaInfo.selector).catch(() => null);
      if (!stillPresent) {
        await this.logCaptcha(
          jobId,
          'info',
          `✅ CAPTCHA resolved during ${phase} after attempt ${attempt}`,
          {
            captcha_type: captchaInfo.type,
            attempt,
            max_attempts: maxAttempts,
            phase
          }
        );
        return { detected: true, resolved: true, attempts: attempt };
      }

      await page.waitForTimeout(800 + Math.random() * 800);
    }

    await this.logCaptcha(
      jobId,
      'warn',
      `❌ CAPTCHA still present after ${maxAttempts} attempts during ${phase}`,
      { phase, max_attempts: maxAttempts }
    );

    return { detected: true, resolved: false, attempts: maxAttempts };
  }

  /**
   * Load workflow template from backend
   */
  async loadWorkflowTemplate() {
    if (!this.context.workflow_template_id) {
      console.error(`[WorkflowExecutor] ❌ No workflow template ID provided - workflows are mandatory!`);
      throw new Error('workflow_template_id is required - all jobs must use workflows stored in MongoDB');
    }

    try {
      const response = await axios.get(`${this.backendUrl}/api/workflow-templates/${this.context.workflow_template_id}`, {
        headers: this.getAuthHeaders()
      });
      this.workflowTemplate = response.data;
      console.log(`[WorkflowExecutor] ✅ Loaded workflow: "${this.workflowTemplate.name}" (ID: ${this.context.workflow_template_id})`);
      console.log(`[WorkflowExecutor] 📄 Workflow contains ${this.workflowTemplate.prompts?.length || 0} prompts`);
      
      // Log template details
      if (this.workflowTemplate.prompts && this.workflowTemplate.prompts.length > 0) {
        console.log(`[WorkflowExecutor] 📝 Custom prompts in template:`);
        this.workflowTemplate.prompts.forEach(p => {
          console.log(`[WorkflowExecutor]    - ${p.name}: ${p.template?.substring(0, 80)}...`);
        });
      }
      
      await this.logWorkflowDecision(
        `Using workflow: "${this.workflowTemplate.name}" (ID: ${this.context.workflow_template_id})`,
        `Workflow contains ${this.workflowTemplate.prompts?.length || 0} prompts`
      );
      
      return this.workflowTemplate;
    } catch (error) {
      console.error(`[WorkflowExecutor] ❌ Failed to load workflow template: ${error.message}`);
      throw new Error(`Failed to load workflow template ${this.context.workflow_template_id}: ${error.message}`);
    }
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
   * Find any AI prompt step with embedded template
   * Prompts are embedded directly in workflow step configs
   */
  findAIPromptStep() {
    if (!this.workflowTemplate || !this.workflowTemplate.steps) {
      return null;
    }

    const findInSteps = (steps) => {
      for (const s of steps || []) {
        if (s.type === 'ai-prompt') {
          // Check if step has embedded template
          const template = s.config?.template || s.config?.user_message_template;
          if (template) {
            return s;
          }
        }
        // Check nested steps (for-each, while-loop, etc.)
        if (s.config?.steps && Array.isArray(s.config.steps)) {
          const found = findInSteps(s.config.steps);
          if (found) return found;
        }
      }
      return null;
    };

    return findInSteps(this.workflowTemplate.steps);
  }

  /**
   * Find the specific script generation step (prioritizes script generation over action analysis)
   */
  findScriptGenerationStep() {
    if (!this.workflowTemplate || !this.workflowTemplate.steps) {
      console.log(`[WorkflowExecutor] findScriptGenerationStep: No workflow template or steps`);
      return null;
    }

    const findInSteps = (steps, depth = 0) => {
      for (const s of steps || []) {
        if (s.type === 'ai-prompt') {
          // Prioritize steps that are clearly for script generation
          const stepId = s.id || s.name || '';
          const stepName = (s.name || '').toLowerCase();
          const template = s.config?.template || s.config?.user_message_template || '';
          
          // Check if this is a script generation step
          // Exclude steps that are clearly for action analysis (but allow generation steps that mention actions)
          const isAnalysisStep = 
            (stepId.includes('analyze') && !stepId.includes('generate')) || 
            (stepName.includes('analyze') && !stepName.includes('generate')) ||
            (template.toLowerCase().includes('identify') && !template.toLowerCase().includes('generate')) ||
            template.toLowerCase().includes('list actions');
          
          const isScriptStep = 
            !isAnalysisStep && ( // Exclude analysis steps
              stepId.includes('script') || 
              stepId.includes('generate') ||
              stepName.includes('script') ||
              stepName.includes('generate') ||
              template.toLowerCase().includes('playwright code') ||
              template.toLowerCase().includes('playwright script') ||
              template.toLowerCase().includes('executable code') ||
              template.toLowerCase().includes('generate playwright') ||
              template.toLowerCase().includes('javascript code')
            );
          
          if (isScriptStep && template) {
            console.log(`[WorkflowExecutor] ✅ Found script generation step: ${stepId || stepName} (depth: ${depth})`);
            return s;
          }
        }
        // Check nested steps (for-each, while-loop, if-step, etc.)
        if (s.config?.steps && Array.isArray(s.config.steps)) {
          const found = findInSteps(s.config.steps, depth + 1);
          if (found) return found;
        }
      }
      return null;
    };

    // First try to find script generation step
    let scriptStep = findInSteps(this.workflowTemplate.steps);
    
    // If not found, fall back to any ai-prompt step
    if (!scriptStep) {
      console.log(`[WorkflowExecutor] ⚠️ No script generation step found, falling back to any ai-prompt step`);
      scriptStep = this.findAIPromptStep();
      if (scriptStep) {
        console.log(`[WorkflowExecutor] ✅ Fallback found ai-prompt step: ${scriptStep.id || scriptStep.name || 'unknown'}`);
      } else {
        console.log(`[WorkflowExecutor] ❌ No ai-prompt step found either`);
      }
    }
    
    return scriptStep;
  }

  /**
   * Find the determine completion step in workflow template
   */
  findDetermineCompletionStep() {
    if (!this.workflowTemplate || !this.workflowTemplate.steps) {
      return null;
    }

    const findInSteps = (steps) => {
      for (const s of steps || []) {
        if (s.type === 'ai-prompt') {
          const stepId = s.id || s.name || '';
          const stepName = (s.name || '').toLowerCase();
          const template = s.config?.template || s.config?.user_message_template || '';
          
          // Check if this is a determine completion step
          const isDetermineStep = 
            stepId.includes('determine') && (stepId.includes('completion') || stepId.includes('complete')) ||
            stepName.includes('determine') && (stepName.includes('completion') || stepName.includes('complete')) ||
            template.toLowerCase().includes('determine') && (template.toLowerCase().includes('completion') || template.toLowerCase().includes('complete')) ||
            template.toLowerCase().includes('determine-leg-completion');
          
          if (isDetermineStep && template) {
            return s;
          }
        }
        // Check nested steps (for-each, while-loop, etc.)
        if (s.config?.steps && Array.isArray(s.config.steps)) {
          const found = findInSteps(s.config.steps);
          if (found) return found;
        }
      }
      return null;
    };

    return findInSteps(this.workflowTemplate.steps);
  }

  /**
   * Check job status from backend
   * @param {string} jobId - Job ID to check
   * @returns {string} Job status (running, failed, paused, etc.)
   */
  async checkJobStatus(jobId) {
    try {
      // Use /api/jobs/:id which doesn't require authentication (runner-friendly endpoint)
      const response = await axios.get(`${this.backendUrl}/api/jobs/${jobId}`, {
        headers: this.getAuthHeaders(), // Still send auth headers for logging/tracking
        timeout: 5000
      });
      return response.data?.status || 'unknown';
    } catch (error) {
      console.error(`[WorkflowExecutor] Error checking job status:`, error.message);
      return 'unknown';
    }
  }

  /**
   * Mark an action as started
   * @param {string} actionId - Action ID to mark as started
   * @param {string} jobId - Job ID that started this action
   */
  async markActionStarted(actionId, jobId) {
    try {
      await axios.post(`${this.backendUrl}/actions/${actionId}/start`, {
        job_id: jobId
      }, {
        timeout: 5000
      });
      console.log(`[WorkflowExecutor] Marked action ${actionId} as started for job ${jobId}`);
    } catch (error) {
      console.error(`[WorkflowExecutor] Error marking action as started:`, error.message);
    }
  }

  /**
   * Mark an action as completed
   * @param {string} actionId - Action ID to mark as completed
   * @param {boolean} success - Whether the action was successful
   * @param {string} error - Error message if action failed
   */
  async markActionCompleted(actionId, success = true, error = null) {
    try {
      await axios.post(`${this.backendUrl}/actions/${actionId}/complete`, {
        success,
        error
      }, {
        timeout: 5000
      });
      console.log(`[WorkflowExecutor] Marked action ${actionId} as ${success ? 'completed' : 'failed'}`);
    } catch (error) {
      console.error(`[WorkflowExecutor] Error marking action as completed:`, error.message);
    }
  }

  /**
   * Start a video segment for the leg if video recorder available
   */
  startLegSegment(jobId, leg) {
    if (!this.videoRecorder) {
      return null;
    }
    const label = leg?.description
      ? `Leg: ${leg.description}`
      : (leg?.leg_id ? `Leg ${leg.leg_id}` : 'Workflow Step');
    return this.videoRecorder.startSegment(jobId, `leg-${leg?.leg_id || Date.now()}`, label, {
      type: 'workflow_leg',
      leg_id: leg?.leg_id || null,
      description: leg?.description || null
    });
  }

  /**
   * End a previously started leg segment
   */
  endLegSegment(jobId, segmentId, leg, result = null, lastError = null) {
    if (!this.videoRecorder || !segmentId) {
      return;
    }
    this.videoRecorder.endSegment(jobId, segmentId, {
      result,
      error: lastError,
      leg_id: leg?.leg_id || null
    });
  }

  /**
   * Execute a single workflow leg
   * @param {Page} page - Playwright page object
   * @param {string} jobId - Job ID for logging
   * @param {string} workflowId - Workflow ID
   * @param {Object} leg - Leg object from workflow
   * @returns {Object} execution result
   */
  async executeLeg(page, jobId, workflowId, leg) {
    console.log(`[WorkflowExecutor] Executing leg: ${leg.leg_id} - ${leg.description}`);

    // Load workflow template if not already loaded
    if (!this.workflowTemplate) {
      await this.loadWorkflowTemplate();
    }
    
    // CRITICAL: Verify workflow template has steps with embedded prompts
    if (!this.workflowTemplate || !this.workflowTemplate.steps || this.workflowTemplate.steps.length === 0) {
      throw new Error(`Workflow template has no steps with embedded prompts. All prompts must be embedded in workflow step configs.`);
    }
    
    // Verify at least one step has an embedded template
    const hasEmbeddedPrompt = this.findAIPromptStep() !== null;
    if (!hasEmbeddedPrompt) {
      throw new Error(`No embedded prompt templates found in workflow steps. All prompts must be embedded in workflow step configs.`);
    }

    // Check job status before starting
    const jobStatus = await this.checkJobStatus(jobId);
    if (jobStatus !== 'running') {
      console.log(`[WorkflowExecutor] Job ${jobId} status is ${jobStatus}, stopping leg execution`);
      return {
        leg_id: leg.leg_id,
        result: 'cancelled',
        iterations: 0,
        error: `Job status is ${jobStatus}`
      };
    }

    // CRITICAL: Check database for already-executed actions with same leg_id + page_id in this job
    // This ensures actions are analyzed once per job per page
    // Get page_id from context or workflow state
    const pageId = this.context.page_id || leg.page_id || null;
    
    try {
      const existingActionResponse = await axios.get(`${this.backendUrl}/api/actions`, {
        params: {
          job_id: jobId,
          leg_id: leg.leg_id,
          ...(pageId ? { page_id: pageId } : {})
        },
        timeout: 5000
      });
      
      if (existingActionResponse.data && Array.isArray(existingActionResponse.data) && existingActionResponse.data.length > 0) {
        const existingActions = existingActionResponse.data;
        // Check if any action with this leg_id (and page_id if available) has been executed (not pending)
        const executedAction = existingActions.find(a => {
          const legMatch = a.leg_id === leg.leg_id;
          const pageMatch = !pageId || !a.page_id || a.page_id.toString() === pageId.toString();
          const isExecuted = a.status !== 'pending' && a.status !== undefined;
          return legMatch && pageMatch && isExecuted;
        });
        
        if (executedAction) {
          console.log(`[WorkflowExecutor] ⏭️ Skipping duplicate leg ${leg.leg_id} for job ${jobId}${pageId ? ` and page ${pageId}` : ''} - already executed (status: ${executedAction.status})`);
          return {
            leg_id: leg.leg_id,
            result: 'skipped',
            iterations: 0,
            error: `duplicate_leg_in_job_per_page - action already executed with status: ${executedAction.status}`
          };
        }
      }
    } catch (checkError) {
      // If check fails, log warning but continue (don't block execution)
      console.warn(`[WorkflowExecutor] Could not check for duplicate actions: ${checkError.message}`);
    }
    
    // Also track in memory for fast lookup within this executor instance
    const executed = this.executedLegsPerJob.get(jobId) || new Set();
    if (executed.has(leg.leg_id)) {
      console.log(`[WorkflowExecutor] Skipping duplicate leg ${leg.leg_id} for job ${jobId} (in-memory check)`);
      return {
        leg_id: leg.leg_id,
        result: 'skipped',
        iterations: 0,
        error: 'duplicate_leg_in_job'
      };
    }
    executed.add(leg.leg_id);
    this.executedLegsPerJob.set(jobId, executed);

    // Mark leg as in progress (only if workflowId is provided)
    if (workflowId) {
      await this.updateLegStatus(workflowId, leg.leg_id, 'in_progress', jobId);
    }

    // Mark associated action as started if it exists
    if (leg.action_id) {
      await this.markActionStarted(leg.action_id, jobId);
    }

    const segmentToken = this.startLegSegment(jobId, leg);
    let finalSegmentResult = 'failure';
    let finalSegmentError = null;
    let outcome = null;

    let completed = false;
    let finalResult = 'failure';
    let lastError = null;
    let aiRequestCount = 0;
    const iteration = 1; // Always 1 - no retries
    let screenshotBeforeKey = null; // Initialize to avoid undefined errors
    let htmlContent = null; // Initialize to avoid undefined errors

    // CRITICAL: Wrap entire leg execution in 1-minute timeout to prevent hangs
    const legTimeout = 60000; // 1 minute max per leg
    const legExecutionPromise = (async () => {
    try {
      console.log(`[WorkflowExecutor] Leg ${leg.leg_id} - Single execution (AI requests: ${aiRequestCount}/${this.maxAiRequestsPerLeg})`);

      // Check job status before execution
      const jobStatus = await this.checkJobStatus(jobId);
      if (jobStatus !== 'running') {
        console.log(`[WorkflowExecutor] Job ${jobId} status changed to ${jobStatus}, stopping leg execution`);
        finalResult = 'cancelled';
        completed = true;
        lastError = `Job status changed to ${jobStatus}`;
      } else {
        try {
        // Step 1: Capture page URL before action (for execution state)
        const pageUrlBefore = page.url();
        
        // Step 1a: Detect and resolve captcha (up to 10 attempts) before collecting artifacts
        const captchaResult = await this.resolveCaptchaWithRetries(page, jobId, 10, 'pre-leg');
        if (captchaResult.detected && !captchaResult.resolved) {
          await this.logCaptcha(
            jobId,
            'warn',
            `⚠️ CAPTCHA unresolved after ${captchaResult.attempts} attempts (continuing leg)`,
            { phase: 'pre-leg' }
          );
        }

        // Step 2: Take screenshot before action
        const screenshotBefore = await page.screenshot({ fullPage: true, type: 'png' });
        screenshotBeforeKey = await this.uploadScreenshot(jobId, screenshotBefore, 'before');
        const screenshotBeforeBase64 = screenshotBefore.toString('base64');

        // Step 2: Get HTML content (FULL - no trimming)
        htmlContent = await page.content();
        
        // Get interactive elements for context
        // Collect interactive elements with proper selectors and IDs
        const interactiveElementsArray = await page.$$('[role="button"], button, a, input, select, textarea, [onclick], [tabindex]');
        const interactiveElements = [];
        
        for (let i = 0; i < interactiveElementsArray.length; i++) {
          const el = interactiveElementsArray[i];
          const tagName = await el.evaluate(el => el.tagName.toLowerCase());
          const id = await el.getAttribute('id');
          const name = await el.getAttribute('name');
          const type = await el.getAttribute('type');
          const className = await el.getAttribute('class');
          const text = await el.evaluate(el => el.textContent?.trim().substring(0, 100) || '');
          const role = await el.getAttribute('role');
          
          // Generate selector - prioritize ID, then name, then type, then class, then text
          let selector = '';
          let elementId = id || '';
          
          if (id) {
            selector = `#${id}`;
            elementId = id;
          } else if (name) {
            selector = `${tagName}[name="${name}"]`;
            elementId = `element_${i}_${tagName}_${name}`;
          } else if (type) {
            selector = `${tagName}[type="${type}"]`;
            elementId = `element_${i}_${tagName}_${type}`;
          } else if (className && className.trim()) {
            const firstClass = className.trim().split(/\s+/)[0];
            selector = `.${firstClass}`;
            elementId = `element_${i}_${tagName}_${firstClass}`;
          } else if (text) {
            selector = `${tagName}:has-text("${text.substring(0, 30)}")`;
            elementId = `element_${i}_${tagName}_text`;
          } else {
            // Generate nth-of-type selector as fallback
            const sameTagElements = await page.$$(tagName);
            const index = sameTagElements.indexOf(el);
            selector = `${tagName}:nth-of-type(${index + 1})`;
            elementId = `element_${i}_${tagName}_nth${index + 1}`;
          }
          
          // Generate XPath as additional identifier
          const xpath = await el.evaluate((el) => {
            if (el.id) return `//*[@id="${el.id}"]`;
            if (el.name) return `//${el.tagName.toLowerCase()}[@name="${el.name}"]`;
            const path = [];
            let current = el;
            while (current && current.nodeType === Node.ELEMENT_NODE) {
              let selector = current.tagName.toLowerCase();
              if (current.id) {
                selector += `[@id="${current.id}"]`;
                path.unshift(selector);
                break;
              }
              const siblings = Array.from(current.parentNode?.children || []).filter(c => c.tagName === current.tagName);
              const index = siblings.indexOf(current) + 1;
              selector += `[${index}]`;
              path.unshift(selector);
              current = current.parentNode;
              if (current === document.body) break;
            }
            return '/' + path.join('/');
          });
          
          interactiveElements.push({
            tag: tagName.toUpperCase(),
            id: elementId, // Always provide an ID (real or generated)
            class: className || '',
            text: text,
            type: type || '',
            name: name || '',
            role: role || '',
            selector: selector, // Primary selector
            xpath: xpath, // XPath for additional identification
            // Additional attributes for better recognition
            href: tagName === 'a' ? await el.getAttribute('href') : null,
            placeholder: tagName === 'input' ? await el.getAttribute('placeholder') : null
          });
        }
        
        const interactiveElementsJson = JSON.stringify(interactiveElements, null, 2);
        
        // Get Playwright analysis (form structure, inputs, buttons) with proper selectors and IDs
        const playwrightAnalysis = await page.evaluate(() => {
          const forms = [];
          document.querySelectorAll('form').forEach((form, idx) => {
            const formId = form.id || `form_${idx}`;
            const formData = {
              index: idx,
              id: formId,
              action: form.action || '',
              method: form.method || 'get',
              selector: form.id ? `#${form.id}` : `form:nth-of-type(${idx + 1})`,
              fields: []
            };
            form.querySelectorAll('input, select, textarea').forEach((field, fieldIdx) => {
              const fieldId = field.id || `field_${idx}_${fieldIdx}`;
              const fieldSelector = field.id 
                ? `#${field.id}` 
                : (field.name 
                  ? `${field.tagName.toLowerCase()}[name="${field.name}"]` 
                  : `${field.tagName.toLowerCase()}:nth-of-type(${fieldIdx + 1})`);
              
              formData.fields.push({
                type: field.type || field.tagName.toLowerCase(),
                name: field.name || '',
                id: fieldId, // Always provide an ID (real or generated)
                placeholder: field.placeholder || '',
                required: field.required || false,
                selector: fieldSelector // Always provide a selector
              });
            });
            forms.push(formData);
          });
          
          // Generate inputs with selectors and IDs
          const inputs = Array.from(document.querySelectorAll('input')).map((input, idx) => {
            const inputId = input.id || `input_${idx}`;
            const inputSelector = input.id 
              ? `#${input.id}` 
              : (input.name 
                ? `input[name="${input.name}"]` 
                : `input:nth-of-type(${idx + 1})`);
            
            return {
              type: input.type,
              name: input.name || '',
              id: inputId, // Always provide an ID
              placeholder: input.placeholder || '',
              selector: inputSelector // Always provide a selector
            };
          });
          
          // Generate buttons with selectors and IDs
          const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]')).map((btn, idx) => {
            const btnId = btn.id || `button_${idx}`;
            const btnSelector = btn.id 
              ? `#${btn.id}` 
              : `${btn.tagName.toLowerCase()}:nth-of-type(${idx + 1})`;
            
            return {
              type: btn.type,
              text: btn.textContent || btn.value || '',
              id: btnId, // Always provide an ID
              selector: btnSelector // Always provide a selector
            };
          });
          
          return {
            forms: forms,
            inputs: inputs,
            buttons: buttons
          };
        });

        // Step 3: Ask OpenAI for Playwright script with FULL context
        let playwrightScript = leg.playwright_script;
        
        if (!playwrightScript) {
          // No previous logs - single attempt only
          const previousLogs = '';
          
          const scriptRequest = {
            page_url: page.url(),
            html_content: htmlContent,  // FULL HTML - no trimming
            screenshot_base64: screenshotBeforeBase64,  // Include screenshot inline for Vision API
            playwright_analysis: JSON.stringify(playwrightAnalysis, null, 2),  // Include Playwright analysis
            interactive_elements_json: interactiveElementsJson,
            leg_description: leg.description,
            leg_type: leg.type,
            element_info: JSON.stringify(leg.element_info, null, 2),
            test_instructions: leg.test_instructions,
            previous_error: lastError,
            previous_logs: previousLogs,
            iteration_number: iteration,
            additional_prompt_text: this.context.additional_prompt_text || ''  // Project-specific additional context
          };

          console.log(`[WorkflowExecutor] Requesting script from OpenAI (HTML: ${htmlContent.length} chars, screenshot: ${screenshotBeforeBase64.length} chars, iteration: ${iteration})`);

          // Update sub-status with descriptive information
          const legDescription = leg.description || 'Unknown workflow step';
          await this.updateJobSubstatus(jobId, `Generating test script for: ${legDescription}`, {
            current_page: page.url(),
            workflow_leg: leg.leg_id,
            iteration: iteration
          });

          console.log(`[WorkflowExecutor] DEBUG: About to call makeAICallWithPrompt`);
          aiRequestCount++;
          if (aiRequestCount > this.maxAiRequestsPerLeg) {
            console.log(`[WorkflowExecutor] AI request limit reached (${this.maxAiRequestsPerLeg}), stopping leg execution`);
            throw new Error(`AI request limit exceeded: ${aiRequestCount}/${this.maxAiRequestsPerLeg}`);
          }
          
          // Find prompt from workflow steps - prompts MUST be embedded in step configs
          // Prioritize script generation steps over action analysis steps
          const scriptStep = this.findScriptGenerationStep();
          const customScriptTemplate = scriptStep ? (scriptStep.config?.template || scriptStep.config?.user_message_template) : null;
          
          if (!customScriptTemplate) {
            const stepInfo = scriptStep ? `${scriptStep.id || scriptStep.name || 'unknown'}` : 'none found';
            console.error(`[WorkflowExecutor] ❌ No embedded prompt template found in workflow steps.`);
            console.error(`[WorkflowExecutor] Step found: ${stepInfo}`);
            console.error(`[WorkflowExecutor] Available steps: ${this.workflowTemplate?.steps?.map(s => s.id || s.name || s.type).join(', ') || 'none'}`);
            throw new Error(`No embedded prompt template found in workflow steps. All prompts must be embedded in workflow step configs. Step: ${stepInfo}`);
          }
          
          console.log(`[WorkflowExecutor] ✅ Using prompt template from step: ${scriptStep.id || scriptStep.name || 'unknown'}`);
          
          const scriptPromptSource = 'workflow-step';
          const promptIdentifier = scriptStep ? (scriptStep.id || scriptStep.name || 'workflow-step') : 'workflow-executor';
          
          // Log prompt usage
          await this.logPromptUsage(promptIdentifier, scriptPromptSource, customScriptTemplate, scriptRequest);
          
          const scriptResponse = await this.aiLogger.makeAICallWithPrompt(
            promptIdentifier,
            scriptRequest,
            jobId,
            'workflow-executor',
            page.url(),
            screenshotBeforeKey,  // screenshotId for tracking
            scriptRequest,  // Pass scriptRequest as sourcePayload for full attachment logging
            customScriptTemplate // Pass custom template (required - no fallback to database)
          );
          console.log(`[WorkflowExecutor] DEBUG: makeAICallWithPrompt completed successfully`);

          // Helper function to extract script from various response formats
          const extractScript = (response) => {
            if (!response) return null;
            
            // Handle string responses (might be JSON string)
            if (typeof response === 'string') {
              try {
                const parsed = JSON.parse(response);
                return extractScript(parsed);
              } catch {
                // If it's not JSON, check if it's already script code
                if (response.trim().length > 0 && (response.includes('await') || response.includes('page.') || response.includes('async'))) {
                  return response;
                }
                return null;
              }
            }
            
            // Handle nested objects (response.data, response.result, etc.)
            if (response.data && typeof response.data === 'object') {
              const fromData = extractScript(response.data);
              if (fromData) return fromData;
            }
            if (response.result && typeof response.result === 'object') {
              const fromResult = extractScript(response.result);
              if (fromResult) return fromResult;
            }
            if (response.response && typeof response.response === 'object') {
              const fromResponse = extractScript(response.response);
              if (fromResponse) return fromResponse;
            }
            
            // Check for script in actions array (if response has actions)
            if (response.actions && Array.isArray(response.actions) && response.actions.length > 0) {
              for (const action of response.actions) {
                if (action.playwright_script && typeof action.playwright_script === 'string') {
                  return action.playwright_script;
                }
                if (action.script && typeof action.script === 'string') {
                  return action.script;
                }
                if (action.code && typeof action.code === 'string') {
                  return action.code;
                }
              }
            }
            
            // Check for script in legs array (if response has legs)
            if (response.legs && Array.isArray(response.legs) && response.legs.length > 0) {
              for (const leg of response.legs) {
                if (leg.playwright_script && typeof leg.playwright_script === 'string') {
                  return leg.playwright_script;
                }
                if (leg.script && typeof leg.script === 'string') {
                  return leg.script;
                }
                if (leg.code && typeof leg.code === 'string') {
                  return leg.code;
                }
                // Check nested actions in legs
                if (leg.actions && Array.isArray(leg.actions)) {
                  for (const action of leg.actions) {
                    if (action.playwright_script && typeof action.playwright_script === 'string') {
                      return action.playwright_script;
                    }
                    if (action.script && typeof action.script === 'string') {
                      return action.script;
                    }
                  }
                }
              }
            }
            
            // Check all possible field names (case-insensitive check for common variations)
            const possibleFields = [
              'script',
              'playwright_script',
              'code',
              'playwright_code',
              'playwrightCode',
              'executable_code',
              'automation_code',
              'test_code',
              'action_code'
            ];
            
            for (const field of possibleFields) {
              if (response[field] && typeof response[field] === 'string' && response[field].trim().length > 0) {
                return response[field];
              }
            }
            
            return null;
          };
          
          playwrightScript = extractScript(scriptResponse);
          
          console.log(`[WorkflowExecutor] DEBUG: scriptResponse type: ${typeof scriptResponse}`);
          console.log(`[WorkflowExecutor] DEBUG: scriptResponse keys: ${scriptResponse ? Object.keys(scriptResponse) : 'null'}`);
          console.log(`[WorkflowExecutor] DEBUG: Extracted script length: ${playwrightScript ? playwrightScript.length : 0}`);
          
          if (!playwrightScript || playwrightScript.trim().length === 0) {
            console.error(`[WorkflowExecutor] ❌ OpenAI did not return a valid Playwright script.`);
            console.error(`[WorkflowExecutor] Response type: ${typeof scriptResponse}`);
            console.error(`[WorkflowExecutor] Response keys: ${scriptResponse ? Object.keys(scriptResponse).join(', ') : 'null'}`);
            console.error(`[WorkflowExecutor] Full response: ${JSON.stringify(scriptResponse, null, 2)}`);
            throw new Error(`OpenAI did not return a valid Playwright script. Response keys: ${scriptResponse ? Object.keys(scriptResponse).join(', ') : 'null'}`);
          }
          
          // DO NOT sanitize, clean, or validate - use script exactly as OpenAI returned it
          // Only extract from markdown code blocks if present (but preserve all content)
          if (playwrightScript.includes('```')) {
            const codeBlockRegex = /```[\w]*\s*\n?([\s\S]*?)\n?```/g;
            const codeBlockMatches = [...playwrightScript.matchAll(codeBlockRegex)];
            if (codeBlockMatches.length > 0) {
              // Extract code from first code block
              // CRITICAL: Only trim leading/trailing whitespace, preserve all content including quotes
              // Do NOT use .trim() as it can remove closing quotes on new lines
              let extracted = codeBlockMatches[0][1];
              // Only remove leading/trailing whitespace (newlines, spaces, tabs), preserve quotes
              extracted = extracted.replace(/^[\s\n\r]+/, '').replace(/[\s\n\r]+$/, '');
              playwrightScript = extracted;
              
              console.log(`[WorkflowExecutor] Extracted from code block: ${playwrightScript.length} chars (preserved all content)`);
            }
          }
          
          // Check if script has incomplete strings BEFORE storing/executing
          if (this.checkIncompleteString && this.checkIncompleteString(playwrightScript)) {
            console.log(`[WorkflowExecutor] ⚠️ Detected incomplete string literals in extracted script, attempting to fix...`);
            playwrightScript = this.fixIncompleteStrings(playwrightScript);
            console.log(`[WorkflowExecutor] Fixed script length: ${playwrightScript.length} chars`);
          }
          
          // Only check if script is empty after minimal trimming (preserve all content)
          const trimmedCheck = playwrightScript.replace(/^\s+/, '').replace(/\s+$/, '');
          if (!trimmedCheck || trimmedCheck.length === 0) {
            throw new Error(`Script is empty`);
          }
          
          console.log(`[WorkflowExecutor] ✅ Successfully extracted Playwright script (${playwrightScript.length} characters) - NO sanitization applied`);
          
          // Update leg with script
          await this.updateLeg(workflowId, leg.leg_id, { 
            playwright_script: playwrightScript,
            update_action: true  // Signal backend to also update action document
          });
        }

        console.log(`[WorkflowExecutor] Executing script for leg ${leg.leg_id}`);

        // Step 4: Add human-like pre-execution behaviors
        try {
          const { addHumanBehavior, humanDelay } = await import('../../browser/stealth-config.js');
          const { moveMouse, randomScroll } = await addHumanBehavior(page);
          
          // Random mouse movement (humans move mouse even when not clicking)
          if (Math.random() < 0.3) {
            await moveMouse();
          }
          
          // Small random scroll (humans scroll to read)
          if (Math.random() < 0.4) {
            await randomScroll('down', 50 + Math.random() * 150);
          }
          
          // Brief pause before starting actions
          await humanDelay(200, 500);
        } catch (error) {
          // Don't fail if human behavior injection fails
          console.warn(`[WorkflowExecutor] Human behavior injection warning: ${error.message}`);
        }
        
        // Step 4: Execute Playwright script
        const executionResult = await this.executeScript(page, playwrightScript, jobId);
        
        // Step 5: Take screenshot after action (always, even if script failed)
        // CRITICAL: Wrap in try-catch to handle browser crashes gracefully
        let screenshotAfter = null;
        let screenshotAfterKey = null;
        let screenshotAfterBase64 = null;
        let htmlAfter = null;
        
        try {
          // Check if page is still valid before attempting screenshot
          if (page && !page.isClosed()) {
            try {
              // Quick validity check
              await page.url();
              
              screenshotAfter = await page.screenshot({ 
                fullPage: true, 
                type: 'png',
                timeout: 10000 // Shorter timeout to fail faster if browser is unstable
              });
              screenshotAfterKey = await this.uploadScreenshot(jobId, screenshotAfter, 'after');
              screenshotAfterBase64 = screenshotAfter.toString('base64');
              
              // Get HTML after action
              htmlAfter = await page.content();
            } catch (screenshotError) {
              // Browser crashed or page became invalid
              console.warn(`[WorkflowExecutor] Screenshot after action failed (browser may have crashed): ${screenshotError.message}`);
              await this.backendLogger.appendJobLog(jobId, 'warn', 
                `⚠️ Could not capture screenshot after action: ${screenshotError.message}`,
                'WORKFLOW-EXECUTOR',
                { leg_id: leg.leg_id, error: screenshotError.message }
              );
              // Continue without screenshot - we can still verify with execution result
              htmlAfter = null;
            }
          } else {
            console.warn(`[WorkflowExecutor] Page is closed or invalid, skipping screenshot`);
            await this.backendLogger.appendJobLog(jobId, 'warn',
              `⚠️ Page is closed/invalid after script execution, skipping screenshot`,
              'WORKFLOW-EXECUTOR',
              { leg_id: leg.leg_id }
            );
          }
        } catch (error) {
          // Last resort catch - log and continue
          console.error(`[WorkflowExecutor] Error during screenshot/HTML capture: ${error.message}`);
          await this.backendLogger.appendJobLog(jobId, 'error',
            `❌ Screenshot/HTML capture error: ${error.message}`,
            'WORKFLOW-EXECUTOR',
            { leg_id: leg.leg_id, error: error.message }
          );
        }

        // Step 7: Always call determine completion to get clear reasoning (even if script failed)
        // This provides clear failure/success reasons for all outcomes
        const determineCompletionRequest = {
          // Map to template field names
          current_leg: JSON.stringify({
            leg_id: leg.leg_id,
            description: leg.description,
            type: leg.type,
            test_instructions: leg.test_instructions,
            element_info: leg.element_info
          }, null, 2),
          execution_result: JSON.stringify(executionResult, null, 2), // Include script execution result/error
          page_description: await page.evaluate(() => document.body.innerText?.substring(0, 2000) || ''),
          visible_text: await page.evaluate(() => document.body.innerText || ''),
          interactive_elements: JSON.stringify(await page.$$eval('[role="button"], button, a, input, select, textarea', els => 
            els.slice(0, 50).map(el => ({
              tag: el.tagName,
              text: el.textContent?.trim().substring(0, 100) || '',
              id: el.id || '',
              class: el.className || ''
            }))
          ), null, 2),
          forms: JSON.stringify(await page.$$eval('form', forms => 
            forms.slice(0, 10).map(form => ({
              id: form.id || '',
              action: form.action || '',
              method: form.method || 'get'
            }))
          ), null, 2),
          testing_history: '', // No previous iterations - single attempt
          // Additional context
          page_url: page.url(),
          before_url: page.url(),
          after_url: page.url(),
          html_before: htmlContent.substring(0, 50000), // Truncate for AI context
          html_after: htmlAfter.substring(0, 50000),
          screenshot_base64: screenshotAfterBase64,
          script_executed: playwrightScript,
          script_error: executionResult?.error || executionResult?.message || null, // Include script error if any
          leg_description: leg.description,
          leg_type: leg.type,
          test_instructions: leg.test_instructions,
          iteration_number: iteration,
          additional_prompt_text: this.context.additional_prompt_text || ''
        };

        console.log(`[WorkflowExecutor] Calling determine completion (script success: ${!executionResult?.error}, HTML after: ${htmlAfter.length} chars)`);

        aiRequestCount++;
        if (aiRequestCount > this.maxAiRequestsPerLeg) {
          console.log(`[WorkflowExecutor] AI request limit reached (${this.maxAiRequestsPerLeg}), stopping leg execution`);
          throw new Error(`AI request limit exceeded: ${aiRequestCount}/${this.maxAiRequestsPerLeg}`);
        }

        // Find determine completion step - prioritize determine completion step
        const determineStep = this.findDetermineCompletionStep();
        let determineTemplate = determineStep ? (determineStep.config?.template || determineStep.config?.user_message_template) : null;
        
        // Fallback to any AI prompt step if determine completion step not found
        if (!determineTemplate) {
          const verifyStep = this.findAIPromptStep();
          determineTemplate = verifyStep ? (verifyStep.config?.template || verifyStep.config?.user_message_template) : null;
        }
        
        if (!determineTemplate) {
          throw new Error(`No embedded prompt template found in workflow steps for determine completion. All prompts must be embedded in workflow step configs.`);
        }
        
        const determinePromptSource = 'workflow-step';
        const determinePromptIdentifier = determineStep ? (determineStep.id || determineStep.name || 'determine-completion') : 'workflow-executor';
        
        // Log prompt usage
        await this.logPromptUsage(determinePromptIdentifier, determinePromptSource, determineTemplate, determineCompletionRequest);
        
        const determineCompletionResponse = await this.aiLogger.makeAICallWithPrompt(
          determinePromptIdentifier,
          determineCompletionRequest,
          jobId,
          'workflow-executor',
          page.url(),
          screenshotAfterKey,
          determineCompletionRequest,
          determineTemplate
        );

        // Extract reason from determine completion response
        const completionReason = determineCompletionResponse.reason || 
                                 determineCompletionResponse.description || 
                                 determineCompletionResponse.what_happened ||
                                 (executionResult?.error ? `Script execution failed: ${executionResult.error}` : 'Unknown outcome');

        // Collect execution state for redo capability
        const pageUrlAfter = page.url();
        const cookies = await page.context().cookies();
        const viewport = page.viewportSize();
        const userAgent = await page.evaluate(() => navigator.userAgent);
        
        const executionState = {
          page_url: pageUrlAfter,
          page_url_before: pageUrlBefore, // URL before script execution
          cookies: cookies.map(c => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            expires: c.expires,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite
          })),
          connection_settings: {
            viewport: viewport ? { width: viewport.width, height: viewport.height } : null,
            user_agent: userAgent,
            timezone: await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
            locale: await page.evaluate(() => navigator.language)
          },
          script: playwrightScript,
          timestamp: new Date().toISOString()
        };

        // Step 8: Record iteration with FULL data including determine completion reasoning and execution state
        await this.addIteration(workflowId, leg.leg_id, {
          screenshot_before: screenshotBeforeKey,
          screenshot_after: screenshotAfterKey,
          html_sent: htmlContent,
          html_after: htmlAfter,
          script_executed: playwrightScript,
          openai_request: determineCompletionRequest,
          openai_response: determineCompletionResponse,
          result: determineCompletionResponse.status === 'success' ? 'success' : 
                  (determineCompletionResponse.status === 'failure' ? 'failure' : 'incomplete'),
          status: determineCompletionResponse.status || null, // Status from determine_completion (success/failure/continue/stuck)
          completion_status: determineCompletionResponse.completion_status || null, // Alternative status field
          error: executionResult?.error || null, // Keep script error for technical details
          reason: completionReason, // CRITICAL: Reasoning from determine_completion for execution history
          failure_reason: completionReason, // Keep for backward compatibility
          what_happened: determineCompletionResponse.what_happened || null, // What happened description
          page_url_before: pageUrlBefore, // URL before script execution
          page_url_after: pageUrlAfter, // URL after script execution
          execution_state: executionState, // Save state for redo capability
          job_id: jobId,
          video_segment_id: segmentToken || null
        });

        // Step 9: Check result - always complete after single attempt (no retries)
        const completionStatus = determineCompletionResponse.status || determineCompletionResponse.completion_status;
        if (completionStatus === 'success' || determineCompletionResponse.is_complete === true) {
          console.log(`[WorkflowExecutor] Leg ${leg.leg_id} completed successfully. Reason: ${completionReason}`);
          completed = true;
          finalResult = 'success';
          lastError = null;
        } else {
          // Any non-success result is a failure - use clear reason from determine completion
          console.log(`[WorkflowExecutor] Leg ${leg.leg_id} failed. Reason: ${completionReason}`);
          completed = true;
          finalResult = 'failure';
          lastError = completionReason; // Use clear reasoning from determine completion
        }

        } catch (error) {
          console.error(`[WorkflowExecutor] Error in execution:`, error.message);
          console.error(`[WorkflowExecutor] Error stack:`, error.stack);
          lastError = error.message;

          // Try to collect execution state even on error (if page is still available)
          let executionState = null;
          try {
            const pageUrl = page.url();
            const cookies = await page.context().cookies();
            const viewport = page.viewportSize();
            const userAgent = await page.evaluate(() => navigator.userAgent);
            
            executionState = {
              page_url: pageUrl,
              cookies: cookies.map(c => ({
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path,
                expires: c.expires,
                httpOnly: c.httpOnly,
                secure: c.secure,
                sameSite: c.sameSite
              })),
              connection_settings: {
                viewport: viewport ? { width: viewport.width, height: viewport.height } : null,
                user_agent: userAgent,
                timezone: await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
                locale: await page.evaluate(() => navigator.language)
              },
              script: typeof playwrightScript !== 'undefined' ? playwrightScript : null,
              timestamp: new Date().toISOString()
            };
          } catch (stateError) {
            console.warn(`[WorkflowExecutor] Could not collect execution state: ${stateError.message}`);
          }

          // Record failed attempt (single attempt only)
          let pageUrlBefore = null;
          let pageUrlAfter = null;
          try {
            if (page && !page.isClosed()) {
              pageUrlBefore = page.url();
              pageUrlAfter = page.url();
            }
          } catch (urlError) {
            // Ignore URL errors
          }

          await this.addIteration(workflowId, leg.leg_id, {
            screenshot_before: screenshotBeforeKey || null,
            screenshot_after: null,
            html_sent: htmlContent || null,
            script_executed: typeof playwrightScript !== 'undefined' ? playwrightScript : null,
            openai_request: null,
            openai_response: null,
            result: 'failure',
            status: 'failure',
            error: error.message,
            reason: error.message, // Use error message as reason for execution history
            page_url_before: pageUrlBefore,
            page_url_after: pageUrlAfter,
            execution_state: executionState, // Save state even on error if available
            job_id: jobId,
            video_segment_id: segmentToken || null
          });

          // Always mark as failed - no retries
          finalResult = 'failure';
          completed = true;
        }
      }

      // Mark leg as completed
      if (workflowId) {
        await this.completeLeg(workflowId, leg.leg_id, finalResult, lastError, jobId);
      }

      // Mark associated action as completed if it exists
      if (leg.action_id) {
        const success = finalResult === 'success';
        await this.markActionCompleted(leg.action_id, success, lastError);
      }

      finalSegmentResult = finalResult;
      finalSegmentError = lastError;

      outcome = {
        leg_id: leg.leg_id,
        result: finalResult,
        iterations: 1, // Always 1 - single attempt
        error: lastError
      };
    } finally {
      this.endLegSegment(jobId, segmentToken, leg, finalSegmentResult, finalSegmentError);
    }

    return outcome;
    })();

    // Execute with timeout wrapper
    try {
      outcome = await Promise.race([
        legExecutionPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Leg execution timed out after ${legTimeout/1000}s`)), legTimeout)
        )
      ]);
    } catch (timeoutError) {
      console.error(`[WorkflowExecutor] Leg ${leg.leg_id} timed out after ${legTimeout/1000}s: ${timeoutError.message}`);
      finalResult = 'failure';
      lastError = timeoutError.message;
      
      // Mark leg as failed due to timeout
      try {
        if (workflowId) {
          await this.completeLeg(workflowId, leg.leg_id, 'failure', lastError, jobId);
        }
      } catch (e) {
        console.error(`[WorkflowExecutor] Error completing timed-out leg: ${e.message}`);
      }
      
      // Mark associated action as failed if it exists
      if (leg.action_id) {
        try {
          await this.markActionCompleted(leg.action_id, false, lastError);
        } catch (e) {
          console.error(`[WorkflowExecutor] Error marking timed-out action: ${e.message}`);
        }
      }
      
      outcome = {
        leg_id: leg.leg_id,
        result: 'failure',
        iterations: 1,
        error: lastError
      };
    }

    return outcome;
  }

  /**
   * Execute all legs in a workflow
   */
  async executeWorkflow(page, jobId, workflowId) {
    console.log(`[WorkflowExecutor] Executing workflow: ${workflowId}`);

    // Get workflow
    const workflow = await this.getWorkflow(workflowId);
    
    if (!workflow || !workflow.legs) {
      throw new Error('Workflow not found or has no legs');
    }

    const results = [];
    const singleActionOnly =
      this.context?.single_action_only === true ||
      this.context?.options?.single_action_only === true ||
      workflow?.options?.single_action_only === true;
    const effectiveJobId = jobId || this.context?.job_id || null;

    if (singleActionOnly) {
      console.log(`[WorkflowExecutor] 🎯 Single-action mode enabled for workflow ${workflowId}`);
      if (effectiveJobId && this.backendLogger) {
        await this.backendLogger.appendJobLog(effectiveJobId, 'info', '🎯 Single-action mode: will execute only the first pending leg', 'WORKFLOW-EXECUTOR', {
          workflow_id: workflowId,
          single_action_only: true
        });
      }
    }

    let executedCount = 0;

    // CRITICAL: Pre-check database for already-executed OR currently-executing actions to avoid re-execution
    // This prevents executing legs that have already been analyzed/tested in this job OR are currently being executed
    // Check for ANY action with leg_id + job_id, regardless of status, because:
    // - 'pending' means the leg is currently being executed
    // - 'success'/'failed_action'/'failed_testing' means the leg was already executed
    const executedLegIds = new Set();
    if (effectiveJobId) {
      try {
        const executedActionsResponse = await axios.get(`${this.backendUrl}/api/actions`, {
          params: {
            job_id: effectiveJobId
          },
          timeout: 5000
        });
        
        if (executedActionsResponse.data && Array.isArray(executedActionsResponse.data)) {
          executedActionsResponse.data.forEach(action => {
            // CRITICAL: Check for ANY action with leg_id, regardless of status
            // This prevents duplicate execution even if the first execution is still in 'pending' status
            if (action.leg_id) {
              executedLegIds.add(action.leg_id);
              console.log(`[WorkflowExecutor] Found leg ${action.leg_id} already associated with this job (status: ${action.status || 'unknown'}) - will skip execution`);
            }
          });
        }
      } catch (checkError) {
        console.warn(`[WorkflowExecutor] Could not pre-check executed actions: ${checkError.message}`);
      }
    }

    // Execute each leg sequentially
    for (const leg of workflow.legs) {
      // Skip if already executed in this job (checked from database)
      if (leg.leg_id && executedLegIds.has(leg.leg_id)) {
        console.log(`[WorkflowExecutor] ⏭️ Skipping leg ${leg.leg_id} - already executed in this job`);
        if (effectiveJobId && this.backendLogger) {
          await this.backendLogger.appendJobLog(effectiveJobId, 'info', `⏭️ Skipped leg ${leg.leg_id} (already executed)`, 'WORKFLOW-EXECUTOR', {
            workflow_id: workflowId,
            leg_id: leg.leg_id,
            reason: 'already_executed'
          });
        }
        continue;
      }
      
      if (singleActionOnly && executedCount >= 1) {
        if (leg.status === 'pending') {
          console.log(`[WorkflowExecutor] ⏭️ Skipping leg ${leg.leg_id} due to single-action mode`);
          await this.completeLeg(workflowId, leg.leg_id, 'skipped', null, effectiveJobId);
          if (effectiveJobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(effectiveJobId, 'info', `⏭️ Skipped leg ${leg.leg_id} (single-action mode)`, 'WORKFLOW-EXECUTOR', {
              workflow_id: workflowId,
              leg_id: leg.leg_id,
              reason: 'single_action_only'
            });
          }
        } else {
          console.log(`[WorkflowExecutor] Skipping leg ${leg.leg_id} - status: ${leg.status}`);
        }
        continue;
      }

      // Skip legs that are not pending (already completed/failed/skipped)
      if (leg.status && leg.status !== 'pending') {
        console.log(`[WorkflowExecutor] Skipping leg ${leg.leg_id} - status: ${leg.status}`);
        continue;
      }

      // Execute the leg
      const result = await this.executeLeg(page, effectiveJobId, workflowId, leg);
      results.push(result);
      executedCount += 1;
      
      // Track executed leg in memory (executeLeg already does this, but ensure it's tracked)
      if (leg.leg_id) {
        executedLegIds.add(leg.leg_id);
      }
    }

    return {
      workflow_id: workflowId,
      legs_executed: results.length,
      results: results
    };
  }

  /**
   * Execute legs directly without requiring workflow_id (for execution-only, no DB updates)
   * @param {Page} page - Playwright page object
   * @param {string} jobId - Job ID for logging
   * @param {Array} legs - Array of leg objects to execute
   * @param {string|null} workflowId - Optional workflow ID for database updates
   * @returns {Object} execution result
   */
  async executeLegsDirectly(page, jobId, legs, workflowId = null) {
    console.log(`[WorkflowExecutor] Executing ${legs.length} legs directly${workflowId ? ` (workflow: ${workflowId})` : ' (no workflow_id - execution only)'}`);
    
    if (!Array.isArray(legs) || legs.length === 0) {
      return {
        workflow_id: workflowId,
        legs_executed: 0,
        results: []
      };
    }

    const results = [];
    const effectiveJobId = jobId || this.context?.job_id || null;
    const singleActionOnly =
      this.context?.single_action_only === true ||
      this.context?.options?.single_action_only === true;

    if (singleActionOnly) {
      console.log(`[WorkflowExecutor] 🎯 Single-action mode enabled`);
      if (effectiveJobId && this.backendLogger) {
        await this.backendLogger.appendJobLog(effectiveJobId, 'info', '🎯 Single-action mode: will execute only the first leg', 'WORKFLOW-EXECUTOR', {
          workflow_id: workflowId,
          single_action_only: true
        });
      }
    }

    let executedCount = 0;

    // Execute each leg sequentially
    for (const leg of legs) {
      if (singleActionOnly && executedCount >= 1) {
        console.log(`[WorkflowExecutor] ⏭️ Skipping leg ${leg.leg_id} due to single-action mode`);
        if (workflowId) {
          await this.completeLeg(workflowId, leg.leg_id, 'skipped', null, effectiveJobId);
        }
        if (effectiveJobId && this.backendLogger) {
          await this.backendLogger.appendJobLog(effectiveJobId, 'info', `⏭️ Skipped leg ${leg.leg_id} (single-action mode)`, 'WORKFLOW-EXECUTOR', {
            workflow_id: workflowId,
            leg_id: leg.leg_id,
            reason: 'single_action_only'
          });
        }
        continue;
      }

      // Execute leg (workflowId is optional - only used for DB updates)
      const result = await this.executeLeg(page, effectiveJobId, workflowId, leg);
      results.push(result);
      executedCount += 1;
    }

    return {
      workflow_id: workflowId,
      legs_executed: results.length,
      results: results
    };
  }

  /**
   * Execute a specific leg by ID (for manual testing)
   */
  async executeSingleLeg(page, jobId, workflowId, legId) {
    const workflow = await this.getWorkflow(workflowId);
    const leg = workflow.legs.find(l => l.leg_id === legId);
    
    if (!leg) {
      throw new Error(`Leg ${legId} not found in workflow ${workflowId}`);
    }

    return await this.executeLeg(page, jobId, workflowId, leg);
  }

  /**
   * Check if script ends with an incomplete string literal
   * Returns true if there's an unmatched quote at the end
   */
  checkIncompleteString(script) {
    if (!script || typeof script !== 'string') {
      return false;
    }
    
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inTemplateLiteral = false;
    let escapeNext = false;
    
    for (let i = 0; i < script.length; i++) {
      const char = script[i];
      
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      
      if (char === '\\') {
        escapeNext = true;
        continue;
      }
      
      // Handle template literals first (they can contain ${})
      if (char === '`' && !inSingleQuote && !inDoubleQuote) {
        inTemplateLiteral = !inTemplateLiteral;
        continue;
      }
      
      // Only check single/double quotes if not in template literal
      if (!inTemplateLiteral) {
        if (char === "'" && !inDoubleQuote) {
          inSingleQuote = !inSingleQuote;
        } else if (char === '"' && !inSingleQuote) {
          inDoubleQuote = !inDoubleQuote;
        }
      }
    }
    
    // If we're still inside a string at the end, it's incomplete
    return inSingleQuote || inDoubleQuote || inTemplateLiteral;
  }

  /**
   * Fix incomplete string literals by closing them
   * This handles cases where OpenAI generates scripts with unclosed quotes
   */
  fixIncompleteStrings(script) {
    if (!script || typeof script !== 'string') {
      return script;
    }
    
    let fixed = script;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inTemplateLiteral = false;
    let escapeNext = false;
    let lastQuoteIndex = -1;
    let lastQuoteType = null;
    
    // First pass: detect incomplete strings
    for (let i = 0; i < fixed.length; i++) {
      const char = fixed[i];
      
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      
      if (char === '\\') {
        escapeNext = true;
        continue;
      }
      
      if (char === '`' && !inSingleQuote && !inDoubleQuote) {
        inTemplateLiteral = !inTemplateLiteral;
        if (inTemplateLiteral) {
          lastQuoteIndex = i;
          lastQuoteType = '`';
        }
        continue;
      }
      
      if (!inTemplateLiteral) {
        if (char === "'" && !inDoubleQuote) {
          inSingleQuote = !inSingleQuote;
          if (inSingleQuote) {
            lastQuoteIndex = i;
            lastQuoteType = "'";
          }
        } else if (char === '"' && !inSingleQuote) {
          inDoubleQuote = !inDoubleQuote;
          if (inDoubleQuote) {
            lastQuoteIndex = i;
            lastQuoteType = '"';
          }
        }
      }
    }
    
    // If we're still inside a string at the end, close it
    if (inSingleQuote || inDoubleQuote || inTemplateLiteral) {
      // Find the last incomplete string and close it
      // Look for common patterns like 'xpath= or "selector= or `url=
      const incompletePattern = new RegExp(`(['"\`])\\s*(xpath|selector|url|text|value|id|name|class|href|src)\\s*=\\s*$`, 'i');
      const match = fixed.substring(lastQuoteIndex).match(incompletePattern);
      
      if (match) {
        // Remove the incomplete string part
        fixed = fixed.substring(0, lastQuoteIndex) + fixed.substring(lastQuoteIndex).replace(incompletePattern, '');
      } else {
        // Just close the quote at the end
        fixed += lastQuoteType || '"';
      }
    }
    
    return fixed;
  }

  /**
   * Clean script to remove function declarations, require statements, etc.
   * Extract only executable code
   */
  cleanScript(script) {
    if (!script || typeof script !== 'string') {
      return script;
    }
    
    let cleaned = script.trim();
    
    // First, extract code from markdown code blocks if present
    // This handles cases where there's text before/after the code block
    const codeBlockRegex = /```[\w]*\s*\n?([\s\S]*?)\n?```/g;
    const codeBlockMatches = [...cleaned.matchAll(codeBlockRegex)];
    if (codeBlockMatches.length > 0) {
      // If code blocks are found, extract only the code from them
      cleaned = codeBlockMatches.map(match => match[1]).join('\n\n');
    } else {
      // No code blocks found, but remove any markdown markers that might be present
      cleaned = cleaned.replace(/^```[\w]*\s*\n?/gm, '');
      cleaned = cleaned.replace(/\n?\s*```$/gm, '');
      cleaned = cleaned.replace(/^\s*```[\w]*\s*$/gm, '');
      cleaned = cleaned.replace(/```[\w]*/g, '');
    }
    
    // Extract function bodies instead of removing functions completely
    // This handles nested braces by matching from function start to matching closing brace
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
          const openBracePos = match.index + match[0].length - 1; // Position of opening {
          let braceCount = 1;
          let pos = openBracePos + 1;
          const bodyStart = pos;
          
          // Find matching closing brace
          while (braceCount > 0 && pos < text.length) {
            if (text[pos] === '{') braceCount++;
            else if (text[pos] === '}') braceCount--;
            pos++;
          }
          
          if (braceCount === 0) {
            // Found matching brace, extract function body (content between braces)
            const bodyEnd = pos - 1; // Position just before closing }
            const functionBody = text.slice(bodyStart, bodyEnd).trim();
            // Replace function with just its body
            text = text.slice(0, start) + functionBody + text.slice(pos);
            pattern.lastIndex = 0; // Reset regex
          }
        }
      }
      
      return text;
    };
    
    cleaned = extractFunctionBodies(cleaned);
    
    // Remove IIFE wrappers (async () => { ... })() or (async function() { ... })()
    cleaned = cleaned.replace(/\(async\s*\([^)]*\)\s*=>\s*\{/g, '');
    cleaned = cleaned.replace(/\(async\s+function\s*\([^)]*\)\s*\{[^}]*\}\)\s*\(\)/g, '');
    cleaned = cleaned.replace(/\(async\s*\(\)\s*=>\s*\{[^}]*\}\)\s*\(\)/g, '');
    
    // Remove require statements (const { chromium } = require('playwright'); etc.)
    cleaned = cleaned.replace(/const\s+\{[^}]*\}\s*=\s*require\s*\([^)]*\)\s*;?\s*/g, '');
    cleaned = cleaned.replace(/const\s+\w+\s*=\s*require\s*\([^)]*\)\s*;?\s*/g, '');
    cleaned = cleaned.replace(/require\s*\([^)]*\)\s*;?\s*/g, '');
    
    // Remove module.exports
    cleaned = cleaned.replace(/module\.exports\s*=\s*[^;]+;?\s*/g, '');
    cleaned = cleaned.replace(/module\.exports\s*=\s*async\s+function[^}]*\}/g, '');
    
    // Remove browser/page creation (we're already in a Playwright context)
    cleaned = cleaned.replace(/const\s+browser\s*=\s*await\s+chromium\.launch[^;]+;?\s*/g, '');
    cleaned = cleaned.replace(/const\s+page\s*=\s*await\s+browser\.newPage[^;]+;?\s*/g, '');
    cleaned = cleaned.replace(/const\s+context\s*=\s*await\s+browser\.newContext[^;]+;?\s*/g, '');
    cleaned = cleaned.replace(/const\s+page\s*=\s*await\s+context\.newPage[^;]+;?\s*/g, '');
    cleaned = cleaned.replace(/await\s+browser\.close[^;]+;?\s*/g, '');
    cleaned = cleaned.replace(/await\s+context\.close[^;]+;?\s*/g, '');
    
    // Remove Node.js-specific code (process.env, process.argv, console.error, etc.)
    cleaned = cleaned.replace(/const\s+\w+\s*=\s*process\.env\.\w+/g, '');
    cleaned = cleaned.replace(/process\.env\.\w+/g, '""');
    cleaned = cleaned.replace(/process\.argv\[\d+\]/g, '""');
    cleaned = cleaned.replace(/console\.(error|log|warn|info)\([^)]*\)\s*;?\s*/g, '');
    cleaned = cleaned.replace(/process\.exit\(\d+\)\s*;?\s*/g, '');
    
    // Remove template variables ({{action}}, {{page_context}}, etc.)
    cleaned = cleaned.replace(/\{\{[^}]+\}\}/g, '');
    
    // Remove comments
    cleaned = cleaned.replace(/\/\/[^\n]*/g, '');
    cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
    
    // Clean up extra whitespace and newlines
    cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n');
    cleaned = cleaned.trim();
    
    // If the script is wrapped in braces, unwrap them
    if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
      cleaned = cleaned.slice(1, -1).trim();
    }
    
    return cleaned;
  }

  /**
   * Parse script to extract meaningful action lines for logging
   */
  parseScriptActions(script) {
    if (!script || typeof script !== 'string') return [];
    
    const actions = [];
    const lines = script.split('\n');
    
    // Common Playwright action patterns - more comprehensive
    const actionPatterns = [
      /await\s+page\.(click|fill|type|press|selectOption|check|uncheck|goto|waitForTimeout|waitFor|screenshot|hover|focus|blur)/i,
      /await\s+page\.locator\([^)]+\)\.(click|fill|type|press|selectOption|check|uncheck|screenshot|hover|focus|blur|waitFor)/i,
      /await\s+page\.mouse\.(move|click|down|up|wheel)/i,
      /await\s+page\.keyboard\.(press|type|down|up)/i,
      /await\s+element\.(click|fill|type|press|selectOption|check|uncheck|screenshot|hover|focus|blur)/i,
      /page\.(click|fill|type|press|selectOption|check|uncheck|goto|waitForTimeout|waitFor|screenshot|hover|focus|blur)/i,
      /page\.locator\([^)]+\)\.(click|fill|type|press|selectOption|check|uncheck|screenshot|hover|focus|blur)/i,
      /page\.mouse\.(move|click|down|up|wheel)/i,
      /page\.keyboard\.(press|type|down|up)/i,
    ];
    
    // Track if we're inside the IIFE body (skip the wrapper lines)
    let insideIIFE = false;
    let braceDepth = 0;
    
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      
      // Skip empty lines and comments
      if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) {
        continue;
      }
      
      // Detect start of async IIFE: "return await (async () => {" or "async () => {"
      if (line.match(/^(return\s+await\s*\(async|async\s*\(\)\s*=>\s*\{)/)) {
        insideIIFE = true;
        // Count opening braces
        braceDepth = (line.match(/\{/g) || []).length;
        continue;
      }
      
      // Count braces to detect when we exit the IIFE
      if (insideIIFE) {
        const openBraces = (line.match(/\{/g) || []).length;
        const closeBraces = (line.match(/\}/g) || []).length;
        braceDepth += openBraces - closeBraces;
        
        // If we hit the closing of the IIFE, skip it
        if (braceDepth <= 0 && (line.includes('})();') || line.includes('})()'))) {
          insideIIFE = false;
          continue;
        }
        
        // Skip closing braces that are just structure
        if (line === '}' || line === '});' || line === '})();') {
          continue;
        }
      }
      
      // Skip standalone return statements that are just control flow (but allow return { success: ... })
      if (line.match(/^return\s*;$/)) {
        continue;
      }
      
      // Skip try/catch/if/else/for/while declarations on their own line (but keep their content)
      if (line.match(/^(try|catch|if|else|for|while)\s*[\{\(]$/)) {
        continue;
      }
      
      // Skip variable declarations (but allow if they contain actions)
      if (line.match(/^(const|let|var)\s+\w+\s*=\s*[^a-zA-Z]/) && !line.match(/page\.|element\./)) {
        continue;
      }
      
      // Check if line contains a Playwright action
      for (const pattern of actionPatterns) {
        if (pattern.test(line)) {
          // Clean up the action line for display
          let displayLine = line;
          
          // Remove leading/trailing semicolons and whitespace
          displayLine = displayLine.replace(/^[;\s]+|[;\s]+$/g, '');
          
          // Truncate very long lines but preserve the action
          if (displayLine.length > 150) {
            const match = displayLine.match(/(await\s+)?(page|element|page\.mouse|page\.keyboard|page\.locator)\.([a-zA-Z]+)/);
            if (match) {
              const awaitPart = match[1] || '';
              const objPart = match[2];
              const methodPart = match[3];
              displayLine = `${awaitPart}${objPart}.${methodPart}(...)`;
            } else {
              // Fallback: just truncate
              displayLine = displayLine.substring(0, 147) + '...';
            }
          }
          
          actions.push(displayLine);
          break;
        }
      }
    }
    
    return actions;
  }

  async executeScript(page, script, jobId = null) {
    const startTime = Date.now();
    const originalScriptLength = script?.length || 0;
    
    try {
      // Parse script to extract action lines BEFORE cleaning
      const actionLines = this.parseScriptActions(script);
      console.log(`[WorkflowExecutor] 📋 Parsed ${actionLines.length} action lines from script (length: ${script?.length || 0})`);
      
      // Log script execution start if jobId available
      if (jobId && this.backendLogger) {
        await this.backendLogger.appendJobLog(jobId, 'debug',
          `🎭 Starting script execution`,
          'WORKFLOW-EXECUTOR',
          {
            original_script_length: originalScriptLength,
            script_preview: script?.substring(0, 300) || 'N/A',
            page_url: page.url(),
            action_lines_count: actionLines.length
          }
        );
        
        // Log each action line with [executing] prefix
        console.log(`[WorkflowExecutor] 📋 Logging ${actionLines.length} action lines`);
        if (actionLines.length > 0) {
          for (const actionLine of actionLines) {
            console.log(`[WorkflowExecutor] 📝 Logging action: [executing] ${actionLine.substring(0, 100)}`);
            try {
              await this.backendLogger.appendJobLog(jobId, 'info',
                `[executing] ${actionLine}`,
                'WORKFLOW-EXECUTOR',
                {
                  action_type: 'script_action',
                  action_line: actionLine
                }
              );
            } catch (logError) {
              console.error(`[WorkflowExecutor] ❌ Failed to log action line: ${logError.message}`);
            }
          }
          console.log(`[WorkflowExecutor] ✅ Successfully logged ${actionLines.length} action lines`);
        } else {
          console.warn(`[WorkflowExecutor] ⚠️ No action lines found in script`);
        }
      }
      
      // DO NOT clean or sanitize the script - use it exactly as provided
      if (!script || script.trim().length === 0) {
        const error = 'Script is empty';
        if (jobId && this.backendLogger) {
          await this.backendLogger.appendJobLog(jobId, 'error',
            `❌ ${error}`,
            'WORKFLOW-EXECUTOR',
            {
              original_script_length: originalScriptLength
            }
          );
        }
        throw new Error(error);
      }
      
      // Use script exactly as provided - NO cleaning or sanitization
      const cleanedScript = script;
      
      const urlBefore = page.url();
      const titleBefore = await page.title();
      
      // Log execution start
      if (jobId && this.backendLogger) {
        await this.backendLogger.appendJobLog(jobId, 'debug',
          `▶️ Executing script in Node.js context...`,
          'WORKFLOW-EXECUTOR',
          {
            url_before: urlBefore,
            title_before: titleBefore
          }
        );
      }
      
      // Playwright scripts must execute in Node.js context, not browser context
      // The 'page' object is available in Node.js, not in browser
      // Import human behavior functions
      const { humanClick } = await import('../../browser/human-behavior-wrapper.js');
      const { humanType } = await import('../../browser/human-typing.js');
      const { humanDelay } = await import('../../browser/stealth-config.js');
      
      // Create a wrapper page object that intercepts ALL Playwright methods to log execution
      const createPageWrapper = (pageObj, jobId, backendLogger) => {
        console.log(`[WorkflowExecutor] 🔧 Creating page wrapper for jobId: ${jobId}`);
        const self = this; // Capture 'this' from WorkflowExecutor
        const backendUrl = this.backendUrl;
        const getAuthHeaders = this.getAuthHeaders.bind(this);
        
        // Helper function to log action execution with better formatting
        const logAction = async (methodName, args = []) => {
          if (!jobId || !backendLogger) {
            console.log(`[WorkflowExecutor] ⚠️ logAction called but no jobId or backendLogger: ${methodName}`);
            return;
          }
          
          try {
            // Format action message similar to playwright-action-logger
            const message = formatActionMessage(methodName, args);
            
            console.log(`[WorkflowExecutor] 📝 Logging action: ${message}`);
            
            // Extract details for metadata
            const details = extractActionDetails(methodName, args);
            
            await backendLogger.appendJobLog(jobId, 'info',
              message,
              'PLAYWRIGHT-ACTION',
              {
                action_type: methodName,
                ...details,
                timestamp: new Date().toISOString()
              }
            );
            
            console.log(`[WorkflowExecutor] ✅ Successfully logged action: ${methodName}`);
          } catch (logError) {
            // Don't fail execution if logging fails
            console.error(`[WorkflowExecutor] ❌ Failed to log action: ${logError.message}`, logError);
          }
        };
        
        // Format action message for display (similar to playwright-action-logger)
        const formatActionMessage = (actionType, args) => {
          const actionEmojis = {
            fill: '✍️',
            click: '🖱️',
            type: '⌨️',
            press: '⌨️',
            selectOption: '📋',
            check: '☑️',
            uncheck: '☐',
            goto: '🌐',
            waitForSelector: '⏳',
            waitForTimeout: '⏸️',
            evaluate: '🔍',
            screenshot: '📸',
            hover: '👆',
            focus: '🎯',
            blur: '👋',
            setInputFiles: '📁',
            waitForNavigation: '⏳',
            reload: '🔄',
            goBack: '⬅️',
            goForward: '➡️'
          };
          
          const emoji = actionEmojis[actionType] || '⚙️';
          const selector = args[0] || 'page';
          
          switch (actionType) {
            case 'fill':
              const value = args[1] || '';
              return `${emoji} Filling field "${selector}" with ${value?.length || 0} characters`;
            
            case 'click':
              return `${emoji} Clicking "${selector}"`;
            
            case 'type':
              const text = args[1] || '';
              return `${emoji} Typing ${text?.length || 0} characters into "${selector}"`;
            
            case 'press':
              const key = args[1] || args[0];
              return `${emoji} Pressing key "${key}"${selector !== 'page' ? ` on "${selector}"` : ''}`;
            
            case 'selectOption':
              const values = args[1] || args[0];
              const valuesCount = Array.isArray(values) ? values.length : 1;
              return `${emoji} Selecting option(s) in "${selector}" (${valuesCount} value(s))`;
            
            case 'check':
              return `${emoji} Checking checkbox "${selector}"`;
            
            case 'uncheck':
              return `${emoji} Unchecking checkbox "${selector}"`;
            
            case 'goto':
              return `${emoji} Navigating to "${selector}"`;
            
            case 'waitForSelector':
              return `${emoji} Waiting for selector "${selector}"`;
            
            case 'waitForTimeout':
              return `${emoji} Waiting ${selector}ms`;
            
            case 'evaluate':
              return `${emoji} Evaluating JavaScript on page`;
            
            case 'screenshot':
              return `${emoji} Taking screenshot`;
            
            case 'hover':
              return `${emoji} Hovering over "${selector}"`;
            
            case 'focus':
              return `${emoji} Focusing on "${selector}"`;
            
            case 'blur':
              return `${emoji} Blurring "${selector}"`;
            
            case 'setInputFiles':
              return `${emoji} Uploading file(s) to "${selector}"`;
            
            case 'waitForNavigation':
              return `${emoji} Waiting for navigation`;
            
            case 'reload':
              return `${emoji} Reloading page`;
            
            case 'goBack':
              return `${emoji} Going back in history`;
            
            case 'goForward':
              return `${emoji} Going forward in history`;
            
            default:
              return `${emoji} ${actionType} on "${selector}"`;
          }
        };
        
        // Extract action details for metadata
        const extractActionDetails = (methodName, args) => {
          const details = {};
          
          if (args.length > 0) {
            details.selector = args[0];
          }
          
          switch (methodName) {
            case 'fill':
            case 'type':
              if (args.length > 1) {
                details.value = maskSensitiveValue(args[1]);
                details.value_length = args[1]?.length || 0;
              }
              break;
            case 'press':
              details.key = args[1] || args[0];
              break;
            case 'selectOption':
              const values = args[1] || args[0];
              details.values = Array.isArray(values) ? values : [values];
              details.values_count = Array.isArray(values) ? values.length : 1;
              break;
            case 'waitForTimeout':
              details.timeout_ms = args[0];
              break;
          }
          
          return details;
        };
        
        // Mask sensitive values (passwords, etc.)
        const maskSensitiveValue = (value) => {
          if (!value || typeof value !== 'string') {
            return value;
          }
          
          // Mask if value is longer than 8 chars (likely password)
          if (value.length > 8) {
            return '***' + value.substring(value.length - 2);
          }
          
          return value;
        };
        
        // Wrap click method with human-like behavior AND logging
        const originalClick = pageObj.click.bind(pageObj);
        wrapper.click = async function(selector, options = {}) {
          try {
            // Log the action execution
            await logAction('click', [selector]);
            
            // Get element text for marker label
            let label = 'Click';
            try {
              const element = pageObj.locator(selector).first();
              const text = await element.textContent({ timeout: 1000 }).catch(() => null);
              if (text && text.trim()) {
                label = `Click: ${text.trim().substring(0, 30)}`;
              } else {
                label = `Click: ${selector.substring(0, 30)}`;
              }
            } catch (e) {
              label = `Click: ${selector.substring(0, 30)}`;
            }
            
            // Enhanced click with visibility and stability checks
            const element = pageObj.locator(selector).first();
            
            // Increased timeout for slow-loading elements (60 seconds)
            const visibilityTimeout = options.timeout || 60000;
            
            // Wait for element to be visible with longer timeout
            await element.waitFor({ state: 'visible', timeout: visibilityTimeout });
            
            // Check if element is actually visible (not just in DOM but hidden by CSS)
            const isActuallyVisible = await element.evaluate((el) => {
              const style = window.getComputedStyle(el);
              return style.display !== 'none' && 
                     style.visibility !== 'hidden' && 
                     style.opacity !== '0' &&
                     el.offsetWidth > 0 && 
                     el.offsetHeight > 0;
            }).catch(() => false);
            
            if (!isActuallyVisible) {
              // Try to make element visible by removing hidden styles
              await element.evaluate((el) => {
                el.style.display = '';
                el.style.visibility = '';
                el.style.opacity = '';
              }).catch(() => {});
              
              // Wait a bit for styles to apply
              await pageObj.waitForTimeout(500);
              
              // Re-check visibility
              const isNowVisible = await element.evaluate((el) => {
                const style = window.getComputedStyle(el);
                return style.display !== 'none' && 
                       style.visibility !== 'hidden' && 
                       style.opacity !== '0' &&
                       el.offsetWidth > 0 && 
                       el.offsetHeight > 0;
              }).catch(() => false);
              
              if (!isNowVisible) {
                throw new Error(`Element ${selector} is not visible (hidden by CSS)`);
              }
            }
            
            // Scroll element into view if needed
            await element.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {
              // Ignore scroll errors, continue with click
            });
            
            // Wait a bit for any animations to settle
            await pageObj.waitForTimeout(300);
            
            // Check if element is enabled
            const isEnabled = await element.isEnabled({ timeout: 2000 }).catch(() => true);
            if (!isEnabled) {
              throw new Error(`Element ${selector} is not enabled`);
            }
            
            // Send timeline marker BEFORE human-like click (so it appears early in video)
            if (jobId && backendLogger) {
              await backendLogger.appendJobLog(jobId, 'info',
                `🖱️ ${label}`,
                'WORKFLOW-ACTION',
                {
                  action_type: 'click',
                  selector: selector,
                  timestamp: Date.now(),
                  is_timeline_marker: true,
                  marker_color: '#3b82f6' // Blue for clicks
                }
              );
            }
            
            // Use human-like click with mouse movements and delays
            try {
              // Get element bounding box for mouse movement
              const box = await element.boundingBox();
              
              if (box) {
                // Move mouse to element with curved path (humans don't move in straight lines)
                const offsetX = (Math.random() - 0.5) * 15; // Slightly larger offset
                const offsetY = (Math.random() - 0.5) * 15;
                const targetX = box.x + box.width / 2 + offsetX;
                const targetY = box.y + box.height / 2 + offsetY;
                
                // Move mouse with more steps for smoother, more visible movement
                const steps = Math.floor(Math.random() * 15) + 20; // 20-35 steps
                await pageObj.mouse.move(targetX, targetY, { steps });
                
                // Hover before clicking (humans hover to see hover effects)
                await humanDelay(400, 800); // Longer hover to see menus open
                
                // Perform click
                await element.click({ 
                  ...options,
                  force: options.force || false,
                  timeout: options.timeout || 60000
                });
                
                // Wait after clicking to see menu opens, dropdowns, etc. (humans wait to see result)
                // Longer delay for interactive elements that trigger menus
                if (Math.random() < 0.5) {
                  await humanDelay(600, 1200); // 50% chance: 600-1200ms (for menus)
                } else {
                  await humanDelay(200, 500);  // 50% chance: 200-500ms (quick clicks)
                }
              } else {
                // Fallback to regular click if bounding box unavailable
                await element.click({ 
                  ...options,
                  force: options.force || false,
                  timeout: options.timeout || 60000
                });
                await humanDelay(300, 700);
              }
              
              return;
            } catch (clickError) {
              // If error is about strict mode violation (multiple elements), use first()
              if (clickError.message && clickError.message.includes('strict mode') && clickError.message.includes('matches')) {
                console.warn(`[WorkflowExecutor] Locator ambiguity detected for ${selector}, using first() element`);
                const firstElement = pageObj.locator(selector).first();
                const box = await firstElement.boundingBox();
                
                if (box) {
                  const offsetX = (Math.random() - 0.5) * 15;
                  const offsetY = (Math.random() - 0.5) * 15;
                  const targetX = box.x + box.width / 2 + offsetX;
                  const targetY = box.y + box.height / 2 + offsetY;
                  const steps = Math.floor(Math.random() * 15) + 20;
                  await pageObj.mouse.move(targetX, targetY, { steps });
                  await humanDelay(400, 800);
                }
                
                await firstElement.click({ 
                  ...options,
                  force: options.force || false,
                  timeout: options.timeout || 60000
                });
                await humanDelay(600, 1200);
                return;
              }
              throw clickError;
            }
          } catch (markerError) {
            // Don't fail script execution if marker sending fails
            console.warn(`[WorkflowExecutor] Failed to send click marker: ${markerError.message}`);
            // Still try to click even if marker failed
            const element = pageObj.locator(selector).first();
            return await element.click(options);
          }
        };
        
        // Wrap fill method with human-like typing (mistakes, corrections, delays) AND logging
        const originalFill = pageObj.fill.bind(pageObj);
        wrapper.fill = async function(selector, value, options) {
          try {
            // Log the action execution
            await logAction('fill', [selector, value]);
            
            // Get element label for marker
            let label = 'Input';
            try {
              const element = await pageObj.locator(selector).first();
              const placeholder = await element.getAttribute('placeholder').catch(() => null);
              const name = await element.getAttribute('name').catch(() => null);
              if (placeholder) {
                label = `Input: ${placeholder.substring(0, 30)}`;
              } else if (name) {
                label = `Input: ${name.substring(0, 30)}`;
              } else {
                label = `Input: ${selector.substring(0, 30)}`;
              }
            } catch (e) {
              label = `Input: ${selector.substring(0, 30)}`;
            }
            
            // Send timeline marker BEFORE typing (so it appears early in video)
            if (jobId && backendLogger) {
              await backendLogger.appendJobLog(jobId, 'info',
                `⌨️ ${label}`,
                'WORKFLOW-ACTION',
                {
                  action_type: 'input',
                  selector: selector,
                  value_preview: String(value).substring(0, 50),
                  timestamp: Date.now(),
                  is_timeline_marker: true,
                  marker_color: '#10b981' // Green for inputs
                }
              );
            }
            
            // Use human-like typing with mistakes and corrections
            // Increase typo chance to 15% and add more pauses for better video visibility
            await humanType(pageObj, selector, String(value), {
              minDelay: 100,        // Slower typing (100-300ms between keystrokes)
              maxDelay: 300,
              typoChance: 0.15,     // 15% chance of making a typo
              pauseChance: 0.20,    // 20% chance of pausing mid-typing
              pauseDuration: [600, 1500], // Longer pauses (600-1500ms)
              moveMouseFirst: true   // Move mouse to field first
            });
            
            // Additional pause after completing field (humans verify what they typed)
            await humanDelay(500, 1000);
            
            return;
          } catch (typingError) {
            // If human typing fails, fall back to regular fill
            console.warn(`[WorkflowExecutor] Human typing failed, falling back to regular fill: ${typingError.message}`);
            return await originalFill(selector, value, options);
          }
        };
        
        // Wrap other common Playwright methods to log execution
        const wrapMethod = (methodName, originalMethod) => {
          return async function(...args) {
            console.log(`[WorkflowExecutor] 🔍 Wrapper called for method: ${methodName}`);
            await logAction(methodName, args);
            return await originalMethod.apply(pageObj, args);
          };
        };
        
        // Wrap common page methods
        wrapper.type = wrapMethod('type', pageObj.type.bind(pageObj));
        wrapper.press = wrapMethod('press', pageObj.press.bind(pageObj));
        wrapper.goto = wrapMethod('goto', pageObj.goto.bind(pageObj));
        wrapper.waitForTimeout = wrapMethod('waitForTimeout', pageObj.waitForTimeout.bind(pageObj));
        wrapper.waitFor = wrapMethod('waitFor', pageObj.waitFor.bind(pageObj));
        wrapper.waitForLoadState = wrapMethod('waitForLoadState', pageObj.waitForLoadState.bind(pageObj));
        wrapper.waitForSelector = wrapMethod('waitForSelector', pageObj.waitForSelector.bind(pageObj));
        wrapper.selectOption = wrapMethod('selectOption', pageObj.selectOption.bind(pageObj));
        wrapper.check = wrapMethod('check', pageObj.check.bind(pageObj));
        wrapper.uncheck = wrapMethod('uncheck', pageObj.uncheck.bind(pageObj));
        wrapper.hover = wrapMethod('hover', pageObj.hover.bind(pageObj));
        wrapper.focus = wrapMethod('focus', pageObj.focus.bind(pageObj));
        wrapper.blur = wrapMethod('blur', pageObj.blur.bind(pageObj));
        
        // Wrap locator method to also intercept methods on locators
        const originalLocator = pageObj.locator.bind(pageObj);
        wrapper.locator = function(selector, options) {
          const locator = originalLocator(selector, options);
          
          // Wrap locator methods
          const wrapLocatorMethod = (methodName, originalLocatorMethod) => {
            return async function(...args) {
              await logAction(`locator(${typeof selector === 'string' ? selector.substring(0, 50) : '...'}).${methodName}`, args);
              return await originalLocatorMethod.apply(locator, args);
            };
          };
          
          // Wrap common locator methods
          if (locator.click) {
            const originalLocatorClick = locator.click.bind(locator);
            locator.click = wrapLocatorMethod('click', originalLocatorClick);
          }
          if (locator.fill) {
            const originalLocatorFill = locator.fill.bind(locator);
            locator.fill = wrapLocatorMethod('fill', originalLocatorFill);
          }
          if (locator.type) {
            const originalLocatorType = locator.type.bind(locator);
            locator.type = wrapLocatorMethod('type', originalLocatorType);
          }
          if (locator.press) {
            const originalLocatorPress = locator.press.bind(locator);
            locator.press = wrapLocatorMethod('press', originalLocatorPress);
          }
          if (locator.selectOption) {
            const originalLocatorSelectOption = locator.selectOption.bind(locator);
            locator.selectOption = wrapLocatorMethod('selectOption', originalLocatorSelectOption);
          }
          if (locator.check) {
            const originalLocatorCheck = locator.check.bind(locator);
            locator.check = wrapLocatorMethod('check', originalLocatorCheck);
          }
          if (locator.uncheck) {
            const originalLocatorUncheck = locator.uncheck.bind(locator);
            locator.uncheck = wrapLocatorMethod('uncheck', originalLocatorUncheck);
          }
          if (locator.hover) {
            const originalLocatorHover = locator.hover.bind(locator);
            locator.hover = wrapLocatorMethod('hover', originalLocatorHover);
          }
          if (locator.screenshot) {
            const originalLocatorScreenshot = locator.screenshot.bind(locator);
            locator.screenshot = wrapLocatorMethod('screenshot', originalLocatorScreenshot);
          }
          
          return locator;
        };
        
        // Wrap screenshot method to capture and log screenshots during script execution
        const originalScreenshot = pageObj.screenshot.bind(pageObj);
        wrapper.screenshot = async function(options = {}) {
          try {
            // Log the action execution
            await logAction('screenshot', [options]);
            
            // Take the screenshot
            const screenshotBuffer = await originalScreenshot(options);
            
            // Log and upload screenshot if jobId and backendLogger are available
            if (jobId && backendLogger && backendUrl) {
              try {
                const axios = await import('axios');
                const authHeaders = getAuthHeaders();
                
                const presignedResponse = await axios.default.post(`${backendUrl}/api/upload/presigned-url`, {
                  type: 'screenshot',
                  jobId: jobId,
                  contentType: 'image/png'
                }, {
                  headers: authHeaders
                });
                
                if (presignedResponse.data.key && presignedResponse.data.url) {
                  // Upload screenshot
                  await axios.default.put(presignedResponse.data.url, screenshotBuffer, {
                    headers: { 'Content-Type': 'image/png' },
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity
                  });
                  
                  const screenshotKey = presignedResponse.data.key;
                  
                  // Log screenshot with screenshot_type metadata (like screenshot-type elements)
                  await backendLogger.appendJobLog(jobId, 'info',
                    `📸 Screenshot captured`,
                    'WORKFLOW-EXECUTOR',
                    {
                      screenshot_type: 'script_execution',
                      screenshot_key: screenshotKey,
                      screenshot_file_id: screenshotKey,
                      is_screenshot: true,
                      action_type: 'screenshot',
                      screenshot_options: options
                    }
                  );
                }
              } catch (screenshotLogError) {
                // Don't fail script execution if screenshot logging fails
                console.warn(`[WorkflowExecutor] Failed to log screenshot: ${screenshotLogError.message}`);
              }
            }
            
            return screenshotBuffer;
          } catch (screenshotError) {
            // Re-throw screenshot errors
            throw screenshotError;
          }
        };
        
        // Track which methods we've explicitly wrapped so Proxy can use them
        const wrappedMethods = new Set(Object.keys(wrapper).filter(key => typeof wrapper[key] === 'function'));
        
        // Use Proxy to intercept ALL method calls - always wrap, never return direct references
        const proxy = new Proxy(pageObj, {
          get(target, prop, receiver) {
            const originalValue = target[prop];
            
            // If we've explicitly wrapped this method in our wrapper object, use that
            if (wrappedMethods.has(prop)) {
              return wrapper[prop];
            }
            
            // For all functions, wrap them to log execution
            if (typeof originalValue === 'function') {
              // Bind the function to maintain 'this' context
              const boundFn = originalValue.bind(target);
              return async function(...args) {
                console.log(`[WorkflowExecutor] 🔍 Proxy intercepted method: ${String(prop)}`);
                await logAction(String(prop), args);
                return await boundFn(...args);
              };
            }
            
            // For non-functions (properties), return as-is
            return originalValue;
          },
          // Also proxy property setting to maintain page object behavior
          set(target, prop, value) {
            target[prop] = value;
            return true;
          }
        });
        
        return proxy;
      };
      
      // Create an async function that has access to the wrapped page object
      const executeInNodeContext = async (pageObj, scriptCode, jobId) => {
        // Create wrapped page with action interception
        const wrappedPage = createPageWrapper(pageObj, jobId, this.backendLogger);
        
        // Verify wrapper is working - test that wrappedPage.click exists and is our wrapper
        console.log(`[WorkflowExecutor] 🔍 Testing wrapper: wrappedPage.click is function? ${typeof wrappedPage.click === 'function'}`);
        console.log(`[WorkflowExecutor] 🔍 Testing wrapper: wrappedPage.locator is function? ${typeof wrappedPage.locator === 'function'}`);
        
        // Use string concatenation (not template literals) to avoid escaping issues
        // This allows the script code to contain backticks, ${}, etc. without problems
        const functionBody = 'return (async function() {\n' + scriptCode + '\n})();';
        
        // Create a function with page as parameter
        const fn = new Function('page', functionBody);
        return await fn(wrappedPage);
      };
      
      // Fix incomplete string literals automatically instead of failing
      if (this.checkIncompleteString && this.checkIncompleteString(cleanedScript)) {
        console.log(`[WorkflowExecutor] ⚠️ Detected incomplete string literals, attempting to fix...`);
        const originalScript = cleanedScript;
        cleanedScript = this.fixIncompleteStrings(cleanedScript);
        
        if (jobId && this.backendLogger) {
          await this.backendLogger.appendJobLog(jobId, 'warn',
            `⚠️ Fixed incomplete string literals in script`,
            'WORKFLOW-EXECUTOR',
            {
              original_length: originalScript.length,
              fixed_length: cleanedScript.length,
              script_preview: cleanedScript.substring(0, 500)
            }
          );
        }
        
        // Verify the fix worked
        if (this.checkIncompleteString(cleanedScript)) {
          const errorMsg = 'Script contains incomplete string literals that could not be fixed';
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'error',
              `❌ ${errorMsg}`,
              'WORKFLOW-EXECUTOR',
              {
                script_preview: cleanedScript.substring(0, 500),
                script_length: cleanedScript.length
              }
            );
          }
          throw new Error(errorMsg);
        }
      }
      
      // Validate script syntax using JavaScript parser
      try {
        new Function(cleanedScript);
      } catch (syntaxError) {
        const errorMsg = `Script syntax error: ${syntaxError.message}`;
        if (jobId && this.backendLogger) {
          await this.backendLogger.appendJobLog(jobId, 'error',
            `❌ ${errorMsg}`,
            'WORKFLOW-EXECUTOR',
            {
              script_preview: cleanedScript.substring(0, 500),
              script_length: cleanedScript.length,
              syntax_error: syntaxError.message
            }
          );
        }
        throw new Error(errorMsg);
      }
      
      // Wrap script execution with timeout (increased to 45 seconds to match workflow step timeout)
      // Re-check for CAPTCHA right before executing the script with up to 10 attempts
      await this.resolveCaptchaWithRetries(page, jobId, 10, 'pre-script');
      
      // Increased timeout to 90 seconds for complex interactions and CAPTCHA handling
      const result = await Promise.race([
        executeInNodeContext(page, cleanedScript, jobId),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Script execution timeout after 90 seconds')), 90000)
        )
      ]);
      
      const urlAfter = page.url();
      const titleAfter = await page.title();
      const executionTime = Date.now() - startTime;

      // Log successful execution
      if (jobId && this.backendLogger) {
        await this.backendLogger.appendJobLog(jobId, 'info',
          `✅ Script executed successfully (${executionTime}ms)`,
          'WORKFLOW-EXECUTOR',
          {
            execution_time_ms: executionTime,
            url_before: urlBefore,
            url_after: urlAfter,
            title_before: titleBefore,
            title_after: titleAfter,
            url_changed: urlBefore !== urlAfter,
            title_changed: titleBefore !== titleAfter,
            result_preview: typeof result === 'object' ? JSON.stringify(result).substring(0, 500) : String(result).substring(0, 500)
          }
        );
      }

      return {
        success: true,
        result: result,
        error: null
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      
      // Log execution failure
      if (jobId && this.backendLogger) {
        await this.backendLogger.appendJobLog(jobId, 'error',
          `❌ Script execution failed: ${error.message}`,
          'WORKFLOW-EXECUTOR',
          {
            execution_time_ms: executionTime,
            error_message: error.message,
            error_stack: error.stack?.substring(0, 1000),
            original_script_preview: script?.substring(0, 500) || 'N/A',
            cleaned_script_preview: this.cleanScript(script)?.substring(0, 500) || 'N/A',
            page_url: page.url()
          }
        );
      }
      
      return {
        success: false,
        result: null,
        error: error.message
      };
    }
  }

  /**
   * Upload screenshot via backend
   */
  async uploadScreenshot(jobId, screenshotBuffer, suffix) {
    try {
      // Use the correct upload endpoint
      const response = await axios.post(
        `${this.backendUrl}/upload/screenshot`,
        {
          jobId: jobId,
          data: screenshotBuffer.toString('base64'),
          type: 'image/png',
          metadata: {
            suffix: suffix,
            action: 'workflow_executor'
          }
        },
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );

      return response.data.file_id;
    } catch (error) {
      console.error('[WorkflowExecutor] Screenshot upload failed:', error.message);
      return null;
    }
  }

  /**
   * Get workflow from backend
   */
  async getWorkflow(workflowId) {
    try {
      const response = await axios.get(`${this.backendUrl}/api/workflows/${workflowId}`);
      return response.data;
    } catch (error) {
      console.error('[WorkflowExecutor] Error getting workflow:', error.message);
      throw error;
    }
  }

  /**
   * Update leg status
   */
  async updateLegStatus(workflowId, legId, status, jobId = null) {
    return await this.updateLeg(workflowId, legId, { status }, jobId);
  }

  /**
   * Update leg fields
   */
  async updateLeg(workflowId, legId, updates, jobId = null) {
    try {
      const payload = { ...updates };
      if (jobId) {
        payload.job_id = jobId;
      }
      
      await axios.put(
        `${this.backendUrl}/api/workflows/${workflowId}/legs/${legId}`,
        payload
      );
    } catch (error) {
      console.error('[WorkflowExecutor] Error updating leg:', error.message);
    }
  }

  /**
   * Add iteration to leg
   */
  async addIteration(workflowId, legId, iteration) {
    try {
      await axios.post(
        `${this.backendUrl}/api/workflows/${workflowId}/legs/${legId}/iterations`,
        iteration
      );
    } catch (error) {
      console.error('[WorkflowExecutor] Error adding iteration:', error.message);
    }
  }

  /**
   * Mark leg as completed
   */
  async completeLeg(workflowId, legId, finalResult, error = null, jobId = null) {
    try {
      const payload = { final_result: finalResult, error };
      if (jobId) {
        payload.job_id = jobId;
      }
      
      await axios.post(
        `${this.backendUrl}/api/workflows/${workflowId}/legs/${legId}/complete`,
        payload
      );
    } catch (error) {
      console.error('[WorkflowExecutor] Error completing leg:', error.message);
    }
  }

  /**
   * Update job substatus in real-time
   * @param {string} jobId - Job ID
   * @param {string} substatus - Current substatus
   * @param {object} progress - Progress details (optional)
   */
  async updateJobSubstatus(jobId, substatus, progress = {}) {
    try {
      await axios.post(`${this.backendUrl}/jobs/${jobId}/substatus`, {
        substatus, 
        ...progress,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      // Silent fail - don't block execution
      console.error(`Failed to update substatus: ${error.message}`);
    }
  }

  /**
   * Log workflow decision to job history
   * Shows which workflow from MongoDB is being used (ID and name)
   */
  async logWorkflowDecision(decision, details) {
    try {
      const jobId = this.context.job_id;
      if (!jobId) return;
      
      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'info',
        message: `🔄 WORKFLOW: ${decision}`,
        component: 'WORKFLOW-EXECUTOR',
        metadata: {
          workflow_decision: true,
          workflow_id: this.context.workflow_template_id,
          workflow_name: this.workflowTemplate?.name,
          details: details,
          prompts_count: this.workflowTemplate?.prompts?.length || 0,
          timestamp: new Date().toISOString()
        }
      });
      
      console.log(`[WorkflowExecutor] 📝 Logged workflow: ${decision}`);
    } catch (error) {
      console.error('[WorkflowExecutor] Error logging workflow decision:', error.message);
    }
  }
  
  /**
   * Log prompt usage to job history
   * Shows which prompt was used (custom from template or default from database)
   */
  async logPromptUsage(promptName, source, promptText, payload) {
    try {
      const jobId = this.context.job_id;
      if (!jobId) return;
      
      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'info',
        message: `📝 PROMPT USAGE: "${promptName}" from ${source}`,
        component: 'WORKFLOW-EXECUTOR',
        metadata: {
          prompt_usage: true,
          prompt_name: promptName,
          prompt_source: source, // 'workflow-template' or 'database'
          prompt_text_preview: promptText ? promptText.substring(0, 200) : 'N/A',
          workflow_template_id: this.context.workflow_template_id || null,
          workflow_template_name: this.workflowTemplate?.name || null,
          payload_keys: Object.keys(payload || {}),
          timestamp: new Date().toISOString()
        }
      });
      
      console.log(`[WorkflowExecutor] 📝 Logged prompt usage: ${promptName} (${source})`);
    } catch (error) {
      console.error('[WorkflowExecutor] Error logging prompt usage:', error.message);
    }
  }
}

export default WorkflowExecutor;

