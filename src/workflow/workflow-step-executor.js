import { chromium } from 'playwright';
import axios from 'axios';
import { AIConversationLogger } from '../../shared/ai-conversation-logger.js';
import * as BackendLogger from '../backend-logger.js';
import { getRunnerBackendUrl } from '../utils/runner-service-urls.js';
import { gatherDomCandidatesAcrossFrames } from '../utils/page-element-candidates.js';

/**
 * WorkflowStepExecutor
 * Contains all executable functions for workflow steps
 * Each function is stateless and can be called independently
 */
export class WorkflowStepExecutor {
  constructor() {
    this.backendUrl = getRunnerBackendUrl();
    const RUNNER_TOKEN = process.env.RUNNER_TOKEN;
    this.aiLogger = new AIConversationLogger(this.backendUrl, RUNNER_TOKEN);
    this.activeBrowsers = new Map(); // Track active browser instances per job
  }

  /**
   * Clean script to remove markdown code blocks and function declarations
   */
  cleanScript(script) {
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

  /**
   * Get or create browser instance for job
   */
  async getBrowserForJob(jobId) {
    if (!this.activeBrowsers.has(jobId)) {
      // Import stealth configuration
      const { getStealthLaunchArgs } = await import('../browser/stealth-config.js');
      
      const browser = await chromium.launch({
        headless: true,
        args: getStealthLaunchArgs()
      });
      this.activeBrowsers.set(jobId, browser);
    }
    return this.activeBrowsers.get(jobId);
  }

  /**
   * Get or create page for job
   */
  async getPageForJob(jobId, context) {
    const browser = await this.getBrowserForJob(jobId);
    const page = await browser.newPage();
    
    // Inject stealth scripts to hide automation
    const { injectStealthScripts } = await import('../browser/stealth-config.js');
    await injectStealthScripts(page);
    
    // Navigate to URL if provided
    if (context.pageUrl) {
      try {
        await page.goto(context.pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {
          console.warn(`[WorkflowStepExecutor] Page DOM not fully loaded after 30s, continuing anyway`);
        });
      } catch (error) {
        console.warn(`[WorkflowStepExecutor] Navigation failed: ${error.message}`);
        // Continue without navigation for testing
      }
    }
    
    return page;
  }

  /**
   * Execute Screenshot Step
   */
  async executeScreenshotStep(jobId, stepId, parameters, context) {
    const startTime = Date.now();
    console.log(`[WorkflowStepExecutor] Executing screenshot step for job ${jobId}`);
    
    try {
      const page = await this.getPageForJob(jobId, context);
      const { resolveScreenshotFullPage } = await import('./utils/resolve-screenshot-full-page.js');
      const fullPage = await resolveScreenshotFullPage(page, {
        fullPage: parameters.fullPage !== false,
        allowRiskyFullPageOnImageDocument: parameters.allowRiskyFullPageOnImageDocument === true
      });
      if (parameters.fullPage !== false && !fullPage) {
        console.log('[WorkflowStepExecutor] Viewport screenshot for image/SVG document (fullPage skipped)');
      }

      const screenshotOptions = {
        fullPage,
        type: 'png'
      };

      const screenshotBuffer = await page.screenshot(screenshotOptions);
      const screenshotBase64 = screenshotBuffer.toString('base64');
      
      // Upload to MinIO if requested
      let screenshotUrl = null;
      let screenshotFileId = null;
      
      if (parameters.upload !== false) {
        try {
          const uploadResponse = await BackendLogger.prepareScreenshotUpload(jobId, 'workflow-screenshot');
          screenshotUrl = uploadResponse.url;
          screenshotFileId = uploadResponse.fileId;
          
          // Upload the screenshot
          await fetch(uploadResponse.uploadUrl, {
            method: 'PUT',
            body: screenshotBuffer,
            headers: { 'Content-Type': 'image/png' }
          });
        } catch (uploadError) {
          console.warn(`[WorkflowStepExecutor] Screenshot upload failed: ${uploadError.message}`);
        }
      }
      
      const result = {
        screenshotBase64,
        screenshotUrl,
        screenshotFileId,
        dimensions: {
          width: await page.viewportSize()?.width || 1920,
          height: await page.viewportSize()?.height || 1080
        }
      };
      
      return {
        ...result,
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      console.error(`[WorkflowStepExecutor] Screenshot step failed:`, error);
      throw error;
    }
  }

  /**
   * Execute Playwright Analysis Step
   */
  async executePlaywrightAnalysisStep(jobId, stepId, parameters, context) {
    const startTime = Date.now();
    console.log(`[WorkflowStepExecutor] Executing playwright analysis step for job ${jobId}`);
    
    try {
      const page = await this.getPageForJob(jobId, context);
      
      const analysis = {
        forms: [],
        links: [],
        interactive_elements: []
      };
      
      // Collect forms if requested
      if (parameters.collectForms !== false) {
        const forms = await page.$$('form');
        for (const form of forms) {
          const inputs = await form.$$('input, textarea, select');
          const buttons = await form.$$('button, input[type="submit"]');
          
          const formData = {
            selector: await this.getElementSelector(form),
            action: await form.getAttribute('action'),
            method: await form.getAttribute('method'),
            inputs: await Promise.all(inputs.map(async input => ({
              name: await input.getAttribute('name'),
              type: await input.getAttribute('type'),
              placeholder: await input.getAttribute('placeholder'),
              selector: await this.getElementSelector(input)
            }))),
            buttons: await Promise.all(buttons.map(async button => ({
              text: await button.textContent(),
              type: await button.getAttribute('type'),
              selector: await this.getElementSelector(button)
            })))
          };
          
          analysis.forms.push(formData);
        }
      }
      
      // Collect links if requested
      if (parameters.collectLinks !== false) {
        const links = await page.$$('a[href]');
        for (const link of links) {
          const href = await link.getAttribute('href');
          const text = await link.textContent();
          const selector = await this.getElementSelector(link);
          
          analysis.links.push({
            text: text?.trim(),
            href,
            selector
          });
        }
      }
      
      // Collect interactive elements if requested
      const onlyVisibleInteractiveElements = parameters.onlyVisibleInteractiveElements === true;
      if (parameters.collectInteractiveElements !== false) {
        const domCandidates = await gatherDomCandidatesAcrossFrames(page, {
          perFrameCap: 280,
          maxTotal: 500,
        });
        for (const row of domCandidates) {
          const elementData = {
            tag: row.type,
            text: row.text,
            selector: row.selector,
            attributes: {
              role: row.role,
              tabindex: row.tabindex,
              href: row.href,
              name: row.name,
              id: row.id,
              placeholder: row.placeholder,
              has_onclick: row.has_onclick,
            },
            visible: true,
            click_targets_undetermined: true,
            in_frame: row.in_frame,
            frame_url: row.frame_url,
          };
          if (!onlyVisibleInteractiveElements || elementData.visible) {
            analysis.interactive_elements.push(elementData);
          }
        }
      }
      
      return {
        ...analysis,
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      console.error(`[WorkflowStepExecutor] Playwright analysis step failed:`, error);
      throw error;
    }
  }

  /**
   * Execute Page Description Step
   */
  async executePageDescriptionStep(jobId, stepId, parameters, context) {
    const startTime = Date.now();
    console.log(`[WorkflowStepExecutor] Executing page description step for job ${jobId}`);
    
    try {
      const page = await this.getPageForJob(jobId, context);
      
      // Get page information
      const pageTitle = await page.title();
      const pageUrl = page.url();
      const visibleText = await page.evaluate(() => {
        return document.body.innerText || document.body.textContent || '';
      });
      
      // Prepare AI request
      const promptName = parameters.prompt || 'universal-page-description';
      const attachments = parameters.attachments || ['visible_text'];
      
      const descriptionPayload = {
        page_title: pageTitle,
        page_url: pageUrl,
        visible_text: visibleText.substring(0, 2000), // Limit text length
        additional_prompt_text: context.additional_prompt_text || ''
      };
      
      // Make AI call
      const aiResponse = await this.aiLogger.makeAICallWithPrompt(
        promptName,
        descriptionPayload,
        jobId,
        `Page description for ${pageUrl}`
      );
      
      return {
        pageDescription: aiResponse,
        aiRequestId: aiResponse.requestId,
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      console.error(`[WorkflowStepExecutor] Page description step failed:`, error);
      throw error;
    }
  }

  /**
   * Execute Workflow Analysis Step
   */
  async executeWorkflowAnalysisStep(jobId, stepId, parameters, context) {
    const startTime = Date.now();
    console.log(`[WorkflowStepExecutor] Executing workflow analysis step for job ${jobId}`);
    
    try {
      const page = await this.getPageForJob(jobId, context);
      
      // Get page information
      const pageTitle = await page.title();
      const pageUrl = page.url();
      
      // Prepare AI request
      const promptName = parameters.prompt || 'universal-workflow-analysis';
      const attachments = parameters.attachments || ['page_description', 'interactive_elements'];
      
      const analysisPayload = {
        page_title: pageTitle,
        page_url: pageUrl,
        page_description: context.pageDescription || 'No description available',
        interactive_elements_json: JSON.stringify(context.interactiveElements || []),
        conversation_history: context.conversationHistory || [],
        additional_prompt_text: context.additional_prompt_text || ''
      };
      
      // Make AI call
      const aiResponse = await this.aiLogger.makeAICallWithPrompt(
        promptName,
        analysisPayload,
        jobId,
        `Workflow analysis for ${pageUrl}`
      );
      
      return {
        workflowAnalysis: aiResponse,
        legsCount: aiResponse.legs?.length || 0,
        aiRequestId: aiResponse.requestId,
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      console.error(`[WorkflowStepExecutor] Workflow analysis step failed:`, error);
      throw error;
    }
  }

  /**
   * Execute Code Step (static code only)
   */
  async executeCodeStep(jobId, stepId, parameters, context) {
    const startTime = Date.now();
    console.log(`[WorkflowStepExecutor] Executing static code step for job ${jobId}`);
    
    try {
      const page = await this.getPageForJob(jobId, context);
      const workflowState = context?.workflowState || {};

      let code = parameters.code;
      if (!code) {
        throw new Error('Code parameter is required for execute-code step');
      }
      
      // Clean the code to remove markdown code blocks and function declarations
      code = this.cleanScript(code);
      code = code.replace(/page\.goto\([^)]*\)\s*;?/gi, '');
      
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
        {
          code,
          workflowState,
          timeout
        }
      );
      
      return {
        executionResult: result,
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      console.error(`[WorkflowStepExecutor] Execute code step failed:`, error);
      throw error;
    }
  }

  /**
   * Execute Code from Variable Step
   */
  async executeCodeFromVariableStep(jobId, stepId, parameters, context) {
    const startTime = Date.now();
    console.log(`[WorkflowStepExecutor] Executing code from variable step for job ${jobId}`);
    
    try {
      const page = await this.getPageForJob(jobId, context);
      const workflowState = context?.workflowState || {};

      const sourceField = parameters.sourceField;
      if (!sourceField) {
        throw new Error('sourceField parameter is required for execute-code-from-variable step');
      }

      // Resolve the path (remove workflowState. prefix if present)
      const normalizedPath = sourceField.startsWith('workflowState.')
        ? sourceField.substring('workflowState.'.length)
        : sourceField;
      
      let code = this.getNestedValue(workflowState, normalizedPath);
      if (code === undefined) {
        code = this.getNestedValue(context || {}, normalizedPath);
        if (code === undefined) {
          throw new Error(`Code not found at path "${sourceField}" in workflowState`);
        }
      }

      console.log(`[WorkflowStepExecutor] Resolved code from "${sourceField}": ${code ? 'found' : 'not found'}`);
      
      if (!code) {
        throw new Error(`Code is empty at path "${sourceField}"`);
      }

      const resolvedPageUrl =
        context?.pageUrl ||
        context?.page_url ||
        context?.page?.page_url ||
        context?.page?.url ||
        workflowState?.pageUrl ||
        workflowState?.page_url ||
        workflowState?.context?.page_url ||
        workflowState?.context?.pageUrl ||
        workflowState?.context?.page?.page_url ||
        workflowState?.context?.page?.url ||
        workflowState?.page?.url ||
        null;

      const currentJourney = workflowState.currentJourney || workflowState.context?.currentJourney || null;
      const allowNavigation =
        Array.isArray(currentJourney?.actions) &&
        currentJourney.actions.some(action =>
          String(action?.type || action?.action || '').toLowerCase() === 'navigate'
        );

      if (resolvedPageUrl) {
        code = code.replace(/\{\{\s*page_url\s*\}\}/g, resolvedPageUrl);
        const escapeForRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedPageUrl = escapeForRegex(resolvedPageUrl);
        if (!allowNavigation) {
          code = code.replace(new RegExp(`page\\.goto\\(\\s*(?:['"])?${escapedPageUrl}(?:['"])?[^\\)]*\\)\\s*;?`, 'gi'), '');
        }
      }

      if (!allowNavigation) {
        code = code.replace(/page\.goto\([^)]*\)\s*;?/gi, '');
      }

      const resolvedVisibleText =
        context?.visible_text ||
        workflowState?.visible_text ||
        workflowState?.context?.visible_text ||
        workflowState?.variablePool?.page?.visible_text?.value ||
        workflowState?.variablePool?.page?.visible_text ||
        null;

      let extractedUsername = null;
      let extractedPassword = null;
      if (resolvedVisibleText && typeof resolvedVisibleText === 'string') {
        const usernameMatch = resolvedVisibleText.match(/username\s*[:=]\s*([^\s]+)/i);
        const passwordMatch = resolvedVisibleText.match(/password\s*[:=]\s*([^\s]+)/i);
        extractedUsername = usernameMatch ? usernameMatch[1] : null;
        extractedPassword = passwordMatch ? passwordMatch[1] : null;
      }

      const fallbackUsername = extractedUsername || 'testuser';
      const fallbackPassword = extractedPassword || 'Test123!';
      if (extractedUsername) {
        code = code.replace(/(username\w*\.fill)\('.*?'\)/gi, `$1('${extractedUsername}')`);
        code = code.replace(/(page\.type\(['"]#username['"],\s*)'[^']*'/gi, `$1'${extractedUsername}'`);
      }
      if (extractedPassword) {
        code = code.replace(/(password\w*\.fill)\('.*?'\)/gi, `$1('${extractedPassword}')`);
        code = code.replace(/(page\.type\(['"]#password['"],\s*)'[^']*'/gi, `$1'${extractedPassword}'`);
      }

      code = code.replace(/(username\w*\.fill)\(''\)/gi, `$1('${fallbackUsername}')`);
      code = code.replace(/(password\w*\.fill)\(''\)/gi, `$1('${fallbackPassword}')`);

      // Clean the code to remove markdown code blocks and function declarations
      code = this.cleanScript(code);

      if (!code || code.trim().length === 0) {
        throw new Error('Script is empty after cleaning');
      }
      
      const timeout = parameters.timeout || 30000;

      // Execute in Node context so Playwright "page" is available to the script
      const executionPromise = (async () => {
        const runner = new Function(
          'page',
          'workflowState',
          `"use strict";\n${code}`
        );

        return await runner(page, workflowState);
      })();

      const timeoutPromise = new Promise((_, reject) => {
        const timer = setTimeout(() => {
          clearTimeout(timer);
          reject(new Error(`Code execution timed out after ${timeout}ms`));
        }, timeout);
      });

      const result = await Promise.race([executionPromise, timeoutPromise]);
      
      return {
        executionResult: result,
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      console.error(`[WorkflowStepExecutor] Execute code from variable step failed:`, error);
      throw error;
    }
  }


  /**
   * Execute Update Workflow Step
   */
  async executeUpdateWorkflowStep(jobId, stepId, parameters, context) {
    const startTime = Date.now();
    console.log(`[WorkflowStepExecutor] Executing update workflow step for job ${jobId}`);
    
    try {
      const workflowId = context.workflowId;
      if (!workflowId) {
        throw new Error('workflowId is required for update-workflow step');
      }
      
      const updateData = {};
      
      if (parameters.useAIAnalysis && context.aiAnalysis) {
        updateData.ai_analysis = context.aiAnalysis;
        updateData.legs = context.legs || [];
      }
      
      // Send to backend to update workflow
      const response = await axios.put(`${this.backendUrl}/api/workflows/${workflowId}`, updateData);
      
      return {
        workflowId: response.data._id,
        updatedLegsCount: response.data.legs?.length || 0,
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      console.error(`[WorkflowStepExecutor] Update workflow step failed:`, error);
      throw error;
    }
  }

  /**
   * Execute Page Discovery Step
   */
  async executePageDiscoveryStep(jobId, stepId, parameters, context) {
    const startTime = Date.now();
    console.log(`[WorkflowStepExecutor] Executing page discovery step for job ${jobId}`);
    
    try {
      const pageData = {
        url: context.pageUrl,
        project_id: context.projectId,
        analyzed: parameters.analyzed || false,
        workflow_id: parameters.includeWorkflowId ? context.workflowId : null,
        ai_analysis: parameters.includeAIAnalysis ? context.aiAnalysis : null
      };
      
      // Send to backend to update page discovery
      const response = await axios.post(`${this.backendUrl}/pages`, pageData);
      
      return {
        pageId: response.data._id,
        workflowId: pageData.workflow_id,
        analysisComplete: pageData.analyzed,
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      console.error(`[WorkflowStepExecutor] Page discovery step failed:`, error);
      throw error;
    }
  }

  /**
   * Execute AI Prompt Step
   */
  async executeAIPromptStep(jobId, stepId, parameters, context) {
    const startTime = Date.now();
    console.log(`[WorkflowStepExecutor] Executing AI prompt step for job ${jobId}`);
    
    try {
      const promptName = parameters.prompt;
      if (!promptName) {
        throw new Error('prompt parameter is required for ai-prompt step');
      }
      
      const attachments = parameters.attachments || [];
      const promptPayload = {
        page_url: context.pageUrl,
        page_title: context.pageTitle || '',
        additional_prompt_text: context.additional_prompt_text || ''
      };
      
      // Add attachments to payload
      if (attachments.includes('visible_text') && context.visibleText) {
        promptPayload.visible_text = context.visibleText;
      }
      if (attachments.includes('interactive_elements') && context.interactiveElements) {
        promptPayload.interactive_elements_json = JSON.stringify(context.interactiveElements);
      }
      
      // Make AI call
      const aiResponse = await this.aiLogger.makeAICallWithPrompt(
        promptName,
        promptPayload,
        jobId,
        `Custom AI prompt: ${promptName}`
      );
      
      return {
        aiResponse: aiResponse,
        aiRequestId: aiResponse.requestId,
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      console.error(`[WorkflowStepExecutor] AI prompt step failed:`, error);
      throw error;
    }
  }

  /**
   * Execute Cycle Start Step
   */
  async executeCycleStartStep(jobId, stepId, parameters, context) {
    const startTime = Date.now();
    console.log(`[WorkflowStepExecutor] Executing cycle start step for job ${jobId}`);
    
    try {
      const maxIterations = parameters.maxIterations || 1;
      const iterationVariable = parameters.iterationVariable || 'currentIteration';
      
      // Initialize cycle state
      const cycleState = {
        maxIterations,
        currentIteration: 0,
        iterationVariable,
        cycleStarted: true
      };
      
      return {
        ...cycleState,
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      console.error(`[WorkflowStepExecutor] Cycle start step failed:`, error);
      throw error;
    }
  }

  /**
   * Execute Cycle End Step
   */
  async executeCycleEndStep(jobId, stepId, parameters, context) {
    const startTime = Date.now();
    console.log(`[WorkflowStepExecutor] Executing cycle end step for job ${jobId}`);
    
    try {
      const nextIteration = parameters.nextIteration;
      const currentIteration = context.workflowState?.currentIteration || 0;
      const maxIterations = context.workflowState?.maxIterations || 1;
      
      const shouldContinue = currentIteration < maxIterations - 1;
      
      return {
        cycleEnded: !shouldContinue,
        nextIteration: shouldContinue ? nextIteration : null,
        currentIteration: currentIteration + 1,
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      console.error(`[WorkflowStepExecutor] Cycle end step failed:`, error);
      throw error;
    }
  }

  /**
   * Execute Conditional Step
   */
  async executeConditionalStep(jobId, stepId, parameters, context) {
    const startTime = Date.now();
    console.log(`[WorkflowStepExecutor] Executing conditional step for job ${jobId}`);
    
    try {
      const condition = parameters.condition;
      const onTrue = parameters.onTrue;
      const onFalse = parameters.onFalse;
      
      if (!condition) {
        throw new Error('condition parameter is required for conditional step');
      }
      
      // Evaluate condition using workflow state
      const workflowState = context.workflowState || {};
      const conditionMet = this.evaluateCondition(condition, workflowState);
      
      return {
        conditionMet,
        nextStep: conditionMet ? onTrue : onFalse,
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      console.error(`[WorkflowStepExecutor] Conditional step failed:`, error);
      throw error;
    }
  }

  /**
   * Execute Validate Response Step
   */
  async executeValidateResponseStep(jobId, stepId, parameters, context) {
    const startTime = Date.now();
    console.log(`[WorkflowStepExecutor] Executing validate response step for job ${jobId}`);
    
    try {
      const responseField = parameters.responseField;
      const schema = parameters.schema;
      
      if (!responseField || !schema) {
        throw new Error('responseField and schema parameters are required for validate-response step');
      }
      
      // Get response data from workflow state
      const workflowState = context.workflowState || {};
      const responseData = this.getNestedValue(workflowState, responseField);
      
      // Validate against schema
      const validationResult = this.validateAgainstSchema(responseData, schema);
      
      return {
        validationPassed: validationResult.valid,
        validationErrors: validationResult.errors,
        validatedField: responseField,
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      console.error(`[WorkflowStepExecutor] Validate response step failed:`, error);
      throw error;
    }
  }

  /**
   * Execute Filter Response Step
   */
  async executeFilterResponseStep(jobId, stepId, parameters, context) {
    const startTime = Date.now();
    console.log(`[WorkflowStepExecutor] Executing filter response step for job ${jobId}`);
    
    try {
      const inputField = parameters.inputField;
      const outputField = parameters.outputField;
      const filter = parameters.filter;
      
      if (!inputField || !outputField) {
        throw new Error('inputField and outputField parameters are required for filter-response step');
      }
      
      // Get input data from workflow state
      const workflowState = context.workflowState || {};
      const inputData = this.getNestedValue(workflowState, inputField);
      
      // Apply filter
      const filteredData = this.applyFilter(inputData, filter);
      
      return {
        filteredCount: Array.isArray(filteredData) ? filteredData.length : 0,
        originalCount: Array.isArray(inputData) ? inputData.length : 0,
        filteredField: outputField,
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      console.error(`[WorkflowStepExecutor] Filter response step failed:`, error);
      throw error;
    }
  }

  // Helper methods

  /**
   * Get element selector using multiple strategies
   */
  async getElementSelector(element) {
    try {
      // Try ID first
      const id = await element.getAttribute('id');
      if (id) return `#${id}`;
      
      // Try class
      const className = await element.getAttribute('class');
      if (className) {
        const classes = className.split(' ').filter(c => c.trim());
        if (classes.length > 0) {
          return `.${classes[0]}`;
        }
      }
      
      // Try data attributes
      const dataTestId = await element.getAttribute('data-testid');
      if (dataTestId) return `[data-testid="${dataTestId}"]`;
      
      // Fallback to tag + text
      const tagName = await element.evaluate(el => el.tagName.toLowerCase());
      const text = await element.textContent();
      if (text && text.trim()) {
        return `${tagName}:has-text("${text.trim().substring(0, 50)}")`;
      }
      
      // Last resort
      return tagName;
    } catch (error) {
      return 'unknown';
    }
  }

  /**
   * Get element attributes
   */
  async getElementAttributes(element) {
    try {
      return await element.evaluate(el => {
        const attrs = {};
        for (const attr of el.attributes) {
          attrs[attr.name] = attr.value;
        }
        return attrs;
      });
    } catch (error) {
      return {};
    }
  }

  /**
   * Evaluate condition string
   */
  evaluateCondition(condition, workflowState) {
    try {
      // Simple condition evaluation
      // Replace variables with actual values
      let evaluatedCondition = condition;
      for (const [key, value] of Object.entries(workflowState)) {
        evaluatedCondition = evaluatedCondition.replace(new RegExp(`workflowState\\.${key}`, 'g'), JSON.stringify(value));
      }
      
      // Evaluate the condition
      return eval(evaluatedCondition);
    } catch (error) {
      console.error(`[WorkflowStepExecutor] Condition evaluation failed:`, error);
      return false;
    }
  }

  /**
   * Get nested value from object
   */
  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  /**
   * Validate data against JSON schema
   */
  validateAgainstSchema(data, schema) {
    // Simple validation - in production, use a proper JSON schema validator
    const errors = [];
    
    if (schema.required) {
      for (const field of schema.required) {
        if (data[field] === undefined) {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }
    
    if (schema.properties) {
      for (const [field, fieldSchema] of Object.entries(schema.properties)) {
        if (data[field] !== undefined) {
          if (fieldSchema.type === 'array' && !Array.isArray(data[field])) {
            errors.push(`Field ${field} must be an array`);
          }
          if (fieldSchema.minItems && Array.isArray(data[field]) && data[field].length < fieldSchema.minItems) {
            errors.push(`Field ${field} must have at least ${fieldSchema.minItems} items`);
          }
          if (fieldSchema.maxItems && Array.isArray(data[field]) && data[field].length > fieldSchema.maxItems) {
            errors.push(`Field ${field} must have at most ${fieldSchema.maxItems} items`);
          }
        }
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Apply filter to data
   */
  applyFilter(data, filter) {
    if (!Array.isArray(data) || !filter) {
      return data;
    }
    
    return data.filter(item => {
      for (const [key, value] of Object.entries(filter)) {
        if (item[key] !== value) {
          return false;
        }
      }
      return true;
    });
  }

  /**
   * Cleanup browser for job
   */
  async cleanupJob(jobId) {
    if (this.activeBrowsers.has(jobId)) {
      const browser = this.activeBrowsers.get(jobId);
      await browser.close();
      this.activeBrowsers.delete(jobId);
    }
  }
}
