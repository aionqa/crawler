import axios from 'axios';

/**
 * WorkflowExecutor
 * Handles execution of workflow legs with iterative OpenAI testing
 * Each leg is tested until OpenAI confirms completion or failure
 */
class WorkflowExecutor {
  constructor(backendUrl, aiLogger, backendLogger, context = {}) {
    this.backendUrl = backendUrl;
    this.aiLogger = aiLogger;
    this.backendLogger = backendLogger;
    this.context = context;
    this.workflowTemplate = null;
    // For page analysis workflows, don't retry legs on failure (maxIterations = 1)
    // For other workflows, allow 1 retry (maxIterations = 2)
    this.maxIterations = context.maxIterations !== undefined ? context.maxIterations : 2;
    this.maxAiRequestsPerLeg = this.maxIterations * 2; // Maximum AI requests per leg (iterations × 2 requests each)
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
      const response = await axios.get(`${this.backendUrl}/api/workflow-templates/${this.context.workflow_template_id}`);
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

    let iteration = 0;
    let completed = false;
    let finalResult = 'failure';
    let lastError = null;
    let aiRequestCount = 0;

    while (iteration < this.maxIterations && !completed && aiRequestCount < this.maxAiRequestsPerLeg) {
      iteration++;
      console.log(`[WorkflowExecutor] Leg ${leg.leg_id} - Iteration ${iteration}/${this.maxIterations} (AI requests: ${aiRequestCount}/${this.maxAiRequestsPerLeg})`);

      // Check job status before each iteration
      const jobStatus = await this.checkJobStatus(jobId);
      if (jobStatus !== 'running') {
        console.log(`[WorkflowExecutor] Job ${jobId} status changed to ${jobStatus}, stopping leg execution`);
        finalResult = 'cancelled';
        completed = true;
        lastError = `Job status changed to ${jobStatus}`;
        break;
      }

      // Refetch workflow to get latest leg state with iterations
      if (iteration > 1) {
        const latestWorkflow = await this.getWorkflow(workflowId);
        leg = latestWorkflow.legs.find(l => l.leg_id === leg.leg_id) || leg;
        console.log(`[WorkflowExecutor] Refetched leg with ${leg.iterations?.length || 0} previous iterations`);
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
          
          // Clean the script immediately after extraction to remove markdown code blocks
          playwrightScript = this.cleanScript(playwrightScript);
          
          if (!playwrightScript || playwrightScript.trim().length === 0) {
            throw new Error(`Script is empty after cleaning`);
          }
          
          console.log(`[WorkflowExecutor] ✅ Successfully extracted and cleaned Playwright script (${playwrightScript.length} characters)`);
          
          // Update leg with script
          await this.updateLeg(workflowId, leg.leg_id, { 
            playwright_script: playwrightScript,
            update_action: true  // Signal backend to also update action document
          });
        }

        console.log(`[WorkflowExecutor] Executing script for leg ${leg.leg_id}`);

        // Step 4: Execute Playwright script
        const executionResult = await this.executeScript(page, playwrightScript, jobId);

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

        console.log(`[WorkflowExecutor] Verifying with OpenAI (HTML before: ${htmlContent.length} chars, after: ${htmlAfter.length} chars, screenshot: ${screenshotAfterBase64.length} chars)`);

        aiRequestCount++;
        if (aiRequestCount > this.maxAiRequestsPerLeg) {
          console.log(`[WorkflowExecutor] AI request limit reached (${this.maxAiRequestsPerLeg}), stopping leg execution`);
          throw new Error(`AI request limit exceeded: ${aiRequestCount}/${this.maxAiRequestsPerLeg}`);
        }

        // Find prompt from workflow steps - prompts are embedded in step configs
        const verifyStep = this.findAIPromptStep();
        const customVerifyTemplate = verifyStep ? (verifyStep.config?.template || verifyStep.config?.user_message_template) : null;
        
        if (!customVerifyTemplate) {
          throw new Error(`No embedded prompt template found in workflow steps for verification. All prompts must be embedded in workflow step configs. Step: ${verifyStep?.name || 'unknown'}`);
        }
        
        const verifyPromptSource = 'workflow-step';
        const verifyPromptIdentifier = verifyStep ? (verifyStep.id || verifyStep.name || 'workflow-step') : 'workflow-executor';
        
        // Log prompt usage
        await this.logPromptUsage(verifyPromptIdentifier, verifyPromptSource, customVerifyTemplate, verificationRequest);
        
        const verificationResponse = await this.aiLogger.makeAICallWithPrompt(
          verifyPromptIdentifier,
          verificationRequest,
          jobId,
          'workflow-executor',
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
          console.log(`[WorkflowExecutor] Leg ${leg.leg_id} completed successfully`);
          completed = true;
          finalResult = 'success';
        } else if (verificationResponse.success === false || (verificationResponse.status === 'failed' && verificationResponse.can_retry === false)) {
          console.log(`[WorkflowExecutor] Leg ${leg.leg_id} failed permanently`);
          completed = true;
          finalResult = 'failure';
          lastError = verificationResponse.description || verificationResponse.reason || 'Unknown failure';
        } else {
          // Continue to next iteration
          console.log(`[WorkflowExecutor] Leg ${leg.leg_id} incomplete, continuing... Reason: ${verificationResponse.description || verificationResponse.reason || 'Unknown'}`);
          lastError = verificationResponse.description || verificationResponse.reason;
        }

      } catch (error) {
        console.error(`[WorkflowExecutor] Error in iteration ${iteration}:`, error.message);
        console.error(`[WorkflowExecutor] Error stack:`, error.stack);
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
      await this.markActionCompleted(leg.action_id, success, lastError);
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
    console.log(`[WorkflowExecutor] Executing workflow: ${workflowId}`);

    // Get workflow
    const workflow = await this.getWorkflow(workflowId);
    
    if (!workflow || !workflow.legs) {
      throw new Error('Workflow not found or has no legs');
    }

    const results = [];

    // Execute each leg sequentially
    for (const leg of workflow.legs) {
      if (leg.status === 'pending') {
        const result = await this.executeLeg(page, jobId, workflowId, leg);
        results.push(result);
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
   * Execute Playwright script in page context
   */
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
      
      // Clean the script to remove function declarations, require statements, etc.
      const cleanedScript = this.cleanScript(script);
      const cleanedScriptLength = cleanedScript?.length || 0;
      
      if (!cleanedScript || cleanedScript.trim().length === 0) {
        const error = 'Script is empty after cleaning';
        if (jobId && this.backendLogger) {
          await this.backendLogger.appendJobLog(jobId, 'error',
            `❌ ${error}`,
            'WORKFLOW-EXECUTOR',
            {
              original_script_length: originalScriptLength,
              cleaned_script_length: cleanedScriptLength,
              original_script_preview: script?.substring(0, 500) || 'N/A'
            }
          );
        }
        throw new Error(error);
      }
      
      // Log cleaned script info
      if (jobId && this.backendLogger) {
        await this.backendLogger.appendJobLog(jobId, 'debug',
          `📝 Script cleaned (${originalScriptLength} → ${cleanedScriptLength} chars)`,
          'WORKFLOW-EXECUTOR',
          {
            cleaned_script_preview: cleanedScript.substring(0, 500),
            cleaning_removed_chars: originalScriptLength - cleanedScriptLength
          }
        );
      }
      
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
      // Create an async function that has access to the page object
      const executeInNodeContext = async (pageObj, scriptCode) => {
        // Use string concatenation (not template literals) to avoid escaping issues
        // This allows the script code to contain backticks, ${}, etc. without problems
        const functionBody = 'return (async function() {\n' + scriptCode + '\n})();';
        
        // Create a function with page as parameter
        const fn = new Function('page', functionBody);
        return await fn(pageObj);
      };
      
      // Validate script completeness before execution
      // Check for common incomplete patterns that indicate truncation
      const lines = cleanedScript.split('\n');
      const incompletePatterns = [
        /['"`][a-z]+\s*=\s*$/,  // Incomplete selector like 'xpath= or "button=
        /await\s+page\.(waitForSelector|click|fill)\(['"`][^'"`]*$/,  // Incomplete await statement
        /^\s*try\s*\{\s*$/,  // Incomplete try block (only opening brace)
        /^\s*catch\s*\(\s*$/,  // Incomplete catch block (only opening paren)
      ];
      
      // Check last few lines for incomplete patterns
      const lastLines = lines.slice(-3).join('\n');
      for (const pattern of incompletePatterns) {
        if (pattern.test(lastLines)) {
          const error = 'Script appears to be incomplete (truncated)';
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'error',
              `❌ ${error}`,
              'WORKFLOW-EXECUTOR',
              {
                original_script_length: originalScriptLength,
                cleaned_script_length: cleanedScriptLength,
                script_preview: cleanedScript.substring(Math.max(0, cleanedScript.length - 500)),
                incomplete_pattern: pattern.toString(),
                last_50_chars: cleanedScript.substring(Math.max(0, cleanedScript.length - 50))
              }
            );
          }
          throw new Error(error);
        }
      }
      
      // Additional check: if script ends with incomplete string/quotes
      const trimmedScript = cleanedScript.trim();
      if (trimmedScript.match(/['"`][^'"`]*$/)) {
        const error = 'Script appears to end with incomplete string literal';
        if (jobId && this.backendLogger) {
          await this.backendLogger.appendJobLog(jobId, 'error',
            `❌ ${error}`,
            'WORKFLOW-EXECUTOR',
            {
              original_script_length: originalScriptLength,
              cleaned_script_length: cleanedScriptLength,
              script_preview: cleanedScript.substring(Math.max(0, cleanedScript.length - 500)),
              last_50_chars: cleanedScript.substring(Math.max(0, cleanedScript.length - 50))
            }
          );
        }
        throw new Error(error);
      }
      
      // Wrap script execution with timeout (increased to 45 seconds to match workflow step timeout)
      const result = await Promise.race([
        executeInNodeContext(page, cleanedScript),
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

