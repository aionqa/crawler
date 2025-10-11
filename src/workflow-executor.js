import axios from 'axios';

/**
 * WorkflowExecutor
 * Handles execution of workflow legs with iterative OpenAI testing
 * Each leg is tested until OpenAI confirms completion or failure
 */
class WorkflowExecutor {
  constructor(backendUrl, aiLogger, backendLogger) {
    this.backendUrl = backendUrl;
    this.aiLogger = aiLogger;
    this.backendLogger = backendLogger;
    this.maxIterations = 2; // Maximum iterations per leg (reduced for faster execution)
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

    // Mark leg as in progress
    await this.updateLegStatus(workflowId, leg.leg_id, 'in_progress', jobId);

    let iteration = 0;
    let completed = false;
    let finalResult = 'failure';
    let lastError = null;

    while (iteration < this.maxIterations && !completed) {
      iteration++;
      console.log(`[WorkflowExecutor] Leg ${leg.leg_id} - Iteration ${iteration}/${this.maxIterations}`);

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
            iteration_number: iteration
          };

          console.log(`[WorkflowExecutor] Requesting script from OpenAI (HTML: ${htmlContent.length} chars, screenshot: ${screenshotBeforeBase64.length} chars, iteration: ${iteration})`);

          const scriptResponse = await this.aiLogger.makeAICallWithPrompt(
            'generate-workflow-script',
            scriptRequest,
            jobId,
            'workflow-executor',
            page.url(),
            screenshotBeforeKey,  // screenshotId for tracking
            scriptRequest  // Pass scriptRequest as sourcePayload for full attachment logging
          );

          if (!scriptResponse || !scriptResponse.playwright_script) {
            throw new Error('OpenAI did not return a valid Playwright script');
          }

          playwrightScript = scriptResponse.playwright_script;
          
          // Update leg with script
          await this.updateLeg(workflowId, leg.leg_id, { 
            playwright_script: playwrightScript,
            update_action: true  // Signal backend to also update action document
          });
        }

        console.log(`[WorkflowExecutor] Executing script for leg ${leg.leg_id}`);

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
          iteration_number: iteration
        };

        console.log(`[WorkflowExecutor] Verifying with OpenAI (HTML before: ${htmlContent.length} chars, after: ${htmlAfter.length} chars, screenshot: ${screenshotAfterBase64.length} chars)`);

        const verificationResponse = await this.aiLogger.makeAICallWithPrompt(
          'verify-workflow-leg',
          verificationRequest,
          jobId,
          'workflow-executor',
          page.url(),
          screenshotAfterKey,  // screenshotId for tracking
          verificationRequest  // Pass verificationRequest as sourcePayload for full attachment logging
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
        if (verificationResponse.status === 'completed' || verificationResponse.completed === true) {
          console.log(`[WorkflowExecutor] Leg ${leg.leg_id} completed successfully`);
          completed = true;
          finalResult = 'success';
        } else if (verificationResponse.status === 'failed' && verificationResponse.can_retry === false) {
          console.log(`[WorkflowExecutor] Leg ${leg.leg_id} failed permanently`);
          completed = true;
          finalResult = 'failure';
          lastError = verificationResponse.reason || 'Unknown failure';
        } else {
          // Continue to next iteration
          console.log(`[WorkflowExecutor] Leg ${leg.leg_id} incomplete, continuing... Reason: ${verificationResponse.reason || 'Unknown'}`);
          lastError = verificationResponse.reason;
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
      const prepareResponse = await axios.post(
        `${this.backendUrl}/api/files/prepare-screenshot`,
        { job_id: jobId, suffix }
      );

      const { uploadUrl, key } = prepareResponse.data;

      await axios.put(uploadUrl, screenshotBuffer, {
        headers: { 'Content-Type': 'image/png' }
      });

      return key;
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
}

export default WorkflowExecutor;

