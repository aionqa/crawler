/**
 * Workflow Functions for Crawler
 * Implements individual workflow step functions that can be called by backend
 * Each function is stateless and receives context from backend
 */

import axios from 'axios';
import { AIConversationLogger } from '../../../shared/ai-conversation-logger.js';

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
    
    // Get model and options from step config or use project default
    // Use undefined (not null) for optional values so project defaults can be used
    const stepModel = parameters.model || undefined;
    const stepReasoningEnabled = parameters.reasoning_enabled !== undefined ? parameters.reasoning_enabled : undefined;
    const stepWebsearchEnabled = parameters.websearch_enabled !== undefined ? parameters.websearch_enabled : undefined;
    
    // GPT-5 specific options - only include in payload if explicitly set
    const stepTextFormat = parameters.text_format || undefined;
    const stepReasoningEffort = parameters.reasoning_effort !== undefined ? parameters.reasoning_effort : undefined;
    const stepVerbosity = parameters.verbosity !== undefined ? parameters.verbosity : undefined;
    const stepStoreLogs = parameters.store_logs !== undefined ? parameters.store_logs : undefined;
    
    // Make AI call - makeAICallWithPrompt has built-in retry logic (2 attempts)
    // Don't add outer retry loop to avoid duplicate calls
    try {
      // Get step name from context or parameters
      const stepName = context?.stepName || parameters?.name || stepId || 'AI Request';
      
      const result = await aiLogger.makeAICallWithPrompt(
        parameters.prompt,
        {
          ...attachments,
          ...contextualPayload,
          pageUrl: context.pageUrl,
          jobId: context.jobId,
          project_id: context.project_id || context.projectId || null, // Pass project_id for LLM config lookup
          projectId: context.project_id || context.projectId || null, // Also pass as projectId for compatibility
          // Only include these in payload if explicitly set (undefined values will be omitted)
          ...(stepModel !== undefined && { model: stepModel }),
          ...(stepReasoningEnabled !== undefined && { reasoning_enabled: stepReasoningEnabled }),
          ...(stepWebsearchEnabled !== undefined && { websearch_enabled: stepWebsearchEnabled }),
          ...(stepTextFormat !== undefined && { text_format: stepTextFormat }),
          ...(stepReasoningEffort !== undefined && { reasoning_effort: stepReasoningEffort }),
          ...(stepVerbosity !== undefined && { verbosity: stepVerbosity }),
          ...(stepStoreLogs !== undefined && { store_logs: stepStoreLogs })
        },
        jobId,
        'workflow-ai-request',
        context.pageUrl,
        null,
        {
          ...attachments,
          step_id: stepId,
          step_name: stepName,
          workflow_step: true
        },
        promptTemplate,
        1, // attemptNumber (makeAICallWithPrompt will retry internally if needed)
        null, // previousError
        stepModel, // modelOverride
        stepReasoningEnabled, // reasoningEnabled
        stepWebsearchEnabled // websearchEnabled
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
      const skipCaptchaForms = parameters.skipCaptchaForms === true;
      const skipMailpoetForms = parameters.skipMailpoetForms === true;
      
      analysis.forms = await page.$$eval('form', (forms, skipCaptcha, skipMailpoet) => {
        return forms
          .filter(form => {
            // Skip captcha forms if requested
            if (skipCaptcha || skipMailpoet) {
              const formId = form.id || '';
              const formClass = form.className || '';
              const formName = form.name || '';
              
              // Skip mailpoet captcha forms
              if (skipMailpoet && (
                formId.includes('mailpoet') && formId.includes('captcha') ||
                formId === 'mailpoet_captcha_form' ||
                formClass.includes('mailpoet') && formClass.includes('captcha')
              )) {
                return false;
              }
              
              // Skip generic captcha forms
              if (skipCaptcha && (
                formId.toLowerCase().includes('captcha') ||
                formClass.toLowerCase().includes('captcha') ||
                formName.toLowerCase().includes('captcha')
              )) {
                return false;
              }
            }
            return true;
          })
          .map(form => ({
            id: form.id || '',
            action: form.action,
            method: form.method || 'GET',
            fields: Array.from(form.elements)
              .filter(el => el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')
              .map(el => ({
                name: el.name || '',
                type: el.type || 'text',
                required: el.required || false,
                placeholder: el.placeholder || '',
                id: el.id || ''
              }))
          }));
      }, skipCaptchaForms, skipMailpoetForms);
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
      const onlyVisibleInteractiveElements = parameters.onlyVisibleInteractiveElements === true;
      const skipHiddenElements = parameters.skipHiddenElements === true;
      
      analysis.interactiveElements = await page.$$eval(
        'button, input, select, textarea, [onclick], [role="button"]',
        (elements, onlyVisible, skipHidden) => {
          // Helper to check if element or any parent is hidden
          const isElementOrParentHidden = (el) => {
            let current = el;
            while (current && current !== document.body) {
              const style = window.getComputedStyle(current);
              const rect = current.getBoundingClientRect();
              
              // Check if element itself is hidden
              if (style.visibility === 'hidden' ||
                  style.display === 'none' ||
                  parseFloat(style.opacity) === 0 ||
                  rect.width === 0 ||
                  rect.height === 0 ||
                  current.hasAttribute('hidden') ||
                  current.getAttribute('aria-hidden') === 'true') {
                return true;
              }
              
              current = current.parentElement;
            }
            return false;
          };
          
          return elements
            .map(el => {
              const style = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              const isVisible = !!style &&
                style.visibility !== 'hidden' &&
                style.display !== 'none' &&
                parseFloat(style.opacity) > 0 &&
                rect.width > 0 &&
                rect.height > 0 &&
                !el.hasAttribute('hidden') &&
                el.getAttribute('aria-hidden') !== 'true';
              
              // Enhanced hidden check - also check parent containers
              const isParentHidden = skipHidden && isElementOrParentHidden(el);
              
              if (onlyVisible && (!isVisible || isParentHidden)) {
                return null;
              }
              
              return {
                tagName: el.tagName,
                type: el.type,
                text: el.textContent?.trim(),
                placeholder: el.placeholder,
                id: el.id,
                className: el.className,
                onclick: el.onclick?.toString(),
                visible: isVisible,
                isHidden: isParentHidden
              };
            })
            .filter(Boolean);
        },
        onlyVisibleInteractiveElements,
        skipHiddenElements || false
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

    // Clean the code to remove markdown code blocks and function declarations
    code = cleanScript(code);
    
    if (!code || code.trim().length === 0) {
      throw new Error('Script is empty after cleaning');
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


