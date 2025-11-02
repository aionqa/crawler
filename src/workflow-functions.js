/**
 * Workflow Functions for Crawler
 * Implements individual workflow step functions that can be called by backend
 * Each function is stateless and receives context from backend
 */

import axios from 'axios';
import { AIConversationLogger } from '/app/shared/ai-conversation-logger.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://back:4000';

/**
 * AI Request - Send prompt to AI with schema validation
 */
export async function executeAiRequest(page, jobId, stepId, parameters, context) {
  console.log(`[WORKFLOW-FUNCTIONS] Executing AI Request: ${stepId}`);
  
  try {
    const RUNNER_TOKEN = process.env.RUNNER_TOKEN;
    const aiLogger = new AIConversationLogger(BACKEND_URL, RUNNER_TOKEN);
    
    // Get prompt template from backend
    const promptResponse = await axios.get(`${BACKEND_URL}/api/prompts/${parameters.prompt}`);
    const promptTemplate = promptResponse.data;
    
    if (!promptTemplate) {
      throw new Error(`Prompt template ${parameters.prompt} not found`);
    }

    // Prepare attachments based on configuration
    const attachments = await prepareAttachments(page, parameters.attachments || [], context);

    const contextFields = Array.isArray(parameters.contextFields) ? parameters.contextFields : [];
    const contextualPayload = {};
    for (const field of contextFields) {
      if (!field) continue;
      if (typeof field === 'string') {
        const value = getNestedValue(context?.workflowState || context || {}, field);
        if (value !== undefined) {
          const key = field.split('.').pop();
          contextualPayload[key] = value;
        }
        continue;
      }

      const path = field.path || field.key || field.name;
      if (!path) continue;
      const alias = field.name || field.key || path.split('.').pop();
      const source = field.source || field.from || 'workflowState';
      const sourceObject = source === 'context' ? (context || {}) : (context?.workflowState || {});
      const value = getNestedValue(sourceObject, path);
      if (value !== undefined) {
        contextualPayload[alias] = value;
      }
    }
    
    // Make AI call with retry logic
    let lastError = null;
    for (let attempt = 1; attempt <= (parameters.maxRetries || 3); attempt++) {
      try {
        const result = await aiLogger.makeAICallWithPrompt(
          parameters.prompt,
          {
            ...attachments,
            ...contextualPayload,
            pageUrl: context.pageUrl,
            jobId: context.jobId
          },
          jobId,
          'workflow-ai-request',
          context.pageUrl,
          null,
          attachments,
          promptTemplate
        );

        // Validate response schema if provided
        if (parameters.outputSchema) {
          const schema = typeof parameters.outputSchema === 'string' 
            ? JSON.parse(parameters.outputSchema) 
            : parameters.outputSchema;
          
          if (!validateSchema(result, schema)) {
            throw new Error('AI response does not match required schema');
          }
        }

        const responsePayload = {
          success: true,
          result: result,
          attempt: attempt,
          prompt: parameters.prompt,
          lastAIResponse: result
        };

        if (parameters.storeResultAs) {
          responsePayload[parameters.storeResultAs] = result;
        }

        if (parameters.mergeResultIntoContext && typeof result === 'object' && result !== null) {
          Object.assign(responsePayload, result);
        }

        return responsePayload;

      } catch (error) {
        lastError = error;
        console.log(`[WORKFLOW-FUNCTIONS] AI Request attempt ${attempt} failed:`, error.message);
        
        if (attempt < (parameters.maxRetries || 3)) {
          await sleep(2000 * attempt); // Exponential backoff
        }
      }
    }

    throw lastError || new Error('AI Request failed after all retries');

  } catch (error) {
    console.error(`[WORKFLOW-FUNCTIONS] AI Request failed:`, error);
    return {
      success: false,
      error: error.message,
      stepId: stepId
    };
  }
}

/**
 * Screenshot - Capture page screenshot
 */
export async function executeScreenshot(page, jobId, stepId, parameters, context) {
  console.log(`[WORKFLOW-FUNCTIONS] Executing Screenshot: ${stepId}`);
  
  try {
    const screenshotOptions = {
      fullPage: parameters.fullPage !== false,
      quality: parameters.quality || 90
    };

    const screenshot = await page.screenshot(screenshotOptions);
    
    let screenshotKey = null;
    if (parameters.upload !== false) {
      // Upload to MinIO via backend
      const uploadResponse = await axios.post(`${BACKEND_URL}/api/files/prepare-screenshot`, {
        jobId: jobId,
        filename: `screenshot_${stepId}_${Date.now()}.png`
      });
      
      screenshotKey = uploadResponse.data.key;
      const uploadUrl = uploadResponse.data.uploadUrl;
      
      // Upload to MinIO
      await axios.put(uploadUrl, screenshot, {
        headers: { 'Content-Type': 'image/png' }
      });
    }

    return {
      success: true,
      result: {
        screenshotKey: screenshotKey,
        fullPage: screenshotOptions.fullPage,
        quality: screenshotOptions.quality
      },
      stepId: stepId
    };

  } catch (error) {
    console.error(`[WORKFLOW-FUNCTIONS] Screenshot failed:`, error);
    return {
      success: false,
      error: error.message,
      stepId: stepId
    };
  }
}

/**
 * Playwright Analysis - Analyze page with Playwright
 */
export async function executePlaywrightAnalysis(page, jobId, stepId, parameters, context) {
  console.log(`[WORKFLOW-FUNCTIONS] Executing Playwright Analysis: ${stepId}`);
  
  try {
    const analysis = {};

    if (parameters.collectForms !== false) {
      analysis.forms = await page.$$eval('form', forms => 
        forms.map(form => ({
          action: form.action,
          method: form.method,
          fields: Array.from(form.elements).map(el => ({
            name: el.name,
            type: el.type,
            required: el.required,
            placeholder: el.placeholder
          }))
        }))
      );
    }

    if (parameters.collectLinks !== false) {
      analysis.links = await page.$$eval('a[href]', links => 
        links.map(link => ({
          href: link.href,
          text: link.textContent?.trim(),
          title: link.title
        }))
      );
    }

    if (parameters.collectInteractiveElements !== false) {
      analysis.interactiveElements = await page.$$eval(
        'button, input, select, textarea, [onclick], [role="button"]',
        elements => elements.map(el => ({
          tagName: el.tagName,
          type: el.type,
          text: el.textContent?.trim(),
          placeholder: el.placeholder,
          id: el.id,
          className: el.className,
          onclick: el.onclick?.toString()
        }))
      );
    }

    return {
      success: true,
      result: analysis,
      stepId: stepId
    };

  } catch (error) {
    console.error(`[WORKFLOW-FUNCTIONS] Playwright Analysis failed:`, error);
    return {
      success: false,
      error: error.message,
      stepId: stepId
    };
  }
}

/**
 * Execute Code - Execute Playwright JavaScript code
 */
export async function executeCode(page, jobId, stepId, parameters, context) {
  console.log(`[WORKFLOW-FUNCTIONS] Executing Code: ${stepId}`);
  
  try {
    const workflowState = context?.workflowState || {};
    let code = parameters.code;
    const codeField = parameters.codeField || parameters.sourceField;

    if (!code && codeField) {
      const normalizedPath = codeField.startsWith('workflowState.')
        ? codeField.substring('workflowState.'.length)
        : codeField;
      code = getNestedValue(workflowState, normalizedPath);
      if (code === undefined) {
        code = getNestedValue(context || {}, normalizedPath);
      }
      console.log(`[WORKFLOW-FUNCTIONS] Resolved code from "${codeField}": ${code ? 'found' : 'not found'}`);
    }

    if (!code) {
      throw new Error('No code provided for execution');
    }

    const timeout = parameters.timeout || 30000;

    const result = await page.evaluate(
      ({ code, workflowState, timeout }) => {
        const runner = new Function(
          'workflowState',
          `return (async () => {\n${code}\n})();`
        );

        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`Code execution timed out after ${timeout}ms`));
          }, timeout);

          Promise.resolve(runner(workflowState))
            .then(result => {
              clearTimeout(timer);
              resolve(result);
            })
            .catch(error => {
              clearTimeout(timer);
              reject(error);
            });
        });
      },
      { code, workflowState, timeout }
    );

    return {
      success: true,
      result: result,
      stepId: stepId,
      code: code,
      lastExecutionResult: result
    };

  } catch (error) {
    console.error(`[WORKFLOW-FUNCTIONS] Execute Code failed:`, error);
    return {
      success: false,
      error: error.message,
      stepId: stepId
    };
  }
}

/**
 * Conditional - Execute conditional logic
 */
export async function executeConditional(page, jobId, stepId, parameters, context) {
  console.log(`[WORKFLOW-FUNCTIONS] Executing Conditional: ${stepId}`);
  
  try {
    const condition = parameters.condition;
    if (!condition) {
      throw new Error('No condition provided');
    }

    // Evaluate condition in the context of workflow state
    const conditionResult = evaluateCondition(condition, context.workflowState);
    
    const nextStep = conditionResult ? parameters.onTrue : parameters.onFalse;

    return {
      success: true,
      result: {
        condition: condition,
        result: conditionResult,
        nextStep: nextStep
      },
      stepId: stepId,
      nextStep: nextStep
    };

  } catch (error) {
    console.error(`[WORKFLOW-FUNCTIONS] Conditional failed:`, error);
    return {
      success: false,
      error: error.message,
      stepId: stepId
    };
  }
}

/**
 * Validate Response - Validate step response schema
 */
export async function executeValidateResponse(page, jobId, stepId, parameters, context) {
  console.log(`[WORKFLOW-FUNCTIONS] Executing Validate Response: ${stepId}`);
  
  try {
    const responseField = parameters.responseField;
    const schema = parameters.schema;
    
    if (!responseField || !schema) {
      throw new Error('Response field and schema are required');
    }

    // Get the response value from workflow state
    const responseValue = getNestedValue(context.workflowState, responseField);
    
    if (!validateSchema(responseValue, schema)) {
      throw new Error(`Response does not match schema for field: ${responseField}`);
    }

    return {
      success: true,
      result: {
        field: responseField,
        valid: true,
        value: responseValue
      },
      stepId: stepId
    };

  } catch (error) {
    console.error(`[WORKFLOW-FUNCTIONS] Validate Response failed:`, error);
    return {
      success: false,
      error: error.message,
      stepId: stepId
    };
  }
}

/**
 * Filter & Replace - Filter and replace response data
 */
export async function executeFilterReplace(page, jobId, stepId, parameters, context) {
  console.log(`[WORKFLOW-FUNCTIONS] Executing Filter & Replace: ${stepId}`);
  
  try {
    const filter = parameters.filter;
    const replacePattern = parameters.replacePattern;
    const replaceValue = parameters.replaceValue;
    const outputField = parameters.outputField || 'filtered_data';
    
    if (!filter) {
      throw new Error('Filter expression is required');
    }

    // Get input data from workflow state
    const inputData = context.workflowState.results || {};
    
    // Apply filter (simplified jq-like filtering)
    let filteredData = applyFilter(inputData, filter);
    
    // Apply replace if pattern provided
    if (replacePattern && replaceValue) {
      filteredData = applyReplace(filteredData, replacePattern, replaceValue);
    }

    return {
      success: true,
      result: {
        [outputField]: filteredData,
        filter: filter,
        replacePattern: replacePattern,
        replaceValue: replaceValue
      },
      stepId: stepId
    };

  } catch (error) {
    console.error(`[WORKFLOW-FUNCTIONS] Filter & Replace failed:`, error);
    return {
      success: false,
      error: error.message,
      stepId: stepId
    };
  }
}

/**
 * Log to History - Log step to job history
 */
export async function executeLogToHistory(page, jobId, stepId, parameters, context) {
  console.log(`[WORKFLOW-FUNCTIONS] Executing Log to History: ${stepId}`);
  
  try {
    const message = parameters.message || 'Step completed';
    const level = parameters.level || 'info';
    const includeContext = parameters.includeContext || false;
    
    // Resolve variables in message
    const resolvedMessage = resolveVariables(message, context.workflowState);
    
    // Prepare log data
    const logData = {
      jobId: jobId,
      level: level,
      message: resolvedMessage,
      component: 'workflow-step',
      metadata: {
        stepId: stepId,
        stepType: 'log-to-history',
        timestamp: new Date().toISOString()
      }
    };
    
    if (includeContext) {
      logData.metadata.context = context.workflowState;
    }

    // Send log to backend
    await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, logData);

    return {
      success: true,
      result: {
        message: resolvedMessage,
        level: level,
        logged: true
      },
      stepId: stepId
    };

  } catch (error) {
    console.error(`[WORKFLOW-FUNCTIONS] Log to History failed:`, error);
    return {
      success: false,
      error: error.message,
      stepId: stepId
    };
  }
}

/**
 * Skip to Next Page - Skip to next page in crawl
 */
export async function executeSkipToNextPage(page, jobId, stepId, parameters, context) {
  console.log(`[WORKFLOW-FUNCTIONS] Executing Skip to Next Page: ${stepId}`);
  
  try {
    const reason = parameters.reason || 'Page not relevant for testing';
    const logSkip = parameters.logSkip !== false;
    
    if (logSkip) {
      await executeLogToHistory(page, jobId, stepId, {
        message: `Skipping page: ${reason}`,
        level: 'info'
      }, context);
    }

    return {
      success: true,
      result: {
        skipped: true,
        reason: reason
      },
      stepId: stepId,
      skipToNextPage: true
    };

  } catch (error) {
    console.error(`[WORKFLOW-FUNCTIONS] Skip to Next Page failed:`, error);
    return {
      success: false,
      error: error.message,
      stepId: stepId
    };
  }
}

/**
 * Stop Job - Stop entire job execution
 */
export async function executeStopJob(page, jobId, stepId, parameters, context) {
  console.log(`[WORKFLOW-FUNCTIONS] Executing Stop Job: ${stepId}`);
  
  try {
    const reason = parameters.reason || 'Job stopped';
    const exitCode = parameters.exitCode || '1';
    const logStop = parameters.logStop !== false;
    
    if (logStop) {
      await executeLogToHistory(page, jobId, stepId, {
        message: `Stopping job: ${reason}`,
        level: 'error'
      }, context);
    }

    return {
      success: true,
      result: {
        stopped: true,
        reason: reason,
        exitCode: exitCode
      },
      stepId: stepId,
      stopJob: true
    };

  } catch (error) {
    console.error(`[WORKFLOW-FUNCTIONS] Stop Job failed:`, error);
    return {
      success: false,
      error: error.message,
      stepId: stepId
    };
  }
}

// Helper functions

async function prepareAttachments(page, attachmentTypes, context = {}) {
  const attachments = {};
  
  for (const type of attachmentTypes) {
    switch (type) {
      case 'visible_text':
        attachments.visible_text = await page.textContent('body');
        break;
      case 'interactive_elements':
        attachments.interactive_elements = await page.$$eval(
          'button, input, select, textarea, [onclick], [role="button"]',
          elements => elements.map(el => ({
            tagName: el.tagName,
            text: el.textContent?.trim(),
            type: el.type,
            id: el.id,
            className: el.className
          }))
        );
        break;
      case 'screenshot':
        const screenshot = await page.screenshot({ fullPage: true });
        attachments.screenshot_base64 = screenshot.toString('base64');
        attachments.screenshot = attachments.screenshot_base64;
        break;
      case 'page_description':
        // This would be populated by a previous step
        break;
      case 'current_action':
        attachments.current_action = getNestedValue(context?.workflowState || context || {}, 'currentAction');
        break;
      case 'current_item':
        attachments.current_item = getNestedValue(context?.workflowState || context || {}, 'currentItem');
        break;
      case 'current_leg':
        attachments.current_leg = getNestedValue(context?.workflowState || context || {}, 'currentLeg');
        break;
      case 'forms':
        attachments.forms = getNestedValue(context?.workflowState || context || {}, 'forms')
          || getNestedValue(context?.workflowState || context || {}, 'playwrightAnalysis.forms');
        break;
      case 'last_execution_result':
        attachments.last_execution_result = getNestedValue(context?.workflowState || context || {}, 'lastExecutionResult');
        break;
      case 'playwright_analysis':
        attachments.playwright_analysis = getNestedValue(context?.workflowState || context || {}, 'playwrightAnalysis');
        break;
    }
  }
  
  return attachments;
}

function validateSchema(data, schema) {
  // Simple schema validation - in production, use a proper JSON schema validator
  if (schema.type === 'object' && typeof data !== 'object') {
    return false;
  }
  if (schema.required) {
    for (const field of schema.required) {
      if (!(field in data)) {
        return false;
      }
    }
  }
  return true;
}

function evaluateCondition(condition, workflowState) {
  // Simple condition evaluation - in production, use a proper expression evaluator
  try {
    // Replace variables in condition
    const resolvedCondition = resolveVariables(condition, workflowState);
    
    // Evaluate as JavaScript expression
    return eval(resolvedCondition);
  } catch (error) {
    console.error(`[WORKFLOW-FUNCTIONS] Condition evaluation failed:`, error);
    return false;
  }
}

function getNestedValue(obj, path) {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

function applyFilter(data, filter) {
  // Simple filter implementation - in production, use a proper jq-like filter
  try {
    // For now, just return the data as-is
    // In production, implement proper jq-like filtering
    return data;
  } catch (error) {
    console.error(`[WORKFLOW-FUNCTIONS] Filter application failed:`, error);
    return data;
  }
}

function applyReplace(data, pattern, value) {
  // Simple replace implementation
  if (typeof data === 'string') {
    const regex = new RegExp(pattern, 'g');
    return data.replace(regex, value);
  }
  return data;
}

function resolveVariables(template, context) {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, variable) => {
    const value = getNestedValue(context, variable.trim());
    return value !== undefined ? String(value) : match;
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


