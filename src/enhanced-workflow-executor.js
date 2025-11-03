import axios from 'axios';

/**
 * EnhancedWorkflowExecutor
 * Enhanced version of WorkflowExecutor with additional features
 * Handles execution of workflow legs with iterative OpenAI testing
 * Each leg is tested until OpenAI confirms completion or failure
 */
class EnhancedWorkflowExecutor {
  constructor(backendUrl, aiLogger, backendLogger, context = {}) {
    this.backendUrl = backendUrl;
    this.aiLogger = aiLogger;
    this.backendLogger = backendLogger;
    this.context = context;
    this.workflowTemplate = null;
    this.maxIterations = 2; // Maximum iterations per leg (reduced for faster execution)
    this.maxAiRequestsPerLeg = 4; // Maximum AI requests per leg (2 iterations × 2 requests each)
  }

  /**
   * Load workflow template from backend
   */
  async loadWorkflowTemplate() {
    if (!this.context.workflow_template_id) {
      console.error(`[EnhancedWorkflowExecutor] ❌ No workflow template ID provided - workflows are mandatory!`);
      throw new Error('workflow_template_id is required - all jobs must use workflows stored in MongoDB');
    }

    try {
      const response = await axios.get(`${this.backendUrl}/api/workflow-templates/${this.context.workflow_template_id}`);
      this.workflowTemplate = response.data;
      console.log(`[EnhancedWorkflowExecutor] ✅ Loaded workflow: "${this.workflowTemplate.name}" (ID: ${this.context.workflow_template_id})`);
      console.log(`[EnhancedWorkflowExecutor] 📄 Workflow contains ${this.workflowTemplate.prompts?.length || 0} prompts`);
      
      // Log template details
      if (this.workflowTemplate.prompts && this.workflowTemplate.prompts.length > 0) {
        console.log(`[EnhancedWorkflowExecutor] 📝 Custom prompts in template:`);
        this.workflowTemplate.prompts.forEach(p => {
          console.log(`[EnhancedWorkflowExecutor]    - ${p.name}: ${p.template?.substring(0, 80)}...`);
        });
      }
      
      await this.logWorkflowDecision(
        `Using workflow: "${this.workflowTemplate.name}" (ID: ${this.context.workflow_template_id})`,
        `Workflow contains ${this.workflowTemplate.prompts?.length || 0} prompts`
      );
      
      return this.workflowTemplate;
    } catch (error) {
      console.error(`[EnhancedWorkflowExecutor] ❌ Failed to load workflow template: ${error.message}`);
      throw new Error(`Failed to load workflow template ${this.context.workflow_template_id}: ${error.message}`);
    }
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
      console.error(`[EnhancedWorkflowExecutor] Error checking job status:`, error.message);
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
      console.log(`[EnhancedWorkflowExecutor] Marked action ${actionId} as started`);
    } catch (error) {
      // Silently ignore 404 errors (action doesn't exist, which is fine for workflow-based testing)
      if (error.response && error.response.status === 404) {
        console.log(`[EnhancedWorkflowExecutor] Action ${actionId} not found (workflow-based testing, no action needed)`);
      } else {
        console.error(`[EnhancedWorkflowExecutor] Error marking action as started:`, error.message);
      }
    }
  }

  /**
   * Mark an action as completed
   * @param {string} actionId - Action ID to mark as completed
   * @param {boolean} success - Whether the action was successful
   * @param {string} error - Error message if action failed
   * @param {string} screenshotBefore - Screenshot before action
   * @param {string} screenshotAfter - Screenshot after action
   */
  async markActionCompleted(actionId, success = true, error = null, screenshotBefore = null, screenshotAfter = null) {
    try {
      await axios.post(`${this.backendUrl}/actions/${actionId}/complete`, {
        success,
        error,
        screenshot_before: screenshotBefore,
        screenshot_after: screenshotAfter
      }, {
        timeout: 5000
      });
      console.log(`[EnhancedWorkflowExecutor] Marked action ${actionId} as ${success ? 'completed' : 'failed'} with screenshots`);
    } catch (err) {
      // Silently ignore 404 errors (action doesn't exist, which is fine for workflow-based testing)
      if (err.response && err.response.status === 404) {
        console.log(`[EnhancedWorkflowExecutor] Action ${actionId} not found (workflow-based testing, no action needed)`);
      } else {
        console.error(`[EnhancedWorkflowExecutor] Error marking action as completed:`, err.message);
      }
    }
  }

  /**
   * Execute a single workflow leg
   * @param {Page} page - Playwright page object
   * @param {string} jobId - Job ID for logging
   * @param {string} workflowId - Workflow ID
   * @param {Object} leg - Leg object from workflow
   * @returns {Object} execution result
   */
  async executeStep(page, jobId, workflowId, step) {
    console.log(`[EnhancedWorkflowExecutor] Executing step: ${step.id} - ${step.name}`);

    // Load workflow template if not already loaded
    if (!this.workflowTemplate) {
      await this.loadWorkflowTemplate();
    }

    // Check job status before starting
    const jobStatus = await this.checkJobStatus(jobId);
    if (jobStatus !== 'running') {
      console.log(`[EnhancedWorkflowExecutor] Job ${jobId} status is ${jobStatus}, stopping step execution`);
      return {
        step_id: step.id,
        result: 'cancelled',
        iterations: 0,
        error: `Job status is ${jobStatus}`
      };
    }

    // Mark step as in progress
    await this.updateStepStatus(workflowId, step.id, 'in_progress', jobId);

    // Update job statistics - page being processed
    await this.updateJobStatistics(jobId, {
      pages_processed: 1,
      pages_added: 1
    });

    // Mark associated action as started if it exists
    if (leg.action_id) {
      await this.markActionStarted(leg.action_id, jobId);
    }

    let iteration = 0;
    let completed = false;
    let finalResult = 'failure';
    let lastError = null;
    let aiRequestCount = 0;

    while (iteration < this.maxIterations && !completed && aiRequestCount < this.maxAiRequestsPerLeg) {
      iteration++;
      console.log(`[EnhancedWorkflowExecutor] Leg ${leg.leg_id} - Iteration ${iteration}/${this.maxIterations} (AI requests: ${aiRequestCount}/${this.maxAiRequestsPerLeg})`);

      // Check job status before each iteration
      const jobStatus = await this.checkJobStatus(jobId);
      if (jobStatus !== 'running') {
        console.log(`[EnhancedWorkflowExecutor] Job ${jobId} status changed to ${jobStatus}, stopping leg execution`);
        finalResult = 'cancelled';
        completed = true;
        lastError = `Job status changed to ${jobStatus}`;
        break;
      }

      // Refetch workflow to get latest leg state with iterations
      if (iteration > 1) {
        const latestWorkflow = await this.getWorkflow(workflowId);
        leg = latestWorkflow.legs.find(l => l.leg_id === leg.leg_id) || leg;
        console.log(`[EnhancedWorkflowExecutor] Refetched leg with ${leg.iterations?.length || 0} previous iterations`);
      }

      try {
        // Step 1: Take screenshot before action
        const screenshotBefore = await page.screenshot({ fullPage: true, type: 'png' });
        const screenshotBeforeKey = await this.uploadScreenshot(jobId, screenshotBefore, 'before');
        const screenshotBeforeBase64 = screenshotBefore.toString('base64');

        // Step 2: Get HTML content (FULL - no trimming)
        const htmlContent = await page.content();
        
        // Get interactive elements for context
        const interactiveElements = await page.$$eval('[role="button"], button, a, input, select, textarea, [onclick], [tabindex]', 
          elements => elements.map(el => ({
            tag: el.tagName,
            id: el.id,
            class: el.className,
            text: el.textContent?.trim().substring(0, 100),
            type: el.type,
            name: el.name
          }))
        ).catch(() => []);
        
        const interactiveElementsJson = JSON.stringify(interactiveElements, null, 2);
        
        // Update job statistics - elements processed
        await this.updateJobStatistics(jobId, {
          elements_processed: interactiveElements.length,
          elements_added: interactiveElements.length
        });
        
        // Get Playwright analysis (form structure, inputs, buttons)
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

        // Step 3: Ask OpenAI for Playwright script with FULL context and previous logs
        let playwrightScript = leg.playwright_script;
        
        if (!playwrightScript || iteration > 1) {
          // Build previous logs context from leg iterations
          let previousLogs = '';
          if (leg.iterations && leg.iterations.length > 0) {
            previousLogs = leg.iterations.map((iter, idx) => 
              `Iteration ${iter.iteration_number}:
  Script: ${iter.script_executed?.substring(0, 500) || 'N/A'}
  Result: ${iter.result}
  Error: ${iter.error || 'None'}`
            ).join('\n\n');
          }
          
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

          console.log(`[EnhancedWorkflowExecutor] Requesting script from OpenAI (HTML: ${htmlContent.length} chars, screenshot: ${screenshotBeforeBase64.length} chars, iteration: ${iteration})`);

          // Update sub-status with descriptive information
          const legDescription = leg.description || 'Unknown workflow step';
          await this.updateJobSubstatus(jobId, `Generating test script for: ${legDescription}`, {
            current_page: page.url(),
            workflow_leg: leg.leg_id,
            iteration: iteration
          });

          console.log(`[EnhancedWorkflowExecutor] DEBUG: About to call makeAICallWithPrompt`);
          aiRequestCount++;
          if (aiRequestCount > this.maxAiRequestsPerLeg) {
            console.log(`[EnhancedWorkflowExecutor] AI request limit reached (${this.maxAiRequestsPerLeg}), stopping leg execution`);
            throw new Error(`AI request limit exceeded: ${aiRequestCount}/${this.maxAiRequestsPerLeg}`);
          }
          
          // Find prompt from workflow steps - prompts MUST be embedded in step configs
          const scriptStep = this.findAIPromptStep();
          const customScriptTemplate = scriptStep ? (scriptStep.config?.template || scriptStep.config?.user_message_template) : null;
          
          if (!customScriptTemplate) {
            throw new Error(`No embedded prompt template found in workflow steps. All prompts must be embedded in workflow step configs. Step: ${scriptStep?.name || 'unknown'}`);
          }
          
          const scriptPromptSource = 'workflow-step';
          const promptIdentifier = scriptStep ? (scriptStep.id || scriptStep.name || 'workflow-step') : 'enhanced-workflow-executor';
          
          // Log prompt usage
          await this.logPromptUsage(promptIdentifier, scriptPromptSource, customScriptTemplate, scriptRequest);
          
          const scriptResponse = await this.aiLogger.makeAICallWithPrompt(
            promptIdentifier,
            scriptRequest,
            jobId,
            'enhanced-workflow-executor',
            page.url(),
            screenshotBeforeKey,  // screenshotId for tracking
            scriptRequest,  // Pass scriptRequest as sourcePayload for full attachment logging
            customScriptTemplate // Pass custom template (required - no fallback to database)
          );
          console.log(`[EnhancedWorkflowExecutor] DEBUG: makeAICallWithPrompt completed successfully`);

          console.log(`[EnhancedWorkflowExecutor] DEBUG: scriptResponse type: ${typeof scriptResponse}`);
          console.log(`[EnhancedWorkflowExecutor] DEBUG: scriptResponse keys: ${scriptResponse ? Object.keys(scriptResponse) : 'null'}`);
          console.log(`[EnhancedWorkflowExecutor] DEBUG: has playwright_script: ${!!scriptResponse?.playwright_script}`);
          console.log(`[EnhancedWorkflowExecutor] DEBUG: has code: ${!!scriptResponse?.code}`);
          
          console.log(`[EnhancedWorkflowExecutor] DEBUG: Validation check:`);
          console.log(`[EnhancedWorkflowExecutor] DEBUG: !scriptResponse = ${!scriptResponse}`);
          console.log(`[EnhancedWorkflowExecutor] DEBUG: !scriptResponse.playwright_script = ${!scriptResponse?.playwright_script}`);
          console.log(`[EnhancedWorkflowExecutor] DEBUG: !scriptResponse.code = ${!scriptResponse?.code}`);
          console.log(`[EnhancedWorkflowExecutor] DEBUG: !scriptResponse.script = ${!scriptResponse?.script}`);
          console.log(`[EnhancedWorkflowExecutor] DEBUG: (!scriptResponse.playwright_script && !scriptResponse.code && !scriptResponse.script) = ${(!scriptResponse?.playwright_script && !scriptResponse?.code && !scriptResponse?.script)}`);
          console.log(`[EnhancedWorkflowExecutor] DEBUG: Full validation result = ${!scriptResponse || (!scriptResponse.playwright_script && !scriptResponse.code && !scriptResponse.script)}`);
          
          if (!scriptResponse || (!scriptResponse.playwright_script && !scriptResponse.code && !scriptResponse.script)) {
            console.warn(`[EnhancedWorkflowExecutor] OpenAI did not return a valid Playwright script. Response: ${JSON.stringify(scriptResponse)}`);
            throw new Error('OpenAI did not return a valid Playwright script');
          }

          // Check for script field first (most common), then playwright_script, then code field
          playwrightScript = scriptResponse.script || scriptResponse.playwright_script || scriptResponse.code;
          
          // Update leg with script
          await this.updateStep(workflowId, step.id, { 
            playwright_script: playwrightScript,
            update_action: true  // Signal backend to also update action document
          });
        }

        console.log(`[EnhancedWorkflowExecutor] Executing script for leg ${leg.leg_id}`);

        // Step 4: Execute Playwright script
        const executionResult = await this.executeScript(page, playwrightScript);

        // Step 5: Take screenshot after action
        const screenshotAfter = await page.screenshot({ fullPage: true, type: 'png' });
        const screenshotAfterKey = await this.uploadScreenshot(jobId, screenshotAfter, 'after');
        const screenshotAfterBase64 = screenshotAfter.toString('base64');

        // Step 6: Get HTML after action (FULL - no trimming)
        const htmlAfter = await page.content();

        // Build previous logs for verification context
        const verificationLogs = leg.iterations ? leg.iterations.map((iter, idx) => 
          `Iteration ${iter.iteration_number}: ${iter.result} - ${iter.error || 'No error'}`
        ).join('\n') : '';

        // Step 7: Ask OpenAI to verify with FULL context and previous logs
        const verificationRequest = {
          // Map to template field names
          leg_name: leg.description,
          leg_action: leg.type,
          expected_outcome: leg.test_instructions,
          before_url: page.url(),
          before_title: await page.title(),
          after_url: page.url(),
          after_title: await page.title(),
          after_visible_text: await page.evaluate(() => document.body.innerText),
          dom_snapshot: htmlAfter,  // Use HTML after action as DOM snapshot
          // Additional context for AI
          page_url: page.url(),
          html_before: htmlContent,  // FULL HTML - no trimming
          html_after: htmlAfter,     // FULL HTML - no trimming
          screenshot_base64: screenshotAfterBase64,  // Include after screenshot inline for Vision API
          leg_description: leg.description,
          leg_type: leg.type,
          test_instructions: leg.test_instructions,
          script: playwrightScript,
          execution_result: JSON.stringify(executionResult, null, 2),
          screenshot_before: screenshotBeforeKey,
          screenshot_after: screenshotAfterKey,
          previous_logs: verificationLogs,
          iteration_number: iteration,
          additional_prompt_text: this.context.additional_prompt_text || ''  // Project-specific additional context
        };

        console.log(`[EnhancedWorkflowExecutor] Verifying with OpenAI (HTML before: ${htmlContent.length} chars, after: ${htmlAfter.length} chars, screenshot: ${screenshotAfterBase64.length} chars)`);

        aiRequestCount++;
        if (aiRequestCount > this.maxAiRequestsPerLeg) {
          console.log(`[EnhancedWorkflowExecutor] AI request limit reached (${this.maxAiRequestsPerLeg}), stopping leg execution`);
          throw new Error(`AI request limit exceeded: ${aiRequestCount}/${this.maxAiRequestsPerLeg}`);
        }

        // Find prompt from workflow steps - prompts MUST be embedded in step configs
        const verifyStep = this.findAIPromptStep();
        const customVerifyTemplate = verifyStep ? (verifyStep.config?.template || verifyStep.config?.user_message_template) : null;
        
        if (!customVerifyTemplate) {
          throw new Error(`No embedded prompt template found in workflow steps for verification. All prompts must be embedded in workflow step configs. Step: ${verifyStep?.name || 'unknown'}`);
        }
        
        const verifyPromptSource = 'workflow-step';
        const verifyPromptIdentifier = verifyStep ? (verifyStep.id || verifyStep.name || 'workflow-step') : 'enhanced-workflow-executor';
        
        // Log prompt usage
        await this.logPromptUsage(verifyPromptIdentifier, verifyPromptSource, customVerifyTemplate, verificationRequest);
        
        const verificationResponse = await this.aiLogger.makeAICallWithPrompt(
          verifyPromptIdentifier,
          verificationRequest,
          jobId,
          'enhanced-workflow-executor',
          page.url(),
          screenshotAfterKey,  // screenshotId for tracking
          verificationRequest,  // Pass verificationRequest as sourcePayload for full attachment logging
          customVerifyTemplate // Pass custom template (required - no fallback to database)
        );

        // Step 8: Record iteration with FULL data (no trimming)
        await this.addIteration(workflowId, leg.leg_id, {
          screenshot_before: screenshotBeforeKey,
          screenshot_after: screenshotAfterKey,
          html_sent: htmlContent,  // FULL HTML - no trimming for proper context
          html_after: htmlAfter,   // FULL HTML after execution
          script_executed: playwrightScript,
          openai_request: verificationRequest,
          openai_response: verificationResponse,
          result: verificationResponse.status || 'incomplete',
          error: executionResult.error || null
        });

        // Step 9: Check if OpenAI says we're done
        // FIX: Handle both old format (status/completed) and new format (success/confidence)
        if (verificationResponse.success === true || verificationResponse.status === 'completed' || verificationResponse.completed === true) {
          console.log(`[EnhancedWorkflowExecutor] Leg ${leg.leg_id} completed successfully`);
          completed = true;
          finalResult = 'success';
        } else if (verificationResponse.success === false && verificationResponse.can_retry === false) {
          // Only fail permanently if explicitly marked as non-retryable
          console.log(`[EnhancedWorkflowExecutor] Leg ${leg.leg_id} failed permanently (explicitly marked as non-retryable)`);
          completed = true;
          finalResult = 'failure';
          lastError = verificationResponse.description || verificationResponse.reason || 'Unknown failure';
        } else if (verificationResponse.success === false && iteration >= this.maxIterations) {
          // Fail permanently only after max iterations
          console.log(`[EnhancedWorkflowExecutor] Leg ${leg.leg_id} failed permanently (max iterations reached)`);
          completed = true;
          finalResult = 'failure';
          lastError = verificationResponse.description || verificationResponse.reason || 'Max iterations reached';
        } else {
          // Continue to next iteration (including success: false with can_retry: true/undefined)
          console.log(`[EnhancedWorkflowExecutor] Leg ${leg.leg_id} incomplete, continuing... Reason: ${verificationResponse.description || verificationResponse.reason || 'Unknown'}`);
          lastError = verificationResponse.description || verificationResponse.reason;
        }

      } catch (error) {
        console.error(`[EnhancedWorkflowExecutor] Error in iteration ${iteration}:`, error.message);
        console.error(`[EnhancedWorkflowExecutor] Error stack:`, error.stack);
        lastError = error.message;

        // Record failed iteration
        await this.addIteration(workflowId, leg.leg_id, {
          screenshot_before: null,
          screenshot_after: null,
          html_sent: null,
          script_executed: typeof playwrightScript !== 'undefined' ? playwrightScript : null,
          openai_request: null,
          openai_response: null,
          result: 'failure',
          error: error.message
        });

        // If this was the last iteration, mark as failed
        if (iteration >= this.maxIterations) {
          finalResult = 'failure';
          completed = true;
        }
      }
    }

    // Mark leg as completed
    await this.completeLeg(workflowId, leg.leg_id, finalResult, lastError, jobId);

    // Mark associated action as completed if it exists
    if (leg.action_id) {
      const success = finalResult === 'success';
      // Get screenshot keys from the last successful iteration
      let screenshotBefore = null;
      let screenshotAfter = null;
      
      if (leg.iterations && leg.iterations.length > 0) {
        const lastIteration = leg.iterations[leg.iterations.length - 1];
        screenshotBefore = lastIteration.screenshot_before;
        screenshotAfter = lastIteration.screenshot_after;
      }
      
      await this.markActionCompleted(leg.action_id, success, lastError, screenshotBefore, screenshotAfter);
    }

    return {
      leg_id: leg.leg_id,
      result: finalResult,
      iterations: iteration,
      error: lastError
    };
  }

  /**
   * Execute all legs in a workflow
   */
  async executeWorkflow(page, jobId, workflowId) {
    console.log(`[EnhancedWorkflowExecutor] Executing workflow: ${workflowId}`);

    // Get workflow
    const workflow = await this.getWorkflow(workflowId);
    
    if (!workflow || !workflow.steps) {
      throw new Error('Workflow not found or has no steps');
    }

    const results = [];

    // Execute each step sequentially
    for (const step of workflow.steps) {
      if (step.status === 'pending') {
        const result = await this.executeStep(page, jobId, workflowId, step);
        results.push(result);
      } else {
        console.log(`[EnhancedWorkflowExecutor] Skipping step ${step.id} - status: ${step.status}`);
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
   * Execute Playwright script in page context
   */
  async executeScript(page, script) {
    try {
      // Wrap the AI-generated code in an async IIFE to support return statements
      const wrappedScript = `(async function() { ${script} })()`;
      
      // Wrap script execution with timeout
      const result = await Promise.race([
        page.evaluate(wrappedScript),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Script execution timeout')), 30000)
        )
      ]);

      return {
        success: true,
        result: result,
        error: null
      };
    } catch (error) {
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
            action: 'enhanced_workflow_executor'
          }
        },
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );

      return response.data.file_id;
    } catch (error) {
      console.error('[EnhancedWorkflowExecutor] Screenshot upload failed:', error.message);
      return null;
    }
  }

  /**
   * Get workflow from backend
   */
  async getWorkflow(workflowId) {
    try {
      const response = await axios.get(`${this.backendUrl}/api/workflow-templates/${workflowId}`);
      return response.data;
    } catch (error) {
      console.error('[EnhancedWorkflowExecutor] Error getting workflow:', error.message);
      throw error;
    }
  }

  /**
   * Update leg status
   */
  async updateStepStatus(workflowId, stepId, status, jobId = null) {
    return await this.updateStep(workflowId, stepId, { status }, jobId);
  }

  /**
   * Update leg fields
   */
  async updateStep(workflowId, stepId, updates, jobId = null) {
    try {
      const payload = { ...updates };
      if (jobId) {
        payload.job_id = jobId;
      }
      
      await axios.put(
        `${this.backendUrl}/api/workflow-templates/${workflowId}/steps/${stepId}`,
        payload
      );
    } catch (error) {
      console.error('[EnhancedWorkflowExecutor] Error updating step:', error.message);
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
      console.error('[EnhancedWorkflowExecutor] Error adding iteration:', error.message);
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
      console.error('[EnhancedWorkflowExecutor] Error completing leg:', error.message);
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
   * Update job statistics
   * @param {string} jobId - Job ID
   * @param {object} stats - Statistics to update
   */
  async updateJobStatistics(jobId, stats) {
    try {
      await axios.post(`${this.backendUrl}/jobs/${jobId}/counts`, stats);
      console.log(`[EnhancedWorkflowExecutor] Updated job statistics: ${JSON.stringify(stats)}`);
    } catch (error) {
      console.error(`[EnhancedWorkflowExecutor] Failed to update job statistics: ${error.message}`);
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
        component: 'ENHANCED-WORKFLOW-EXECUTOR',
        metadata: {
          workflow_decision: true,
          workflow_id: this.context.workflow_template_id,
          workflow_name: this.workflowTemplate?.name,
          details: details,
          prompts_count: this.workflowTemplate?.prompts?.length || 0,
          timestamp: new Date().toISOString()
        }
      });
      
      console.log(`[EnhancedWorkflowExecutor] 📝 Logged workflow: ${decision}`);
    } catch (error) {
      console.error(`[EnhancedWorkflowExecutor] Error logging workflow decision:`, error.message);
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
        component: 'ENHANCED-WORKFLOW-EXECUTOR',
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
      
      console.log(`[EnhancedWorkflowExecutor] 📝 Logged prompt usage: ${promptName} (${source})`);
    } catch (error) {
      console.error(`[EnhancedWorkflowExecutor] Error logging prompt usage:`, error.message);
    }
  }
}

export default EnhancedWorkflowExecutor;

