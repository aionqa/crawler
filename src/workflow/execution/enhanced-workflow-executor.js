import axios from 'axios';
import { appendRequirementToTemplate, getRequirementTextForNextStep } from '../../step-requirements.js';

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
    // NO HARDCODED LIMITS - all limits come from workflow step configs
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
      const response = await axios.get(`${this.backendUrl}/api/workflow-templates/${this.context.workflow_template_id}`, {
        headers: this.getAuthHeaders()
      });
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
   * Find the specific script generation step (prioritizes script generation over action analysis)
   */
  findScriptGenerationStep() {
    if (!this.workflowTemplate || !this.workflowTemplate.steps) {
      console.log(`[EnhancedWorkflowExecutor] findScriptGenerationStep: No workflow template or steps`);
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
            console.log(`[EnhancedWorkflowExecutor] ✅ Found script generation step: ${stepId || stepName} (depth: ${depth})`);
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
      console.log(`[EnhancedWorkflowExecutor] ⚠️ No script generation step found, falling back to any ai-prompt step`);
      scriptStep = this.findAIPromptStep();
      if (scriptStep) {
        console.log(`[EnhancedWorkflowExecutor] ✅ Fallback found ai-prompt step: ${scriptStep.id || scriptStep.name || 'unknown'}`);
      } else {
        console.log(`[EnhancedWorkflowExecutor] ❌ No ai-prompt step found either`);
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
      // Use /api/jobs/:id which doesn't require authentication (runner-friendly endpoint)
      const response = await axios.get(`${this.backendUrl}/api/jobs/${jobId}`, {
        headers: this.getAuthHeaders(), // Still send auth headers for logging/tracking
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
   * Create action immediately when OpenAI proposes it
   * This ensures actions appear in the UI as soon as they're proposed
   * @param {Object} leg - Leg object with action details
   * @param {string} playwrightScript - The script proposed by OpenAI
   * @param {string} jobId - Job ID
   * @param {Page} page - Playwright page object
   * @param {Object} workflowState - Workflow state
   */
  async createActionImmediately(leg, playwrightScript, jobId, page, workflowState) {
    try {
      // Get project ID from context or workflow state
      const projectId = this.context.project_id || workflowState.projectId;
      const pageId = this.context.page_id || workflowState.pageId;
      
      if (!projectId || !pageId) {
        console.warn(`[EnhancedWorkflowExecutor] Cannot create action - missing project_id or page_id`);
        return;
      }
      
      // Extract action details from leg
      // Try multiple possible fields for action type/kind
      const kind = leg.type || leg.kind || leg.action_type || leg.action || 'click'; // Default to click if not specified
      const text = leg.description || leg.text || leg.name || 'AI-generated action';
      const selector = leg.element_info?.selector || leg.selector || leg.element_selector || null;
      
      // CRITICAL: Skip verify/check actions - they should not be created during execution
      const actionType = (kind || '').toLowerCase();
      const actionText = (text || '').toLowerCase();
      if (actionType === 'verify' || actionType === 'check' || 
          actionText.includes('verify') || actionText.includes('check')) {
        console.log(`[EnhancedWorkflowExecutor] Skipping verify/check action: ${text}`);
        return null;
      }
      
      // Ensure kind is always a valid string (not undefined)
      const finalKind = (typeof kind === 'string' && kind.trim()) ? kind.trim() : 'click';
      
      // Create action payload
      const actionPayload = {
        project_id: projectId,
        page_id: pageId,
        kind: finalKind,
        text: text,
        selector: selector,
        playwright_script: playwrightScript,
        status: 'pending',
        source: 'ai-generated',
        leg_id: leg.leg_id || leg.id,
        job_id: jobId  // Link action to job immediately
      };
      
      // Check if action already exists (matching logic)
      const existingAction = await this.findExistingAction(actionPayload, projectId, pageId);
      
      if (existingAction) {
        // Update existing action instead of creating duplicate
        console.log(`[EnhancedWorkflowExecutor] Found existing action ${existingAction._id}, updating instead of creating duplicate`);
        await axios.put(`${this.backendUrl}/actions/${existingAction._id}`, {
          playwright_script: playwrightScript,
          status: 'pending',
          updated_at: new Date()
        }, {
          headers: this.getAuthHeaders(),
          timeout: 5000
        });
        
        // Store action ID in leg for later reference
        leg.action_id = existingAction._id;
        return existingAction._id;
      } else {
        // Create new action
        const response = await axios.post(`${this.backendUrl}/actions`, actionPayload, {
          headers: this.getAuthHeaders(),
          timeout: 5000
        });
        
        const actionId = response.data._id;
        console.log(`[EnhancedWorkflowExecutor] ✅ Created action immediately: ${actionId} (${text})`);
        
        // Store action ID in leg for later reference
        leg.action_id = actionId;
        
        return actionId;
      }
    } catch (error) {
      // Log error but don't fail the workflow
      console.error(`[EnhancedWorkflowExecutor] Error creating action immediately: ${error.message}`);
      if (error.response) {
        console.error(`[EnhancedWorkflowExecutor] Response status: ${error.response.status}`);
        console.error(`[EnhancedWorkflowExecutor] Response data: ${JSON.stringify(error.response.data)}`);
      }
    }
  }

  /**
   * Find existing action to avoid duplicates
   * Matches by page_id, kind, text, and selector
   * @param {Object} actionPayload - Action payload to match
   * @param {string} projectId - Project ID
   * @param {string} pageId - Page ID
   * @returns {Object|null} Existing action or null
   */
  async findExistingAction(actionPayload, projectId, pageId) {
    try {
      // Query for existing actions with matching criteria
      // CRITICAL: Include job_id to prevent duplicates within the same job
      const queryParams = new URLSearchParams({
        project_id: projectId,
        page_id: pageId,
        kind: actionPayload.kind,
        text: actionPayload.text
      });
      
      // Include job_id if available to ensure we only find actions from the same job
      if (actionPayload.job_id) {
        queryParams.append('job_id', actionPayload.job_id);
      }
      
      if (actionPayload.selector) {
        queryParams.append('selector', actionPayload.selector);
      }
      
      const response = await axios.get(`${this.backendUrl}/actions?${queryParams.toString()}`, {
        headers: this.getAuthHeaders(),
        timeout: 5000
      });
      
      const actions = response.data || [];
      
      // Find exact match (including job_id if provided)
      const exactMatch = actions.find(a => {
        const matchesKind = a.kind === actionPayload.kind;
        const matchesText = a.text === actionPayload.text;
        const matchesSelector = (!actionPayload.selector && !a.selector) || (a.selector === actionPayload.selector);
        const matchesPage = a.page_id?.toString() === pageId.toString();
        // CRITICAL: Also match job_id if provided to prevent duplicates within the same job
        const matchesJob = !actionPayload.job_id || (a.job_id?.toString() === actionPayload.job_id.toString());
        
        return matchesKind && matchesText && matchesSelector && matchesPage && matchesJob;
      });
      
      return exactMatch || null;
    } catch (error) {
      console.error(`[EnhancedWorkflowExecutor] Error finding existing action: ${error.message}`);
      return null;
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
   * Execute a single workflow step based on its type
   * NO HARDCODED LOOPS - all logic comes from workflow steps
   * @param {Page} page - Playwright page object
   * @param {string} jobId - Job ID for logging
   * @param {string} workflowId - Workflow ID
   * @param {Object} step - Step object from workflow template
   * @returns {Object} execution result
   */
  async executeStep(page, jobId, workflowId, step, options = {}) {
    console.log(`[EnhancedWorkflowExecutor] Executing step: ${step.id} - ${step.name} (type: ${step.type})`);

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
        error: `Job status is ${jobStatus}`
      };
    }

    // Mark step as in progress
    await this.updateStepStatus(workflowId, step.id, 'in_progress', jobId);

    // Execute step based on its type - NO HARDCODED LOOPS
    try {
      const stepType = step.type || 'ai-prompt';
      const parentSteps = Array.isArray(options.parentSteps) ? options.parentSteps : [];
      const stepIndex = typeof options.stepIndex === 'number' ? options.stepIndex : null;
      const nextStep = options.nextStepOverride ??
        (parentSteps.length > 0 && stepIndex !== null ? parentSteps[stepIndex + 1] : null);
      
      switch (stepType) {
        case 'while-loop':
          return await this.executeWhileLoopStep(page, jobId, workflowId, step);
        case 'if-step':
          return await this.executeIfStep(page, jobId, workflowId, step);
        case 'execute-code':
          return await this.executeCodeStep(page, jobId, workflowId, step);
        case 'browser-config':
          return await this.executeBrowserConfigStep(page, jobId, workflowId, step);
        case 'ai-prompt':
          return await this.executeAIPromptStep(page, jobId, workflowId, step, { nextStep });
        case 'cycle':
          return await this.executeCycleStep(page, jobId, workflowId, step);
        default:
          // Default to ai-prompt for backward compatibility
          console.warn(`[EnhancedWorkflowExecutor] Unknown step type: ${stepType}, defaulting to ai-prompt`);
          return await this.executeAIPromptStep(page, jobId, workflowId, step, { nextStep });
      }
    } catch (error) {
      console.error(`[EnhancedWorkflowExecutor] Error executing step ${step.id}:`, error);
      await this.updateStepStatus(workflowId, step.id, 'failed', jobId);
      return {
        step_id: step.id,
        result: 'failure',
        error: error.message
      };
    }
  }

  /**
   * Execute a while-loop step - NO HARDCODED LOGIC, follows workflow config
   */
  async executeWhileLoopStep(page, jobId, workflowId, step) {
    const config = step.config || {};
    // CRITICAL: Force 1 iteration per job - no multiple iterations allowed
    const maxIterations = 1;
    const conditionPath = config.conditionPath;
    const conditionType = config.conditionType || 'ai-response';
    const conditionValue = config.conditionValue;
    const onEachIteration = config.onEachIteration;
    const onComplete = config.onComplete;
    const loopSteps = Array.isArray(config.steps) ? config.steps : [];
    const findLoopStepIndex = (stepObj) => loopSteps.findIndex(s => s && stepObj && s.id === stepObj.id);
    
    console.log(`[EnhancedWorkflowExecutor] Executing while-loop step: ${step.id} (maxIterations: ${maxIterations})`);
    
    let iteration = 0;
    let shouldContinue = true;
    
    // Get nested steps from workflow template
    const workflow = await this.getWorkflow(workflowId);
    const workflowTemplate = this.workflowTemplate;
    
    // Find the step to execute on each iteration
    let iterationStep = null;
    if (onEachIteration) {
      iterationStep = workflowTemplate?.steps?.find(s => s.id === onEachIteration || s.name === onEachIteration);
      if (!iterationStep) {
        throw new Error(`While-loop step ${step.id} references step ${onEachIteration} which was not found`);
      }
    }
    
    while (iteration < maxIterations && shouldContinue) {
      iteration++;
      console.log(`[EnhancedWorkflowExecutor] While-loop iteration ${iteration}/${maxIterations}`);
      
      // Check job status
      const jobStatus = await this.checkJobStatus(jobId);
      if (jobStatus !== 'running') {
        console.log(`[EnhancedWorkflowExecutor] Job ${jobId} status changed to ${jobStatus}, stopping loop`);
        break;
      }
      
      // Execute iteration step and follow the chain until verification
      if (iterationStep) {
        // Execute the step chain starting from iterationStep
        // Follow onSuccess/onFailure links until we reach a verification step
        let currentStep = iterationStep;
        let lastResult = null;
        const executedSteps = new Set();
        const maxChainLength = 10; // Prevent infinite loops
        let chainLength = 0;
        
        while (currentStep && chainLength < maxChainLength && !executedSteps.has(currentStep.id)) {
          executedSteps.add(currentStep.id);
          chainLength++;
          
          console.log(`[EnhancedWorkflowExecutor] Executing step in chain: ${currentStep.id} - ${currentStep.name}`);
          const contextIndex = findLoopStepIndex(currentStep);
          const stepResult = await this.executeStep(page, jobId, workflowId, currentStep, {
            parentSteps: loopSteps,
            stepIndex: contextIndex >= 0 ? contextIndex : null
          });
          lastResult = stepResult;
          
          // Check if this is a verification step (usually step_6_verify or similar)
          const isVerifyStep = currentStep.id?.includes('verify') || currentStep.name?.includes('verify');
          
          if (isVerifyStep) {
            // Found verification step - check condition from its result
            break;
          }
          
          // Follow onSuccess link to next step
          if (stepResult.result === 'success' && currentStep.onSuccess) {
            const nextStepId = currentStep.onSuccess;
            currentStep = workflowTemplate?.steps?.find(s => s.id === nextStepId || s.name === nextStepId);
            if (!currentStep) {
              console.warn(`[EnhancedWorkflowExecutor] Next step ${nextStepId} not found in workflow template`);
              break;
            }
          } else if (stepResult.result === 'failure' && currentStep.onFailure) {
            const nextStepId = currentStep.onFailure;
            currentStep = workflowTemplate?.steps?.find(s => s.id === nextStepId || s.name === nextStepId);
            if (!currentStep) {
              console.warn(`[EnhancedWorkflowExecutor] Failure step ${nextStepId} not found in workflow template`);
              break;
            }
          } else {
            // No next step defined
            break;
          }
        }
        
        // CRITICAL: Check step result first - if failed or succeeded, stop immediately (one iteration per job)
        if (lastResult && (lastResult.result === 'failure' || lastResult.result === 'success')) {
          const resultStatus = lastResult.result;
          console.log(`[EnhancedWorkflowExecutor] Step execution result is '${resultStatus}' - stopping loop immediately (one iteration per job)`);
          shouldContinue = false;
          break;
        }
        
        // CRITICAL: Check status first - if failed, stop immediately regardless of condition
        let currentStatus = null;
        if (conditionPath && conditionType === 'ai-response') {
          // Refetch workflow to get latest results after step execution
          const latestWorkflow = await this.getWorkflow(workflowId);
          
          // The condition path should point to the verification step result
          // e.g., 'verify_result.is_complete' means check step_6_verify's openai_response.is_complete
          const pathParts = conditionPath.split('.');
          if (pathParts.length >= 2) {
            // Find the verification step (usually step_6_verify or similar)
            const verifyStepId = pathParts[0].replace('_result', '').replace('verify', 'step_6_verify');
            const verifyStep = workflowTemplate?.steps?.find(s => 
              s.id === verifyStepId || s.id === 'step_6_verify' || s.name?.includes('verify')
            );
            
            if (verifyStep && latestWorkflow.results?.[verifyStep.id]) {
              const verifyResult = latestWorkflow.results[verifyStep.id];
              const verifyResponse = verifyResult.openai_response || verifyResult;
              
              // Check status first - if failure or success, stop immediately (one iteration per job)
              currentStatus = verifyResponse.status || verifyResponse.completion_status;
              if (currentStatus === 'failure' || currentStatus === 'failed' || currentStatus === 'success') {
                console.log(`[EnhancedWorkflowExecutor] Status is '${currentStatus}' - stopping loop immediately (one iteration per job)`);
                shouldContinue = false;
                break;
              }
              
              // Get the value from the verification response
              const fieldPath = pathParts.slice(1).join('.'); // e.g., 'is_complete'
              const conditionValueFromResult = this.getPathValue(verifyResponse, fieldPath);
              
              // Check if condition matches - continue while condition is true (e.g., is_complete === false)
              shouldContinue = conditionValueFromResult === conditionValue;
              console.log(`[EnhancedWorkflowExecutor] Condition check: ${conditionPath} = ${conditionValueFromResult} (expected: ${conditionValue}) -> continue: ${shouldContinue}`);
            } else {
              // If verification step not found or no result yet, continue by default
              console.warn(`[EnhancedWorkflowExecutor] Verification step ${verifyStepId} not found or no result yet, continuing loop`);
              shouldContinue = true;
            }
          } else {
            // Simple path - check directly in result
            const resultResponse = lastResult?.openai_response || lastResult;
            
            // Check status first - if failure, stop immediately
            currentStatus = resultResponse?.status || resultResponse?.completion_status;
            if (currentStatus === 'failure' || currentStatus === 'failed') {
              console.log(`[EnhancedWorkflowExecutor] Status is '${currentStatus}' - stopping loop immediately (ignoring condition)`);
              shouldContinue = false;
              break;
            }
            
            const conditionValueFromResult = this.getPathValue(lastResult, conditionPath);
            shouldContinue = conditionValueFromResult === conditionValue;
            console.log(`[EnhancedWorkflowExecutor] Condition check: ${conditionPath} = ${conditionValueFromResult} (expected: ${conditionValue}) -> continue: ${shouldContinue}`);
          }
        } else {
          // No condition - check status from lastResult if available
          const resultResponse = lastResult?.openai_response || lastResult;
          currentStatus = resultResponse?.status || resultResponse?.completion_status;
          if (currentStatus === 'failure' || currentStatus === 'failed') {
            console.log(`[EnhancedWorkflowExecutor] Status is '${currentStatus}' - stopping loop immediately`);
            shouldContinue = false;
            break;
          }
          // No condition - continue until max iterations
          shouldContinue = true;
        }
      } else {
        // No iteration step defined, break immediately
        console.warn(`[EnhancedWorkflowExecutor] While-loop step ${step.id} has no onEachIteration step defined`);
        break;
      }
    }
    
    await this.updateStepStatus(workflowId, step.id, 'completed', jobId);
    
    return {
      step_id: step.id,
      result: shouldContinue ? 'incomplete' : 'completed',
      iterations: iteration,
      next_step: shouldContinue ? null : onComplete
    };
  }

  /**
   * Execute an if-step (conditional step) - NO HARDCODED LOGIC, follows workflow config
   */
  async executeIfStep(page, jobId, workflowId, step) {
    const config = step.config || {};
    const conditionType = config.conditionType || 'ai-response';
    const conditionPath = config.conditionPath;
    const conditionValue = config.conditionValue;
    const onTrue = config.onTrue;
    const onFalse = config.onFalse;
    
    console.log(`[EnhancedWorkflowExecutor] Executing if-step: ${step.id}`);
    
    // Get workflow to access previous results
    const workflow = await this.getWorkflow(workflowId);
    
    // Evaluate condition
    let conditionResult = false;
    if (conditionPath && conditionType === 'ai-response') {
      // The condition path format is like 'verify_result.is_complete' or 'verify_result.success'
      // Find the verification step (usually step_6_verify)
      const pathParts = conditionPath.split('.');
      const verifyStepId = pathParts[0]?.replace('_result', '').replace('verify', 'step_6_verify') || 'step_6_verify';
      const verifyResult = workflow.results?.[verifyStepId] || workflow.results?.['step_6_verify'];
      
      if (verifyResult) {
        // Get the field path (e.g., 'is_complete' from 'verify_result.is_complete')
        const fieldPath = pathParts.length > 1 ? pathParts.slice(1).join('.') : conditionPath;
        const conditionValueFromResult = this.getPathValue(
          verifyResult.openai_response || verifyResult, 
          fieldPath
        );
        conditionResult = conditionValueFromResult === conditionValue;
        console.log(`[EnhancedWorkflowExecutor] Condition check: ${conditionPath} = ${conditionValueFromResult} (expected: ${conditionValue}) -> result: ${conditionResult}`);
      } else {
        console.warn(`[EnhancedWorkflowExecutor] Verification step ${verifyStepId} not found or no result yet, condition defaults to false`);
      }
    }
    
    await this.updateStepStatus(workflowId, step.id, 'completed', jobId);
    
    return {
      step_id: step.id,
      result: conditionResult ? 'true' : 'false',
      next_step: conditionResult ? onTrue : onFalse
    };
  }

  /**
   * Execute an execute-code step - NO HARDCODED LOGIC, follows workflow config
   */
  async executeCodeStep(page, jobId, workflowId, step) {
    const config = step.config || {};
    const scriptSource = config.scriptSource || 'from-previous-step';
    
    console.log(`[EnhancedWorkflowExecutor] Executing code step: ${step.id} (scriptSource: ${scriptSource})`);
    
    // Get script from previous step or from leg
    let playwrightScript = null;
    
    if (scriptSource === 'from-previous-step') {
      // Get script from previous step's result
      const workflow = await this.getWorkflow(workflowId);
      // Find the script generation step result
      const scriptStep = this.workflowTemplate?.steps?.find(s => 
        (s.type === 'ai-prompt' && s.name?.includes('script')) || 
        (s.id === 'step_4_gen_or_reuse_script')
      );
      
      if (scriptStep && workflow.results?.[scriptStep.id]) {
        const scriptResult = workflow.results[scriptStep.id];
        playwrightScript = scriptResult.playwright_script || scriptResult.script;
      }
    }
    
    if (!playwrightScript) {
      // Fallback: get from step's playwright_script field
      playwrightScript = step.playwright_script;
    }
    
    if (!playwrightScript) {
      throw new Error(`No script available for code step ${step.id}`);
    }
    
    // Execute script
    const executionResult = await this.executeScript(page, playwrightScript, jobId);
    
    // Take screenshot after execution
    const screenshotAfter = await page.screenshot({ fullPage: true, type: 'png' });
    const screenshotAfterKey = await this.uploadScreenshot(jobId, screenshotAfter, 'after');
    
    await this.updateStepStatus(workflowId, step.id, executionResult.success ? 'completed' : 'failed', jobId);
    
    return {
      step_id: step.id,
      result: executionResult.success ? 'success' : 'failure',
      execution_result: executionResult,
      screenshot_after: screenshotAfterKey,
      playwright_script: playwrightScript
    };
  }

  /**
   * Execute a browser-config step - Configures browser settings
   */
  async executeBrowserConfigStep(page, jobId, workflowId, step) {
    const config = step.config || {};
    
    console.log(`[EnhancedWorkflowExecutor] Executing browser-config step: ${step.id}`);
    
    try {
      // Get browser configuration from step config
      const browserConfig = {
        viewport: config.viewport || { width: 1920, height: 1080 },
        userAgent: config.userAgent || config.user_agent || null,
        timeout: config.timeout || 30000,
        isMobile: config.isMobile || config.is_mobile || false,
        hasTouch: config.hasTouch || config.has_touch || false,
        deviceScaleFactor: config.deviceScaleFactor || config.device_scale_factor || 1,
        locale: config.locale || 'en-US',
        timezoneId: config.timezoneId || config.timezone_id || 'America/New_York'
      };
      
      // Apply viewport
      if (browserConfig.viewport) {
        await page.setViewportSize(browserConfig.viewport);
        console.log(`[EnhancedWorkflowExecutor] Viewport set to ${browserConfig.viewport.width}x${browserConfig.viewport.height}`);
      }
      
      // Apply user agent via context (if page has context)
      if (browserConfig.userAgent) {
        const context = page.context();
        await context.setExtraHTTPHeaders({
          'User-Agent': browserConfig.userAgent
        });
        // Also set via evaluate to override navigator.userAgent
        await page.evaluate((ua) => {
          Object.defineProperty(navigator, 'userAgent', {
            get: () => ua,
            configurable: true
          });
        }, browserConfig.userAgent);
        console.log(`[EnhancedWorkflowExecutor] User agent set to: ${browserConfig.userAgent.substring(0, 50)}...`);
      }
      
      // Apply mobile emulation if needed
      if (browserConfig.isMobile) {
        const context = page.context();
        // Mobile devices typically have touch support
        await context.addInitScript(() => {
          Object.defineProperty(navigator, 'maxTouchPoints', {
            get: () => 5,
            configurable: true
          });
        });
        console.log(`[EnhancedWorkflowExecutor] Mobile emulation enabled`);
      }
      
      // Store config in workflow state for future reference
      const workflow = await this.getWorkflow(workflowId);
      if (!workflow.browserConfig) {
        workflow.browserConfig = {};
      }
      Object.assign(workflow.browserConfig, browserConfig);
      
      await this.updateStepStatus(workflowId, step.id, 'completed', jobId);
      
      await this.logWorkflowStep(
        'browser-config',
        `🌐 Browser configured: ${browserConfig.viewport.width}x${browserConfig.viewport.height}${browserConfig.isMobile ? ' (mobile)' : ''}`,
        { browserConfig }
      );
      
      return {
        step_id: step.id,
        result: 'success',
        browserConfig: browserConfig,
        message: `Browser configured: ${browserConfig.viewport.width}x${browserConfig.viewport.height}${browserConfig.isMobile ? ' (mobile)' : ''}`
      };
    } catch (error) {
      console.error(`[EnhancedWorkflowExecutor] Browser config error: ${error.message}`);
      await this.updateStepStatus(workflowId, step.id, 'failed', jobId);
      return {
        step_id: step.id,
        result: 'failure',
        error: error.message
      };
    }
  }

  /**
   * Execute an AI prompt step - NO HARDCODED LOOPS, just executes the prompt
   */
  async executeAIPromptStep(page, jobId, workflowId, step, options = {}) {
    console.log(`[EnhancedWorkflowExecutor] Executing AI prompt step: ${step.id}`);
    
    // Get template from step config
    const baseTemplate = step.config?.template || step.config?.user_message_template;
    if (!baseTemplate) {
      throw new Error(`AI prompt step ${step.id} has no template in config`);
    }
    const requirementText = getRequirementTextForNextStep(options.nextStep);
    const template = appendRequirementToTemplate(baseTemplate, requirementText);
    
    // Take screenshot before
    const screenshotBefore = await page.screenshot({ fullPage: true, type: 'png' });
    const screenshotBeforeKey = await this.uploadScreenshot(jobId, screenshotBefore, 'before');
    const screenshotBeforeBase64 = screenshotBefore.toString('base64');
    
    // Get HTML content
    const htmlContent = await page.content();
    
    // Prepare request based on step attachments
    const attachments = step.attachments || [];
    const requestData = {
      page_url: page.url(),
      html_content: htmlContent,
      screenshot_base64: screenshotBeforeBase64
    };
    
    // Add attachments based on step config
    if (attachments.includes('interactive_elements')) {
      // Collect interactive elements (simplified - full implementation would be more complex)
      const interactiveElements = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[role="button"], button, a, input, select, textarea')).map(el => ({
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          text: el.textContent?.trim().substring(0, 100) || ''
        }));
      });
      requestData.interactive_elements_json = JSON.stringify(interactiveElements, null, 2);
    }
    
    // Make AI call
    const promptIdentifier = step.id || step.name || 'workflow-step';
    const aiResponse = await this.aiLogger.makeAICallWithPrompt(
      promptIdentifier,
      requestData,
      jobId,
      'enhanced-workflow-executor',
      page.url(),
      screenshotBeforeKey,
      requestData,
      template
    );
    
    await this.updateStepStatus(workflowId, step.id, 'completed', jobId);
    
    return {
      step_id: step.id,
      result: 'success',
      openai_response: aiResponse,
      playwright_script: aiResponse.playwright_script || aiResponse.script || null
    };
  }

  /**
   * Execute a cycle step - NO HARDCODED LOOPS, follows workflow config
   */
  async executeCycleStep(page, jobId, workflowId, step) {
    const config = step.config || {};
    const cycleType = config.cycleType || 'leg';
    const maxIterations = config.maxIterations || 10;
    const onEachIteration = config.onEachIteration;
    
    console.log(`[EnhancedWorkflowExecutor] Executing cycle step: ${step.id} (type: ${cycleType}, maxIterations: ${maxIterations})`);
    
    // Get workflow to find items to iterate over
    const workflow = await this.getWorkflow(workflowId);
    
    let items = [];
    if (cycleType === 'leg') {
      items = workflow.legs || [];
    }
    
    const results = [];
    for (let i = 0; i < Math.min(items.length, maxIterations); i++) {
      const item = items[i];
      console.log(`[EnhancedWorkflowExecutor] Cycle iteration ${i + 1}/${items.length} for ${cycleType}`);
      
      // Check job status
      const jobStatus = await this.checkJobStatus(jobId);
      if (jobStatus !== 'running') {
        break;
      }
      
      // Execute iteration step if specified
      if (onEachIteration) {
        const iterationStep = this.workflowTemplate?.steps?.find(s => s.id === onEachIteration || s.name === onEachIteration);
        if (iterationStep) {
          const templateSteps = Array.isArray(this.workflowTemplate?.steps) ? this.workflowTemplate.steps : [];
          const iterationIndex = templateSteps.findIndex(s => s && iterationStep && s.id === iterationStep.id);
          const result = await this.executeStep(page, jobId, workflowId, iterationStep, {
            parentSteps: templateSteps,
            stepIndex: iterationIndex >= 0 ? iterationIndex : null
          });
          results.push(result);
        }
      }
    }
    
    await this.updateStepStatus(workflowId, step.id, 'completed', jobId);
    
    return {
      step_id: step.id,
      result: 'completed',
      iterations: results.length,
      results: results
    };
  }

  /**
   * Helper to get value from object by path (e.g., "verify_result.is_complete")
   */
  getPathValue(obj, path) {
    if (!obj || !path) return undefined;
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = current[part];
    }
    return current;
  }

  /**
   * Execute a leg by executing workflow steps
   * NO HARDCODED LOOPS - delegates to workflow step execution
   */
  async executeLeg(page, jobId, workflowId, leg) {
    // Convert leg to workflow step format
    // Find the step that corresponds to this leg from workflow template
    const workflowTemplate = this.workflowTemplate;
    if (!workflowTemplate || !workflowTemplate.steps) {
      throw new Error('Workflow template not loaded or has no steps');
    }
    
    // Find the cycle step that processes legs
    const cycleStep = workflowTemplate.steps.find(s => 
      s.type === 'cycle' && s.config?.cycleType === 'leg'
    );
    
    if (!cycleStep) {
      throw new Error('No cycle step found for legs in workflow template');
    }
    
    // Execute the cycle step - it will handle the leg
    const templateSteps = workflowTemplate.steps || [];
    const cycleIndex = templateSteps.findIndex(s => s && cycleStep && s.id === cycleStep.id);
    return await this.executeStep(page, jobId, workflowId, cycleStep, {
      parentSteps: templateSteps,
      stepIndex: cycleIndex >= 0 ? cycleIndex : null
    });
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
    const workflowSteps = Array.isArray(workflow.steps) ? workflow.steps : [];

    // Execute each step sequentially
    for (let index = 0; index < workflowSteps.length; index++) {
      const step = workflowSteps[index];
      if (step.status === 'pending') {
        const result = await this.executeStep(page, jobId, workflowId, step, {
          parentSteps: workflowSteps,
          stepIndex: index
        });
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
   * OLD HARDCODED CODE REMOVED - All execution now goes through workflow steps
   */
  async _OLD_executeWorkflow(page, jobId, workflowId) {
    // This method is intentionally left empty - all old hardcoded loops removed
    // All execution now goes through executeWorkflow which delegates to workflow step types
    throw new Error('Old hardcoded executeWorkflow method removed - use workflow steps instead');
  }

  /**
   * DUPLICATE METHOD REMOVED
   */
  async _OLD_executeWorkflow_DUPLICATE(page, jobId, workflowId) {
    // This was a duplicate - removed
    throw new Error('Duplicate method removed');
  }

  /**
   * Check if script has incomplete string literals
   * Returns true if any string literal is incomplete (unmatched quotes)
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
   * Check if script has incomplete string literals
   * Returns true if any string literal is incomplete (unmatched quotes)
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
   * Sanitize script to remove incomplete xpath entries from arrays
   * Fixes incomplete strings like 'xpath= or "xpath= that are not closed
   */
  sanitizeIncompleteXpathStrings(script) {
    if (!script || typeof script !== 'string') {
      return script;
    }
    
    let sanitized = script;
    
    // Split by lines to handle incomplete strings that span lines
    const lines = sanitized.split('\n');
    const sanitizedLines = [];
    
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      
      // Check if line contains incomplete xpath string (ends with 'xpath= or "xpath= or `xpath=)
      // This pattern matches incomplete xpath strings that don't have a closing quote on the same line
      const incompleteXpathPattern = /['"`]\s*xpath\s*=\s*(?![^'"`\n]*['"`])/;
      
      if (incompleteXpathPattern.test(line)) {
        // Check if this is part of an array (has comma before or after)
        const isArrayEntry = line.includes(',') || (i > 0 && lines[i-1].includes('[')) || (i < lines.length - 1 && lines[i+1].includes(']'));
        
        if (isArrayEntry) {
          // Remove the incomplete xpath entry from the array
          // Remove: , 'xpath= or , "xpath= or , `xpath= (with optional whitespace)
          line = line.replace(/,\s*['"`]\s*xpath\s*=\s*(?![^'"`\n]*['"`])/g, '');
          // Remove: ['xpath= or ["xpath= or [`xpath= at start
          line = line.replace(/(\[\s*)['"`]\s*xpath\s*=\s*(?![^'"`\n]*['"`])/g, '$1');
          // Remove: 'xpath=] or "xpath=] or `xpath=] before closing bracket
          line = line.replace(/['"`]\s*xpath\s*=\s*(?![^'"`\n]*['"`])\s*\]/g, ']');
        } else {
          // Not an array entry, just remove the entire line if it's just an incomplete xpath
          if (/^\s*['"`]\s*xpath\s*=\s*(?![^'"`\n]*['"`])\s*$/.test(line.trim())) {
            continue; // Skip this line
          }
          // Otherwise, try to remove just the incomplete part
          line = line.replace(/['"`]\s*xpath\s*=\s*(?![^'"`\n]*['"`])/g, '');
        }
      }
      
      sanitizedLines.push(line);
    }
    
    sanitized = sanitizedLines.join('\n');
    
    // Final cleanup: remove double commas and commas before closing brackets
    sanitized = sanitized.replace(/,\s*,/g, ',');
    sanitized = sanitized.replace(/,\s*\]/g, ']');
    sanitized = sanitized.replace(/,\s*$/gm, '');
    
    return sanitized;
  }

  /**
   * Clean script WITHOUT sanitization - preserves all content
   * Only removes markdown code blocks and function wrappers
   */
  cleanScriptWithoutSanitization(script) {
    if (!script || typeof script !== 'string') {
      return script;
    }
    
    // DO NOT sanitize - preserve full script content
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
   * Clean script - DEPRECATED: Use cleanScriptWithoutSanitization instead
   * Kept for backwards compatibility but sanitization is disabled
   */
  cleanScript(script) {
    // Use the version without sanitization to preserve full script
    return this.cleanScriptWithoutSanitization(script);
  }

  /**
   * Execute Playwright script in page context
   */
  async executeScript(page, script, jobId = null) {
    const startTime = Date.now();
    const originalScriptLength = script?.length || 0;
    
    try {
      // DO NOT clean or sanitize the script - use it exactly as provided
      // Log script execution start if jobId available
      if (jobId && this.backendLogger) {
        await this.backendLogger.appendJobLog(jobId, 'debug',
          `🎭 Starting script execution (${originalScriptLength} chars)`,
          'ENHANCED-WORKFLOW-EXECUTOR',
          {
            original_script_length: originalScriptLength,
            script_preview: script?.substring(0, 300) || 'N/A',
            page_url: page.url()
          }
        );
      }
      
      if (!script || script.trim().length === 0) {
        const error = 'Script is empty';
        if (jobId && this.backendLogger) {
          await this.backendLogger.appendJobLog(jobId, 'error',
            `❌ ${error}`,
            'ENHANCED-WORKFLOW-EXECUTOR',
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
          'ENHANCED-WORKFLOW-EXECUTOR',
          {
            url_before: urlBefore,
            title_before: titleBefore
          }
        );
      }
      
      // Add human-like pre-execution behaviors
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
        console.warn(`[ENHANCED-WORKFLOW-EXECUTOR] Human behavior injection warning: ${error.message}`);
      }
      
      // Playwright scripts must execute in Node.js context, not browser context
      // The 'page' object is available in Node.js, not in browser
      
      // Create action-logged page wrapper to intercept and log all Playwright actions
      const { createActionLoggedPage } = await import('../../playwright-action-logger.js');
      const loggedPage = createActionLoggedPage(page, jobId);
      
      // Create an async function that has access to the page object
      const executeInNodeContext = async (pageObj, scriptCode) => {
        // Use string concatenation (not template literals) to avoid escaping issues
        // This allows the script code to contain backticks, ${}, etc. without problems
        const functionBody = 'return (async function() {\n' + scriptCode + '\n})();';
        
        // Create a function with page and wrapper (alias) as parameters - AI may use either name
        const fn = new Function('page', 'wrapper', functionBody);
        return await fn(pageObj, pageObj);
      };
      
      // DO NOT validate or check for incomplete strings - execute script as-is from OpenAI
      
      // Wrap script execution with timeout (increased to 45 seconds to match workflow step timeout)
      const result = await Promise.race([
        executeInNodeContext(loggedPage, cleanedScript),
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
          'ENHANCED-WORKFLOW-EXECUTOR',
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
          'ENHANCED-WORKFLOW-EXECUTOR',
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
      const response = await axios.get(`${this.backendUrl}/api/workflow-templates/${workflowId}`, {
        headers: this.getAuthHeaders()
      });
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
      await axios.post(`${this.backendUrl}/api/jobs/${jobId}/substatus`, {
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

