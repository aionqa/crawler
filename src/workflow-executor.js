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
      const response = await axios.get(`${this.backendUrl}/jobs/${jobId}`, {
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

    // Mark leg as in progress
    await this.updateLegStatus(workflowId, leg.leg_id, 'in_progress', jobId);

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
              playwrightScript = codeBlockMatches[0][1].trim();
            }
          }
          
          if (!playwrightScript || playwrightScript.trim().length === 0) {
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
          const { addHumanBehavior, humanDelay } = await import('./stealth-config.js');
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
          error: executionResult?.error || null, // Keep script error for technical details
          failure_reason: completionReason, // Clear reasoning from determine completion
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
          await this.addIteration(workflowId, leg.leg_id, {
            screenshot_before: screenshotBeforeKey || null,
            screenshot_after: null,
            html_sent: htmlContent || null,
            script_executed: typeof playwrightScript !== 'undefined' ? playwrightScript : null,
            openai_request: null,
            openai_response: null,
            result: 'failure',
            error: error.message,
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
      await this.completeLeg(workflowId, leg.leg_id, finalResult, lastError, jobId);

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

    // Execute each leg sequentially
    for (const leg of workflow.legs) {
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

      if (leg.status === 'pending') {
        const result = await this.executeLeg(page, effectiveJobId, workflowId, leg);
        results.push(result);
        executedCount += 1;
      } else {
        console.log(`[WorkflowExecutor] Skipping leg ${leg.leg_id} - status: ${leg.status}`);
      }
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

  async executeScript(page, script, jobId = null) {
    const startTime = Date.now();
    const originalScriptLength = script?.length || 0;
    
    try {
      // Log script execution start if jobId available
      if (jobId && this.backendLogger) {
        await this.backendLogger.appendJobLog(jobId, 'debug',
          `🎭 Starting script execution`,
          'WORKFLOW-EXECUTOR',
          {
            original_script_length: originalScriptLength,
            script_preview: script?.substring(0, 300) || 'N/A',
            page_url: page.url()
          }
        );
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
      // Create a wrapper page object that intercepts clicks and fills to send timeline markers
      const createPageWrapper = (pageObj, jobId, backendLogger) => {
        const wrapper = Object.create(pageObj);
        
        // Wrap click method to send timeline marker
        const originalClick = pageObj.click.bind(pageObj);
        wrapper.click = async function(selector, options) {
          try {
            // Get element text for marker label
            let label = 'Click';
            try {
              const element = await pageObj.locator(selector).first();
              const text = await element.textContent({ timeout: 1000 }).catch(() => null);
              if (text && text.trim()) {
                label = `Click: ${text.trim().substring(0, 30)}`;
              } else {
                label = `Click: ${selector.substring(0, 30)}`;
              }
            } catch (e) {
              label = `Click: ${selector.substring(0, 30)}`;
            }
            
            // Send timeline marker
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
          } catch (markerError) {
            // Don't fail script execution if marker sending fails
            console.warn(`[WorkflowExecutor] Failed to send click marker: ${markerError.message}`);
          }
          
          return await originalClick(selector, options);
        };
        
        // Wrap fill method to send timeline marker
        const originalFill = pageObj.fill.bind(pageObj);
        wrapper.fill = async function(selector, value, options) {
          try {
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
            
            // Send timeline marker
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
          } catch (markerError) {
            // Don't fail script execution if marker sending fails
            console.warn(`[WorkflowExecutor] Failed to send input marker: ${markerError.message}`);
          }
          
          return await originalFill(selector, value, options);
        };
        
        // Copy all other methods and properties
        Object.setPrototypeOf(wrapper, pageObj);
        return wrapper;
      };
      
      // Create an async function that has access to the wrapped page object
      const executeInNodeContext = async (pageObj, scriptCode, jobId) => {
        // Create wrapped page with action interception
        const wrappedPage = createPageWrapper(pageObj, jobId, this.backendLogger);
        
        // Use string concatenation (not template literals) to avoid escaping issues
        // This allows the script code to contain backticks, ${}, etc. without problems
        const functionBody = 'return (async function() {\n' + scriptCode + '\n})();';
        
        // Create a function with page as parameter
        const fn = new Function('page', functionBody);
        return await fn(wrappedPage);
      };
      
      // Validate script syntax before execution to catch errors early
      if (this.checkIncompleteString && this.checkIncompleteString(cleanedScript)) {
        const errorMsg = 'Script contains incomplete string literals or template literals';
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
      
      // Wrap script execution with timeout (increased to 45 seconds to match workflow step timeout)
      const result = await Promise.race([
        executeInNodeContext(page, cleanedScript, jobId),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Script execution timeout after 45 seconds')), 45000)
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

