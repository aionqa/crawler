import axios from 'axios';
import { StaticNodeExecutor } from '../execution/static-node-executor.js';
import { appendRequirementToTemplate, getRequirementTextForNextStep } from '../../step-requirements.js';

/**
 * WorkflowAnalyzer - Updated 2025-10-15
 * Handles initial page analysis using Playwright + OpenAI
 * Creates workflow structure with testable legs
 */
class WorkflowAnalyzer {
  constructor(backendUrl, aiLogger, context = {}) {
    this.backendUrl = backendUrl;
    this.aiLogger = aiLogger;
    this.context = context;
    this.workflowTemplate = null;
    this.workflowCapabilities = this.detectCapabilities([]);
  }

  /**
   * Load workflow template from backend
   */
  async loadWorkflowTemplate() {
    console.log(`🔍 Context received:`, JSON.stringify(this.context, null, 2));
    if (!this.context.workflow_template_id) {
      console.error(`❌ No workflow template ID provided - workflows are mandatory!`);
      console.error(`❌ Context keys:`, Object.keys(this.context));
      throw new Error('workflow_template_id is required - all jobs must use workflows stored in MongoDB');
    }

    try {
      if (this.workflowTemplate && (this.workflowTemplate._id?.toString() === this.context.workflow_template_id)) {
        return this.workflowTemplate;
      }

      const response = await axios.get(`${this.backendUrl}/api/workflow-templates/${this.context.workflow_template_id}`, {
        headers: this.getAuthHeaders()
      });
      this.workflowTemplate = response.data;
      console.log(`✅ Loaded workflow: "${this.workflowTemplate.name}" (ID: ${this.context.workflow_template_id})`);
      console.log(`📄 Workflow contains ${this.workflowTemplate.prompts?.length || 0} prompts`);
      
      // Log workflow usage
      if (this.workflowTemplate.prompts && this.workflowTemplate.prompts.length > 0) {
        console.log(`📝 Custom prompts in template:`);
        this.workflowTemplate.prompts.forEach(p => {
          console.log(`   - ${p.name}: ${p.template?.substring(0, 80)}...`);
        });
      }
      
      await this.logWorkflowDecision(
        `Using workflow: "${this.workflowTemplate.name}" (ID: ${this.context.workflow_template_id})`,
        `Workflow contains ${this.workflowTemplate.prompts?.length || 0} prompts`
      );

      this.workflowCapabilities = this.detectCapabilities(this.workflowTemplate.steps || []);
      console.log(`⚙️ Workflow capabilities:`, JSON.stringify(this.workflowCapabilities));
      
      return this.workflowTemplate;
    } catch (error) {
      console.error(`❌ Failed to load workflow template: ${error.message}`);
      throw new Error(`Failed to load workflow template ${this.context.workflow_template_id}: ${error.message}`);
    }
  }

  /**
   * Get timeout for a workflow step (in milliseconds)
   * Returns step-specific timeout or default based on step type
   * Range: 1 minute (60000ms) to 15 minutes (900000ms)
   */
  getStepTimeout(step) {
    // If step has explicit timeout config, use it (clamped to 1m-15m range)
    if (step.config?.timeout_ms !== undefined) {
      const timeout = Math.max(60000, Math.min(900000, step.config.timeout_ms));
      return timeout;
    }
    if (step.config?.timeout !== undefined) {
      const timeout = Math.max(60000, Math.min(900000, step.config.timeout));
      return timeout;
    }

    // Default timeouts by step type (in milliseconds)
    const defaultTimeouts = {
      'ai-prompt': 900000,           // 15 minutes - AI calls can take time
      'workflow-analysis': 180000,   // 3 minutes - Complex analysis
      'page-description': 120000,    // 2 minutes - Page analysis
      'playwright-analysis': 120000, // 2 minutes - Playwright analysis
      'execute-code': 120000,        // 2 minutes - Code execution
      'execute-code-from-variable': 120000, // 2 minutes
      'while-loop': 600000,          // 10 minutes - Journey iteration (generate+execute+justify per stage) needs multiple AI calls
      'for-each': 600000,            // 10 minutes - Iterations can take time with nested while-loops
      'screenshot': 60000,           // 1 minute - Quick operation
      'cookie-collect': 60000,       // 1 minute - Quick operation
      'content-change': 60000,       // 1 minute - Variable operations
      'var-dump': 60000,            // 1 minute - Quick operation
      'print': 30000,               // 30 seconds - Very quick
      'sleep': 60000,               // 1 minute - Sleep operations
      'page-discovery': 180000,     // 3 minutes - Discovery can take time
      'sitemap-exploration': 240000, // 4 minutes - Sitemap exploration
      'unlighthouse': 300000,       // 5 minutes - Performance audit
      'save-data': 120000,          // 2 minutes - Data saving
      'update-workflow': 120000,    // 2 minutes
      'hardcoded-workflow-analysis': 120000, // 2 minutes
    };

    const stepType = step.type || 'ai-prompt';
    return defaultTimeouts[stepType] || 120000; // Default: 2 minutes
  }

  detectCapabilities(steps = []) {
    const stepList = Array.isArray(steps) ? steps : [];
    const hasStep = (...types) => stepList.some(step => types.includes(step.type));

    const capabilities = {
      hasSteps: stepList.length > 0,
      usesPlaywrightAnalysis: hasStep('playwright-analysis', 'workflow-analysis', 'hardcoded-workflow-analysis', 'page-discovery'),
      usesAIModel: hasStep('ai-request', 'ai-prompt', 'page-description', 'workflow-analysis', 'hardcoded-workflow-analysis', 'update-workflow'),
      usesLinkDiscovery: hasStep('page-discovery'),
      usesPerformanceAudit: hasStep('unlighthouse'),
      usesScreenshotStep: hasStep('screenshot'),
      usesCookieOperations: hasStep('cookie-add', 'cookie-update', 'cookie-remove', 'cookie-collect')
    };

    return capabilities;
  }

  getCapabilities() {
    return this.workflowCapabilities;
  }

  hasExecutableSteps() {
    return !!(this.workflowCapabilities?.hasSteps);
  }


  /**
   * Analyze page using workflow template steps only
   * @param {Page} page - Playwright page object
   * @param {string} jobId - Job ID for logging
   * @param {string} pageId - Page ID in MongoDB
   * @param {string} projectId - Project ID
   * @returns {Object} workflow object
   */
  async analyzePage(page, jobId, pageId, projectId) {
    // CRITICAL: job_id must always be available - use from context if not provided as parameter
    // Backend always provides job_id in context, so this ensures workflows can link to the job
    const effectiveJobId = jobId || this.context.job_id;
    if (!effectiveJobId) {
      console.warn(`⚠️ No job_id provided - workflows/actions/pages may not be linked to job`);
    }
    
    // CRITICAL: Prevent duplicate analyzePage calls for the same page
    const analyzeKey = `${effectiveJobId}_${pageId || 'no-page'}_${this.context.workflow_template_id}`;
    if (!this._analyzePageInProgress) {
      this._analyzePageInProgress = new Set();
    }
    
    if (this._analyzePageInProgress.has(analyzeKey)) {
      const errorMsg = `⚠️ CRITICAL: analyzePage already in progress for ${analyzeKey} - DUPLICATE CALL DETECTED!`;
      console.error(errorMsg);
      console.error(`⚠️ Stack trace:`, new Error().stack);
      throw new Error(`analyzePage already in progress for this job/page/template combination. This indicates a bug - analyzePage should not be called twice.`);
    }
    
    this._analyzePageInProgress.add(analyzeKey);
    console.log(`🔒 analyzePage guard set for key: ${analyzeKey} (jobId: ${effectiveJobId}, pageId: ${pageId || 'none'}, templateId: ${this.context.workflow_template_id})`);
    
    try {
      const initialUrl = page.url();
      console.log(`═══════════════════════════════════════════════════════`);
      console.log(`📄 VAR_DUMP: analyzePage called`);
      console.log(`📄 VAR_DUMP: initialUrl=${initialUrl}`);
      console.log(`📄 VAR_DUMP: jobId=${jobId}, effectiveJobId=${effectiveJobId}`);
      console.log(`📄 VAR_DUMP: pageId=${pageId}, projectId=${projectId}`);
      console.log(`📄 VAR_DUMP: context.page_url=${this.context?.page_url}`);
      console.log(`📄 VAR_DUMP: context.credentials=${JSON.stringify({username: this.context?.credentials?.username || this.context?.username || 'MISSING', password: this.context?.credentials?.password || this.context?.password ? '***' : 'MISSING'})}`);
      console.log(`Analyzing page: ${initialUrl} (job_id: ${effectiveJobId || 'none'})`);

      // Load workflow template - MANDATORY
      await this.loadWorkflowTemplate();

      // Validate workflow template has steps
      if (!this.workflowTemplate || !this.workflowTemplate.steps || this.workflowTemplate.steps.length === 0) {
        throw new Error(`Workflow template "${this.context.workflow_template_id}" has no steps defined. All analysis must be defined in workflow template steps.`);
      }

      // DEFAULT: All jobs are "crawl" jobs by default (test everything, discover pages, queue links)
      // The configuration step can change this to "login" (authenticate only, no crawling)
      // We don't check here - configuration step will set jobType if needed
      // Default behavior is crawl, so we don't need to set anything here
      
      console.log(`🎯 Executing workflow template: "${this.workflowTemplate.name}"`);
      console.log(`📋 Workflow template has ${this.workflowTemplate.steps.length} steps to execute`);

      // Execute workflow template steps ONLY
      // Use jobId from parameter or fallback to context (backend always provides job_id in context)
      const results = await this.executeWorkflowSteps(page, effectiveJobId, pageId, projectId);
      console.log(`✅ Workflow template steps completed successfully`);
      
      return results;
    } catch (stepError) {
      console.error(`❌ Workflow template execution failed:`, stepError);
      throw new Error(`Workflow execution failed: ${stepError.message}`);
    } finally {
      // Clean up analyzePage guard
      if (this._analyzePageInProgress) {
        this._analyzePageInProgress.delete(analyzeKey);
      }
    }
  }

  /**
   * Perform Playwright analysis to extract forms, links, interactive elements
   */
  async performPlaywrightAnalysis(page) {
    const analysis = {
      forms: [],
      links: [],
      interactive_elements: [],
      non_interactive_elements: []
    };

    try {
      // Extract forms - including hidden ones in modals/popups
      // Also detect form-like structures (inputs grouped together without <form> tag)
      // Use evaluate to find ALL forms in DOM, even if hidden
      const allFormsInDOM = await page.evaluate(() => {
        const forms = Array.from(document.querySelectorAll('form'));
        const formResults = forms.map((form, idx) => {
          const formId = form.id || `form_${idx}`;
          const inputs = Array.from(form.querySelectorAll('input, textarea, select'));
          const buttons = Array.from(form.querySelectorAll('button, input[type="submit"]'));
          
          // Check if form is in a modal/popup (common patterns)
          const isInModal = form.closest('[class*="modal"], [class*="popup"], [id*="modal"], [id*="popup"], [class*="overlay"]');
          const modalInfo = isInModal ? {
            in_modal: true,
            modal_selector: isInModal.id ? `#${isInModal.id}` : (isInModal.className ? `.${isInModal.className.split(/\s+/)[0]}` : null)
          } : { in_modal: false };
          
          return {
            index: idx,
            id: formId,
            selector: form.id ? `#${form.id}` : `form:nth-of-type(${idx + 1})`,
            action: form.action || '',
            method: form.method || 'get',
            fields: inputs.map(input => ({
              type: input.type || input.tagName.toLowerCase(),
              name: input.name || '',
              id: input.id || '',
              placeholder: input.placeholder || '',
              required: input.required || false
            })),
            buttons: buttons.map(btn => ({
              text: btn.textContent?.trim() || btn.value || '',
              type: btn.type || 'button',
              id: btn.id || ''
            })),
            ...modalInfo
          };
        });
        
        // If no <form> tags found, detect form-like structures (groups of inputs/buttons)
        if (forms.length === 0) {
          const allInputs = Array.from(document.querySelectorAll('input[type="text"], input[type="email"], input[type="password"], input[name], textarea[name], select[name]'));
          const allButtons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'));
          
          if (allInputs.length > 0) {
            // Group inputs that are close together (likely form fields)
            const formGroups = new Map();
            let groupIndex = 0;
            
            allInputs.forEach(input => {
              // Find parent container that likely wraps a form (common patterns)
              let container = input.closest('div[class*="form"], div[class*="login"], div[class*="sign"], section, main, article, div[role="form"]');
              if (!container) {
                // Look for parent with multiple inputs nearby
                const parent = input.parentElement;
                if (parent) {
                  const siblings = Array.from(parent.querySelectorAll('input, textarea, select'));
                  if (siblings.length >= 2) {
                    container = parent;
                  }
                }
              }
              
              if (!container) {
                container = input.closest('div') || document.body;
              }
              
              const containerId = container.id || (container.className ? container.className.trim().split(/\s+/)[0] : `form-group-${groupIndex}`);
              
              if (!formGroups.has(containerId)) {
                formGroups.set(containerId, {
                  container: container,
                  inputs: [],
                  buttons: []
                });
                groupIndex++;
              }
              
              formGroups.get(containerId).inputs.push(input);
            });
            
            // Add nearby buttons to form groups
            allButtons.forEach(button => {
              const buttonText = (button.textContent || button.value || '').toLowerCase();
              // Check if button text suggests it's a form submit button
              if (buttonText.includes('submit') || buttonText.includes('login') || buttonText.includes('sign') || 
                  buttonText.includes('send') || buttonText.includes('save') || buttonText.includes('enter') ||
                  button.type === 'submit') {
                // Find closest form group
                let closestGroup = null;
                let closestDistance = Infinity;
                
                formGroups.forEach((group, key) => {
                  const rect = group.container.getBoundingClientRect();
                  const buttonRect = button.getBoundingClientRect();
                  const distance = Math.sqrt(
                    Math.pow(rect.left - buttonRect.left, 2) + 
                    Math.pow(rect.top - buttonRect.top, 2)
                  );
                  if (distance < closestDistance && distance < 500) { // Within 500px
                    closestDistance = distance;
                    closestGroup = group;
                  }
                });
                
                if (closestGroup) {
                  closestGroup.buttons.push(button);
                } else if (formGroups.size > 0) {
                  // Add to first group if no close match
                  formGroups.values().next().value.buttons.push(button);
                }
              }
            });
            
            // Convert form groups to form-like structures
            let formLikeIndex = 0;
            formGroups.forEach((group, key) => {
              if (group.inputs.length > 0) {
                const container = group.container;
                const formId = container.id || `form-like-${formLikeIndex}`;
                const inputs = group.inputs;
                const buttons = group.buttons;
                
                formResults.push({
                  index: formResults.length,
                  id: formId,
                  selector: container.id ? `#${container.id}` : (container.className ? `.${container.className.trim().split(/\s+/)[0]}` : `form-like:nth-of-type(${formLikeIndex + 1})`),
                  action: '',
                  method: 'post',
                  fields: inputs.map(input => ({
                    type: input.type || input.tagName.toLowerCase(),
                    name: input.name || '',
                    id: input.id || '',
                    placeholder: input.placeholder || '',
                    required: input.required || false
                  })),
                  buttons: buttons.map(btn => ({
                    text: btn.textContent?.trim() || btn.value || '',
                    type: btn.type || 'button',
                    id: btn.id || ''
                  })),
                  is_form_like: true, // Flag to indicate this is a detected form-like structure
                  in_modal: false
                });
                formLikeIndex++;
              }
            });
          }
        }
        
        return formResults;
      });
      
      // Now process each form to get full selectors
      for (const formInfo of allFormsInDOM) {
        try {
          // Find the form element using the selector
          // For form-like structures, try multiple selector strategies
          let form = await page.$(formInfo.selector).catch(() => null);
          
          // If selector doesn't work and it's a form-like structure, try alternative selectors
          if (!form && formInfo.is_form_like) {
            // Try finding by container that has inputs
            if (formInfo.fields && formInfo.fields.length > 0) {
              const firstField = formInfo.fields[0];
              if (firstField.id) {
                const fieldElement = await page.$(`#${firstField.id}`).catch(() => null);
                if (fieldElement) {
                  // Get parent container
                  form = await fieldElement.evaluateHandle(el => {
                    return el.closest('div, section, main, article, form') || el.parentElement;
                  }).catch(() => null);
                }
              }
            }
          }
          
          if (!form) {
            // Skip if we still can't find it, but log for debugging
            if (formInfo.is_form_like) {
              console.log(`⚠️ Could not locate form-like structure: ${formInfo.selector}, but will include basic info`);
              // Still add the form with basic info from evaluate
              analysis.forms.push({
                selector: formInfo.selector,
                action: formInfo.action,
                method: formInfo.method,
                fields: formInfo.fields || [],
                buttons: formInfo.buttons || [],
                in_modal: formInfo.in_modal || false,
                is_form_like: true
              });
            }
            continue;
          }
          
          const inputs = await form.$$('input, textarea, select');
          const buttons = await form.$$('button, input[type="submit"]');
          
          // Get selectors with all strategies
          const formSelectors = await this.getElementSelector(form);
          const formData = {
            selector: formSelectors[0]?.selector || formInfo.selector,
            selectors: formSelectors.length > 0 ? formSelectors : [{ selector: formInfo.selector }],
            action: formInfo.action,
            method: formInfo.method,
            fields: [],
            buttons: [],
            in_modal: formInfo.in_modal || false,
            modal_selector: formInfo.modal_selector || null
          };

          // If Playwright query found fields, use them (with full selector info)
          if (inputs.length > 0) {
            for (const input of inputs) {
              const type = await input.getAttribute('type') || 'text';
              const name = await input.getAttribute('name');
              const id = await input.getAttribute('id');
              const placeholder = await input.getAttribute('placeholder');
              
              const inputSelectors = await this.getElementSelector(input);
              formData.fields.push({
                type,
                name,
                id,
                placeholder,
                selector: inputSelectors[0]?.selector,
                selectors: inputSelectors
              });
            }
          } else {
            // Fallback: Use fields from evaluate() step if Playwright query found none
            // This ensures we don't lose form field data that was already detected
            if (formInfo.fields && formInfo.fields.length > 0) {
              console.log(`⚠️ Playwright query found no inputs, using ${formInfo.fields.length} fields from evaluate() step`);
              for (const field of formInfo.fields) {
                // Try to get selector for each field
                let fieldSelectors = [];
                if (field.id) {
                  try {
                    const fieldElement = await page.$(`#${field.id}`).catch(() => null);
                    if (fieldElement) {
                      fieldSelectors = await this.getElementSelector(fieldElement);
                    }
                  } catch (e) {
                    // Ignore selector generation errors
                  }
                }
                
                formData.fields.push({
                  type: field.type || 'text',
                  name: field.name || '',
                  id: field.id || '',
                  placeholder: field.placeholder || '',
                  selector: fieldSelectors[0]?.selector || (field.id ? `#${field.id}` : (field.name ? `[name="${field.name}"]` : null)),
                  selectors: fieldSelectors.length > 0 ? fieldSelectors : []
                });
              }
            }
          }

          // If Playwright query found buttons, use them (with full selector info)
          if (buttons.length > 0) {
            for (const button of buttons) {
              const text = await button.textContent();
              const buttonSelectors = await this.getElementSelector(button);
              formData.buttons.push({
                text: text?.trim(),
                selector: buttonSelectors[0]?.selector,
                selectors: buttonSelectors
              });
            }
          } else {
            // Fallback: Use buttons from evaluate() step if Playwright query found none
            if (formInfo.buttons && formInfo.buttons.length > 0) {
              console.log(`⚠️ Playwright query found no buttons, using ${formInfo.buttons.length} buttons from evaluate() step`);
              for (const btn of formInfo.buttons) {
                // Try to get selector for each button
                let buttonSelectors = [];
                if (btn.id) {
                  try {
                    const buttonElement = await page.$(`#${btn.id}`).catch(() => null);
                    if (buttonElement) {
                      buttonSelectors = await this.getElementSelector(buttonElement);
                    }
                  } catch (e) {
                    // Ignore selector generation errors
                  }
                }
                
                formData.buttons.push({
                  text: btn.text || '',
                  selector: buttonSelectors[0]?.selector || (btn.id ? `#${btn.id}` : null),
                  selectors: buttonSelectors.length > 0 ? buttonSelectors : []
                });
              }
            }
          }

          analysis.forms.push(formData);
        } catch (error) {
          // If we can't process the form, still add basic info
          console.warn(`Could not fully process form ${formInfo.selector}: ${error.message}`);
          analysis.forms.push({
            selector: formInfo.selector,
            action: formInfo.action,
            method: formInfo.method,
            fields: formInfo.fields || [],
            buttons: formInfo.buttons || [],
            in_modal: formInfo.in_modal || false
          });
        }
      }

      // Extract links (excluding pure anchors, but preserving all hash fragments in full URLs)
      const links = await page.$$('a[href]');
      for (const link of links.slice(0, 50)) { // Limit to first 50 links
        // Use resolved href (full URL) instead of raw attribute to get complete URLs with hash fragments
        const href = await link.evaluate(el => el.href || el.getAttribute('href'));
        const text = await link.textContent();
        
        const isPureAnchor = href.startsWith('#') && !href.startsWith('http');
        
        // Exclude pure anchor links (#section) but include all full URLs with any hash fragments
        if (href && 
            !href.startsWith('javascript:') && 
            !isPureAnchor && // Exclude pure anchors like "#section"
            !href.startsWith('mailto:') &&
            !href.startsWith('tel:') &&
            href.trim() !== '') {
          const linkSelectors = await this.getElementSelector(link);
          analysis.links.push({
            href,
            text: text?.trim(),
            selector: linkSelectors[0]?.selector, // Primary selector
            selectors: linkSelectors // All strategies
          });
        }
      }

      // Extract interactive elements (buttons, clickable divs, etc.)
      const buttons = await page.$$('button:not(form button), input[type="button"], [role="button"], [onclick]');
      for (const button of buttons) {
        const text = await button.textContent();
        const role = await button.getAttribute('role');
        const onclick = await button.getAttribute('onclick');

        const buttonSelectors = await this.getElementSelector(button);
        analysis.interactive_elements.push({
          type: 'button',
          text: text?.trim(),
          role,
          onclick: onclick ? 'yes' : 'no',
          selector: buttonSelectors[0]?.selector, // Primary selector
          selectors: buttonSelectors // All strategies
        });
      }

      // Extract non-interactive elements (informational content, headings, labels)
      const nonInteractiveElements = await page.$$eval(
        'p, h1, h2, h3, h4, h5, h6, span, div, label',
        elements => elements
          .filter(el => {
            const text = el.textContent?.trim() || '';
            if (!text) return false;
            if (text.length > 500) return false; // skip very long blobs
            const style = window.getComputedStyle(el);
            return style && style.visibility !== 'hidden' && style.display !== 'none';
          })
          .slice(0, 50)
          .map(el => ({
            type: el.tagName.toLowerCase(),
            text: el.textContent.trim(),
            selector: el.id
              ? `#${el.id}`
              : (el.className && el.className.trim()
                ? `.${el.className.trim().split(/\s+/)[0]}`
                : el.tagName.toLowerCase())
          }))
      );

      analysis.non_interactive_elements = nonInteractiveElements;

      // CRITICAL: Also add form fields (inputs, selects, textareas) to interactive_elements
      // Form fields are interactive elements and should be counted
      // Do this after all forms are processed so we have complete form data
      if (analysis.forms && analysis.forms.length > 0) {
        const initialIECount = analysis.interactive_elements.length;
        console.log(`📊 Adding form fields to interactive_elements (${analysis.forms.length} form(s) found, current IE count: ${initialIECount})`);
        
        for (const formData of analysis.forms) {
          if (formData.fields && formData.fields.length > 0) {
            for (const field of formData.fields) {
              // Check if this field is already in interactive_elements (to avoid duplicates)
              // Match by id, selector, or name+type combination
              const alreadyExists = analysis.interactive_elements.some(
                el => {
                  if (field.id && el.id === field.id) return true;
                  if (field.selector && el.selector === field.selector) return true;
                  if (field.name && el.name === field.name && field.type === el.type) return true;
                  return false;
                }
              );
              
              if (!alreadyExists) {
                const newElement = {
                  type: field.type || 'input',
                  name: field.name || '',
                  id: field.id || '',
                  placeholder: field.placeholder || '',
                  selector: field.selector || (field.id ? `#${field.id}` : (field.name ? `[name="${field.name}"]` : null)),
                  selectors: field.selectors || []
                };
                analysis.interactive_elements.push(newElement);
                console.log(`  ➕ Added field to IE: ${newElement.type} ${newElement.name || newElement.id || 'unnamed'}`);
              } else {
                console.log(`  ⏭️  Skipped duplicate field: ${field.type} ${field.name || field.id || 'unnamed'}`);
              }
            }
          }
          
          // Also add form buttons to interactive_elements if not already there
          if (formData.buttons && formData.buttons.length > 0) {
            for (const button of formData.buttons) {
              const alreadyExists = analysis.interactive_elements.some(
                el => {
                  if (button.id && el.id === button.id) return true;
                  if (button.selector && el.selector === button.selector) return true;
                  if (button.text && el.text === button.text && el.type === 'button') return true;
                  return false;
                }
              );
              
              if (!alreadyExists && button.selector) {
                analysis.interactive_elements.push({
                  type: 'button',
                  text: button.text || '',
                  selector: button.selector,
                  selectors: button.selectors || []
                });
              }
            }
          }
        }
        
        const finalIECount = analysis.interactive_elements.length;
        const addedCount = finalIECount - initialIECount;
        console.log(`✅ Added ${addedCount} form fields to interactive_elements. Total: ${finalIECount} (was ${initialIECount})`);
      }

    } catch (error) {
      console.error('Error during Playwright analysis:', error);
    }

    return analysis;
  }

  async generateLegsFromPlaywrightAnalysis(playwrightAnalysis = {}, pageUrl = '', workflowState = {}) {
    const legs = [];
    const forms = Array.isArray(playwrightAnalysis.forms) ? playwrightAnalysis.forms.slice(0, 20) : [];
    const interactiveElements = Array.isArray(playwrightAnalysis.interactive_elements)
      ? playwrightAnalysis.interactive_elements.slice(0, 20)
      : [];
    const links = Array.isArray(playwrightAnalysis.links) ? playwrightAnalysis.links.slice(0, 30) : [];
    
    console.log(`🔍 generateLegsFromPlaywrightAnalysis: ${forms.length} forms, ${interactiveElements.length} interactive elements, ${links.length} links`);
    
    // Ensure we generate at least one leg if we have any detectable elements
    const hasAnyElements = forms.length > 0 || interactiveElements.length > 0 || links.length > 0;

    forms.forEach((form, index) => {
      // Generate leg even if form doesn't have perfect selector
      const formSelector = form.selector || form.id ? `#${form.id}` : `form:nth-of-type(${index + 1})`;
      
      const legId = `auto-form-${index + 1}`;
      const formInModal = form.in_modal === true;
      
      legs.push({
        leg_id: legId,
        type: 'form_submit',
        action: 'submit_form',
        description: formInModal 
          ? `Open modal and submit form #${index + 1}` 
          : `Submit detected form #${index + 1}`,
        test_instructions: formInModal
          ? `First open the modal containing the form (may require clicking a button or link), then fill the form fields with sample data and submit. Verify the modal opens and the form submits successfully.`
          : 'Fill detected fields with sample data and submit the form. Confirm that the page responds with a success state or expected validation.',
        element_info: {
          selector: form.selector,
          selectors: form.selectors || [],
          fields: form.fields || [],
          buttons: form.buttons || [],
          method: form.method || 'get',
          action: form.action || null,
          in_modal: formInModal,
          modal_selector: form.modal_selector || null
        },
        confidence: formInModal ? 0.7 : 0.6,
        status: 'pending',
        metadata: {
          generated_by: 'playwright-analysis',
          source: 'form',
          in_modal: formInModal
        }
      });
    });

    interactiveElements.forEach((element, index) => {
      const legId = `auto-interactive-${index + 1}`;
      legs.push({
        leg_id: legId,
        type: 'click',
        action: 'click',
        description: `Click interactive element #${index + 1}${element.text ? ` (${element.text})` : ''}`.trim(),
        test_instructions: 'Click the element and verify that the expected UI change or navigation occurs.',
        element_info: {
          selector: element.selector,
          selectors: element.selectors || [],
          text: element.text,
          role: element.role,
          onclick: element.onclick
        },
        confidence: 0.5,
        status: 'pending',
        metadata: {
          generated_by: 'playwright-analysis',
          source: 'interactive-element'
        }
      });
    });

    if (links.length) {
      let baseOrigin = null;
      try {
        baseOrigin = new URL(pageUrl).origin;
      } catch (_) {
        baseOrigin = null;
      }

      links.forEach((link, index) => {
        if (!link.href) {
          return;
        }

        if (baseOrigin) {
          const isSameOrigin = link.href.startsWith(baseOrigin) || link.href.startsWith('/') || link.href.startsWith('./');
          if (!isSameOrigin) {
            return;
          }
        }

        // Check if link has hash fragment (modal/popup on same page)
        const hasHashFragment = link.href.includes('#') && link.href.split('#').length > 1;
        const hashFragment = hasHashFragment ? link.href.split('#')[1] : null;
        const baseUrl = hasHashFragment ? link.href.split('#')[0] : link.href;
        
        // Determine if this is the same page (hash fragment) or different page
        const isHashBasedAction = hasHashFragment && baseUrl === pageUrl.split('#')[0];

        const legId = `auto-link-${index + 1}`;
        
        if (isHashBasedAction) {
          // Hash-based link = modal/popup action on same page, not navigation
          legs.push({
            leg_id: legId,
            type: 'click',
            action: 'click',
            description: hashFragment ? `Open ${hashFragment} on current page` : `Click link to open modal/popup`,
            test_instructions: `Click the link to open the modal/popup (${hashFragment || 'hash-based action'}). Verify the modal appears and is interactive.`,
            element_info: {
              selector: link.selector,
              selectors: link.selectors || [],
              href: link.href,
              text: link.text,
              hashFragment: hashFragment
            },
            confidence: 0.5,
            status: 'pending',
            metadata: {
              generated_by: 'playwright-analysis',
              source: 'hash-link',
              is_modal_action: true
            }
          });
        } else {
          // Regular navigation link
          legs.push({
            leg_id: legId,
            type: 'navigate',
            action: 'navigate',
            description: `Follow link #${index + 1} to ${baseUrl}`,
            test_instructions: 'Click the link and verify that the destination page loads successfully without errors.',
            element_info: {
              selector: link.selector,
              selectors: link.selectors || [],
              href: link.href,
              text: link.text
            },
            confidence: 0.4,
            status: 'pending',
            metadata: {
              generated_by: 'playwright-analysis',
              source: 'link'
            }
          });
        }
      });
    }
    
    console.log(`✅ Generated ${legs.length} leg(s) from Playwright analysis`);
    return legs;
  }

  buildActionsSummary(legs = []) {
    if (!Array.isArray(legs) || legs.length === 0) {
      return {
        total: 0,
        pending: 0,
        in_progress: 0,
        completed: 0,
        failed: 0,
        by_type: {}
      };
    }

    const summary = {
      total: legs.length,
      pending: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
      by_type: {},
      sample: []
    };

    legs.forEach((leg) => {
      const type = (leg.type || leg.action || 'action').toLowerCase();
      summary.by_type[type] = (summary.by_type[type] || 0) + 1;

      const status = (leg.status || 'pending').toLowerCase();
      if (status === 'completed' || status === 'success') {
        summary.completed += 1;
      } else if (status === 'failed' || status === 'error') {
        summary.failed += 1;
      } else if (status === 'skipped') {
        summary.pending += 1;
      } else if (status === 'in_progress') {
        summary.in_progress += 1;
      } else {
        summary.pending += 1;
      }

      if (summary.sample.length < 15) {
        const iterations = Array.isArray(leg.iterations) ? leg.iterations : [];
        const lastIteration = iterations.length ? iterations[iterations.length - 1] : null;
        summary.sample.push({
          leg_id: leg.leg_id,
          type,
          status,
          description: leg.description,
          test_instructions: leg.test_instructions,
          last_result: lastIteration?.result || null,
          last_message: lastIteration?.message || lastIteration?.error || null
        });
      }
    });

    return summary;
  }

  enforceLegInstructionsInTemplate(template) {
    if (!template || typeof template !== 'string') {
      return template;
    }

    const normalized = template.toLowerCase();
    if (normalized.includes('"legs"') || normalized.includes(' legs array') || normalized.includes('workflow legs')) {
      return template;
    }

    return `${template.trim()}

IMPORTANT OUTPUT REQUIREMENTS:
- Return valid JSON that includes all of the page summary fields above.
- ALSO include a top-level "legs" array describing the highest value interactive test actions (buttons, toggles, form submissions, input flows).
- CRITICAL: If FORMS (JSON) data is provided, you MUST create a leg for EACH form in that array. Each form leg must:
  - Have type: "form_submit"
  - Use the form's selector property from the forms JSON (form.selector or form.selectors[0].selector)
  - Include form fields and buttons in element_info
  - Describe what the form does (e.g., "Submit contact form", "Submit newsletter signup")
- Each item in "legs" MUST include:
  - "leg_id": unique snake_case string identifier
  - "description": concise sentence describing the action and purpose
  - "type": one of click | form_submit | input | navigation_toggle | custom (avoid plain navigation link testing)
  - "selector": CSS selector (or Playwright-compatible selector such as xpath=...) to locate the element
  - "expected_outcome": what should be verified after performing the action
  - "test_instructions": detailed steps or notes for running the action
  - "priority": high | medium | low
  - "confidence": number between 0 and 1
  - "element_info": extra helpful selector/text/attribute data (ids, aria-labels, text, XPath, etc.)
- Do NOT include duplicate actions or simple navigation links unless the navigation triggers a meaningful state change or workflow step.`;
  }

  /**
   * Convert legs to journeys (one leg = one journey with one action)
   * For backwards compatibility, also converts journeys to legs format
   */
  convertLegsToJourneys(legs) {
    if (!Array.isArray(legs)) return [];
    
    const journeys = [];
    for (const leg of legs) {
      // If it's already a journey, use it
      if (leg.journey_id && leg.actions && Array.isArray(leg.actions)) {
        journeys.push(leg);
        continue;
      }
      
      // Convert leg to journey with one action
      const journey = {
        journey_id: leg.journey_id || leg.leg_id || `journey_${leg.leg_id || Math.random().toString(36).substr(2, 9)}`,
        description: leg.description || '',
        priority: leg.priority || 'medium',
        confidence: leg.confidence || 0,
        expected_outcome: leg.expected_outcome || '',
        test_instructions: leg.test_instructions || '',
        status: leg.status || 'pending',
        final_result: leg.final_result || null,
        completed_at: leg.completed_at || null,
        iterations: Array.isArray(leg.iterations) ? leg.iterations : [],
        actions: [{
          action_id: leg.action_id || `action_${leg.leg_id || '1'}`,
          type: leg.type || 'click',
          selector: leg.selector || '',
          description: leg.description || '',
          order: 0,
          element_info: leg.element_info || {}
        }],
        // Keep original leg_id for backwards compatibility
        leg_id: leg.leg_id,
        element_info: leg.element_info || {}
      };
      journeys.push(journey);
    }
    return journeys;
  }

  /**
   * Convert journeys to legs (for backwards compatibility)
   */
  convertJourneysToLegs(journeys) {
    if (!Array.isArray(journeys)) return [];
    
    const legs = [];
    for (const journey of journeys) {
      // If it's already a leg, use it
      if (journey.leg_id && !journey.actions) {
        legs.push(journey);
        continue;
      }
      
      // Convert journey to leg (prefer first non-verify action as primary)
      const actions = Array.isArray(journey.actions) ? journey.actions : [];
      const primaryAction = actions.find(action => {
        const actionType = (action?.type || '').toLowerCase();
        return actionType !== 'verify' && actionType !== 'check';
      }) || actions[0] || null;
      
      const leg = {
        leg_id: journey.leg_id || journey.journey_id,
        description: journey.description || '',
        type: primaryAction?.type || 'click',
        selector: primaryAction?.selector || '',
        expected_outcome: journey.expected_outcome || '',
        test_instructions: journey.test_instructions || '',
        priority: journey.priority || 'medium',
        confidence: journey.confidence || 0,
        status: journey.status || 'pending',
        final_result: journey.final_result || null,
        completed_at: journey.completed_at || null,
        iterations: Array.isArray(journey.iterations) ? journey.iterations : [],
        element_info: primaryAction?.element_info || journey.element_info || {},
        // Keep journey_id for reference
        journey_id: journey.journey_id
      };
      legs.push(leg);
    }
    return legs;
  }

  async applyLegsToWorkflowState(rawLegs, workflowState, source = 'page-summary') {
    if (!Array.isArray(rawLegs) || rawLegs.length === 0 || !workflowState) {
      return [];
    }
    
    console.log(`[applyLegsToWorkflowState] Processing ${rawLegs.length} raw legs/journeys from source: ${source}`);
    
    // Check if we received journeys from AI (new format)
    const hasJourneys = rawLegs.some(item => item.journey_id && item.actions);
    let processedItems = rawLegs;
    
    if (hasJourneys) {
      console.log(`✅ Received journeys format from AI, processing ${rawLegs.length} journeys`);
      
      const seenSelectors = new Set();
      const dedupedJourneys = rawLegs.filter(journey => {
        const actions = Array.isArray(journey.actions) ? journey.actions : [];
        const primaryAction = actions.find(action => {
          const actionType = (action?.type || '').toLowerCase();
          return actionType !== 'verify' && actionType !== 'check';
        }) || actions[0] || null;
        
        const selectorKey = (primaryAction?.selector || '').trim();
        if (!selectorKey) {
          return true;
        }
        
        if (seenSelectors.has(selectorKey)) {
          console.warn(`⚠️ Deduplicating journey "${journey.journey_id || journey.description || 'unknown'}" (duplicate selector: ${selectorKey})`);
          return false;
        }
        
        seenSelectors.add(selectorKey);
        return true;
      });
      
      // Convert journeys to legs for internal processing (backwards compatibility)
      processedItems = this.convertJourneysToLegs(dedupedJourneys);
    }

    const normalizeType = (rawType) => {
      if (!rawType) return 'click';
      const type = String(rawType).trim().toLowerCase();
      if (!type) return 'click';
      const mappings = {
        press: 'click',
        click: 'click',
        tap: 'click',
        submit: 'form_submit',
        form: 'form_submit',
        form_submit: 'form_submit',
        input: 'input',
        type_text: 'input',
        fill: 'input',
        toggle: 'navigation_toggle',
        navigation_toggle: 'navigation_toggle',
        dropdown: 'navigation_toggle',
        custom: 'custom',
        interaction: 'custom',
        action: 'custom'
      };
      const normalized = mappings[type] || type;
      if (normalized === 'navigate' || normalized === 'navigation') {
        return 'navigation';
      }
      return normalized;
    };

    const normalizePriority = (rawPriority) => {
      if (!rawPriority && rawPriority !== 0) return 'medium';
      const value = String(rawPriority).trim().toLowerCase();
      if (value === 'high' || value === 'medium' || value === 'low') {
        return value;
      }
      if (value === 'critical' || value === 'highest') return 'high';
      if (value === 'lowest') return 'low';
      return 'medium';
    };

    const normalizeConfidence = (rawConfidence) => {
      if (rawConfidence === null || rawConfidence === undefined) return null;
      const numeric = Number(rawConfidence);
      if (Number.isNaN(numeric)) return null;
      return Math.max(0, Math.min(1, numeric));
    };

    const sanitizeSelector = (candidate) => {
      if (!candidate && candidate !== 0) return null;
      if (typeof candidate === 'string') {
        const trimmed = candidate.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith('//')) {
          return trimmed.startsWith('xpath=') ? trimmed : `xpath=${trimmed}`;
        }
        return trimmed;
      }
      return null;
    };

    const pickSelector = (leg) => {
      const candidates = [
        leg.selector,
        leg.css_selector,
        leg.cssSelector,
        leg.element_selector,
        leg.elementSelector,
        leg.target_selector,
        leg.targetSelector,
        leg.locator,
        leg.element?.selector,
        leg.element_info?.selector,
        leg.element_info?.css_selector,
        leg.element_info?.cssSelector,
        ...(Array.isArray(leg.selectors) ? leg.selectors : []),
        ...(Array.isArray(leg.element_info?.selectors) ? leg.element_info.selectors : []),
        leg.xpath,
        leg.element_info?.xpath
      ];

      for (const candidate of candidates) {
        const selector = sanitizeSelector(candidate);
        if (selector) {
          return selector;
        }
      }
      return null;
    };

    // Track existing journey/leg IDs from workflowState to prevent duplicates within the same batch.
    // When we have fresh AI journeys (hasJourneys), do NOT pre-populate with existing IDs so we don't
    // discard the only AI journey as "duplicate" of a prior fallback (e.g. form_simple_form).
    const existingLegIds = new Set();
    if (!hasJourneys && Array.isArray(workflowState.legs) && workflowState.legs.length > 0) {
      for (const existingLeg of workflowState.legs) {
        if (existingLeg.leg_id) {
          existingLegIds.add(existingLeg.leg_id);
        }
      }
    }
    const seenIds = new Set(existingLegIds);
    
    const generateLegId = (leg, index) => {
      const candidates = [
        leg.leg_id,
        leg.legId,
        leg.id,
        leg.action_id,
        leg.source_leg_id,
        leg.original_leg_id,
        leg.slug,
        leg.selector,
        leg.description,
        leg.name
      ];

      let baseId = null;
      for (const candidate of candidates) {
        if (!candidate && candidate !== 0) continue;
        const candidateString = String(candidate).trim();
        if (candidateString) {
          baseId = candidateString;
          break;
        }
      }

      if (!baseId) {
        baseId = `${source}_leg_${index + 1}`;
      }

      let sanitized = baseId
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

      if (!sanitized) {
        sanitized = `${source}_leg_${index + 1}`;
      }

      let finalId = sanitized;
      let suffix = 2;
      while (seenIds.has(finalId)) {
        finalId = `${sanitized}_${suffix}`;
        suffix += 1;
      }
      seenIds.add(finalId);

      return finalId;
    };

    const normalizedLegs = [];
    const itemsToNormalize = hasJourneys ? processedItems : rawLegs;
    for (let index = 0; index < itemsToNormalize.length; index++) {
      const rawLeg = itemsToNormalize[index];
      if (!rawLeg || typeof rawLeg !== 'object') {
        continue;
      }

      const type = normalizeType(rawLeg.type || rawLeg.action || rawLeg.action_type || rawLeg.kind);
      if (type === 'navigation') {
        console.log('⚠️ Skipping navigation journey emitted by page summary');
        continue;
      }

      const selector = pickSelector(rawLeg);
      
      // For form_submit legs, extract selector from element_info if not at leg level
      let finalSelector = selector;
      if (!finalSelector && type === 'form_submit') {
        // Try element_info first
        if (rawLeg.element_info) {
          finalSelector = rawLeg.element_info.selector || 
                         rawLeg.element_info.css_selector ||
                         (rawLeg.element_info.fields && rawLeg.element_info.fields.length > 0 
                           ? rawLeg.element_info.fields[0].selector 
                           : null);
        }
        
        // If still no selector, try to derive from Playwright analysis forms
        if (!finalSelector && workflowState.playwrightAnalysis && workflowState.playwrightAnalysis.forms) {
          const forms = workflowState.playwrightAnalysis.forms;
          if (forms.length > 0) {
            // Use first form if description matches or just use first available form
            const matchingForm = forms.find(f => {
              const formDesc = (rawLeg.description || '').toLowerCase();
              return formDesc.includes('form') || formDesc.includes('login') || formDesc.includes('submit');
            }) || forms[0];
            
            if (matchingForm) {
              finalSelector = matchingForm.selector || 
                             (matchingForm.id ? `#${matchingForm.id}` : null) ||
                             `form:nth-of-type(${(matchingForm.index || 0) + 1})`;
              console.log(`🔧 Derived form selector from Playwright analysis: ${finalSelector}`);
            }
          }
        }
      }
      
      if (!finalSelector) {
        const legInfo = rawLeg.description || rawLeg.leg_id || rawLeg.journey_id || rawLeg.type || `index_${index}`;
        console.log(`⚠️ Skipping journey "${legInfo}" - no selector found. Available fields: ${Object.keys(rawLeg).join(', ')}`);
        // Log available selector fields for debugging
        const selectorFields = {
          selector: rawLeg.selector,
          css_selector: rawLeg.css_selector,
          element_selector: rawLeg.element_selector,
          element_info_selector: rawLeg.element_info?.selector,
          element_info_css: rawLeg.element_info?.css_selector,
          playwright_forms: workflowState.playwrightAnalysis?.forms?.length || 0
        };
        console.log(`  Selector fields checked:`, JSON.stringify(selectorFields));
        continue;
      }
      const legId = generateLegId(rawLeg, index);
      let description = rawLeg.description || rawLeg.summary || rawLeg.name || rawLeg.label || `Leg ${index + 1}`;
      const expectedOutcome = rawLeg.expected_outcome || rawLeg.expectedOutcome || rawLeg.expected_result || rawLeg.result || '';
      const testInstructions = rawLeg.test_instructions || rawLeg.instructions || rawLeg.steps || '';
      const priority = normalizePriority(rawLeg.priority || rawLeg.importance);
      const confidence = normalizeConfidence(rawLeg.confidence ?? rawLeg.score ?? rawLeg.confidence_score);

      // Check if there's an existing action with action_discovery_prompt for this leg
      // If so, use action_discovery_prompt instead of description for better matching
      if (workflowState.pageId && legId) {
        try {
          const actionResponse = await axios.get(
            `${this.backendUrl}/actions?leg_id=${legId}&page_id=${workflowState.pageId}`,
            { timeout: 3000 }
          );
          const actions = Array.isArray(actionResponse.data) ? actionResponse.data : [];
          const existingAction = actions.find(a => a.leg_id === legId);
          if (existingAction && existingAction.action_discovery_prompt) {
            description = existingAction.action_discovery_prompt;
            console.log(`🔍 Using action_discovery_prompt for leg ${legId}`);
          }
        } catch (error) {
          // Silently continue if fetch fails - use original description
        }
      }

      // Duplicate journey/leg id within this batch only (existingLegIds not in seenIds when hasJourneys)
      if (seenIds.has(legId)) {
        console.warn(`⚠️ Duplicate journey_id in same batch: "${legId}". Skipping duplicate.`);
        continue;
      }
      seenIds.add(legId);

      const normalizedLeg = {
        ...rawLeg,
        leg_id: legId,
        original_leg_id: rawLeg.original_leg_id || legId,
        source_leg_id: rawLeg.source_leg_id || legId,
        type,
        description: String(description).trim(),
        selector: selector || finalSelector || '',
        expected_outcome: expectedOutcome ? String(expectedOutcome).trim() : '',
        test_instructions: testInstructions ? String(testInstructions).trim() : '',
        priority,
        confidence,
        status: rawLeg.status || 'pending',
        iterations: Array.isArray(rawLeg.iterations) ? rawLeg.iterations : [],
        element_info: rawLeg.element_info || rawLeg.elementInfo || rawLeg.element || {},
        metadata: {
          ...(rawLeg.metadata || {}),
          generated_from: source
        }
      };

      if (!normalizedLeg.element_info.selector) {
        normalizedLeg.element_info.selector = selector;
      }

      normalizedLegs.push(normalizedLeg);
    }

    if (normalizedLegs.length === 0) {
      console.log(`⚠️ No valid journeys produced from ${source} response`);
      return [];
    }

    // Merge with existing: put new normalized first so we prefer AI output over prior fallback when same journey_id
    const existingLegs = Array.isArray(workflowState.legs) ? workflowState.legs : [];
    const mergedLegs = [...normalizedLegs, ...existingLegs];
    const finalLegs = [];
    const finalLegIds = new Set();
    for (const leg of mergedLegs) {
      if (!finalLegIds.has(leg.leg_id)) {
        finalLegIds.add(leg.leg_id);
        finalLegs.push(leg);
      }
    }
    
    workflowState.legs = finalLegs;
    workflowState.legsToExecute = finalLegs;
    workflowState.legsSource = source;
    workflowState.legResults = new Array(finalLegs.length).fill(null);
    workflowState.actionsSummary = this.buildActionsSummary(finalLegs);

    // Convert legs to journeys (new format)
    const journeys = this.convertLegsToJourneys(finalLegs);
    workflowState.journeys = journeys;
    workflowState.journeysToExecute = journeys;

    // Ensure context has legsToExecute for for-each step (backwards compatibility)
    if (!workflowState.context) {
      workflowState.context = {};
    }
    workflowState.context.legsToExecute = finalLegs;
    workflowState.context.journeysToExecute = journeys;

    // Save to variable pool for easy access and visibility
    this.initializeVariablePool(workflowState);
    // Save legsToExecute to page namespace (default) - backwards compatibility
    this.saveVariable(workflowState, 'legsToExecute', normalizedLegs, 'page', null);
    this.saveVariable(workflowState, 'legs', normalizedLegs, 'page', null);
    // Save journeys (new format)
    this.saveVariable(workflowState, 'journeysToExecute', journeys, 'page', null);
    this.saveVariable(workflowState, 'journeys', journeys, 'page', null);

    workflowState.aiAnalysisResult = workflowState.aiAnalysisResult || {};
    if (!workflowState.aiAnalysisResult.page_description && workflowState.pageDescription) {
      workflowState.aiAnalysisResult.page_description = workflowState.pageDescription;
    }
    workflowState.aiAnalysisResult.legs = finalLegs; // Keep for backwards compatibility
    workflowState.aiAnalysisResult.journeys = journeys; // New format
    workflowState.aiAnalysisResult.source = source;

    const newLegsCount = normalizedLegs.length;
    const totalLegsCount = finalLegs.length;
    const skippedCount = existingLegs.length > 0 ? (existingLegs.length + newLegsCount - totalLegsCount) : 0;
    
    if (skippedCount > 0) {
      console.log(`✅ Normalized ${newLegsCount} new legs from ${source}, merged with ${existingLegs.length} existing legs (${skippedCount} duplicates skipped, total: ${totalLegsCount})`);
    } else {
      console.log(`✅ Normalized ${newLegsCount} legs from ${source} (total: ${totalLegsCount})`);
    }

    return finalLegs;
  }


  /**
   * Get a reliable selector for an element
   * Returns multiple selector strategies for robust element matching
   */
  async getElementSelector(element) {
    const selectors = [];
    
    try {
      const tagName = await element.evaluate(el => el.tagName.toLowerCase());
      
      // Strategy 1: ID selector (most reliable if stable)
      const id = await element.getAttribute('id');
      if (id) {
        selectors.push({
          strategy: 'id',
          selector: `#${id}`,
          priority: 1,
          stability: 'high'
        });
      }

      // Strategy 2: Name + type selector
      const name = await element.getAttribute('name');
      if (name) {
        selectors.push({
          strategy: 'name',
          selector: `${tagName}[name="${name}"]`,
          priority: 2,
          stability: 'high'
        });
      }

      // Strategy 3: Type selector for inputs
      const type = await element.getAttribute('type');
      if (type) {
        selectors.push({
          strategy: 'type',
          selector: `${tagName}[type="${type}"]`,
          priority: 3,
          stability: 'medium'
        });
      }

      // Strategy 4: Text-based selector (for buttons, links)
      const text = await element.textContent();
      if (text && text.trim()) {
        const cleanText = text.trim().substring(0, 50);
        selectors.push({
          strategy: 'text',
          selector: `text="${cleanText}"`,
          priority: 4,
          stability: 'medium',
          text_content: cleanText
        });
      }

      // Strategy 5: Role selector
      const role = await element.getAttribute('role');
      if (role) {
        selectors.push({
          strategy: 'role',
          selector: `[role="${role}"]`,
          priority: 5,
          stability: 'medium'
        });
      }

      // Strategy 6: Placeholder selector for inputs
      const placeholder = await element.getAttribute('placeholder');
      if (placeholder) {
        selectors.push({
          strategy: 'placeholder',
          selector: `${tagName}[placeholder="${placeholder}"]`,
          priority: 6,
          stability: 'low'
        });
      }

      // Strategy 7: Class selector (if few classes, stable)
      const className = await element.getAttribute('class');
      if (className) {
        const classes = className.trim().split(/\s+/).filter(c => c);
        if (classes.length <= 3 && classes.length > 0) {
          selectors.push({
            strategy: 'class',
            selector: `.${classes.join('.')}`,
            priority: 7,
            stability: classes.length === 1 ? 'medium' : 'low',
            classes: classes
          });
        }
      }

      // Strategy 8: Fallback to tag
      selectors.push({
        strategy: 'tag',
        selector: tagName,
        priority: 8,
        stability: 'very-low'
      });

    } catch (error) {
      console.error('Error generating selectors:', error);
      return [{
        strategy: 'fallback',
        selector: 'unknown',
        priority: 9,
        stability: 'none'
      }];
    }

    return selectors;
  }

  /**
   * Get element selector in legacy format (backward compatibility)
   */
  async getElementSelectorLegacy(element) {
    const selectors = await this.getElementSelector(element);
    // Return the first (highest priority) selector
    return selectors[0]?.selector || 'unknown';
  }

  /**
   * Log page description to job history with attachments (appears above AI chats)
   */
  async logPageDescription(jobId, pageUrl, pageTitle, pageDescription, metadata = {}, htmlContent = null, screenshotBase64 = null) {
    try {
      // Extract short_description with fallbacks (handle different response structures)
      const shortDescription = pageDescription?.short_description ||
                               pageDescription?.description ||
                               pageDescription?.summary ||
                               pageDescription?.short_summary ||
                               (pageDescription && typeof pageDescription === 'string' ? pageDescription : null) ||
                               pageTitle ||
                               'Page analysis completed';
      
      const message = `📄 Page Analysis: ${shortDescription}`;
      
      const logMetadata = {
        page_analysis: true,
        page_title: pageTitle,
        page_url: pageUrl,
        short_description: shortDescription,
        full_description: pageDescription?.full_description || pageDescription?.description || '',
        purpose: pageDescription?.purpose || '',
        conversation_context: pageDescription?.conversation_context || '',
        legs_count: Array.isArray(pageDescription?.legs) ? pageDescription.legs.length : 0,
        ...metadata
      };
      
      // Create attachments for full data (with content for display)
      const attachments = [];
      
      // 1. HTML content attachment
      if (htmlContent) {
        attachments.push({
          type: 'html_content',
          filename: `page_content_${Date.now()}.html`,
          content: htmlContent,  // Full HTML for display
          mimeType: 'text/html',
          size: htmlContent.length,
          timestamp: new Date().toISOString()
        });
      }
      
      // 2. Screenshot attachment (store as base64 data URL for display)
      if (screenshotBase64) {
        // Ensure screenshotBase64 is properly formatted as base64 string
        let screenshotContent = screenshotBase64;
        if (typeof screenshotBase64 === 'string') {
          // If it's already a data URL, use it as-is
          if (screenshotBase64.startsWith('data:image/')) {
            screenshotContent = screenshotBase64;
          } else {
            // If it's raw base64, add data URL prefix
            if (screenshotBase64.length > 100 && /^[A-Za-z0-9+/=]+$/.test(screenshotBase64)) {
              screenshotContent = `data:image/png;base64,${screenshotBase64}`;
            } else {
              screenshotContent = screenshotBase64;
            }
          }
        } else {
          // If it's a Buffer, convert to base64 data URL
          screenshotContent = `data:image/png;base64,${screenshotBase64.toString('base64')}`;
        }
        
        const size = typeof screenshotBase64 === 'string' 
          ? (screenshotBase64.startsWith('data:image/') ? screenshotBase64.length - 22 : screenshotBase64.length)
          : screenshotBase64.length;
        
        attachments.push({
          type: 'screenshot',
          filename: `page_screenshot_${Date.now()}.png`,
          content: screenshotContent,  // Base64 data URL for display
          mimeType: 'image/png',
          size: size,
          timestamp: new Date().toISOString()
        });
      }
      
      // Use backend logger to append job log with attachments
      console.log(`Sending ${attachments.length} attachments:`, attachments.map(a => `${a.type} (${a.size} bytes)`));
      
      const response = await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'info',
        message: message,
        component: 'PAGE-ANALYZER',
        metadata: logMetadata,
        attachments: attachments
      });
      
      console.log(`Page description logged to job history with ${attachments.length} attachments`);
      return response.data;
    } catch (error) {
      console.error('Error logging page description:', error.message);
      // Don't throw - this is not critical
    }
  }

  /**
   * Create workflow document via backend API
   */
  async createWorkflow(pageId, projectId, url, playwrightAnalysis, jobId = null) {
    try {
      if (!pageId) {
        throw new Error('pageId is required to create workflow');
      }
      if (!projectId) {
        throw new Error('projectId is required to create workflow');
      }
      
      // CRITICAL: First check if workflow already exists for this page
      // This prevents recreating workflows that were deleted
      try {
        const existingWorkflowResponse = await axios.get(`${this.backendUrl}/api/workflows/by-page/${pageId}`, {
          headers: this.getAuthHeaders()
        });
        
        if (existingWorkflowResponse.data && existingWorkflowResponse.data._id) {
          console.log(`✅ Workflow already exists for page ${pageId} (ID: ${existingWorkflowResponse.data._id}), returning existing workflow`);
          return existingWorkflowResponse.data;
        }
      } catch (checkError) {
        // 404 is expected if workflow doesn't exist - continue to create
        if (checkError.response && checkError.response.status !== 404) {
          console.warn(`⚠️ Error checking for existing workflow: ${checkError.message}`);
        }
      }
      
      const workflowData = {
        page_id: pageId,
        project_id: projectId,
        url: url,
        playwright_analysis: playwrightAnalysis
      };
      
      // Include job_id if available (so workflows are linked to the job that created them)
      if (jobId) {
        workflowData.job_id = jobId;
      }
      
      console.log(`📝 Creating workflow: pageId=${pageId}, projectId=${projectId}, url=${url}`);
      const response = await axios.post(`${this.backendUrl}/api/workflows`, workflowData, {
        headers: this.getAuthHeaders()
      });

      const workflow = response.data;
      if (!workflow || !workflow._id) {
        console.error('❌ Workflow creation response missing _id:', workflow);
        throw new Error('Workflow creation response missing _id');
      }
      
      console.log(`✅ Workflow created successfully: ${workflow._id}`);
      return workflow;
    } catch (error) {
      console.error('❌ Error creating workflow:', error.message);
      if (error.response) {
        console.error('❌ Response status:', error.response.status);
        console.error('❌ Response data:', error.response.data);
      }
      throw error;
    }
  }

  /**
   * Ensure we have a pageId by discovering/upserting the page if missing.
   */
  /**
   * Clean journey objects to remove circular references before sending to backend
   */
  cleanJourneyForSave(journey) {
    if (!journey || typeof journey !== 'object') {
      return journey;
    }
    
    const cleaned = {
      journey_id: journey.journey_id,
      description: journey.description,
      test_instructions: journey.test_instructions,
      expected_outcome: journey.expected_outcome,
      priority: journey.priority,
      confidence: journey.confidence,
      status: journey.status,
      justification_status: journey.justification_status,
      final_result: journey.final_result,
      expected_outcome_verified: journey.expected_outcome_verified,
      verification_details: journey.verification_details,
      ai_justification: journey.ai_justification,
      completed_at: journey.completed_at ? (journey.completed_at instanceof Date ? journey.completed_at.toISOString() : journey.completed_at) : null,
      updated_at: journey.updated_at ? (journey.updated_at instanceof Date ? journey.updated_at.toISOString() : journey.updated_at) : null,
      actions: Array.isArray(journey.actions) ? journey.actions.map(action => {
        if (!action || typeof action !== 'object') return action;
        return {
          action_id: action.action_id,
          type: action.type,
          description: action.description,
          selector: action.selector,
          test_instructions: action.test_instructions,
          element_info: action.element_info && typeof action.element_info === 'object' ? {
            id: action.element_info.id,
            selector: action.element_info.selector,
            text: action.element_info.text,
            type: action.element_info.type,
            name: action.element_info.name,
            role: action.element_info.role
          } : null,
          interactive_element: action.interactive_element && typeof action.interactive_element === 'object' ? {
            id: action.interactive_element.id,
            selector: action.interactive_element.selector,
            text: action.interactive_element.text,
            type: action.interactive_element.type
          } : null
        };
      }) : [],
      iterations: Array.isArray(journey.iterations) ? journey.iterations.map(iter => {
        if (!iter || typeof iter !== 'object') return iter;
        const cleanedIter = {
          iteration_number: iter.iteration_number,
          status: iter.status,
          timestamp: iter.timestamp ? (iter.timestamp instanceof Date ? iter.timestamp.toISOString() : iter.timestamp) : null,
          screenshot_before: iter.screenshot_before,
          screenshot_after: iter.screenshot_after
        };
        
        // CRITICAL: Include actions in iterations (required for multistep wizards)
        if (Array.isArray(iter.actions)) {
          cleanedIter.actions = iter.actions.map(action => {
            if (!action || typeof action !== 'object') return action;
            return {
              action_id: action.action_id,
              type: action.type,
              description: action.description,
              selector: action.selector,
              test_instructions: action.test_instructions,
              element_info: action.element_info && typeof action.element_info === 'object' ? {
                id: action.element_info.id,
                selector: action.element_info.selector,
                text: action.element_info.text,
                type: action.element_info.type,
                name: action.element_info.name,
                role: action.element_info.role
              } : null,
              interactive_element: action.interactive_element && typeof action.interactive_element === 'object' ? {
                id: action.interactive_element.id,
                selector: action.interactive_element.selector,
                text: action.interactive_element.text,
                type: action.interactive_element.type
              } : null
            };
          });
        }
        
        // Clean result object if it exists
        if (iter.result && typeof iter.result === 'object') {
          cleanedIter.result = {
            status: iter.result.status,
            reason: iter.result.reason,
            expected_outcome_verified: iter.result.expected_outcome_verified,
            verification_details: iter.result.verification_details
          };
        }
        
        return cleanedIter;
      }) : []
    };
    
    return cleaned;
  }

  async ensurePageId(workflowState, jobId) {
    if (workflowState.pageId && workflowState.projectId) {
      return workflowState.pageId;
    }
    if (!workflowState.projectId) {
      return null;
    }

    try {
      const payload = {
        project_id: workflowState.projectId,
        job_id: jobId,
        url: workflowState.pageUrl,
        title: workflowState.pageTitle,
        content: workflowState.htmlContent,
        forms: workflowState.playwrightAnalysis?.forms || [],
        links: workflowState.playwrightAnalysis?.links || [],
        interactive_elements: workflowState.playwrightAnalysis?.interactiveElements || workflowState.playwrightAnalysis?.interactive_elements || [],
        analyzed: true
      };

      const response = await axios.post(`${this.backendUrl}/api/pages/discover`, payload, {
        headers: this.getAuthHeaders()
      });

      const discovered = response.data;
      const pageId = discovered?._id || discovered?.page_id || discovered?.page?._id;
      if (pageId) {
        workflowState.pageId = pageId;
        console.log(`✅ Upserted page, obtained pageId=${pageId}`);
        return pageId;
      }
      console.warn('⚠️ Page discover response missing _id');
      return null;
    } catch (err) {
      console.warn(`⚠️ Failed to upsert page via /api/pages/discover: ${err.message}`);
      return null;
    }
  }

  /**
   * Update workflow with AI analysis and legs
   * Also creates action documents for each leg
   */
  async updateWorkflowWithAnalysis(workflowId, pageDescription, legs, createActions = true, jobId = null) {
    try {
      const response = await axios.put(
        `${this.backendUrl}/api/workflows/${workflowId}/analysis`,
        {
          ai_analysis: {
            page_description: pageDescription,
            analyzed_at: new Date().toISOString()
          },
          legs: legs,
          create_actions: createActions,  // Signal backend to create action documents
          job_id: jobId  // Pass job_id so actions can be linked to the job
        },
        {
          headers: this.getAuthHeaders()
        }
      );

      return response.data;
    } catch (error) {
      console.error('Error updating workflow:', error.message);
      throw error;
    }
  }
  
  /**
   * Send real-time page discovery/update to backend
   * @param {string} jobId - Job ID
   * @param {string} pageId - Page ID
   * @param {string} projectId - Project ID
   * @param {string} url - Page URL
   * @param {Object} data - Page data to update
   */
  async updatePageDiscovery(jobId, pageId, projectId, url, data) {
    try {
      const payload = {
        project_id: projectId,
        job_id: jobId,
        url: url,
        ...data
      };
      
      // Validate required fields
      if (!projectId || !jobId || !url) {
        console.error('Missing required fields for page discovery:', {
          projectId: !!projectId,
          jobId: !!jobId,
          url: !!url
        });
        return;
      }
      
      const response = await axios.post(
        `${this.backendUrl}/api/pages/discover`,
        payload,
        {
          headers: this.getAuthHeaders()
        }
      );
      
      console.log(`Page discovery updated: ${url} (${response.data.isNew ? 'new' : 'updated'})`);
      return response.data;
    } catch (error) {
      console.error('Error updating page discovery:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
      // Don't throw - page discovery updates are non-critical
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
   * Update job progress with current iteration and step information
   */
  async updateJobProgress(jobId, progress = {}) {
    try {
      await axios.put(`${this.backendUrl}/api/jobs/${jobId}/progress`, {
        ...progress,
        timestamp: new Date().toISOString()
      }, {
        headers: this.getAuthHeaders()
      });
    } catch (error) {
      // Silent fail - don't block execution
      console.error(`Failed to update job progress: ${error.message}`);
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
        component: 'WORKFLOW-ANALYZER',
        metadata: {
          workflow_decision: true,
          workflow_id: this.context.workflow_template_id,
          workflow_name: this.workflowTemplate?.name,
          details: details,
          prompts_count: this.workflowTemplate?.prompts?.length || 0,
          timestamp: new Date().toISOString()
        }
      });
      
      console.log(`📝 Logged workflow: ${decision}`);
    } catch (error) {
      console.error('Error logging workflow decision:', error.message);
    }
  }
  
  /**
   * Log prompt usage to job history
   * Shows which prompt was used (custom from template or default from database)
   * @param {string} promptName - Name of the prompt
   * @param {string} source - Source of the prompt ('workflow-step', 'workflow-template', 'database')
   * @param {string} promptText - The prompt text (optional)
   * @param {object} payload - The payload sent to the prompt (optional)
   * @param {object} stepInfo - Step information {step, stepIndex, totalSteps} (optional)
   */
  async logPromptUsage(promptName, source, promptText, payload, stepInfo = null) {
    try {
      const jobId = this.context.job_id;
      if (!jobId) return;
      
      // Format message with step information if available
      let message = `📝 PROMPT USAGE: "${promptName}"`;
      
      if (stepInfo && stepInfo.step && stepInfo.stepIndex !== undefined) {
        const stepNumber = stepInfo.stepIndex + 1; // 1-indexed for display
        const stepName = stepInfo.step.name || stepInfo.step.type || 'Unknown';
        const totalSteps = stepInfo.totalSteps || this.workflowTemplate?.steps?.length || '?';
        message += ` from Step ${stepNumber}/${totalSteps}: "${stepName}"`;
      } else if (source) {
        message += ` from ${source}`;
      }
      
      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'info',
        message: message,
        component: 'WORKFLOW-ANALYZER',
        metadata: {
          prompt_usage: true,
          prompt_name: promptName,
          prompt_source: source, // 'workflow-template' or 'database'
          prompt_text_preview: promptText ? promptText.substring(0, 200) : 'N/A',
          workflow_template_id: this.context.workflow_template_id || null,
          workflow_template_name: this.workflowTemplate?.name || null,
          payload_keys: Object.keys(payload || {}),
          step_name: stepInfo?.step?.name || null,
          step_type: stepInfo?.step?.type || null,
          step_number: stepInfo?.stepIndex !== undefined ? stepInfo.stepIndex + 1 : null,
          total_steps: stepInfo?.totalSteps || this.workflowTemplate?.steps?.length || null,
          timestamp: new Date().toISOString()
        }
      });
      
      console.log(`📝 Logged prompt usage: ${promptName}${stepInfo && stepInfo.step ? ` (Step ${stepInfo.stepIndex + 1}: ${stepInfo.step.name || stepInfo.step.type})` : ''}`);
    } catch (error) {
      console.error('Error logging prompt usage:', error.message);
    }
  }

  /**
   * Log step execution with parameters
   */
  async logStepExecution(step, jobId) {
    try {
      const stepConfig = step.config || {};
      const logData = {
        step_type: step.type,
        step_name: step.name || step.type,
        step_slug: step.slug || null,
        parameters: stepConfig,
        timestamp: new Date().toISOString()
      };

      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'info',
        message: `🔧 Executing step: "${step.name || step.type}"`,
        component: 'WORKFLOW-STEP',
        metadata: logData
      }, {
        headers: this.getAuthHeaders()
      });

      console.log(`📋 STEP PARAMS: ${JSON.stringify(stepConfig, null, 2)}`);
    } catch (error) {
      console.error(`⚠️ Failed to log step execution: ${error.message}`);
    }
  }

  /**
   * Log step outcome with summary metadata
   */
  async logStepOutcome(step, jobId, message, metadata = {}, level = 'info', attachments = []) {
    if (!jobId) {
      return;
    }

    try {
      const slug = step.slug || this.generateSlug(step.name || step.type);
      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: level,
        message: message,
        component: 'WORKFLOW-STEP',
        metadata: {
          step_type: step.type,
          step_name: step.name || step.type,
          step_slug: slug,
          ...metadata,
          timestamp: new Date().toISOString()
        },
        attachments: attachments.length > 0 ? attachments : undefined
      }, {
        headers: this.getAuthHeaders()
      });
    } catch (error) {
      console.error(`⚠️ Failed to log step outcome: ${error.message}`);
    }
  }

  /**
   * Helper to send log to backend (for crucial workflow execution logs)
   */
  async sendLogToBackend(jobId, level, message, component = 'WORKFLOW-ANALYZER', metadata = {}) {
    if (!jobId) {
      return;
    }

    try {
      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: level,
        message: message,
        component: component,
        metadata: {
          ...metadata,
          timestamp: new Date().toISOString()
        }
      }, {
        headers: this.getAuthHeaders()
      });
    } catch (error) {
      console.error(`⚠️ Failed to send log to backend: ${error.message}`);
    }
  }

  /**
   * Execute workflow template steps and return results
   * @param {Page} page - Playwright page object
   * @param {string} jobId - Job ID for logging
   * @param {string} pageId - Page ID in MongoDB
   * @param {string} projectId - Project ID
   * @returns {Object} workflow results
   */
  async executeWorkflowSteps(page, jobId, pageId, projectId) {
    // CRITICAL: job_id must always be available - use from context if not provided as parameter
    // Backend always provides job_id in context, so this ensures workflows can link to the job
    const effectiveJobId = jobId || this.context.job_id;
    if (!effectiveJobId) {
      console.warn(`⚠️ No job_id available - workflows/actions/pages may not be linked to job`);
    }
    
    // CRITICAL: Prevent duplicate execution - track if workflow is already executing
    // Use only jobId and templateId for the key (pageId may change during execution)
    const executionKey = `${effectiveJobId}_${this.context.workflow_template_id}`;
    
    // Initialize execution tracking if needed
    if (!this._executionInProgress) {
      this._executionInProgress = new Set();
    }
    
    if (this._executionInProgress.has(executionKey)) {
      const errorMsg = `⚠️ CRITICAL: Workflow execution already in progress for ${executionKey} - DUPLICATE CALL DETECTED!`;
      console.error(errorMsg);
      console.error(`⚠️ Stack trace:`, new Error().stack);
      await this.sendLogToBackend(effectiveJobId, 'error', errorMsg, 'WORKFLOW-ANALYZER', {
        execution_key: executionKey,
        stack_trace: new Error().stack
      });
      throw new Error(`Workflow execution already in progress for this job/template combination. This indicates a bug - workflow should not be executed twice.`);
    }
    
    this._executionInProgress.add(executionKey);
    console.log(`🔒 Execution guard set for key: ${executionKey} (jobId: ${effectiveJobId}, templateId: ${this.context.workflow_template_id})`);
    
    try {
      console.log(`═══════════════════════════════════════════════════════`);
      console.log(`🔄 EXECUTING WORKFLOW TEMPLATE STEPS (job_id: ${effectiveJobId || 'none'})`);
      console.log(`═══════════════════════════════════════════════════════`);
    
    const resolvedOptions = {
      ...(this.context?.options || {})
    };
    if (this.context?.single_action_only !== undefined && resolvedOptions.single_action_only === undefined) {
      resolvedOptions.single_action_only = this.context.single_action_only;
    }
    const singleActionOnly =
      resolvedOptions.single_action_only === true ||
      resolvedOptions.single_action_only === 'true';

    // CRITICAL: Track initial URL to prevent navigation away from login page
    const initialPageUrl = page.url();
    const expectedLoginUrl = this.context?.page_url || initialPageUrl;
    console.log(`📄 VAR_DUMP: executeWorkflowSteps - initialPageUrl=${initialPageUrl}`);
    console.log(`📄 VAR_DUMP: executeWorkflowSteps - expectedLoginUrl=${expectedLoginUrl}`);
    
    // Initialize workflow state
    const workflowState = {
      pageTitle: null,
      pageUrl: initialPageUrl, // Use initial URL, not current (may have changed)
      expectedLoginUrl: expectedLoginUrl, // Track expected login URL
      htmlContent: null,
      visibleText: null,
      screenshotBase64: null,
      screenshotUrl: null,
      screenshotFileId: null,
      playwrightAnalysis: null,
      pageDescription: null,
      conversationHistory: [],
      aiAnalysisResult: null,
      workflowId: null,
      legs: [],
      legResults: [],
      options: resolvedOptions,
      runtimeOptions: resolvedOptions,
      singleActionOnly,
      context: {
        ...(this.context?.context || {}),
        options: resolvedOptions
      },
      inputCredentials: (() => {
        // CRITICAL: Credentials are only required for login jobs
        // For crawl jobs, credentials are optional (only needed if login_enabled)
        const isLoginJob = this.context?.jobType === 'login' || 
                          this.context?.job_type === 'login' ||
                          this.context?.isLoginJob === true;
        const loginEnabled = this.context?.login_enabled === true || 
                            this.context?.options?.login_enabled === true;
        
        // Only require credentials for login jobs or if login is explicitly enabled
        if (isLoginJob || loginEnabled) {
          if (!this.context?.credentials || !this.context.credentials.username || !this.context.credentials.password ||
              this.context.credentials.username === 'MISSING' || this.context.credentials.username === 'missing' ||
              this.context.credentials.password === 'MISSING' || this.context.credentials.password === 'missing') {
            console.error(`❌ ERROR: Credentials missing or invalid in context.credentials!`);
            console.error(`this.context.credentials:`, this.context?.credentials);
            throw new Error('Credentials are required in context.credentials and must not contain placeholder values');
          }
          
          const creds = this.context.credentials;
          console.log(`📄 VAR_DUMP: inputCredentials initialization (login job/enabled)`);
          console.log(`📄 VAR_DUMP: creds.username=${creds.username}`);
          console.log(`📄 VAR_DUMP: creds.password=***`);
          console.log(`🔑 Initialized inputCredentials: username=${creds.username}, password=***`);
          return creds;
        } else {
          // Crawl job without login - credentials optional
          // Use credentials if available, otherwise return null
          if (this.context?.credentials && 
              this.context.credentials.username && 
              this.context.credentials.password &&
              this.context.credentials.username !== 'MISSING' && 
              this.context.credentials.username !== 'missing' &&
              this.context.credentials.password !== 'MISSING' && 
              this.context.credentials.password !== 'missing') {
            const creds = this.context.credentials;
            console.log(`📄 VAR_DUMP: inputCredentials initialization (crawl job, credentials available)`);
            console.log(`🔑 Initialized inputCredentials: username=${creds.username}, password=***`);
            return creds;
          } else {
            console.log(`ℹ️ No credentials provided for crawl job (login not enabled) - proceeding without credentials`);
            return null;
          }
        }
      })(),
      // Variable Pool - organized by namespace (job, page, cycle)
      variablePool: {
        job: {},      // Variables scoped to the entire job execution
        page: {},     // Variables scoped to the current page
        cycle: [],    // Array of cycle scopes (for nested loops) - each cycle has its own namespace
        steps: {}     // Step results organized by step slug for easy reference
      },
      // Track current cycle depth for proper namespace scoping
      cycleDepth: 0,
      cycleStack: []  // Stack of cycle contexts for nested loops
    };
    
    workflowState.pageId = pageId || null;
    workflowState.projectId = projectId || null;
    workflowState.jobId = effectiveJobId; // Use effectiveJobId (from parameter or context)

    // If we already have a projectId but no pageId, try to upsert/discover the page early
    if (!workflowState.pageId && workflowState.projectId) {
      await this.ensurePageId(workflowState, effectiveJobId);
    }
    
    // Check if we should retry from a specific step (after self-adjustable workflow)
    let startStepIndex = 0;
    if (workflowState.shouldRetryFromStep !== undefined && workflowState.shouldRetryFromStep !== null) {
      startStepIndex = workflowState.shouldRetryFromStep;
      console.log(`🔄 Retrying from step ${startStepIndex} with adjusted workflow`);
      // Clear the flag so we don't loop
      delete workflowState.shouldRetryFromStep;
      // Clear the last script failure so self-adjustable workflow doesn't trigger again
      delete workflowState.lastScriptFailure;
    }
    
    // Execute each step in sequence
    // CRITICAL: Store steps length at start to prevent issues if steps array is modified
    const totalSteps = this.workflowTemplate.steps.length;
    console.log(`🔒 Starting step execution loop: ${totalSteps} steps, starting from index ${startStepIndex}`);
    
    for (let i = startStepIndex; i < totalSteps; i++) {
      const step = this.workflowTemplate.steps[i];
      console.log(`🔒 Loop iteration: i=${i}, step.name=${step.name}, step.id=${step.id || 'no-id'}`);
      console.log(`═══════════════════════════════════════════════════════`);
      console.log(`🔄 EXECUTING STEP ${i + 1}/${totalSteps}: ${step.name}`);
      console.log(`Type: ${step.type}`);
      console.log(`═══════════════════════════════════════════════════════`);
      
      // Send log to backend
      await this.sendLogToBackend(effectiveJobId, 'info', `🔄 EXECUTING STEP ${i + 1}/${this.workflowTemplate.steps.length}: ${step.name} (${step.type})`, 'WORKFLOW-ANALYZER', {
        step_id: step.id,
        step_name: step.name || step.type,
        step_type: step.type,
        step_order: i + 1,
        total_steps: this.workflowTemplate.steps.length
      });
      
      try {
        // Process variable inputs before step execution
        const variableInputs = this.processVariableInputs(step, workflowState);
        if (Object.keys(variableInputs).length > 0) {
          console.log(`📖 Loaded ${Object.keys(variableInputs).length} variable(s) for step execution`);
        }

        // Get step timeout
        const stepTimeout = this.getStepTimeout(step);
        console.log(`⏱️  Step timeout: ${Math.round(stepTimeout / 1000)}s`);
        
        // Log step execution with parameters
        await this.logStepExecution(step, jobId);
        
        // Execute step with timeout
        let stepCompleted = false;
        let pageLoadedSuccessfully = false;
        
        // Check if page is loaded before starting (for timeout handling)
        try {
          const currentUrl = page.url();
          pageLoadedSuccessfully = !!currentUrl && currentUrl !== 'about:blank';
        } catch (e) {
          // Page check failed, but continue
        }
        
        await Promise.race([
          (async () => {
            switch (step.type) {
          case 'screenshot':
            await this.executeScreenshotStep(page, step, workflowState, effectiveJobId, pageId);
            break;
            
          case 'browser-config':
            await this.executeBrowserConfigStep(page, step, workflowState, effectiveJobId);
            break;
            
          case 'playwright-analysis':
            await this.executePlaywrightAnalysisStep(page, step, workflowState, effectiveJobId);
            break;
            
          case 'ai-prompt':
            try {
              await this.executeAIPromptStep(page, step, workflowState, effectiveJobId, {
                stepIndex: i,
                siblings: this.workflowTemplate.steps
              });
            } catch (stepError) {
              const errorMessage = `Step "${step.name || step.id}" (ai-prompt) failed: ${stepError.message}`;
              console.error(`❌ ${errorMessage}`);
              console.error(`❌ Step config:`, JSON.stringify(step.config, null, 2));
              console.error(`❌ Full step:`, JSON.stringify(step, null, 2));
              if (effectiveJobId && this.backendLogger) {
                await this.backendLogger.appendJobLog(effectiveJobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', {
                  step_id: step.id,
                  step_name: step.name,
                  step_type: step.type,
                  step_config: step.config,
                  error: stepError.message,
                  error_stack: stepError.stack,
                  full_step: step
                });
              }
              throw stepError; // Re-throw to fail workflow
            }
            break;
          
          // Deterministic, hardcoded analysis for specific domains (e.g., Practical Test Automation)
          case 'hardcoded-workflow-analysis':
            await this.executeHardcodedWorkflowAnalysisStep(page, step, workflowState, effectiveJobId);
            break;
            
          case 'update-workflow':
            await this.executeUpdateWorkflowStep(step, workflowState, effectiveJobId);
            break;
            
          case 'page-discovery':
            // DEPRECATED: page-discovery step type has been removed
            // Each workflow step must save its own data when executed
            console.warn(`⚠️ DEPRECATED: page-discovery step type has been removed. Skipping step "${step.name || step.id}".`);
            console.warn(`⚠️ Each workflow step must save its own data when executed.`);
            // Skip this step - data should already be saved by individual steps
            break;
            
          case 'save-page-data':
            await this.executeSavePageDataStep(page, step, workflowState, effectiveJobId);
            break;
            
          case 'execute-code':
            const nextStepForCode = i + 1 < this.workflowTemplate.steps.length ? this.workflowTemplate.steps[i + 1] : null;
            await this.executeCodeStep(page, step, workflowState, effectiveJobId, nextStepForCode);
            break;
            
          case 'execute-code-from-variable':
            const nextStep = i + 1 < this.workflowTemplate.steps.length ? this.workflowTemplate.steps[i + 1] : null;
            try {
              await this.executeCodeFromVariableStep(page, step, workflowState, jobId, nextStep);
            } catch (stepError) {
              const errorMessage = `Step "${step.name || step.id}" (execute-code-from-variable) failed: ${stepError.message}`;
              console.error(`❌ ${errorMessage}`);
              console.error(`❌ Step config:`, JSON.stringify(step.config, null, 2));
              console.error(`❌ Full step:`, JSON.stringify(step, null, 2));
              if (jobId && this.backendLogger) {
                await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', {
                  step_id: step.id,
                  step_name: step.name,
                  step_type: step.type,
                  step_config: step.config,
                  error: stepError.message,
                  error_stack: stepError.stack,
                  full_step: step
                });
              }
              throw stepError; // Re-throw to fail workflow
            }
            break;
            
          case 'cookie-add':
            await this.executeCookieAddStep(step, workflowState, jobId);
            break;
            
          case 'cookie-update':
            await this.executeCookieUpdateStep(step, workflowState, jobId);
            break;
            
          case 'cookie-remove':
            await this.executeCookieRemoveStep(step, workflowState, jobId);
            break;
            
          case 'cookie-collect':
            await this.executeCookieCollectStep(page, step, workflowState, jobId);
            break;
            
          case 'job-configuration':
            await this.executeJobConfigurationStep(step, workflowState, effectiveJobId);
            break;
            
          case 'content-change':
            await this.executeContentChangeStep(step, workflowState, jobId);
            break;
            
          case 'validate-response':
            await this.executeValidateResponseStep(step, workflowState);
            break;
            
          case 'filter-response':
            await this.executeFilterResponseStep(step, workflowState);
            break;
            
          case 'cycle-start':
            console.log(`🔄 Starting cycle (${step.name})`);
            break;
            
          case 'cycle-end':
            console.log(`🔚 Ending cycle (${step.name})`);
            break;
            
          case 'conditional':
            await this.executeConditionalStep(step, workflowState);
            break;
            
          case 'print':
            await this.executePrintStep(step, workflowState, jobId);
            break;

          case 'var-dump':
            // DEPRECATED: var-dump is now part of save-page-data
            // For backward compatibility, execute as save-page-data with variableDump enabled
            await this.executeSavePageDataStep(page, step, workflowState, effectiveJobId);
            break;
          case 'save-page-data':
            await this.executeSavePageDataStep(page, step, workflowState, effectiveJobId);
            break;
            
          case 'sleep':
            await this.executeSleepStep(step, workflowState);
            break;
            
          case 'complete-leg':
            await this.executeCompleteLegStep(step, workflowState, jobId);
            break;
            
          case 'for-each':
            await this.executeForEachStep(page, step, workflowState, effectiveJobId);
            break;
            
          case 'while-loop':
            await this.executeWhileLoopStep(page, step, workflowState, effectiveJobId);
            break;
            
          case 'if':
          case 'if-step':
            await this.executeIfStep(page, step, workflowState, jobId);
            break;
            
          default:
            console.log(`⚠️ Unknown step type: ${step.type}`);
        }
            stepCompleted = true;
          })(),
          new Promise((resolve, reject) => 
            setTimeout(() => {
              if (!stepCompleted) {
                // For for-each steps, check if page loaded successfully before failing
                if (step.type === 'for-each' && pageLoadedSuccessfully) {
                  console.log(`⚠️ Step "${step.name || step.id}" timed out but page loaded successfully - allowing to continue`);
                  // Resolve instead of reject to allow step to continue
                  resolve();
                } else {
                  reject(new Error(`Step "${step.name || step.id}" timed out after ${Math.round(stepTimeout / 1000)}s`));
                }
              }
            }, stepTimeout)
          )
        ]);
        
        // CRITICAL: Check if any step has signaled the workflow should stop
        // This is workflow-driven: steps can set stopWorkflow in their results
        // The workflow template controls when to stop by configuring steps appropriately
        if (workflowState.stopWorkflow === true) {
          const stopReason = workflowState.stopWorkflowReason || 'Workflow stopped by step configuration';
          console.log(`🛑 Workflow stop signaled - STOPPING workflow (stopped at step ${i + 1}/${this.workflowTemplate.steps.length}): ${stopReason}`);
          await this.sendLogToBackend(effectiveJobId, 'info', `🛑 Workflow stopped: ${stopReason}`, 'WORKFLOW-ANALYZER', {
            workflow_id: workflowState.workflowId,
            steps_executed: i + 1,
            total_steps: this.workflowTemplate.steps.length,
            stopped_early: true,
            stop_reason: stopReason
          });
          
          // Break out of the loop immediately - don't execute remaining steps
          break;
        }
        
        // Add delay between steps
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (stepError) {
        const errorMessage = `Step ${i + 1} "${step.name || step.id}" (${step.type}) failed: ${stepError.message}`;
        console.error(`❌ ${errorMessage}`);
        console.error(`❌ Step config:`, JSON.stringify(step.config, null, 2));
        console.error(`❌ Full step:`, JSON.stringify(step, null, 2));
        console.error(`❌ Error stack:`, stepError.stack);
        
        // Upload variable pool as downloadable file on error
        let variablePoolUrl = null;
        try {
          const variablePoolJson = JSON.stringify(workflowState.variablePool, null, 2);
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const fileName = `variable-pool-${effectiveJobId}-${timestamp}.json`;
          variablePoolUrl = await this.uploadFileForDownload(effectiveJobId, variablePoolJson, fileName, 'application/json');
          
          if (variablePoolUrl) {
            console.error(`❌ Variable Pool (full content at time of error):`);
            console.error(`❌ 📥 Download: ${variablePoolUrl}`);
          } else {
            // Fallback: log preview if upload fails
            console.error(`❌ Variable Pool (preview, upload failed):`);
            console.error(`❌ ${variablePoolJson.substring(0, 2000)}...`);
          }
        } catch (varPoolError) {
          console.error(`❌ Failed to upload variable pool: ${varPoolError.message}`);
          // Try to log at least the structure
          try {
            const varPoolSummary = {
              job: workflowState.variablePool?.job ? Object.keys(workflowState.variablePool.job) : [],
              page: workflowState.variablePool?.page ? Object.keys(workflowState.variablePool.page) : [],
              cycle: workflowState.variablePool?.cycle ? workflowState.variablePool.cycle.map((c, idx) => ({ index: idx, keys: Object.keys(c || {}) })) : [],
              steps: workflowState.variablePool?.steps ? Object.keys(workflowState.variablePool.steps) : []
            };
            console.error(`❌ Variable Pool structure:`, JSON.stringify(varPoolSummary, null, 2));
          } catch (summaryError) {
            console.error(`❌ Failed to summarize variable pool: ${summaryError.message}`);
          }
        }
        
        // Send error log to backend with full context including variable pool URL
        let variablePoolForBackend = null;
        try {
          variablePoolForBackend = workflowState.variablePool;
        } catch (e) {
          // If we can't access it, leave it null
        }
        
        const errorLogMessage = variablePoolUrl 
          ? `${errorMessage}\n📥 Variable Pool: ${variablePoolUrl}`
          : errorMessage;
        
        await this.sendLogToBackend(effectiveJobId, 'error', errorLogMessage, 'WORKFLOW-ANALYZER', {
          step_id: step.id,
          step_name: step.name || step.type,
          step_type: step.type,
          step_order: i + 1,
          step_config: step.config,
          error: stepError.message,
          error_stack: stepError.stack,
          full_step: step,
          variable_pool: variablePoolForBackend,
          variable_pool_download_url: variablePoolUrl
        });
        
        // Check if this is a script execution failure and next step is self-adjustable-ai-workflow
        const isScriptExecutionFailure = (
          step.type === 'execute-code' || 
          step.type === 'execute-code-from-variable'
        );
        const nextStepIndex = i + 1;
        const nextStep = nextStepIndex < this.workflowTemplate.steps.length 
          ? this.workflowTemplate.steps[nextStepIndex] 
          : null;
        const nextStepIsAdjustable = nextStep && nextStep.type === 'self-adjustable-ai-workflow';
        
        // No fallbacks: fail the job immediately on any step failure
        throw stepError;
      }
    }
    
    console.log(`═══════════════════════════════════════════════════════`);
    console.log(`✅ ALL WORKFLOW STEPS COMPLETED`);
    console.log(`═══════════════════════════════════════════════════════`);
    
    // Workflows are only created when explicitly requested via a step or API call
    // No automatic workflow creation - workflows must be explicitly created
    if (!workflowState.workflowId) {
      console.log(`⚠️ No workflow_id set - workflows must be created explicitly via a step or API call`);
    } else {
      console.log(`✅ Workflow already exists: ${workflowState.workflowId}`);
    }
    
    // CRITICAL: For login jobs, check if login was successful and mark job as complete
    const isLoginJob = workflowState.jobType === 'login' || 
                       this.context?.jobType === 'login' || 
                       this.context?.job_type === 'login' ||
                       this.context?.isLoginJob === true;
    
    if (isLoginJob) {
      // Extract login status from determine_completion step result
      const determineResult = 
        workflowState.results?.determine_completion?.result ||
        workflowState.determine_completion?.result ||
        workflowState.determine_completion ||
        workflowState.context?.determine_completion?.result ||
        workflowState.context?.determine_completion ||
        null;
      
      const loginStatus = determineResult?.status || determineResult?.completion_status || null;
      const loginSuccess = loginStatus === 'success' || 
                          (determineResult?.is_complete === true && loginStatus !== 'failure');
      
      if (loginSuccess) {
        await this.sendLogToBackend(effectiveJobId, 'info', `✅ LOGIN SUCCESSFUL - Job will stop after saving results`, 'WORKFLOW-ANALYZER', {
          login_status: 'success',
          workflow_id: workflowState.workflowId,
          reason: determineResult?.reason || 'Login confirmed by AI analysis'
        });
        // Mark in workflowState that login was successful
        workflowState.loginSuccess = true;
        workflowState.loginStatus = 'success';
        workflowState.context = workflowState.context || {};
        workflowState.context.login_status = 'success';
        workflowState.context.loginSuccess = true;
      } else {
        await this.sendLogToBackend(effectiveJobId, 'warn', `⚠️ Login not confirmed (status: ${loginStatus || 'unknown'})`, 'WORKFLOW-ANALYZER', {
          login_status: loginStatus || 'unknown',
          workflow_id: workflowState.workflowId,
          reason: determineResult?.reason || 'Login status unclear'
        });
        workflowState.loginSuccess = false;
        workflowState.loginStatus = loginStatus || 'unknown';
      }
    }
    
    // CRITICAL: Final save of journeys before workflow completes
    // This ensures journeys are saved even if earlier save attempts failed
    // Check multiple sources for journeys - "Execute Workflow Journeys" runs, so journeys must exist somewhere
    let journeysToSave = workflowState.journeys || workflowState.journeysToExecute || null;
    if (!journeysToSave || journeysToSave.length === 0) {
      // Check variablePool for journeys extracted by variableOutputs
      const journeysVar = this.readVariable(workflowState, 'journeysToExecute', 'page');
      if (journeysVar && Array.isArray(journeysVar) && journeysVar.length > 0) {
        journeysToSave = journeysVar;
        console.log(`🔍 [WORKFLOW-COMPLETE] Found ${journeysVar.length} journey(s) in variablePool`);
      }
    }
    if (!journeysToSave || journeysToSave.length === 0) {
      // Check context for journeys
      if (workflowState.context?.journeysToExecute && Array.isArray(workflowState.context.journeysToExecute) && workflowState.context.journeysToExecute.length > 0) {
        journeysToSave = workflowState.context.journeysToExecute;
        console.log(`🔍 [WORKFLOW-COMPLETE] Found ${journeysToSave.length} journey(s) in context`);
      }
    }
    
    // CRITICAL: Check stepResults for journeys (might be stored there by storeStepResult)
    if (!journeysToSave || journeysToSave.length === 0) {
      if (workflowState.stepResults) {
        for (const [stepId, stepResult] of Object.entries(workflowState.stepResults)) {
          if (stepResult?.result?.journeys && Array.isArray(stepResult.result.journeys) && stepResult.result.journeys.length > 0) {
            journeysToSave = stepResult.result.journeys;
            console.log(`🔍 [WORKFLOW-COMPLETE] Found ${journeysToSave.length} journey(s) in stepResults[${stepId}]`);
            break;
          }
        }
      }
    }
    
    if (journeysToSave && Array.isArray(journeysToSave) && journeysToSave.length > 0) {
      let pageIdToUse = workflowState.pageId || this.context?.page_id || this.context?.pageId || null;
      let projectIdToUse = workflowState.projectId || this.context?.project_id || this.context?.projectId || null;
      
      if (!pageIdToUse && projectIdToUse && workflowState.pageUrl) {
        try {
          pageIdToUse = await this.ensurePageId(workflowState, effectiveJobId);
        } catch (pageError) {
          console.warn(`⚠️ [JOURNEYS-FINAL] Failed to get pageId: ${pageError.message}`);
        }
      }
      
      if (pageIdToUse && projectIdToUse) {
        try {
          // First ensure page exists, create if it doesn't
          let pageExists = false;
          try {
            await axios.get(`${this.backendUrl}/api/pages/${pageIdToUse}`, { headers: this.getAuthHeaders() });
            pageExists = true;
          } catch (checkError) {
          if (checkError.response?.status === 404) {
            console.log(`🔍 [JOURNEYS-FINAL] Page ${pageIdToUse} not found, creating it first`);
            const newPageId = await this.ensurePageId(workflowState, effectiveJobId);
            if (newPageId) {
              pageIdToUse = newPageId;
              workflowState.pageId = newPageId; // Update workflowState so subsequent calls use the correct ID
              pageExists = true;
              console.log(`✅ [JOURNEYS-FINAL] Created page with ID: ${pageIdToUse}`);
            } else {
              throw new Error('Failed to create page');
            }
          } else {
            throw checkError;
          }
          }
          
          if (pageExists && pageIdToUse) {
            // Check if journeys already exist (skip check if page was just created to avoid 404)
            let existingJourneys = [];
            let skipCheck = false;
            try {
              const pageCheckResponse = await axios.get(
                `${this.backendUrl}/api/pages/${pageIdToUse}`,
                { headers: this.getAuthHeaders() }
              );
              existingJourneys = pageCheckResponse.data?.journeys || [];
            } catch (checkError) {
              if (checkError.response?.status === 404) {
                // Page was just created, might not be immediately available - skip duplicate check and save all journeys
                console.log(`🔍 [JOURNEYS-FINAL] Page ${pageIdToUse} not yet available after creation, will save all journeys`);
                skipCheck = true;
              } else {
                throw checkError;
              }
            }
            
            const existingJourneyIds = skipCheck ? new Set() : new Set(existingJourneys.map(j => j.journey_id));
            const newJourneys = skipCheck ? journeysToSave : journeysToSave.filter(j => !existingJourneyIds.has(j.journey_id));
            
            if (newJourneys.length > 0) {
              console.log(`🔍 [JOURNEYS-FINAL] Saving ${newJourneys.length} journey(s) at workflow completion${skipCheck ? ' (page just created)' : ` (${existingJourneys.length} already exist)`}`);
              
              // CRITICAL: Clean journeys to remove circular references before sending
              const cleanedJourneys = newJourneys.map(j => this.cleanJourneyForSave(j));
              
              const payload = {
                saveLegs: true,
                journeys: cleanedJourneys,
                job_id: effectiveJobId
              };
              
              const response = await axios.post(
                `${this.backendUrl}/api/pages/${pageIdToUse}/save-analysis`,
                payload,
                { headers: this.getAuthHeaders() }
              );
              
              console.log(`✅ [JOURNEYS-FINAL] Saved ${newJourneys.length} journey(s) at workflow completion. Response status: ${response.status}`);
              await this.sendLogToBackend(effectiveJobId, 'info', `✅ [JOURNEYS-FINAL] Saved ${newJourneys.length} journey(s) at workflow completion`, 'WORKFLOW-ANALYZER', {
                journeys_count: newJourneys.length,
                page_id: pageIdToUse,
                response_status: response.status
              });
            } else {
              console.log(`✅ [JOURNEYS-FINAL] All ${journeysToSave.length} journey(s) already exist on page`);
            }
          }
        } catch (finalError) {
          console.error(`❌ [JOURNEYS-FINAL] Failed to save journeys at workflow completion: ${finalError.message}`);
          console.error(`❌ [JOURNEYS-FINAL] Error details:`, finalError.response?.data || finalError.message);
          await this.sendLogToBackend(effectiveJobId, 'error', `❌ [JOURNEYS-FINAL] Failed to save journeys: ${finalError.message}`, 'WORKFLOW-ANALYZER', {
            error: finalError.message,
            status: finalError.response?.status,
            error_data: finalError.response?.data
          });
        }
      } else {
        console.warn(`⚠️ [JOURNEYS-FINAL] Cannot save journeys at workflow completion: missing pageId (${pageIdToUse}) or projectId (${projectIdToUse})`);
        console.warn(`⚠️ [JOURNEYS-FINAL] workflowState.pageId: ${workflowState.pageId}, context.page_id: ${this.context?.page_id}`);
      }
    }
    
    // Send log to backend
    await this.sendLogToBackend(effectiveJobId, 'info', `✅ ALL WORKFLOW STEPS COMPLETED${workflowState.workflowId ? ` (workflow: ${workflowState.workflowId})` : ' (no workflow_id)'}`, 'WORKFLOW-ANALYZER', {
      total_steps: this.workflowTemplate.steps.length,
      workflow_id: workflowState.workflowId,
      legs_count: workflowState.legs?.length || 0,
      journeys_count: workflowState.journeys?.length || 0,
      is_login_job: isLoginJob,
      login_success: isLoginJob ? (workflowState.loginSuccess || false) : undefined
    });
    
    // CRITICAL: Include all step results in the return value
    // Step results are stored by step.id, step.slug, and in workflowState.results
    // This allows login-operations.js to extract determine_completion and other step results

    // When template returns journeys (not legs), workflowState.legs may never be set; derive from journeysToExecute so caller gets legs_count/legs
    let resultLegs = Array.isArray(workflowState.legs) ? workflowState.legs : [];
    if (resultLegs.length === 0 && workflowState.journeysToExecute && Array.isArray(workflowState.journeysToExecute) && workflowState.journeysToExecute.length > 0) {
      resultLegs = workflowState.journeysToExecute.map(journey => ({
        leg_id: journey.journey_id,
        description: journey.description,
        test_instructions: journey.test_instructions,
        expected_outcome: journey.expected_outcome,
        actions: journey.actions || [],
        journey_id: journey.journey_id
      }));
      console.log(`✅ [WORKFLOW-RESULT] Derived ${resultLegs.length} legs from journeysToExecute for result (caller will see testable legs)`);
    }
    
    // Build result object with all step results accessible
    const result = {
      workflow_id: workflowState.workflowId,
      legs_count: resultLegs.length,
      page_description: workflowState.pageDescription,
      legs: resultLegs,
      journeys: workflowState.journeysToExecute || [], // Include so caller can check journey status (success/failure)
      ai_analysis: workflowState.aiAnalysisResult,
      context: workflowState.context || {},
      collectedCookies: workflowState.collectedCookies || [],
      login_status: workflowState.context?.login_status || workflowState.loginStatus || null,
      screenshotUrl: workflowState.screenshotUrl || null,
      screenshotFileId: workflowState.screenshotFileId || null,
      // Include all step results by ID (e.g., determine_completion, perform_login_attempts, etc.)
      results: workflowState.results || {}
    };
    
    // Also include step results directly on the result object for backward compatibility
    // This allows analysisResult.determine_completion to work
    if (workflowState.results) {
      for (const [stepId, stepResult] of Object.entries(workflowState.results)) {
        if (stepResult && typeof stepResult === 'object') {
          result[stepId] = stepResult;
        }
      }
    }
    
    // Also include step results stored by slug or name (storeStepResult stores in multiple places)
    // Check for common step IDs like determine_completion, perform_login_attempts, etc.
    const importantStepIds = ['determine_completion', 'perform_login_attempts', 'collect_iteration_cookies', 'collect_final_cookies'];
    for (const stepId of importantStepIds) {
      if (workflowState[stepId] && !result[stepId]) {
        result[stepId] = workflowState[stepId];
      }
      // Also check for slug-based storage
      const stepSlug = workflowState[stepId]?.stepName ? 
        workflowState[stepId].stepName.toLowerCase().replace(/\s+/g, '_') : null;
      if (stepSlug && workflowState[stepSlug] && !result[stepSlug]) {
        result[stepSlug] = workflowState[stepSlug];
      }
    }
    
    // Note: workflow_id is optional - workflows are only created when explicitly requested via a step or API call
    // This is expected behavior, not an error
    if (!result.workflow_id) {
      console.log(`ℹ️ workflow_id is not set - workflows are only created when explicitly requested (this is expected)`);
    } else {
      console.log(`✅ Returning workflow results with workflow_id: ${result.workflow_id}`);
    }
    
    console.log(`✅ Returning workflow results with step results:`, Object.keys(result.results || {}));
    
    return result;
    } finally {
      // Clean up execution tracking
      if (this._executionInProgress) {
        this._executionInProgress.delete(executionKey);
      }
    }
  }

  /**
   * Execute hardcoded workflow analysis step
   * Reproduces deterministic page analysis: pages → actions → elements
   * Tailored for domains like practicaltestautomation.com to avoid heavy AI usage
   */
  async executeHardcodedWorkflowAnalysisStep(page, step, workflowState, jobId) {
    console.log(`🧩 Performing hardcoded workflow analysis (${step.name})`);
    const url = workflowState.pageUrl;

    // Ensure Playwright analysis exists (forms, links, interactive elements)
    if (!workflowState.playwrightAnalysis) {
      const analysis = await this.performPlaywrightAnalysis(page);
      workflowState.playwrightAnalysis = analysis;
    }

    // Domain detection (default to enabled if step.config.force === true)
    const force = step.config?.force === true;
    const isPracticalTestAutomation = typeof url === 'string' && /practicaltestautomation/i.test(url);
    if (!force && !isPracticalTestAutomation) {
      console.log(`ℹ️ Hardcoded analysis skipped (domain not matched, use config.force=true to override)`);
      return;
    }

    const legs = await this.generateLegsFromPlaywrightAnalysis(workflowState.playwrightAnalysis, url, workflowState);

    if (legs.length === 0) {
      console.log(`⚠️ Hardcoded analysis produced no legs`);
      return;
    }

    workflowState.legs = legs;
    workflowState.aiAnalysisResult = workflowState.aiAnalysisResult || {};
    workflowState.aiAnalysisResult.page_description = workflowState.aiAnalysisResult.page_description || workflowState.pageDescription || null;
    workflowState.aiAnalysisResult.legs = legs;
    console.log(`✅ Hardcoded analysis completed: ${legs.length} legs identified`);
  }

  /**
   * Execute screenshot step
   */
  async executeScreenshotStep(page, step, workflowState, jobId, pageId) {
    console.log(`📸 Taking screenshot (${step.name})`);
    const config = step.config || {};
    const fullPage = config.fullPage !== false;
    const upload = config.upload !== false;
    const format = (config.format || config.type || 'png').toLowerCase();
    const quality = typeof config.quality === 'number' ? config.quality : 90;

    const screenshotOptions = {
      fullPage,
      type: format === 'jpeg' || format === 'jpg' ? 'jpeg' : 'png'
    };

    if (screenshotOptions.type === 'jpeg' && typeof quality === 'number') {
      screenshotOptions.quality = quality;
    }

    console.log('Screenshot options resolved:', screenshotOptions);

    const screenshot = await page.screenshot(screenshotOptions);

    workflowState.screenshotBase64 = screenshot.toString('base64');
    console.log(`✅ Screenshot taken (${screenshot.length} bytes)`);

    let uploaded = false;
    let publicUrl = null;
    let fileId = null;

    if (upload) {
      try {
        console.log(`📸 Requesting presigned URL for screenshot upload...`);

        const mimeType = screenshotOptions.type === 'jpeg' ? 'image/jpeg' : 'image/png';

        const presignedResponse = await axios.post(`${this.backendUrl}/api/upload/presigned-url`, {
          type: 'screenshot',
          jobId: jobId,
          contentType: mimeType
        }, {
          timeout: 10000,
          headers: this.getAuthHeaders()
        });

        const { url: presignedUrl, key, publicUrl: returnedUrl } = presignedResponse.data;
        workflowState.screenshotFileId = key;
        workflowState.screenshotUrl = returnedUrl;
        fileId = key;
        publicUrl = returnedUrl;

        await axios.put(presignedUrl, screenshot, {
          headers: { 'Content-Type': mimeType },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 30000
        });

        uploaded = true;
        console.log(`✅ Screenshot uploaded to MinIO: ${returnedUrl}`);

        if (pageId) {
          await axios.post(`${this.backendUrl}/api/pages/${pageId}/screenshot`, {
            fileId: workflowState.screenshotFileId,
            jobId: jobId
          }, {
            timeout: 10000,
            headers: this.getAuthHeaders()
          });

          console.log(`✅ Page ${pageId} updated with screenshot`);
        }
      } catch (error) {
        console.error(`❌ Failed to upload screenshot: ${error.message}`);
        if (error.response) {
          console.error(`   Status: ${error.response.status}`);
          console.error(`   Response: ${JSON.stringify(error.response.data)}`);
        }
        if (error.request) {
          console.error(`   Request made but no response received`);
        }
      }
    }

    // Store result - storeStepResult will structure it according to schema
    const result = {
      screenshot_url: publicUrl || null,
      screenshot_file_id: fileId || null,
      screenshot_base64: uploaded ? null : screenshot.toString('base64'),
      size_bytes: screenshot.length,
      uploaded: uploaded
    };
    
    this.storeStepResult(step, result, workflowState);

    // Create screenshot attachment for display in job history
    const screenshotAttachments = [];
    if (uploaded && publicUrl) {
      // If uploaded, create attachment with reference to the uploaded file
      screenshotAttachments.push({
        type: 'screenshot',
        filename: `screenshot_${fileId || Date.now()}.png`,
        screenshot_id: fileId,
        screenshot_url: publicUrl,
        mimeType: 'image/png',
        size: screenshot.length,
        timestamp: new Date().toISOString()
      });
    } else if (screenshot) {
      // If not uploaded, include base64 screenshot data
      screenshotAttachments.push({
        type: 'screenshot',
        filename: `screenshot_${Date.now()}.png`,
        content: screenshot.toString('base64'),
        mimeType: 'image/png',
        size: screenshot.length,
        timestamp: new Date().toISOString()
      });
    }

    // Prepare metadata with all screenshot URL fields for UI detection
    // Construct screenshot URL - prefer publicUrl, fallback to backend /files endpoint
    let screenshotUrl = null;
    if (publicUrl) {
      screenshotUrl = publicUrl;
    } else if (fileId) {
      // fileId is the full object name (e.g., "screenshots/jobId/timestamp.png")
      // The /files/:objectName endpoint can handle this, but we need to URL encode it
      screenshotUrl = `${this.backendUrl}/files/${encodeURIComponent(fileId)}`;
    }
    
    const screenshotMetadata = {
      uploaded,
      fileId,
      fullPage,
      quality,
      size_bytes: screenshot.length,
      // Add all screenshot ID fields for UI detection
      screenshotId: fileId,
      screenshot_id: fileId,
      screenshotKey: fileId,
      screenshot_file_id: fileId,
      // Add all screenshot URL fields for UI detection
      screenshot_url: screenshotUrl,
      screenshotPath: screenshotUrl,
      screenshotUrl: screenshotUrl,
      isScreenshot: true // Flag to indicate this is a screenshot log
    };

    await this.logStepOutcome(
      step,
      jobId,
      uploaded
        ? `📸 [SCREENSHOT] Uploaded screenshot (${screenshot.length} bytes)`
        : `📸 [SCREENSHOT] Captured screenshot locally (${screenshot.length} bytes)`,
      screenshotMetadata,
      'info',
      screenshotAttachments
    );
  }

  /**
   * Execute browser-config step - Configures browser settings (viewport, user agent, mobile emulation, etc.)
   */
  async executeBrowserConfigStep(page, step, workflowState, jobId) {
    console.log(`🌐 Executing browser-config step (${step.name || step.id})`);
    
    const config = step.config || {};
    
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
      if (browserConfig.viewport && browserConfig.viewport.width && browserConfig.viewport.height) {
        await page.setViewportSize(browserConfig.viewport);
        console.log(`🌐 Viewport set to ${browserConfig.viewport.width}x${browserConfig.viewport.height}`);
        
        if (jobId && this.backendLogger) {
          await this.backendLogger.appendJobLog(jobId, 'info', 
            `🌐 Viewport configured: ${browserConfig.viewport.width}x${browserConfig.viewport.height}`,
            'WORKFLOW-ANALYZER',
            { browserConfig: { viewport: browserConfig.viewport } }
          );
        }
      }
      
      // Apply user agent via context and page evaluation
      if (browserConfig.userAgent && browserConfig.userAgent.trim()) {
        const context = page.context();
        if (context) {
          // Set via extra HTTP headers
          await context.setExtraHTTPHeaders({
            'User-Agent': browserConfig.userAgent
          });
          
          // Override navigator.userAgent in page context
          await page.evaluate((ua) => {
            Object.defineProperty(navigator, 'userAgent', {
              get: () => ua,
              configurable: true
            });
          }, browserConfig.userAgent);
          
          console.log(`🌐 User agent set to: ${browserConfig.userAgent.substring(0, 50)}...`);
          
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'info',
              `🌐 User agent configured: ${browserConfig.userAgent.substring(0, 80)}...`,
              'WORKFLOW-ANALYZER',
              { browserConfig: { userAgent: browserConfig.userAgent } }
            );
          }
        }
      }
      
      // Apply mobile emulation if needed
      if (browserConfig.isMobile) {
        const context = page.context();
        if (context) {
          // Add init script to set maxTouchPoints for mobile emulation
          await context.addInitScript(() => {
            Object.defineProperty(navigator, 'maxTouchPoints', {
              get: () => 5,
              configurable: true
            });
          });
          console.log(`🌐 Mobile emulation enabled (maxTouchPoints: 5)`);
          
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'info',
              `🌐 Mobile emulation enabled`,
              'WORKFLOW-ANALYZER',
              { browserConfig: { isMobile: true, hasTouch: browserConfig.hasTouch } }
            );
          }
        }
      }
      
      // Store config in workflow state for future reference
      if (!workflowState.browserConfig) {
        workflowState.browserConfig = {};
      }
      Object.assign(workflowState.browserConfig, browserConfig);
      
      // Log step outcome
      await this.logStepOutcome(
        step,
        jobId,
        `🌐 Browser configured: ${browserConfig.viewport.width}x${browserConfig.viewport.height}${browserConfig.isMobile ? ' (mobile)' : ''}${browserConfig.userAgent ? ' with custom UA' : ''}`,
        { browserConfig }
      );
      
      console.log(`✅ Browser configuration applied successfully`);
    } catch (error) {
      console.error(`❌ Browser config error: ${error.message}`);
      if (jobId && this.backendLogger) {
        await this.backendLogger.appendJobLog(jobId, 'error',
          `❌ Browser configuration failed: ${error.message}`,
          'WORKFLOW-ANALYZER',
          { step_id: step.id, error: error.message, error_stack: error.stack }
        );
      }
      throw error; // Re-throw to fail workflow if browser config is critical
    }
  }

  /**
   * Execute Playwright analysis step
   */
  async executePlaywrightAnalysisStep(page, step, workflowState, jobId) {
    console.log(`🔍 Performing Playwright analysis (${step.name})`);
    
    // CRITICAL: Preserve existing interactive_elements if they exist and new analysis has fewer
    // This prevents form fields from being lost when analysis runs multiple times
    const existingIECount = workflowState.playwrightAnalysis?.interactive_elements?.length || 0;
    
    const analysis = await this.performPlaywrightAnalysis(page);
    
    // If we had more interactive elements before and new analysis has fewer, preserve the existing ones
    // This handles the case where form fields were added in a previous run
    if (existingIECount > 0 && analysis.interactive_elements.length < existingIECount) {
      console.log(`⚠️ New analysis has fewer interactive elements (${analysis.interactive_elements.length} vs ${existingIECount}). Preserving existing interactive_elements.`);
      analysis.interactive_elements = workflowState.playwrightAnalysis.interactive_elements;
    }
    
    workflowState.playwrightAnalysis = analysis;
    
    // Store result - storeStepResult will structure it according to schema
    // But we need to pass the raw analysis object so structureResultWithNamespaces can properly format it
    this.storeStepResult(step, analysis, workflowState);

    const metadata = {
      forms_count: analysis.forms.length,
      links_count: analysis.links.length,
      interactive_count: analysis.interactive_elements.length,
      non_interactive_count: analysis.non_interactive_elements.length
    };

    if (analysis.forms.length > 0) {
      metadata.sample_forms = analysis.forms.slice(0, 3).map(form => form.selector || form.action || 'unknown-form');
    }
    if (analysis.links.length > 0) {
      metadata.sample_links = analysis.links.slice(0, 3).map(link => link.href || link.text || 'unknown-link');
    }
    if (analysis.interactive_elements.length > 0) {
      metadata.sample_interactive = analysis.interactive_elements.slice(0, 3).map(el => el.selector || el.text || el.type || 'interactive');
    }

    await this.logStepOutcome(
      step,
      jobId,
      `📊 [PLAYWRIGHT] Found ${analysis.forms.length} forms, ${analysis.links.length} links, ${analysis.interactive_elements.length} interactive elements, ${analysis.non_interactive_elements.length} non-interactive elements`,
      metadata
    );
    
    // CRITICAL: Log forms being stored to verify they're preserved
    if (analysis.forms.length > 0) {
      console.log(`✅ Stored ${analysis.forms.length} form(s) in workflowState.playwrightAnalysis.forms`);
      analysis.forms.forEach((form, idx) => {
        console.log(`  Form ${idx + 1}: selector="${form.selector}", fields=${form.fields?.length || 0}, buttons=${form.buttons?.length || 0}`);
      });
    } else {
      console.log(`⚠️ WARNING: No forms found in Playwright analysis for ${workflowState.pageUrl || 'unknown page'}`);
    }
    
    // CRITICAL: Save data directly to DB - each step saves its own data
    // This replaces the deprecated "save-data" step type
    if (workflowState.pageId && workflowState.projectId) {
      try {
        await this.updatePageDiscovery(
          jobId,
          workflowState.pageId,
          workflowState.projectId,
          workflowState.pageUrl,
          {
            // Always save forms/interactive_elements - use Array.isArray to handle empty arrays correctly
            forms: Array.isArray(analysis.forms) ? analysis.forms : [],
            links: Array.isArray(analysis.links) ? analysis.links : [],
            interactive_elements: Array.isArray(analysis.interactive_elements) ? analysis.interactive_elements : [],
            non_interactive_elements: Array.isArray(analysis.non_interactive_elements) ? analysis.non_interactive_elements : []
          }
        );
        console.log(`✅ Playwright analysis data saved directly to page: ${analysis.forms.length} forms, ${analysis.interactive_elements.length} interactive elements`);
      } catch (saveError) {
        console.warn(`⚠️ Failed to save playwright analysis data: ${saveError.message}`);
        // Don't fail the workflow if save fails
      }
    }
  }

  resolveStepContext(step, stepContext, fallbackSiblings = null) {
    const info = {
      stepIndex: null,
      siblings: Array.isArray(fallbackSiblings) ? fallbackSiblings : null,
      nextStep: null
    };

    if (typeof stepContext === 'number') {
      info.stepIndex = stepContext;
    } else if (stepContext && typeof stepContext === 'object') {
      if (typeof stepContext.stepIndex === 'number') {
        info.stepIndex = stepContext.stepIndex;
      }
      if (Array.isArray(stepContext.siblings)) {
        info.siblings = stepContext.siblings;
      }
      if (stepContext.nextStep) {
        info.nextStep = stepContext.nextStep;
      }
    }

    if (!Array.isArray(info.siblings) && Array.isArray(this.workflowTemplate?.steps)) {
      info.siblings = this.workflowTemplate.steps;
    }

    if (Array.isArray(fallbackSiblings) && (!Array.isArray(info.siblings) || info.siblings.length === 0)) {
      info.siblings = fallbackSiblings;
    }

    if (Array.isArray(info.siblings) && info.siblings.length > 0) {
      if (info.stepIndex === null || info.stepIndex < 0) {
        const derivedIndex = info.siblings.findIndex(candidate => {
          if (!candidate) return false;
          if (candidate === step) return true;
          if (candidate.id && step.id && candidate.id === step.id) return true;
          if (candidate.name && step.name && candidate.name === step.name) return true;
          return false;
        });
        if (derivedIndex !== -1) {
          info.stepIndex = derivedIndex;
        }
      }

      if (!info.nextStep && info.stepIndex !== null && info.stepIndex >= 0) {
        info.nextStep = info.siblings[info.stepIndex + 1] || null;
      }
    }

    return {
      ...info,
      requirementText: getRequirementTextForNextStep(info.nextStep)
    };
  }

  /**
   * Execute page description step
   */
  async executePageDescriptionStep(page, step, workflowState, jobId, stepContext = null) {
    console.log(`📝 Generating page description (${step.name})`);
    
    // Define formsCount early so it's available throughout the function
    const formsCount = workflowState.playwrightAnalysis?.forms?.length || 0;
    
    // Get page title and content if not already collected
    if (!workflowState.pageTitle) {
      workflowState.pageTitle = await page.title();
    }
    if (!workflowState.htmlContent) {
      workflowState.htmlContent = await page.content();
    }
    if (!workflowState.visibleText) {
      workflowState.visibleText = await page.evaluate(() => {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: function(node) {
              const parent = node.parentElement;
              if (!parent) return NodeFilter.FILTER_REJECT;
              const style = window.getComputedStyle(parent);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                return NodeFilter.FILTER_REJECT;
              }
              const text = node.textContent?.trim();
              if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            }
          }
        );
        
        const textNodes = [];
        let node;
        while (node = walker.nextNode()) {
          textNodes.push(node.textContent.trim());
        }
        
        return textNodes.join(' ').replace(/\s+/g, ' ').trim().substring(0, 2000);
      });
    }
    
    // Prompt template MUST be embedded directly in step config
    const customTemplate = step.config?.template || step.config?.user_message_template || null;
    
    if (!customTemplate) {
      throw new Error(`No embedded prompt template found in workflow step "${step.name || step.id}". All prompts must be embedded in workflow step configs.`);
    }
    
    const promptIdentifier = step.id || step.name || 'page-description';
    const promptSource = 'workflow-step';
    const contextInfo = this.resolveStepContext(step, stepContext, this.workflowTemplate?.steps);
    const requirementText = contextInfo.requirementText;
    const decoratedTemplate = appendRequirementToTemplate(customTemplate, requirementText);
    const templateForExecution = this.enforceLegInstructionsInTemplate(decoratedTemplate);
    
    const descriptionPayload = {
      page_title: workflowState.pageTitle,
      page_url: workflowState.pageUrl,
      visible_text: workflowState.visibleText,
      additional_prompt_text: this.context.additional_prompt_text || ''
    };

    const attachments = Array.isArray(step.config?.attachments)
      ? step.config.attachments
      : [];

    if (attachments.includes('interactive_elements') && workflowState.playwrightAnalysis?.interactive_elements) {
      const interactiveElements = workflowState.playwrightAnalysis.interactive_elements.slice(0, 50);
      descriptionPayload.interactive_elements = interactiveElements;
      descriptionPayload.interactive_elements_json = JSON.stringify(interactiveElements, null, 2);
    }

    if (attachments.includes('forms')) {
      const formsCount = workflowState.playwrightAnalysis?.forms?.length || 0;
      console.log(`🔍 Forms attachment requested. Checking workflowState...`);
      console.log(`  playwrightAnalysis exists: ${!!workflowState.playwrightAnalysis}`);
      console.log(`  forms array exists: ${!!workflowState.playwrightAnalysis?.forms}`);
      console.log(`  forms count: ${formsCount}`);
      
      if (formsCount > 0) {
        const forms = workflowState.playwrightAnalysis.forms.slice(0, 30);
        descriptionPayload.forms = forms;
        descriptionPayload.forms_json = JSON.stringify(forms, null, 2);
        console.log(`✅ Including ${forms.length} form(s) in AI payload for page-description step`);
        if (jobId && this.backendLogger) {
          await this.backendLogger.appendJobLog(jobId, 'info', `📋 Passing ${forms.length} form(s) to AI for leg generation`, 'WORKFLOW-ANALYZER', {
            forms_count: forms.length,
            forms_sample: forms.slice(0, 3).map(f => ({ selector: f.selector, fields_count: f.fields?.length || 0, buttons_count: f.buttons?.length || 0 }))
          });
        }
      } else {
        console.log(`❌ CRITICAL: Forms attachment requested but no forms found!`);
        console.log(`  playwrightAnalysis structure: ${JSON.stringify(Object.keys(workflowState.playwrightAnalysis || {}))}`);
        if (jobId && this.backendLogger) {
          await this.backendLogger.appendJobLog(jobId, 'warn', `⚠️ CRITICAL: Forms attachment requested but workflowState.playwrightAnalysis.forms is empty (count: ${formsCount})`, 'WORKFLOW-ANALYZER', {
            playwrightAnalysis_keys: workflowState.playwrightAnalysis ? Object.keys(workflowState.playwrightAnalysis) : [],
            page_url: workflowState.pageUrl
          });
        }
      }
    }

    if (attachments.includes('links') && workflowState.playwrightAnalysis?.links) {
      const links = workflowState.playwrightAnalysis.links.slice(0, 40);
      descriptionPayload.links = links;
      descriptionPayload.links_json = JSON.stringify(links, null, 2);
    }

    if (attachments.includes('screenshot') && workflowState.screenshotBase64) {
      descriptionPayload.screenshot_base64 = workflowState.screenshotBase64;
      descriptionPayload.screenshot = workflowState.screenshotBase64;
    }
    
    // Always include full playwright_analysis if requested in attachments (for {{playwright_analysis}} template variable)
    if (attachments.includes('playwright_analysis') && workflowState.playwrightAnalysis) {
      descriptionPayload.playwright_analysis = workflowState.playwrightAnalysis;
      descriptionPayload.playwright_analysis_json = JSON.stringify(workflowState.playwrightAnalysis, null, 2);
    }
    
    // Log prompt usage with step information
    const currentStepIndex = contextInfo.stepIndex !== null ? contextInfo.stepIndex : (this.workflowTemplate?.steps?.findIndex(s => s.id === step.id || s.name === step.name) ?? -1);
    await this.logPromptUsage(promptIdentifier, promptSource, templateForExecution, descriptionPayload, {
      step: step,
      stepIndex: currentStepIndex >= 0 ? currentStepIndex : (this.workflowTemplate?.steps?.findIndex(s => s.type === step.type) ?? -1),
      totalSteps: this.workflowTemplate?.steps?.length
    });
    
    try {
      const aiResponse = await this.aiLogger.makeAICallWithPrompt(
        promptIdentifier,
        descriptionPayload,
        jobId,
        'page-descriptor',
        workflowState.pageUrl,
        null,
        descriptionPayload,
        templateForExecution // Pass decorated template (required - no fallback to database)
      );
      
      // Handle response structure: AI may return { page_summary: {...}, legs: [...] } or flat structure
      let pageDescriptionObj = aiResponse;
      let candidateLegs = [];
      
      // Check if response has nested page_summary structure
      if (aiResponse && typeof aiResponse === 'object' && aiResponse.page_summary) {
        // Extract page_summary and merge with top-level properties
        pageDescriptionObj = {
          ...aiResponse.page_summary,
          ...aiResponse
        };
        // Legs should be at top level even when page_summary is nested
        candidateLegs = Array.isArray(aiResponse.legs)
          ? aiResponse.legs
          : Array.isArray(aiResponse.actions)
            ? aiResponse.actions
            : [];
      } else {
        // Flat structure - legs might be directly in the response
        candidateLegs = Array.isArray(aiResponse?.legs)
          ? aiResponse.legs
          : Array.isArray(aiResponse?.actions)
            ? aiResponse.actions
            : [];
      }
      
      workflowState.pageDescription = pageDescriptionObj;
      
      // Log response structure for debugging
      const responseKeys = aiResponse && typeof aiResponse === 'object' ? Object.keys(aiResponse) : [];
      console.log(`🔍 AI response structure: keys=${responseKeys.join(', ')}, legs at top level: ${Array.isArray(aiResponse?.legs) ? aiResponse.legs.length : 'none'}, has page_summary: ${!!aiResponse?.page_summary}`);
      
      // Extract short_description with fallbacks (handle different response structures)
      const shortDescription = workflowState.pageDescription?.short_description ||
                               workflowState.pageDescription?.description ||
                               workflowState.pageDescription?.summary ||
                               workflowState.pageDescription?.short_summary ||
                               (workflowState.pageDescription && typeof workflowState.pageDescription === 'string' ? workflowState.pageDescription : null) ||
                               workflowState.pageTitle ||
                               'Page description generated';
      
      console.log(`✅ Page description generated: ${shortDescription}`);
      
      // Ensure pageDescription has short_description if it's missing
      if (workflowState.pageDescription && !workflowState.pageDescription.short_description) {
        workflowState.pageDescription.short_description = shortDescription;
      }
      
      // Log candidate legs before normalization
      if (candidateLegs.length > 0) {
        console.log(`🔍 Found ${candidateLegs.length} candidate legs from AI response`);
        // Log sample of legs to see if they have selectors
        const sampleLegs = candidateLegs.slice(0, 3);
        sampleLegs.forEach((leg, idx) => {
          const hasSelector = !!(leg.selector || leg.css_selector || leg.element_info?.selector);
          console.log(`  Leg ${idx + 1}: ${leg.description || leg.leg_id || 'unnamed'}, has selector: ${hasSelector}, selector: ${leg.selector || 'none'}`);
        });
      } else {
        console.log(`⚠️ No candidate legs found in AI response`);
        const formsCount = workflowState.playwrightAnalysis?.forms?.length || 0;
        if (formsCount > 0) {
          console.log(`⚠️ WARNING: Forms detected (${formsCount}) but no legs generated by AI`);
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'warn', `⚠️ CRITICAL: ${formsCount} form(s) detected but AI did not generate any legs. Forms data was passed to AI.`, 'WORKFLOW-ANALYZER', {
              forms_count: formsCount,
              forms_passed_to_ai: formsCount,
              ai_response_keys: aiResponse && typeof aiResponse === 'object' ? Object.keys(aiResponse) : [],
              page_url: workflowState.pageUrl
            });
          }
        }
      }

      let normalizedFromSummary = [];
      if (candidateLegs.length > 0) {
        normalizedFromSummary = await this.applyLegsToWorkflowState(candidateLegs, workflowState, 'page-summary');
        const filteredCount = candidateLegs.length - normalizedFromSummary.length;
        if (filteredCount > 0) {
          console.log(`⚠️ Filtered out ${filteredCount} legs (likely missing selectors or navigation legs)`);
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'warn', `⚠️ ${filteredCount} legs filtered out (missing selectors or navigation)`, 'WORKFLOW-ANALYZER', {
              candidate_legs: candidateLegs.length,
              valid_legs: normalizedFromSummary.length,
              filtered_out: filteredCount
            });
          }
        }
        
        if (normalizedFromSummary.length > 0) {
          workflowState.pageDescription.legs = normalizedFromSummary;
          if (!Array.isArray(workflowState.pageDescription.actions) || workflowState.pageDescription.actions.length === 0) {
            workflowState.pageDescription.actions = normalizedFromSummary;
          }
          // CRITICAL: Ensure legsToExecute is set for for-each step
          workflowState.legsToExecute = normalizedFromSummary;
          if (!workflowState.context) {
            workflowState.context = {};
          }
          workflowState.context.legsToExecute = normalizedFromSummary;
          
          // Save to variable pool for visibility and access
          this.initializeVariablePool(workflowState);
          this.saveVariable(workflowState, 'legsToExecute', normalizedFromSummary, 'page', null);
          this.saveVariable(workflowState, 'legs', normalizedFromSummary, 'page', null);
          
          console.log(`✅ Page summary included ${normalizedFromSummary.length} legs (legsToExecute set and saved to variable pool)`);
          
          // CRITICAL: Workflows must be created explicitly by the user, not auto-created
          // If no workflow exists, log a warning and skip saving legs
          if (normalizedFromSummary.length > 0) {
            if (!workflowState.workflowId) {
              console.warn(`⚠️ [PAGE-DESCRIPTION] No workflow_id available. Workflows must be created explicitly by the user. Skipping leg persistence.`);
              console.warn(`⚠️ [PAGE-DESCRIPTION] To save legs, create a workflow first via the API or UI.`);
            }
          }
          
          // CRITICAL: Save legs immediately to workflow database so they're visible right away
          if (normalizedFromSummary.length > 0 && workflowState.workflowId) {
            try {
              await this.saveLegIterationsToWorkflow(workflowState, normalizedFromSummary, jobId);
              console.log(`💾 Immediately saved ${normalizedFromSummary.length} action(s) to workflow ${workflowState.workflowId}`);
              if (jobId && this.backendLogger) {
                await this.backendLogger.appendJobLog(jobId, 'info', `💾 Saved ${normalizedFromSummary.length} action(s) to workflow immediately after discovery`, 'WORKFLOW-ANALYZER', {
                  total_legs: normalizedFromSummary.length,
                  workflow_id: workflowState.workflowId
                });
              }
            } catch (saveError) {
              console.warn(`⚠️ Failed to immediately save legs: ${saveError.message}`);
            }
          } else if (normalizedFromSummary.length > 0 && !workflowState.workflowId) {
            console.log(`⏳ ${normalizedFromSummary.length} legs collected but workflowId not yet available - will save when workflow is created`);
          }
        } else {
          console.log(`⚠️ All ${candidateLegs.length} candidate legs were filtered out during normalization`);
          const formsCount = workflowState.playwrightAnalysis?.forms?.length || 0;
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'warn', `⚠️ All ${candidateLegs.length} legs filtered out - likely missing selectors${formsCount > 0 ? ` (${formsCount} form(s) detected but no valid legs)` : ''}`, 'WORKFLOW-ANALYZER', {
              candidate_legs: candidateLegs.length,
              forms_detected: formsCount,
              interactive_elements: workflowState.playwrightAnalysis?.interactive_elements?.length || 0
            });
          }
        }
      } else {
        // No candidate legs at all - log warning if forms/interactive elements exist
        // formsCount already defined at function start
        const interactiveCount = workflowState.playwrightAnalysis?.interactive_elements?.length || 0;
        if (formsCount > 0 || interactiveCount > 0) {
          console.log(`⚠️ WARNING: Page has ${formsCount} form(s) and ${interactiveCount} interactive element(s), but AI did not generate any legs`);
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'warn', `⚠️ AI did not generate legs despite ${formsCount} form(s) and ${interactiveCount} interactive element(s) on page`, 'WORKFLOW-ANALYZER', {
              forms_detected: formsCount,
              interactive_elements: interactiveCount,
              page_url: workflowState.pageUrl
            });
          }
        }
      }
      
      // Add to conversation history
      workflowState.conversationHistory.push({
        timestamp: new Date().toISOString(),
        action: 'page-description-generated',
        description: shortDescription
      });
      

      
      // Log page description to job history
      await this.logPageDescription(jobId, workflowState.pageUrl, workflowState.pageTitle, workflowState.pageDescription, {
        visible_text_length: workflowState.visibleText.length,
        forms_count: formsCount,
        interactive_elements_count: workflowState.playwrightAnalysis?.interactive_elements?.length || 0,
        legs_count: (workflowState.pageDescription?.legs || normalizedFromSummary || []).length
      }, workflowState.htmlContent, workflowState.screenshotBase64);

      this.storeStepResult(step, {
        description: workflowState.pageDescription,
        legs: workflowState.pageDescription?.legs || normalizedFromSummary || [],
        visible_text_length: workflowState.visibleText.length,
        attachments: step.config?.attachments || []
      }, workflowState);

      workflowState.aiAnalysisResult = workflowState.aiAnalysisResult || {};
      workflowState.aiAnalysisResult.page_description = workflowState.pageDescription;
      if (normalizedFromSummary.length > 0) {
        workflowState.aiAnalysisResult.legs = normalizedFromSummary;
        workflowState.aiAnalysisResult.source = 'page-summary';
      } else if (workflowState.legs && workflowState.legs.length > 0) {
        // Include fallback legs in aiAnalysisResult
        workflowState.aiAnalysisResult.legs = workflowState.legs;
        workflowState.aiAnalysisResult.source = 'playwright-fallback';
      }

      // Log summary for page-description step
      const finalLegsCount = (workflowState.pageDescription?.legs || normalizedFromSummary || workflowState.legs || []).length;
      let pageDescSummary = `📄 Page analyzed: ${shortDescription}`;
      if (finalLegsCount > 0) {
        pageDescSummary += ` • Found ${finalLegsCount} action(s)`;
      } else if (formsCount > 0) {
        pageDescSummary += ` • ${formsCount} form(s) detected but no testable actions found`;
      }
      if (jobId && this.backendLogger) {
        await this.backendLogger.appendJobLog(jobId, 'info', pageDescSummary, 'WORKFLOW-ANALYZER', {
          step_id: step.id,
          step_name: step.name || step.id,
          short_description: shortDescription,
          legs_count: finalLegsCount,
          forms_detected: formsCount,
          workflow_id: workflowState.workflowId,
          legs_source: workflowState.aiAnalysisResult?.source || 'ai'
        });
      }
      
      await this.logStepOutcome(
        step,
        jobId,
        `📝 [PAGE-DESCRIPTION] Generated summary: ${shortDescription}${finalLegsCount > 0 ? ` • Found ${finalLegsCount} action(s)` : formsCount > 0 ? ` • ${formsCount} form(s) detected` : ''}`,
        {
          short_description: shortDescription,
          attachments: step.config?.attachments || [],
          visible_text_length: workflowState.visibleText.length,
          legs_count: finalLegsCount,
          forms_detected: formsCount,
          workflow_id: workflowState.workflowId,
          legs_source: workflowState.aiAnalysisResult?.source || 'ai'
        }
      );
      
    } catch (error) {
      console.error(`❌ Failed to generate page description: ${error.message}`);
      console.error(`❌ Error stack:`, error.stack);
      
      await this.logStepOutcome(
        step,
        jobId,
        `❌ [PAGE-DESCRIPTION] Failed to generate page description: ${error.message}`,
        {
          error: error.message,
          error_stack: error.stack,
          step_id: step.id,
          step_name: step.name,
          step_type: step.type
        },
        'error'
      );
      
      // CRITICAL: No fallbacks - throw the error
      throw new Error(`Page description generation failed: ${error.message}`);
    }
  }

  /**
   * Execute AI prompt step
   */
  async executeAIPromptStep(page, step, workflowState, jobId, stepContext = null) {
    // CRITICAL: Log function entry to verify it's being called
    console.log(`🔍 [EXECUTE-AI-PROMPT-STEP] Function called for step ${step.id} (${step.name})`);
    if (jobId && this.backendLogger) {
      await this.backendLogger.appendJobLog(jobId, 'info', `🔍 [EXECUTE-AI-PROMPT-STEP] Function called for step ${step.id}`, 'WORKFLOW-ANALYZER', {
        step_id: step.id,
        step_name: step.name,
        step_type: step.type
      });
    }
    console.log(`🤖 Executing AI prompt (${step.name})`);
    
    // Prompt template MUST be embedded directly in step config, not fetched from database
    const customTemplate = step.config?.template || step.config?.user_message_template || null;
    const systemMessage = step.config?.system_message || step.config?.system_message_template || null;
    const responseSchema = step.config?.response_schema || null;
    
    if (!customTemplate) {
      throw new Error(`No embedded prompt template found in workflow step "${step.name || step.id}". All prompts must be embedded in workflow step configs.`);
    }
    
    const promptIdentifier = step.id || step.name || 'workflow-step';
    const promptSource = 'workflow-step';
    const contextInfo = this.resolveStepContext(step, stepContext, this.workflowTemplate?.steps);
    const requirementText = contextInfo.requirementText;
    const decoratedTemplate = appendRequirementToTemplate(customTemplate, requirementText);
    
    // Prepare payload based on step configuration
    const stepPayload = {
      page_url: workflowState.pageUrl,
      page_title: workflowState.pageTitle || await page.title(),
      page_content: workflowState.htmlContent || await page.content(),
      additional_prompt_text: this.context.additional_prompt_text || ''
    };
    // CRITICAL: Strict validation - credentials MUST be valid in workflowState.inputCredentials, no fallbacks
    if (workflowState.inputCredentials) {
      const creds = workflowState.inputCredentials;
      // Check if credentials are valid (not "MISSING" placeholders)
      // Only validate credentials if they're actually present
      // For crawl jobs, credentials may be null (optional)
      if (creds === null) {
        console.log(`ℹ️ No credentials available for this step (crawl job without login)`);
        // Don't add input_credentials if null
      } else if (!creds.username || !creds.password ||
          creds.username === 'MISSING' || creds.username === 'missing' ||
          creds.password === 'MISSING' || creds.password === 'missing') {
        // Only throw error for login jobs
        const isLoginJob = this.context?.jobType === 'login' || 
                          this.context?.job_type === 'login' ||
                          this.context?.isLoginJob === true;
        if (isLoginJob) {
          console.error(`❌ ERROR: inputCredentials contains "MISSING" placeholder values!`);
          console.error(`inputCredentials:`, creds);
          throw new Error('Credentials in workflowState.inputCredentials must not contain placeholder values');
        } else {
          console.log(`ℹ️ Credentials invalid but not required (crawl job) - skipping`);
        }
      } else {
        stepPayload.input_credentials = creds;
      }
    }
    
    // Add workflow context information (always available)
    if (workflowState.workflowId) {
      stepPayload.workflow_id = workflowState.workflowId;
    }
    if (workflowState.jobId) {
      stepPayload.job_id = workflowState.jobId;
    }
    if (workflowState.pageId) {
      stepPayload.page_id = workflowState.pageId;
    }
    if (workflowState.projectId) {
      stepPayload.project_id = workflowState.projectId;
    }
    
    // Add workflow execution context
    if (workflowState.legs && Array.isArray(workflowState.legs) && workflowState.legs.length > 0) {
      stepPayload.workflow_legs = workflowState.legs;
      stepPayload.total_legs = workflowState.legs.length;
    }
    if (workflowState.legResults && Array.isArray(workflowState.legResults) && workflowState.legResults.length > 0) {
      stepPayload.leg_results = workflowState.legResults;
      stepPayload.completed_legs = workflowState.legResults.length;
    }
    if (workflowState.legsToExecute && Array.isArray(workflowState.legsToExecute) && workflowState.legsToExecute.length > 0) {
      stepPayload.legs_to_execute = workflowState.legsToExecute;
      stepPayload.legsToExecute = workflowState.legsToExecute; // CRITICAL: Add camelCase version for template variable resolution
      stepPayload.pending_legs = workflowState.legsToExecute.length;
    }
    
    // CRITICAL: Also add journeysToExecute as legsToExecute if journeys exist but legsToExecute doesn't
    // This ensures the "Justify Journeys" step receives the journeys data
    if ((!workflowState.legsToExecute || workflowState.legsToExecute.length === 0) && 
        workflowState.journeysToExecute && Array.isArray(workflowState.journeysToExecute) && workflowState.journeysToExecute.length > 0) {
      // Convert journeys to legs format for template compatibility
      const journeysAsLegs = workflowState.journeysToExecute.map(journey => ({
        leg_id: journey.journey_id,
        description: journey.description,
        test_instructions: journey.test_instructions,
        expected_outcome: journey.expected_outcome,
        actions: journey.actions || [],
        journey_id: journey.journey_id // Preserve journey_id for reference
      }));
      stepPayload.legs_to_execute = journeysAsLegs;
      stepPayload.legsToExecute = journeysAsLegs; // CRITICAL: Add camelCase version for template variable resolution
      stepPayload.pending_legs = journeysAsLegs.length;
      console.log(`🔄 [JUSTIFY-JOURNEYS] Converted ${workflowState.journeysToExecute.length} journey(s) to legs format for template`);
    }
    
    // Add journeysToExecute directly if available (for reference)
    if (workflowState.journeysToExecute && Array.isArray(workflowState.journeysToExecute) && workflowState.journeysToExecute.length > 0) {
      stepPayload.journeysToExecute = workflowState.journeysToExecute;
      stepPayload.journeys_to_execute = workflowState.journeysToExecute;
    }
    
    // Add current leg context
    if (workflowState.currentLeg) {
      stepPayload.current_leg = workflowState.currentLeg;
    }
    if (workflowState.currentLegIndex !== undefined && workflowState.currentLegIndex !== null) {
      stepPayload.current_leg_index = workflowState.currentLegIndex;
    }

    // Add current journey context (for journey-based templates)
    if (workflowState.currentJourney || workflowState.currentItem) {
      const currentJourney = workflowState.currentJourney || workflowState.currentItem;
      
      // CRITICAL: Filter out verify/check actions before passing to AI prompt
      // During execution, we only want interactive actions (clicks, fills, etc.)
      // Verifications should NOT be executed - they are for analysis only
      let filteredJourney = { ...currentJourney };
      if (currentJourney.actions && Array.isArray(currentJourney.actions)) {
        filteredJourney.actions = currentJourney.actions.filter(action => {
          const actionType = (action.type || '').toLowerCase();
          return actionType !== 'verify' && actionType !== 'check';
        });
        console.log(`[WorkflowAnalyzer] Filtered journey actions: ${currentJourney.actions.length} -> ${filteredJourney.actions.length} (removed verify/check actions)`);
      }
      
      stepPayload.currentJourney = filteredJourney;
      stepPayload.current_journey = filteredJourney;
    }
    
    // For while-loop iterations: include iteration/step id only. Do NOT set conversation_key: backend returns 404 if id is not an existing conversation, so omit to let backend create new conversation and avoid log errors.
    if (workflowState.currentIteration !== undefined && workflowState.currentIteration !== null) {
      stepPayload.current_iteration = workflowState.currentIteration;
      stepPayload.step_request_id = step.id || `${step.name || 'step'}_${workflowState.currentIteration}`;
    }

    // Add execution history
    if (workflowState.executionHistory && Array.isArray(workflowState.executionHistory) && workflowState.executionHistory.length > 0) {
      stepPayload.execution_history = workflowState.executionHistory;
    }
    if (workflowState.lastExecutionResult) {
      stepPayload.last_execution_result = workflowState.lastExecutionResult;
      stepPayload.execution_result = workflowState.lastExecutionResult;
    }
    
    // Add previous step results summary
    if (workflowState.results && typeof workflowState.results === 'object') {
      const stepResultsSummary = {};
      for (const [stepId, result] of Object.entries(workflowState.results)) {
        if (result && typeof result === 'object') {
          // Include a summary of each step's result
          stepResultsSummary[stepId] = {
            has_result: true,
            result_type: typeof result,
            keys: Object.keys(result).slice(0, 10), // Limit to first 10 keys
            preview: JSON.stringify(result).substring(0, 200) // Preview of result
          };
        }
      }
      if (Object.keys(stepResultsSummary).length > 0) {
        stepPayload.previous_step_results = stepResultsSummary;
      }
    }
    
    // Add shared context/variables
    if (workflowState.context && typeof workflowState.context === 'object') {
      const contextSummary = {};
      for (const [key, value] of Object.entries(workflowState.context)) {
        if (value !== undefined && value !== null) {
          const valueType = typeof value;
          if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
            contextSummary[key] = value;
          } else if (Array.isArray(value)) {
            contextSummary[key] = {
              type: 'array',
              length: value.length,
              preview: value.slice(0, 5) // First 5 items
            };
          } else if (valueType === 'object') {
            contextSummary[key] = {
              type: 'object',
              keys: Object.keys(value).slice(0, 10),
              preview: JSON.stringify(value).substring(0, 200)
            };
          }
        }
      }
      if (Object.keys(contextSummary).length > 0) {
        stepPayload.shared_context = contextSummary;
      }
    }
    
    // Add page description if available
    if (workflowState.pageDescription) {
      stepPayload.page_description = workflowState.pageDescription;
    }
    if (workflowState.aiAnalysisResult) {
      stepPayload.ai_analysis_result = workflowState.aiAnalysisResult;
    }
    
    // Add URL tracking (fallback to pageUrl so {{url_before_action}}/{{url_after_action}} are always substituted)
    const currentPageUrl = workflowState.pageUrl || workflowState.currentUrl || (typeof page?.url === 'function' ? page.url() : null);
    stepPayload.url_before_action = workflowState.urlBeforeAction || currentPageUrl || stepPayload.page_url || '';
    stepPayload.before_url = stepPayload.url_before_action;
    stepPayload.url_after_action = workflowState.urlAfterAction || currentPageUrl || stepPayload.page_url || '';
    stepPayload.after_url = stepPayload.url_after_action;
    if (workflowState.currentUrl) {
      stepPayload.current_url = workflowState.currentUrl;
    }
    
    // Add screenshot information if available
    // CRITICAL: Use screenshot_base64 (not screenshot) to match what AI conversation logger expects
    if (workflowState.screenshotBase64) {
      stepPayload.screenshot_base64 = workflowState.screenshotBase64;
      stepPayload.screenshot = workflowState.screenshotBase64; // Also keep for backward compatibility
    }
    if (workflowState.screenshotUrl) {
      stepPayload.screenshot_url = workflowState.screenshotUrl;
    }
    
    // CRITICAL: Automatically collect requested attachments if not already in workflowState
    // This allows AI Prompt steps to collect data on-demand without requiring separate steps
    const requestedAttachments = Array.isArray(step.config?.attachments) ? step.config.attachments : [];
    
    if (requestedAttachments.length > 0) {
      console.log(`📦 [AI-PROMPT] Collecting ${requestedAttachments.length} attachment(s) for step "${step.name || step.id}"`);
      
      // Collect visible_text if requested and not already available
      if (requestedAttachments.includes('visible_text') && !workflowState.visibleText) {
        console.log(`📝 [AI-PROMPT] Collecting visible_text...`);
        try {
          workflowState.visibleText = await page.evaluate(() => {
            const walker = document.createTreeWalker(
              document.body,
              NodeFilter.SHOW_TEXT,
              {
                acceptNode: function(node) {
                  const parent = node.parentElement;
                  if (!parent) return NodeFilter.FILTER_REJECT;
                  const style = window.getComputedStyle(parent);
                  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                    return NodeFilter.FILTER_REJECT;
                  }
                  const text = node.textContent?.trim();
                  if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;
                  return NodeFilter.FILTER_ACCEPT;
                }
              }
            );
            
            const textNodes = [];
            let node;
            while (node = walker.nextNode()) {
              textNodes.push(node.textContent.trim());
            }
            
            return textNodes.join(' ').replace(/\s+/g, ' ').trim().substring(0, 2000);
          });
          
          const textLength = workflowState.visibleText?.length || 0;
          console.log(`✅ [AI-PROMPT] Collected visible_text (${textLength} characters)`);
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'info', `📝 [AI-PROMPT] Collected visible_text (${textLength} characters)`, 'WORKFLOW-ANALYZER', {
              attachment_type: 'visible_text',
              text_length: textLength
            });
          }
        } catch (error) {
          console.error(`❌ [AI-PROMPT] Failed to collect visible_text: ${error.message}`);
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'error', `❌ [AI-PROMPT] Failed to collect visible_text: ${error.message}`, 'WORKFLOW-ANALYZER', {
              attachment_type: 'visible_text',
              error: error.message
            });
          }
        }
      }
      
      // AUTO-RUN: Collect playwright_analysis if requested in attachments but not yet available
      // This allows workflows to use playwright_analysis in attachments without an explicit playwright-analysis step
      // The simplified workflow uses this: it has "playwright_analysis" in attachments but no explicit step
      const needsPlaywrightAnalysis = requestedAttachments.includes('interactive_elements') || 
                                      requestedAttachments.includes('playwright_analysis') ||
                                      requestedAttachments.includes('forms');
      
      if (needsPlaywrightAnalysis && !workflowState.playwrightAnalysis) {
        console.log(`🔍 [AI-PROMPT] Auto-collecting playwright_analysis (requested in attachments but no explicit step found)...`);
        try {
          await this.executePlaywrightAnalysisStep(page, {
            id: `${step.id}_auto_playwright_analysis`,
            name: `Auto Playwright Analysis (for ${step.name || step.id})`,
            type: 'playwright-analysis',
            config: { 
              collectForms: true, 
              collectLinks: true, 
              collectInteractiveElements: true 
            }
          }, workflowState, jobId);
          
          const analysis = workflowState.playwrightAnalysis || {};
          const formsCount = analysis.forms?.length || 0;
          const linksCount = analysis.links?.length || 0;
          const interactiveCount = analysis.interactive_elements?.length || 0;
          
          console.log(`✅ [AI-PROMPT] Collected playwright_analysis (${formsCount} forms, ${linksCount} links, ${interactiveCount} interactive elements)`);
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'info', `🔍 [AI-PROMPT] Collected playwright_analysis (${formsCount} forms, ${linksCount} links, ${interactiveCount} interactive elements)`, 'WORKFLOW-ANALYZER', {
              attachment_type: 'playwright_analysis',
              forms_count: formsCount,
              links_count: linksCount,
              interactive_elements_count: interactiveCount
            });
          }
        } catch (error) {
          console.error(`❌ [AI-PROMPT] Failed to collect playwright_analysis: ${error.message}`);
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'error', `❌ [AI-PROMPT] Failed to collect playwright_analysis: ${error.message}`, 'WORKFLOW-ANALYZER', {
              attachment_type: 'playwright_analysis',
              error: error.message
            });
          }
        }
      }
      
      // Collect screenshot if requested and not already available
      if (requestedAttachments.includes('screenshot') && !workflowState.screenshotBase64) {
        console.log(`📸 [AI-PROMPT] Collecting screenshot...`);
        try {
          await this.executeScreenshotStep(page, {
            id: `${step.id}_auto_screenshot`,
            name: `Auto Screenshot (for ${step.name || step.id})`,
            type: 'screenshot',
            config: { 
              fullPage: true, 
              quality: 90,
              upload: true
            }
          }, workflowState, jobId, workflowState.pageId);
          
          const screenshotSize = workflowState.screenshotBase64 ? Buffer.from(workflowState.screenshotBase64, 'base64').length : 0;
          console.log(`✅ [AI-PROMPT] Collected screenshot (${screenshotSize} bytes)`);
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'info', `📸 [AI-PROMPT] Collected screenshot (${screenshotSize} bytes)`, 'WORKFLOW-ANALYZER', {
              attachment_type: 'screenshot',
              size_bytes: screenshotSize,
              screenshot_url: workflowState.screenshotUrl || null
            });
          }
        } catch (error) {
          console.error(`❌ [AI-PROMPT] Failed to collect screenshot: ${error.message}`);
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'error', `❌ [AI-PROMPT] Failed to collect screenshot: ${error.message}`, 'WORKFLOW-ANALYZER', {
              attachment_type: 'screenshot',
              error: error.message
            });
          }
        }
      }
      
      // Collect page_description if requested and not already available
      if (requestedAttachments.includes('page_description') && !workflowState.pageDescription) {
        console.log(`📝 [AI-PROMPT] Collecting page_description...`);
        try {
          // Use a page description step with visual/context attachments for accuracy
          await this.executePageDescriptionStep(page, {
            id: `${step.id}_auto_page_description`,
            name: `Auto Page Description (for ${step.name || step.id})`,
            type: 'page-description',
            config: {
              template: step.config?.page_description_template || 'Describe this page in detail, including its purpose, main content, and interactive elements.',
              attachments: ['visible_text', 'interactive_elements', 'screenshot']
            }
          }, workflowState, jobId);
          
          const description = workflowState.pageDescription?.short_description || 
                             workflowState.pageDescription?.description || 
                             'Page description generated';
          const descLength = description.length;
          console.log(`✅ [AI-PROMPT] Collected page_description (${descLength} characters)`);
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'info', `📝 [AI-PROMPT] Collected page_description (${descLength} characters): ${description.substring(0, 100)}...`, 'WORKFLOW-ANALYZER', {
              attachment_type: 'page_description',
              description_length: descLength
            });
          }
        } catch (error) {
          console.error(`❌ [AI-PROMPT] Failed to collect page_description: ${error.message}`);
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'error', `❌ [AI-PROMPT] Failed to collect page_description: ${error.message}`, 'WORKFLOW-ANALYZER', {
              attachment_type: 'page_description',
              error: error.message
            });
          }
        }
      }
      
      console.log(`✅ [AI-PROMPT] Finished collecting attachments for step "${step.name || step.id}"`);
    }
    
    // Add additional data based on step attachments (these are explicitly requested)
    if (step.config?.attachments) {
      if (step.config.attachments.includes('visible_text') && workflowState.visibleText) {
        stepPayload.visible_text = workflowState.visibleText;
      }
      if (step.config.attachments.includes('interactive_elements') && workflowState.playwrightAnalysis) {
        // CRITICAL: Use interactive_elements from playwrightAnalysis, ensuring form fields are included
        const interactiveElements = workflowState.playwrightAnalysis.interactive_elements || [];
        stepPayload.interactive_elements = interactiveElements;
        
        // Log for debugging - CRITICAL for troubleshooting
        console.log(`📤 AI Step: Sending ${interactiveElements.length} interactive elements to AI (step: ${step.name || step.id})`);
        if (interactiveElements.length > 0) {
          console.log(`   Sample elements: ${interactiveElements.slice(0, 3).map(el => `${el.type}(${el.name || el.id || 'unnamed'})`).join(', ')}`);
        }
        if (interactiveElements.length === 0 && workflowState.playwrightAnalysis.forms?.length > 0) {
          console.error(`❌ ERROR: Interactive elements array is empty but ${workflowState.playwrightAnalysis.forms.length} form(s) found!`);
          console.error(`   Form fields should have been added to interactive_elements. This is a bug.`);
          // Try to recover by adding form fields on the fly
          const forms = workflowState.playwrightAnalysis.forms || [];
          const recoveredElements = [];
          for (const form of forms) {
            if (form.fields) {
              for (const field of form.fields) {
                recoveredElements.push({
                  type: field.type || 'input',
                  name: field.name || '',
                  id: field.id || '',
                  selector: field.selector || (field.id ? `#${field.id}` : (field.name ? `[name="${field.name}"]` : null))
                });
              }
            }
          }
          if (recoveredElements.length > 0) {
            console.log(`   🔧 Recovered ${recoveredElements.length} form fields and adding to payload`);
            stepPayload.interactive_elements = recoveredElements;
          }
        }
      }
      if (step.config.attachments.includes('forms') && workflowState.playwrightAnalysis) {
        stepPayload.forms = workflowState.playwrightAnalysis.forms;
      }
      if (step.config.attachments.includes('playwright_analysis') && workflowState.playwrightAnalysis) {
        stepPayload.playwright_analysis = workflowState.playwrightAnalysis;
      }
      if (step.config.attachments.includes('login_strategy') && workflowState.loginStrategy) {
        stepPayload.login_strategy = workflowState.loginStrategy;
      }
      if (step.config.attachments.includes('screenshot') && workflowState.screenshotBase64) {
        stepPayload.screenshot_base64 = workflowState.screenshotBase64;
        stepPayload.screenshot = workflowState.screenshotBase64; // Also keep for backward compatibility
      }
      // CRITICAL: Always include input_credentials if requested in attachments (for login script generation)
      // Strict validation - must not contain "MISSING" placeholder values
      if (step.config.attachments.includes('input_credentials') && workflowState.inputCredentials) {
        const creds = workflowState.inputCredentials;
        if (!creds.username || !creds.password ||
            creds.username === 'MISSING' || creds.username === 'missing' ||
            creds.password === 'MISSING' || creds.password === 'missing') {
          console.error(`❌ ERROR: input_credentials requested but contains "MISSING" values!`);
          throw new Error('Credentials in workflowState.inputCredentials must not contain placeholder values');
        }
        stepPayload.input_credentials = creds;
        console.log(`✅ Added input_credentials to payload: username=${creds.username}, password=***`);
      }
    }
    
    // CRITICAL: Always ensure input_credentials is available for login-related steps (even if not in attachments)
    // Only add credentials if they're valid (not MISSING) and if they exist
    if (!stepPayload.input_credentials && workflowState.inputCredentials) {
      const creds = workflowState.inputCredentials;
      // Only validate and add if credentials are actually present and valid
      if (creds && creds.username && creds.password &&
          creds.username !== 'MISSING' && creds.username !== 'missing' &&
          creds.password !== 'MISSING' && creds.password !== 'missing') {
        stepPayload.input_credentials = creds;
        console.log(`✅ Added input_credentials to payload: username=${creds.username}, password=***`);
      } else if (creds === null) {
        // Credentials are explicitly null (crawl job without login) - this is OK, don't add them
        console.log(`ℹ️ No credentials available for this step (crawl job without login)`);
      } else {
        // Credentials exist but are invalid - only throw if this is a login job
        const isLoginJob = this.context?.jobType === 'login' || 
                          this.context?.job_type === 'login' ||
                          this.context?.isLoginJob === true;
        if (isLoginJob) {
          console.error(`❌ ERROR: Cannot add input_credentials - contains "MISSING" values!`);
          throw new Error('Credentials in workflowState.inputCredentials must not contain placeholder values');
        } else {
          console.log(`ℹ️ Credentials invalid but not required (crawl job) - skipping`);
        }
      }
    }

    if (workflowState.lastDialogMessage) {
      stepPayload.last_dialog_message = workflowState.lastDialogMessage;
    }
    
    // DEBUG: Log legsToExecute data for "Justify Journeys" step
    if (step.id === 'justify_journeys' || step.name?.includes('Justify Journeys')) {
      console.log(`🔍 [JUSTIFY-JOURNEYS DEBUG] Step: ${step.id || step.name}`);
      console.log(`🔍 [JUSTIFY-JOURNEYS DEBUG] workflowState.legsToExecute: ${workflowState.legsToExecute?.length || 0} items`);
      console.log(`🔍 [JUSTIFY-JOURNEYS DEBUG] workflowState.journeysToExecute: ${workflowState.journeysToExecute?.length || 0} items`);
      console.log(`🔍 [JUSTIFY-JOURNEYS DEBUG] stepPayload.legsToExecute: ${stepPayload.legsToExecute?.length || 0} items`);
      console.log(`🔍 [JUSTIFY-JOURNEYS DEBUG] stepPayload.legs_to_execute: ${stepPayload.legs_to_execute?.length || 0} items`);
      if (stepPayload.legsToExecute && stepPayload.legsToExecute.length > 0) {
        console.log(`🔍 [JUSTIFY-JOURNEYS DEBUG] First leg/journey sample:`, JSON.stringify(stepPayload.legsToExecute[0], null, 2).substring(0, 500));
      }
      if (workflowState.context?.legsToExecute) {
        console.log(`🔍 [JUSTIFY-JOURNEYS DEBUG] workflowState.context.legsToExecute: ${workflowState.context.legsToExecute.length} items`);
      }
      if (workflowState.context?.journeysToExecute) {
        console.log(`🔍 [JUSTIFY-JOURNEYS DEBUG] workflowState.context.journeysToExecute: ${workflowState.context.journeysToExecute.length} items`);
      }
    }
    
    // Log prompt usage with step information
    const currentStepIndex = contextInfo.stepIndex !== null ? contextInfo.stepIndex : (this.workflowTemplate?.steps?.findIndex(s => s.id === step.id || s.name === step.name) ?? -1);
    await this.logPromptUsage(promptIdentifier, promptSource, decoratedTemplate, stepPayload, {
      step: step,
      stepIndex: currentStepIndex >= 0 ? currentStepIndex : (this.workflowTemplate?.steps?.findIndex(s => s.type === step.type) ?? -1),
      totalSteps: this.workflowTemplate?.steps?.length
    });
    
    try {
      const isScriptGenerationStep = step.id === 'generate_journey_script' || step.id === 'generate_login_script' ||
        step.name?.includes('Generate Journey Action Script') || step.name?.includes('Generate Login Script');
      const isPageSummaryStep = step.id === 'page_summary' || step.name?.includes('AI Page Intelligence');

      // Script-generation steps frequently fail with reasoning-only/incomplete outputs.
      // Force direct JSON generation for these steps by disabling reasoning overrides.
      if (isScriptGenerationStep) {
        stepPayload.reasoning_enabled = false;
        stepPayload.reasoning_effort = null;
        stepPayload.websearch_enabled = false;
        // Explicitly request larger output budget for generated scripts.
        // This avoids nested prompt-slug default limits causing truncated empty responses.
        stepPayload.max_completion_tokens = 8192;

        // Prevent stale scripts from previous attempts/runs from being reused.
        delete workflowState.legScriptToExecute;
        delete workflowState.journeyScriptToExecute;
        if (workflowState.context && typeof workflowState.context === 'object') {
          delete workflowState.context.legScriptToExecute;
          delete workflowState.context.journeyScriptToExecute;
        }
        if (workflowState.variablePool?.page) {
          delete workflowState.variablePool.page.legScriptToExecute;
          delete workflowState.variablePool.page.journeyScriptToExecute;
        }
      }

      // Page-summary prompts can also return reasoning-only/incomplete payloads.
      // Force direct JSON output mode for this step as well.
      if (isPageSummaryStep) {
        stepPayload.reasoning_enabled = false;
        stepPayload.reasoning_effort = null;
        stepPayload.websearch_enabled = false;
        // Use a stable non-reasoning model for page discovery to avoid reasoning-only incomplete outputs.
        stepPayload.model = 'gpt-4.1-mini';
        if (stepPayload.max_completion_tokens === undefined || stepPayload.max_completion_tokens === null) {
          stepPayload.max_completion_tokens = 2500;
        }
      }

      // Check if this is a determine_completion step and if current leg has an associated action with action_test_prompt
      let finalTemplate = decoratedTemplate;
      const isDetermineCompletion = step.id?.includes('determine_completion') || 
                                    step.id?.includes('determine-completion') ||
                                    step.name?.toLowerCase().includes('determine completion') ||
                                    promptIdentifier?.includes('determine_completion');
      
      if (isDetermineCompletion && workflowState.currentLeg) {
        const legId = workflowState.currentLeg.leg_id || workflowState.currentLeg.id;
        if (legId && workflowState.pageId) {
          try {
            // Fetch action from backend using leg_id and page_id
            const actionResponse = await axios.get(
              `${this.backendUrl}/actions?leg_id=${legId}&page_id=${workflowState.pageId}`,
              { timeout: 5000 }
            );
            
            const actions = Array.isArray(actionResponse.data) ? actionResponse.data : [];
            const action = actions.find(a => a.leg_id === legId);
            
            if (action && action.action_test_prompt) {
              const mergeMode = step.config?.action_test_prompt_mode || 'merge'; // 'merge' or 'replace'
              
              if (mergeMode === 'replace') {
                finalTemplate = action.action_test_prompt;
                console.log(`🔄 Replaced prompt with action_test_prompt for leg ${legId}`);
              } else {
                // Merge: append action_test_prompt to the existing template
                finalTemplate = `${decoratedTemplate}\n\n--- Additional Action-Specific Instructions ---\n${action.action_test_prompt}`;
                console.log(`🔄 Merged action_test_prompt for leg ${legId}`);
              }
            }
          } catch (error) {
            console.warn(`⚠️ Failed to fetch action for leg ${legId}: ${error.message}`);
            // Continue with original template if fetch fails
          }
        }
      }
      
      // Use embedded template from step config (required - no fallback to database)
      // CRITICAL: The user_message_template already includes the schema format in the prompt text
      // We pass response_schema for validation but don't need response_schema_description
      // because the template explicitly describes the expected JSON structure
      let effectiveTemplate = finalTemplate;
      if (isScriptGenerationStep) {
        // Runtime hardening: enforce deterministic dynamic-field handling even if older workflow templates are loaded.
        effectiveTemplate += '\n\nRUNTIME OVERRIDE (MANDATORY):\n'
          + '- Execute each listed action exactly once (no duplicate add/click actions unless explicitly repeated in currentJourney.actions).\n'
          + '- If an action adds dynamic inputs (e.g., Add Email/Add Phone), ensure every visible required input is non-empty before submit.\n'
          + '- Immediately before submit, handle browser validation safely: if any :invalid input exists, fill it with a valid realistic value and then submit.\n'
          + '- Never return success while required fields remain empty or browser validation messages are visible.\n';
      }
      const promptConfig = {
        user_message_template: effectiveTemplate,
        system_message: systemMessage,
        response_schema: responseSchema
      };
      
      // CRITICAL: Ensure pageUrl is set correctly for AI conversation logging
      const effectivePageUrl = workflowState.pageUrl || workflowState.expectedLoginUrl || page.url();
      console.log(`📄 VAR_DUMP: executeAIPromptStep - effectivePageUrl=${effectivePageUrl}`);
      console.log(`📄 VAR_DUMP: executeAIPromptStep - jobId=${jobId}`);
      console.log(`📄 VAR_DUMP: executeAIPromptStep - promptIdentifier=${promptIdentifier}`);
      console.log(`📄 VAR_DUMP: executeAIPromptStep - stepPayload.input_credentials=${stepPayload.input_credentials ? JSON.stringify({username: stepPayload.input_credentials.username || 'MISSING', password: stepPayload.input_credentials.password ? '***' : 'MISSING'}) : 'MISSING'}`);
      
      let aiResponse;
      // Reuse step classification for retry behavior
      const configuredRetries = Number.isFinite(step.config?.maxRetries) ? step.config.maxRetries : 1;
      const maxAttempts = Math.max(1, configuredRetries + 1);
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          aiResponse = await this.aiLogger.makeAICallWithPrompt(
            promptIdentifier,
            stepPayload,
            jobId,
            'workflow-step',
            effectivePageUrl, // Use effectivePageUrl to ensure conversations are linked to correct page
            null,
            stepPayload,
            promptConfig // Pass full config (required - no fallback to database)
          );
        } catch (aiError) {
          const errorMessage = `OpenAI API call failed for step "${step.name || step.id}" (attempt ${attempt}/${maxAttempts}): ${aiError.message}`;
          const fullContext = {
            step_id: step.id,
            step_name: step.name,
            step_type: step.type,
            prompt_identifier: promptIdentifier,
            step_config: step.config,
            step_payload_keys: Object.keys(stepPayload || {}),
            attempt,
            max_attempts: maxAttempts,
            error: aiError.message,
            error_stack: aiError.stack
          };
          console.error(`❌ ${errorMessage}`);
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', fullContext);
          }
          if (attempt < maxAttempts) {
            continue;
          }
          throw new Error(`${errorMessage}\nFull context: ${JSON.stringify(fullContext, null, 2)}`);
        }

        // Script generation can occasionally return a non-JSON/incomplete wrapper object.
        // Retry immediately instead of continuing with an error-shaped payload.
        const isIncompleteResponse = isScriptGenerationStep &&
          aiResponse &&
          typeof aiResponse === 'object' &&
          aiResponse.success === false &&
          typeof aiResponse.error === 'string' &&
          (aiResponse.error.includes('OpenAI returned empty or undefined content') ||
            aiResponse.error.includes('"status":"incomplete"'));

        if (isIncompleteResponse && attempt < maxAttempts) {
          const retryMessage = `⚠️ Incomplete OpenAI output for ${step.id || step.name} (attempt ${attempt}/${maxAttempts}) - retrying`;
          console.warn(retryMessage);
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'warn', retryMessage, 'WORKFLOW-ANALYZER', {
              step_id: step.id,
              attempt,
              max_attempts: maxAttempts
            });
          }
          continue;
        }

        break;
      }
      
      // CRITICAL: Validate OpenAI response exists
      if (!aiResponse) {
        const errorMessage = `OpenAI returned null/undefined response for step "${step.name || step.id}"`;
        const fullContext = {
          step_id: step.id,
          step_name: step.name,
          step_type: step.type,
          prompt_identifier: promptIdentifier,
          step_config: step.config,
          step_payload_keys: Object.keys(stepPayload || {}),
          ai_response: null
        };
        console.error(`❌ ${errorMessage}`);
        console.error(`❌ Full step context:`, JSON.stringify(fullContext, null, 2));
        if (jobId && this.backendLogger) {
          await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', fullContext);
        }
        throw new Error(`${errorMessage}\nFull context: ${JSON.stringify(fullContext, null, 2)}`);
      }
      
      let parsedResponse = aiResponse;
      if (typeof aiResponse === 'string') {
        try {
          parsedResponse = JSON.parse(aiResponse);
        } catch (parseError) {
          const errorMessage = `Failed to parse OpenAI JSON response for step "${step.name || step.id}": ${parseError.message}`;
          const fullContext = {
            step_id: step.id,
            step_name: step.name,
            step_type: step.type,
            prompt_identifier: promptIdentifier,
            step_config: step.config,
            raw_response: aiResponse,
            parse_error: parseError.message
          };
          console.error(`❌ ${errorMessage}`);
          console.error(`❌ Raw response:`, aiResponse);
          console.error(`❌ Full step context:`, JSON.stringify(fullContext, null, 2));
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', fullContext);
          }
          throw new Error(`${errorMessage}\nRaw response: ${aiResponse}\nFull context: ${JSON.stringify(fullContext, null, 2)}`);
        }
      }

      // CRITICAL: Validate parsed response is an object
      if (!parsedResponse || typeof parsedResponse !== 'object' || Array.isArray(parsedResponse)) {
        const errorMessage = `OpenAI returned invalid response type for step "${step.name || step.id}". Expected object, got: ${typeof parsedResponse}`;
        const fullContext = {
          step_id: step.id,
          step_name: step.name,
          step_type: step.type,
          prompt_identifier: promptIdentifier,
          step_config: step.config,
          response_type: typeof parsedResponse,
          response_value: parsedResponse,
          raw_response: aiResponse
        };
        console.error(`❌ ${errorMessage}`);
        console.error(`❌ Response value:`, parsedResponse);
        console.error(`❌ Full step context:`, JSON.stringify(fullContext, null, 2));
        if (jobId && this.backendLogger) {
          await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', fullContext);
        }
        throw new Error(`${errorMessage}\nResponse: ${JSON.stringify(parsedResponse)}\nFull context: ${JSON.stringify(fullContext, null, 2)}`);
      }

      // Debug: Log what was returned
      console.log(`🔍 AI Response for step ${step.id} (${step.name}):`, JSON.stringify(parsedResponse, null, 2).substring(0, 1000));
      
      // CRITICAL: Log journeys in response for debugging
      if (parsedResponse && typeof parsedResponse === 'object') {
        const hasJourneys = !!(parsedResponse.journeys || parsedResponse.page_summary?.journeys);
        const journeysCount = parsedResponse.journeys?.length || parsedResponse.page_summary?.journeys?.length || 0;
        const hasLegs = !!(parsedResponse.legs || parsedResponse.page_summary?.legs);
        const legsCount = parsedResponse.legs?.length || parsedResponse.page_summary?.legs?.length || 0;
        const hasActions = !!(parsedResponse.actions || parsedResponse.page_summary?.actions);
        const actionsCount = parsedResponse.actions?.length || parsedResponse.page_summary?.actions?.length || 0;
        
        console.log(`🔍 [AI-RESPONSE] Step ${step.id}: hasJourneys=${hasJourneys}, journeysCount=${journeysCount}, hasLegs=${hasLegs}, legsCount=${legsCount}, hasActions=${hasActions}, actionsCount=${actionsCount}`);
        console.log(`🔍 [AI-RESPONSE] Full response keys: ${Object.keys(parsedResponse).join(', ')}`);
        if (parsedResponse.page_summary) {
          console.log(`🔍 [AI-RESPONSE] page_summary keys: ${Object.keys(parsedResponse.page_summary).join(', ')}`);
        }
        
        // CRITICAL: Log full response structure for debugging
        const responsePreview = JSON.stringify(parsedResponse, null, 2).substring(0, 3000);
        console.log(`🔍 [AI-RESPONSE] Full response preview:\n${responsePreview}`);
        
        if (jobId && this.backendLogger) {
          await this.backendLogger.appendJobLog(jobId, 'info', `🔍 [AI-RESPONSE] Step ${step.id}: hasJourneys=${hasJourneys}, journeysCount=${journeysCount}, hasLegs=${hasLegs}, legsCount=${legsCount}`, 'WORKFLOW-ANALYZER', {
            step_id: step.id,
            has_journeys: hasJourneys,
            journeys_count: journeysCount,
            has_legs: hasLegs,
            legs_count: legsCount,
            has_actions: hasActions,
            actions_count: actionsCount,
            response_keys: Object.keys(parsedResponse),
            has_page_summary: !!parsedResponse.page_summary,
            page_summary_keys: parsedResponse.page_summary ? Object.keys(parsedResponse.page_summary).join(', ') : null,
            response_preview: responsePreview
          });
        }
      }
      
      // Generate summary for AI request
      let summaryMessage = '';
      let summaryMetadata = {
        step_id: step.id,
        step_name: step.name || step.id,
        response_type: typeof parsedResponse
      };
      
      if (parsedResponse && typeof parsedResponse === 'object') {
        console.log(`🔍 Response keys: ${Object.keys(parsedResponse).join(', ')}`);
        // CRITICAL: Enforce response schema for script-generation steps (login + journey)
        const isGenerateLoginScriptStep = step.id === 'generate_login_script' || step.name?.includes('Generate Login Script');
        const isGenerateJourneyScriptStep = step.id === 'generate_journey_script' || step.name?.includes('Generate Journey Action Script');
        if (isGenerateLoginScriptStep || isGenerateJourneyScriptStep) {
          const requiredStringFields = isGenerateJourneyScriptStep
            ? ['playwright_script', 'description', 'expected_result']
            : ['playwright_script'];

          for (const fieldName of requiredStringFields) {
            const fieldValue = parsedResponse[fieldName];
            if (typeof fieldValue !== 'string' || fieldValue.trim().length === 0) {
              const stepTypeLabel = isGenerateJourneyScriptStep ? 'generate_journey_script' : 'generate_login_script';
              const errorMessage = `Missing or invalid required field "${fieldName}" in ${stepTypeLabel} response for step "${step.name || step.id}"`;
              const fullContext = {
                step_id: step.id,
                step_name: step.name,
                step_type: step.type,
                step_config: step.config,
                missing_or_invalid_field: fieldName,
                field_value_type: typeof fieldValue,
                field_value_preview: typeof fieldValue === 'string' ? fieldValue.substring(0, 200) : fieldValue,
                available_keys: Object.keys(parsedResponse),
                full_response: parsedResponse
              };
              console.error(`❌ ${errorMessage}`);
              console.error(`❌ Available keys: ${Object.keys(parsedResponse).join(', ')}`);
              console.error(`❌ Full response:`, JSON.stringify(parsedResponse, null, 2));
              console.error(`❌ Full step context:`, JSON.stringify(fullContext, null, 2));
              if (jobId && this.backendLogger) {
                await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', fullContext);
              }
              throw new Error(`${errorMessage}\nAvailable keys: ${Object.keys(parsedResponse).join(', ')}\nFull response: ${JSON.stringify(parsedResponse, null, 2)}\nFull context: ${JSON.stringify(fullContext, null, 2)}`);
            }
          }

          console.log(`✅ playwright_script PRESENT in response: ${parsedResponse.playwright_script.length} chars`);
        }
        
        // Extract summary information based on response content
        // CRITICAL: Log the actual response structure for debugging
        console.log(`🔍 [AI-RESPONSE] Response keys: ${Object.keys(parsedResponse).join(', ')}`);
        if (parsedResponse.page_summary) {
          console.log(`🔍 [AI-RESPONSE] page_summary keys: ${Object.keys(parsedResponse.page_summary).join(', ')}`);
          if (parsedResponse.page_summary.journeys) {
            console.log(`🔍 [AI-RESPONSE] page_summary.journeys found: ${Array.isArray(parsedResponse.page_summary.journeys) ? parsedResponse.page_summary.journeys.length : 'not array'}`);
          }
        }
        if (parsedResponse.journeys) {
          console.log(`🔍 [AI-RESPONSE] parsedResponse.journeys found: ${Array.isArray(parsedResponse.journeys) ? parsedResponse.journeys.length : 'not array'}`);
        }
        if (jobId && this.backendLogger) {
          await this.backendLogger.appendJobLog(jobId, 'info', `🔍 [AI-RESPONSE] Response structure: keys=${Object.keys(parsedResponse).join(', ')}`, 'WORKFLOW-ANALYZER', {
            response_keys: Object.keys(parsedResponse),
            has_journeys: !!parsedResponse.journeys,
            journeys_is_array: Array.isArray(parsedResponse.journeys),
            journeys_length: Array.isArray(parsedResponse.journeys) ? parsedResponse.journeys.length : 0,
            has_page_summary: !!parsedResponse.page_summary,
            has_page_summary_journeys: !!(parsedResponse.page_summary?.journeys),
            page_summary_journeys_is_array: Array.isArray(parsedResponse.page_summary?.journeys),
            page_summary_journeys_length: Array.isArray(parsedResponse.page_summary?.journeys) ? parsedResponse.page_summary.journeys.length : 0,
            has_legs: !!parsedResponse.legs,
            has_actions: !!parsedResponse.actions,
            response_preview: JSON.stringify(parsedResponse).substring(0, 500)
          });
        }
        
        // CRITICAL: Check for journeys first (new format)
        // Check both parsedResponse.journeys and parsedResponse.page_summary.journeys
        const journeysInResponse = parsedResponse.journeys || parsedResponse.page_summary?.journeys || null;
        if (journeysInResponse && Array.isArray(journeysInResponse)) {
          const totalActions = journeysInResponse.reduce((sum, j) => sum + (Array.isArray(j.actions) ? j.actions.length : 0), 0);
          summaryMessage = `📋 Found ${journeysInResponse.length} journey(s) with ${totalActions} action(s)`;
          summaryMetadata.journeys_count = journeysInResponse.length;
          summaryMetadata.total_actions_in_journeys = totalActions;
          summaryMetadata.sample_journeys = journeysInResponse.slice(0, 3).map(j => ({
            journey_id: j.journey_id,
            actions_count: Array.isArray(j.actions) ? j.actions.length : 0
          }));
          console.log(`✅ [AI-RESPONSE] Found ${journeysInResponse.length} journey(s) with ${totalActions} action(s) in response`);
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'info', `✅ [AI-RESPONSE] Found ${journeysInResponse.length} journey(s) with ${totalActions} action(s)`, 'WORKFLOW-ANALYZER', {
              journeys_count: journeysInResponse.length,
              total_actions: totalActions
            });
          }
        } else if (parsedResponse.legs && Array.isArray(parsedResponse.legs)) {
          summaryMessage = `📋 Found ${parsedResponse.legs.length} action(s)`;
          summaryMetadata.legs_count = parsedResponse.legs.length;
          summaryMetadata.sample_legs = parsedResponse.legs.slice(0, 3).map(leg => leg.description || leg.leg_id || 'leg');
        } else if (parsedResponse.actions && Array.isArray(parsedResponse.actions)) {
          summaryMessage = `📋 Found ${parsedResponse.actions.length} action(s)`;
          summaryMetadata.actions_count = parsedResponse.actions.length;
        } else if (parsedResponse.page_summary) {
          summaryMessage = `📄 Page analyzed: ${parsedResponse.page_summary.short_description || parsedResponse.page_summary.detailed_description?.substring(0, 100) || 'Page analyzed'}`;
          summaryMetadata.has_page_summary = true;
        } else if (parsedResponse.status) {
          summaryMessage = `✅ Outcome: ${parsedResponse.status}${parsedResponse.reason ? ` - ${parsedResponse.reason}` : ''}`;
          summaryMetadata.status = parsedResponse.status;
          summaryMetadata.is_complete = parsedResponse.is_complete;
        } else if (parsedResponse.playwright_script) {
          summaryMessage = `📜 Generated script (${parsedResponse.playwright_script.length} chars)`;
          summaryMetadata.script_length = parsedResponse.playwright_script.length;
        } else if (parsedResponse.login_summary) {
          summaryMessage = `🔐 Login flow: ${parsedResponse.login_summary.flow_type || 'analyzed'}`;
          summaryMetadata.login_flow_type = parsedResponse.login_summary.flow_type;
        }
        
        // Log summary to job history
        if (summaryMessage && jobId && this.backendLogger) {
          await this.backendLogger.appendJobLog(jobId, 'info', summaryMessage, 'WORKFLOW-ANALYZER', summaryMetadata);
        }
        
        // CRITICAL: Store playwright_script as legScriptToExecute for ALL AI prompt steps that return it
        // This is used by execute-code-from-variable steps
        const playwrightScript = parsedResponse.playwright_script != null && typeof parsedResponse.playwright_script === 'string' ? parsedResponse.playwright_script : '';
        if (playwrightScript) {
          console.log(`✅ playwright_script found: ${playwrightScript.length} chars`);
          console.log(`📄 VAR_DUMP: playwright_script length=${playwrightScript.length}`);
          console.log(`📄 VAR_DUMP: playwright_script preview: ${playwrightScript.substring(0, 300)}`);
          
          // CRITICAL: Verify script uses input_credentials (only for login steps)
          if (step.id === 'generate_login_script' || step.name?.includes('Generate Login Script')) {
            const scriptUsesCredentials = playwrightScript.includes('input_credentials') ||
                                         playwrightScript.includes('input_credentials.username') ||
                                         playwrightScript.includes('input_credentials.password');
            console.log(`📄 VAR_DUMP: scriptUsesCredentials=${scriptUsesCredentials}`);
            if (!scriptUsesCredentials) {
              console.error(`❌ ERROR: Generated script does NOT use input_credentials!`);
              console.error(`Script preview: ${playwrightScript.substring(0, 500)}`);
              console.error(`Available credentials: username=${workflowState.inputCredentials?.username || 'MISSING'}, password=${workflowState.inputCredentials?.password ? '***' : 'MISSING'}`);
            } else {
              console.log(`✅ Generated script uses input_credentials`);
            }
          }
          
          // Note: We rely on AI to generate appropriate scripts without hardcoded pattern checks
          // The AI should analyze the page state and generate scripts accordingly
          
          // Upload playwright script as downloadable file
          let scriptUrl = null;
          if (jobId) {
            try {
              const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
              const stepName = (step.name || step.id || 'script').replace(/[^a-z0-9]/gi, '-').toLowerCase();
              const fileName = `playwright-script-${jobId}-${stepName}-${timestamp}.js`;
              scriptUrl = await this.uploadFileForDownload(jobId, playwrightScript, fileName, 'text/javascript');
              
              if (scriptUrl) {
                console.log(`✅ Playwright script uploaded: 📥 ${scriptUrl}`);
              }
            } catch (uploadError) {
              console.warn(`⚠️ Failed to upload playwright script: ${uploadError.message}`);
            }
          }
          
          // Log to job history with download link
          const scriptLogMessage = scriptUrl
            ? `✅ playwright_script extracted: ${playwrightScript.length} chars\n📥 Download: ${scriptUrl}`
            : `✅ playwright_script extracted: ${playwrightScript.length} chars`;
          
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'info',
              scriptLogMessage,
              'WORKFLOW-ANALYZER',
              {
                step_id: step.id,
                script_length: playwrightScript.length,
                script_preview: playwrightScript.substring(0, 200),
                script_download_url: scriptUrl
              }
            );
          }

          // CRITICAL: Store as legScriptToExecute for execute-code-from-variable steps
          let cleanedScript = this.cleanScript(playwrightScript);
          // Repair AI-generated script: add missing catch for outer try so executor does not fail with syntax error
          if (cleanedScript && cleanedScript.trim().length > 0) {
            try {
              new Function(cleanedScript);
            } catch (syntaxErr) {
              if (syntaxErr.message && syntaxErr.message.includes('Missing catch or finally after try')) {
                const trimmed = cleanedScript.trim();
                let repaired = trimmed.replace(/\}\s*\}\s*\)\s*\(\s*\)\s*;?\s*$/, '} catch (e) { throw e; } })();');
                if (repaired === trimmed) repaired = trimmed.replace(/\}\)\s*\(\s*\)\s*;?\s*$/, '} catch (e) { throw e; } })();');
                if (repaired !== trimmed) {
                  try {
                    new Function(repaired);
                    cleanedScript = repaired;
                    parsedResponse.playwright_script = repaired;
                    console.log('✅ Repaired playwright_script: added missing catch for outer try');
                    if (jobId && this.backendLogger) {
                      await this.backendLogger.appendJobLog(jobId, 'info', 'Repaired playwright_script: added missing catch for outer try', 'WORKFLOW-ANALYZER', { script_length: cleanedScript.length });
                    }
                  } catch (_) { /* keep original */ }
                }
              }
            }
          }
          if (cleanedScript && cleanedScript.trim().length > 0) {
            workflowState.legScriptToExecute = cleanedScript;
            if (!workflowState.context) {
              workflowState.context = {};
            }
            workflowState.context.legScriptToExecute = cleanedScript;
            // Also store in variable pool for easy access
            this.initializeVariablePool(workflowState);
            this.saveVariable(workflowState, 'legScriptToExecute', cleanedScript, 'page', step);
            console.log(`✅ Stored playwright_script as legScriptToExecute in workflowState, context, and variablePool: ${cleanedScript.length} chars`);
            
            // CRITICAL: Upsert script to scripts collection for tracking
            try {
              await this.upsertScriptToCollection(
                cleanedScript,
                parsedResponse,
                step,
                workflowState,
                jobId,
                stepContext
              );
            } catch (upsertError) {
              console.warn(`⚠️ Failed to upsert script to collection: ${upsertError.message}`);
              // Don't throw - script is still stored in workflowState
            }
          } else {
            console.warn(`⚠️ Cleaned script is empty after cleaning`);
          }
        } else {
          console.log(`⚠️ playwright_script NOT found in response`);
          console.log(`📄 VAR_DUMP: parsedResponse keys: ${Object.keys(parsedResponse || {}).join(', ')}`);
          console.log(`📄 VAR_DUMP: parsedResponse preview: ${JSON.stringify(parsedResponse).substring(0, 1000)}`);
          // Log to job history
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'warn',
              `⚠️ playwright_script NOT found in AI response`,
              'WORKFLOW-ANALYZER',
              {
                step_id: step.id,
                response_keys: Object.keys(parsedResponse).join(', '),
                response_preview: JSON.stringify(parsedResponse).substring(0, 500)
              }
            );
          }
        }

        if (!workflowState.legScriptToExecute) {
          const fallbackScript =
            parsedResponse.script ||
            parsedResponse.code ||
            parsedResponse.legScriptToExecute ||
            null;

          if (typeof fallbackScript === 'string' && fallbackScript.trim().length > 0) {
            const cleanedFallback = this.cleanScript(fallbackScript);
            if (cleanedFallback && cleanedFallback.trim().length > 0) {
              workflowState.legScriptToExecute = cleanedFallback;
              if (!workflowState.context) {
                workflowState.context = {};
              }
              workflowState.context.legScriptToExecute = cleanedFallback;
            }
          }

        }
      }

      // CRITICAL: Extract legs from AI response and store in context.legsToExecute for for-each steps
      // This ensures Execute Workflow Legs can find legsToExecute at context.legsToExecute
      if (parsedResponse && typeof parsedResponse === 'object') {
        let candidateLegs = [];
        let journeys = [];
        
        // Check if response has journeys (new format from simplified template)
        // CRITICAL: Check both parsedResponse.journeys and parsedResponse.page_summary.journeys
        console.log(`🔍 [JOURNEYS-EXTRACT] Checking parsedResponse for journeys: has journeys=${!!parsedResponse.journeys}, isArray=${Array.isArray(parsedResponse.journeys)}, type=${typeof parsedResponse.journeys}`);
        console.log(`🔍 [JOURNEYS-EXTRACT] Response keys: ${Object.keys(parsedResponse).join(', ')}`);
        if (parsedResponse.page_summary) {
          console.log(`🔍 [JOURNEYS-EXTRACT] page_summary keys: ${Object.keys(parsedResponse.page_summary).join(', ')}`);
        }
        
        if (parsedResponse.journeys && Array.isArray(parsedResponse.journeys)) {
          journeys = parsedResponse.journeys;
          console.log(`✅ [JOURNEYS-EXTRACT] Found ${journeys.length} journeys in response`);
          console.log(`🔍 [JOURNEYS-EXTRACT] First journey preview:`, JSON.stringify(journeys[0], null, 2).substring(0, 500));
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'info', `✅ [JOURNEYS-EXTRACT] Found ${journeys.length} journeys in response`, 'WORKFLOW-ANALYZER', {
              journeys_count: journeys.length,
              journey_ids: journeys.map(j => j.journey_id || 'no-id')
            });
          }
          console.log(`🔍 [JOURNEYS-EXTRACT] Response keys: ${Object.keys(parsedResponse).join(', ')}`);
          if (journeys.length > 0) {
            console.log(`🔍 [JOURNEYS-EXTRACT] Journey IDs: ${journeys.map(j => j.journey_id || 'no-id').join(', ')}`);
            // CRITICAL: Validate that journeys have actions array
            let totalActions = 0;
            journeys.forEach((journey, idx) => {
              const actionsCount = Array.isArray(journey.actions) ? journey.actions.length : 0;
              totalActions += actionsCount;
              if (actionsCount === 0) {
                console.error(`❌ [JOURNEYS-EXTRACT] Journey ${journey.journey_id || idx} has NO actions array or empty actions! Journey keys: ${Object.keys(journey).join(', ')}`);
                console.error(`❌ [JOURNEYS-EXTRACT] Journey ${journey.journey_id || idx} full object:`, JSON.stringify(journey, null, 2).substring(0, 1000));
                if (jobId && this.backendLogger) {
                  this.backendLogger.appendJobLog(jobId, 'error', `❌ [JOURNEYS-EXTRACT] Journey ${journey.journey_id || idx} has NO actions!`, 'WORKFLOW-ANALYZER', {
                    journey_id: journey.journey_id || idx,
                    journey_keys: Object.keys(journey).join(', ')
                  });
                }
              } else {
                console.log(`✅ [JOURNEYS-EXTRACT] Journey ${journey.journey_id || idx} has ${actionsCount} action(s)`);
              }
            });
            if (jobId && this.backendLogger) {
              await this.backendLogger.appendJobLog(jobId, 'info', `✅ [JOURNEYS-EXTRACT] Total actions across ${journeys.length} journeys: ${totalActions}`, 'WORKFLOW-ANALYZER', {
                journeys_count: journeys.length,
                total_actions: totalActions
              });
            }
          }
          if (journeys.length === 0) {
            console.warn(`⚠️ [AI RESPONSE] Journeys array is EMPTY. Full response structure:`, JSON.stringify(parsedResponse, null, 2).substring(0, 2000));
            // CRITICAL: Even if empty, we need to store it in parsedResponse so processVariableOutputs can access it
            // This ensures the variableOutputs can see the empty array and log appropriately
          }
          
          // VALIDATION: Log journey count for debugging (no strict enforcement since journeys can be for forms OR interactive elements)
          // Get all interactive groups (forms and interactive elements)
          const interactiveGroups = {
            forms: workflowState.playwrightAnalysis?.forms || workflowState.forms || [],
            interactiveElements: workflowState.playwrightAnalysis?.interactive_elements || workflowState.interactive_elements || []
          };
          const formsCount = Array.isArray(interactiveGroups.forms) ? interactiveGroups.forms.length : 0;
          const interactiveElements = Array.isArray(interactiveGroups.interactiveElements)
            ? interactiveGroups.interactiveElements
            : [];
          const significantInteractiveElements = interactiveElements.filter((element) => {
            const elementType = String(element.element_type || element.type || '').toLowerCase();
            if (!elementType) {
              return true;
            }
            return !['input', 'select', 'textarea', 'checkbox', 'radio'].includes(elementType);
          });
          const interactiveElementsCount = significantInteractiveElements.length;
          const journeysCount = journeys.length;
          
          console.log(`📊 [VALIDATION] Found ${formsCount} form(s), ${interactiveElementsCount} significant interactive element(s), ${journeysCount} journey(s)`);
          
          // Warn if no journeys but elements exist (AI might have missed something)
          if (journeysCount === 0 && (formsCount > 0 || interactiveElementsCount > 0)) {
            console.warn(`⚠️ [VALIDATION] No journeys generated but ${formsCount} form(s) and ${interactiveElementsCount} significant interactive element(s) exist on the page`);
          }
          
          // Validate journey count matches forms + significant interactive elements
          // AI must follow the rule: ONE FORM/INTERACTIVE ELEMENT = ONE JOURNEY
          if (journeysCount !== (formsCount + interactiveElementsCount)) {
            console.warn(`⚠️ [VALIDATION] Generated ${journeysCount} journey(s) but expected ${formsCount + interactiveElementsCount} (${formsCount} form(s) + ${interactiveElementsCount} significant interactive element(s)). AI must follow the rule: EXACTLY ONE JOURNEY PER FORM/INTERACTIVE ELEMENT.`);
          }
          
          // Deduplicate journeys by mapping them back to unique interactive elements
          if (journeys.length > 1) {
            const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const extractSelectorText = (selector) => {
              if (!selector || typeof selector !== 'string') {
                return '';
              }
              const trimmed = selector.trim();
              if (!trimmed.startsWith('text=')) {
                return '';
              }
              let text = trimmed.slice(5).trim();
              if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
                text = text.slice(1, -1);
              }
              return text;
            };

            const selectorKeyMap = new Map();
            const textKeyMap = new Map();
            significantInteractiveElements.forEach((element, index) => {
              const elementId = element?.id || element?.element_id || '';
              const selector = element?.selector || '';
              const text = normalizeText(element?.text || element?.innerText || element?.label || '');
              const existingTextKey = text ? textKeyMap.get(text) : null;
              const key = existingTextKey || (elementId
                ? `id:${elementId}`
                : selector
                  ? `selector:${selector}`
                  : text
                    ? `text:${text}`
                    : `index:${index}`);
              if (selector && !selectorKeyMap.has(selector)) {
                selectorKeyMap.set(selector, key);
              }
              if (text && !textKeyMap.has(text)) {
                textKeyMap.set(text, key);
              }
            });

            const seenJourneyKeys = new Set();
            const dedupedJourneys = [];
            for (const journey of journeys) {
              const journeyId = journey?.journey_id || '';
              const actionSelector = journey?.actions?.[0]?.selector || '';
              const selectorKey = selectorKeyMap.get(actionSelector);
              const selectorText = extractSelectorText(actionSelector);
              const textKey = selectorText ? textKeyMap.get(normalizeText(selectorText)) : null;
              const actionText = normalizeText(journey?.actions?.[0]?.element_info?.text || journey?.interactive_element?.text || '');
              const actionTextKey = actionText ? textKeyMap.get(actionText) : null;

              const dedupeKey = selectorKey ||
                textKey ||
                actionTextKey ||
                (actionSelector ? `selector:${actionSelector}` : (journeyId ? `id:${journeyId}` : `index:${dedupedJourneys.length}`));

              if (seenJourneyKeys.has(dedupeKey)) {
                console.warn(`⚠️ [JOURNEYS-DEDUP] Dropping duplicate journey ${journeyId || '(no-id)'} for key ${dedupeKey}`);
                continue;
              }
              seenJourneyKeys.add(dedupeKey);
              dedupedJourneys.push(journey);
            }

            if (dedupedJourneys.length !== journeys.length) {
              console.warn(`⚠️ [JOURNEYS-DEDUP] Deduped journeys from ${journeys.length} to ${dedupedJourneys.length}`);
              journeys = dedupedJourneys;
            }
          }

          // CRITICAL: Store journeys in workflowState IMMEDIATELY after extraction
          // Only journeys with a non-empty actions array are executable; filter out the rest
          const validJourneys = journeys.filter(j => Array.isArray(j.actions) && j.actions.length > 0);
          const skippedNoActions = journeys.length - validJourneys.length;
          if (skippedNoActions > 0) {
            console.warn(`⚠️ [JOURNEYS-EXTRACT] Skipped ${skippedNoActions} journey(s) with no actions; ${validJourneys.length} executable`);
          }
          if (journeys.length > 0) {
            workflowState.journeys = journeys;
            workflowState.journeysToExecute = validJourneys;
            if (!workflowState.context) {
              workflowState.context = {};
            }
            workflowState.context.journeysToExecute = validJourneys;
            
            // CRITICAL: Also save to variable pool immediately so for-each step can find it
            this.initializeVariablePool(workflowState);
            this.saveVariable(workflowState, 'journeysToExecute', validJourneys, 'page', step);
            
            // Also store in aiAnalysisResult for compatibility
            if (!workflowState.aiAnalysisResult) {
              workflowState.aiAnalysisResult = {};
            }
            workflowState.aiAnalysisResult.journeys = journeys;
            
            console.log(`✅ [JOURNEYS-STATE] Immediately stored ${validJourneys.length} journey(s) in workflowState.journeysToExecute and variable pool`);
            if (jobId && this.backendLogger) {
              await this.backendLogger.appendJobLog(jobId, 'info', `✅ [JOURNEYS-STATE] Stored ${validJourneys.length} executable journey(s) in workflowState`, 'WORKFLOW-ANALYZER', {
                journeys_count: validJourneys.length,
                skipped_no_actions: skippedNoActions,
                journey_ids: validJourneys.map(j => j.journey_id || 'no-id'),
                total_actions: validJourneys.reduce((sum, j) => sum + (Array.isArray(j.actions) ? j.actions.length : 0), 0)
              });
            }
            
            // CRITICAL: Save journeys to backend IMMEDIATELY after extraction
            // Don't wait for later save attempts - save now while we have the data
            let pageIdToSave = workflowState.pageId || this.context?.page_id || this.context?.pageId || null;
            let projectIdToSave = workflowState.projectId || this.context?.project_id || this.context?.projectId || null;
            
            if (!pageIdToSave && projectIdToSave && workflowState.pageUrl) {
              try {
                pageIdToSave = await this.ensurePageId(workflowState, jobId);
              } catch (pageError) {
                console.warn(`⚠️ [JOURNEYS-IMMEDIATE] Failed to get pageId: ${pageError.message}`);
              }
            }
            
            if (pageIdToSave && projectIdToSave) {
              try {
                // First verify page exists, create if it doesn't
                try {
                  await axios.get(`${this.backendUrl}/api/pages/${pageIdToSave}`, { headers: this.getAuthHeaders() });
                } catch (checkError) {
                  if (checkError.response?.status === 404) {
                    console.log(`🔍 [JOURNEYS-IMMEDIATE] Page ${pageIdToSave} not found, creating it first`);
                    pageIdToSave = await this.ensurePageId(workflowState, jobId);
                    if (!pageIdToSave) {
                      throw new Error('Failed to create page');
                    }
                  } else {
                    throw checkError;
                  }
                }
                
                // CRITICAL: Clean journeys to remove circular references before sending
                const cleanedJourneys = journeys.map(j => this.cleanJourneyForSave(j));
                
                const payload = {
                  saveLegs: true,
                  journeys: cleanedJourneys,
                  job_id: jobId
                };
                
                console.log(`🔍 [JOURNEYS-IMMEDIATE] Saving ${journeys.length} journey(s) immediately after extraction to page ${pageIdToSave}`);
                const response = await axios.post(
                  `${this.backendUrl}/api/pages/${pageIdToSave}/save-analysis`,
                  payload,
                  { headers: this.getAuthHeaders() }
                );
                
                console.log(`✅ [JOURNEYS-IMMEDIATE] Successfully saved ${journeys.length} journey(s) immediately. Response status: ${response.status}`);
                if (jobId && this.backendLogger) {
                  await this.backendLogger.appendJobLog(jobId, 'info', `✅ [JOURNEYS-IMMEDIATE] Saved ${journeys.length} journey(s) immediately after extraction`, 'WORKFLOW-ANALYZER', {
                    journeys_count: journeys.length,
                    page_id: pageIdToSave,
                    response_status: response.status
                  });
                }
              } catch (immediateError) {
                console.error(`❌ [JOURNEYS-IMMEDIATE] Failed to save journeys immediately: ${immediateError.message}`);
                console.error(`❌ [JOURNEYS-IMMEDIATE] Error details:`, immediateError.response?.data || immediateError.message);
                if (jobId && this.backendLogger) {
                  await this.backendLogger.appendJobLog(jobId, 'error', `❌ [JOURNEYS-IMMEDIATE] Failed to save journeys: ${immediateError.message}`, 'WORKFLOW-ANALYZER', {
                    error: immediateError.message,
                    status: immediateError.response?.status,
                    error_data: immediateError.response?.data
                  });
                }
              }
            } else {
              console.warn(`⚠️ [JOURNEYS-IMMEDIATE] Cannot save journeys immediately: missing pageId (${pageIdToSave}) or projectId (${projectIdToSave})`);
              console.warn(`⚠️ [JOURNEYS-IMMEDIATE] workflowState.pageId: ${workflowState.pageId}, context.page_id: ${this.context?.page_id}`);
            }
          } else {
            // Empty journeys array - log warning but don't overwrite existing journeys
            console.warn(`⚠️ [JOURNEYS] AI returned empty journeys array. Keeping existing journeys in workflowState to avoid data loss.`);
            if (jobId && this.backendLogger) {
              await this.backendLogger.appendJobLog(jobId, 'warn', `⚠️ AI returned empty journeys array but ${formsCount} form(s) and ${interactiveElementsCount} significant interactive element(s) exist on page. Keeping existing journeys.`, 'WORKFLOW-ANALYZER', {
                forms_count: formsCount,
                interactive_elements_count: interactiveElementsCount,
                existing_journeys_count: workflowState.journeys?.length || 0,
                response_keys: Object.keys(parsedResponse).join(', '),
                has_page_summary: !!parsedResponse.page_summary
              });
            }
          }
          
          // Convert journeys to legs format (extract actions from each journey)
          // CRITICAL: Ensure journey_id is stable and based on element selector/id for status updates
          
          for (let journeyIndex = 0; journeyIndex < journeys.length; journeyIndex++) {
            const journey = journeys[journeyIndex];
            
            // CRITICAL: Ensure every journey has an actions array, even if empty
            if (!journey.actions || !Array.isArray(journey.actions)) {
              console.warn(`⚠️ [JOURNEY] Journey ${journey.journey_id || journeyIndex} missing actions array, creating empty array`);
              journey.actions = [];
            }
            
            // If journey has actions, process it
            if (journey.actions.length > 0) {
              // CRITICAL: Generate stable journey_id from element selector/id if not already stable
              let stableJourneyId = journey.journey_id;
              
              // Try to match journey to a form or interactive element
              // Check if journey_id already follows our pattern (form_*, button_*, element_*)
              const isAlreadyStable = stableJourneyId && (
                stableJourneyId.startsWith('form_') || 
                stableJourneyId.startsWith('button_') || 
                stableJourneyId.startsWith('element_')
              );
              
              if (!isAlreadyStable) {
                // Try to find matching interactive group (form or interactive element)
                const firstActionSelector = journey.actions[0]?.selector || '';
                let matchingInteractiveGroup = null;
                let groupType = null; // 'form' or 'interactiveElement'
                
                // Try to match by selector to a form first
                for (const form of interactiveGroups.forms) {
                  if (form.selector && firstActionSelector.includes(form.selector.replace(/[#\.\[\]]/g, ''))) {
                    matchingInteractiveGroup = form;
                    groupType = 'form';
                    break;
                  }
                }
                
                // Try to match by selector to an interactive element if no form match
                if (!matchingInteractiveGroup) {
                  for (const element of interactiveGroups.interactiveElements) {
                    if (element.selector && firstActionSelector === element.selector) {
                      matchingInteractiveGroup = element;
                      groupType = 'interactiveElement';
                      break;
                    }
                  }
                }
                
                // Generate stable ID based on group type
                if (matchingInteractiveGroup && groupType === 'form') {
                  const formId = matchingInteractiveGroup.id || '';
                  const formSelector = matchingInteractiveGroup.selector || '';
                  const formAction = matchingInteractiveGroup.action || '';
                  
                  if (formId) {
                    stableJourneyId = `form_${formId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
                  } else if (formSelector) {
                    const selectorMatch = formSelector.match(/(?:action=['\"]([^'\"]+)['\"]|id=['\"]([^'\"]+)['\"]|#([a-zA-Z0-9_-]+)|form\[([^\]]+)\])/);
                    if (selectorMatch) {
                      const extracted = selectorMatch[1] || selectorMatch[2] || selectorMatch[3] || selectorMatch[4];
                      stableJourneyId = `form_${extracted.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30)}`;
                    } else {
                      stableJourneyId = `form_${journeyIndex}`;
                    }
                  } else if (formAction) {
                    const actionPath = formAction.split('/').pop().split('?')[0];
                    stableJourneyId = `form_${actionPath.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
                  } else {
                    stableJourneyId = `form_${journeyIndex}`;
                  }
                } else if (matchingInteractiveGroup && groupType === 'interactiveElement') {
                  const elementId = matchingInteractiveGroup.id || '';
                  const elementText = (matchingInteractiveGroup.text || '').toLowerCase().replace(/[^a-zA-Z0-9]/g, '-').substring(0, 30);
                  const elementSelector = matchingInteractiveGroup.selector || '';
                  
                  if (elementId) {
                    stableJourneyId = `button_${elementId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
                  } else if (elementText) {
                    stableJourneyId = `button_${elementText}`;
                  } else if (elementSelector) {
                    const selectorId = elementSelector.replace(/[#\.\[\]='\"]/g, '_').substring(0, 30);
                    stableJourneyId = `element_${selectorId}`;
                  } else {
                    stableJourneyId = `element_${journeyIndex}`;
                  }
                } else {
                  // Fallback: use existing journey_id if it exists, otherwise generate generic
                  stableJourneyId = stableJourneyId || `journey_${journeyIndex}`;
                }
                
                console.log(`🔧 [JOURNEY-ID] Correcting journey_id from "${journey.journey_id}" to "${stableJourneyId}" for journey at index ${journeyIndex}`);
                journey.journey_id = stableJourneyId; // Update in original journey object too
              }
              
              // Match each action to an interactive element from interactive_elements array
              // This creates the nested structure: page -> journey -> action -> interactive element
              const actionsWithElements = journey.actions.map(action => {
                // Try to find matching interactive element by selector, id, or text
                let matchingElement = null;
                
                if (action.selector) {
                  // Try exact selector match first
                  matchingElement = interactiveGroups.interactiveElements.find(el => 
                    el.selector === action.selector || 
                    el.id === action.selector.replace(/^#/, '') ||
                    (el.text && action.description && el.text.toLowerCase().includes(action.description.toLowerCase().substring(0, 20)))
                  );
                  
                  // Try partial selector match if exact match fails
                  if (!matchingElement && action.selector.includes('#')) {
                    const selectorId = action.selector.replace(/^#/, '');
                    matchingElement = interactiveGroups.interactiveElements.find(el => 
                      el.id === selectorId || 
                      (el.selector && el.selector.includes(selectorId))
                    );
                  }
                }
                
                // If still no match, try by description text
                if (!matchingElement && action.description) {
                  const actionText = action.description.toLowerCase();
                  matchingElement = interactiveGroups.interactiveElements.find(el => 
                    el.text && el.text.toLowerCase().includes(actionText.substring(0, 30))
                  );
                }
                
                // Add interactive_element reference to action
                if (matchingElement) {
                  action.interactive_element = {
                    id: matchingElement.id || null,
                    selector: matchingElement.selector || null,
                    text: matchingElement.text || null,
                    type: matchingElement.type || null,
                    name: matchingElement.name || null,
                    role: matchingElement.role || null
                  };
                }
                
                return action;
              });
              
              // Create a leg from the journey (use first action as primary, or create a combined leg)
              const journeyLeg = {
                leg_id: stableJourneyId, // Use stable journey_id as leg_id
                description: journey.description || journey.test_instructions || 'Journey from AI analysis',
                type: journey.actions[0]?.type || 'custom',
                selector: journey.actions[0]?.selector || '',
                test_instructions: journey.test_instructions || journey.description,
                expected_outcome: journey.expected_outcome,
                actions: actionsWithElements, // Store all actions with interactive_element references
                journey_id: stableJourneyId, // Store stable journey_id
                priority: journey.priority,
                confidence: journey.confidence
              };
              candidateLegs.push(journeyLeg);
            } else {
              // Journey has no actions - create a minimal leg with journey info
              console.warn(`⚠️ [JOURNEY] Journey ${journey.journey_id || journeyIndex} has no actions, creating minimal leg`);
              const minimalLeg = {
                leg_id: journey.journey_id || `journey_${journeyIndex}`,
                description: journey.description || journey.test_instructions || 'Journey from AI analysis',
                type: 'custom',
                selector: '',
                test_instructions: journey.test_instructions || journey.description || '',
                expected_outcome: journey.expected_outcome || '',
                actions: [], // Empty actions array - will be populated during execution
                journey_id: journey.journey_id || `journey_${journeyIndex}`,
                priority: journey.priority || 'medium',
                confidence: journey.confidence || 0
              };
              candidateLegs.push(minimalLeg);
            }
          }
          console.log(`[AI RESPONSE] Converted ${journeys.length} journeys to ${candidateLegs.length} legs`);
        }
        // Check if response has nested page_summary structure
        else if (parsedResponse.page_summary && parsedResponse.legs) {
          candidateLegs = Array.isArray(parsedResponse.legs) ? parsedResponse.legs : [];
        } else if (parsedResponse.legs) {
          candidateLegs = Array.isArray(parsedResponse.legs) ? parsedResponse.legs : [];
        } else if (parsedResponse.actions) {
          candidateLegs = Array.isArray(parsedResponse.actions) ? parsedResponse.actions : [];
        }
        
        // CRITICAL: If no journeys found but legs/actions exist, convert them to journeys
        if (journeys.length === 0 && candidateLegs.length > 0) {
          console.log(`🔍 [JOURNEYS-CONVERT] No journeys found but ${candidateLegs.length} leg(s)/action(s) found, converting to journeys`);
          journeys = candidateLegs.map((leg, idx) => ({
            journey_id: leg.journey_id || leg.leg_id || leg.action_id || `journey_${idx + 1}`,
            description: leg.description || leg.action_description || 'Journey',
            expected_outcome: leg.expected_outcome || leg.expected_result || 'Complete journey',
            actions: Array.isArray(leg.actions) ? leg.actions : (leg.action ? [leg.action] : []),
            priority: leg.priority || 'medium',
            confidence: leg.confidence || 0.8
          }));
          console.log(`✅ [JOURNEYS-CONVERT] Converted ${candidateLegs.length} leg(s)/action(s) to ${journeys.length} journey(s)`);
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'info', `✅ [JOURNEYS-CONVERT] Converted ${candidateLegs.length} leg(s)/action(s) to journeys`, 'WORKFLOW-ANALYZER', {
              legs_count: candidateLegs.length,
              journeys_count: journeys.length
            });
          }
          
          // CRITICAL: Store journeys in workflowState immediately after conversion
          workflowState.journeys = journeys;
          workflowState.journeysToExecute = journeys;
          if (!workflowState.context) {
            workflowState.context = {};
          }
          workflowState.context.journeysToExecute = journeys;
          this.initializeVariablePool(workflowState);
          this.saveVariable(workflowState, 'journeysToExecute', journeys, 'page', step);
          
          // Save journeys immediately after conversion
          let pageIdToSave = workflowState.pageId || this.context?.page_id || this.context?.pageId || null;
          let projectIdToSave = workflowState.projectId || this.context?.project_id || this.context?.projectId || null;
          
          if (!pageIdToSave && projectIdToSave && workflowState.pageUrl) {
            try {
              pageIdToSave = await this.ensurePageId(workflowState, jobId);
            } catch (pageError) {
              console.warn(`⚠️ [JOURNEYS-CONVERT] Failed to get pageId: ${pageError.message}`);
            }
          }
          
          if (pageIdToSave && projectIdToSave) {
            try {
              const payload = {
                saveLegs: true,
                journeys: journeys,
                job_id: jobId
              };
              
              console.log(`🔍 [JOURNEYS-CONVERT] Saving ${journeys.length} journey(s) after conversion to page ${pageIdToSave}`);
              const response = await axios.post(
                `${this.backendUrl}/api/pages/${pageIdToSave}/save-analysis`,
                payload,
                { headers: this.getAuthHeaders() }
              );
              
              console.log(`✅ [JOURNEYS-CONVERT] Successfully saved ${journeys.length} journey(s) after conversion. Response status: ${response.status}`);
              if (jobId && this.backendLogger) {
                await this.backendLogger.appendJobLog(jobId, 'info', `✅ [JOURNEYS-CONVERT] Saved ${journeys.length} journey(s) after conversion`, 'WORKFLOW-ANALYZER', {
                  journeys_count: journeys.length,
                  page_id: pageIdToSave,
                  response_status: response.status
                });
              }
            } catch (convertError) {
              console.error(`❌ [JOURNEYS-CONVERT] Failed to save journeys after conversion: ${convertError.message}`);
            }
          }
        }
        
        console.log(`[AI RESPONSE] Extracted ${candidateLegs.length} candidate legs from AI response for step ${step.id || step.name}`);
        if (candidateLegs.length > 0) {
          console.log(`[AI RESPONSE] Leg types: ${candidateLegs.map(l => l.type || l.action || 'no-type').join(', ')}`);
          console.log(`[AI RESPONSE] Leg descriptions: ${candidateLegs.map(l => (l.description || '').substring(0, 40)).join(' | ')}`);
        }
        
        
        // CRITICAL: Save journeys IMMEDIATELY and INDEPENDENTLY of legs processing
        // Journeys must be saved even if legs conversion fails or legs are empty
        console.log(`🔍 [JOURNEYS-SAVE] Checking journeys: length=${journeys.length}, isArray=${Array.isArray(journeys)}`);
        if (jobId && this.backendLogger) {
          await this.backendLogger.appendJobLog(jobId, 'info', `🔍 [JOURNEYS-SAVE] Checking journeys: length=${journeys.length}`, 'WORKFLOW-ANALYZER', {
            journeys_length: journeys.length,
            is_array: Array.isArray(journeys)
          });
        }
        if (journeys.length > 0) {
          console.log(`🔍 [JOURNEYS-SAVE] Found ${journeys.length} journey(s) to save. Journey IDs: ${journeys.map(j => j.journey_id || 'no-id').join(', ')}`);
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'info', `🔍 [JOURNEYS-SAVE] Found ${journeys.length} journey(s) to save`, 'WORKFLOW-ANALYZER', {
              journeys_count: journeys.length,
              journey_ids: journeys.map(j => j.journey_id || 'no-id')
            });
          }
          
          // CRITICAL: Workflows must be created explicitly by the user, not auto-created
          // If no workflow exists, log a warning and skip saving journeys/actions
          if (!workflowState.workflowId) {
            console.warn(`⚠️ [JOURNEYS-SAVE] No workflow_id available. Workflows must be created explicitly by the user. Skipping journey/action persistence.`);
            console.warn(`⚠️ [JOURNEYS-SAVE] To save journeys/actions, create a workflow first via the API or UI.`);
            if (jobId && this.backendLogger) {
              await this.backendLogger.appendJobLog(jobId, 'warn', `⚠️ [JOURNEYS-SAVE] No workflow_id available. Skipping journey/action persistence.`, 'WORKFLOW-ANALYZER');
            }
          }
          
          // CRITICAL: Save journeys even if workflow doesn't exist - pass page_id and project_id
          // Backend will save to page if workflow doesn't exist
          // CRITICAL: Get pageId and projectId from workflowState or context
          let pageIdToUse = workflowState.pageId || this.context?.page_id || this.context?.pageId || null;
          let projectIdToUse = workflowState.projectId || this.context?.project_id || this.context?.projectId || null;
          
          // CRITICAL: If pageId is missing, try to get or create it
          if (!pageIdToUse) {
            if (projectIdToUse && workflowState.pageUrl) {
              console.log(`🔍 [JOURNEYS-SAVE] pageId missing, attempting to get/create page for URL: ${workflowState.pageUrl}`);
              if (jobId && this.backendLogger) {
                await this.backendLogger.appendJobLog(jobId, 'info', `🔍 [JOURNEYS-SAVE] pageId missing, attempting to create page`, 'WORKFLOW-ANALYZER', {
                  page_url: workflowState.pageUrl,
                  project_id: projectIdToUse
                });
              }
              try {
                pageIdToUse = await this.ensurePageId(workflowState, jobId);
                if (pageIdToUse) {
                  console.log(`✅ [JOURNEYS-SAVE] Got pageId: ${pageIdToUse}`);
                  if (jobId && this.backendLogger) {
                    await this.backendLogger.appendJobLog(jobId, 'info', `✅ [JOURNEYS-SAVE] Created page with pageId: ${pageIdToUse}`, 'WORKFLOW-ANALYZER', {
                      page_id: pageIdToUse
                    });
                  }
                } else {
                  console.warn(`⚠️ [JOURNEYS-SAVE] ensurePageId returned null`);
                }
              } catch (pageError) {
                console.warn(`⚠️ [JOURNEYS-SAVE] Failed to get/create pageId: ${pageError.message}`);
                if (jobId && this.backendLogger) {
                  await this.backendLogger.appendJobLog(jobId, 'error', `❌ [JOURNEYS-SAVE] Failed to create page: ${pageError.message}`, 'WORKFLOW-ANALYZER', {
                    error: pageError.message
                  });
                }
              }
            } else {
              console.warn(`⚠️ [JOURNEYS-SAVE] Cannot create page: missing projectId (${projectIdToUse}) or pageUrl (${workflowState.pageUrl})`);
              if (jobId && this.backendLogger) {
                await this.backendLogger.appendJobLog(jobId, 'warn', `⚠️ [JOURNEYS-SAVE] Cannot create page: missing projectId or pageUrl`, 'WORKFLOW-ANALYZER', {
                  project_id: projectIdToUse,
                  page_url: workflowState.pageUrl
                });
              }
            }
          }
          
          console.log(`🔍 [JOURNEYS-SAVE] pageId: ${pageIdToUse}, projectId: ${projectIdToUse}, workflowState.pageId: ${workflowState.pageId}, workflowState.projectId: ${workflowState.projectId}`);
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'info', `🔍 [JOURNEYS-SAVE] Checking pageId/projectId: pageId=${pageIdToUse}, projectId=${projectIdToUse}`, 'WORKFLOW-ANALYZER', {
              page_id: pageIdToUse,
              project_id: projectIdToUse,
              workflow_state_page_id: workflowState.pageId,
              workflow_state_project_id: workflowState.projectId,
              page_url: workflowState.pageUrl
            });
          }
          
          if (pageIdToUse && projectIdToUse) {
            try {
              // Use workflowId if available, otherwise use a dummy ID (backend will detect it doesn't exist)
              const workflowIdForUrl = workflowState.workflowId || '000000000000000000000000';
              
              // CRITICAL: Verify journeys have actions before sending
              const journeysWithActions = journeys.map(j => {
                const actionsCount = Array.isArray(j.actions) ? j.actions.length : 0;
                if (actionsCount === 0) {
                  console.warn(`⚠️ [JOURNEYS-SAVE] Journey ${j.journey_id || 'no-id'} has NO actions array or empty actions array!`);
                  if (jobId && this.backendLogger) {
                    this.backendLogger.appendJobLog(jobId, 'warn', `⚠️ [JOURNEYS-SAVE] Journey ${j.journey_id || 'no-id'} has NO actions!`, 'WORKFLOW-ANALYZER', {
                      journey_id: j.journey_id || 'no-id'
                    });
                  }
                } else {
                  console.log(`✅ [JOURNEYS-SAVE] Journey ${j.journey_id || 'no-id'} has ${actionsCount} action(s)`);
                }
                return j;
              });
              
              // CRITICAL: Clean journeys to remove circular references before sending
              const cleanedJourneys = journeysWithActions.map(j => this.cleanJourneyForSave(j));
              
              const payload = {
                saveLegs: true, // CRITICAL: Must be true for backend to process journeys (backend checks: if (saveLegs && journeys.length > 0))
                journeys: cleanedJourneys,
                job_id: jobId
              };
              
              const totalActions = journeys.reduce((sum, j) => sum + (Array.isArray(j.actions) ? j.actions.length : 0), 0);
              console.log(`🔍 [JOURNEYS-SAVE] Sending POST to ${this.backendUrl}/api/pages/${workflowState.pageId}/save-analysis with ${journeys.length} journey(s)`);
              console.log(`🔍 [JOURNEYS-SAVE] Payload: saveLegs=${payload.saveLegs}, journeys.length=${payload.journeys.length}, job_id=${payload.job_id}`);
              console.log(`🔍 [JOURNEYS-SAVE] Total actions across all journeys: ${totalActions}`);
              
              if (jobId && this.backendLogger) {
                await this.backendLogger.appendJobLog(jobId, 'info', `🔍 [JOURNEYS-SAVE] Sending ${journeys.length} journey(s) with ${totalActions} total actions to backend`, 'WORKFLOW-ANALYZER', {
                  journeys_count: journeys.length,
                  total_actions: totalActions,
                  page_id: workflowState.pageId
                });
              }
              
              const response = await axios.post(
                `${this.backendUrl}/api/pages/${pageIdToUse}/save-analysis`,
                payload,
                {
                  headers: this.getAuthHeaders()
                }
              );
              
              console.log(`💾 [JOURNEYS-SAVE] ✅ Successfully saved ${journeys.length} journey(s) to page ${pageIdToUse}. Response status: ${response.status}`);
              if (jobId && this.backendLogger) {
                await this.backendLogger.appendJobLog(jobId, 'info', `💾 [JOURNEYS-SAVE] ✅ Successfully saved ${journeys.length} journey(s) to page ${pageIdToUse}. Response status: ${response.status}`, 'WORKFLOW-ANALYZER', {
                  journeys_count: journeys.length,
                  page_id: pageIdToUse,
                  response_status: response.status
                });
              }
            } catch (journeySaveError) {
              console.error(`❌ [JOURNEYS-SAVE] Failed to save journeys: ${journeySaveError.message}`);
              if (journeySaveError.response) {
                console.error(`❌ [JOURNEYS-SAVE] Response status: ${journeySaveError.response.status}, data:`, JSON.stringify(journeySaveError.response.data).substring(0, 500));
              }
              console.error(`❌ [JOURNEYS-SAVE] Stack:`, journeySaveError.stack);
              if (jobId && this.backendLogger) {
                await this.backendLogger.appendJobLog(jobId, 'error', `❌ [JOURNEYS-SAVE] Failed to save journeys: ${journeySaveError.message}`, 'WORKFLOW-ANALYZER', {
                  error: journeySaveError.message,
                  response_status: journeySaveError.response?.status,
                  response_data: journeySaveError.response?.data ? JSON.stringify(journeySaveError.response.data).substring(0, 500) : null
                });
              }
            }
          } else {
            console.warn(`⚠️ [JOURNEYS-SAVE] Cannot save journeys: missing pageId (${pageIdToUse}) or projectId (${projectIdToUse})`);
            if (jobId && this.backendLogger) {
              await this.backendLogger.appendJobLog(jobId, 'warn', `⚠️ [JOURNEYS-SAVE] Cannot save journeys: missing pageId or projectId`, 'WORKFLOW-ANALYZER', {
                page_id: pageIdToUse,
                project_id: projectIdToUse,
                workflow_state_page_id: workflowState.pageId,
                workflow_state_project_id: workflowState.projectId,
                context_page_id: this.context?.page_id,
                context_project_id: this.context?.project_id
              });
            }
          }
        } else {
          console.log(`⚠️ [JOURNEYS-SAVE] No journeys to save (journeys.length=${journeys.length}). This is OK if AI didn't return journeys.`);
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'warn', `⚠️ [JOURNEYS-SAVE] No journeys to save (length=${journeys.length})`, 'WORKFLOW-ANALYZER', {
              journeys_length: journeys.length
            });
          }
        }
        
        if (candidateLegs.length > 0) {
          console.log(`🔍 Found ${candidateLegs.length} journey(s) in AI response, normalizing and storing`);
          const normalizedLegs = await this.applyLegsToWorkflowState(candidateLegs, workflowState, 'ai-prompt');
          console.log(`✅ Stored ${normalizedLegs.length} journey(s) in workflowState.context.legsToExecute (after deduplication)`);
          
          // CRITICAL: Also store legs in the structured result so it's accessible from step result
          // The structured result will be stored by storeStepResult, but we need to ensure legs are extractable
          // Store legs in variable pool with namespace 'page' for for-each access
          this.initializeVariablePool(workflowState);
          workflowState.variablePool.page['legsToExecute'] = {
            value: normalizedLegs,
            savedAt: new Date().toISOString(),
            stepSlug: step.slug,
            stepName: step.name
          };
          
          // CRITICAL: Save legs immediately to workflow database so they're visible right away
          if (normalizedLegs.length > 0) {
            // Set status to 'discovered' for newly discovered actions
            normalizedLegs.forEach(leg => {
              if (!leg.status) {
                leg.status = 'discovered';
              }
            });
            
            // CRITICAL: Workflows must be created explicitly by the user, not auto-created
            // If no workflow exists, log a warning and skip saving legs/actions
            if (!workflowState.workflowId) {
              console.warn(`⚠️ [AI-PROMPT] No workflow_id available. Workflows must be created explicitly by the user. Skipping leg/action persistence.`);
              console.warn(`⚠️ [AI-PROMPT] To save legs/actions, create a workflow first via the API or UI.`);
            }
            
            // Save legs immediately to workflow
            // CRITICAL: normalizedLegs is already deduplicated (it's the return value from applyLegsToWorkflowState which returns finalLegs)
            if (workflowState.workflowId) {
              try {
                await this.saveLegIterationsToWorkflow(workflowState, normalizedLegs, jobId);
                console.log(`💾 Immediately saved ${normalizedLegs.length} action(s) to workflow ${workflowState.workflowId} with status 'discovered' (after deduplication)`);
              } catch (saveError) {
                console.warn(`⚠️ Failed to immediately save legs: ${saveError.message}`);
              }
            } else {
              console.log(`⏳ Legs collected but workflowId not yet available - will save when workflow is created`);
            }
          }
          
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'info', `📋 Found ${normalizedLegs.length} action(s) from AI Page Intelligence${workflowState.workflowId ? ' (saved to workflow)' : ' (pending workflow creation)'}`, 'WORKFLOW-ANALYZER', {
              total_legs: normalizedLegs.length,
              legs: normalizedLegs.map(l => ({ leg_id: l.leg_id, type: l.type, description: l.description?.substring(0, 100) })),
              workflow_id: workflowState.workflowId || null
            });
          }
        } else {
          console.log(`⚠️ No journeys found in AI response`);
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'warn', `⚠️ No legs found in AI response. Response keys: ${parsedResponse && typeof parsedResponse === 'object' ? Object.keys(parsedResponse).join(', ') : 'invalid'}`, 'WORKFLOW-ANALYZER');
          }
        }
      }
      
      // Store response in workflow state (legacy key and slug-based)
      workflowState[`${step.name}_response`] = parsedResponse;
      
      // CRITICAL: For generate_login_script step, extract playwright_script BEFORE storeStepResult
      // This ensures we have the raw value before it gets structured
      // Note: The code at line 3200-3207 already stores it as legScriptToExecute, but we also store as playwright_script for direct access
      if (step.id === 'generate_login_script' || step.name?.includes('Generate Login Script')) {
        const scriptValue = parsedResponse.playwright_script;
        if (scriptValue) {
          // Store playwright_script directly in page namespace for easy access
          this.initializeVariablePool(workflowState);
          this.saveVariable(workflowState, 'playwright_script', scriptValue, 'page', step);
          // Also store directly in workflowState for immediate access
          workflowState.playwright_script = scriptValue;
          // Also ensure legScriptToExecute is set (the code at line 3200-3207 does this, but ensure it's available)
          const cleanedScript = this.cleanScript(scriptValue);
          if (cleanedScript && cleanedScript.trim().length > 0) {
            workflowState.legScriptToExecute = cleanedScript;
            if (!workflowState.context) {
              workflowState.context = {};
            }
            workflowState.context.legScriptToExecute = cleanedScript;
          }
          console.log(`✅ Extracted playwright_script to page namespace, workflowState, and legScriptToExecute: ${(typeof scriptValue === 'string' ? scriptValue : String(scriptValue || '')).substring(0, 100)}...`);
        } else {
          console.warn(`⚠️ playwright_script not found in generate_login_script result. Keys: ${Object.keys(parsedResponse || {}).join(', ')}`);
        }
      }
      
      // CRITICAL: Ensure journeys are in parsedResponse before storing
      // If journeys were extracted and stored in workflowState, add them back to parsedResponse
      // This ensures journeys are preserved in the step result
      if (workflowState.journeys && Array.isArray(workflowState.journeys) && workflowState.journeys.length > 0) {
        if (!parsedResponse.journeys || !Array.isArray(parsedResponse.journeys) || parsedResponse.journeys.length === 0) {
          parsedResponse.journeys = workflowState.journeys;
          console.log(`✅ [JOURNEYS-RESTORE] Restored ${workflowState.journeys.length} journey(s) to parsedResponse before storing step result`);
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'info', `✅ [JOURNEYS-RESTORE] Restored ${workflowState.journeys.length} journey(s) to parsedResponse`, 'WORKFLOW-ANALYZER', {
              journeys_count: workflowState.journeys.length
            });
          }
        }
      }
      
      // CRITICAL: If journeys exist in workflowState but weren't saved yet, save them now
      // This is a fallback to ensure journeys are saved even if the earlier save code didn't execute
      if (workflowState.journeys && Array.isArray(workflowState.journeys) && workflowState.journeys.length > 0) {
        const pageIdToUse = workflowState.pageId || this.context?.page_id || this.context?.pageId || null;
        const projectIdToUse = workflowState.projectId || this.context?.project_id || this.context?.projectId || null;
        
        // Check if journeys were already saved by checking if page has journeys
        let needsSave = true;
        if (pageIdToUse) {
          try {
            const pageCheckResponse = await axios.get(
              `${this.backendUrl}/api/pages/${pageIdToUse}`,
              { headers: this.getAuthHeaders() }
            );
            if (pageCheckResponse.data && pageCheckResponse.data.journeys && Array.isArray(pageCheckResponse.data.journeys) && pageCheckResponse.data.journeys.length > 0) {
              needsSave = false;
              console.log(`✅ [JOURNEYS-FALLBACK] Journeys already saved to page (${pageCheckResponse.data.journeys.length} journeys found)`);
            }
          } catch (checkError) {
            // Page might not exist yet, continue with save
            console.log(`🔍 [JOURNEYS-FALLBACK] Could not check page (might not exist yet): ${checkError.message}`);
          }
        }
        
        if (needsSave && pageIdToUse && projectIdToUse) {
          console.log(`🔍 [JOURNEYS-FALLBACK] Saving ${workflowState.journeys.length} journey(s) as fallback (pageId: ${pageIdToUse})`);
          try {
            // CRITICAL: Clean journeys to remove circular references before sending
            const cleanedJourneys = workflowState.journeys.map(j => this.cleanJourneyForSave(j));
            
            const payload = {
              saveLegs: true,
              journeys: cleanedJourneys,
              job_id: jobId
            };
            
            const response = await axios.post(
              `${this.backendUrl}/api/pages/${pageIdToUse}/save-analysis`,
              payload,
              { headers: this.getAuthHeaders() }
            );
            
            console.log(`✅ [JOURNEYS-FALLBACK] Successfully saved ${workflowState.journeys.length} journey(s) to page ${pageIdToUse}. Response status: ${response.status}`);
            if (jobId && this.backendLogger) {
              await this.backendLogger.appendJobLog(jobId, 'info', `✅ [JOURNEYS-FALLBACK] Saved ${workflowState.journeys.length} journey(s) to page`, 'WORKFLOW-ANALYZER', {
                journeys_count: workflowState.journeys.length,
                page_id: pageIdToUse,
                response_status: response.status
              });
            }
          } catch (fallbackError) {
            console.error(`❌ [JOURNEYS-FALLBACK] Failed to save journeys: ${fallbackError.message}`);
            if (jobId && this.backendLogger) {
              await this.backendLogger.appendJobLog(jobId, 'error', `❌ [JOURNEYS-FALLBACK] Failed to save journeys: ${fallbackError.message}`, 'WORKFLOW-ANALYZER', {
                error: fallbackError.message
              });
            }
          }
        } else if (needsSave) {
          console.warn(`⚠️ [JOURNEYS-FALLBACK] Cannot save journeys: missing pageId (${pageIdToUse}) or projectId (${projectIdToUse})`);
        }
      }
      
      // Store result - storeStepResult will structure it according to schema
      this.storeStepResult(step, parsedResponse, workflowState);
      
      // CRITICAL: After storing step result, ensure journeys are saved to backend
      // This is a final safety net to ensure journeys are saved even if earlier save attempts failed
      // Check both workflowState.journeys and variablePool for journeys (variableOutputs might have extracted them)
      let journeysToSave = workflowState.journeys || null;
      if (!journeysToSave || journeysToSave.length === 0) {
        // Check variablePool for journeys extracted by variableOutputs
        const journeysVar = this.readVariable(workflowState, 'journeysToExecute', 'page');
        if (journeysVar && Array.isArray(journeysVar) && journeysVar.length > 0) {
          journeysToSave = journeysVar;
          console.log(`🔍 [JOURNEYS-FINAL] Found ${journeysVar.length} journey(s) in variablePool, using those for save`);
          // Update workflowState for consistency
          workflowState.journeys = journeysVar;
          workflowState.journeysToExecute = journeysVar;
        }
      }
      
      if (journeysToSave && Array.isArray(journeysToSave) && journeysToSave.length > 0) {
        // Get pageId and projectId
        let pageIdToUse = workflowState.pageId || this.context?.page_id || this.context?.pageId || null;
        let projectIdToUse = workflowState.projectId || this.context?.project_id || this.context?.projectId || null;
        
        // Try to get pageId if missing
        if (!pageIdToUse && projectIdToUse && workflowState.pageUrl) {
          try {
            pageIdToUse = await this.ensurePageId(workflowState, jobId);
          } catch (pageError) {
            console.warn(`⚠️ [JOURNEYS-FINAL] Failed to get pageId: ${pageError.message}`);
          }
        }
        
        if (pageIdToUse && projectIdToUse) {
          // Check if journeys were already saved
          try {
            const pageCheckResponse = await axios.get(
              `${this.backendUrl}/api/pages/${pageIdToUse}`,
              { headers: this.getAuthHeaders() }
            );
            const existingJourneys = pageCheckResponse.data?.journeys || [];
            const existingJourneyIds = new Set(existingJourneys.map(j => j.journey_id));
            const newJourneys = journeysToSave.filter(j => !existingJourneyIds.has(j.journey_id));
            
            if (newJourneys.length > 0) {
              console.log(`🔍 [JOURNEYS-FINAL] Saving ${newJourneys.length} new journey(s) to page ${pageIdToUse} (${existingJourneys.length} already exist)`);
              try {
                const payload = {
                  saveLegs: true,
                  journeys: newJourneys,
                  job_id: jobId
                };
                
                const response = await axios.post(
                  `${this.backendUrl}/api/pages/${pageIdToUse}/save-analysis`,
                  payload,
                  { headers: this.getAuthHeaders() }
                );
                
                console.log(`✅ [JOURNEYS-FINAL] Successfully saved ${newJourneys.length} journey(s) to page ${pageIdToUse}. Response status: ${response.status}`);
                if (jobId && this.backendLogger) {
                  await this.backendLogger.appendJobLog(jobId, 'info', `✅ [JOURNEYS-FINAL] Saved ${newJourneys.length} journey(s) to page`, 'WORKFLOW-ANALYZER', {
                    journeys_count: newJourneys.length,
                    page_id: pageIdToUse,
                    response_status: response.status
                  });
                }
              } catch (finalError) {
                console.error(`❌ [JOURNEYS-FINAL] Failed to save journeys: ${finalError.message}`);
                if (jobId && this.backendLogger) {
                  await this.backendLogger.appendJobLog(jobId, 'error', `❌ [JOURNEYS-FINAL] Failed to save journeys: ${finalError.message}`, 'WORKFLOW-ANALYZER', {
                    error: finalError.message
                  });
                }
              }
            } else {
              console.log(`✅ [JOURNEYS-FINAL] All ${journeysToSave.length} journey(s) already exist on page`);
            }
          } catch (checkError) {
            // Page might not exist, try to save anyway
            console.log(`🔍 [JOURNEYS-FINAL] Could not check page, attempting to save ${journeysToSave.length} journey(s)`);
            try {
              const payload = {
                saveLegs: true,
                journeys: journeysToSave,
                job_id: jobId
              };
              
              const response = await axios.post(
                `${this.backendUrl}/api/pages/${pageIdToUse}/save-analysis`,
                payload,
                { headers: this.getAuthHeaders() }
              );
              
              console.log(`✅ [JOURNEYS-FINAL] Successfully saved ${journeysToSave.length} journey(s) to page ${pageIdToUse}. Response status: ${response.status}`);
            } catch (finalError) {
              console.error(`❌ [JOURNEYS-FINAL] Failed to save journeys: ${finalError.message}`);
            }
          }
        } else {
          console.warn(`⚠️ [JOURNEYS-FINAL] Cannot save journeys: missing pageId (${pageIdToUse}) or projectId (${projectIdToUse})`);
        }
      }

      // CRITICAL: Final save of journeys at the end of AI prompt step execution
      // This ensures journeys are saved even if earlier save attempts failed
      // Check all possible locations for journeys
      let finalJourneysToSave = workflowState.journeys || null;
      if (!finalJourneysToSave || finalJourneysToSave.length === 0) {
        // Check variablePool
        const journeysVar = this.readVariable(workflowState, 'journeysToExecute', 'page');
        if (journeysVar && Array.isArray(journeysVar) && journeysVar.length > 0) {
          finalJourneysToSave = journeysVar;
        }
      }
      if (!finalJourneysToSave || finalJourneysToSave.length === 0) {
        // Check context
        if (workflowState.context?.journeysToExecute && Array.isArray(workflowState.context.journeysToExecute) && workflowState.context.journeysToExecute.length > 0) {
          finalJourneysToSave = workflowState.context.journeysToExecute;
        }
      }
      
      if (finalJourneysToSave && Array.isArray(finalJourneysToSave) && finalJourneysToSave.length > 0) {
        // Get pageId and projectId
        let pageIdFinal = workflowState.pageId || this.context?.page_id || this.context?.pageId || null;
        let projectIdFinal = workflowState.projectId || this.context?.project_id || this.context?.projectId || null;
        
        // Try to get pageId if missing
        if (!pageIdFinal && projectIdFinal && workflowState.pageUrl) {
          try {
            pageIdFinal = await this.ensurePageId(workflowState, jobId);
          } catch (pageError) {
            console.warn(`⚠️ [AI-PROMPT-END] Failed to get pageId: ${pageError.message}`);
          }
        }
        
        if (pageIdFinal && projectIdFinal) {
          try {
            // Check if journeys already exist
            try {
              const pageCheck = await axios.get(
                `${this.backendUrl}/api/pages/${pageIdFinal}`,
                { headers: this.getAuthHeaders() }
              );
              const existing = pageCheck.data?.journeys || [];
              const existingIds = new Set(existing.map(j => j.journey_id));
              const newOnes = finalJourneysToSave.filter(j => !existingIds.has(j.journey_id));
              
              if (newOnes.length > 0) {
                console.log(`🔍 [AI-PROMPT-END] Saving ${newOnes.length} new journey(s) at end of AI prompt step`);
                const payload = {
                  saveLegs: true,
                  journeys: newOnes,
                  job_id: jobId
                };
                
                const response = await axios.post(
                  `${this.backendUrl}/api/pages/${pageIdFinal}/save-analysis`,
                  payload,
                  { headers: this.getAuthHeaders() }
                );
                
                console.log(`✅ [AI-PROMPT-END] Successfully saved ${newOnes.length} journey(s). Response status: ${response.status}`);
                if (jobId && this.backendLogger) {
                  await this.backendLogger.appendJobLog(jobId, 'info', `✅ [AI-PROMPT-END] Saved ${newOnes.length} journey(s) at end of AI prompt step`, 'WORKFLOW-ANALYZER', {
                    journeys_count: newOnes.length,
                    page_id: pageIdFinal,
                    response_status: response.status
                  });
                }
              } else {
                console.log(`✅ [AI-PROMPT-END] All ${finalJourneysToSave.length} journey(s) already exist on page`);
              }
            } catch (checkErr) {
              // Page might not exist, save anyway
              console.log(`🔍 [AI-PROMPT-END] Could not check page, saving ${finalJourneysToSave.length} journey(s) anyway`);
              const payload = {
                saveLegs: true,
                journeys: finalJourneysToSave,
                job_id: jobId
              };
              
              const response = await axios.post(
                `${this.backendUrl}/api/pages/${pageIdFinal}/save-analysis`,
                payload,
                { headers: this.getAuthHeaders() }
              );
              
              console.log(`✅ [AI-PROMPT-END] Successfully saved ${finalJourneysToSave.length} journey(s). Response status: ${response.status}`);
              if (jobId && this.backendLogger) {
                await this.backendLogger.appendJobLog(jobId, 'info', `✅ [AI-PROMPT-END] Saved ${finalJourneysToSave.length} journey(s)`, 'WORKFLOW-ANALYZER', {
                  journeys_count: finalJourneysToSave.length,
                  page_id: pageIdFinal,
                  response_status: response.status
                });
              }
            }
          } catch (endError) {
            console.error(`❌ [AI-PROMPT-END] Failed to save journeys: ${endError.message}`);
            if (jobId && this.backendLogger) {
              await this.backendLogger.appendJobLog(jobId, 'error', `❌ [AI-PROMPT-END] Failed to save journeys: ${endError.message}`, 'WORKFLOW-ANALYZER', {
                error: endError.message
              });
            }
          }
        } else {
          console.warn(`⚠️ [AI-PROMPT-END] Cannot save journeys: missing pageId (${pageIdFinal}) or projectId (${projectIdFinal})`);
        }
      } else {
        console.warn(`⚠️ [AI-PROMPT-END] No journeys found to save (finalJourneysToSave=${finalJourneysToSave ? finalJourneysToSave.length : 'null'})`);
      }
      
      // CRITICAL: For determine_completion step, also store directly by ID for easy access
      if (step.id === 'determine_completion' || step.name?.includes('Determine Login Progress')) {
        // Validate that status field is present
        if (!parsedResponse.status && !parsedResponse.completion_status && parsedResponse.is_complete === undefined) {
          console.error(`❌ ERROR: determine_completion response missing status field!`);
          console.error(`Response keys: ${Object.keys(parsedResponse).join(', ')}`);
          console.error(`Full response:`, JSON.stringify(parsedResponse, null, 2).substring(0, 1000));
          
          // Set a default status if missing
          parsedResponse.status = parsedResponse.completion_status || 'stuck';
          console.warn(`⚠️ Set default status to: ${parsedResponse.status}`);
          
          if (jobId) {
            await this.sendLogToBackend(jobId, 'error', 
              `❌ determine_completion response missing status field. Defaulting to '${parsedResponse.status}'`, 
              'WORKFLOW-ANALYZER', {
                step_id: step.id,
                response_keys: Object.keys(parsedResponse),
                defaulted_status: parsedResponse.status
              }
            );
          }
        }
        
        if (!workflowState.determine_completion) {
          workflowState.determine_completion = {};
        }
        workflowState.determine_completion.result = parsedResponse;
        
        if (!workflowState.results) {
          workflowState.results = {};
        }
        if (!workflowState.results.determine_completion) {
          workflowState.results.determine_completion = {};
        }
        workflowState.results.determine_completion.result = parsedResponse;
        
        // Also store directly by step ID for easy access
        workflowState[step.id] = { result: parsedResponse };
        
        // CRITICAL: Also store in variablePool.steps for condition path resolution
        if (!workflowState.variablePool) {
          workflowState.variablePool = { steps: {} };
        }
        if (!workflowState.variablePool.steps) {
          workflowState.variablePool.steps = {};
        }
        workflowState.variablePool.steps[step.id] = { result: parsedResponse };
        
        workflowState.variablePool.steps['determine_completion'] = { result: parsedResponse }; // Also store by name
        
        console.log(`✅ Stored determine_completion result: status=${parsedResponse?.status || parsedResponse?.completion_status || 'none'}`);
        console.log(`📄 Stored in: workflowState.determine_completion.result, workflowState.results.determine_completion.result, workflowState[${step.id}].result, workflowState.variablePool.steps[${step.id}].result`);
        
        // CRITICAL: Allow step result to signal workflow should stop
        // This is workflow-driven: any step can set stopWorkflow in its result
        // The workflow template controls when to stop by configuring steps appropriately
        if (parsedResponse.stopWorkflow === true || parsedResponse.stop_workflow === true) {
          workflowState.stopWorkflow = true;
          console.log(`🛑 Step "${step.name || step.id}" signaled workflow should stop`);
        }
      }
      
      const logPreview = typeof aiResponse === 'string' ? aiResponse.substring(0, 100) : JSON.stringify(parsedResponse).substring(0, 100);
      console.log(`✅ AI prompt completed: ${logPreview}...`);
    } catch (aiError) {
      console.error(`❌ AI prompt failed: ${aiError.message}`);
      
      // CRITICAL: Even if AI call fails/times out, ensure journeys are saved if they were extracted
      // Check if journeys were extracted before the error occurred
      if (workflowState.journeys && Array.isArray(workflowState.journeys) && workflowState.journeys.length > 0) {
        console.log(`⚠️ [JOURNEYS-TIMEOUT] AI step failed but ${workflowState.journeys.length} journey(s) were already extracted. Ensuring they're saved.`);
        
        // Ensure journeysToExecute is set
        if (!workflowState.journeysToExecute) {
          workflowState.journeysToExecute = workflowState.journeys;
        }
        
        // Ensure variable pool has journeysToExecute
        this.initializeVariablePool(workflowState);
        this.saveVariable(workflowState, 'journeysToExecute', workflowState.journeys, 'page', step);
        
        // Try to save journeys to backend if workflowId exists
        if (workflowState.pageId) {
          try {
            const payload = {
              saveLegs: true,
              journeys: workflowState.journeys,
              job_id: jobId
            };
            
            await axios.post(
              `${this.backendUrl}/api/pages/${workflowState.pageId}/save-analysis`,
              payload,
              {
                headers: this.getAuthHeaders(),
                timeout: 10000 // 10 second timeout for save operation
              }
            );
            
            console.log(`✅ [JOURNEYS-TIMEOUT] Saved ${workflowState.journeys.length} journey(s) despite AI step failure`);
          } catch (saveError) {
            console.warn(`⚠️ [JOURNEYS-TIMEOUT] Failed to save journeys after timeout: ${saveError.message}`);
          }
        }
      }
      
      throw aiError;
    }
  }

  /**
   * Execute workflow analysis step
   */
  async executeWorkflowAnalysisStep(page, step, workflowState, jobId, stepContext = null) {
    // CRITICAL: Skip workflow analysis for login jobs - they don't need legs
    const isLoginJob = workflowState.jobType === 'login' || 
                       this.context?.jobType === 'login' || 
                       this.context?.job_type === 'login' ||
                       this.context?.isLoginJob === true ||
                       workflowState?.variablePool?.job?.isLoginJob === true ||
                       workflowState?.variablePool?.job?.jobType === 'login';
    
    if (isLoginJob) {
      console.log(`⏭️ Skipping workflow analysis step for login job (login jobs don't analyze legs)`);
      await this.sendLogToBackend(jobId, 'info', `⏭️ Skipping workflow analysis step (login jobs do not analyze legs)`, 'WORKFLOW-ANALYZER', {
        step_id: step.id,
        step_name: step.name,
        step_type: step.type,
        reason: 'Login jobs only authenticate, they do not generate test legs'
      });
      return; // Skip the entire workflow analysis step
    }
    
    console.log(`🔍 Performing workflow analysis (${step.name})`);
    
    // Prompt template MUST be embedded directly in step config
    const customTemplate = step.config?.template || step.config?.user_message_template || null;
    
    if (!customTemplate) {
      throw new Error(`No embedded prompt template found in workflow step "${step.name || step.id}". All prompts must be embedded in workflow step configs.`);
    }
    
    const promptIdentifier = step.id || step.name || 'workflow-analysis';
    const promptSource = 'workflow-step';
    const contextInfo = this.resolveStepContext(step, stepContext, this.workflowTemplate?.steps);
    const requirementText = contextInfo.requirementText;
    const decoratedTemplate = appendRequirementToTemplate(customTemplate, requirementText);
    const templateForExecution = this.enforceLegInstructionsInTemplate(decoratedTemplate);

    const legsFromPageSummary = Array.isArray(workflowState.pageDescription?.legs)
      ? workflowState.pageDescription.legs
      : null;

    const summaryLegCount = legsFromPageSummary ? legsFromPageSummary.length : 0;
    const existingLegCount = Array.isArray(workflowState.legs) ? workflowState.legs.length : 0;
    console.log(`♻️ Summary legs count before workflow-analysis: ${summaryLegCount} (existing legs: ${existingLegCount}, source: ${workflowState.legsSource || 'none'})`);

    if (legsFromPageSummary && legsFromPageSummary.length > 0) {
      // Only apply legs from page summary if we don't already have legs, or if existing legs are from a different source
      // BUT skip if legs are already from page-summary to avoid duplicates
      const shouldApplyLegs = (!Array.isArray(workflowState.legs) || workflowState.legs.length === 0) || 
                              (workflowState.legsSource && workflowState.legsSource !== 'page-summary');
      
      if (shouldApplyLegs) {
        await this.applyLegsToWorkflowState(legsFromPageSummary, workflowState, 'page-summary');
        console.log(`♻️ Applied ${workflowState.legs.length} legs from page summary; skipping additional workflow-analysis request`);
      } else {
        // Legs already from page-summary, skip to avoid duplicates
        console.log(`♻️ Legs already from page-summary (${workflowState.legs.length} legs), skipping duplicate application`);
      }
      
      // Workflows must be explicitly created - no auto-creation
      
      workflowState.aiAnalysisResult = workflowState.aiAnalysisResult || {};
      workflowState.aiAnalysisResult.page_description = workflowState.aiAnalysisResult.page_description || workflowState.pageDescription || null;
      workflowState.aiAnalysisResult.legs = workflowState.legs;
      workflowState.aiAnalysisResult.source = workflowState.aiAnalysisResult.source || 'page-summary';
      this.storeStepResult(step, {
        legs: workflowState.legs,
        reusedFrom: 'page-summary'
      }, workflowState);

      await this.logStepOutcome(
        step,
        jobId,
        `🧠 [WORKFLOW-ANALYSIS] Reused ${workflowState.legs.length} legs from page summary${workflowState.workflowId ? ` (workflow: ${workflowState.workflowId})` : ''}`,
        {
          legs_count: workflowState.legs.length,
          reused_from: 'page-summary',
          workflow_id: workflowState.workflowId
        }
      );
      return;
    }
    
    // Prepare playbook data as JSON strings (trimmed to reasonable sizes for prompts)
    const formsData = Array.isArray(workflowState.playwrightAnalysis?.forms)
      ? workflowState.playwrightAnalysis.forms.slice(0, 20)
      : [];
    const interactiveData = Array.isArray(workflowState.playwrightAnalysis?.interactive_elements)
      ? workflowState.playwrightAnalysis.interactive_elements.slice(0, 30)
      : [];
    const linksData = Array.isArray(workflowState.playwrightAnalysis?.links)
      ? workflowState.playwrightAnalysis.links.slice(0, 40)
      : [];

    const interactiveElementsJson = JSON.stringify({
      forms: formsData,
      interactive_elements: interactiveData,
      links: linksData
    }, null, 2);
    
    const optimizedPayload = {
      page_url: workflowState.pageUrl,
      page_title: workflowState.pageTitle,
      page_description: workflowState.pageDescription,
      interactive_elements_json: interactiveElementsJson,
      forms_json: JSON.stringify(formsData, null, 2),
      links_json: JSON.stringify(linksData, null, 2),
      conversation_history: workflowState.conversationHistory,
      additional_prompt_text: this.context.additional_prompt_text || ''
    };
    
    // Log prompt usage with step information
    const currentStepIndex = contextInfo.stepIndex !== null ? contextInfo.stepIndex : (this.workflowTemplate?.steps?.findIndex(s => s.id === step.id || s.name === step.name) ?? -1);
    await this.logPromptUsage(promptIdentifier, promptSource, templateForExecution, optimizedPayload, {
      step: step,
      stepIndex: currentStepIndex >= 0 ? currentStepIndex : (this.workflowTemplate?.steps?.findIndex(s => s.type === step.type) ?? -1),
      totalSteps: this.workflowTemplate?.steps?.length
    });
    
    try {
      workflowState.aiAnalysisResult = await this.aiLogger.makeAICallWithPrompt(
        promptIdentifier,
        optimizedPayload,
        jobId,
        'workflow-analyzer',
        workflowState.pageUrl,
        null,
        optimizedPayload,
        templateForExecution // Pass decorated template (required - no fallback to database)
      );
      
      if (workflowState.aiAnalysisResult && Array.isArray(workflowState.aiAnalysisResult.legs)) {
        const normalizedLegs = await this.applyLegsToWorkflowState(
          workflowState.aiAnalysisResult.legs,
          workflowState,
          step.id || 'workflow-analysis'
        );

        if (normalizedLegs.length === 0) {
          throw new Error('OpenAI did not return valid workflow legs');
        }

        workflowState.aiAnalysisResult.legs = normalizedLegs;
        console.log(`✅ Workflow analysis completed: ${normalizedLegs.length} legs identified`);
        
        // Workflows must be explicitly created - no auto-creation
        
        this.storeStepResult(step, {
          legs: normalizedLegs,
          aiAnalysis: workflowState.aiAnalysisResult
        }, workflowState);

        await this.logStepOutcome(
          step,
          jobId,
          `🧠 [WORKFLOW-ANALYSIS] Identified ${normalizedLegs.length} workflow legs${workflowState.workflowId ? ` (workflow: ${workflowState.workflowId})` : ''}`,
          {
            legs_count: normalizedLegs.length,
            sample_legs: normalizedLegs.slice(0, 3).map(leg => leg.description || leg.type || 'leg'),
            workflow_id: workflowState.workflowId
          }
        );
      } else {
        throw new Error('OpenAI did not return valid workflow legs');
      }
    } catch (error) {
      console.error(`❌ Workflow analysis failed: ${error.message}`);
      throw error;
    }
  }


  /**
   * Execute update workflow step
   */
  async executeUpdateWorkflowStep(step, workflowState, jobId) {
    console.log(`📝 Updating workflow with analysis (${step.name})`);
    
    if (!workflowState.workflowId) {
      throw new Error('No workflow ID available for update');
    }
    
    try {
      const createActions = step.config?.createActions !== false;

      const hasExistingLegs = Array.isArray(workflowState.legs) && workflowState.legs.length > 0;
      const canGenerateFromAnalysis = !!workflowState.playwrightAnalysis;

      if (!hasExistingLegs) {
        workflowState.legs = [];
      }

      if (!workflowState.aiAnalysisResult) {
        workflowState.aiAnalysisResult = {
          page_description: workflowState.pageDescription || null,
          legs: workflowState.legs
        };
      } else {
        if (!workflowState.aiAnalysisResult.legs && workflowState.legs) {
          workflowState.aiAnalysisResult.legs = workflowState.legs;
        }
        if (!workflowState.aiAnalysisResult.page_description && workflowState.pageDescription) {
          workflowState.aiAnalysisResult.page_description = workflowState.pageDescription;
        }
      }

      const updateResult = await this.updateWorkflowWithAnalysis(
        workflowState.workflowId,
        workflowState.aiAnalysisResult?.page_description || workflowState.pageDescription,
        workflowState.legs,
        createActions,
        jobId  // Pass jobId so actions are linked to the current job
      );
      console.log(`✅ Workflow updated with analysis${createActions ? ' (actions created immediately)' : ''}`);

      if (updateResult?.legs && Array.isArray(updateResult.legs)) {
        workflowState.legs = updateResult.legs;
      }

      workflowState.actionsSummary = this.buildActionsSummary(workflowState.legs);
      
      // CRITICAL: Update page discovery immediately after actions are created
      // This ensures the page shows the latest analysis and action count
      if (workflowState.pageId && workflowState.projectId) {
        try {
          await this.updatePageDiscovery(
            jobId,
            workflowState.pageId,
            workflowState.projectId,
            workflowState.pageUrl,
            {
              title: workflowState.pageTitle,
              workflow_id: workflowState.workflowId,
              page_description: workflowState.aiAnalysisResult?.page_description || workflowState.pageDescription,
              analyzed: true,
              ai_analysis: workflowState.aiAnalysisResult,
              actions_summary: workflowState.actionsSummary,
              // CRITICAL: Include forms with fields so UI can display input counts
              forms: workflowState.playwrightAnalysis?.forms || [],
              interactive_elements: workflowState.playwrightAnalysis?.interactive_elements || [],
              links: workflowState.playwrightAnalysis?.links || [],
              // CRITICAL: Also include in ai_analysis so extraction logic can find them
              ai_analysis: {
                ...(workflowState.aiAnalysisResult || {}),
                forms: workflowState.playwrightAnalysis?.forms || [],
                interactive_elements: workflowState.playwrightAnalysis?.interactive_elements || [],
                links: workflowState.playwrightAnalysis?.links || []
              }
            }
          );
          console.log(`✅ Page discovery updated with analysis and actions`);
        } catch (discoveryError) {
          console.warn(`⚠️ Failed to update page discovery: ${discoveryError.message}`);
          // Don't fail the workflow if page discovery update fails
        }
      }

      this.storeStepResult(step, {
        workflowId: workflowState.workflowId,
        legsUpdated: workflowState.legs?.length || 0,
        createActions,
        updateResult,
        actionsSummary: workflowState.actionsSummary
      }, workflowState);

      await this.logStepOutcome(
        step,
        jobId,
        `📝 [UPDATE-WORKFLOW] Updated workflow ${workflowState.workflowId} (${workflowState.legs?.length || 0} legs, actions: ${createActions ? 'enabled' : 'skipped'})`,
        {
          workflow_id: workflowState.workflowId,
          legs_count: workflowState.legs?.length || 0,
          actions_created: createActions,
          response_has_legs: Array.isArray(updateResult?.legs),
          actions_summary: workflowState.actionsSummary || null
        }
      );
    } catch (error) {
      console.error(`❌ Failed to update workflow: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute page discovery step
   */
  async executePageDiscoveryStep(step, workflowState, jobId, pageId, projectId) {
    console.log(`📡 Updating page discovery (${step.name})`);
    
    const config = step.config || {};
    const includeContent = config.includeContent !== false;
    const includeForms = config.includeForms !== false;
    const includeLinks = config.includeLinks !== false;
    const includeInteractive = config.includeInteractiveElements !== false;
    const includeNonInteractive = config.includeNonInteractiveElements !== false;
    const includeDescription = config.includePageDescription !== false;
    const includeVisibleText = config.includeVisibleText !== false;
    const includeScreenshot = config.includeScreenshot !== false;
    const markAsAnalyzed = config.markAsAnalyzed !== false;
    const includeAiAnalysis = config.includeAiAnalysis !== false;
    const includeActions = config.includeActions === true;
    const actionsScope = config.actionsScope || 'all';
    const saveLegsData = config.saveLegsData === true;
    
    const discoveryData = {
      title: workflowState.pageTitle,
      analyzed: markAsAnalyzed
    };
    
    if (includeContent && workflowState.htmlContent) {
      discoveryData.content = workflowState.htmlContent;
    }
    // CRITICAL: Always save forms/interactive_elements from playwrightAnalysis (not conditional)
    // This ensures elements are populated even if workflow steps don't explicitly request them
    // Check for array existence (not truthiness - empty arrays are falsy but still valid)
    if (workflowState.playwrightAnalysis && Array.isArray(workflowState.playwrightAnalysis.forms)) {
      discoveryData.forms = workflowState.playwrightAnalysis.forms;
    }
    if (workflowState.playwrightAnalysis && Array.isArray(workflowState.playwrightAnalysis.links)) {
      discoveryData.links = workflowState.playwrightAnalysis.links;
    }
    if (workflowState.playwrightAnalysis && Array.isArray(workflowState.playwrightAnalysis.interactive_elements)) {
      discoveryData.interactive_elements = workflowState.playwrightAnalysis.interactive_elements;
    }
    if (workflowState.playwrightAnalysis && Array.isArray(workflowState.playwrightAnalysis.non_interactive_elements)) {
      discoveryData.non_interactive_elements = workflowState.playwrightAnalysis.non_interactive_elements;
    }
    if (includeDescription && workflowState.pageDescription) {
      discoveryData.page_description = workflowState.pageDescription;
    }
    if (includeVisibleText && workflowState.visibleText) {
      discoveryData.visible_text = workflowState.visibleText;
    }
    if (includeScreenshot && workflowState.screenshotFileId) {
      discoveryData.screenshot_file_id = workflowState.screenshotFileId;
    }
    
    if (workflowState.workflowId) {
      discoveryData.workflow_id = workflowState.workflowId;
    }
    
    if (includeAiAnalysis && workflowState.aiAnalysisResult) {
      // Get SEO/Content/Accessibility analysis from variablePool (set by AI prompt steps via variableOutputs)
      const seoAnalysis = workflowState.seoAnalysis || 
                          workflowState.context?.seoAnalysis || 
                          (workflowState.variablePool?.step?.seoAnalysis?.value) ||
                          (workflowState.stepResults?.seo_analysis?.seo_analysis) ||
                          (workflowState.stepResults?.seo_analysis?.result?.seo_analysis) ||
                          null;
      
      const contentAnalysis = workflowState.contentAnalysis ||
                              workflowState.context?.contentAnalysis ||
                              (workflowState.variablePool?.step?.contentAnalysis?.value) ||
                              (workflowState.stepResults?.content_optimization_analysis?.content_analysis) ||
                              (workflowState.stepResults?.content_optimization_analysis?.result?.content_analysis) ||
                              null;
      
      const accessibilityAnalysis = workflowState.accessibilityAnalysis ||
                                     workflowState.context?.accessibilityAnalysis ||
                                     (workflowState.variablePool?.step?.accessibilityAnalysis?.value) ||
                                     (workflowState.stepResults?.accessibility_analysis?.accessibility_analysis) ||
                                     (workflowState.stepResults?.accessibility_analysis?.result?.accessibility_analysis) ||
                                     null;
      
      discoveryData.ai_analysis = {
        ...(workflowState.aiAnalysisResult || {}),
        page_description: workflowState.aiAnalysisResult.page_description,
        legs_count: workflowState.legs.length,
        analyzed_at: new Date().toISOString(),
        // CRITICAL: Include forms/interactive_elements in ai_analysis so extraction logic can find them
        forms: workflowState.playwrightAnalysis?.forms || [],
        interactive_elements: workflowState.playwrightAnalysis?.interactive_elements || [],
        links: workflowState.playwrightAnalysis?.links || [],
        // Include all AI analysis results (SEO, Content, Accessibility)
        seo_analysis: seoAnalysis,
        content_analysis: contentAnalysis,
        accessibility_analysis: accessibilityAnalysis
      };
      discoveryData.analyzed = true;
    }

    const stats = {
      forms: workflowState.playwrightAnalysis?.forms?.length || 0,
      links: workflowState.playwrightAnalysis?.links?.length || 0,
      interactive: workflowState.playwrightAnalysis?.interactive_elements?.length || 0,
      non_interactive: workflowState.playwrightAnalysis?.non_interactive_elements?.length || 0,
      generated_at: new Date().toISOString()
    };

    let actionsSummary = workflowState.actionsSummary;
    if (!actionsSummary) {
      actionsSummary = this.buildActionsSummary(workflowState.legs);
      workflowState.actionsSummary = actionsSummary;
    }

    stats.actions_total = actionsSummary.total;
    stats.actions_completed = actionsSummary.completed;
    stats.actions_failed = actionsSummary.failed;
    stats.actions_pending = actionsSummary.pending;

    discoveryData.page_stats = stats;

    if (includeActions && actionsSummary.total > 0) {
      discoveryData.actions_summary = actionsSummary;
    }

    // CRITICAL: No fallbacks - page_description must be set by the AI prompt step
    if (includeDescription && !discoveryData.page_description) {
      throw new Error('Page description is required but was not generated. Ensure the AI prompt step for page description executed successfully.');
    }
    
    const jobIdentifier = workflowState.jobId || jobId;
    const effectiveProjectId = workflowState.projectId || projectId;

    try {
      console.log('🚀 Page discovery payload summary:', {
        url: workflowState.pageUrl,
        hasDescription: !!discoveryData.page_description,
        stats,
        actionsSummaryTotal: actionsSummary?.total || 0,
        includeFlags: config
      });
      const resolvedLegId = workflowState.currentLeg?.original_leg_id ||
        workflowState.currentLegOriginalId ||
        workflowState.currentLegResolvedId ||
        workflowState.currentLeg?.leg_id ||
        workflowState.currentLeg?.source_leg_id ||
        workflowState.currentLeg?.id ||
        null;
      const response = await this.updatePageDiscovery(jobIdentifier, pageId, effectiveProjectId, workflowState.pageUrl, discoveryData);
      console.log(`✅ Page discovery updated`);
 
      let legSaveResults = null;
      if (saveLegsData) {
        // Get legs from multiple sources - legsToExecute is the primary source during for-each iterations
        let legsToSave = Array.isArray(workflowState.legsToExecute) ? workflowState.legsToExecute : 
                        (Array.isArray(workflowState.legs) ? workflowState.legs : []);
        
        console.log('🧾 Leg save candidates before filtering:', {
          total: Array.isArray(legsToSave) ? legsToSave.length : 0,
          workflowId: workflowState.workflowId || 'not set',
          source: Array.isArray(workflowState.legsToExecute) ? 'legsToExecute' : 'legs',
          legIds: Array.isArray(legsToSave) ? legsToSave.map(leg => leg.leg_id || leg.id || 'no-id').slice(0, 5) : []
        });
        
        // If no workflowId, try to get it from pageId/projectId or skip saving
        if (!workflowState.workflowId && workflowState.pageId && workflowState.projectId) {
          try {
            // Try to find existing workflow for this page
            const workflowResponse = await axios.get(
              `${this.backendUrl}/api/projects/${workflowState.projectId}/pages/${workflowState.pageId}/workflow`,
              { headers: this.getAuthHeaders() }
            );
            if (workflowResponse.data && workflowResponse.data._id) {
              workflowState.workflowId = workflowResponse.data._id;
              console.log('✅ Found workflowId:', workflowState.workflowId);
            }
          } catch (e) {
            console.log('⚠️ Could not find workflowId, will save after workflow is created');
          }
        }
        console.log('🔎 Current leg id for save:', workflowState.currentLeg?.leg_id);
        if (actionsScope === 'current_leg') {
          if (resolvedLegId) {
            legsToSave = legsToSave.filter(leg => leg.leg_id === resolvedLegId || leg.leg_id === workflowState.currentLeg?.leg_id);
          } else if (workflowState.currentLeg?.description) {
            const targetDescription = workflowState.currentLeg.description.toLowerCase();
            legsToSave = legsToSave.filter(leg => (leg.description || '').toLowerCase() === targetDescription);
          }
        }
        console.log('📊 Leg iterations snapshot:', legsToSave.map(leg => ({
          leg_id: leg.leg_id || leg.id || 'no-id',
          iterations: Array.isArray(leg.iterations) ? leg.iterations.length : 0
        })));
        
        // For current_leg scope, save the current leg even if it doesn't have iterations yet
        // The iterations will be accumulated during the while-loop
        if (actionsScope === 'current_leg' && workflowState.currentLeg) {
          // Add current leg to save list if not already there
          const currentLegId = workflowState.currentLeg.leg_id || workflowState.currentLeg.id;
          const alreadyIncluded = legsToSave.some(leg => (leg.leg_id || leg.id) === currentLegId);
          if (!alreadyIncluded) {
            legsToSave.push(workflowState.currentLeg);
            console.log('➕ Added current leg to save list:', currentLegId);
          }
        }
        
        // Filter to only legs with iterations (unless saving current leg which may not have iterations yet)
        if (actionsScope !== 'current_leg') {
          legsToSave = legsToSave.filter(leg => Array.isArray(leg.iterations) && leg.iterations.length > 0);
        }
        
        console.log('🧮 Leg save candidates after filtering:', {
          total: legsToSave.length,
          legIds: legsToSave.map(leg => leg.leg_id || leg.id || 'no-id'),
          hasWorkflowId: !!workflowState.workflowId
        });
        
        // Save legs if we have a workflowId
        if (legsToSave.length > 0 && workflowState.workflowId) {
          legSaveResults = await this.saveLegIterationsToWorkflow(workflowState, legsToSave, jobId);
          console.log('✅ Saved leg iterations to workflow:', legSaveResults);
        } else if (legsToSave.length > 0 && !workflowState.workflowId) {
          console.log('⏳ Legs ready to save but workflowId not yet available - will save when workflow is created');
        }
      }

      const discoverySummary = {
        included: {
          content: includeContent && !!discoveryData.content,
          visible_text: includeVisibleText && !!discoveryData.visible_text,
          forms: includeForms && !!discoveryData.forms,
          interactive_elements: includeInteractive && !!discoveryData.interactive_elements,
          non_interactive_elements: includeNonInteractive && !!discoveryData.non_interactive_elements,
          links: includeLinks && !!discoveryData.links,
          description: includeDescription && !!discoveryData.page_description,
          ai_analysis: includeAiAnalysis && !!discoveryData.ai_analysis,
          screenshot: includeScreenshot && !!discoveryData.screenshot_file_id,
          actions: includeActions && !!discoveryData.actions_summary
        },
        counts: stats
      };

      await this.logStepOutcome(
        step,
        jobId,
        `📡 [PAGE-DISCOVERY] Upserted page data for ${workflowState.pageUrl}`,
        {
          included: discoverySummary.included,
          counts: discoverySummary.counts,
          analyzed: discoveryData.analyzed,
          page_stats: stats,
          actions_summary: includeActions && actionsSummary.total > 0 ? actionsSummary : null,
          leg_save_results: legSaveResults
        }
      );
    } catch (error) {
      console.error(`❌ Failed to update page discovery: ${error.message}`);
    }
  }

  async saveLegIterationsToWorkflow(workflowState, legs, jobId) {
    if (!Array.isArray(legs) || legs.length === 0 || !workflowState.pageId) {
      return null;
    }

    try {
      const legsPayload = JSON.parse(JSON.stringify(legs));

      const response = await axios.post(
        `${this.backendUrl}/api/pages/${workflowState.pageId}/save-analysis`,
        {
          saveLegs: true,
          saveInteractiveElements: false,
          saveNonInteractiveElements: false,
          saveLinks: false,
          saveCookies: false,
          legs: legsPayload,
          job_id: jobId
        },
        {
          headers: this.getAuthHeaders()
        }
      );

      const results = response.data?.results || null;
      if (results) {
        console.log('💾 Saved leg iterations:', results.legs || results);
      }
      return results;
    } catch (error) {
      console.error(`❌ Failed to save leg iterations: ${error.message}`);
      return null;
    }
  }

  /**
   * Execute save-data step - DEPRECATED: This step type has been removed.
   * Each workflow step must now save its own data directly.
   * @deprecated Use individual step data saving instead
   */
  async executeSaveDataStep(page, step, workflowState, jobId) {
      console.error(`❌ DEPRECATED: save-data step type has been removed. Each step must save its own data.`);
    throw new Error('save-data step type has been removed. Each workflow step must save its own data when executed.');
    
    // Original implementation removed - steps must save data individually
    // This function is deprecated and will always throw an error
    
    const config = step.config || {};
    
    // Determine what to save based on config
    const saveLegs = config.saveLegs !== false; // Default true
    const saveInteractiveElements = config.saveInteractiveElements !== false; // CRITICAL: Always save interactive elements by default (default true)
    const saveNonInteractiveElements = config.saveNonInteractiveElements === true;
    const saveLinks = config.saveLinks === true;
    const saveCookies = config.saveCookies === true;
    const saveSeoData = config.saveSeoData === true;
    const saveContentData = config.saveContentData === true;
    const saveAccessibilityData = config.saveAccessibilityData === true;
    
    // Collect data from workflowState
    // CRITICAL: Use legsToExecute if available (the active legs array), otherwise fall back to legs
    // legsToExecute is set by AI steps and contains the latest discovered actions
    let legs = workflowState.legsToExecute || workflowState.context?.legsToExecute || workflowState.legs || [];
    
    // Get journeys from workflowState (new format from AI analysis)
    let journeys = workflowState.journeys || 
                   workflowState.journeysToExecute || 
                   workflowState.context?.journeysToExecute ||
                   workflowState.aiAnalysisResult?.journeys ||
                   [];
    
    // Get journey justifications dynamically - no hardcoded step IDs
    // Check variablePool first (set by variableOutputs) - this is the primary location
    // This is AI-driven: any step that outputs journeyJustifications will populate this
    let journeyJustifications = null;
    
    if (workflowState.variablePool?.page?.journeyJustifications?.value) {
      journeyJustifications = workflowState.variablePool.page.journeyJustifications.value;
      console.log(`💾 Found journey justifications in variablePool.page.journeyJustifications`);
    }
    // Check all stepResults dynamically (no hardcoded step IDs)
    else if (workflowState.stepResults) {
      for (const [stepKey, stepResult] of Object.entries(workflowState.stepResults)) {
        if (stepResult?.result?.journey_justifications) {
          journeyJustifications = stepResult.result.journey_justifications;
          console.log(`💾 Found journey justifications in stepResults.${stepKey}.result`);
          break;
        }
      }
    }
    // Check variablePool steps dynamically
    if (!journeyJustifications && workflowState.variablePool?.steps) {
      for (const [stepKey, stepData] of Object.entries(workflowState.variablePool.steps)) {
        // CRITICAL: structuredResult wraps values in { value: ..., namespace: ... }
        // So we need to check both the direct path and the .value path
        let foundJustifications = null;
        
        // Check direct path first (if not structured)
        if (stepData?.result?.journey_justifications) {
          if (stepData.result.journey_justifications.value !== undefined) {
            // Structured format: { value: [...], namespace: '...' }
            foundJustifications = stepData.result.journey_justifications.value;
          } else if (Array.isArray(stepData.result.journey_justifications)) {
            // Direct array (not structured)
            foundJustifications = stepData.result.journey_justifications;
          }
        }
        
        console.log(`🔍 [SAVE-DATA] Checking variablePool.steps.${stepKey}:`, {
          hasResult: !!stepData?.result,
          resultKeys: stepData?.result ? Object.keys(stepData.result) : [],
          hasJourneyJustifications: !!stepData?.result?.journey_justifications,
          hasValue: !!stepData?.result?.journey_justifications?.value,
          journeyJustificationsType: typeof stepData?.result?.journey_justifications,
          journeyJustificationsIsArray: Array.isArray(stepData?.result?.journey_justifications),
          journeyJustificationsValueType: typeof stepData?.result?.journey_justifications?.value,
          journeyJustificationsValueIsArray: Array.isArray(stepData?.result?.journey_justifications?.value),
          foundJustifications: foundJustifications !== null,
          foundJustificationsLength: Array.isArray(foundJustifications) ? foundJustifications.length : 'N/A'
        });
        
        if (foundJustifications && Array.isArray(foundJustifications)) {
          journeyJustifications = foundJustifications;
          console.log(`💾 Found journey justifications in variablePool.steps.${stepKey}.result:`, {
            type: typeof journeyJustifications,
            isArray: Array.isArray(journeyJustifications),
            length: journeyJustifications.length,
            value: JSON.stringify(journeyJustifications).substring(0, 200)
          });
          break;
        }
      }
    }
    // Check workflowState dynamically (look for any step result with journey_justifications)
    if (!journeyJustifications && workflowState.results) {
      for (const [stepKey, stepResult] of Object.entries(workflowState.results)) {
        if (stepResult?.result?.journey_justifications) {
          journeyJustifications = stepResult.result.journey_justifications;
          console.log(`💾 Found journey justifications in workflowState.results.${stepKey}.result`);
          break;
        }
      }
    }
    // Check direct workflowState (set by variableOutputs)
    if (!journeyJustifications && workflowState.journeyJustifications) {
      journeyJustifications = workflowState.journeyJustifications;
      console.log(`💾 Found journey justifications in workflowState.journeyJustifications`);
    }
    // Check context (set by variableOutputs)
    if (!journeyJustifications && workflowState.context?.journeyJustifications) {
      journeyJustifications = workflowState.context.journeyJustifications;
      console.log(`💾 Found journey justifications in workflowState.context.journeyJustifications`);
    }
    
    console.log(`🔍 [SAVE-DATA] Final journeyJustifications check:`, {
      isNull: journeyJustifications === null,
      isUndefined: journeyJustifications === undefined,
      isArray: Array.isArray(journeyJustifications),
      type: typeof journeyJustifications,
      length: Array.isArray(journeyJustifications) ? journeyJustifications.length : 'N/A',
      value: journeyJustifications ? JSON.stringify(journeyJustifications).substring(0, 300) : 'null/undefined'
    });
    
    if (!journeyJustifications || !Array.isArray(journeyJustifications)) {
      journeyJustifications = [];
      console.log(`⚠️ [SAVE-DATA] No journey justifications found - will save journeys without justifications`);
      console.log(`⚠️ [SAVE-DATA] Debug: workflowState keys:`, Object.keys(workflowState).join(', '));
      console.log(`⚠️ [SAVE-DATA] Debug: variablePool.page keys:`, workflowState.variablePool?.page ? Object.keys(workflowState.variablePool.page).join(', ') : 'N/A');
      console.log(`⚠️ [SAVE-DATA] Debug: variablePool.steps keys:`, workflowState.variablePool?.steps ? Object.keys(workflowState.variablePool.steps).join(', ') : 'N/A');
      console.log(`⚠️ [SAVE-DATA] Debug: stepResults keys:`, workflowState.stepResults ? Object.keys(workflowState.stepResults).join(', ') : 'N/A');
    } else {
      console.log(`✅ [SAVE-DATA] Found ${journeyJustifications.length} journey justifications for save-data step`);
      journeyJustifications.forEach((j, i) => {
        console.log(`  Justification ${i+1}: journey_id=${j.journey_id}, status=${j.status}, reason=${j.reason ? j.reason.substring(0, 50) + '...' : 'NO REASON'}`);
      });
    }
    
    // Apply justifications to journeys
    if (Array.isArray(journeyJustifications) && journeyJustifications.length > 0) {
      console.log(`💾 Applying ${journeyJustifications.length} journey justifications to journeys`);
      const justificationMap = new Map();
      journeyJustifications.forEach(j => {
        if (j.journey_id) {
          justificationMap.set(j.journey_id, j);
        }
      });
      
      // Apply justifications to journeys and create iterations
      journeys = journeys.map(journey => {
        const justification = justificationMap.get(journey.journey_id);
        if (justification) {
          // Create an iteration for the journey with the justification
          const journeyIteration = {
            iteration_number: (journey.iterations?.length || 0) + 1,
            timestamp: new Date(),
            screenshot_before: null,
            screenshot_after: null,
            html_sent: null,
            html_after: null,
            script_executed: null,
            openai_request: null,
            openai_response: {
              status: justification.status,
              reason: justification.reason,
              what_happened: justification.verification_details,
              expected_outcome_verified: justification.expected_outcome_verified
            },
            result: justification.status === 'success' ? 'success' : (justification.status === 'failure' ? 'failure' : 'incomplete'),
            status: justification.status,
            reason: justification.reason,
            what_happened: justification.verification_details,
            page_url_before: workflowState.pageUrl || null,
            page_url_after: workflowState.pageUrl || null,
            job_id: jobId
          };
          
          // Add iteration to journey's iterations array
          const existingIterations = journey.iterations || [];
          
          console.log(`✅ [SAVE-DATA] Created iteration for journey ${journey.journey_id} with reason: ${justification.reason ? justification.reason.substring(0, 80) + '...' : 'NO REASON'}`);
          
          // CRITICAL: Check if this journey is designed to test failure scenarios
          const journeyDesc = (journey.description || '').toLowerCase();
          const journeyExpectedOutcome = (journey.expected_outcome || '').toLowerCase();
          const isFailureTestJourney = 
            journeyDesc.includes('always fail') ||
            journeyDesc.includes('verify that submission fails') ||
            journeyDesc.includes('verify that submission does not succeed') ||
            journeyDesc.includes('non-existent domain') ||
            journeyDesc.includes('will fail') ||
            journeyDesc.includes('should fail') ||
            journeyDesc.includes('expected to fail') ||
            journeyDesc.includes('does not succeed') ||
            journeyDesc.includes('submission fails') ||
            journeyDesc.includes('does not navigate') ||
            journeyDesc.includes('stays on page') ||
            journeyDesc.includes('form remains visible') ||
            journeyDesc.includes('form still visible') ||
            journeyExpectedOutcome.includes('fail') ||
            journeyExpectedOutcome.includes('does not succeed') ||
            journeyExpectedOutcome.includes('does not navigate') ||
            journeyExpectedOutcome.includes('stays on page') ||
            journeyExpectedOutcome.includes('form remains visible');
          
          if (isFailureTestJourney) {
            console.log(`🔍 [FAILURE-TEST-DETECTED] Journey ${journey.journey_id} is a failure-test journey`);
            console.log(`   Description: ${journeyDesc.substring(0, 100)}...`);
            console.log(`   Expected Outcome: ${journeyExpectedOutcome.substring(0, 100)}...`);
          }
          
          // CRITICAL: Map status based on expected_outcome_verified (primary source)
          // If expected_outcome_verified is true, status should be 'success'
          // This ensures green status on the journeys page
          let finalStatus = justification.status;
          
          // CRITICAL: For failure-test journeys, ALWAYS mark as 'failure' (form correctly failed)
          // The user explicitly stated: "the one which is shown always fail will obviously fail to mock the app, it must be marked as failed"
          if (isFailureTestJourney) {
            // For failure-test journeys, mark as 'failure' regardless of AI response
            // This indicates the form correctly failed (which is the expected behavior)
            finalStatus = 'failure';
            console.log(`✅ [FAILURE-TEST] Journey ${journey.journey_id} - marking as 'failure' (form correctly failed as expected)`);
          } else {
            // Normal journey logic
            if (justification.expected_outcome_verified === true) {
              finalStatus = 'success';
            } else if (justification.expected_outcome_verified === false) {
              finalStatus = 'failure';
            }
            // Otherwise keep the AI's status (pending, etc.)
          }
          
          return {
            ...journey,
            ai_justification: justification.reason,
            justification_status: finalStatus,
            expected_outcome_verified: justification.expected_outcome_verified,
            verification_details: justification.verification_details,
            iterations: [...existingIterations, journeyIteration]
          };
        }
        return journey;
      });
      
      // Also update journeys in workflowState so they're saved with justifications and iterations
      workflowState.journeys = journeys;
      if (!workflowState.context) {
        workflowState.context = {};
      }
      workflowState.context.journeysToExecute = journeys;
      
      console.log(`✅ [SAVE-DATA] Updated ${journeys.length} journeys with justifications and iterations`);
    } else {
      console.log(`⚠️ [SAVE-DATA] No journey justifications to apply (journeyJustifications.length=${journeyJustifications?.length || 0}, journeys.length=${journeys.length})`);
    }
    
    // CRITICAL: Filter out legs that have already been analyzed in this job
    // Once an action is collected/analyzed in a job, it should not be analyzed again
    if (saveLegs && legs.length > 0 && jobId) {
      try {
        const axios = (await import('axios')).default;
        // Get all existing actions for this job
        const existingActionsResponse = await axios.get(`${this.backendUrl}/api/actions`, {
          params: {
            job_id: jobId
          },
          headers: this.getAuthHeaders(),
          timeout: 5000
        });
        
        const existingActions = Array.isArray(existingActionsResponse.data) ? existingActionsResponse.data : [];
        const existingLegIds = new Set(existingActions.map(a => a.leg_id).filter(Boolean));
        
        // Filter out legs that already have actions in this job
        const originalLegCount = legs.length;
        legs = legs.filter(leg => {
          if (!leg.leg_id) return true; // Keep legs without leg_id (shouldn't happen, but be safe)
          if (existingLegIds.has(leg.leg_id)) {
            console.log(`⏭️ Skipping leg ${leg.leg_id} - already analyzed in job ${jobId}`);
            return false;
          }
          return true;
        });
        
        const skippedCount = originalLegCount - legs.length;
        if (skippedCount > 0) {
          console.log(`⏭️ Filtered out ${skippedCount} legs that were already analyzed in job ${jobId}`);
          await this.sendLogToBackend(jobId, 'info', `⏭️ Skipped ${skippedCount} legs already analyzed in this job`, 'WORKFLOW-ANALYZER', {
            step_id: step.id,
            step_name: step.name,
            skipped_count: skippedCount,
            remaining_legs: legs.length
          });
        }
      } catch (filterError) {
        // If check fails, log warning but continue with all legs (don't block save-data)
        console.warn(`⚠️ Could not check for existing actions to filter legs: ${filterError.message}`);
      }
    }
    
    const interactiveElements = workflowState.playwrightAnalysis?.interactive_elements || [];
    const nonInteractiveElements = workflowState.playwrightAnalysis?.non_interactive_elements || [];
    const links = workflowState.playwrightAnalysis?.links || [];
    
    // Get SEO analysis from workflowState (set by SEO analysis step via variableOutputs)
    // Check multiple locations where it might be stored
    const seoAnalysis = workflowState.seoAnalysis || 
                        workflowState.context?.seoAnalysis || 
                        (workflowState.variablePool?.step?.seoAnalysis?.value) ||
                        (workflowState.stepResults?.seo_analysis?.seo_analysis) ||
                        (workflowState.stepResults?.seo_analysis?.result?.seo_analysis) ||
                        null;
    
    // Get Content analysis from workflowState
    const contentAnalysis = workflowState.contentAnalysis ||
                            workflowState.context?.contentAnalysis ||
                            (workflowState.variablePool?.step?.contentAnalysis?.value) ||
                            (workflowState.stepResults?.content_optimization_analysis?.content_analysis) ||
                            (workflowState.stepResults?.content_optimization_analysis?.result?.content_analysis) ||
                            null;
    
    // Get Accessibility analysis from workflowState
    const accessibilityAnalysis = workflowState.accessibilityAnalysis ||
                                   workflowState.context?.accessibilityAnalysis ||
                                   (workflowState.variablePool?.step?.accessibilityAnalysis?.value) ||
                                   (workflowState.stepResults?.accessibility_analysis?.accessibility_analysis) ||
                                   (workflowState.stepResults?.accessibility_analysis?.result?.accessibility_analysis) ||
                                   null;
    
    const dataTypes = [];
    if (saveLegs && legs.length > 0) dataTypes.push(`${legs.length} legs`);
    if (saveSeoData && seoAnalysis) dataTypes.push('SEO data');
    if (saveContentData && contentAnalysis) dataTypes.push('Content data');
    if (saveAccessibilityData && accessibilityAnalysis) dataTypes.push('Accessibility data');
    
    console.log(`💾 Save-data step: saving ${dataTypes.join(', ')}`);
    
    // Get cookies from page context
    let cookies = [];
    if (saveCookies) {
      try {
        const pageCookies = await page.context().cookies();
        cookies = pageCookies;
      } catch (error) {
        console.warn(`Failed to collect cookies: ${error.message}`);
      }
    }
    
    // Prepare payload
    const payload = {
      saveLegs,
      saveInteractiveElements,
      saveNonInteractiveElements,
      saveLinks,
      saveCookies,
      saveSeoData,
      saveContentData,
      saveAccessibilityData,
      legs: saveLegs ? legs : [],
      journeys: saveLegs && journeys.length > 0 ? journeys : [], // CRITICAL: Send journeys if available (new format)
      interactiveElements: saveInteractiveElements ? interactiveElements : [],
      nonInteractiveElements: saveNonInteractiveElements ? nonInteractiveElements : [],
      links: saveLinks ? links : [],
      cookies: saveCookies ? cookies : [],
      seoData: saveSeoData && seoAnalysis ? seoAnalysis : null,
      contentData: saveContentData && contentAnalysis ? contentAnalysis : null,
      accessibilityData: saveAccessibilityData && accessibilityAnalysis ? accessibilityAnalysis : null,
      job_id: jobId
    };
    
    // Debug: Log journey iterations being sent
    if (journeys.length > 0) {
      console.log(`💾 [SAVE-DATA] Sending ${journeys.length} journeys to backend (workflowId: ${workflowState.workflowId})`);
      journeys.forEach((j, i) => {
        console.log(`  Journey ${i+1} (${j.journey_id}): ai_justification=${j.ai_justification ? 'YES (' + j.ai_justification.substring(0, 80) + '...)' : 'NO'}, justification_status=${j.justification_status || 'N/A'}, expected_outcome_verified=${j.expected_outcome_verified}, iterations=${j.iterations?.length || 0}`);
        if (j.iterations && j.iterations.length > 0) {
          j.iterations.forEach((iter, idx) => {
            console.log(`    Iter ${idx+1}: reason=${iter.reason ? 'YES (' + iter.reason.substring(0, 50) + '...)' : 'NO'}, status=${iter.status || 'N/A'}`);
          });
        }
      });
    }
    
    try {
      if (!workflowState.pageId) {
        console.error(`❌ [SAVE-DATA] Cannot save data: pageId is missing`);
        throw new Error('pageId is required to save data');
      }
      
      console.log(`💾 [SAVE-DATA] POSTing to ${this.backendUrl}/api/pages/${workflowState.pageId}/save-analysis with ${journeys.length} journeys`);
      const response = await axios.post(
        `${this.backendUrl}/api/pages/${workflowState.pageId}/save-analysis`,
        payload,
        {
          headers: this.getAuthHeaders()
        }
      );
      
      console.log(`✅ [SAVE-DATA] Backend responded with status ${response.status}`);
      const results = response.data?.results || {};
      
      console.log(`✅ Saved data:`, {
        legs: results.legs,
        actions: results.actions,
        page: results.page,
        cookies: results.cookies,
        seo: results.seo,
        content: results.content,
        accessibility: results.accessibility
      });
      
      // CRITICAL: Journey iterations are now created when applying justifications to journeys above
      // This ensures AI justification appears in action details via journey.iterations
      // No need to create leg iterations separately - journeys are saved with iterations in the save-data step
      
      this.storeStepResult(step, {
        success: true,
        results
      }, workflowState);
      
      const savedItems = [];
      if (results.legs?.created || results.legs?.updated) {
        savedItems.push(`${results.legs.created || 0} new legs, ${results.legs.updated || 0} updated legs`);
      }
      if (results.actions?.created || results.actions?.updated) {
        savedItems.push(`${results.actions.created || 0} new actions, ${results.actions.updated || 0} updated actions`);
      }
      if (results.seo?.saved) savedItems.push('SEO data');
      if (results.content?.saved) savedItems.push('Content data');
      if (results.accessibility?.saved) savedItems.push('Accessibility data');
      
      const logMessage = `💾 [SAVE-DATA] Saved ${savedItems.join(', ')}`;
      
      await this.logStepOutcome(
        step,
        jobId,
        logMessage,
        {
          results,
          config: {
            saveLegs,
            saveInteractiveElements,
            saveNonInteractiveElements,
            saveLinks,
            saveCookies,
            saveSeoData,
            saveContentData,
            saveAccessibilityData
          }
        }
      );
      
      return results;
    } catch (error) {
      console.error(`❌ Failed to save data: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute save-page-data step - saves page data and optionally performs variable dump
   * This combines the functionality of save-data and var-dump steps
   */
  async executeSavePageDataStep(page, step, workflowState, jobId) {
    console.log(`💾 Executing save-page-data step (${step.name})`);
    
    const config = step.config || {};
    const variableDump = config.variableDump === true; // Optional variable dump feature
    
    // If variableDump is enabled, perform var-dump first
    if (variableDump) {
      console.log(`🧾 Variable dump enabled in save-page-data step`);
      await this.executeVarDumpStep(step, workflowState, jobId);
    }
    
    // Then execute save-data functionality
    // For login jobs, we want to save page data even if there's no workflowId
    // Check if this is a login job
    const isLoginJob = workflowState.jobType === 'login' || 
                       this.context?.jobType === 'login' || 
                       this.context?.isLoginJob === true;
    
    if (isLoginJob) {
      // For login jobs, save page data to job logs and optionally to database
      console.log(`💾 Saving page data for login job`);
      
      // Collect available data based on config
      const pageData = {
        url: page.url(),
        title: await page.title().catch(() => 'Unknown'),
        timestamp: new Date().toISOString(),
        jobId: jobId
      };
      
      // Collect data based on config options
      if (config.saveInteractiveElements && workflowState.playwrightAnalysis?.interactive_elements) {
        pageData.interactiveElements = workflowState.playwrightAnalysis.interactive_elements;
      }
      if (config.saveNonInteractiveElements && workflowState.playwrightAnalysis?.non_interactive_elements) {
        pageData.nonInteractiveElements = workflowState.playwrightAnalysis.non_interactive_elements;
      }
      if (config.saveLinks && workflowState.playwrightAnalysis?.links) {
        pageData.links = workflowState.playwrightAnalysis.links;
      }
      if (config.saveCookies) {
        try {
          const pageCookies = await page.context().cookies();
          pageData.cookies = pageCookies;
        } catch (error) {
          console.warn(`Failed to collect cookies: ${error.message}`);
        }
      }
      if (config.saveLegs) {
        const legs = workflowState.legsToExecute || workflowState.context?.legsToExecute || workflowState.legs || [];
        if (legs.length > 0) {
          pageData.legs = legs;
        }
      }
      
      // Add variable dump snapshot if enabled
      if (variableDump) {
        const { snapshot } = this.buildVarDumpSnapshot(step, workflowState, {
          maxDepth: Math.max(1, this.coerceToInteger(config.maxDepth) ?? 4),
          maxArrayLength: Math.max(1, this.coerceToInteger(config.maxArrayLength) ?? 20),
          maxStringLength: Math.max(50, this.coerceToInteger(config.maxStringLength) ?? 1200)
        }, config);
        pageData.workflowState = snapshot;
      }
      
      // Save to job logs as metadata
      try {
        await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
          jobId,
          level: 'info',
          message: `💾 [SAVE-PAGE-DATA] ${step.name || 'Page data saved'}`,
          component: 'WORKFLOW-SAVE-PAGE-DATA',
          metadata: {
            step_type: 'save-page-data',
            step_name: step.name,
            step_slug: step.slug || null,
            pageData,
            config: {
              variableDump,
              saveLegs: config.saveLegs,
              saveInteractiveElements: config.saveInteractiveElements,
              saveNonInteractiveElements: config.saveNonInteractiveElements,
              saveLinks: config.saveLinks,
              saveCookies: config.saveCookies
            }
          }
        }, {
          headers: this.getAuthHeaders()
        });
        
        this.storeStepResult(step, {
          success: true,
          pageData,
          variableDump: variableDump
        }, workflowState);
        
        const savedItems = [];
        if (pageData.interactiveElements) savedItems.push('interactive elements');
        if (pageData.nonInteractiveElements) savedItems.push('non-interactive elements');
        if (pageData.links) savedItems.push('links');
        if (pageData.cookies) savedItems.push('cookies');
        if (pageData.legs) savedItems.push('legs');
        if (variableDump) savedItems.push('variable dump');
        
        console.log(`✅ Saved page data for login job: ${savedItems.join(', ') || 'basic page info'}`);
      } catch (error) {
        console.error(`❌ Failed to save page data for login job: ${error.message}`);
        // Don't throw - login jobs should continue even if data saving fails
      }
    } else {
      // For non-login jobs, save-page-data should handle its own saving
      // The save-data step type has been removed - each step must save its own data
      console.warn(`⚠️ save-page-data step in non-login job - ensure data is saved by individual steps`);
    }
  }

  /**
   * Store step result by slug with structured JSON format including namespaces
   */
  async storeStepResult(step, result, workflowState) {
    const slug = step.slug || this.generateSlug(step.name || 'step');
    
    // Get output schema for this step type to determine namespaces
    const outputSchema = step.config?.output_schema || this.getDefaultOutputSchema(step.type);
    
    // Convert result to structured format with namespaces
    const structuredResult = this.structureResultWithNamespaces(result, outputSchema, step.type);
    
    if (!workflowState[slug]) {
      workflowState[slug] = {};
    }
    workflowState[slug].result = structuredResult;
    workflowState[slug].stepName = step.name;
    workflowState[slug].stepType = step.type;
    // Also store by name for backward compatibility
    workflowState[`${step.name}_result`] = structuredResult;
    
    // Also store by step ID if it exists (for nested steps in for-each)
    if (step.id) {
      if (!workflowState.results) {
        workflowState.results = {};
      }
      if (!workflowState.results[step.id]) {
        workflowState.results[step.id] = {};
      }
      workflowState.results[step.id].result = structuredResult;
      workflowState.results[step.id].stepName = step.name;
      workflowState.results[step.id].stepType = step.type;
      
      // Also store directly on workflowState for easier access
      workflowState[step.id] = {
        result: structuredResult,
        stepName: step.name,
        stepType: step.type
      };
    }

    // Store in variablePool.steps for easy reference with structured format
    this.initializeVariablePool(workflowState);
    workflowState.variablePool.steps[slug] = {
      result: structuredResult,
      stepName: step.name,
      stepType: step.type,
      stepId: step.id
    };
    
    // CRITICAL: Also store raw result in stepResults for processVariableOutputs to access
    // This ensures that even empty arrays (like empty journeys) are accessible
    if (!workflowState.stepResults) {
      workflowState.stepResults = {};
    }
    const stepId = step.id || step.slug || slug;
    workflowState.stepResults[stepId] = {
      result: result, // Store raw result (not structured) so processVariableOutputs can access original structure
      structuredResult: structuredResult, // Also store structured for reference
      stepName: step.name,
      stepType: step.type,
      stepId: step.id
    };

    // Process variable outputs if configured
    await this.processVariableOutputs(step, workflowState, structuredResult);
    
    // Also store individual fields in their appropriate namespaces
    this.storeResultFieldsToNamespaces(structuredResult, workflowState, step);
  }

  /**
   * Get default output schema for a step type
   */
  getDefaultOutputSchema(stepType) {
    const schemas = {
      'screenshot': {
        screenshot_url: { namespace: 'page' },
        screenshot_file_id: { namespace: 'page' },
        screenshot_base64: { namespace: 'page' }
      },
      'playwright-analysis': {
        playwright_analysis: { namespace: 'page' }
      },
      'ai-prompt': {
        result: { namespace: 'step' }
      },
      'content-change': {
        success: { namespace: 'step' },
        operation: { namespace: 'step' },
        message: { namespace: 'step' }
      },
      'for-each': {
        iterations: { namespace: 'step' },
        total_iterations: { namespace: 'step' }
      },
      'while-loop': {
        iterations: { namespace: 'step' },
        total_iterations: { namespace: 'step' },
        condition_result: { namespace: 'step' }
      },
      'conditional': {
        condition_met: { namespace: 'step' },
        route_taken: { namespace: 'step' }
      }
    };
    return schemas[stepType] || {};
  }

  /**
   * Structure result with namespace information
   */
  structureResultWithNamespaces(result, outputSchema, stepType) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      // For simple values, wrap in structured format
      const defaultSchema = this.getDefaultOutputSchema(stepType);
      const firstKey = Object.keys(defaultSchema)[0];
      if (firstKey) {
        return {
          [firstKey]: {
            value: result,
            namespace: defaultSchema[firstKey].namespace || 'step'
          }
        };
      }
      return { value: result, namespace: 'step' };
    }

    // For objects, structure each field with namespace information
    const structured = {};
    const schemaKeys = Object.keys(outputSchema || {});
    
    // If we have a schema, use it to structure the result
    if (schemaKeys.length > 0) {
      for (const key of schemaKeys) {
        const schemaField = outputSchema[key];
        const namespace = schemaField?.namespace || 'step';
        
        if (result[key] !== undefined) {
          structured[key] = {
            value: result[key],
            namespace: namespace
          };
        } else if (schemaField?.value && typeof schemaField.value === 'object') {
          // Handle nested structures - recursively structure nested objects
          const nestedValue = result[key];
          if (nestedValue !== undefined && typeof nestedValue === 'object' && !Array.isArray(nestedValue) && nestedValue !== null) {
            const nestedStructured = {};
            // Structure each nested field according to schema
            if (schemaField.value && typeof schemaField.value === 'object') {
              for (const [nestedKey, nestedSchema] of Object.entries(schemaField.value)) {
                if (nestedValue[nestedKey] !== undefined) {
                  const nestedNs = nestedSchema?.namespace || 'step';
                  nestedStructured[nestedKey] = {
                    value: nestedValue[nestedKey],
                    namespace: nestedNs
                  };
                }
              }
            }
            // Include any fields not in schema but present in result
            for (const nestedKey of Object.keys(nestedValue)) {
              if (!nestedStructured[nestedKey]) {
                // Try to find namespace from schema, otherwise default to parent namespace or 'step'
                const nestedNs = schemaField.value?.[nestedKey]?.namespace || namespace || 'step';
                nestedStructured[nestedKey] = {
                  value: nestedValue[nestedKey],
                  namespace: nestedNs
                };
              }
            }
            structured[key] = {
              value: nestedStructured,
              namespace: namespace
            };
          } else if (nestedValue !== undefined) {
            // For non-object nested values, wrap directly
            structured[key] = {
              value: nestedValue,
              namespace: namespace
            };
          }
        }
      }
      
      // Also include any fields not in schema (for backward compatibility)
      for (const key of Object.keys(result)) {
        if (!structured[key]) {
          structured[key] = {
            value: result[key],
            namespace: 'step'
          };
        }
      }
    } else {
      // No schema, wrap entire result
      for (const key of Object.keys(result)) {
        structured[key] = {
          value: result[key],
          namespace: 'step'
        };
      }
    }
    
    // CRITICAL: For AI prompt steps, also extract top-level fields to their own namespace entries
    // This allows direct access like "playwright_script" instead of "stepId.result.playwright_script"
    if (stepType === 'ai-prompt' && result && typeof result === 'object' && !Array.isArray(result)) {
      for (const [key, value] of Object.entries(result)) {
        // If this field isn't already in structured (from schema), add it
        if (!structured[key]) {
          // Extract to page namespace for easy access (especially for scripts)
          const namespace = (key === 'playwright_script' || key.includes('script')) ? 'page' : 'step';
          // Handle both object and primitive values
          if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            // If it's already a structured value, keep it; otherwise wrap it
            structured[key] = value.value !== undefined ? value : {
              value: value,
              namespace: namespace
            };
          } else {
            structured[key] = {
              value: value,
              namespace: namespace
            };
          }
        }
      }
    }
    
    return structured;
  }

  /**
   * Store result fields to their appropriate namespaces in variablePool
   * Also handles nested structures and extracts individual fields
   */
  storeResultFieldsToNamespaces(structuredResult, workflowState, step) {
    if (!structuredResult || typeof structuredResult !== 'object') return;
    
    this.initializeVariablePool(workflowState);
    
    // Helper function to recursively store nested structures
    const storeField = (key, fieldData, namespace, step) => {
      if (!fieldData || typeof fieldData !== 'object') return;
      
      // Handle structured format: {value: ..., namespace: ...}
      if (fieldData.namespace && fieldData.value !== undefined) {
        const actualNamespace = fieldData.namespace;
        const actualValue = fieldData.value;
        
        // Store the main field
        if (actualNamespace === 'job') {
          workflowState.variablePool.job[key] = {
            value: actualValue,
            savedAt: new Date().toISOString(),
            stepSlug: step.slug,
            stepName: step.name
          };
        } else if (actualNamespace === 'page') {
          workflowState.variablePool.page[key] = {
            value: actualValue,
            savedAt: new Date().toISOString(),
            stepSlug: step.slug,
            stepName: step.name
          };
          
          // CRITICAL: For playwright_analysis, also extract nested fields for easy access
          if (key === 'playwright_analysis' && typeof actualValue === 'object' && actualValue !== null) {
            // Store forms, links, interactive_elements, visible_text individually for backward compatibility
            if (actualValue.forms !== undefined) {
              workflowState.variablePool.page['forms'] = {
                value: actualValue.forms,
                savedAt: new Date().toISOString(),
                stepSlug: step.slug,
                stepName: step.name
              };
            }
            if (actualValue.links !== undefined) {
              workflowState.variablePool.page['links'] = {
                value: actualValue.links,
                savedAt: new Date().toISOString(),
                stepSlug: step.slug,
                stepName: step.name
              };
            }
            if (actualValue.interactive_elements !== undefined) {
              workflowState.variablePool.page['interactive_elements'] = {
                value: actualValue.interactive_elements,
                savedAt: new Date().toISOString(),
                stepSlug: step.slug,
                stepName: step.name
              };
            }
            if (actualValue.visible_text !== undefined) {
              workflowState.variablePool.page['visible_text'] = {
                value: actualValue.visible_text,
                savedAt: new Date().toISOString(),
                stepSlug: step.slug,
                stepName: step.name
              };
              // Also store in workflowState for backward compatibility
              workflowState.visibleText = actualValue.visible_text;
            }
            // Also keep the full object in workflowState for backward compatibility
            workflowState.playwrightAnalysis = actualValue;
          }
          
        } else if (actualNamespace === 'cycle' && workflowState.cycleStack.length > 0) {
          const cycleIndex = workflowState.cycleStack.length - 1;
          if (!workflowState.variablePool.cycle[cycleIndex]) {
            workflowState.variablePool.cycle[cycleIndex] = {};
          }
          workflowState.variablePool.cycle[cycleIndex][key] = {
            value: actualValue,
            savedAt: new Date().toISOString(),
            stepSlug: step.slug,
            stepName: step.name,
            cycleIndex: cycleIndex
          };
        }
        
        // If the value itself is an object with structured fields, recurse
        if (typeof actualValue === 'object' && actualValue !== null && !Array.isArray(actualValue)) {
          for (const [nestedKey, nestedFieldData] of Object.entries(actualValue)) {
            if (nestedFieldData && typeof nestedFieldData === 'object' && nestedFieldData.namespace && nestedFieldData.value !== undefined) {
              storeField(nestedKey, nestedFieldData, nestedFieldData.namespace, step);
            }
          }
        }
      }
    };
    
    // Process all top-level fields
    for (const [key, fieldData] of Object.entries(structuredResult)) {
      if (fieldData && typeof fieldData === 'object') {
        const namespace = fieldData.namespace || 'step';
        storeField(key, fieldData, namespace, step);
      }
    }
  }

  /**
   * Generate slug from name
   */
  generateSlug(name) {
    if (!name) return 'step';
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 50);
  }

  /**
   * Build minimal fallback journeys from playwright_analysis when AI step (page_summary) fails.
   * One journey per form: fill each field, submit, verify. Allows for-each step to run without AI.
   * @param {Object} workflowState
   * @param {Object} stepPayload - must have playwright_analysis.forms
   * @param {string} jobId
   * @returns {{ page_summary: object, journeys: Array } | null}
   */
  buildFallbackJourneysFromPlaywright(workflowState, stepPayload, jobId) {
    const pa = stepPayload?.playwright_analysis;
    if (!pa || !Array.isArray(pa.forms) || pa.forms.length === 0) return null;
    const journeys = [];
    pa.forms.forEach((form, formIndex) => {
      const formSelector = form.selector || form.selectors?.[0]?.selector || `form`;
      const formId = (form.id || formSelector.replace(/[^a-z0-9-_]/gi, '_') || `form_${formIndex}`).substring(0, 80);
      const journeyId = `form_${formId}`;
      const actions = [];
      let order = 0;
      (form.fields || []).forEach((field) => {
        const sel = field.selector || (field.id ? `#${field.id}` : null) || (field.name ? `input[name="${field.name}"]` : null) || null;
        if (sel) {
          actions.push({
            action_id: `action_${order}`,
            type: 'input',
            element_type: (field.type && field.type !== 'text' ? field.type : 'input'),
            selector: sel,
            description: `Fill ${field.name || field.id || 'field'}`,
            order: order++
          });
        }
      });
      (form.buttons || []).forEach((btn) => {
        const sel = btn.selector || (btn.text ? `button:has-text("${btn.text}")` : 'button[type="submit"]');
        actions.push({
          action_id: `action_${order}`,
          type: 'form_submit',
          element_type: 'button',
          selector: sel,
          description: btn.text ? `Submit: ${btn.text}` : 'Submit form',
          order: order++
        });
      });
      if (actions.length > 0) {
        actions.push({
          action_id: `action_${order}`,
          type: 'verify',
          element_type: 'other',
          selector: 'body',
          description: 'Verify submission or result',
          order: order
        });
        journeys.push({
          journey_id: journeyId,
          description: `Fallback form journey for ${formSelector}`,
          priority: 'high',
          confidence: 0.7,
          expected_outcome: 'Form submitted successfully',
          test_instructions: 'Fill form and submit',
          actions
        });
      }
    });
    if (journeys.length === 0) return null;
    return {
      page_summary: {
        short_description: 'Fallback (AI unavailable): built from form structure',
        primary_purpose: 'Form submission',
        forms_present: true
      },
      journeys
    };
  }

  /**
   * Initialize variable pool if it doesn't exist
   */
  initializeVariablePool(workflowState) {
    if (!workflowState.variablePool) {
      workflowState.variablePool = {
        job: {},
        page: {},
        cycle: [],
        steps: {}
      };
    }
    if (!workflowState.cycleDepth) workflowState.cycleDepth = 0;
    if (!workflowState.cycleStack) workflowState.cycleStack = [];
  }

  /**
   * Save a variable to the appropriate namespace
   * @param {Object} workflowState - The workflow state object
   * @param {string} variableName - Name of the variable
   * @param {*} value - Value to store
   * @param {string} namespace - 'job', 'page', or 'cycle' (defaults to 'page')
   * @param {Object} step - Step configuration (optional, for step-based namespace detection)
   */
  saveVariable(workflowState, variableName, value, namespace = null, step = null) {
    this.initializeVariablePool(workflowState);
    
    // Auto-detect namespace if not provided
    if (!namespace) {
      // If inside a cycle, default to cycle namespace
      if (workflowState.cycleDepth > 0) {
        namespace = 'cycle';
      } else {
        namespace = 'page'; // Default to page namespace
      }
    }

    if (namespace === 'job') {
      workflowState.variablePool.job[variableName] = {
        value,
        savedAt: new Date().toISOString(),
        stepSlug: step?.slug || null,
        stepName: step?.name || null
      };
    } else if (namespace === 'page') {
      workflowState.variablePool.page[variableName] = {
        value,
        savedAt: new Date().toISOString(),
        stepSlug: step?.slug || null,
        stepName: step?.name || null
      };
    } else if (namespace === 'cycle') {
      // For cycle namespace, save to the current cycle in the stack
      const cycleIndex = workflowState.cycleStack.length - 1;
      if (cycleIndex >= 0) {
        if (!workflowState.variablePool.cycle[cycleIndex]) {
          workflowState.variablePool.cycle[cycleIndex] = {};
        }
        workflowState.variablePool.cycle[cycleIndex][variableName] = {
          value,
          savedAt: new Date().toISOString(),
          stepSlug: step?.slug || null,
          stepName: step?.name || null,
          cycleIndex
        };
      } else {
        // Fallback to page if no cycle active
        workflowState.variablePool.page[variableName] = {
          value,
          savedAt: new Date().toISOString(),
          stepSlug: step?.slug || null,
          stepName: step?.name || null
        };
      }
    }
  }

  /**
   * Read a variable from the variable pool
   * @param {Object} workflowState - The workflow state object
   * @param {string} variableName - Name of the variable
   * @param {string} namespace - 'job', 'page', or 'cycle' (optional, will search all if not provided)
   * @returns {*} The variable value or undefined if not found
   */
  readVariable(workflowState, variableName, namespace = null) {
    if (!workflowState.variablePool) {
      return undefined;
    }

    // If namespace specified, look only there
    if (namespace) {
      if (namespace === 'job' && workflowState.variablePool.job[variableName]) {
        return workflowState.variablePool.job[variableName].value;
      } else if (namespace === 'page' && workflowState.variablePool.page[variableName]) {
        return workflowState.variablePool.page[variableName].value;
      } else if (namespace === 'cycle') {
        // Check current cycle first
        const cycleIndex = workflowState.cycleStack.length - 1;
        if (cycleIndex >= 0 && workflowState.variablePool.cycle[cycleIndex]?.[variableName]) {
          return workflowState.variablePool.cycle[cycleIndex][variableName].value;
        }
      }
      return undefined;
    }

    // Search in order: cycle (current) -> page -> job
    const cycleIndex = workflowState.cycleStack.length - 1;
    if (cycleIndex >= 0 && workflowState.variablePool.cycle[cycleIndex]?.[variableName]) {
      return workflowState.variablePool.cycle[cycleIndex][variableName].value;
    }
    if (workflowState.variablePool.page[variableName]) {
      return workflowState.variablePool.page[variableName].value;
    }
    if (workflowState.variablePool.job[variableName]) {
      return workflowState.variablePool.job[variableName].value;
    }
    return undefined;
  }

  /**
   * Process variable outputs configuration for a step
   * Saves variables according to step configuration
   */
  async processVariableOutputs(step, workflowState, stepResult) {
    if (!step.config?.variableOutputs || !Array.isArray(step.config.variableOutputs)) {
      return;
    }

    this.initializeVariablePool(workflowState);

    for (const output of step.config.variableOutputs) {
      if (!output.variableName || !output.sourcePath) {
        continue;
      }

      // Resolve the value from sourcePath
      // CRITICAL: For result.journeys path, check raw AI response FIRST (no fallbacks - must work on first attempt)
      // The raw AI response is stored in stepResults[stepId].result and has the exact structure from OpenAI
      let value = undefined;
      
      // For result.journeys specifically, check raw AI response FIRST (where it's actually stored)
      if (output.sourcePath === 'result.journeys' || (output.sourcePath.endsWith('.journeys') && output.sourcePath.startsWith('result.'))) {
        const stepId = step.id || step.slug;
        const rawResult = workflowState.stepResults?.[stepId]?.result;
        if (rawResult) {
          // Direct access: rawResult.result.journeys (AI response structure from OpenAI)
          value = this.getNestedValue(rawResult, output.sourcePath);
          if (value !== undefined) {
            console.log(`✅ [VARIABLE-OUTPUT] Found ${output.sourcePath} in raw AI response: ${Array.isArray(value) ? value.length : 'not array'} items`);
          } else {
            // If not found in raw result, try structured result as backup
            value = this.getNestedValue(stepResult, output.sourcePath);
            if (value !== undefined) {
              console.log(`✅ [VARIABLE-OUTPUT] Found ${output.sourcePath} in structured result: ${Array.isArray(value) ? value.length : 'not array'} items`);
            }
          }
        } else {
          // Try structured result if raw result not available
          value = this.getNestedValue(stepResult, output.sourcePath);
          if (value !== undefined) {
            console.log(`✅ [VARIABLE-OUTPUT] Found ${output.sourcePath} in structured result: ${Array.isArray(value) ? value.length : 'not array'} items`);
          }
        }
        
        // If still undefined, fail immediately (no fallbacks for result.journeys)
        if (value === undefined) {
          const stepId = step.id || step.slug;
          const rawResult = workflowState.stepResults?.[stepId]?.result;
          console.error(`❌ [VARIABLE-OUTPUT] Failed to find ${output.sourcePath} in AI response`);
          console.error(`   Step ID: ${stepId}`);
          console.error(`   Raw result keys: ${rawResult ? Object.keys(rawResult).join(', ') : 'null'}`);
          if (rawResult && rawResult.result) {
            console.error(`   Raw result.result keys: ${Object.keys(rawResult.result).join(', ')}`);
          }
          if (rawResult && typeof rawResult === 'object') {
            console.error(`   Raw result structure: ${JSON.stringify(rawResult, null, 2).substring(0, 500)}`);
          }
          throw new Error(`Variable output "${output.variableName}" requires "${output.sourcePath}" but it was not found in the AI response. The AI step must return the data at this path.`);
        }
      } else {
        // For other sourcePaths, use existing logic
        value = this.getNestedValue(stepResult, output.sourcePath);
        if (value === undefined && stepResult[output.sourcePath]?.value !== undefined) {
          // Try accessing via .value wrapper (structured format)
          value = stepResult[output.sourcePath].value;
        }
        if (value === undefined) {
          // Try from raw parsedResponse (stored in stepResults by step ID)
          const stepId = step.id || step.slug;
          if (workflowState.stepResults?.[stepId]?.result) {
            value = this.getNestedValue(workflowState.stepResults[stepId].result, output.sourcePath);
          }
        }
        if (value === undefined) {
          // Try from workflowState
          value = this.getNestedValue(workflowState, output.sourcePath);
        }
        if (value === undefined) {
          // Try from context
          value = this.getNestedValue(workflowState.context || {}, output.sourcePath);
        }
      }

      if (value !== undefined) {
        // Determine namespace
        let namespace = output.namespace;
        if (!namespace) {
          // Auto-detect: if in cycle, use cycle, otherwise page
          namespace = workflowState.cycleDepth > 0 ? 'cycle' : 'page';
        }

        this.saveVariable(workflowState, output.variableName, value, namespace, step);
        console.log(`💾 Saved variable "${output.variableName}" to namespace "${namespace}" from path "${output.sourcePath}"`);
        
        // CRITICAL: If this is journeysToExecute, save journeys to backend immediately
        if (output.variableName === 'journeysToExecute' && Array.isArray(value) && value.length > 0) {
          // Update workflowState with journeys
          workflowState.journeys = value;
          workflowState.journeysToExecute = value;
          if (!workflowState.context) {
            workflowState.context = {};
          }
          workflowState.context.journeysToExecute = value;
          
          console.log(`✅ [JOURNEYS-VAROUTPUT] Found ${value.length} journey(s) via variableOutputs, saving immediately`);
          
          // Get pageId and projectId
          let pageIdToSave = workflowState.pageId || this.context?.page_id || this.context?.pageId || null;
          let projectIdToSave = workflowState.projectId || this.context?.project_id || this.context?.projectId || null;
          
          // Try to get pageId if missing
          if (!pageIdToSave && projectIdToSave && workflowState.pageUrl) {
            try {
              // We need jobId - get it from context or workflowState
              const jobIdToUse = workflowState.jobId || this.context?.job_id || null;
              if (jobIdToUse) {
                pageIdToSave = await this.ensurePageId(workflowState, jobIdToUse);
              }
            } catch (pageError) {
              console.warn(`⚠️ [JOURNEYS-VAROUTPUT] Failed to get pageId: ${pageError.message}`);
            }
          }
          
          // Save journeys if we have pageId and projectId
          if (pageIdToSave && projectIdToSave) {
            try {
              const jobIdToUse = workflowState.jobId || this.context?.job_id || null;
              const payload = {
                saveLegs: true,
                journeys: value,
                job_id: jobIdToUse
              };
              
              console.log(`🔍 [JOURNEYS-VAROUTPUT] Saving ${value.length} journey(s) from variableOutputs to page ${pageIdToSave}`);
              const response = await axios.post(
                `${this.backendUrl}/api/pages/${pageIdToSave}/save-analysis`,
                payload,
                { headers: this.getAuthHeaders() }
              );
              
              console.log(`✅ [JOURNEYS-VAROUTPUT] Successfully saved ${value.length} journey(s) from variableOutputs. Response status: ${response.status}`);
              if (jobIdToUse && this.backendLogger) {
                await this.backendLogger.appendJobLog(jobIdToUse, 'info', `✅ [JOURNEYS-VAROUTPUT] Saved ${value.length} journey(s) from variableOutputs`, 'WORKFLOW-ANALYZER', {
                  journeys_count: value.length,
                  page_id: pageIdToSave,
                  response_status: response.status
                });
              }
            } catch (varOutputError) {
              console.error(`❌ [JOURNEYS-VAROUTPUT] Failed to save journeys from variableOutputs: ${varOutputError.message}`);
              const jobIdToUse = workflowState.jobId || this.context?.job_id || null;
              if (jobIdToUse && this.backendLogger) {
                await this.backendLogger.appendJobLog(jobIdToUse, 'error', `❌ [JOURNEYS-VAROUTPUT] Failed to save journeys: ${varOutputError.message}`, 'WORKFLOW-ANALYZER', {
                  error: varOutputError.message
                });
              }
            }
          } else {
            console.warn(`⚠️ [JOURNEYS-VAROUTPUT] Cannot save journeys: missing pageId (${pageIdToSave}) or projectId (${projectIdToSave})`);
          }
        }
      } else {
        console.warn(`⚠️ Could not resolve value for variable "${output.variableName}" from path "${output.sourcePath}"`);
      }
    }
  }

  /**
   * Process variable inputs configuration for a step
   * Reads variables and makes them available in workflowState context
   */
  processVariableInputs(step, workflowState) {
    if (!step.config?.variableInputs || !Array.isArray(step.config.variableInputs)) {
      return {};
    }

    this.initializeVariablePool(workflowState);
    const inputs = {};

    for (const input of step.config.variableInputs) {
      if (!input.variableName || !input.targetPath) {
        continue;
      }

      const value = this.readVariable(workflowState, input.variableName, input.namespace);
      if (value !== undefined) {
        // Set value at targetPath in workflowState.context
        if (!workflowState.context) {
          workflowState.context = {};
        }
        this.setNestedValue(workflowState.context, input.targetPath, value);
        inputs[input.variableName] = value;
        console.log(`📖 Loaded variable "${input.variableName}" from namespace "${input.namespace || 'auto'}" to context.${input.targetPath}`);
      } else {
        console.warn(`⚠️ Variable "${input.variableName}" not found in namespace "${input.namespace || 'auto'}"`);
      }
    }

    return inputs;
  }

  /**
   * Execute content-change step - performs variable operations (set, update, delete, export) using JSON configuration
   */
  async executeContentChangeStep(step, workflowState, jobId = null) {
    console.log(`🔧 Executing content-change step (${step.name})`);
    
    try {
      const config = step.config || {};
      let jsonConfig = config.json || '{}';
      
      // Parse JSON configuration
      let operation;
      try {
        // Handle both string and object JSON
        if (typeof jsonConfig === 'string') {
          operation = JSON.parse(jsonConfig);
        } else {
          operation = jsonConfig;
        }
      } catch (parseError) {
        throw new Error(`Invalid JSON configuration: ${parseError.message}`);
      }
      
      if (!operation.operation) {
        const errorMessage = `Missing required field "operation" in content-change step "${step.name || step.id}"`;
        const missingPath = 'step.config.json.operation';
        console.error(`❌ ${errorMessage}`);
        console.error(`❌ Missing JSON path: ${missingPath}`);
        console.error(`❌ Full step:`, JSON.stringify(step, null, 2));
        console.error(`❌ Step config:`, JSON.stringify(step.config, null, 2));
        console.error(`❌ Parsed operation:`, JSON.stringify(operation, null, 2));
        
        const fullContext = {
          step_id: step.id,
          step_name: step.name || step.type,
          step_type: step.type,
          step_config: step.config,
          parsed_operation: operation,
          full_step: step
        };
        
        if (jobId && this.backendLogger) {
          try {
            await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', {
              ...fullContext,
              missing_path: missingPath
            });
          } catch (e) {
            console.error(`❌ Failed to log error to backend:`, e.message);
          }
        }
        
        throw new Error(`${errorMessage}\nMissing JSON path: ${missingPath}\nFull step: ${JSON.stringify(step, null, 2)}`);
      }
      
      this.initializeVariablePool(workflowState);
      
      const opType = operation.operation.toLowerCase();
      let result = { success: true, operation: opType };
      
      switch (opType) {
        case 'set':
          // Support both single variable (legacy) and multiple variables (new)
          if (operation.variables && Array.isArray(operation.variables)) {
            // Multiple variables: [{name, value, namespace}, ...]
            const setResults = [];
            for (const varConfig of operation.variables) {
              if (!varConfig.name) {
                console.warn(`⚠️ Skipping variable config missing "name" field`);
                continue;
              }
              const varNamespace = varConfig.namespace || operation.namespace || (workflowState.cycleDepth > 0 ? 'cycle' : 'page');
              const varValue = varConfig.value;
              this.saveVariable(workflowState, varConfig.name, varValue, varNamespace, step);
              setResults.push(`${varConfig.name}=${JSON.stringify(varValue)}`);
              console.log(`✅ Set variable "${varConfig.name}" to ${JSON.stringify(varValue)} in namespace "${varNamespace}"`);
            }
            result.message = `Set ${setResults.length} variable(s): ${setResults.join(', ')}`;
            console.log(`✅ ${result.message}`);
          } else {
            // Single variable (legacy format)
            if (!operation.name) {
              throw new Error('Set operation requires "name" field or "variables" array');
            }
            const namespace = operation.namespace || (workflowState.cycleDepth > 0 ? 'cycle' : 'page');
            const value = operation.value;
            this.saveVariable(workflowState, operation.name, value, namespace, step);
            result.message = `Variable "${operation.name}" set to ${JSON.stringify(value)} in namespace "${namespace}"`;
            console.log(`✅ ${result.message}`);
          }
          break;
          
        case 'update':
          if (!operation.name || !operation.expression) {
            throw new Error('Update operation requires "name" and "expression" fields');
          }
          const currentValue = this.readVariable(workflowState, operation.name);
          if (currentValue === undefined) {
            throw new Error(`Variable "${operation.name}" not found for update`);
          }
          // Simple expression evaluation: replace $value with current value
          let expression = operation.expression;
          expression = expression.replace(/\$value/g, JSON.stringify(currentValue));
          try {
            // Evaluate expression safely (limited context)
            const newValue = eval(`(${expression})`);
            const updateNamespace = operation.namespace || (workflowState.cycleDepth > 0 ? 'cycle' : 'page');
            this.saveVariable(workflowState, operation.name, newValue, updateNamespace, step);
            result.message = `Variable "${operation.name}" updated from ${JSON.stringify(currentValue)} to ${JSON.stringify(newValue)}`;
            console.log(`✅ ${result.message}`);
          } catch (evalError) {
            throw new Error(`Failed to evaluate expression "${operation.expression}": ${evalError.message}`);
          }
          break;
          
        case 'delete':
          if (!operation.name) {
            throw new Error('Delete operation requires "name" field');
          }
          // Delete from all namespaces (search order: cycle -> page -> job)
          const cycleIndex = workflowState.cycleStack.length - 1;
          let deleted = false;
          if (cycleIndex >= 0 && workflowState.variablePool.cycle[cycleIndex]?.[operation.name]) {
            delete workflowState.variablePool.cycle[cycleIndex][operation.name];
            deleted = true;
          }
          if (workflowState.variablePool.page[operation.name]) {
            delete workflowState.variablePool.page[operation.name];
            deleted = true;
          }
          if (workflowState.variablePool.job[operation.name]) {
            delete workflowState.variablePool.job[operation.name];
            deleted = true;
          }
          if (!deleted) {
            throw new Error(`Variable "${operation.name}" not found for deletion`);
          }
          result.message = `Variable "${operation.name}" deleted`;
          console.log(`✅ ${result.message}`);
          break;
          
        case 'export':
          if (!operation.exports || !Array.isArray(operation.exports)) {
            throw new Error('Export operation requires "exports" array field');
          }
          for (const exportItem of operation.exports) {
            if (!exportItem.source || !exportItem.target) {
              console.warn(`⚠️ Skipping export item missing source or target`);
              continue;
            }
            
            // Resolve source value
            const sourceParts = exportItem.source.split('.');
            let sourceValue;
            if (sourceParts[0] === 'loop' || sourceParts[0] === 'cycle') {
              const cycleIdx = workflowState.cycleStack.length - 1;
              if (cycleIdx >= 0) {
                const sourceVar = sourceParts.slice(1).join('.');
                sourceValue = this.readVariable(workflowState, sourceVar, 'cycle');
              }
            } else if (sourceParts[0] === 'shared' || sourceParts[0] === 'page') {
              const sourceVar = sourceParts.slice(1).join('.');
              sourceValue = this.readVariable(workflowState, sourceVar, 'page');
            } else if (sourceParts[0] === 'job') {
              const sourceVar = sourceParts.slice(1).join('.');
              sourceValue = this.readVariable(workflowState, sourceVar, 'job');
            } else if (sourceParts[0] === 'step' || sourceParts[0] === 'state') {
              // Resolve from workflowState
              const sourcePath = sourceParts.slice(1).join('.');
              sourceValue = this.getNestedValue(workflowState, sourcePath);
            } else {
              // Try direct path
              sourceValue = this.getNestedValue(workflowState, exportItem.source);
            }
            
            if (sourceValue === undefined) {
              console.warn(`⚠️ Source value not found: ${exportItem.source}`);
              continue;
            }
            
            // Resolve target namespace and variable name
            const targetParts = exportItem.target.split('.');
            let targetNamespace = 'page';
            let targetVar;
            if (targetParts[0] === 'shared' || targetParts[0] === 'page') {
              targetNamespace = 'page';
              targetVar = targetParts.slice(1).join('.');
            } else if (targetParts[0] === 'job') {
              targetNamespace = 'job';
              targetVar = targetParts.slice(1).join('.');
            } else {
              targetVar = exportItem.target;
            }
            
            const strategy = exportItem.strategy || 'replace';
            if (strategy === 'replace') {
              this.saveVariable(workflowState, targetVar, sourceValue, targetNamespace, step);
            } else if (strategy === 'merge' && typeof sourceValue === 'object' && sourceValue !== null) {
              const existing = this.readVariable(workflowState, targetVar, targetNamespace);
              if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
                const merged = { ...existing, ...sourceValue };
                this.saveVariable(workflowState, targetVar, merged, targetNamespace, step);
              } else {
                this.saveVariable(workflowState, targetVar, sourceValue, targetNamespace, step);
              }
            } else if (strategy === 'append' && Array.isArray(sourceValue)) {
              const existing = this.readVariable(workflowState, targetVar, targetNamespace);
              if (Array.isArray(existing)) {
                const appended = [...existing, ...sourceValue];
                this.saveVariable(workflowState, targetVar, appended, targetNamespace, step);
              } else {
                this.saveVariable(workflowState, targetVar, sourceValue, targetNamespace, step);
              }
            } else {
              this.saveVariable(workflowState, targetVar, sourceValue, targetNamespace, step);
            }
            
            console.log(`✅ Exported ${exportItem.source} → ${exportItem.target} (${strategy})`);
          }
          result.message = `Exported ${operation.exports.length} variable(s)`;
          break;
          
        default:
          throw new Error(`Unknown operation type: ${opType}. Supported: set, update, delete, export`);
      }
      
      this.storeStepResult(step, result, workflowState);
      
      if (jobId) {
        try {
          await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'info',
            message: `🔧 Content-change: ${result.message}`,
            component: 'WORKFLOW-ANALYZER',
            metadata: {
              step_id: step.id,
              step_name: step.name,
              step_type: 'content-change',
              operation: opType,
              result: result
            }
          }, {
            headers: this.getAuthHeaders()
          });
        } catch (e) {
          // Silent fail
        }
      }
      
      return result;
      
    } catch (error) {
      console.error(`❌ Content-change step failed: ${error.message}`);
      const errorResult = {
        success: false,
        error: error.message,
        operation: step.config?.json ? (typeof step.config.json === 'string' ? JSON.parse(step.config.json).operation : step.config.json.operation) : 'unknown'
      };
      this.storeStepResult(step, errorResult, workflowState);
      throw error;
    }
  }

  /**
   * Set nested value in object using dot notation
   */
  setNestedValue(obj, path, value) {
    const keys = path.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!current[key] || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key];
    }
    current[keys[keys.length - 1]] = value;
  }

  /**
   * Resolve path with slug support
   * Supports both slug-based paths (e.g., "generate-login-code.playwright_code") 
   * and direct paths (e.g., "lastAIResponse.playwright_code")
   */
  resolvePath(path, workflowState) {
    // Remove workflowState. prefix if present
    const normalizedPath = path.startsWith('workflowState.')
      ? path.substring('workflowState.'.length)
      : path;
    
    // Check if path starts with a step slug (slug-based reference)
    const parts = normalizedPath.split('.');
    if (parts.length > 0) {
      const firstPart = parts[0];
      // Check if first part matches any step slug
      const stepSlug = Object.keys(workflowState).find(key => {
        const stepData = workflowState[key];
        return stepData && stepData.stepName && this.generateSlug(stepData.stepName) === firstPart;
      }) || Object.keys(workflowState).find(key => {
        return this.generateSlug(key) === firstPart;
      });
      
      if (stepSlug && workflowState[stepSlug]) {
        // It's a slug-based reference
        const stepData = workflowState[stepSlug];
        if (parts.length === 1) {
          // Just the slug - return the whole step data
          return stepData;
        } else {
          // Slug with path - resolve the nested path
          const remainingPath = parts.slice(1).join('.');
          return this.getNestedValue(stepData, remainingPath);
        }
      }
    }
    
    // Fall back to direct path resolution
    return this.getNestedValue(workflowState, normalizedPath);
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
   * Clean script to remove markdown code blocks and function declarations
   */
  /**
   * Parse script to extract meaningful action lines for logging
   */
  parseScriptActions(script) {
    if (!script || typeof script !== 'string') return [];
    
    const actions = [];
    const lines = script.split('\n');
    const inputSelectors = new Set();
    const loggedInputSelectors = new Set();
    const inputMethods = new Set(['fill', 'type', 'press', 'selectOption', 'check', 'uncheck']);

    const normalizeSelectorKey = (selectorKey) => {
      if (!selectorKey) return null;
      const cleaned = selectorKey.replace(/^[#.]+/, '').trim();
      const normalized = cleaned.replace(/(Handle|Sel|Selector|Input|Field|Locator)$/i, '').trim() || cleaned;
      if (normalized === 'msg') return 'message';
      if (normalized === 'cat') return 'category';
      return normalized;
    };

    const extractQuerySelector = (lineText) => {
      const match = lineText.match(/document\.querySelector\(([^)]+)\)/i);
      if (!match) return null;
      const rawSelector = match[1].trim();
      const selector = rawSelector.replace(/^['"`]|['"`]$/g, '').trim();
      return selector || null;
    };

    const extractActionMethodAndSelector = (lineText) => {
      const match = lineText.match(/\b([A-Za-z_$][\w$]*)\.(click|fill|type|press|selectOption|check|uncheck)\s*\(([^,]+)?/i);
      if (!match) return { target: null, method: null, selector: null, normalizedSelector: null };
      const target = match[1] || null;
      const method = match[2]?.toLowerCase() || null;
      const rawSelector = match[3] ? match[3].trim() : null;

      if (target && target !== 'page' && target !== 'element') {
        const selector = normalizeSelectorKey(target);
        return { target, method, selector, normalizedSelector: selector };
      }
      if (!rawSelector) return { method, selector: null };
      const selector = rawSelector.replace(/^['"`]|['"`]$/g, '').trim();
      const normalizedSelector = normalizeSelectorKey(selector || null);
      return { target, method, selector: selector || null, normalizedSelector };
    };
    
    // Common Playwright user-action patterns (exclude waits, screenshots, and navigation)
    // CRITICAL: Only count direct user interactions (inputs/selects/clicks)
    const actionPatterns = [
      // Standard await patterns
      /await\s+page\.(click|fill|type|press|selectOption|check|uncheck)\b/i,
      /await\s+page\.locator\([^)]*\)\.(click|fill|type|press|selectOption|check|uncheck)\b/i,
      /await\s+element\.(click|fill|type|press|selectOption|check|uncheck)\b/i,
      /await\s+[A-Za-z_$][\w$]*\.(click|fill|type|press|selectOption|check|uncheck)\b/i,
      // Without await (some scripts don't use await)
      /page\.(click|fill|type|press|selectOption|check|uncheck)\b/i,
      /page\.locator\([^)]*\)\.(click|fill|type|press|selectOption|check|uncheck)\b/i,
      /[A-Za-z_$][\w$]*\.(click|fill|type|press|selectOption|check|uncheck)\b/i,
      // Locator patterns with action chaining
      /await\s+page\.getBy(Text|Role|Label|Placeholder|AltText|Title|TestId)\([^)]*\)\.(click|fill|type|press|selectOption|check|uncheck)\b/i,
      /page\.getBy(Text|Role|Label|Placeholder|AltText|Title|TestId)\([^)]*\)\.(click|fill|type|press|selectOption|check|uncheck)\b/i,
      // DOM selector actions in evaluate blocks
      /document\.querySelector\(/i,
    ];
    
    // Track if we're inside the IIFE body (skip the wrapper lines)
    let insideIIFE = false;
    let braceDepth = 0;

    // Pre-scan: identify selectors that are used for input actions (fill/type/select)
    let lastFocusSelector = null;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const { target, method, normalizedSelector } = extractActionMethodAndSelector(line);
      if (method === 'click' && normalizedSelector) {
        lastFocusSelector = normalizedSelector;
      }
      if (method && inputMethods.has(method) && normalizedSelector) {
        inputSelectors.add(normalizedSelector);
      }
      if (target && target.toLowerCase() === 'keyboard' && method === 'type' && lastFocusSelector) {
        inputSelectors.add(lastFocusSelector);
      }
      const querySelector = extractQuerySelector(line);
      if (querySelector) {
        const normalizedSelector = normalizeSelectorKey(querySelector);
        if (normalizedSelector) {
          inputSelectors.add(normalizedSelector);
        }
      }
    }
    
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
      if (line.match(/^(const|let|var)\s+\w+\s*=\s*[^a-zA-Z]/) && !line.match(/page\.|element\.|getBy/)) {
        continue;
      }
      
      // CRITICAL: Check if line contains a Playwright action
      // Also check multi-line patterns by looking ahead/behind if needed
      let matchedPattern = null;
      for (const pattern of actionPatterns) {
        if (pattern.test(line)) {
          matchedPattern = pattern;
          break;
        }
      }
      
      // If no match on current line, check if it's part of a multi-line statement
      // by checking if line ends with certain characters that suggest continuation
      if (!matchedPattern && (line.endsWith('(') || line.endsWith('.') || line.endsWith('['))) {
        // Look ahead a few lines to see if there's an action
        let combinedLine = line;
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const nextLine = lines[j].trim();
          if (!nextLine) continue;
          combinedLine += ' ' + nextLine;
          
          // Check combined line
          for (const pattern of actionPatterns) {
            if (pattern.test(combinedLine)) {
              matchedPattern = pattern;
              break;
            }
          }
          if (matchedPattern) break;
          
          // Stop if we hit a semicolon or closing brace
          if (nextLine.includes(';') || nextLine.includes('}')) break;
        }
      }
      
      if (matchedPattern) {
        if (line.match(/waitFor(Function|Selector|Timeout|LoadState|Navigation|Response|Request)\s*\(/i)) {
          continue;
        }
        // Ignore non-submit keypresses (keep Enter/Return only)
        if (/\.keyboard\.press\(\s*['"]([^'"]+)['"]\s*\)/i.test(line)) {
          const keyMatch = line.match(/\.keyboard\.press\(\s*['"]([^'"]+)['"]\s*\)/i);
          const key = keyMatch ? keyMatch[1] : '';
          if (!['Enter', 'Return'].includes(key)) {
            continue;
          }
        }
        // Ignore clicks that only focus form fields (inputs/textarea/select)
        if (/\.click\(\s*['"]([^'"]+)['"]\s*\)/i.test(line)) {
          const clickMatch = line.match(/\.click\(\s*['"]([^'"]+)['"]\s*\)/i);
          const selector = clickMatch ? clickMatch[1] : '';
          if (/(input|textarea|select)/i.test(selector)) {
            continue;
          }
        }

        const { target, method, normalizedSelector } = extractActionMethodAndSelector(line);
        let effectiveSelector = normalizedSelector;
        let effectiveMethod = method;

        const querySelector = extractQuerySelector(line);
        if (querySelector && !effectiveMethod) {
          if (querySelector.toLowerCase().includes('simpleform')) {
            // Skip form existence checks; they are not user actions.
            continue;
          }
          effectiveMethod = 'selectOption';
          effectiveSelector = normalizeSelectorKey(querySelector);
        }

        if (effectiveMethod === 'click' && effectiveSelector) {
          lastFocusSelector = normalizedSelector;
        }
        if (target && target.toLowerCase() === 'keyboard' && effectiveMethod === 'type' && lastFocusSelector) {
          effectiveSelector = lastFocusSelector;
        }

        if (effectiveMethod === 'click' && effectiveSelector && inputSelectors.has(effectiveSelector)) {
          // Skip clicks that are part of input field focus when an input action exists.
          continue;
        }
        if (effectiveMethod === 'fill' && /,\s*['"]\s*['"]\s*\)/i.test(line)) {
          // Skip empty clears; we only want one input action per field.
          continue;
        }
        if (effectiveMethod && inputMethods.has(effectiveMethod) && effectiveSelector) {
          if (loggedInputSelectors.has(effectiveSelector)) {
            // Skip repeated input actions for the same selector.
            continue;
          }
          loggedInputSelectors.add(effectiveSelector);
        }

        // Clean up the action line for display
        let displayLine = line;
        
        // Remove leading/trailing semicolons and whitespace
        displayLine = displayLine.replace(/^[;\s]+|[;\s]+$/g, '');
        
        // Truncate very long lines but preserve the action
        if (displayLine.length > 150) {
          const match = displayLine.match(/(await\s+)?(page|element|page\.mouse|page\.keyboard|page\.locator|page\.getBy)\.?([a-zA-Z]+)?/);
          if (match) {
            const awaitPart = match[1] || '';
            const objPart = match[2] || 'page';
            const methodPart = match[3] || 'action';
            displayLine = `${awaitPart}${objPart}.${methodPart}(...)`;
          } else {
            // Fallback: just truncate
            displayLine = displayLine.substring(0, 147) + '...';
          }
        }
        
        actions.push(displayLine);
      }
    }
    
    const selectOptionSelectors = new Set();
    const selectOptionTokens = new Set();
    for (const actionLine of actions) {
      const { method, normalizedSelector } = extractActionMethodAndSelector(actionLine);
      if (method === 'selectOption' && normalizedSelector) {
        selectOptionSelectors.add(normalizedSelector);
      }
      const tokenMatch = actionLine.match(/selectOption\(([^,]+)/i);
      if (tokenMatch && tokenMatch[1]) {
        selectOptionTokens.add(tokenMatch[1].trim());
      }
    }

    const filteredActions = [];
    const seenSelectOptionSelectors = new Set();
    const seenSelectOptionTokens = new Set();
    for (const actionLine of actions) {
      const { method, normalizedSelector } = extractActionMethodAndSelector(actionLine);
      if (method === 'selectOption' && normalizedSelector) {
        if (seenSelectOptionSelectors.has(normalizedSelector)) {
          continue;
        }
        seenSelectOptionSelectors.add(normalizedSelector);
      }
      const tokenMatch = actionLine.match(/selectOption\(([^,]+)/i);
      if (tokenMatch && tokenMatch[1]) {
        const token = tokenMatch[1].trim();
        if (seenSelectOptionTokens.has(token)) {
          continue;
        }
        seenSelectOptionTokens.add(token);
      }
      if (method === 'click' && normalizedSelector && selectOptionSelectors.has(normalizedSelector)) {
        continue;
      }
      if (method === 'click' && selectOptionTokens.size > 0) {
        let clickMatchesSelect = false;
        for (const token of selectOptionTokens) {
          if (actionLine.includes(token)) {
            clickMatchesSelect = true;
            break;
          }
        }
        if (clickMatchesSelect) {
          continue;
        }
      }
      filteredActions.push(actionLine);
    }

    return filteredActions;
  }

  cleanScript(script) {
    if (!script || typeof script !== 'string') {
      return script;
    }
    
    let cleaned = script.trim();
    // Fix smart/curly quotes and other chars that cause "Invalid or unexpected token" in executor
    cleaned = cleaned.replace(/\u2018|\u2019/g, "'").replace(/\u201C|\u201D/g, '"').replace(/\u2026/g, '...');
    
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
    cleaned = cleaned.trim();
    
    // Preserve async IIFE wrappers (return await (async () => { ... })()) to avoid breaking structure.
    // Must run AFTER code block extraction so scripts inside ``` are preserved.
    const asyncIifePattern = /^return\s+await\s+\(async\s*\(\)\s*=>\s*\{/;
    if (asyncIifePattern.test(cleaned)) {
      return cleaned;
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
    
    // Remove IIFE wrappers only when that won't leave invalid "return await " + try/catch
    const wouldLeaveBrokenReturn = /^return\s+await\s+\(async\s*\(\)\s*=>\s*\{/.test(cleaned.trim());
    if (!wouldLeaveBrokenReturn) {
      cleaned = cleaned.replace(/\(async\s*\([^)]*\)\s*=>\s*\{/g, '');
      cleaned = cleaned.replace(/\(async\s+function\s*\([^)]*\)\s*\{[^}]*\}\)\s*\(\)/g, '');
      cleaned = cleaned.replace(/\(async\s*\(\)\s*=>\s*\{[^}]*\}\)\s*\(\)/g, '');
    }
    
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
   * Execute code step (static code)
   */
  async executeCodeStep(page, step, workflowState, jobId = null, nextStep = null) {
    const startTime = Date.now();
    console.log(`🚀 Executing static code (${step.name})`);
    
    // Log execution start
    if (jobId) {
      try {
        await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
          jobId: jobId,
          level: 'debug',
          message: `🚀 Starting code execution: ${step.name}`,
          component: 'WORKFLOW-ANALYZER',
          metadata: {
            step_id: step.id,
            step_name: step.name,
            step_type: 'execute-code',
            page_url: page.url()
          }
        }, {
          headers: this.getAuthHeaders()
        });
      } catch (e) {
        // Silent fail - don't block execution
      }
    }
    
    let code = step.config?.code || step.code;
    const originalCodeLength = code?.length || 0;
    
    if (!code) {
      const errorMessage = `Missing required field "code" for step "${step.name || step.id}"`;
      const missingPath = 'step.config.code';
      console.error(`❌ ${errorMessage}`);
      console.error(`❌ Missing JSON path: ${missingPath}`);
      console.error(`❌ Full step:`, JSON.stringify(step, null, 2));
      console.error(`❌ Step config:`, JSON.stringify(step.config, null, 2));
      
      const fullContext = {
        step_id: step.id,
        step_name: step.name || step.type,
        step_type: step.type,
        step_config: step.config,
        full_step: step
      };
      
      if (jobId && this.backendLogger) {
        try {
          await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', {
            ...fullContext,
            missing_path: missingPath
          });
        } catch (e) {
          console.error(`❌ Failed to log error to backend:`, e.message);
        }
      }
      
      throw new Error(`${errorMessage}\nMissing JSON path: ${missingPath}\nFull step: ${JSON.stringify(step, null, 2)}`);
    }
    
    // Clean the code to remove markdown code blocks and function declarations
    code = this.cleanScript(code);
    const cleanedCodeLength = code?.length || 0;
    
    if (!code || code.trim().length === 0) {
      if (jobId) {
        try {
          await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'error',
            message: `❌ Script is empty after cleaning for step: ${step.name}`,
            component: 'WORKFLOW-ANALYZER',
            metadata: {
              step_id: step.id,
              step_name: step.name,
              original_code_length: originalCodeLength,
              cleaned_code_length: cleanedCodeLength,
              original_code_preview: step.config?.code?.substring(0, 500) || step.code?.substring(0, 500) || 'N/A'
            }
          }, {
            headers: this.getAuthHeaders()
          });
        } catch (e) {}
      }
      throw new Error(`Script is empty after cleaning for step: ${step.name}`);
    }
    
    // Log cleaned code info
    if (jobId) {
      try {
        await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
          jobId: jobId,
          level: 'debug',
          message: `📝 Code cleaned (${originalCodeLength} → ${cleanedCodeLength} chars)`,
          component: 'WORKFLOW-ANALYZER',
          metadata: {
            step_id: step.id,
            step_name: step.name,
            cleaned_code_preview: code.substring(0, 500),
            cleaning_removed_chars: originalCodeLength - cleanedCodeLength
          }
        }, {
          headers: this.getAuthHeaders()
        });
      } catch (e) {}
    }
    
    try {
      const timeout = step.config?.timeout || 30000;
      const urlBefore = page.url();
      const titleBefore = await page.title();
      
      // Log execution start
      if (jobId) {
        try {
          await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'debug',
            message: `▶️ Executing code in browser context...`,
            component: 'WORKFLOW-ANALYZER',
            metadata: {
              step_id: step.id,
              step_name: step.name,
              url_before: urlBefore,
              title_before: titleBefore,
              timeout_ms: timeout
            }
          }, {
            headers: this.getAuthHeaders()
          });
        } catch (e) {}
      }
      
      const result = await page.evaluate(
        ({ code, workflowState, timeout }) => {
          // Extract commonly used variables from workflowState for direct access in browser context
          const analysis = workflowState?.analysis || workflowState?.playwrightAnalysis || {};
          const playwrightAnalysis = workflowState?.playwrightAnalysis || {};
          const collectedLinks = workflowState?.collectedLinks || playwrightAnalysis?.links || [];
          const collectedForms = workflowState?.collectedForms || playwrightAnalysis?.forms || [];
          const collectedInteractiveElements = workflowState?.collectedInteractiveElements || playwrightAnalysis?.interactive_elements || [];
          const visibleText = workflowState?.visibleText || workflowState?.visible_text || '';
          const interactiveElements = workflowState?.interactiveElements || workflowState?.interactive_elements || [];
          const forms = workflowState?.forms || [];
          const links = workflowState?.links || [];
          const pageUrl = workflowState?.pageUrl || workflowState?.page_url || '';
          const pageTitle = workflowState?.pageTitle || workflowState?.page_title || '';
          const pageDescription = workflowState?.pageDescription || workflowState?.page_description || '';
          const currentLeg = workflowState?.currentLeg || {};
          const currentItem = workflowState?.currentItem || {};
          const legsToExecute = workflowState?.legsToExecute || workflowState?.legs || [];
          const context = workflowState?.context || {};
          const lastExecutionResult = workflowState?.lastExecutionResult || null;
          const executionResult = lastExecutionResult;
          // Extract step results from workflowState (all stored step results)
          const results = workflowState?.results || {};
          // Common step result variables that might be referenced
          // Try multiple possible locations for playwright analysis result
          let playwrightStepResult = workflowState?.playwright_analysis?.result || 
            workflowState?.playwrightAnalysis || 
            results?.playwright_analysis?.result ||
            workflowState?.playwright_analysis ||
            {};
          // Try to find any step with playwright in its name/id
          if (!playwrightStepResult || typeof playwrightStepResult !== 'object' || Object.keys(playwrightStepResult).length === 0) {
            for (const [key, value] of Object.entries(workflowState)) {
              if (key && typeof key === 'string' && 
                  (key.includes('playwright') || key.includes('analysis')) && 
                  value && typeof value === 'object' && 
                  (value.result || value.forms || value.links || value.interactive_elements)) {
                playwrightStepResult = value.result || value;
                break;
              }
            }
          }
          // Fallback to empty object if still not found
          if (!playwrightStepResult || typeof playwrightStepResult !== 'object') {
            playwrightStepResult = {};
          }
          const stepResult = lastExecutionResult || {};
          
          // Create runner function with all extracted variables available in scope
          const runner = new Function(
            'workflowState',
            'analysis',
            'playwrightAnalysis',
            'collectedLinks',
            'collectedForms',
            'collectedInteractiveElements',
            'visibleText',
            'interactiveElements',
            'forms',
            'links',
            'pageUrl',
            'pageTitle',
            'pageDescription',
            'currentLeg',
            'currentItem',
            'legsToExecute',
            'context',
            'lastExecutionResult',
            'executionResult',
            'results',
            'playwrightStepResult',
            'stepResult',
            `return (async () => {\n${code}\n})();`
          );

          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error(`Code execution timed out after ${timeout}ms`));
            }, timeout);

            Promise.resolve(runner(
              workflowState,
              analysis,
              playwrightAnalysis,
              collectedLinks,
              collectedForms,
              collectedInteractiveElements,
              visibleText,
              interactiveElements,
              forms,
              links,
              pageUrl,
              pageTitle,
              pageDescription,
              currentLeg,
              currentItem,
              legsToExecute,
              context,
              lastExecutionResult,
              executionResult,
              results,
              playwrightStepResult,
              stepResult
            ))
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
      
      const urlAfter = page.url();
      const titleAfter = await page.title();
      const executionTime = Date.now() - startTime;
      
      // Log successful execution
      if (jobId) {
        try {
          await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'info',
            message: `✅ Code executed successfully (${executionTime}ms): ${step.name}`,
            component: 'WORKFLOW-ANALYZER',
            metadata: {
              step_id: step.id,
              step_name: step.name,
              execution_time_ms: executionTime,
              url_before: urlBefore,
              url_after: urlAfter,
              title_before: titleBefore,
              title_after: titleAfter,
              url_changed: urlBefore !== urlAfter,
              title_changed: titleBefore !== titleAfter,
              result_preview: typeof result === 'object' ? JSON.stringify(result).substring(0, 500) : String(result).substring(0, 500)
            }
          }, {
            headers: this.getAuthHeaders()
          });
        } catch (e) {}
      }
      
      workflowState.lastExecutionResult = result;
      if (result && typeof result === 'object') {
        const scriptFromResult = result.legScriptToExecute || result.script || result.playwright_script || result.code || null;
        if (typeof scriptFromResult === 'string' && scriptFromResult.trim().length > 0) {
          workflowState.legScriptToExecute = scriptFromResult;
          if (!workflowState.context) {
            workflowState.context = {};
          }
          workflowState.context.legScriptToExecute = scriptFromResult;
        }
      }
      
      // If result contains workflowState updates (like legsToExecute, context updates), merge them
      const resultType = typeof result;
      const isResultArray = Array.isArray(result);
      const resultKeys = result && typeof result === 'object' && !Array.isArray(result) ? Object.keys(result) : [];
      
      console.log(`🔍 Checking result for merge - type: ${resultType}, isArray: ${isResultArray}, keys: ${resultKeys.join(', ') || 'N/A'}`);
      
      try {
        const resultStr = JSON.stringify(result);
        console.log(`🔍 Result preview: ${resultStr.substring(0, 500)}${resultStr.length > 500 ? '...' : ''}`);
      } catch (e) {
        console.log(`⚠️ Could not stringify result: ${e.message}`);
        console.log(`🔍 Result:`, result);
      }
      
      // Check if result has legsToExecute (handle both object and array results)
      let resultObj = result;
      if (isResultArray) {
        // If result is an array, check if it's actually legsToExecute
        if (result.length > 0) {
          const firstItem = result[0];
          const firstItemKeys = typeof firstItem === 'object' && firstItem !== null ? Object.keys(firstItem) : [];
          console.log(`🔍 Array result: length=${result.length}, first item keys: ${firstItemKeys.join(', ')}`);
          
          if (typeof firstItem === 'object' && firstItem !== null && (firstItem.leg_id || firstItem.legId || firstItem.id || firstItem.type)) {
            // It's an array of leg objects - wrap it
            resultObj = { legsToExecute: result };
            console.log(`🔄 Wrapped array result into object with legsToExecute (${result.length} items)`);
          } else {
            console.log(`⚠️ Result is array but doesn't appear to be legs. Length: ${result.length}, first item type: ${typeof firstItem}, keys: ${firstItemKeys.join(',') || 'N/A'}`);
            // Check if it's an array containing a single object with legsToExecute
            if (result.length === 1 && typeof result[0] === 'object' && result[0] !== null && result[0].legsToExecute) {
              console.log(`🔄 Found legsToExecute in nested array object`);
              resultObj = result[0];
            } else {
              resultObj = null; // Can't extract legsToExecute from this array
            }
          }
        } else {
          console.log(`⚠️ Result is empty array`);
          resultObj = null;
        }
      }
      
      if (resultObj && typeof resultObj === 'object' && !Array.isArray(resultObj)) {
        if (resultObj.legsToExecute && Array.isArray(resultObj.legsToExecute)) {
          console.log(`📦 Merging legsToExecute: ${resultObj.legsToExecute.length} items`);
          if (resultObj.summary) {
            console.log(`📊 Legs summary:`, JSON.stringify(resultObj.summary));
          }
          workflowState.legsToExecute = resultObj.legsToExecute;
          if (!workflowState.context) {
            workflowState.context = {};
          }
          workflowState.context.legsToExecute = resultObj.legsToExecute;
          console.log(`✅ Merged legsToExecute into workflowState and context`);
        } else {
          const availableKeys = Object.keys(resultObj);
          console.log(`⚠️ Result doesn't have legsToExecute array. Result keys: ${availableKeys.join(', ')}`);
          // Try to find legsToExecute with different naming
          const legsKey = availableKeys.find(k => k.toLowerCase().includes('leg') && k.toLowerCase().includes('execute'));
          if (legsKey && Array.isArray(resultObj[legsKey])) {
            console.log(`🔄 Found legsToExecute with different key name: ${legsKey}`);
            workflowState.legsToExecute = resultObj[legsKey];
            if (!workflowState.context) {
              workflowState.context = {};
            }
            workflowState.context.legsToExecute = resultObj[legsKey];
            console.log(`✅ Merged legsToExecute from key ${legsKey}`);
          }
        }
        if (resultObj.context && typeof resultObj.context === 'object') {
          workflowState.context = { ...workflowState.context, ...resultObj.context };
        }
        if (resultObj.legs && Array.isArray(resultObj.legs)) {
          workflowState.legs = resultObj.legs;
        }
      } else if (resultObj === null && isResultArray && result.length === 0) {
        console.log(`⚠️ Result is empty array - code may have failed or returned nothing`);
      }
      
      this.storeStepResult(step, result, workflowState);
      console.log(`✅ Code execution completed: ${JSON.stringify(result).substring(0, 100)}...`);
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error(`❌ Code execution failed: ${error.message}`);
      
      // Log execution failure
      if (jobId) {
        try {
          await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'error',
            message: `❌ Code execution failed: ${error.message}`,
            component: 'WORKFLOW-ANALYZER',
            metadata: {
              step_id: step.id,
              step_name: step.name,
              execution_time_ms: executionTime,
              error_message: error.message,
              error_stack: error.stack?.substring(0, 1000),
              code_preview: code?.substring(0, 500) || 'N/A',
              page_url: page.url()
            }
          }, {
            headers: this.getAuthHeaders()
          });
        } catch (e) {
          // Silent fail - don't block error throwing
        }
      }
      
      // If next step is self-adjustable-ai-workflow, don't throw - let workflow continue
      if (nextStep && nextStep.type === 'self-adjustable-ai-workflow') {
        console.log(`🔄 Script execution failed, but next step is self-adjustable-ai-workflow - will retry`);
        // Store failure info for retry
        workflowState.lastScriptFailure = {
          step: step,
          error: error.message,
          script: code?.substring(0, 500) || 'N/A',
          timestamp: new Date(),
          executionResult: {
            success: false,
            error: error.message
          }
        };
        return {
          success: false,
          error: error.message
        }; // Return error result instead of throwing
      }
      
      throw error;
    }
  }

  /**
   * Execute code from variable step
   */
  async executeCodeFromVariableStep(page, step, workflowState, jobId, nextStep = null) {
    console.log(`🚀 Executing code from variable (${step.name})`);
    
    const sourceField = step.config?.sourceField;
    if (!sourceField) {
      const errorMessage = `Missing required field "sourceField" in step config for step "${step.name || step.id}"`;
      const missingPath = 'step.config.sourceField';
      const fullContext = {
        step_id: step.id,
        step_name: step.name,
        step_type: step.type,
        step_config: step.config,
        missing_field: 'sourceField',
        missing_path: missingPath,
        full_step: step
      };
      console.error(`❌ ${errorMessage}`);
      console.error(`❌ Missing JSON path: ${missingPath}`);
      console.error(`❌ Full step:`, JSON.stringify(step, null, 2));
      console.error(`❌ Full step context:`, JSON.stringify(fullContext, null, 2));
      if (jobId && this.backendLogger) {
        await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', fullContext);
      }
      throw new Error(`${errorMessage}\nMissing JSON path: ${missingPath}\nFull step: ${JSON.stringify(step, null, 2)}\nFull context: ${JSON.stringify(fullContext, null, 2)}`);
    }
    
    // Resolve the path with slug support
    let code = null;
    
    console.log(`🔍 Resolving code from sourceField: "${sourceField}"`);
    
    // CRITICAL: First check variable pool (page namespace) for direct variable access
    if (workflowState.variablePool?.page?.[sourceField]) {
      const varData = workflowState.variablePool.page[sourceField];
      code = varData?.value !== undefined ? varData.value : varData;
      if (code) {
        console.log(`✅ Resolved code from variable pool (page namespace): ${sourceField} (${code.length} chars)`);
      }
    }
    
    // Also check if it's stored directly in workflowState (from structureResultWithNamespaces or direct assignment)
    if (!code && workflowState[sourceField]) {
      const fieldData = workflowState[sourceField];
      if (typeof fieldData === 'object' && fieldData !== null && fieldData.value !== undefined) {
        code = fieldData.value;
        console.log(`✅ Resolved code from workflowState[${sourceField}].value (${code.length} chars)`);
      } else if (typeof fieldData === 'string') {
        code = fieldData;
        console.log(`✅ Resolved code from workflowState[${sourceField}] (direct string, ${code.length} chars)`);
      }
    }
    
    // Also check context.legScriptToExecute (legacy location)
    if (!code && workflowState.context?.[sourceField]) {
      code = workflowState.context[sourceField];
      console.log(`✅ Resolved code from workflowState.context[${sourceField}] (${typeof code === 'string' ? code.length + ' chars' : typeof code})`);
    }
    
    // Also check resolvePathValue which handles variable pool access
    if (!code) {
      code = this.resolvePathValue(workflowState, sourceField, 'context');
      if (code) {
        console.log(`✅ Resolved code from resolvePathValue (context): ${sourceField} (${typeof code === 'string' ? code.length + ' chars' : typeof code})`);
      }
    }
    
    // Also try resolvePathValue with 'results' source type
    if (!code) {
      code = this.resolvePathValue(workflowState, sourceField, 'results');
      if (code) {
        console.log(`✅ Resolved code from resolvePathValue (results): ${sourceField} (${typeof code === 'string' ? code.length + ' chars' : typeof code})`);
      }
    }
    
    if (!code) {
      code = this.resolvePath(sourceField, workflowState);
      if (code) {
        console.log(`✅ Resolved code from resolvePath: ${sourceField} (${typeof code === 'string' ? code.length + ' chars' : typeof code})`);
      }
    }
    
    // Fall back to workflowState.context if direct resolution failed
    if (!code && workflowState?.context) {
      code = this.resolvePath(sourceField, workflowState.context);
      if (code) {
        console.log(`✅ Resolved code from resolvePath(context): ${sourceField} (${typeof code === 'string' ? code.length + ' chars' : typeof code})`);
      }
    }

    // Fall back to checking plain context paths (e.g., context.legScriptToExecute)
    if (!code && workflowState?.context) {
      code = this.getNestedValue(workflowState.context, sourceField);
      if (code) {
        console.log(`✅ Resolved code from getNestedValue(context): ${sourceField} (${typeof code === 'string' ? code.length + ' chars' : typeof code})`);
      }
    }
    
    // Final fallback: log available keys for debugging and fail if code still not found
    if (!code) {
      // Try final fallbacks
      if (workflowState.legScriptToExecute) {
        code = workflowState.legScriptToExecute;
        console.log(`✅ Using workflowState.legScriptToExecute as fallback: ${code.length} chars`);
      }
      if (!code && workflowState.context?.legScriptToExecute) {
        code = workflowState.context.legScriptToExecute;
        console.log(`✅ Using workflowState.context.legScriptToExecute as fallback: ${code.length} chars`);
      }
      
      // If still not found, fail with detailed error
      if (!code) {
        const errorMessage = `Missing required field "${sourceField}" for step "${step.name || step.id}"`;
        const missingPath = `workflowState.${sourceField}`;
        const workflowKeys = Object.keys(workflowState || {});
        const contextKeys = workflowState.context ? Object.keys(workflowState.context) : [];
        const varPoolPageKeys = workflowState.variablePool?.page ? Object.keys(workflowState.variablePool.page) : [];
        const fullContext = {
          step_id: step.id,
          step_name: step.name,
          step_type: step.type,
          step_config: step.config,
          missing_field: sourceField,
          missing_path: missingPath,
          available_keys_workflowState: workflowKeys,
          available_keys_context: contextKeys,
          available_keys_variablePool_page: varPoolPageKeys,
          workflowState_sample: Object.fromEntries(Object.entries(workflowState || {}).slice(0, 20)),
          context_sample: workflowState.context ? Object.fromEntries(Object.entries(workflowState.context).slice(0, 20)) : null
        };
        console.error(`❌ ${errorMessage}`);
        console.error(`❌ Missing JSON path: ${missingPath}`);
        console.error(`❌ Available keys in workflowState (${workflowKeys.length}): ${workflowKeys.slice(0, 30).join(', ')}${workflowKeys.length > 30 ? '...' : ''}`);
        console.error(`❌ Available keys in workflowState.context (${contextKeys.length}): ${contextKeys.slice(0, 30).join(', ')}${contextKeys.length > 30 ? '...' : ''}`);
        console.error(`❌ Available keys in workflowState.variablePool.page (${varPoolPageKeys.length}): ${varPoolPageKeys.join(', ')}`);
        console.error(`❌ Full step context:`, JSON.stringify(fullContext, null, 2));
        if (jobId && this.backendLogger) {
          await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', fullContext);
        }
        throw new Error(`${errorMessage}\nMissing JSON path: ${missingPath}\nAvailable keys in workflowState: ${workflowKeys.join(', ')}\nAvailable keys in context: ${contextKeys.join(', ')}\nAvailable keys in variablePool.page: ${varPoolPageKeys.join(', ')}\nFull context: ${JSON.stringify(fullContext, null, 2)}`);
      }
    }
    
    // CRITICAL: If path contains ".result.", try to extract from structured format
    // Structured results are stored as: workflowState[stepId].result = { field: { value: ..., namespace: ... } }
    if (!code && sourceField.includes('.result.')) {
      const pathParts = sourceField.split('.result.');
      const stepId = pathParts[0];
      const fieldPath = pathParts[1];
      
      console.log(`🔍 Trying to resolve structured path: ${stepId}.result.${fieldPath}`);
      
      // Try multiple locations for step result
      const stepResult = workflowState[stepId]?.result || 
                        workflowState.results?.[stepId]?.result ||
                        workflowState.variablePool?.steps?.[stepId]?.result ||
                        null;
      
        if (stepResult) {
          console.log(`🔍 Found step result, extracting field: ${fieldPath}`);
          console.log(`🔍 Step result structure:`, JSON.stringify(Object.keys(stepResult || {}).join(', ')));
          
          // Try to extract field from structured format
          // Structured format: { result: { value: { playwright_script: { value: "...", namespace: "step" } } } }
          // OR: { result: { playwright_script: { value: "...", namespace: "step" } } }
          // OR: { playwright_script: { value: "...", namespace: "step" } }
          
          let fieldValue = null;
          
          // Try direct path first
          fieldValue = this.getNestedValue(stepResult, fieldPath);
          
          // If not found and fieldPath contains dots, try each segment with structured value extraction
          if (!fieldValue && fieldPath.includes('.')) {
            const fieldParts = fieldPath.split('.');
            let current = stepResult;
            for (const part of fieldParts) {
              if (current && typeof current === 'object') {
                current = current[part];
                // If we hit a structured value with .value, extract it
                if (current && typeof current === 'object' && current.value !== undefined && !Array.isArray(current.value)) {
                  current = current.value;
                }
              } else {
                current = undefined;
                break;
              }
            }
            fieldValue = current;
          }
          
          // Also try if stepResult has a "result" wrapper
          if (!fieldValue && stepResult.result) {
            fieldValue = this.getNestedValue(stepResult.result, fieldPath);
            if (fieldValue && typeof fieldValue === 'object' && fieldValue.value !== undefined) {
              fieldValue = fieldValue.value;
            }
          }
          
          if (fieldValue) {
            // If it's still a structured value with .value, extract it
            if (fieldValue && typeof fieldValue === 'object' && fieldValue.value !== undefined && !Array.isArray(fieldValue.value)) {
              code = fieldValue.value;
            } else {
              code = fieldValue;
            }
            console.log(`✅ Resolved code from structured format: ${stepId}.result.${fieldPath}`);
          } else {
            console.warn(`⚠️ Field path "${fieldPath}" not found in step result. Available keys: ${Object.keys(stepResult || {}).join(', ')}`);
            if (stepResult.result) {
              console.warn(`⚠️ stepResult.result keys: ${Object.keys(stepResult.result || {}).join(', ')}`);
            }
          }
        }
      
      // Also try slug-based lookup
      if (!code) {
        const stepSlug = this.generateSlug(stepId);
        console.log(`🔍 Trying slug-based lookup: ${stepSlug}`);
        const slugResult = workflowState[stepSlug]?.result || 
                          workflowState.results?.[stepSlug]?.result ||
                          workflowState.variablePool?.steps?.[stepSlug]?.result ||
                          null;
        if (slugResult) {
          let fieldValue = this.getNestedValue(slugResult, fieldPath);
          if (fieldValue) {
            code = (fieldValue && typeof fieldValue === 'object' && fieldValue.value !== undefined) ? fieldValue.value : fieldValue;
            console.log(`✅ Resolved code from slug-based structured format: ${stepSlug}.result.${fieldPath}`);
          }
        }
      }
    }

    if (!code) {
      console.warn(`⚠️ Unable to resolve code for path "${sourceField}". Available keys:`, Object.keys(workflowState || {}));
      if (workflowState?.context) {
        console.warn(`⚠️ Context keys:`, Object.keys(workflowState.context));
      }
      if (workflowState?.results) {
        console.warn(`⚠️ Results keys:`, Object.keys(workflowState.results));
      }
      throw new Error(`Code not found at path "${sourceField}" in workflowState for step: ${step.name}`);
    }
    
    console.log(`📦 Resolved code from "${sourceField}": ${code ? 'found' : 'not found'}`);
    
    // Parse script to extract action lines BEFORE cleaning (to preserve original structure)
    const actionLines = this.parseScriptActions(code);
    console.log(`📋 Parsed ${actionLines.length} action lines from script`);
    
    // Log parsing result to job logs for debugging
    if (jobId && actionLines.length > 0) {
      try {
        await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
          jobId: jobId,
          level: 'debug',
          message: `📋 Parsed ${actionLines.length} action lines from script (will log during execution)`,
          component: 'WORKFLOW-ANALYZER',
          metadata: {
            step_id: step.id,
            step_name: step.name,
            action_lines_count: actionLines.length,
            script_length: code.length
          }
        }, {
          headers: this.getAuthHeaders()
        });
      } catch (logError) {
        console.error(`❌ Failed to log parsing result: ${logError.message}`);
      }
    } else if (jobId && actionLines.length === 0 && code && code.trim().length > 0) {
      // Only warn if script is non-empty but no actions found
      // This is just for logging/debugging - script will still execute
      try {
        // Check if script might be valid but just not matching our patterns
        const hasAsyncFunction = /async\s*\(\)\s*=>|async\s+function|\(async\s*\(\)/.test(code);
        const hasPageReference = /page\.|await\s+page|page\.locator|page\.getBy/.test(code);
        const hasReturn = /return\s+/.test(code);
        
        // If script has async/page references, it's likely valid - reduce warning severity
        const warningLevel = (hasAsyncFunction || hasPageReference || hasReturn) ? 'debug' : 'warn';
        const warningMessage = (hasAsyncFunction || hasPageReference || hasReturn)
          ? `ℹ️ No action lines parsed from script for logging (script length: ${code.length} chars) - script appears valid but may use patterns not recognized by parser`
          : `⚠️ No action lines parsed from script (script length: ${code.length} chars) - script may be empty or in unexpected format`;
        
        await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
          jobId: jobId,
          level: warningLevel,
          message: warningMessage,
          component: 'WORKFLOW-ANALYZER',
          metadata: {
            step_id: step.id,
            step_name: step.name,
            script_length: code.length,
            script_preview: code.substring(0, 300),
            has_async: hasAsyncFunction,
            has_page_ref: hasPageReference,
            has_return: hasReturn
          }
        }, {
          headers: this.getAuthHeaders()
        });
      } catch (logError) {
        console.error(`❌ Failed to log parsing warning: ${logError.message}`);
      }
    }
    
    // Clean the code to remove markdown code blocks and function declarations
    code = this.cleanScript(code);
    console.log(`🧾 Code preview (${step.name}): ${code.substring(0, 200)}${code.length > 200 ? '…' : ''}`);
    
    if (!code || code.trim().length === 0) {
      throw new Error(`Script is empty after cleaning for step: ${step.name}`);
    }
    
    try {
      const timeout = step.config?.timeout || 30000;
      
      // Capture URL before action
      const urlBeforeAction = page.url();
      workflowState.urlBeforeAction = urlBeforeAction;
      console.log(`📄 VAR_DUMP: executeCodeFromVariableStep - urlBeforeAction=${urlBeforeAction}`);
      console.log(`📄 VAR_DUMP: executeCodeFromVariableStep - expectedLoginUrl=${workflowState.expectedLoginUrl}`);
      console.log(`📄 VAR_DUMP: executeCodeFromVariableStep - code preview: ${code.substring(0, 300)}`);
      
      // CRITICAL: Check if we're navigating away from login page
      if (workflowState.expectedLoginUrl && urlBeforeAction !== workflowState.expectedLoginUrl) {
        console.warn(`⚠️ WARNING: Page is NOT on expected login URL! Current URL: ${urlBeforeAction}, Expected: ${workflowState.expectedLoginUrl}`);
      }
      
      // Take screenshot before action
      let screenshotBeforeKey = null;
      try {
        const screenshotBefore = await page.screenshot({ fullPage: true, type: 'png' });
        const presignedBefore = await axios.post(`${this.backendUrl}/api/upload/presigned-url`, {
          type: 'screenshot',
          jobId: jobId,
          contentType: 'image/png'
        }, {
          headers: this.getAuthHeaders()
        });
        
        if (presignedBefore.data.key && presignedBefore.data.url) {
          await axios.put(presignedBefore.data.url, screenshotBefore, {
            headers: { 'Content-Type': 'image/png' },
            maxBodyLength: Infinity,
            maxContentLength: Infinity
          });
          screenshotBeforeKey = presignedBefore.data.key;
          
          // Store screenshot link with action metadata
          const currentLeg = workflowState.currentLeg || {};
          await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'info',
            message: `📸 Screenshot before action: ${step.name} - ${currentLeg.description || 'Action execution'}`,
            component: 'WORKFLOW-STEP',
            metadata: {
              screenshot_type: 'before_action',
              action: step.name,
              leg_id: currentLeg.leg_id,
              leg_description: currentLeg.description,
              screenshot_key: screenshotBeforeKey,
              url: urlBeforeAction
            }
          }, {
            headers: this.getAuthHeaders()
          });
        }
      } catch (screenshotError) {
        console.warn(`⚠️ Failed to capture before screenshot: ${screenshotError.message}`);
      }
      
      // Upload script as downloadable file before execution
      let executedScriptUrl = null;
      if (jobId && code) {
        try {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const stepName = (step.name || step.id || 'script').replace(/[^a-z0-9]/gi, '-').toLowerCase();
          const fileName = `playwright-script-executed-${jobId}-${stepName}-${timestamp}.js`;
          executedScriptUrl = await this.uploadFileForDownload(jobId, code, fileName, 'text/javascript');
          
          if (executedScriptUrl) {
            console.log(`✅ Script uploaded before execution: 📥 ${executedScriptUrl}`);
          }
        } catch (uploadError) {
          console.warn(`⚠️ Failed to upload script before execution: ${uploadError.message}`);
        }
      }
      
      // Log execution start
      const executionStartMessage = executedScriptUrl
        ? `▶️ Executing Playwright script in Node.js context...\n📥 Download: ${executedScriptUrl}`
        : `▶️ Executing Playwright script in Node.js context...`;
      
      if (jobId) {
        try {
          await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'debug',
            message: executionStartMessage,
            component: 'WORKFLOW-ANALYZER',
            metadata: {
              step_id: step.id,
              step_name: step.name,
              url_before: urlBeforeAction,
              timeout_ms: timeout,
              script_length: code.length,
              script_preview: code.substring(0, 300),
              script_download_url: executedScriptUrl
            }
          }, {
            headers: this.getAuthHeaders()
          });
          
          // Log each action line with [executing] prefix
          console.log(`📋 Found ${actionLines.length} action lines to log`);
          if (actionLines.length > 0) {
            let loggedCount = 0;
            let failedCount = 0;
            for (const actionLine of actionLines) {
              console.log(`📝 Logging action: [executing] ${actionLine.substring(0, 100)}`);
              try {
                const response = await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
                  jobId: jobId,
                  level: 'info',
                  message: `[executing] ${actionLine}`,
                  component: 'WORKFLOW-ANALYZER',
                  metadata: {
                    step_id: step.id,
                    step_name: step.name,
                    action_type: 'script_action',
                    action_line: actionLine
                  }
                }, {
                  headers: this.getAuthHeaders(),
                  timeout: 5000 // 5 second timeout
                });
                if (response.status === 200 || response.status === 201) {
                  loggedCount++;
                } else {
                  failedCount++;
                  console.error(`❌ Failed to log action line: HTTP ${response.status}`);
                }
              } catch (logError) {
                failedCount++;
                console.error(`❌ Failed to log action line: ${logError.message}`, logError.response?.data || '');
              }
            }
            console.log(`✅ Logged ${loggedCount}/${actionLines.length} action lines (${failedCount} failed)`);
            
            // Log summary if some failed
            if (failedCount > 0 && jobId) {
              try {
                await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
                  jobId: jobId,
                  level: 'warn',
                  message: `⚠️ Failed to log ${failedCount} out of ${actionLines.length} action lines`,
                  component: 'WORKFLOW-ANALYZER',
                  metadata: {
                    step_id: step.id,
                    step_name: step.name,
                    logged_count: loggedCount,
                    failed_count: failedCount,
                    total_count: actionLines.length
                  }
                }, {
                  headers: this.getAuthHeaders()
                });
              } catch (summaryError) {
                console.error(`❌ Failed to log summary: ${summaryError.message}`);
              }
            }
          } else {
            console.warn(`⚠️ No action lines found in script (script length: ${code.length})`);
          }
        } catch (e) {
          console.error(`❌ Failed to log execution start: ${e.message}`, e);
        }
      }
      
      // Playwright scripts must execute in Node.js context, not browser context
      // The 'page' object is available in Node.js, not in browser
      // Create an async function that has access to the page object and credentials
      const scriptUsesCredentials = code.includes('input_credentials') || 
                                   code.includes('input_credentials.username') ||
                                   code.includes('input_credentials.password');
      
      // DEFAULT: Allow navigation (crawl jobs can navigate to test everything)
      // Only restrict navigation if this is explicitly configured as a login job
      // Login jobs are configured via workflow configuration step, not by default
      const isLoginJob = this.context?.jobType === 'login' || 
                        this.context?.job_type === 'login' || 
                        this.context?.isLoginJob === true ||
                        workflowState?.variablePool?.job?.isLoginJob === true ||
                        workflowState?.variablePool?.job?.jobType === 'login' ||
                        workflowState?.variablePool?.job?.preventNavigation === true;

      const inputCredentials = workflowState.inputCredentials || this.context?.credentials || null;
      
      // CRITICAL: Log credentials being passed to script execution
      console.log(`📄 VAR_DUMP: executeCodeFromVariableStep - inputCredentials check`);
      console.log(`📄 VAR_DUMP: inputCredentials=${inputCredentials ? 'EXISTS' : 'NULL'}`);
      console.log(`📄 VAR_DUMP: scriptUsesCredentials=${scriptUsesCredentials}`);
      if (inputCredentials) {
        console.log(`📄 VAR_DUMP: inputCredentials.username=${inputCredentials.username || 'MISSING'}`);
        console.log(`📄 VAR_DUMP: inputCredentials.password=${inputCredentials.password ? '***' : 'MISSING'}`);
        console.log(`🔑 Passing credentials to script: username=${inputCredentials.username || 'MISSING'}, password=${inputCredentials.password ? '***' : 'MISSING'}`);
        if (!inputCredentials.username || !inputCredentials.password) {
          console.warn(`⚠️ WARNING: Credentials incomplete! username=${!!inputCredentials.username}, password=${!!inputCredentials.password}`);
        }
      } else if (isLoginJob || scriptUsesCredentials) {
        console.error(`❌ ERROR: No credentials available for script execution!`);
        console.error(`workflowState.inputCredentials:`, workflowState.inputCredentials);
        console.error(`this.context.credentials:`, this.context?.credentials);
      } else {
        console.log(`ℹ️ No credentials provided for this script (non-login crawl step).`);
      }
      
      if (isLoginJob && !scriptUsesCredentials) {
        console.error(`❌ ERROR: Generated login script does NOT use input_credentials!`);
        console.error(`Script preview: ${code.substring(0, 500)}`);
      }
      
      if (isLoginJob) {
        // Check for forbidden navigation patterns
        const hasPageGoto = code.includes('page.goto(') || code.includes('page.goto(');
        const hasNavigationLinks = code.includes('click(') && (
          code.includes('/courses') || 
          code.includes('/home') || 
          code.includes('/about') ||
          code.includes('href') ||
          code.includes('navigation') ||
          code.includes('menu')
        );
        
        if (hasPageGoto) {
          console.error(`❌ ERROR: Login job script contains page.goto() - this is FORBIDDEN!`);
          console.error(`Script preview: ${code.substring(0, 500)}`);
          
          if (jobId) {
            await this.sendLogToBackend(jobId, 'error', 
              `❌ Login job script contains forbidden page.goto() - login jobs must NOT navigate to other pages`, 
              'WORKFLOW-ANALYZER', {
                step_id: step.id,
                script_preview: code.substring(0, 500)
              }
            );
          }
          
          throw new Error('Login job script contains forbidden page.goto() - login jobs must only interact with login forms, not navigate to other pages');
        }
        
        if (hasNavigationLinks) {
          console.warn(`⚠️ WARNING: Login job script may be clicking navigation links - this is discouraged`);
          console.warn(`Script preview: ${code.substring(0, 500)}`);
        }
      }
      
      // Wrap page object to intercept ALL Playwright method calls and log execution
      const createPageWrapperWithScreenshot = (pageObj, jobId, backendUrl, getAuthHeaders, stepInfo = null, recordAction = null) => {
        console.log(`🔧 Creating page wrapper for jobId: ${jobId}`);
        const wrapper = {};
        
        // Helper function to log action execution
        const logAction = async (methodName, args = []) => {
          if (!jobId) {
            console.log(`⚠️ logAction called but no jobId: ${methodName}`);
            return;
          }
          
          try {
            // Format the action for display
            let actionDisplay = methodName;
            if (args.length > 0) {
              // Format first argument (usually selector or value)
              const firstArg = args[0];
              if (typeof firstArg === 'string') {
                // Truncate long selectors/values
                const truncated = firstArg.length > 50 ? firstArg.substring(0, 47) + '...' : firstArg;
                actionDisplay = `${methodName}(${truncated})`;
              } else if (typeof firstArg === 'object' && firstArg !== null) {
                actionDisplay = `${methodName}({...})`;
              } else {
                actionDisplay = `${methodName}(${String(firstArg).substring(0, 30)})`;
              }
            } else {
              actionDisplay = `${methodName}()`;
            }
            
            const actionLine = `await page.${actionDisplay}`;
            console.log(`📝 Logging action: [executing] ${actionLine}`);
            if (recordAction) {
              recordAction(actionLine);
            }
            
            const metadata = {
              action_type: 'playwright_method',
              method_name: methodName,
              action_display: actionDisplay
            };
            
            // Add step info if available
            if (stepInfo) {
              if (stepInfo.id) metadata.step_id = stepInfo.id;
              if (stepInfo.name) metadata.step_name = stepInfo.name;
            }
            
            try {
              const response = await axios.post(`${backendUrl}/api/logs/jobs/append`, {
                jobId: jobId,
                level: 'info',
                message: `[executing] await page.${actionDisplay}`,
                component: 'WORKFLOW-ANALYZER',
                metadata: metadata
              }, {
                headers: getAuthHeaders(),
                timeout: 5000 // 5 second timeout
              });
              
              console.log(`✅ Successfully logged action: ${actionDisplay} (status: ${response.status})`);
            } catch (axiosError) {
              // Log the error but don't fail execution
              console.error(`❌ Failed to log action via axios: ${axiosError.message}`);
              if (axiosError.response) {
                console.error(`Response status: ${axiosError.response.status}`);
                console.error(`Response data:`, axiosError.response.data);
              }
              // Try to log via console as fallback
              console.log(`[executing] await page.${actionDisplay}`);
            }
          } catch (logError) {
            // Don't fail execution if logging fails
            console.error(`❌ Failed to log action: ${logError.message}`, logError);
          }
        };
        
        // Wrap common Playwright methods to log execution
        const wrapMethod = (methodName, originalMethod) => {
          return async function(...args) {
            console.log(`🔍 Wrapper called for method: ${methodName}`);
            await logAction(methodName, args);
            return await originalMethod.apply(pageObj, args);
          };
        };
        
        // Wrap common page methods
        wrapper.click = wrapMethod('click', pageObj.click.bind(pageObj));
        wrapper.fill = wrapMethod('fill', pageObj.fill.bind(pageObj));
        wrapper.type = wrapMethod('type', pageObj.type.bind(pageObj));
        wrapper.press = wrapMethod('press', pageObj.press.bind(pageObj));
        wrapper.goto = wrapMethod('goto', pageObj.goto.bind(pageObj));
        wrapper.waitForTimeout = wrapMethod('waitForTimeout', pageObj.waitForTimeout.bind(pageObj));
        if (pageObj.waitFor) {
          wrapper.waitFor = wrapMethod('waitFor', pageObj.waitFor.bind(pageObj));
        }
        wrapper.waitForLoadState = wrapMethod('waitForLoadState', pageObj.waitForLoadState.bind(pageObj));
        wrapper.waitForSelector = wrapMethod('waitForSelector', pageObj.waitForSelector.bind(pageObj));
        wrapper.selectOption = wrapMethod('selectOption', pageObj.selectOption.bind(pageObj));
        wrapper.check = wrapMethod('check', pageObj.check.bind(pageObj));
        wrapper.uncheck = wrapMethod('uncheck', pageObj.uncheck.bind(pageObj));
        wrapper.hover = wrapMethod('hover', pageObj.hover.bind(pageObj));
        wrapper.focus = wrapMethod('focus', pageObj.focus.bind(pageObj));
        if (pageObj.blur) {
          wrapper.blur = wrapMethod('blur', pageObj.blur.bind(pageObj));
        }
        
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
            
            // Log and upload screenshot if jobId and backendUrl are available
            if (jobId && backendUrl) {
              try {
                const authHeaders = getAuthHeaders();
                
                const presignedResponse = await axios.post(`${backendUrl}/api/upload/presigned-url`, {
                  type: 'screenshot',
                  jobId: jobId,
                  contentType: 'image/png'
                }, {
                  headers: authHeaders
                });
                
                if (presignedResponse.data.key && presignedResponse.data.url) {
                  // Upload screenshot
                  await axios.put(presignedResponse.data.url, screenshotBuffer, {
                    headers: { 'Content-Type': 'image/png' },
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity
                  });
                  
                  const screenshotKey = presignedResponse.data.key;
                  
                  // Log screenshot with screenshot_type metadata (like screenshot-type elements)
                  await axios.post(`${backendUrl}/api/logs/jobs/append`, {
                    jobId: jobId,
                    level: 'info',
                    message: `📸 Screenshot captured`,
                    component: 'WORKFLOW-ANALYZER',
                    metadata: {
                      screenshot_type: 'script_execution',
                      screenshot_key: screenshotKey,
                      screenshot_file_id: screenshotKey,
                      is_screenshot: true,
                      action_type: 'screenshot',
                      screenshot_options: options,
                      step_id: step.id,
                      step_name: step.name
                    }
                  }, {
                    headers: authHeaders
                  });
                }
              } catch (screenshotLogError) {
                // Don't fail script execution if screenshot logging fails
                console.warn(`Failed to log screenshot: ${screenshotLogError.message}`);
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
                console.log(`🔍 Proxy intercepted method: ${String(prop)}`);
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
      
      const executeInNodeContext = async (pageObj, scriptCode, credentials) => {
        console.log(`📄 VAR_DUMP: executeInNodeContext called`);
        console.log(`📄 VAR_DUMP: credentials passed=${credentials ? JSON.stringify({username: credentials.username || 'MISSING', password: credentials.password ? '***' : 'MISSING'}) : 'NULL'}`);
        console.log(`📄 VAR_DUMP: jobId=${jobId}, backendUrl=${this.backendUrl}`);
        
        // Wrap page object to intercept ALL method calls
        const executedActionLines = [];
        const recordAction = (actionLine) => {
          executedActionLines.push(actionLine);
        };
        let wrappedPage;
        try {
          console.log(`🔧 About to create page wrapper...`);
          // Pass step info for logging context
          const stepInfo = step ? { id: step.id, name: step.name } : null;
          wrappedPage = createPageWrapperWithScreenshot(pageObj, jobId, this.backendUrl, () => this.getAuthHeaders(), stepInfo, recordAction);
          console.log(`✅ Page wrapper created successfully`);
        } catch (wrapperError) {
          console.error(`❌ Failed to create page wrapper: ${wrapperError.message}`, wrapperError);
          // Fall back to original page object if wrapper creation fails
          wrappedPage = pageObj;
        }
        
        // Verify wrapper is working - test that wrappedPage.click exists and is our wrapper
        console.log(`🔍 Testing wrapper: wrappedPage.click is function? ${typeof wrappedPage.click === 'function'}`);
        console.log(`🔍 Testing wrapper: wrappedPage.locator is function? ${typeof wrappedPage.locator === 'function'}`);
        console.log(`🔍 Testing wrapper: wrappedPage type=${typeof wrappedPage}, isProxy=${wrappedPage !== pageObj}`);
        
        // Use string concatenation (not template literals) to avoid escaping issues
        // This allows the script code to contain backticks, ${}, etc. without problems
        const functionBody = 'return (async function() {\n' + scriptCode + '\n})();';
        
        // Create a function with page, wrapper (alias for page), and input_credentials as parameters
        // Some AI-generated scripts use 'wrapper' instead of 'page' - both refer to the same wrapped page
        console.log(`🔧 Creating function with wrappedPage, script length=${scriptCode.length}`);
        const fn = new Function('page', 'wrapper', 'input_credentials', functionBody);
        console.log(`🚀 Executing script with wrapped page object...`);
        const result = await fn(wrappedPage, wrappedPage, credentials);
        console.log(`✅ Script execution completed, result.success=${result?.success}`);
        console.log(`📄 VAR_DUMP: executeInNodeContext result:`, JSON.stringify(result).substring(0, 200));
        workflowState.lastExecutedActionLines = executedActionLines;
        return result;
      };
      
      // Capture dialog messages triggered during script execution
      let dialogMessage = null;
      const dialogHandler = async (dialog) => {
        dialogMessage = dialog.message();
        try {
          await dialog.accept();
        } catch (dialogError) {
          console.warn(`⚠️ Failed to accept dialog: ${dialogError.message}`);
        }
      };
      page.on('dialog', dialogHandler);

      // Wrap script execution with timeout
      const executionStartTime = Date.now();
      const result = await Promise.race([
        executeInNodeContext(page, code, inputCredentials),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Code execution timed out after ${timeout}ms`)), timeout)
        )
      ]);
      
      page.off('dialog', dialogHandler);
      workflowState.lastDialogMessage = dialogMessage;
      
      const executionTime = Date.now() - executionStartTime;
      
      // CRITICAL: Check URL after execution to detect navigation
      const urlAfterAction = page.url();
      console.log(`📄 VAR_DUMP: executeCodeFromVariableStep - urlAfterAction=${urlAfterAction}`);
      console.log(`📄 VAR_DUMP: executeCodeFromVariableStep - urlChanged=${urlBeforeAction !== urlAfterAction}`);
      if (urlBeforeAction !== urlAfterAction) {
        console.log(`📄 VAR_DUMP: URL changed from ${urlBeforeAction} to ${urlAfterAction}`);
        // Note: We rely on AI to determine if navigation is appropriate based on page analysis
        // No hardcoded URL pattern checks - AI should analyze page state dynamically
      }
      workflowState.urlAfterAction = urlAfterAction;
      
      // Log successful execution
      const successMessage = executedScriptUrl
        ? `✅ Playwright script executed successfully (${executionTime}ms)\n📥 Script: ${executedScriptUrl}`
        : `✅ Playwright script executed successfully (${executionTime}ms)`;
      
      if (jobId) {
        try {
          await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'info',
            message: successMessage,
            component: 'WORKFLOW-ANALYZER',
            metadata: {
              step_id: step.id,
              step_name: step.name,
              execution_time_ms: executionTime,
              url_before: urlBeforeAction,
              url_after: page.url(),
              result_preview: typeof result === 'object' ? JSON.stringify(result).substring(0, 500) : String(result).substring(0, 500),
              script_download_url: executedScriptUrl
            }
          }, {
            headers: this.getAuthHeaders()
          });
        } catch (e) {
          // Silent fail - don't block execution
        }
      }
      
      // After executing code, wait for page to stabilize (navigation, DOM updates, etc.)
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {
          console.warn('Page DOM not fully loaded after 30s, continuing anyway');
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (waitError) {
        console.log(`⚠️ Page wait warning: ${waitError.message}`);
      }
      
      // Capture URL after action (already captured above, just update state)
      const pageChanged = urlBeforeAction !== urlAfterAction;
      
      // Update workflow state with current page URL in case navigation occurred
      if (pageChanged) {
        console.log(`🔄 Page navigation detected: ${urlBeforeAction} → ${urlAfterAction}`);
        workflowState.pageUrl = urlAfterAction;
        workflowState.pageTitle = await page.title().catch(() => '');
      }
      
      // Take screenshot after action
      let screenshotAfterKey = null;
      try {
        const screenshotAfter = await page.screenshot({ fullPage: true, type: 'png' });
        const presignedAfter = await axios.post(`${this.backendUrl}/api/upload/presigned-url`, {
          type: 'screenshot',
          jobId: jobId,
          contentType: 'image/png'
        }, {
          headers: this.getAuthHeaders()
        });
        
        if (presignedAfter.data.key && presignedAfter.data.url) {
          await axios.put(presignedAfter.data.url, screenshotAfter, {
            headers: { 'Content-Type': 'image/png' },
            maxBodyLength: Infinity,
            maxContentLength: Infinity
          });
          screenshotAfterKey = presignedAfter.data.key;
          
          // Store screenshot link with action metadata
          const currentLeg = workflowState.currentLeg || {};
          await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'info',
            message: `📸 Screenshot after action: ${step.name} - ${currentLeg.description || 'Action execution'} ${pageChanged ? '(page changed)' : '(same page)'}`,
            component: 'WORKFLOW-STEP',
            metadata: {
              screenshot_type: 'after_action',
              action: step.name,
              leg_id: currentLeg.leg_id,
              leg_description: currentLeg.description,
              screenshot_key: screenshotAfterKey,
              url: urlAfterAction,
              url_before: urlBeforeAction,
              url_after: urlAfterAction,
              page_changed: pageChanged
            }
          }, {
            headers: this.getAuthHeaders()
          });
        }
      } catch (screenshotError) {
        console.warn(`⚠️ Failed to capture after screenshot: ${screenshotError.message}`);
      }
      
      const executionResult = {
        ...result,
        success: true, // Explicit so final-status logic can override justify 'failure' when script ran OK
        urlBeforeAction,
        urlAfterAction,
        pageChanged,
        screenshotBeforeKey,
        screenshotAfterKey
      };
      
      try {
        const execPreview = JSON.stringify(executionResult);
        console.log(`🎯 Execution result preview: ${execPreview.substring(0, 300)}${execPreview.length > 300 ? '…' : ''}`);
      } catch (e) {
        console.log('🎯 Execution result (non-serializable)', executionResult);
      }

      workflowState.lastExecutionResult = executionResult;
      this.storeStepResult(step, executionResult, workflowState);
      
      console.log(`✅ Code execution completed. Page changed: ${pageChanged}`);
      
      return executionResult;
    } catch (error) {
      console.error(`❌ Code execution failed: ${error.message}`);
      const urlAfterAction = page.url();
      const errorResult = {
        success: false,
        error: error.message,
        urlBeforeAction: workflowState.urlBeforeAction || page.url(),
        urlAfterAction,
        pageChanged: (workflowState.urlBeforeAction || '') !== urlAfterAction
      };
      workflowState.lastExecutionResult = errorResult;
      this.storeStepResult(step, errorResult, workflowState);
      
      // If next step is self-adjustable-ai-workflow, don't throw - let workflow continue
      if (nextStep && nextStep.type === 'self-adjustable-ai-workflow') {
        console.log(`🔄 Script execution failed, but next step is self-adjustable-ai-workflow - will retry`);
        // Store failure info for retry
        workflowState.lastScriptFailure = {
          step: step,
          error: error.message,
          script: workflowState[step.config?.sourceField] || null,
          timestamp: new Date(),
          executionResult: errorResult
        };
        return errorResult; // Return error result instead of throwing
      }
      
      throw error;
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
   * Upload file for download (returns public URL)
   * @param {string} jobId - Job ID
   * @param {string|Buffer} content - File content (string or buffer)
   * @param {string} fileName - File name
   * @param {string} contentType - MIME type
   * @returns {Promise<string|null>} Public URL or null if upload fails
   */
  async uploadFileForDownload(jobId, content, fileName, contentType) {
    try {
      const jobIdStr = jobId != null ? String(jobId) : '';
      if (!jobIdStr) {
        console.error('❌ uploadFileForDownload: jobId is required');
        return null;
      }
      // Convert content to buffer if it's a string
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');

      // Request presigned URL from backend
      const presignedResponse = await axios.post(`${this.backendUrl}/api/upload/presigned-url`, {
        type: 'file',
        jobId: jobIdStr,
        contentType: contentType || 'application/octet-stream',
        fileName: fileName
      }, {
        timeout: 10000,
        headers: this.getAuthHeaders()
      });

      const { url: presignedUrl, key, publicUrl: returnedUrl } = presignedResponse.data;

      // Upload file to presigned URL
      await axios.put(presignedUrl, buffer, {
        headers: { 'Content-Type': contentType },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 30000
      });

      console.log(`✅ File uploaded for download: ${returnedUrl}`);
      return returnedUrl || null;
    } catch (error) {
      console.error(`❌ Failed to upload file for download: ${error.message}`);
      return null;
    }
  }

  /**
   * Execute cookie add step
   */
  async executeCookieAddStep(step, workflowState, jobId) {
    console.log(`🍪 Adding cookie (${step.name})`);
    
    const config = step.config || {};
    if (!config.name || !config.value) {
      const missingFields = [];
      if (!config.name) missingFields.push('name');
      if (!config.value) missingFields.push('value');
      const errorMessage = `Missing required field(s) "${missingFields.join('", "')}" in cookie-add step "${step.name || step.id}"`;
      const missingPath = `step.config.${missingFields[0]}`;
      console.error(`❌ ${errorMessage}`);
      console.error(`❌ Missing JSON path: ${missingPath}`);
      console.error(`❌ Full step:`, JSON.stringify(step, null, 2));
      console.error(`❌ Step config:`, JSON.stringify(step.config, null, 2));
      
      const fullContext = {
        step_id: step.id,
        step_name: step.name || step.type,
        step_type: step.type,
        step_config: step.config,
        missing_fields: missingFields,
        full_step: step
      };
      
      if (jobId && this.backendLogger) {
        try {
          await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', {
            ...fullContext,
            missing_path: missingPath
          });
        } catch (e) {
          console.error(`❌ Failed to log error to backend:`, e.message);
        }
      }
      
      throw new Error(`${errorMessage}\nMissing JSON path: ${missingPath}\nFull step: ${JSON.stringify(step, null, 2)}`);
    }

    try {
      // Get project ID from job
      const jobResponse = await axios.get(`${this.backendUrl}/api/jobs/${jobId}`, {
        headers: this.getAuthHeaders()
      });
      // Handle both ObjectId and string formats
      let projectId = null;
      const rawProjectId = jobResponse.data?.project_id;
      if (rawProjectId) {
        projectId = typeof rawProjectId === 'object' && rawProjectId.toString ? rawProjectId.toString() : String(rawProjectId);
      }
      
      // Also try to get from context if API call didn't return it
      if (!projectId && this.context?.project_id) {
        const ctxProjectId = this.context.project_id;
        projectId = typeof ctxProjectId === 'object' && ctxProjectId.toString ? ctxProjectId.toString() : String(ctxProjectId);
        console.log(`ℹ️ Using project_id from context: ${projectId}`);
      }
      
      if (!projectId) {
        throw new Error(`Could not find project ID for job: ${jobId}`);
      }

      // Get current cookies
      const currentCookiesResponse = await axios.get(`${this.backendUrl}/api/projects/${projectId}/cookies`, {
        headers: this.getAuthHeaders()
      });
      const currentCookies = currentCookiesResponse.data || [];

      // Create new cookie
      const newCookie = {
        name: config.name,
        value: config.value,
        domain: config.domain || undefined,
        path: config.path || '/',
        expires: config.expires || undefined,
        secure: config.secure || false,
        httpOnly: config.httpOnly || false,
        sameSite: config.sameSite || undefined
      };

      // Add to existing cookies
      const updatedCookies = [...currentCookies, newCookie];

      // Update project cookies
      await axios.post(`${this.backendUrl}/api/projects/${projectId}/cookies`, {
        cookies: updatedCookies,
        source: 'workflow'
      }, {
        headers: this.getAuthHeaders()
      });

      this.storeStepResult(step, { cookie: newCookie, added: true }, workflowState);
      console.log(`✅ Cookie "${config.name}" added successfully`);
    } catch (error) {
      console.error(`❌ Cookie add failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute cookie update step
   */
  async executeCookieUpdateStep(step, workflowState, jobId) {
    console.log(`✏️ Updating cookie (${step.name})`);
    
    const config = step.config || {};
    if (!config.cookieName || !config.value) {
      const missingFields = [];
      if (!config.cookieName) missingFields.push('cookieName');
      if (!config.value) missingFields.push('value');
      const errorMessage = `Missing required field(s) "${missingFields.join('", "')}" in cookie-update step "${step.name || step.id}"`;
      const missingPath = `step.config.${missingFields[0]}`;
      console.error(`❌ ${errorMessage}`);
      console.error(`❌ Missing JSON path: ${missingPath}`);
      console.error(`❌ Full step:`, JSON.stringify(step, null, 2));
      console.error(`❌ Step config:`, JSON.stringify(step.config, null, 2));
      
      const fullContext = {
        step_id: step.id,
        step_name: step.name || step.type,
        step_type: step.type,
        step_config: step.config,
        missing_fields: missingFields,
        full_step: step
      };
      
      if (jobId && this.backendLogger) {
        try {
          await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', {
            ...fullContext,
            missing_path: missingPath
          });
        } catch (e) {
          console.error(`❌ Failed to log error to backend:`, e.message);
        }
      }
      
      throw new Error(`${errorMessage}\nMissing JSON path: ${missingPath}\nFull step: ${JSON.stringify(step, null, 2)}`);
    }

    try {
      // Get project ID from job
      const jobResponse = await axios.get(`${this.backendUrl}/api/jobs/${jobId}`, {
        headers: this.getAuthHeaders()
      });
      // Handle both ObjectId and string formats
      let projectId = null;
      const rawProjectId = jobResponse.data?.project_id;
      if (rawProjectId) {
        projectId = typeof rawProjectId === 'object' && rawProjectId.toString ? rawProjectId.toString() : String(rawProjectId);
      }
      
      // Also try to get from context if API call didn't return it
      if (!projectId && this.context?.project_id) {
        const ctxProjectId = this.context.project_id;
        projectId = typeof ctxProjectId === 'object' && ctxProjectId.toString ? ctxProjectId.toString() : String(ctxProjectId);
        console.log(`ℹ️ Using project_id from context: ${projectId}`);
      }
      
      if (!projectId) {
        throw new Error(`Could not find project ID for job: ${jobId}`);
      }

      // Get current cookies
      const currentCookiesResponse = await axios.get(`${this.backendUrl}/api/projects/${projectId}/cookies`, {
        headers: this.getAuthHeaders()
      });
      const currentCookies = currentCookiesResponse.data || [];

      // Update cookie
      const updatedCookies = currentCookies.map(cookie => {
        if (cookie.name === config.cookieName) {
          return {
            ...cookie,
            value: config.value,
            domain: config.domain !== undefined ? config.domain : cookie.domain,
            path: config.path !== undefined ? config.path : cookie.path,
            expires: config.expires !== undefined ? config.expires : cookie.expires,
            secure: config.secure !== undefined ? config.secure : cookie.secure,
            httpOnly: config.httpOnly !== undefined ? config.httpOnly : cookie.httpOnly,
            sameSite: config.sameSite !== undefined ? config.sameSite : cookie.sameSite
          };
        }
        return cookie;
      });

      // Check if cookie was found
      const cookieExists = currentCookies.some(c => c.name === config.cookieName);
      if (!cookieExists) {
        throw new Error(`Cookie "${config.cookieName}" not found`);
      }

      // Update project cookies
      await axios.post(`${this.backendUrl}/api/projects/${projectId}/cookies`, {
        cookies: updatedCookies,
        source: 'workflow'
      }, {
        headers: this.getAuthHeaders()
      });

      this.storeStepResult(step, { cookieName: config.cookieName, updated: true }, workflowState);
      console.log(`✅ Cookie "${config.cookieName}" updated successfully`);
    } catch (error) {
      console.error(`❌ Cookie update failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute cookie remove step
   */
  async executeCookieRemoveStep(step, workflowState, jobId) {
    console.log(`🗑️ Removing cookie (${step.name})`);
    
    const config = step.config || {};
    const removeAll = config.removeAll || false;
    const cookieName = config.cookieName;

    if (!removeAll && !cookieName) {
      const errorMessage = `Missing required field "cookieName" in cookie-remove step "${step.name || step.id}" (removeAll is false)`;
      const missingPath = 'step.config.cookieName';
      console.error(`❌ ${errorMessage}`);
      console.error(`❌ Missing JSON path: ${missingPath}`);
      console.error(`❌ Full step:`, JSON.stringify(step, null, 2));
      console.error(`❌ Step config:`, JSON.stringify(step.config, null, 2));
      
      const fullContext = {
        step_id: step.id,
        step_name: step.name || step.type,
        step_type: step.type,
        step_config: step.config,
        removeAll: removeAll,
        full_step: step
      };
      
      if (jobId && this.backendLogger) {
        try {
          await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', {
            ...fullContext,
            missing_path: missingPath
          });
        } catch (e) {
          console.error(`❌ Failed to log error to backend:`, e.message);
        }
      }
      
      throw new Error(`${errorMessage}\nMissing JSON path: ${missingPath}\nFull step: ${JSON.stringify(step, null, 2)}`);
    }

    try {
      // Get project ID from job
      const jobResponse = await axios.get(`${this.backendUrl}/api/jobs/${jobId}`, {
        headers: this.getAuthHeaders()
      });
      // Handle both ObjectId and string formats
      let projectId = null;
      const rawProjectId = jobResponse.data?.project_id;
      if (rawProjectId) {
        projectId = typeof rawProjectId === 'object' && rawProjectId.toString ? rawProjectId.toString() : String(rawProjectId);
      }
      
      // Also try to get from context if API call didn't return it
      if (!projectId && this.context?.project_id) {
        const ctxProjectId = this.context.project_id;
        projectId = typeof ctxProjectId === 'object' && ctxProjectId.toString ? ctxProjectId.toString() : String(ctxProjectId);
        console.log(`ℹ️ Using project_id from context: ${projectId}`);
      }
      
      if (!projectId) {
        throw new Error(`Could not find project ID for job: ${jobId}`);
      }

      if (removeAll) {
        // Clear all cookies
        await axios.delete(`${this.backendUrl}/api/projects/${projectId}/cookies`, {
          headers: this.getAuthHeaders()
        });
        this.storeStepResult(step, { removedAll: true }, workflowState);
        console.log(`✅ All cookies removed successfully`);
      } else {
        // Remove specific cookie
        const currentCookiesResponse = await axios.get(`${this.backendUrl}/api/projects/${projectId}/cookies`, {
          headers: this.getAuthHeaders()
        });
        const currentCookies = currentCookiesResponse.data || [];

        const updatedCookies = currentCookies.filter(cookie => cookie.name !== cookieName);

        if (updatedCookies.length === currentCookies.length) {
          throw new Error(`Cookie "${cookieName}" not found`);
        }

        await axios.post(`${this.backendUrl}/api/projects/${projectId}/cookies`, {
          cookies: updatedCookies,
          source: 'workflow'
        }, {
          headers: this.getAuthHeaders()
        });

        this.storeStepResult(step, { cookieName, removed: true }, workflowState);
        console.log(`✅ Cookie "${cookieName}" removed successfully`);
      }
    } catch (error) {
      console.error(`❌ Cookie remove failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute cookie collect step
   */
  async executeCookieCollectStep(page, step, workflowState, jobId) {
    console.log(`🔍 Collecting cookies from browser (${step.name})`);
    
    const config = step.config || {};
    let collectedCookies = []; // Declare early so it's available in catch block

    try {
      // Always collect from browser - this is self-explanatory
      if (!page) {
        throw new Error('Playwright page is not available - cannot collect cookies from browser');
      }
      
      // Collect all cookies from the browser context
      const contextCookies = await page.context().cookies();
      collectedCookies = contextCookies;
      console.log(`✅ Collected ${collectedCookies.length} cookie(s) from browser`);
      
      // Try to get project_id to save cookies to project (optional)
      let projectId = null;
      if (config.saveToProject !== false) {
        try {
          const jobResponse = await axios.get(`${this.backendUrl}/api/jobs/${jobId}`, {
            headers: this.getAuthHeaders()
          });
          // Handle both ObjectId and string formats
          const rawProjectId = jobResponse.data?.project_id;
          if (rawProjectId) {
            projectId = typeof rawProjectId === 'object' && rawProjectId.toString ? rawProjectId.toString() : String(rawProjectId);
          }
          
          // Also try to get from context if API call didn't return it
          if (!projectId && this.context?.project_id) {
            const ctxProjectId = this.context.project_id;
            projectId = typeof ctxProjectId === 'object' && ctxProjectId.toString ? ctxProjectId.toString() : String(ctxProjectId);
            console.log(`ℹ️ Using project_id from context: ${projectId}`);
          }
        } catch (jobError) {
          console.warn(`⚠️ Could not fetch job to get project_id: ${jobError.message}`);
          
          // Try to get from context as fallback
          if (this.context?.project_id) {
            const ctxProjectId = this.context.project_id;
            projectId = typeof ctxProjectId === 'object' && ctxProjectId.toString ? ctxProjectId.toString() : String(ctxProjectId);
            console.log(`ℹ️ Using project_id from context as fallback: ${projectId}`);
          }
          // Don't throw - we already have cookies
        }
      }

      // Store collected cookies in workflow state
      if (config.outputVariable) {
        workflowState[config.outputVariable] = collectedCookies;
      }
      workflowState.collectedCookies = collectedCookies;

      // Optionally save to project (only if projectId is available)
      if (config.saveToProject !== false && projectId) {
        try {
          await axios.post(`${this.backendUrl}/api/projects/${projectId}/cookies`, {
            cookies: collectedCookies,
            source: 'workflow'
          }, {
            headers: this.getAuthHeaders()
          });
          console.log(`✅ Saved ${collectedCookies.length} cookie(s) to project`);
        } catch (saveError) {
          console.warn(`⚠️ Failed to save cookies to project: ${saveError.message}`);
          // Don't throw - cookies are still collected
        }
      }

      this.storeStepResult(step, { cookies: collectedCookies, count: collectedCookies.length }, workflowState);
      console.log(`✅ Collected ${collectedCookies.length} cookie(s) successfully`);
    } catch (error) {
      // If we have cookies collected, don't fail the step
      if (collectedCookies && collectedCookies.length > 0) {
        console.warn(`⚠️ Cookie collect had errors but cookies were collected: ${error.message}`);
        this.storeStepResult(step, { cookies: collectedCookies }, workflowState);
        console.log(`✅ Cookie collection completed despite errors: ${collectedCookies.length} cookie(s)`);
        return; // Success - cookies collected
      }
      console.error(`❌ Cookie collect failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute validate response step
   */
  async executeValidateResponseStep(step, workflowState) {
    console.log(`✅ Validating response (${step.name})`);
    
    const responseToValidate = workflowState[step.config?.responseField || 'last_ai_response'];
    const schema = step.config?.schema;
    
    if (!responseToValidate) {
      console.log(`⚠️ No response to validate for step: ${step.name}`);
      return;
    }
    
    // Basic validation logic - can be enhanced
    if (schema && typeof responseToValidate === 'object') {
      try {
        // Simple validation - check if required fields exist
        const requiredFields = schema.required || [];
        const missingFields = requiredFields.filter(field => !(field in responseToValidate));
        
        if (missingFields.length > 0) {
          throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
        }
        
        console.log(`✅ Response validation passed`);
      } catch (error) {
        console.error(`❌ Response validation failed: ${error.message}`);
        throw error;
      }
    }
  }

  /**
   * Execute filter response step
   */
  async executeFilterResponseStep(step, workflowState) {
    console.log(`🔍 Filtering response (${step.name})`);
    
    const responseToFilter = workflowState[step.config?.responseField || 'last_ai_response'];
    const filter = step.config?.filter;
    
    if (!responseToFilter || !filter) {
      console.log(`⚠️ No response or filter to apply for step: ${step.name}`);
      return;
    }
    
    // Basic filtering logic - can be enhanced with jq-like syntax
    try {
      const filteredResponse = this.applyFilter(responseToFilter, filter);
      workflowState[`${step.name}_filtered`] = filteredResponse;
      console.log(`✅ Response filtered successfully`);
    } catch (error) {
      console.error(`❌ Response filtering failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute conditional step
   */
  async executeConditionalStep(step, workflowState) {
    console.log(`❓ Evaluating condition (${step.name})`);
    
    const field = step.config?.field;
    const operator = step.config?.operator || '==';
    const value = step.config?.value;
    const responseField = step.config?.responseField || 'last_ai_response';
    
    const responseToCheck = workflowState[responseField];
    if (!responseToCheck) {
      console.log(`⚠️ No response to check condition for step: ${step.name}`);
      return;
    }
    
    let conditionMet = false;
    const fieldValue = this.getNestedValue(responseToCheck, field);
    
    switch (operator) {
      case '==':
        conditionMet = fieldValue == value;
        break;
      case '!=':
        conditionMet = fieldValue != value;
        break;
      case '>':
        conditionMet = fieldValue > value;
        break;
      case '<':
        conditionMet = fieldValue < value;
        break;
      case 'contains':
        conditionMet = String(fieldValue).includes(String(value));
        break;
      default:
        console.log(`⚠️ Unknown operator: ${operator}`);
    }
    
    console.log(`${conditionMet ? '✅' : '❌'} Condition ${field} ${operator} ${value}: ${conditionMet}`);
    
    // Store condition result
    workflowState[`${step.name}_condition_met`] = conditionMet;
  }

  /**
   * Execute complete-leg step - marks a workflow leg as completed
   */
  async executeCompleteLegStep(step, workflowState, jobId) {
    console.log(`✅ Executing complete-leg step (${step.name})`);
    
    const config = step.config || {};
    
    // Get leg ID from config or from currentLeg in workflowState
    const legId = config.legId || config.leg_id || workflowState.currentLeg?.leg_id || workflowState.currentItem?.leg_id;
    
    if (!legId) {
      throw new Error('complete-leg step requires leg_id in config or currentLeg in workflowState');
    }
    
    if (!workflowState.workflowId) {
      throw new Error('complete-leg step requires workflowId in workflowState');
    }
    
    // Determine final result from config or from determine_completion result
    let finalResult = config.final_result || config.finalResult || 'skipped';
    let error = config.error || null;
    
    // Try to get result from determine_completion step if not specified
    if (finalResult === 'skipped' || !config.final_result) {
      const determineResult = workflowState['determine_completion']?.result || 
                              workflowState.results?.['determine_completion']?.result ||
                              workflowState.lastExecutionResult;
      
      if (determineResult) {
        const status = determineResult.status || determineResult.completion_status || 'unknown';
        finalResult = status === 'success' ? 'success' : (status === 'failure' ? 'failure' : 'skipped');
        error = determineResult.error || determineResult.reason || null;
      }
    }
    
    // Try to get result from collect_iteration_data if still not found
    if (finalResult === 'skipped' || !config.final_result) {
      const collectResult = workflowState['collect_iteration_data']?.result || 
                          workflowState.results?.['collect_iteration_data']?.result;
      
      if (collectResult) {
        if (collectResult.legSucceeded !== undefined) {
          finalResult = collectResult.legSucceeded ? 'success' : (collectResult.legFailed ? 'failure' : 'skipped');
        }
      }
    }
    
    try {
      await axios.post(
        `${this.backendUrl}/api/workflows/${workflowState.workflowId}/legs/${legId}/complete`,
        {
          final_result: finalResult,
          error: error
        },
        {
          headers: this.getAuthHeaders()
        }
      );
      
      console.log(`✅ Marked leg ${legId} as ${finalResult}`);
      
      // Log to backend
      await this.sendLogToBackend(jobId, 'info', `✅ Leg ${legId} completed with status: ${finalResult}`, 'WORKFLOW-ANALYZER', {
        leg_id: legId,
        final_result: finalResult,
        error: error
      });
      
      this.storeStepResult(step, { 
        leg_id: legId,
        final_result: finalResult,
        error: error,
        completed: true
      }, workflowState);
      
    } catch (completeError) {
      console.error(`❌ Failed to mark leg ${legId} as completed: ${completeError.message}`);
      throw completeError;
    }
  }

  /**
   * Execute var-dump step - capture workflow state snapshot
   */
  async executeVarDumpStep(step, workflowState, jobId) {
    console.log(`🧾 Executing var-dump step (${step.name})`);

    // Ensure variablePool is initialized before capturing snapshot
    this.initializeVariablePool(workflowState);

    const config = step.config || {};
    const options = {
      maxDepth: Math.max(1, this.coerceToInteger(config.maxDepth) ?? 4),
      maxArrayLength: Math.max(1, this.coerceToInteger(config.maxArrayLength) ?? 20),
      maxStringLength: Math.max(50, this.coerceToInteger(config.maxStringLength) ?? 1200)
    };

    const { snapshot, scopes, statistics } = this.buildVarDumpSnapshot(step, workflowState, options, config);

    if (!snapshot || Object.keys(snapshot).length === 0) {
      await this.sendLogToBackend(jobId, 'info', '🧾 Var dump skipped (no data)', 'WORKFLOW-VAR-DUMP', {
        step_type: 'var-dump',
        step_name: step.name,
        step_slug: step.slug || null
      });
      return;
    }

    const metadata = {
      step_type: 'var-dump',
      step_name: step.name,
      step_slug: step.slug || null,
      scopes,
      snapshot,
      statistics,
      includeShared: config.includeShared !== false,
      includeCurrentLoop: config.includeCurrentLoop === true,
      includeStepsSummary: config.includeStepsSummary === true,
      includeContext: config.includeContext === true,
      maxDepth: options.maxDepth,
      maxArrayLength: options.maxArrayLength,
      maxStringLength: options.maxStringLength
    };

    try {
      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId,
        level: 'info',
        message: `🧾 [VAR-DUMP] ${step.name || 'Workflow variables'}`,
        component: 'WORKFLOW-VAR-DUMP',
        metadata
      }, {
        headers: this.getAuthHeaders()
      });

      this.storeStepResult(step, {
        dumped_scopes: scopes,
        statistics,
        preview: this.createVarDumpPreview(snapshot)
      }, workflowState);

      console.log(`✅ Var dump captured (${scopes.join(', ')})`);
    } catch (error) {
      console.error(`❌ Var dump step failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute job configuration step - sets job-level configuration that affects entire workflow behavior
   * This step changes job behavior from default "crawl" (test everything) to specific modes like "login" (collect data only)
   */
  async executeJobConfigurationStep(step, workflowState, jobId) {
    console.log(`🔧 Configuring job behavior (${step.name})`);
    
    const config = step.config || {};
    const jobType = config.jobType || 'crawl'; // Default is crawl
    const isLoginJob = config.isLoginJob === true || jobType === 'login';
    const preventCrawling = config.preventCrawling !== false && isLoginJob; // Default true for login jobs
    const preventNavigation = config.preventNavigation !== false && isLoginJob; // Default true for login jobs
    const preventLinkDiscovery = config.preventLinkDiscovery !== false && isLoginJob; // Default true for login jobs
    const scope = config.scope || (isLoginJob ? 'data_collection' : 'testing'); // login = data collection, crawl = testing
    
    // Initialize variable pool if needed
    this.initializeVariablePool(workflowState);
    
    // Set job configuration variables
    this.saveVariable(workflowState, 'jobType', jobType, 'job', step);
    this.saveVariable(workflowState, 'isLoginJob', isLoginJob, 'job', step);
    this.saveVariable(workflowState, 'preventCrawling', preventCrawling, 'job', step);
    this.saveVariable(workflowState, 'preventNavigation', preventNavigation, 'job', step);
    this.saveVariable(workflowState, 'preventLinkDiscovery', preventLinkDiscovery, 'job', step);
    this.saveVariable(workflowState, 'scope', scope, 'job', step);
    
    // Sync to context immediately so it affects subsequent steps
    const previousJobType = this.context.jobType || 'crawl';
    this.context.jobType = jobType;
    this.context.isLoginJob = isLoginJob;
    this.context.preventCrawling = preventCrawling;
    this.context.preventNavigation = preventNavigation;
    this.context.preventLinkDiscovery = preventLinkDiscovery;
    
    const jobConfig = {
      jobType,
      isLoginJob,
      preventCrawling,
      preventNavigation,
      preventLinkDiscovery,
      scope
    };
    
    console.log(`🔧 Job configuration applied:`, jobConfig);
    if (previousJobType !== jobType) {
      console.log(`🔧 Job type changed: ${previousJobType} → ${jobType}`);
      if (isLoginJob) {
        console.log(`🔐 LOGIN JOB MODE ACTIVATED: Job behavior changed from crawl (test everything) to login (collect data only)`);
      }
    }
    
    // Log to backend
    if (jobId) {
      try {
        await this.sendLogToBackend(jobId, 'info', 
          `🔧 Job configuration applied: ${jobType} mode (${scope === 'data_collection' ? 'data collection' : 'testing'})`, 
          'WORKFLOW-ANALYZER', {
            step_id: step.id,
            step_name: step.name,
            step_type: 'job-configuration',
            previous_job_type: previousJobType,
            new_job_type: jobType,
            configuration: jobConfig
          }
        );
      } catch (e) {
        // Silent fail
      }
    }
    
    // Store step result
    this.storeStepResult(step, {
      success: true,
      jobType,
      isLoginJob,
      preventCrawling,
      preventNavigation,
      preventLinkDiscovery,
      scope,
      previousJobType,
      message: `Job configured as ${jobType} mode (${scope === 'data_collection' ? 'data collection' : 'testing'})`
    }, workflowState);
    
    return jobConfig;
  }

  /**
   * Execute print step - logs a message to job history
   */
  async executePrintStep(step, workflowState, jobId) {
    console.log(`📝 Printing message (${step.name})`);
    
    const config = step.config || {};
    const rawMessage = typeof config.message === 'string'
      ? config.message
      : (config.message?.toString?.() ?? 'No message provided');
    const level = config.level || 'info';

    const scope = this.buildTemplateScope(step, workflowState, jobId);
    let message = this.interpolateTemplate(rawMessage, scope);

    const itemsToLog = this.selectItemsForPrint(step, workflowState, scope, config);
    const itemsLabel = config.arrayLabel ||
      config.itemsLabel ||
      (itemsToLog === scope.legsToExecute ? 'Legs' : null) ||
      'Items';
    const formattedItems = Array.isArray(itemsToLog) && itemsToLog.length > 0
      ? this.formatItemsForPrint(itemsToLog, {
          maxItems: this.coerceToInteger(config.maxItemsToLog) ?? 10,
          label: itemsLabel
        })
      : '';

    if (formattedItems) {
      message = `${message}\n${formattedItems}`;
    }

    const metadata = {
      step_name: step.name,
      step_slug: step.slug || null,
      message: message,
      level: level
    };

    if (Array.isArray(itemsToLog) && itemsToLog.length > 0) {
      const preview = this.createItemsPreview(itemsToLog, config);
      metadata.array_path = config.arrayPath || config.itemsPath || 'legsToExecute';
      metadata.array_total = itemsToLog.length;
      if (preview.length > 0) {
        metadata.array_preview = preview;
      }
    }

    const legIndex = scope.currentLegIndex ?? workflowState?.currentLegIndex ?? workflowState?.context?.currentLegIndex;
    if (Number.isInteger(legIndex)) {
      metadata.current_leg_index = legIndex;
    }

    this.enrichPrintMetadata(metadata, scope, workflowState);

    try {
      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: level,
        message: `📝 [PRINT] ${message}`,
        component: 'WORKFLOW-PRINT',
        metadata
      }, {
        headers: this.getAuthHeaders()
      });

      this.storeStepResult(step, { 
        message,
        level,
        printed: true,
        items_logged: Array.isArray(itemsToLog) ? itemsToLog.length : 0
      }, workflowState);
      console.log(`✅ Printed message: "${message}" (level: ${level})`);
    } catch (error) {
      console.error(`❌ Print step failed: ${error.message}`);
      throw error;
    }
  }

  buildTemplateScope(step, workflowState, jobId) {
    const scope = {};

    if (this.context && typeof this.context === 'object') {
      scope.jobContext = this.context;
      Object.entries(this.context).forEach(([key, value]) => {
        scope[key] = value;
      });
    }

    if (workflowState && typeof workflowState === 'object') {
      Object.entries(workflowState).forEach(([key, value]) => {
        scope[key] = value;
      });
    }

    if (workflowState?.context && typeof workflowState.context === 'object') {
      Object.entries(workflowState.context).forEach(([key, value]) => {
        scope[key] = value;
      });
    }

    scope.workflowState = workflowState;
    scope.state = workflowState;
    scope.context = workflowState?.context || {};
    scope.step = step;
    scope.config = step?.config || {};
    scope.jobId = jobId;
    scope.helpers = this.getTemplateHelpers();

    return scope;
  }

  getTemplateHelpers() {
    return {
      json: (value, spacing = 2) => {
        try {
          return JSON.stringify(value, null, spacing);
        } catch (error) {
          return '';
        }
      },
      list: (items, options = {}) => this.formatItemsForPrint(
        Array.isArray(items) ? items : [],
        { maxItems: this.coerceToInteger(options.maxItems) ?? 10, label: options.label }
      ),
      legs: (items, options = {}) => this.formatItemsForPrint(
        Array.isArray(items) ? items : [],
        { maxItems: this.coerceToInteger(options.maxItems) ?? 10, label: options.label || 'Legs' }
      ),
      describeLeg: (leg, index, options = {}) => this.describeLegForPrint(leg, index, options)
    };
  }

  interpolateTemplate(template, scope) {
    if (typeof template !== 'string' || !template.includes('{{')) {
      return template;
    }

    const expressionRegex = /\{\{\s*([^}]+?)\s*\}\}/g;
    return template.replace(expressionRegex, (_, expression) => {
      try {
        // Escape single quotes in the expression to prevent issues with string literals
        // Replace double quotes with single quotes for safer evaluation
        // This handles expressions like: determine_completion.status || loginStatus || "unknown"
        let safeExpression = expression;
        
        // If expression contains double-quoted strings, convert them to single-quoted strings
        // This prevents "Arg string terminates parameters early" errors
        safeExpression = safeExpression.replace(/"([^"]*)"/g, (match, content) => {
          // Escape single quotes in the content and wrap in single quotes
          const escapedContent = content.replace(/'/g, "\\'");
          return `'${escapedContent}'`;
        });
        
        // Build function with proper parameter names
        const paramNames = Object.keys(scope);
        const paramValues = Object.values(scope);
        
        // Create a safe wrapper that handles the expression
        const fnBody = `try { return (${safeExpression}); } catch(e) { return undefined; }`;
        const fn = new Function(...paramNames, fnBody);
        const result = fn(...paramValues);
        
        if (result === undefined || result === null) {
          return '';
        }
        if (typeof result === 'object') {
          return JSON.stringify(result, null, 2);
        }
        return String(result);
      } catch (error) {
        console.warn(`⚠️ Failed to evaluate print expression "${expression}": ${error.message}`);
        return '';
      }
    });
  }

  selectItemsForPrint(step, workflowState, scope, config) {
    const candidates = [];
    const arraySource = config.arraySource || config.sourceType || 'context';

    if (config.arrayPath) {
      const resolved = this.resolvePathValue(workflowState, config.arrayPath, arraySource);
      if (Array.isArray(resolved)) {
        candidates.push(resolved);
      }
    }

    if (config.itemsPath) {
      const resolvedItemsPath = this.resolvePathValue(workflowState, config.itemsPath, arraySource);
      if (Array.isArray(resolvedItemsPath)) {
        candidates.push(resolvedItemsPath);
      }
    }

    if (Array.isArray(scope.legsToExecute)) {
      candidates.push(scope.legsToExecute);
    }

    if (Array.isArray(workflowState?.legsToExecute)) {
      candidates.push(workflowState.legsToExecute);
    }

    if (Array.isArray(workflowState?.context?.legsToExecute)) {
      candidates.push(workflowState.context.legsToExecute);
    }

    const uniqueCandidates = candidates.filter((array, index, self) => {
      return Array.isArray(array) && array.length > 0 && self.findIndex(candidate => candidate === array) === index;
    });

    return uniqueCandidates.length > 0 ? uniqueCandidates[0] : null;
  }

  formatItemsForPrint(items, options = {}) {
    if (!Array.isArray(items) || items.length === 0) {
      return '';
    }

    const maxItems = Math.max(1, options.maxItems ?? 10);
    const label = options.label || 'Items';
    const limitedItems = items.slice(0, maxItems);
    const lines = limitedItems.map((item, index) => {
      if (item && typeof item === 'object') {
        const identifier = item.leg_id || item.id || item.action_id || item.name || `item_${index}`;
        const type = item.type || item.action_type || 'unknown';
        const description = item.description || item.title || item.text || item.name || item.selector || '';
        const selector = item.selector || item.element_selector || item.elementSelector;
        const parts = [
          `${index + 1}. [${type}] ${description}`.trim()
        ];
        if (identifier) {
          parts.push(`id: ${identifier}`);
        }
        if (selector) {
          parts.push(`selector: ${selector}`);
        }
        return `  ${parts.join(' — ')}`.trimEnd();
      }
      return `  ${index + 1}. ${String(item)}`;
    });

    if (items.length > maxItems) {
      lines.push(`  ... and ${items.length - maxItems} more`);
    }

    return `${label}:\n${lines.join('\n')}`;
  }

  createItemsPreview(items, config = {}) {
    if (!Array.isArray(items) || items.length === 0) {
      return [];
    }

    const previewLimit = Math.max(1, Math.min(this.coerceToInteger(config.previewItems) ?? 5, 20));
    return items.slice(0, previewLimit).map(item => this.summarizeItemForMetadata(item));
  }

  summarizeItemForMetadata(item) {
    if (!item || typeof item !== 'object') {
      return item;
    }

    return {
      id: item.leg_id || item.id || item.action_id || null,
      type: item.type || item.action_type || null,
      description: item.description || item.title || item.text || item.name || null,
      selector: item.selector || item.element_selector || item.elementSelector || null
    };
  }

  describeLegForPrint(leg, index, options = {}) {
    const includeId = options.includeId !== false;
    const includeSelector = options.includeSelector !== false;

    if (!leg || typeof leg !== 'object') {
      if (typeof index === 'number') {
        return `Leg #${index + 1}`;
      }
      return 'Leg';
    }

    const parts = [];

    if (typeof index === 'number') {
      parts.push(`#${index + 1}`);
    } else if (typeof leg.iteration === 'number') {
      parts.push(`#${leg.iteration + 1}`);
    }

    const type = leg.type || leg.action_type;
    if (type) {
      parts.push(`[${type}]`);
    }

    const description = leg.title || leg.description || leg.text || leg.name || leg.selector || leg.action || null;
    if (description) {
      parts.push(description);
    }

    if (includeSelector) {
      const selector = leg.selector || leg.element_selector || leg.elementSelector || null;
      if (selector) {
        parts.push(`selector: ${selector}`);
      }
    }

    if (includeId) {
      const identifier = leg.leg_id || leg.id || leg.action_id || leg.original_leg_id || null;
      if (identifier) {
        parts.push(`id: ${identifier}`);
      }
    }

    if (parts.length === 0) {
      return 'Leg';
    }

    return parts.join(' ');
  }

  enrichPrintMetadata(metadata, scope, workflowState) {
    if (!metadata || typeof metadata !== 'object') {
      return;
    }

    const currentLeg = this.resolveCurrentLeg(scope, workflowState);
    if (currentLeg && typeof currentLeg === 'object') {
      const legSummary = this.summarizeItemForMetadata(currentLeg);
      if (legSummary) {
        metadata.current_leg = legSummary;
      }
      const legId = this.toStringIdentifier(
        currentLeg.leg_id ||
        legSummary?.id ||
        currentLeg.id ||
        currentLeg.original_leg_id ||
        currentLeg.source_leg_id
      );
      if (legId) {
        metadata.current_leg_id = legId;
      }
      const actionId = this.toStringIdentifier(
        currentLeg.action_id ||
        currentLeg.actionId ||
        currentLeg.action?.id ||
        currentLeg.action?._id
      );
      if (actionId) {
        metadata.action_id = actionId;
      }
      const stableActionId = this.toStringIdentifier(
        currentLeg.stable_action_id || currentLeg.stableActionId
      );
      if (stableActionId) {
        metadata.stable_action_id = stableActionId;
      }
      const selector = currentLeg.selector || currentLeg.element_selector || currentLeg.elementSelector;
      if (selector && !metadata.current_selector) {
        metadata.current_selector = selector;
      }
    }

    const currentItem = scope.currentItem || workflowState?.currentItem;
    if (currentItem && typeof currentItem === 'object') {
      const itemSummary = this.summarizeItemForMetadata(currentItem);
      if (itemSummary) {
        metadata.current_item = itemSummary;
      }
      const itemLegId = this.toStringIdentifier(
        currentItem.leg_id ||
        currentItem.id ||
        currentItem.original_leg_id ||
        currentItem.source_leg_id
      );
      if (itemLegId && !metadata.current_leg_id) {
        metadata.current_leg_id = itemLegId;
      }
      const itemActionId = this.toStringIdentifier(
        currentItem.action_id ||
        currentItem.actionId ||
        currentItem.action?.id ||
        currentItem.action?._id
      );
      if (itemActionId && !metadata.action_id) {
        metadata.action_id = itemActionId;
      }
      const itemStableId = this.toStringIdentifier(
        currentItem.stable_action_id || currentItem.stableActionId
      );
      if (itemStableId && !metadata.stable_action_id) {
        metadata.stable_action_id = itemStableId;
      }
    }

    const resolvedLegId = this.toStringIdentifier(
      scope.currentLegResolvedId ||
      workflowState?.currentLegResolvedId
    );
    if (resolvedLegId) {
      metadata.current_leg_resolved_id = resolvedLegId;
    }

    const originalLegId = this.toStringIdentifier(
      scope.currentLegOriginalId ||
      workflowState?.currentLegOriginalId
    );
    if (originalLegId) {
      metadata.current_leg_original_id = originalLegId;
    }
  }

  resolveCurrentLeg(scope, workflowState) {
    if (scope?.currentLeg) {
      return scope.currentLeg;
    }
    if (workflowState?.currentLeg) {
      return workflowState.currentLeg;
    }
    if (workflowState?.context?.currentLeg) {
      return workflowState.context.currentLeg;
    }
    return null;
  }

  toStringIdentifier(value) {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (typeof value === 'object') {
      if (value.$oid && typeof value.$oid === 'string') {
        return value.$oid;
      }
      if (typeof value.toHexString === 'function') {
        try {
          return value.toHexString();
        } catch (error) {
          return null;
        }
      }
      if (value._id || value.id) {
        return this.toStringIdentifier(value._id || value.id);
      }
    }
    return null;
  }

  /**
   * Execute sleep step - pauses execution for specified milliseconds
   */
  async executeSleepStep(step, workflowState) {
    console.log(`😴 Sleeping (${step.name})`);
    
    const config = step.config || {};
    const ms = config.ms || 1000;

    if (ms < 0 || ms > 300000) {
      const errorMessage = `Invalid sleep duration "${ms}" in sleep step "${step.name || step.id}". Must be between 0 and 300000ms`;
      const missingPath = 'step.config.ms';
      console.error(`❌ ${errorMessage}`);
      console.error(`❌ Invalid value path: ${missingPath}`);
      console.error(`❌ Full step:`, JSON.stringify(step, null, 2));
      console.error(`❌ Step config:`, JSON.stringify(step.config, null, 2));
      
      const fullContext = {
        step_id: step.id,
        step_name: step.name || step.type,
        step_type: step.type,
        step_config: step.config,
        invalid_value: ms,
        full_step: step
      };
      
      // Note: jobId is not available in executeSleepStep signature, but we can try to get it from workflowState or context
      const effectiveJobId = workflowState.jobId || this.context?.jobId;
      if (effectiveJobId && this.backendLogger) {
        try {
          await this.backendLogger.appendJobLog(effectiveJobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', {
            ...fullContext,
            invalid_path: missingPath
          });
        } catch (e) {
          console.error(`❌ Failed to log error to backend:`, e.message);
        }
      }
      
      throw new Error(`${errorMessage}\nInvalid value path: ${missingPath}\nFull step: ${JSON.stringify(step, null, 2)}`);
    }

    try {
      await new Promise(resolve => setTimeout(resolve, ms));
      this.storeStepResult(step, { duration: ms, slept: true }, workflowState);
      console.log(`✅ Slept for ${ms}ms`);
    } catch (error) {
      console.error(`❌ Sleep step failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute for-each step - iterate over items and execute nested steps
   */
  async executeForEachStep(page, step, workflowState, jobId) {
    console.log(`🔁 Executing for-each step (${step.name})`);
    
    const config = step.config || {};
    const {
      itemsPath,
      sourceType = 'context',
      itemVariable = 'currentItem',
      indexVariable = `${itemVariable}Index`,
      maxItems,
      resultKey: providedResultKey,
      steps: nestedStepsConfig = []
    } = config;

    if (!itemsPath) {
      const errorMessage = `Missing required field "itemsPath" in for-each step "${step.name || step.id}"`;
      const missingPath = 'step.config.itemsPath';
      console.error(`❌ ${errorMessage}`);
      console.error(`❌ Missing JSON path: ${missingPath}`);
      console.error(`❌ Full step:`, JSON.stringify(step, null, 2));
      console.error(`❌ Step config:`, JSON.stringify(step.config, null, 2));
      
      const fullContext = {
        step_id: step.id,
        step_name: step.name || step.type,
        step_type: step.type,
        step_config: step.config,
        full_step: step
      };
      
      if (jobId && this.backendLogger) {
        try {
          await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', {
            ...fullContext,
            missing_path: missingPath
          });
        } catch (e) {
          console.error(`❌ Failed to log error to backend:`, e.message);
        }
      }
      
      throw new Error(`${errorMessage}\nMissing JSON path: ${missingPath}\nFull step: ${JSON.stringify(step, null, 2)}`);
    }

    // Initialize variable pool if needed
    this.initializeVariablePool(workflowState);

    // Enter cycle scope for variable namespace management
    workflowState.cycleDepth = (workflowState.cycleDepth || 0) + 1;
    const cycleIndex = workflowState.cycleStack.length;
    workflowState.cycleStack.push({
      stepId: step.id,
      stepName: step.name,
      stepSlug: step.slug,
      cycleIndex,
      startedAt: new Date().toISOString()
    });
    // Initialize cycle namespace in variable pool
    if (!workflowState.variablePool.cycle[cycleIndex]) {
      workflowState.variablePool.cycle[cycleIndex] = {};
    }

    // STRICT: For "journeysToExecute" or "legsToExecute" with sourceType "context", read ONLY from variable pool (page namespace)
    // This is where the AI step stores it, and we expect it there - no fallbacks
    let items;
    if ((itemsPath === 'journeysToExecute' || itemsPath === 'legsToExecute') && sourceType === 'context') {
      // Initialize variable pool if needed
      this.initializeVariablePool(workflowState);
      // Read directly from variable pool (page namespace) - exact location where AI step stores it
      // Prefer journeysToExecute (new format), fallback to legsToExecute (backwards compatibility)
      items = this.readVariable(workflowState, 'journeysToExecute', 'page') || this.readVariable(workflowState, 'legsToExecute', 'page');
      
      console.log(`🔍 For-each step: Reading "${itemsPath}" from variable pool (page namespace)`);
      console.log(`🔍 Result: ${Array.isArray(items) ? `array with ${items.length} items` : `not found (${typeof items})`}`);
      
      if (!Array.isArray(items)) {
        // Fallback to workflowState/context if variable pool isn't populated yet
        const fallbackItems =
          workflowState.journeysToExecute ||
          workflowState.legsToExecute ||
          workflowState.journeys ||
          workflowState.context?.journeysToExecute ||
          workflowState.context?.journeys ||
          null;

        if (Array.isArray(fallbackItems)) {
          items = fallbackItems;
          console.warn(`⚠️ For-each step: "${itemsPath}" missing in variable pool; using fallback items from workflowState/context (${items.length} items).`);
        } else {
          throw new Error(`for-each step expected "${itemsPath}" in variable pool (page namespace), but it was not found. The AI step must store journeys there before this step executes.`);
        }
      }
      
      // CRITICAL: Set workflowState.journeysToExecute so while-loop can access it
      // The while-loop checks workflowState.journeysToExecute, not the variable pool
      if (itemsPath === 'journeysToExecute') {
        workflowState.journeysToExecute = items;
        console.log(`✅ For-each step: Set workflowState.journeysToExecute with ${items.length} journey(s)`);
      } else if (itemsPath === 'legsToExecute') {
        workflowState.legsToExecute = items;
        console.log(`✅ For-each step: Set workflowState.legsToExecute with ${items.length} leg(s)`);
      }
    } else {
      // For other paths, use resolvePathValue
      items = this.resolvePathValue(workflowState, itemsPath, sourceType);
      
      console.log(`🔍 For-each resolving items from path "${itemsPath}" (source: ${sourceType})`);
      console.log(`🔍 Resolved items: ${Array.isArray(items) ? `array with ${items.length} items` : `not an array (${typeof items})`}`);
      
      if (!Array.isArray(items)) {
        throw new Error(`for-each step expected an array at path "${itemsPath}" (source: ${sourceType}), got: ${typeof items}`);
      }
    }

    const isSingleActionMode =
      workflowState.singleActionOnly === true ||
      workflowState.options?.single_action_only === true ||
      this.context?.single_action_only === true ||
      this.context?.options?.single_action_only === true;

    if (isSingleActionMode && items.length > 1) {
      console.log(`🎯 Single-action mode enabled - limiting items from ${items.length} to 1`);
      items = items.slice(0, 1);
      workflowState.legsToExecute = items;
      if (!workflowState.context) {
        workflowState.context = {};
      }
      workflowState.context.legsToExecute = items;
    }

    const numericMaxItems = this.coerceToInteger(maxItems);
    const effectiveItems = numericMaxItems !== null ? items.slice(0, Math.max(numericMaxItems, 0)) : items;
    const resultKey = providedResultKey || `${step.id || 'for_each'}_results`;

    // Save previous values if they exist
    const hadItemVariable = Object.prototype.hasOwnProperty.call(workflowState, itemVariable);
    const previousItemValue = workflowState[itemVariable];
    const hadIndexVariable = Object.prototype.hasOwnProperty.call(workflowState, indexVariable);
    const previousIndexValue = workflowState[indexVariable];

    const nestedStepsArray = Array.isArray(nestedStepsConfig) ? nestedStepsConfig : [];
    const iterationSummaries = [];

    console.log(`🔁 Iterating over ${effectiveItems.length} items`);

    for (let idx = 0; idx < effectiveItems.length; idx++) {
      const item = effectiveItems[idx];
      workflowState[itemVariable] = item;
      workflowState[indexVariable] = idx;
      
      // CRITICAL: Also set currentJourney if itemVariable is currentJourney or if item has journey_id
      // This ensures while-loop can find the journey in journeysToExecute
      if (itemVariable === 'currentJourney' || item.journey_id) {
        workflowState.currentJourney = item;
      }
      console.log(`🔁 Iteration ${idx + 1}/${effectiveItems.length}: Processing item`);
      
      // Report progress: current iteration
      await this.updateJobProgress(jobId, {
        current_iteration: idx + 1,
        total_iterations: effectiveItems.length,
        current_step: null, // Will be updated per nested step
        current_activity: `Iteration ${idx + 1} of ${effectiveItems.length} legs`
      });
      
      // Execute nested steps for this item
      if (nestedStepsArray.length > 0) {
        for (let nestedIdx = 0; nestedIdx < nestedStepsArray.length; nestedIdx++) {
          const nestedStep = nestedStepsArray[nestedIdx];
          
          // Create unique step ID for nested step
          const baseId = nestedStep.id || `nested-${nestedIdx}`;
          const nestedStepId = `${step.id || 'for-each'}::${idx}::${baseId}`;
          
          const nestedStepWithId = {
            ...nestedStep,
            id: nestedStepId,
            originalId: nestedStep.id || baseId
          };
          
          const stepName = nestedStep.name || nestedStep.type || 'Unknown step';
          const stepTypeLabel = nestedStep.type === 'ai-prompt' ? 'AI prompt' : 
                                nestedStep.type === 'execute-code' || nestedStep.type === 'execute-code-from-variable' ? 'Code execution' :
                                nestedStep.type === 'screenshot' ? 'Screenshot' :
                                nestedStep.type === 'playwright-analysis' ? 'Page analysis' :
                                stepName;
          
          console.log(`🔁 Executing nested step ${nestedIdx + 1}/${nestedStepsArray.length}: ${stepName} (iteration ${idx + 1})`);
          
          // Report progress: current step
          await this.updateJobProgress(jobId, {
            current_iteration: idx + 1,
            total_iterations: effectiveItems.length,
            current_step: stepName,
            current_activity: `Iteration ${idx + 1} of ${effectiveItems.length} legs • Current step: "${stepName}" (${stepTypeLabel})`
          });
          
          try {
            // Execute nested step using the same switch logic
            await this.executeStepByType(page, nestedStepWithId, workflowState, jobId, {
              stepIndex: nestedIdx,
              siblings: nestedStepsArray
            });
          } catch (nestedError) {
            console.error(`❌ Nested step failed in iteration ${idx + 1}: ${nestedError.message}`);
            // No fallbacks: fail the job on any nested step failure
            throw nestedError;
          }
        }
      }

      // Collect step results for this iteration
      const stepResults = nestedStepsArray.map((nestedStep, nestedIndex) => {
        const baseId = nestedStep.id || `nested-${nestedIndex}`;
        const nestedStepId = `${step.id || 'for-each'}::${idx}::${baseId}`;
        return {
          stepId: nestedStepId,
          originalStepId: nestedStep.id || baseId,
          result: workflowState[nestedStepId]
        };
      });

      iterationSummaries.push({
        index: idx,
        item,
        stepResults
      });

      // Save currentItem to cycle namespace for each iteration
      this.saveVariable(workflowState, itemVariable, item, 'cycle', null);
      this.saveVariable(workflowState, indexVariable, idx, 'cycle', null);
    }

    // Exit cycle scope
    if (workflowState.cycleStack.length > 0) {
      workflowState.cycleStack.pop();
    }
    workflowState.cycleDepth = Math.max(0, (workflowState.cycleDepth || 0) - 1);

    // Restore previous values
    if (hadItemVariable) {
      workflowState[itemVariable] = previousItemValue;
    } else {
      delete workflowState[itemVariable];
    }

    if (hadIndexVariable) {
      workflowState[indexVariable] = previousIndexValue;
    } else {
      delete workflowState[indexVariable];
    }

    // Store results
    workflowState[resultKey] = iterationSummaries;
    if (!workflowState.context) {
      workflowState.context = {};
    }
    workflowState.context[resultKey] = iterationSummaries;

    // CRITICAL: Save leg status after for-each completes
    // The nested steps (like test-leg-iteratively) update leg status in workflowState.legsToExecute
    // but we need to persist it to the database
    if (itemsPath === 'legsToExecute' && workflowState.legsToExecute && Array.isArray(workflowState.legsToExecute) && workflowState.workflowId && jobId) {
      try {
        // Get legs that were processed in this for-each - use the current state from workflowState
        const processedLegs = effectiveItems.map((item, idx) => {
          const legId = item.leg_id || item.id;
          const leg = workflowState.legsToExecute.find(l => (l.leg_id === legId) || (l.id === legId));
          if (leg) {
            // Ensure we have the latest status and iterations
            return {
              ...leg,
              leg_id: leg.leg_id || leg.id || legId,
              status: leg.status || 'pending',
              iterations: leg.iterations || []
            };
          }
          return null;
        }).filter(Boolean);
        
        if (processedLegs.length > 0) {
          console.log(`💾 Saving ${processedLegs.length} leg(s) with status after for-each completion`);
          await this.saveLegIterationsToWorkflow(workflowState, processedLegs, jobId);
          console.log(`✅ Saved ${processedLegs.length} leg(s) with final status after for-each completion`);
        } else {
          console.log(`⚠️ No legs found to save after for-each (itemsPath: ${itemsPath}, legsToExecute length: ${workflowState.legsToExecute?.length || 0})`);
        }
      } catch (saveError) {
        console.error(`❌ Failed to save leg status after for-each: ${saveError.message}`, saveError);
      }
    } else if (itemsPath === 'journeysToExecute' && workflowState.journeysToExecute && Array.isArray(workflowState.journeysToExecute) && workflowState.workflowId && jobId) {
      // CRITICAL: Save journey status after for-each completes (for simplified workflow)
      // The nested steps (like test-journey-iteratively) update journey status in workflowState.journeysToExecute
      // but we need to persist it to the database
      try {
        // Get journeys that were processed in this for-each - use the current state from workflowState
        const processedJourneys = effectiveItems.map((item, idx) => {
          const journeyId = item.journey_id || item.id;
          // CRITICAL: Get the journey from journeysToExecute (which was updated by while-loop)
          const journey = workflowState.journeysToExecute.find(j => (j.journey_id === journeyId) || (j.id === journeyId));
          if (journey) {
            // Get the final status from the while-loop result if available
            const iterationSummary = iterationSummaries[idx];
            const whileLoopResult = iterationSummary?.stepResults?.find(sr => sr.stepId?.includes('test_journey_iteratively') || sr.stepId?.includes('test-journey-iteratively'));
            const finalStatus = whileLoopResult?.result?.finalLegStatus || journey.justification_status || journey.status || 'discovered';
            
            // CRITICAL: Use iterations from journey (which was updated by while-loop with all iterations)
            // The while-loop saves iterations to journey.iterations, so use that directly
            const journeyIterations = journey.iterations || [];
            console.log(`💾 [FOR-EACH] Journey ${journeyId} has ${journeyIterations.length} iteration(s) from while-loop`);
            
            // Ensure we have the latest status and iterations
            return {
              ...journey,
              journey_id: journey.journey_id || journey.id || journeyId,
              justification_status: finalStatus,
              status: finalStatus,
              iterations: journeyIterations // Use iterations from journey (updated by while-loop)
            };
          }
          return null;
        }).filter(Boolean);
        
        if (processedJourneys.length > 0) {
          console.log(`💾 Saving ${processedJourneys.length} journey(s) with status after for-each completion`);
          
          const payload = {
            saveLegs: false,
            journeys: processedJourneys,
            job_id: jobId
          };
          
          const response = await axios.post(
            `${this.backendUrl}/api/pages/${workflowState.pageId}/save-analysis`,
            payload,
            {
              headers: this.getAuthHeaders()
            }
          );
          
          console.log(`✅ Saved ${processedJourneys.length} journey(s) with final status after for-each completion`);
        } else {
          console.log(`⚠️ No journeys found to save after for-each (itemsPath: ${itemsPath}, journeysToExecute length: ${workflowState.journeysToExecute?.length || 0})`);
        }
      } catch (saveError) {
        console.error(`❌ Failed to save journey status after for-each: ${saveError.message}`, saveError);
      }
    }

    this.storeStepResult(step, {
      iterations: iterationSummaries,
      total_iterations: iterationSummaries.length,
      resultKey
    }, workflowState);

    console.log(`✅ For-each step completed: ${iterationSummaries.length} iterations`);
  }

  /**
   * Execute while-loop step - loops while condition is true
   * General-purpose looping element that can loop based on conditions from code or AI
   */
  async executeWhileLoopStep(page, step, workflowState, jobId) {
    console.log(`🔄 Executing while-loop (${step.name})`);
    
    const config = step.config || {};
    // Allow maxIterations from template config (for multi-step wizards within same journey)
    // The rule "1 job = 1 attempt per leg" applies to retrying the same leg, not to iterating through steps within a journey
    let maxIterations = config.maxIterations || 5;
    const resolveStepCountFromText = (textValue) => {
      if (!textValue || typeof textValue !== 'string') return null;
      const match = textValue.match(/step\s*\d+\s*(?:of|\/)\s*(\d+)/i);
      if (!match) return null;
      const parsed = Number.parseInt(match[1], 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };
    
    if (maxIterations > 1) {
      let visibleText = workflowState.visibleText;
      if (!visibleText && page && !page.isClosed()) {
        try {
          visibleText = await page.innerText('body');
        } catch (error) {
          console.warn(`⚠️ Failed to read visible text for step count detection: ${error.message}`);
        }
      }
      
      // CRITICAL: Check if this is a wizard/multistep journey before limiting iterations
      const pageUrl = (workflowState.pageUrl || '').toLowerCase();
      const currentJourney = workflowState.currentJourney || workflowState.currentItem || {};
      const journeyId = (currentJourney.journey_id || '').toLowerCase();
      const journeyDesc = (currentJourney.description || '').toLowerCase();
      const isWizardPage = pageUrl.includes('multi-step-wizard') || pageUrl.includes('multistep') || 
                          journeyId.includes('wizard') || journeyDesc.includes('wizard') || 
                          journeyDesc.includes('multi-step') || journeyDesc.includes('multistep');
      
      const detectedStepCount = resolveStepCountFromText(visibleText);
      if (detectedStepCount) {
        maxIterations = detectedStepCount;
        console.log(`🔢 Detected step count from page text: ${detectedStepCount}`);
      } else if (isWizardPage) {
        // Wizard page but step count not detected - keep maxIterations from config (don't limit to 1)
        console.log(`🔢 Wizard page detected but step count not found - keeping maxIterations=${maxIterations} from config`);
      } else {
        maxIterations = 1;
        console.log(`🔢 No step indicator detected; limiting iterations to 1 for single-step journey`);
      }
    }
    const conditionPath = config.conditionPath; // Path to check for condition (e.g., 'determine_completion.is_complete')
    const conditionType = config.conditionType || 'code'; // 'code', 'ai-response', or 'path'
    const invertCondition = config.invertCondition === true; // If true, loop while condition is false
    const nestedSteps = config.steps || [];
    
    if (!nestedSteps.length) {
      console.log(`⚠️ While-loop has no nested steps`);
      return;
    }
    
    let iteration = 0;
    let condition = true; // Start with true to enter loop
    let lastResult = null;
    
    console.log(`🔄 Starting while-loop (max ${maxIterations} iterations)`);
    
    // Send log to backend
    await this.sendLogToBackend(jobId, 'info', `🔄 Starting while-loop (max ${maxIterations} iterations)`, 'WORKFLOW-ANALYZER', {
      step_id: step.id,
      step_name: step.name || step.type,
      step_type: 'while-loop',
      max_iterations: maxIterations,
      condition_path: conditionPath,
      condition_type: conditionType
    });
    
    // Initialize loop state
    if (!workflowState.loopState) {
      workflowState.loopState = {};
    }
    if (!workflowState.loopState[step.id]) {
      workflowState.loopState[step.id] = {
        iterations: [],
        currentIteration: 0
      };
    }
    
    const loopState = workflowState.loopState[step.id];
    const unwrapStructuredValue = (value) => (
      value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')
        ? value.value
        : value
    );
    
    // Update status to 'analyzing' when starting while-loop (first iteration only)
    // This indicates page analysis/testing is about to begin
    const currentLeg = workflowState.currentJourney || workflowState.currentItem || workflowState.currentLeg || {};
    if (iteration === 0 && workflowState.workflowId && currentLeg?.leg_id) {
      try {
        await this.updateLegStatus(workflowState.workflowId, currentLeg.leg_id, 'analyzing', jobId);
        console.log(`📊 Updated action status to 'analyzing' for leg: ${currentLeg.leg_id}`);
      } catch (statusError) {
        console.warn(`⚠️ Failed to update status to 'analyzing': ${statusError.message}`);
      }
    }
    
    // Loop while condition is true (or false if inverted) and under max iterations
    while ((invertCondition ? !condition : condition) && iteration < maxIterations) {
      iteration++;
      loopState.currentIteration = iteration;
      // Also set workflowState.currentIteration for use by other steps
      workflowState.currentIteration = iteration;

      // Reset cached page context so each iteration uses fresh data
      workflowState.visibleText = null;
      workflowState.playwrightAnalysis = null;
      workflowState.pageDescription = null;
      workflowState.screenshotBase64 = null;
      workflowState.screenshotUrl = null;
      workflowState.screenshotFileId = null;
      
      // Update status to 'testing' when starting iteration (first iteration only)
      if (iteration === 1 && workflowState.workflowId && currentLeg?.leg_id) {
        try {
          await this.updateLegStatus(workflowState.workflowId, currentLeg.leg_id, 'testing', jobId);
          console.log(`📊 Updated action status to 'testing' for leg: ${currentLeg.leg_id}`);
          
          // Also update in workflowState for immediate access
          if (workflowState.legsToExecute && Array.isArray(workflowState.legsToExecute)) {
            const legIndex = workflowState.legsToExecute.findIndex(l => 
              (l.leg_id === currentLeg.leg_id) || (l.id === currentLeg.leg_id)
            );
            if (legIndex >= 0) {
              workflowState.legsToExecute[legIndex].status = 'testing';
            }
          }
        } catch (statusError) {
          console.warn(`⚠️ Failed to update status to 'testing': ${statusError.message}`);
        }
      }
      
      console.log(`🔄 While-loop iteration ${iteration}/${maxIterations}`);
      
      // Send log to backend
      await this.sendLogToBackend(jobId, 'info', `🔄 While-loop iteration ${iteration}/${maxIterations}`, 'WORKFLOW-ANALYZER', {
        step_id: step.id,
        step_name: step.name || step.type,
        step_type: 'while-loop',
        iteration: iteration,
        max_iterations: maxIterations
      });
      
      try {
        // Execute nested steps - use unique step ID per iteration so each step (e.g. generate_journey_script) runs fresh every time
        for (let nestedIdx = 0; nestedIdx < nestedSteps.length; nestedIdx++) {
          const nestedStep = nestedSteps[nestedIdx];
          const baseId = nestedStep.id || `nested-${nestedIdx}`;
          const nestedStepId = `${step.id || 'while-loop'}::${iteration}::${baseId}`;
          const nestedStepWithId = {
            ...nestedStep,
            id: nestedStepId,
            originalId: baseId
          };
          
          try {
            // Get timeout for nested step
            const nestedStepTimeout = this.getStepTimeout(nestedStep);
            console.log(`⏱️  Nested step "${nestedStep.name || nestedStep.id}" timeout: ${Math.round(nestedStepTimeout / 1000)}s`);
            await this.sendLogToBackend(jobId, 'info', `🔄 While-loop iteration ${iteration}: running nested step ${nestedIdx + 1}/${nestedSteps.length} (${nestedStep.name || nestedStep.id}, type: ${nestedStep.type})`, 'WORKFLOW-ANALYZER', { iteration, nestedIdx, stepId: nestedStepId, stepType: nestedStep.type });
            
            // Execute nested step with timeout protection
            let nestedStepCompleted = false;
            await Promise.race([
              (async () => {
                await this.executeStepByType(page, nestedStepWithId, workflowState, jobId, {
                  stepIndex: nestedIdx,
                  siblings: nestedSteps
                });
                // CRITICAL: For condition steps (justify_journey, determine_completion), copy result to original step id so conditionPath finds it
                const isConditionStep = (baseId.includes('justify') && baseId.includes('journey')) || (baseId.includes('determine') && baseId.includes('completion'));
                if (isConditionStep && workflowState[nestedStepId]?.result) {
                  const stepSlug = nestedStep.slug || this.generateSlug(nestedStep.name || baseId);
                  workflowState[baseId] = workflowState[nestedStepId];
                  if (!workflowState.results) workflowState.results = {};
                  workflowState.results[baseId] = workflowState[nestedStepId];
                  if (workflowState.variablePool?.steps) {
                    workflowState.variablePool.steps[stepSlug] = workflowState[nestedStepId];
                    workflowState.variablePool.steps[baseId] = workflowState[nestedStepId];
                  }
                }
                nestedStepCompleted = true;
              })(),
              new Promise((resolve, reject) => 
                setTimeout(() => {
                  if (!nestedStepCompleted) {
                    reject(new Error(`Nested step "${nestedStep.name || nestedStep.id}" timed out after ${Math.round(nestedStepTimeout / 1000)}s`));
                  } else {
                    resolve();
                  }
                }, nestedStepTimeout)
              )
            ]);
            
            // CRITICAL: If this is the determine_completion or justify_journey step, store its result for condition evaluation
            const stepId = nestedStep.id || nestedStep.slug || '';
            const stepName = (nestedStep.name || '').toLowerCase();
            const isDetermineStep = stepId.includes('determine') && (stepId.includes('completion') || stepId.includes('complete')) ||
                                   stepName.includes('determine') && (stepName.includes('completion') || stepName.includes('complete'));
            const isJustifyJourneyStep = stepId.includes('justify') && (stepId.includes('journey') || stepId.includes('leg')) ||
                                       stepName.includes('justify') && (stepName.includes('journey') || stepName.includes('leg'));
            const isConditionStep = isDetermineStep || isJustifyJourneyStep;
            
            if (isConditionStep) {
              // CRITICAL: Store result immediately after step execution for condition evaluation
              // Wait a bit for storeStepResult to complete (it's async)
              await new Promise(resolve => setTimeout(resolve, 100));
              
              // Try multiple locations where storeStepResult might have stored it
              // storeStepResult stores in: workflowState[step.id].result, workflowState.results[step.id].result, workflowState.variablePool.steps[slug].result
              const stepId = nestedStep.id;
              const stepSlug = nestedStep.slug || this.generateSlug(nestedStep.name || 'step');
              
              let stepResult = null;
              
              // Try by step ID first
              if (workflowState[stepId]?.result) {
                stepResult = workflowState[stepId].result;
                console.log(`✅ Found determine_completion result in workflowState[${stepId}].result`);
              } else if (workflowState.results?.[stepId]?.result) {
                stepResult = workflowState.results[stepId].result;
                console.log(`✅ Found determine_completion result in workflowState.results[${stepId}].result`);
              } else if (workflowState.variablePool?.steps?.[stepId]?.result) {
                stepResult = workflowState.variablePool.steps[stepId].result;
                console.log(`✅ Found determine_completion result in workflowState.variablePool.steps[${stepId}].result`);
              } else if (workflowState.variablePool?.steps?.[stepSlug]?.result) {
                stepResult = workflowState.variablePool.steps[stepSlug].result;
                console.log(`✅ Found determine_completion result in workflowState.variablePool.steps[${stepSlug}].result`);
              } else if (workflowState[stepId]) {
                stepResult = workflowState[stepId];
                console.log(`✅ Found determine_completion result in workflowState[${stepId}] (direct)`);
              } else if (workflowState.results?.[stepId]) {
                stepResult = workflowState.results[stepId];
                console.log(`✅ Found determine_completion result in workflowState.results[${stepId}] (direct)`);
              }
              
              console.log(`🔍 Looking for determine_completion result from step ${nestedStep.id}`);
              console.log(`🔍 workflowState[${nestedStep.id}]:`, workflowState[nestedStep.id] ? 'exists' : 'missing');
              console.log(`🔍 workflowState.results[${nestedStep.id}]:`, workflowState.results?.[nestedStep.id] ? 'exists' : 'missing');
              console.log(`🔍 workflowState.variablePool.steps[${nestedStep.id}]:`, workflowState.variablePool?.steps?.[nestedStep.id] ? 'exists' : 'missing');
              
              if (stepResult) {
                const normalizedResult = stepResult?.result || stepResult;
                console.log(`✅ Found determine_completion result, normalizing...`);
                console.log(`🔍 Normalized result keys: ${Object.keys(normalizedResult || {}).join(', ')}`);
                
                // CRITICAL: Validate status field is present - fail if missing
                if (!normalizedResult.status && !normalizedResult.completion_status && normalizedResult.is_complete === undefined) {
                  const errorMessage = `Missing required field "status" in determine_completion result for step "${nestedStep.name || nestedStep.id}" (iteration ${iteration})`;
                  const missingPath = `workflowState.determine_completion.result.status`;
                  const fullContext = {
                    step_id: nestedStep.id,
                    step_name: nestedStep.name,
                    step_type: nestedStep.type,
                    step_config: nestedStep.config,
                    iteration: iteration,
                    missing_field: 'status',
                    missing_path: missingPath,
                    available_keys: Object.keys(normalizedResult || {}),
                    normalized_result: normalizedResult,
                    step_result: stepResult,
                    full_response: normalizedResult
                  };
                  console.error(`❌ ${errorMessage}`);
                  console.error(`❌ Missing JSON path: ${missingPath}`);
                  console.error(`❌ Available keys: ${Object.keys(normalizedResult || {}).join(', ')}`);
                  console.error(`❌ Normalized result:`, JSON.stringify(normalizedResult, null, 2));
                  console.error(`❌ Full step context:`, JSON.stringify(fullContext, null, 2));
                  if (jobId && this.backendLogger) {
                    await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', fullContext);
                  }
                  throw new Error(`${errorMessage}\nMissing JSON path: ${missingPath}\nAvailable keys: ${Object.keys(normalizedResult || {}).join(', ')}\nNormalized result: ${JSON.stringify(normalizedResult, null, 2)}\nFull context: ${JSON.stringify(fullContext, null, 2)}`);
                }
                
                // Store in determine_completion/justify_journey for easy access
                if (isDetermineStep) {
                  workflowState.determine_completion = {
                    result: normalizedResult,
                    step_id: nestedStep.id,
                    iteration: iteration
                  };
                  
                  // Also store directly for backward compatibility
                  if (!workflowState.results) {
                    workflowState.results = {};
                  }
                  workflowState.results.determine_completion = {
                    result: normalizedResult,
                    step_id: nestedStep.id,
                    iteration: iteration
                  };
                  workflowState.variablePool.steps['determine_completion'] = { result: normalizedResult }; // Also store by name
                }
                
                if (isJustifyJourneyStep) {
                  workflowState.justify_journey = {
                    result: normalizedResult,
                    step_id: nestedStep.id,
                    iteration: iteration
                  };
                  
                  if (!workflowState.results) {
                    workflowState.results = {};
                  }
                  workflowState.results.justify_journey = {
                    result: normalizedResult,
                    step_id: nestedStep.id,
                    iteration: iteration
                  };
                  workflowState.variablePool.steps['justify_journey'] = { result: normalizedResult }; // Also store by name
                  // CRITICAL: Also store with slug variants for condition path resolution
                  workflowState.variablePool.steps['justify-journey'] = { result: normalizedResult };
                }
                
                // CRITICAL: Also store directly by step ID for condition path resolution
                if (!workflowState[nestedStep.id]) {
                  workflowState[nestedStep.id] = {};
                }
                workflowState[nestedStep.id].result = normalizedResult;
                
                // CRITICAL: Store by slug for condition path resolution (justify-journey)
                if (isJustifyJourneyStep) {
                  workflowState['justify-journey'] = { result: normalizedResult };
                  if (!workflowState.results) {
                    workflowState.results = {};
                  }
                  workflowState.results['justify-journey'] = { result: normalizedResult };
                }
                
                // CRITICAL: Store in variablePool.steps for condition path resolution
                if (!workflowState.variablePool) {
                  workflowState.variablePool = { steps: {} };
                }
                if (!workflowState.variablePool.steps) {
                  workflowState.variablePool.steps = {};
                }
                workflowState.variablePool.steps[nestedStep.id] = { result: normalizedResult };
                
                const stepType = isDetermineStep ? 'determine_completion' : (isJustifyJourneyStep ? 'justify_journey' : nestedStep.id);
                console.log(`✅ Stored ${stepType} result from nested step ${nestedStep.id} (iteration ${iteration}): status=${normalizedResult.status || normalizedResult.completion_status || normalizedResult.is_complete}`);
                console.log(`📄 Stored in: workflowState.${stepType}.result, workflowState.results.${stepType}.result, workflowState[${nestedStep.id}].result, workflowState.variablePool.steps[${nestedStep.id}].result`);
              } else {
                const errorMessage = `determine_completion step executed but result not found in expected locations for step "${nestedStep.name || nestedStep.id}" (iteration ${iteration})`;
                const missingPath = `workflowState.determine_completion.result`;
                const availableKeys = Object.keys(workflowState).filter(k => k.includes('determine') || k.includes('completion'));
                const availableResultsKeys = workflowState.results ? Object.keys(workflowState.results).filter(k => k.includes('determine') || k.includes('completion')) : [];
                const availableVarPoolKeys = workflowState.variablePool?.steps ? Object.keys(workflowState.variablePool.steps).filter(k => k.includes('determine') || k.includes('completion')) : [];
                const fullContext = {
                  step_id: nestedStep.id,
                  step_name: nestedStep.name,
                  step_type: nestedStep.type,
                  step_config: nestedStep.config,
                  iteration: iteration,
                  missing_path: missingPath,
                  available_keys_workflowState: availableKeys,
                  available_keys_results: availableResultsKeys,
                  available_keys_variablePool_steps: availableVarPoolKeys,
                  workflowState_sample: Object.fromEntries(Object.entries(workflowState).slice(0, 20))
                };
                console.error(`❌ ${errorMessage}`);
                console.error(`❌ Missing JSON path: ${missingPath}`);
                console.error(`❌ Available keys in workflowState: ${availableKeys.join(', ') || 'none'}`);
                console.error(`❌ Available keys in workflowState.results: ${availableResultsKeys.join(', ') || 'none'}`);
                console.error(`❌ Available keys in workflowState.variablePool.steps: ${availableVarPoolKeys.join(', ') || 'none'}`);
                console.error(`❌ Full step context:`, JSON.stringify(fullContext, null, 2));
                if (jobId && this.backendLogger) {
                  await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', fullContext);
                }
                throw new Error(`${errorMessage}\nMissing JSON path: ${missingPath}\nAvailable keys in workflowState: ${availableKeys.join(', ') || 'none'}\nAvailable keys in results: ${availableResultsKeys.join(', ') || 'none'}\nAvailable keys in variablePool.steps: ${availableVarPoolKeys.join(', ') || 'none'}\nFull context: ${JSON.stringify(fullContext, null, 2)}`);
              }
            }
          } catch (nestedError) {
            console.error(`❌ Nested step ${nestedIdx + 1} failed in iteration ${iteration}: ${nestedError.message}`);
            if (nestedStep.config?.critical) {
              throw nestedError;
            }
          }
        }
        
        // CRITICAL: Ensure journeysToExecute is set from variable pool if not already set
        // The for-each step should have set it, but ensure it's available for while-loop
        if (!workflowState.journeysToExecute || !Array.isArray(workflowState.journeysToExecute) || workflowState.journeysToExecute.length === 0) {
          const journeysFromPool = this.readVariable(workflowState, 'journeysToExecute', 'page');
          if (Array.isArray(journeysFromPool) && journeysFromPool.length > 0) {
            workflowState.journeysToExecute = journeysFromPool;
            console.log(`🔧 [WHILE-LOOP-ITERATION-${iteration}] Set journeysToExecute from variable pool (${journeysFromPool.length} journey(s))`);
          }
        }
        
        // CRITICAL: Save iteration BEFORE condition check (so it's saved even if loop exits)
        // This ensures iterations are saved even if the condition is false and loop exits
        // Move the iteration save code here (before condition evaluation)
        try {
          // Get step result for iteration save (from justify_journey or determine_completion)
          let stepResultForSave = null;
          if (conditionPath) {
            const pathSegments = conditionPath.split('.');
            const stepId = pathSegments[0];
            const stepIdVariants = [stepId, stepId.replace(/-/g, '_'), stepId.replace(/_/g, '-')];
            const slug = 'justify-journey';
            const slugVariants = [slug, slug.replace(/-/g, '_')];
            
            for (const slugVariant of slugVariants) {
              const stepData = workflowState.variablePool?.steps?.[slugVariant] ||
                             workflowState[slugVariant] ||
                             workflowState.results?.[slugVariant] ||
                             null;
              if (stepData) {
                let rawResult = stepData.result || 
                            stepData.openai_response || 
                            (stepData.result?.openai_response) ||
                            (typeof stepData === 'object' && !stepData.result && !stepData.openai_response ? stepData : null);
                
                // CRITICAL: Unwrap structured result if needed (wrapped in { value: ..., namespace: ... })
                if (rawResult && typeof rawResult === 'object' && 'value' in rawResult && 'namespace' in rawResult) {
                  stepResultForSave = rawResult.value;
                } else {
                  stepResultForSave = rawResult;
                }
                
                if (stepResultForSave) {
                  console.log(`✅ [WHILE-LOOP-ITERATION-${iteration}] Found stepResultForSave by slug "${slugVariant}"`);
                  break;
                }
              }
            }
            
            if (!stepResultForSave) {
              for (const variant of stepIdVariants) {
                const stepData = workflowState[variant] ||
                                workflowState.results?.[variant] ||
                                workflowState.variablePool?.steps?.[variant] ||
                                null;
                if (stepData) {
                  let rawResult = stepData.result || 
                              stepData.openai_response || 
                              (stepData.result?.openai_response) ||
                              (typeof stepData === 'object' && !stepData.result && !stepData.openai_response ? stepData : null);
                  
                  // CRITICAL: Unwrap structured result if needed (wrapped in { value: ..., namespace: ... })
                  if (rawResult && typeof rawResult === 'object' && 'value' in rawResult && 'namespace' in rawResult) {
                    stepResultForSave = rawResult.value;
                  } else {
                    stepResultForSave = rawResult;
                  }
                  
                  if (stepResultForSave) {
                    console.log(`✅ [WHILE-LOOP-ITERATION-${iteration}] Found stepResultForSave by variant "${variant}"`);
                    break;
                  }
                }
              }
            }
          }
          
          if (!stepResultForSave) {
            const determineData = workflowState.determine_completion || 
                                 workflowState.results?.determine_completion ||
                                 {};
            let rawResult = determineData.result || 
                        determineData.openai_response || 
                        (determineData.result?.openai_response) ||
                        determineData ||
                        {};
            
            // CRITICAL: Unwrap structured result if needed (wrapped in { value: ..., namespace: ... })
            if (rawResult && typeof rawResult === 'object' && 'value' in rawResult && 'namespace' in rawResult) {
              stepResultForSave = rawResult.value;
            } else {
              stepResultForSave = rawResult;
            }
            
            if (stepResultForSave && Object.keys(stepResultForSave).length > 0) {
              console.log(`✅ [WHILE-LOOP-ITERATION-${iteration}] Found stepResultForSave from determine_completion fallback`);
            }
          }
          
          console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] DEBUG: stepResultForSave extracted:`, {
            exists: !!stepResultForSave,
            type: stepResultForSave ? typeof stepResultForSave : 'null',
            keys: stepResultForSave && typeof stepResultForSave === 'object' ? Object.keys(stepResultForSave).join(', ') : 'N/A',
            hasStatus: !!(stepResultForSave?.status),
            hasReason: !!(stepResultForSave?.reason)
          });
          
          // Now save iteration (copy the save logic from line 10738+)
          const currentItem = workflowState.currentJourney || workflowState.currentItem || workflowState.currentLeg || {};
          const status = stepResultForSave.status || stepResultForSave.completion_status || 'unknown';
          const isSuccess = status === 'success';
          const isFailure = status === 'failure';
          
          const hasJourneysToExecute = workflowState.journeysToExecute && Array.isArray(workflowState.journeysToExecute) && workflowState.journeysToExecute.length > 0;
          const hasJourneys = workflowState.journeys && Array.isArray(workflowState.journeys) && workflowState.journeys.length > 0;
          const isJourneyContext = hasJourneysToExecute || hasJourneys;
          
          console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] DEBUG: hasJourneysToExecute=${hasJourneysToExecute}, hasJourneys=${hasJourneys}, isJourneyContext=${isJourneyContext}`);
          console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] DEBUG: journeysToExecute.length=${workflowState.journeysToExecute?.length || 0}, journeys.length=${workflowState.journeys?.length || 0}`);
          
          if (!workflowState.journeysToExecute && hasJourneys) {
            workflowState.journeysToExecute = workflowState.journeys;
            console.log(`🔧 [WHILE-LOOP-ITERATION-${iteration}] Set journeysToExecute from journeys (${workflowState.journeys.length} journey(s))`);
          }
          
          if (isJourneyContext) {
            console.log(`✅ [WHILE-LOOP-ITERATION-${iteration}] isJourneyContext is TRUE - saving iteration BEFORE condition check`);
            const journeyId = currentItem.journey_id || currentItem.id;
            let journey = null;
            let journeyIndex = workflowState.journeysToExecute.findIndex(j => 
              (j.journey_id === journeyId) || (j.id === journeyId) ||
              (j.journey_id === currentItem.journey_id) || (j.id === currentItem.id)
            );
            
            if (journeyIndex >= 0) {
              journey = workflowState.journeysToExecute[journeyIndex];
            } else if (currentItem && (currentItem.journey_id || currentItem.actions)) {
              journey = currentItem;
              journeyIndex = workflowState.journeysToExecute.findIndex(j => j === currentItem);
              if (journeyIndex < 0) {
                workflowState.journeysToExecute.push(currentItem);
                journeyIndex = workflowState.journeysToExecute.length - 1;
              }
            }
            
            if (journey) {
              console.log(`✅ [WHILE-LOOP-ITERATION-${iteration}] Found journey ${journeyId} in journeysToExecute`);
              if (!Array.isArray(journey.iterations)) {
                journey.iterations = [];
              }
              
              // Extract justification data from justify_journey step result
              // CRITICAL: Get the actual justify_journey step result from workflowState
              let justificationReason = '';
              let justificationStatus = status;
              let expectedOutcomeVerified = undefined;
              let verificationDetails = null;
              
              // Find justify_journey step result - try multiple sources including stepResultForSave
              const justifyStepId = 'justify_journey';
              const justifyStepSlug = 'justify-journey';
              
              // CRITICAL: stepResultForSave is already extracted above (line 10357-10378) and contains the justify_journey result
              // Use it FIRST, then check other sources
              let justifyStepData = stepResultForSave ||
                                   workflowState.variablePool?.steps?.[justifyStepSlug] ||
                                   workflowState[justifyStepSlug] ||
                                   workflowState[justifyStepId] ||
                                   workflowState.results?.[justifyStepId] ||
                                   workflowState.currentStepResult ||
                                   workflowState.lastExecutionResult?.step_result ||
                                   null;
              
              console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] DEBUG (PATH-1): justifyStepData sources:`, {
                stepResultForSave: !!stepResultForSave,
                currentStepResult: !!workflowState.currentStepResult,
                lastExecutionResult_step_result: !!workflowState.lastExecutionResult?.step_result,
                variablePool_steps: !!workflowState.variablePool?.steps?.[justifyStepSlug],
                workflowState_justifyStepId: !!workflowState[justifyStepId],
                workflowState_results: !!workflowState.results?.[justifyStepId],
                workflowState_justifyStepSlug: !!workflowState[justifyStepSlug],
                finalJustifyStepData: !!justifyStepData,
                isStructured: justifyStepData && typeof justifyStepData === 'object' && 'value' in justifyStepData && 'namespace' in justifyStepData
              });
              
              if (justifyStepData) {
                // CRITICAL: stepResultForSave is already unwrapped, so it might be the final result directly
                // If it's structured, unwrap it; otherwise use it directly
                let unwrappedJustifyData = justifyStepData;
                if (justifyStepData && typeof justifyStepData === 'object' && 'value' in justifyStepData && 'namespace' in justifyStepData) {
                  console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] DEBUG (PATH-1): Unwrapping structured justifyStepData`);
                  unwrappedJustifyData = justifyStepData.value;
                }
                
                // CRITICAL: stepResultForSave is already the result from stepData.result, so it might be the final AI response
                // Check if it already has reason/status (it's the final result), or if it needs further unwrapping
                let justifyResult = null;
                if (unwrappedJustifyData && typeof unwrappedJustifyData === 'object') {
                  // If it has reason/status directly, it's the final result
                  if ('reason' in unwrappedJustifyData || 'status' in unwrappedJustifyData || 'expected_outcome_verified' in unwrappedJustifyData) {
                    justifyResult = unwrappedJustifyData;
                  } else {
                    // Otherwise, try to get it from nested result/openai_response
                    justifyResult = unwrappedJustifyData?.result || 
                                   unwrappedJustifyData?.openai_response || 
                                   (unwrappedJustifyData?.result?.openai_response) ||
                                   unwrappedJustifyData;
                  }
                } else {
                  justifyResult = unwrappedJustifyData;
                }
                
                console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] DEBUG (PATH-1): justifyResult:`, {
                  exists: !!justifyResult,
                  type: justifyResult ? typeof justifyResult : 'null',
                  keys: justifyResult && typeof justifyResult === 'object' ? Object.keys(justifyResult).join(', ') : 'N/A',
                  hasReason: !!(justifyResult?.reason),
                  reasonType: justifyResult?.reason ? typeof justifyResult.reason : 'N/A',
                  reasonValue: justifyResult?.reason ? (typeof justifyResult.reason === 'string' ? justifyResult.reason.substring(0, 100) : JSON.stringify(justifyResult.reason).substring(0, 100)) : 'N/A',
                  hasVerificationDetails: !!(justifyResult?.verification_details),
                  hasAiJustification: !!(justifyResult?.ai_justification),
                  hasStatus: !!(justifyResult?.status),
                  fullJustifyResult: JSON.stringify(justifyResult).substring(0, 500)
                });
                
                // CRITICAL: Extract reason/justification - handle structured format { value: ..., namespace: ... }
                // The result is structured: { reason: { value: "text", namespace: "step" }, status: { value: "pending", namespace: "step" }, ... }
                const extractValue = (obj) => {
                  if (!obj) return null;
                  if (typeof obj === 'string') return obj;
                  if (typeof obj === 'object' && 'value' in obj) return obj.value;
                  return obj.toString ? obj.toString() : JSON.stringify(obj);
                };
                
                // Try reason first (primary source)
                if (justifyResult?.reason) {
                  justificationReason = extractValue(justifyResult.reason);
                } else if (justifyResult?.verification_details) {
                  justificationReason = extractValue(justifyResult.verification_details);
                } else if (justifyResult?.ai_justification) {
                  justificationReason = extractValue(justifyResult.ai_justification);
                } else if (unwrappedJustifyData?.reason) {
                  justificationReason = extractValue(unwrappedJustifyData.reason);
                } else if (unwrappedJustifyData?.verification_details) {
                  justificationReason = extractValue(unwrappedJustifyData.verification_details);
                }
                
                // Extract status - handle structured format
                const statusValue = extractValue(justifyResult?.status) || extractValue(justifyResult?.completion_status) || 
                                   extractValue(unwrappedJustifyData?.status) || extractValue(unwrappedJustifyData?.completion_status) ||
                                   status;
                justificationStatus = typeof statusValue === 'string' ? statusValue : (statusValue?.toString ? statusValue.toString() : status);
                
                // Extract expected_outcome_verified - handle structured format
                const expectedOutcomeValue = extractValue(justifyResult?.expected_outcome_verified) || 
                                           extractValue(unwrappedJustifyData?.expected_outcome_verified);
                expectedOutcomeVerified = expectedOutcomeValue !== null && expectedOutcomeValue !== undefined ? 
                                         (typeof expectedOutcomeValue === 'boolean' ? expectedOutcomeValue : expectedOutcomeValue === 'true' || expectedOutcomeValue === true) : 
                                         undefined;
                
                // Extract verification_details - handle structured format
                verificationDetails = extractValue(justifyResult?.verification_details) || extractValue(unwrappedJustifyData?.verification_details) || null;
                
                console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] DEBUG (PATH-1): Extracted:`, {
                  justificationReason: justificationReason ? `${justificationReason.length} chars` : 'EMPTY',
                  justificationStatus: justificationStatus || 'N/A',
                  expectedOutcomeVerified: expectedOutcomeVerified !== undefined ? expectedOutcomeVerified : 'undefined'
                });
              }
              
              // Map status based on expected_outcome_verified (primary source)
              let finalJustificationStatus = justificationStatus;
              if (justificationStatus === 'pending') {
                finalJustificationStatus = 'pending';
              } else if (expectedOutcomeVerified === true) {
                finalJustificationStatus = 'success';
              } else if (expectedOutcomeVerified === false) {
                finalJustificationStatus = 'failure';
              }

              // CRITICAL: Ensure justify_journey status reflects final status so while-loop condition can exit
              const justifyStepKeys = ['justify-journey', 'justify_journey', 'justifyJourney'];
              for (const key of justifyStepKeys) {
                const stepResult = workflowState.variablePool?.steps?.[key]?.result;
                if (stepResult && typeof stepResult === 'object') {
                  stepResult.status = finalJustificationStatus;
                }
                const resultContainer = workflowState.results?.[key];
                if (resultContainer?.result && typeof resultContainer.result === 'object') {
                  resultContainer.result.status = finalJustificationStatus;
                }
                const directStep = workflowState[key];
                if (directStep?.result && typeof directStep.result === 'object') {
                  directStep.result.status = finalJustificationStatus;
                }
              }
              
              // Update journey with justification data
              journey.justification_status = finalJustificationStatus;
              journey.ai_justification = justificationReason;
              if (expectedOutcomeVerified !== undefined) {
                journey.expected_outcome_verified = expectedOutcomeVerified;
              }
              if (verificationDetails) {
                journey.verification_details = verificationDetails;
              }
              
              console.log(`✅ [WHILE-LOOP-ITERATION-${iteration}] Extracted justification: status=${finalJustificationStatus}, reason=${justificationReason ? justificationReason.substring(0, 100) + '...' : 'N/A'}`);
              
              // CRITICAL: Extract actions for THIS iteration ONLY (one group per step/page)
              // Actions should come from the executed script for this iteration, NOT from journey.actions (which contains all actions)
              let iterationActions = [];
              
              // Get the executed script for this iteration
              const executedScript = workflowState.legScriptToExecute || workflowState.journeyScriptToExecute || '';
              const executedActionLines = Array.isArray(workflowState.lastExecutedActionLines)
                ? workflowState.lastExecutedActionLines
                : [];
              
              if (executedActionLines.length > 0) {
                const parsedActions = this.parseScriptActions(executedActionLines.join('\n'));
                iterationActions = parsedActions.map((actionLine, idx) => ({
                  type: 'script_action',
                  description: actionLine,
                  action: actionLine,
                  selector: null,
                  order: idx + 1,
                  iteration_number: iteration
                }));
                console.log(`🎯 [WHILE-LOOP-ITERATION-${iteration}] Collected ${iterationActions.length} executed action(s) from wrapper for this iteration`);
              } else if (executedScript && typeof executedScript === 'string' && executedScript.trim().length > 0) {
                // Parse actions from the executed script for this iteration
                // This ensures each iteration only has actions from its own step/page
                try {
                  const parsedActions = this.parseScriptActions(executedScript);
                  iterationActions = parsedActions.map((actionLine, idx) => ({
                    type: 'script_action',
                    description: actionLine,
                    action: actionLine,
                    selector: null,
                    order: idx + 1,
                    iteration_number: iteration
                  }));
                  console.log(`🎯 [WHILE-LOOP-ITERATION-${iteration}] Parsed ${iterationActions.length} action(s) from executed script for this iteration`);
                } catch (parseError) {
                  console.warn(`⚠️ [WHILE-LOOP-ITERATION-${iteration}] Failed to parse actions from script: ${parseError.message}`);
                }
              } else {
                console.warn(`⚠️ [WHILE-LOOP-ITERATION-${iteration}] No executed script found for this iteration`);
              }
              
              console.log(`🎯 [WHILE-LOOP-ITERATION-${iteration}] Collected ${iterationActions.length} action(s) for iteration ${iteration} (one group per step/page)`);
              
              // Get the script from generate_journey_script step result (if not already found)
              // The script is stored in workflowState[step.id].result.playwright_script or workflowState.variablePool.steps[slug].result.playwright_script
              if (!executedScript || executedScript.trim().length === 0) {
                const generateScriptStepId = 'generate_journey_script';
                const generateScriptSlug = 'generate-journey-script';
                
                // Try to get script from step result
                const scriptStepData = workflowState.variablePool?.steps?.[generateScriptSlug] ||
                                      workflowState[generateScriptStepId] ||
                                      workflowState.results?.[generateScriptStepId] ||
                                      workflowState.variablePool?.steps?.[generateScriptStepId] ||
                                      null;
                
                if (scriptStepData) {
                  const scriptResult = scriptStepData.result || scriptStepData;
                  if (scriptResult?.playwright_script) {
                    executedScript = scriptResult.playwright_script;
                    console.log(`✅ [WHILE-LOOP-ITERATION-${iteration}] Found playwright_script from generate_journey_script step: ${executedScript.length} chars`);
                  }
                }
              }
              
              // Capture page details for this iteration
              let pageTitleBefore = '';
              let pageTitleAfter = '';
              let pageUrlBefore = workflowState.urlBeforeAction || '';
              let pageUrlAfter = '';
              
              try {
                pageUrlAfter = page.url();
                pageTitleAfter = await page.title();
              } catch (pageError) {
                console.warn(`⚠️ [WHILE-LOOP-ITERATION-${iteration}] Could not get page URL/title: ${pageError.message}`);
              }
              
              // Get page title before from workflowState if available
              if (workflowState.titleBeforeAction) {
                pageTitleBefore = workflowState.titleBeforeAction;
              } else {
                // Try to get from lastExecutionResult
                pageTitleBefore = workflowState.lastExecutionResult?.page_title_before || '';
              }
              
              // Get steps executed in this iteration (from nested steps that were just executed)
              const stepsExecuted = [];
              
              // Collect all nested steps that were executed in this iteration
              // Steps are stored by storeStepResult in: workflowState[step.id], workflowState.results[step.id], workflowState.variablePool.steps[slug]
              for (let nestedIdx = 0; nestedIdx < nestedSteps.length; nestedIdx++) {
                const nestedStep = nestedSteps[nestedIdx];
                const stepId = nestedStep.id;
                const stepSlug = nestedStep.slug || this.generateSlug(nestedStep.name || 'step');
                
                // Try to get step result from multiple locations
                let stepResult = null;
                const stepData = workflowState.variablePool?.steps?.[stepSlug] ||
                                workflowState[stepId] ||
                                workflowState.results?.[stepId] ||
                                workflowState[stepSlug] ||
                                null;
                
                if (stepData) {
                  stepResult = stepData.result || 
                              stepData.openai_response || 
                              (stepData.result?.openai_response) ||
                              (typeof stepData === 'object' && !stepData.result && !stepData.openai_response ? stepData : null);
                }
                
                // Only add step if we have a result
                if (stepResult) {
                  stepsExecuted.push({
                    step_id: stepId,
                    step_name: nestedStep.name || stepId,
                    step_type: nestedStep.type || 'unknown',
                    step_index: nestedIdx,
                    result: stepResult
                  });
                }
              }
              
              console.log(`📋 [WHILE-LOOP-ITERATION-${iteration}] Collected ${stepsExecuted.length} step(s) for iteration: ${stepsExecuted.map(s => s.step_id).join(', ')}`);

              const screenshotBefore = unwrapStructuredValue(
                workflowState[`screenshot_before`]?.result?.screenshot_file_id ||
                workflowState[`screenshot-before-action`]?.result?.screenshot_file_id ||
                null
              );
              const screenshotAfter = unwrapStructuredValue(
                workflowState[`screenshot_after`]?.result?.screenshot_file_id ||
                workflowState[`screenshot-after-action`]?.result?.screenshot_file_id ||
                null
              );

              const iterationData = {
                iteration_number: iteration,
                attempt_number: iteration,
                result: isSuccess ? 'success' : (isFailure ? 'failure' : 'in_progress'),
                status: status,
                completion_status: finalJustificationStatus || status,
                is_complete: isSuccess || isFailure,
                reason: justificationReason,
                error: isFailure ? (justificationReason || 'Journey execution failed') : null,
                timestamp: new Date().toISOString(),
                
                // Page details for this iteration
                page: {
                  url_before: pageUrlBefore,
                  url_after: pageUrlAfter,
                  title_before: pageTitleBefore,
                  title_after: pageTitleAfter,
                  url_changed: pageUrlBefore !== pageUrlAfter,
                  title_changed: pageTitleBefore !== pageTitleAfter
                },
                
                // Screenshots for this iteration
                screenshots: {
                  before: screenshotBefore,
                  after: screenshotAfter
                },
                
                // Script executed in this iteration
                script: {
                  executed: executedScript,
                  length: executedScript.length
                },
                
                // Actions executed in this iteration
                actions: iterationActions,
                actions_count: iterationActions.length,
                
                // Steps executed in this iteration
                steps: stepsExecuted,
                steps_count: stepsExecuted.length,
                
                // Execution result
                execution_result: workflowState.lastExecutionResult || {},
                
                // Additional details
                details: {
                  justification_status: finalJustificationStatus,
                  expected_outcome_verified: expectedOutcomeVerified,
                  verification_details: verificationDetails,
                  ai_justification: justificationReason
                },
                
                // Backward compatibility fields (for existing code that expects flat structure)
                script_executed: executedScript,
                page_url_before: pageUrlBefore,
                page_url_after: pageUrlAfter,
                screenshot_before: screenshotBefore,
                screenshot_after: screenshotAfter
              };
              
              const existingIterationIndex = journey.iterations.findIndex(iter => iter.iteration_number === iteration);
              const isNewIteration = existingIterationIndex < 0;
              
              console.log(`💾 [WHILE-LOOP-ITERATION-${iteration}] Adding iteration data: iteration_number=${iterationData.iteration_number}, status=${iterationData.status}, actions_count=${iterationData.actions?.length || 0}`);
              
              if (existingIterationIndex >= 0) {
                journey.iterations[existingIterationIndex] = iterationData;
                console.log(`💾 [WHILE-LOOP-ITERATION-${iteration}] Updated existing iteration at index ${existingIterationIndex}`);
              } else {
                journey.iterations.push(iterationData);
                console.log(`💾 [WHILE-LOOP-ITERATION-${iteration}] Added new iteration. Journey now has ${journey.iterations.length} iteration(s)`);
              }
              
              // Update journey group when new iteration is discovered
              if (isNewIteration) {
                const totalIterations = journey.iterations.length;
                if (totalIterations > 1) {
                  journey.group = `Multi-step journey (${totalIterations} steps)`;
                } else if (totalIterations === 1) {
                  journey.group = 'Single-step journey';
                }
              }
              
              // Save immediately
              if (workflowState.workflowId) {
                try {
                  // CRITICAL: Ensure journey has all justification fields before saving
                  const journeyToSave = {
                    ...journey,
                    ai_justification: journey.ai_justification || null,
                    justification_status: journey.justification_status || null,
                    expected_outcome_verified: journey.expected_outcome_verified !== undefined ? journey.expected_outcome_verified : undefined,
                    verification_details: journey.verification_details || null
                  };
                  
                  const payload = {
                    saveLegs: false,
                    journeys: [journeyToSave],
                    job_id: jobId
                  };
                  console.log(`💾 [WHILE-LOOP-ITERATION-${iteration}] Saving journey ${journeyId} with ${journey.iterations.length} iteration(s) BEFORE condition check`);
                  console.log(`💾 [WHILE-LOOP-ITERATION-${iteration}] DEBUG: Journey being saved has ai_justification: ${journeyToSave.ai_justification ? `YES (${journeyToSave.ai_justification.length} chars)` : 'NO'}, justification_status: ${journeyToSave.justification_status || 'N/A'}`);
                  console.log(`💾 [WHILE-LOOP-ITERATION-${iteration}] DEBUG: Journey payload keys: ${Object.keys(journeyToSave).join(', ')}`);
                  await axios.post(
                    `${this.backendUrl}/api/pages/${workflowState.pageId}/save-analysis`,
                    payload,
                    { headers: this.getAuthHeaders() }
                  );
                  console.log(`💾 [WHILE-LOOP-ITERATION-${iteration}] ✅ Successfully saved iteration ${iteration} for journey ${journeyId} BEFORE condition check`);
                } catch (saveError) {
                  console.error(`❌ [WHILE-LOOP-ITERATION-${iteration}] Failed to save iteration: ${saveError.message}`);
                }
              }
            } else {
              console.warn(`⚠️ [WHILE-LOOP-ITERATION-${iteration}] Journey not found in journeysToExecute. journeyId=${journeyId}`);
            }
          } else {
            console.warn(`⚠️ [WHILE-LOOP-ITERATION-${iteration}] isJourneyContext is FALSE - skipping iteration save`);
            console.warn(`⚠️ [WHILE-LOOP-ITERATION-${iteration}] DEBUG: journeysToExecute=${!!workflowState.journeysToExecute}, isArray=${Array.isArray(workflowState.journeysToExecute)}, length=${workflowState.journeysToExecute?.length || 0}`);
            console.warn(`⚠️ [WHILE-LOOP-ITERATION-${iteration}] DEBUG: journeys=${!!workflowState.journeys}, isArray=${Array.isArray(workflowState.journeys)}, length=${workflowState.journeys?.length || 0}`);
            console.warn(`⚠️ [WHILE-LOOP-ITERATION-${iteration}] DEBUG: currentItem=${!!currentItem}, currentItem.journey_id=${currentItem.journey_id || 'N/A'}`);
          }
        } catch (saveIterError) {
          console.error(`❌ [WHILE-LOOP-ITERATION-${iteration}] Error saving iteration: ${saveIterError.message}`);
          console.error(`❌ [WHILE-LOOP-ITERATION-${iteration}] Error stack:`, saveIterError.stack);
        }
        
        // Evaluate condition after nested steps
        let conditionValue = undefined;
        if (conditionType === 'code' && config.conditionCode) {
          // Clean the code before execution
          let cleanedCode = this.cleanScript(config.conditionCode);
          if (!cleanedCode || cleanedCode.trim().length === 0) {
            throw new Error('Condition code is empty after cleaning');
          }
          // Execute code to get condition
          const conditionResult = await page.evaluate(
            ({ code, workflowState }) => {
              const runner = new Function('workflowState', `return (${code});`);
              return runner(workflowState);
            },
            { code: cleanedCode, workflowState }
          );
          condition = conditionResult === true || conditionResult === 'true' || conditionResult === 1;
          
        } else if (conditionType === 'ai-response' || conditionType === 'path') {
          // Get condition from workflowState path (check multiple locations)
          // Try multiple path variants: with hyphen, with underscore, with slug
          const pathVariants = [];
          
          // CRITICAL: Validate conditionPath is provided
          if (!conditionPath) {
            const errorMessage = `Missing required field "conditionPath" in while-loop step "${step.name || step.id}"`;
            const missingPath = 'step.config.conditionPath';
            const fullContext = {
              step_id: step.id,
              step_name: step.name,
              step_type: step.type,
              step_config: step.config,
              missing_field: 'conditionPath',
              missing_path: missingPath,
              full_step: step
            };
            console.error(`❌ ${errorMessage}`);
            console.error(`❌ Missing JSON path: ${missingPath}`);
            console.error(`❌ Full step:`, JSON.stringify(step, null, 2));
            console.error(`❌ Full step context:`, JSON.stringify(fullContext, null, 2));
            if (jobId && this.backendLogger) {
              await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', fullContext);
            }
            throw new Error(`${errorMessage}\nMissing JSON path: ${missingPath}\nFull step: ${JSON.stringify(step, null, 2)}\nFull context: ${JSON.stringify(fullContext, null, 2)}`);
          }
          
          if (conditionPath) {
            // Original path
            pathVariants.push(conditionPath);
            // Try with hyphen replaced by underscore
            if (conditionPath.includes('-')) {
              pathVariants.push(conditionPath.replace(/-/g, '_'));
            }
            // Try with underscore replaced by hyphen
            if (conditionPath.includes('_')) {
              pathVariants.push(conditionPath.replace(/_/g, '-'));
            }
            
            // Try each variant in multiple locations
            for (const variant of pathVariants) {
              // Try in results namespace
              conditionValue = this.resolvePathValue(workflowState, variant, 'results');
              if (conditionValue !== undefined && conditionValue !== null) {
                console.log(`✅ Found condition value via path "${variant}" in results: ${conditionValue}`);
                break;
              }
              
              // Try in variablePool.steps namespace
              if (workflowState.variablePool?.steps) {
                const [stepId, ...restPath] = variant.split('.');
                const stepResult = workflowState.variablePool.steps[stepId]?.result;
                if (stepResult) {
                  let current = stepResult;
                  for (const segment of restPath) {
                    if (current && typeof current === 'object') {
                      current = current[segment];
                    } else {
                      current = undefined;
                      break;
                    }
                  }
                  if (current !== undefined) {
                    conditionValue = current;
                    console.log(`✅ Found condition value via path "${variant}" in variablePool.steps: ${conditionValue}`);
                    break;
                  }
                }
              }
              
              // Try direct access on workflowState
              const [stepId, ...restPath] = variant.split('.');
              const stepData = workflowState[stepId];
              if (stepData?.result) {
                let current = stepData.result;
                for (const segment of restPath) {
                  if (current && typeof current === 'object') {
                    current = current[segment];
                  } else {
                    current = undefined;
                    break;
                  }
                }
                if (current !== undefined) {
                  conditionValue = current;
                  console.log(`✅ Found condition value via path "${variant}" in workflowState: ${conditionValue}`);
                  break;
                }
              }
            }
          }
          
          // CRITICAL: Also try to find justify_journey step result (for simplified workflow)
          if (conditionValue === undefined || conditionValue === null && conditionPath && conditionPath.includes('justify_journey')) {
            const justifyStepId = 'justify_journey';
            const justifyStepSlug = 'justify-journey';
            const stepIdVariants = [justifyStepId, justifyStepSlug, justifyStepId.replace(/_/g, '-'), justifyStepSlug.replace(/-/g, '_')];
            
            for (const variant of stepIdVariants) {
              const stepData = workflowState.variablePool?.steps?.[variant] ||
                              workflowState[variant] ||
                              workflowState.results?.[variant] ||
                              null;
              
              if (stepData) {
                let rawResult = stepData.result || 
                            stepData.openai_response || 
                            (stepData.result?.openai_response) ||
                            (typeof stepData === 'object' && !stepData.result && !stepData.openai_response ? stepData : null);
                
                // Unwrap structured result if needed
                if (rawResult && typeof rawResult === 'object' && 'value' in rawResult && 'namespace' in rawResult) {
                  rawResult = rawResult.value;
                }
                
                if (rawResult && typeof rawResult === 'object') {
                  // Extract status from justify_journey result
                  const pathSegments = conditionPath.split('.');
                  if (pathSegments.length > 1 && pathSegments[1] === 'status') {
                    conditionValue = rawResult.status || rawResult.completion_status;
                    if (conditionValue !== undefined) {
                      console.log(`✅ Found justify_journey.status via variant "${variant}": ${conditionValue}`);
                      break;
                    }
                  }
                }
              }
            }
          }
          
          // If still not found, try finding the determine_completion or justify_journey step result directly
          if (conditionValue === undefined || conditionValue === null) {
            // CRITICAL: Check workflowState.determine_completion or justify_journey first (stored after nested step execution)
            let determineStepResult = null;
            
            // Check for justify_journey first (for simplified workflow)
            if (conditionPath && conditionPath.includes('justify_journey') && workflowState.justify_journey?.result) {
              determineStepResult = workflowState.justify_journey.result;
              console.log(`✅ Found justify_journey result from workflowState.justify_journey`);
            } else if (workflowState.determine_completion?.result) {
              determineStepResult = workflowState.determine_completion.result;
              console.log(`✅ Found determine_completion result from workflowState.determine_completion`);
            } else {
              // Try multiple step ID variants
              const stepIdVariants = ['determine-completion', 'determine_completion', 'determineCompletion'];
              
              for (const stepId of stepIdVariants) {
                determineStepResult = workflowState[stepId]?.result || 
                                     workflowState.results?.[stepId]?.result ||
                                     workflowState.variablePool?.steps?.[stepId]?.result ||
                                     null;
                if (determineStepResult) {
                  console.log(`✅ Found determine_completion result via stepId "${stepId}"`);
                  break;
                }
              }
              
              // Also check nested step IDs (for-each may create IDs like "test_leg_iteratively::0::determine_completion")
              if (!determineStepResult && workflowState.variablePool?.steps) {
                for (const [stepKey, stepData] of Object.entries(workflowState.variablePool.steps)) {
                  if (stepKey.includes('determine') && (stepKey.includes('completion') || stepKey.includes('complete'))) {
                    determineStepResult = stepData?.result;
                    if (determineStepResult) {
                      console.log(`✅ Found determine_completion result via nested step key "${stepKey}"`);
                      break;
                    }
                  }
                }
              }
              
              // Also check workflowState.results for nested step results
              if (!determineStepResult && workflowState.results) {
                for (const [stepKey, stepResult] of Object.entries(workflowState.results)) {
                  if (stepKey.includes('determine') && (stepKey.includes('completion') || stepKey.includes('complete'))) {
                    determineStepResult = stepResult?.result || stepResult;
                    if (determineStepResult) {
                      console.log(`✅ Found determine_completion result via results key "${stepKey}"`);
                      break;
                    }
                  }
                }
              }
              
              // CRITICAL: Also try to resolve the conditionPath directly using resolvePathValue
              // This handles nested paths like "execute_workflow_legs::0::determine_completion.status"
              if (!determineStepResult && conditionPath) {
                try {
                  const resolvedValue = this.resolvePathValue(workflowState, conditionPath, 'results');
                  if (resolvedValue !== undefined && resolvedValue !== null) {
                    // If we got a value, extract the determine_completion result from the path
                    // For path like "execute_workflow_legs::0::determine_completion.status", 
                    // we need to get "execute_workflow_legs::0::determine_completion" result
                    const pathParts = conditionPath.split('.');
                    if (pathParts.length > 1) {
                      const stepPath = pathParts.slice(0, -1).join('.'); // Remove last part (status)
                      const stepResult = this.resolvePathValue(workflowState, stepPath, 'results');
                      if (stepResult && typeof stepResult === 'object') {
                        determineStepResult = stepResult;
                        console.log(`✅ Found determine_completion result via resolvePathValue for path "${stepPath}"`);
                      }
                    }
                  }
                } catch (error) {
                  console.warn(`⚠️ Error resolving path "${conditionPath}":`, error.message);
                }
              }
              
              // Fallback to lastExecutionResult
              if (!determineStepResult) {
                determineStepResult = workflowState.lastExecutionResult || {};
              }
            }
            
            // Extract condition from step result
            if (conditionPath && determineStepResult) {
              const pathSegments = conditionPath.split('.');
              // CRITICAL: If path starts with "determine_completion", skip the first segment and use determineStepResult directly
              // This handles paths like "determine_completion.status" where determineStepResult IS the determine_completion result
              let pathToResolve = conditionPath;
              if (pathSegments[0] === 'determine_completion' || pathSegments[0] === 'determine-completion') {
                // Skip the first segment and resolve the rest from determineStepResult
                pathToResolve = pathSegments.slice(1).join('.');
              }
              
              let current = determineStepResult;
              console.log(`🔍 Extracting condition from path "${conditionPath}" (resolved to "${pathToResolve}" from determineStepResult)`);
              console.log(`🔍 determineStepResult keys: ${Object.keys(determineStepResult || {}).join(', ')}`);
              
              if (pathToResolve) {
                const remainingSegments = pathToResolve.split('.');
                for (const segment of remainingSegments) {
                  if (current && typeof current === 'object') {
                    console.log(`🔍 Accessing segment "${segment}" from:`, Object.keys(current || {}).join(', '));
                    current = current[segment];
                  } else {
                    console.log(`⚠️ Cannot access segment "${segment}" - current is:`, typeof current);
                    current = undefined;
                    break;
                  }
                }
              }
              conditionValue = current;
              if (conditionValue !== undefined) {
                console.log(`✅ Extracted condition value from determineStepResult via path "${conditionPath}": ${conditionValue}`);
              } else {
                console.log(`⚠️ Path "${conditionPath}" not found in determineStepResult`);
                console.log(`🔍 Full determineStepResult:`, JSON.stringify(determineStepResult, null, 2).substring(0, 500));
              }
            } else if (determineStepResult) {
              // Default: check status, fallback to is_complete
              console.log(`🔍 No conditionPath specified, using default: check status or is_complete`);
              conditionValue = determineStepResult.status || determineStepResult.completion_status || determineStepResult.is_complete;
              if (conditionValue !== undefined) {
                console.log(`✅ Found default condition value from determineStepResult: ${conditionValue}`);
              } else {
                console.log(`⚠️ No status or is_complete found in determineStepResult`);
                console.log(`🔍 determineStepResult keys: ${Object.keys(determineStepResult || {}).join(', ')}`);
              }
            }
          }
          
          // Log what we found (or didn't find) with detailed debugging
          if (conditionValue === undefined || conditionValue === null) {
            console.log(`⚠️ Condition value not found for path "${conditionPath}"`);
            console.log(`⚠️ Available step results: ${Object.keys(workflowState.results || {}).join(', ') || 'none'}`);
            console.log(`⚠️ Available in workflowState: ${Object.keys(workflowState).filter(k => k.includes('determine')).join(', ') || 'none'}`);
            if (workflowState.variablePool?.steps) {
              console.log(`⚠️ Available in variablePool.steps: ${Object.keys(workflowState.variablePool.steps).filter(k => k.includes('determine')).join(', ') || 'none'}`);
            }
            if (workflowState.determine_completion) {
              console.log(`🔍 workflowState.determine_completion structure:`, JSON.stringify({
                hasResult: !!workflowState.determine_completion.result,
                resultKeys: workflowState.determine_completion.result ? Object.keys(workflowState.determine_completion.result) : [],
                status: workflowState.determine_completion.result?.status,
                completion_status: workflowState.determine_completion.result?.completion_status,
                is_complete: workflowState.determine_completion.result?.is_complete
              }, null, 2));
            }
            
            // Send detailed log to backend
            await this.sendLogToBackend(jobId, 'warn', 
              `⚠️ Condition path "${conditionPath}" not found. Available: ${Object.keys(workflowState.results || {}).join(', ') || 'none'}`, 
              'WORKFLOW-ANALYZER', {
                step_id: step.id,
                condition_path: conditionPath,
                available_results: Object.keys(workflowState.results || {}),
                determine_completion_keys: workflowState.determine_completion?.result ? Object.keys(workflowState.determine_completion.result) : [],
                iteration: iteration
              }
            );
          }
          
          if (conditionValue !== undefined && conditionValue !== null) {
            // Support both new status field (success/failure/continue/stuck) and legacy is_complete
            if (typeof conditionValue === 'string') {
              // New format: status field with 'success', 'failure', 'continue', 'stuck', 'pending'
              const expectedValue = config.conditionValue || 'pending';
              
              // CRITICAL: Check if this is a multistep wizard by looking at visible text or step result
              // Try multiple sources for step result
              let stepResult = workflowState.currentStepResult;
              if (!stepResult) {
                // Try justify_journey result from various locations
                stepResult = workflowState.justify_journey?.result || 
                            workflowState.variablePool?.steps?.['justify-journey']?.result ||
                            workflowState.variablePool?.steps?.['justify_journey']?.result ||
                            workflowState.results?.['justify-journey']?.result ||
                            workflowState.results?.['justify_journey']?.result ||
                            {};
              }
              
              const verificationDetails = stepResult.verification_details || stepResult.reason || '';
              const visibleText = workflowState.visibleText || '';
              const pageDescription = workflowState.pageDescription || '';
              
              // Detect if we're in a multistep wizard (look for step indicators in multiple places)
              const searchText = (verificationDetails + ' ' + visibleText + ' ' + pageDescription).toLowerCase();
              const hasStepIndicator = /step\s+\d+\s+of\s+\d+/i.test(searchText);
              
              // Also check if journey description mentions wizard or multistep
              const currentJourney = workflowState.currentJourney || workflowState.currentItem || {};
              const journeyDesc = (currentJourney.description || '').toLowerCase();
              const journeyId = (currentJourney.journey_id || '').toLowerCase();
              const pageUrl = (workflowState.pageUrl || '').toLowerCase();
              const isWizardJourney = journeyDesc.includes('wizard') || journeyDesc.includes('multi-step') || journeyDesc.includes('multistep') ||
                                     journeyId.includes('wizard') || pageUrl.includes('multi-step-wizard') || pageUrl.includes('multistep');
              
              // Log detection results
              console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] Condition evaluation:`, {
                conditionValue,
                hasStepIndicator,
                isWizardJourney,
                iteration,
                maxIterations: config.maxIterations || 5,
                pageUrl: workflowState.pageUrl,
                journeyId: currentJourney.journey_id
              });
              
              // If multistep wizard and status is "success", check if we're on final step
              if ((hasStepIndicator || isWizardJourney) && conditionValue === 'success') {
                // Extract step numbers from verification details or visible text
                const stepMatch = searchText.match(/step\s+(\d+)\s+of\s+(\d+)/i);
                if (stepMatch) {
                  const currentStep = parseInt(stepMatch[1]);
                  const totalSteps = parseInt(stepMatch[2]);
                  
                  if (currentStep < totalSteps) {
                    // Not on final step - force pending
                    console.log(`🔄 [WHILE-LOOP-ITERATION-${iteration}] Multistep wizard detected: Step ${currentStep} of ${totalSteps} - forcing 'pending' to continue`);
                    condition = true; // Continue loop
                    conditionValue = 'pending'; // Override status for logging
                  } else if (currentStep === totalSteps) {
                    // On final step - success is valid
                    condition = false; // Exit loop on success
                    console.log(`✅ [WHILE-LOOP-ITERATION-${iteration}] Multistep wizard: Final step (${currentStep} of ${totalSteps}) - EXITING loop`);
                  } else {
                    // Invalid step numbers - use original logic
                    condition = false;
                    console.log(`⚠️ [WHILE-LOOP-ITERATION-${iteration}] Invalid step numbers (${currentStep} > ${totalSteps}) - EXITING loop`);
                  }
                } else if (isWizardJourney && iteration < (config.maxIterations || 5)) {
                  // Wizard journey but can't determine step - if we're not at max iterations, continue
                  console.log(`🔄 [WHILE-LOOP-ITERATION-${iteration}] Wizard journey detected but step unclear - continuing (iteration ${iteration}/${config.maxIterations || 5})`);
                  condition = true; // Continue loop
                  conditionValue = 'pending'; // Override status for logging
                } else if (isWizardJourney && conditionValue === 'success' && iteration < (config.maxIterations || 5)) {
                  // Wizard journey, status is success but not at max iterations
                  // Check if we can determine if this is the final step
                  // If step indicator shows we're on final step, allow success
                  // Otherwise, continue to next iteration
                  const finalStepMatch = searchText.match(/step\s+(\d+)\s+of\s+(\d+)/i);
                  if (finalStepMatch) {
                    const currentStep = parseInt(finalStepMatch[1]);
                    const totalSteps = parseInt(finalStepMatch[2]);
                    if (currentStep === totalSteps) {
                      // This IS the final step - allow success
                      console.log(`✅ [WHILE-LOOP-ITERATION-${iteration}] Wizard journey: Final step (${currentStep} of ${totalSteps}) with success - EXITING loop`);
                      condition = false; // Exit loop
                    } else {
                      // Not final step - continue
                      console.log(`🔄 [WHILE-LOOP-ITERATION-${iteration}] Wizard journey: Step ${currentStep} of ${totalSteps} with success - continuing`);
                      condition = true; // Continue loop
                      conditionValue = 'pending'; // Override status for logging
                    }
                  } else {
                    // Can't determine step - if we're close to max iterations, allow success
                    // Otherwise continue
                    if (iteration >= (config.maxIterations || 5) - 1) {
                      console.log(`✅ [WHILE-LOOP-ITERATION-${iteration}] Wizard journey: Near max iterations with success - EXITING loop`);
                      condition = false; // Exit loop
                    } else {
                      console.log(`🔄 [WHILE-LOOP-ITERATION-${iteration}] Wizard journey: Status is 'success' but iteration ${iteration} < max ${config.maxIterations || 5} - continuing`);
                      condition = true; // Continue loop
                      conditionValue = 'pending'; // Override status for logging
                    }
                  }
                } else {
                  // Can't determine step and not clearly a wizard - use original logic
                  condition = false; // Exit loop on success
                  console.log(`✅ [WHILE-LOOP-ITERATION-${iteration}] Status is "success" - journey complete, EXITING loop (condition=false)`);
                }
              } else {
                // Not a multistep wizard or status is not success - use normal logic
                condition = conditionValue === expectedValue;
                
                if (conditionValue === 'success') {
                  // Success means journey is complete - exit loop
                  condition = false; // Exit loop on success
                  console.log(`✅ [WHILE-LOOP-ITERATION-${iteration}] Status is "success" - journey complete, EXITING loop (condition=false)`);
                } else if (conditionValue === 'pending') {
                  // Pending means more steps to complete - continue loop
                  condition = true; // Continue loop on pending
                  console.log(`🔄 [WHILE-LOOP-ITERATION-${iteration}] Status is "pending" - more steps to complete, CONTINUING loop (condition=true)`);
                } else {
                  console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] Checking status: ${conditionValue} === ${expectedValue} → ${condition} (will ${condition ? 'continue' : 'exit'})`);
                }
              }
            } else {
              // Legacy format: boolean is_complete
              condition = conditionValue === true || conditionValue === 'true' || conditionValue === 1 || conditionValue === 'complete';
            }
          } else {
            // If path not found and it's required, default to false (exit loop)
            if (conditionPath) {
              console.log(`⚠️ Condition path "${conditionPath}" not found, exiting loop`);
              
              // Send log to backend
              await this.sendLogToBackend(jobId, 'warn', `⚠️ Condition path "${conditionPath}" not found, exiting loop`, 'WORKFLOW-ANALYZER', {
                step_id: step.id,
                step_name: step.name || step.type,
                step_type: 'while-loop',
                condition_path: conditionPath,
                iteration: iteration
              });
              
              condition = invertCondition ? true : false;
            } else {
              // No condition path specified, default to false (exit loop)
              condition = false;
            }
          }
        }
        
        // Get the step result from the condition path (e.g., justify_journey.result for simplified workflow, determine_completion.result for legacy)
        let stepResult = null;
        if (conditionPath) {
          const pathSegments = conditionPath.split('.');
          const stepId = pathSegments[0]; // e.g., "justify_journey" or "determine_completion"
          
          // Try to get step result from multiple locations
          // Note: storeStepResult stores by slug (e.g., "justify-journey"), not just step ID
          const stepIdVariants = [stepId, stepId.replace(/-/g, '_'), stepId.replace(/_/g, '-')];
          const slug = 'justify-journey'; // From template slug
          const slugVariants = [slug, slug.replace(/-/g, '_')];
          
          // First try by slug (how storeStepResult stores it)
          for (const slugVariant of slugVariants) {
            // Check if result is nested in openai_response
            const stepData = workflowState.variablePool?.steps?.[slugVariant] ||
                           workflowState[slugVariant] ||
                           workflowState.results?.[slugVariant] ||
                           null;
            
            if (stepData) {
              // Try result directly, then openai_response, then result.openai_response
              let rawResult = stepData.result || 
                          stepData.openai_response || 
                          (stepData.result?.openai_response) ||
                          (typeof stepData === 'object' && !stepData.result && !stepData.openai_response ? stepData : null);
              
              // CRITICAL: Unwrap structured result if needed (wrapped in { value: ..., namespace: ... })
              if (rawResult && typeof rawResult === 'object' && 'value' in rawResult && 'namespace' in rawResult) {
                stepResult = rawResult.value;
              } else {
                stepResult = rawResult;
              }
              
              if (stepResult) {
                console.log(`✅ [WHILE-LOOP-ITERATION-${iteration}] Found step result by slug "${slugVariant}"`);
                console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] DEBUG: stepResult from slug:`, {
                  type: typeof stepResult,
                  isStructured: stepResult && typeof stepResult === 'object' && 'value' in stepResult && 'namespace' in stepResult,
                  keys: stepResult && typeof stepResult === 'object' ? Object.keys(stepResult).join(', ') : 'N/A'
                });
                break;
              }
            }
          }
          
          // Then try by step ID variants
          if (!stepResult) {
            for (const variant of stepIdVariants) {
              const stepData = workflowState[variant] ||
                              workflowState.results?.[variant] ||
                              workflowState.variablePool?.steps?.[variant] ||
                              null;
              
              if (stepData) {
                let rawResult = stepData.result || 
                            stepData.openai_response || 
                            (stepData.result?.openai_response) ||
                            (typeof stepData === 'object' && !stepData.result && !stepData.openai_response ? stepData : null);
                
                // CRITICAL: Unwrap structured result if needed (wrapped in { value: ..., namespace: ... })
                if (rawResult && typeof rawResult === 'object' && 'value' in rawResult && 'namespace' in rawResult) {
                  stepResult = rawResult.value;
                } else {
                  stepResult = rawResult;
                }
                
                if (stepResult) {
                  console.log(`✅ [WHILE-LOOP-ITERATION-${iteration}] Found step result by step ID variant "${variant}"`);
                  console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] DEBUG: stepResult from variant:`, {
                    type: typeof stepResult,
                    isStructured: stepResult && typeof stepResult === 'object' && 'value' in stepResult && 'namespace' in stepResult,
                    keys: stepResult && typeof stepResult === 'object' ? Object.keys(stepResult).join(', ') : 'N/A'
                  });
                  break;
                }
              }
            }
          }
          
          // Also check nested step IDs (for-each creates IDs like "execute_workflow_journeys::0::justify_journey")
          if (!stepResult && workflowState.variablePool?.steps) {
            for (const [stepKey, stepData] of Object.entries(workflowState.variablePool.steps)) {
              if (stepKey.includes(stepId.replace(/-/g, '_').replace(/_/g, '-')) || stepKey.includes(slug)) {
                let rawResult = stepData?.result || 
                            stepData?.openai_response || 
                            (stepData?.result?.openai_response) ||
                            null;
                
                // CRITICAL: Unwrap structured result if needed (wrapped in { value: ..., namespace: ... })
                if (rawResult && typeof rawResult === 'object' && 'value' in rawResult && 'namespace' in rawResult) {
                  stepResult = rawResult.value;
                } else {
                  stepResult = rawResult;
                }
                
                if (stepResult) {
                  console.log(`✅ [WHILE-LOOP-ITERATION-${iteration}] Found step result in nested step key "${stepKey}"`);
                  console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] DEBUG: stepResult from nested key:`, {
                    type: typeof stepResult,
                    isStructured: stepResult && typeof stepResult === 'object' && 'value' in stepResult && 'namespace' in stepResult,
                    keys: stepResult && typeof stepResult === 'object' ? Object.keys(stepResult).join(', ') : 'N/A'
                  });
                  break;
                }
              }
            }
          }
        }
        
        // Fallback to determine_completion for legacy workflows
        if (!stepResult) {
          const determineData = workflowState.determine_completion || 
                               workflowState.results?.determine_completion ||
                               {};
          stepResult = determineData.result || 
                      determineData.openai_response || 
                      (determineData.result?.openai_response) ||
                      determineData ||
                      {};
        }
        
        // Record iteration - include step result from condition path
        const iterationState = {
          iteration,
          condition,
          timestamp: new Date().toISOString(),
          lastResult: workflowState.lastExecutionResult || {},
          step_result: stepResult
        };
        loopState.iterations.push(iterationState);
        
        // Also store in lastExecutionResult for next iteration
        if (!workflowState.lastExecutionResult) {
          workflowState.lastExecutionResult = {};
        }
        workflowState.lastExecutionResult.step_result = stepResult;
        
        // CRITICAL: Also store stepResult in workflowState for easy access in journey update code
        workflowState.currentStepResult = stepResult;
        
        // CRITICAL: Log condition evaluation details
        const conditionStatus = stepResult?.status || stepResult?.completion_status || 'unknown';
        console.log(`🔄 [WHILE-LOOP-ITERATION-${iteration}] Iteration complete:`);
        console.log(`   - condition=${condition}`);
        console.log(`   - conditionStatus="${conditionStatus}"`);
        console.log(`   - conditionValue="${conditionValue}"`);
        console.log(`   - expectedValue="${config.conditionValue || 'pending'}"`);
        console.log(`   - inverted=${invertCondition}`);
        console.log(`   - should continue=${invertCondition ? !condition : condition}`);
        console.log(`   - will ${(invertCondition ? !condition : condition) ? 'CONTINUE' : 'EXIT'} loop`);
        
        // CRITICAL: Update journey/leg with iteration result immediately so it can be saved
        // Check multiple locations: currentJourney (from template), currentItem (default), currentLeg (legacy)
        const currentItem = workflowState.currentJourney || workflowState.currentItem || workflowState.currentLeg || {};
        
        const status = stepResult.status || stepResult.completion_status || 'unknown';
        const isSuccess = status === 'success';
        const isFailure = status === 'failure';
        
        // Check if we're working with journeys (simplified workflow) or legs (legacy workflow)
        // CRITICAL: If journeysToExecute exists and is an array, we're in journey context
        // This is the primary indicator - don't rely on currentItem having journey_id
        // Also check workflowState.journeys (set by AI step) as fallback
        const hasJourneysToExecute = workflowState.journeysToExecute && Array.isArray(workflowState.journeysToExecute) && workflowState.journeysToExecute.length > 0;
        const hasJourneys = workflowState.journeys && Array.isArray(workflowState.journeys) && workflowState.journeys.length > 0;
        const isJourneyContext = hasJourneysToExecute || hasJourneys;
        const hasJourneyId = currentItem.journey_id || currentItem.id || (isJourneyContext && currentItem);
        
        // CRITICAL: If journeysToExecute doesn't exist but journeys does, use journeys
        if (!workflowState.journeysToExecute && hasJourneys) {
          workflowState.journeysToExecute = workflowState.journeys;
          console.log(`🔧 [WHILE-LOOP-ITERATION-${iteration}] Set journeysToExecute from journeys (${workflowState.journeys.length} journey(s))`);
        }
        
        console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] Checking iteration save context:`, {
          currentItem_journey_id: currentItem.journey_id || 'N/A',
          currentItem_id: currentItem.id || 'N/A',
          hasJourneyId,
          isJourneyContext,
          journeysToExecute_length: workflowState.journeysToExecute?.length || 0,
          journeysToExecute_exists: !!workflowState.journeysToExecute,
          journeysToExecute_isArray: Array.isArray(workflowState.journeysToExecute),
          status,
          iteration
        });
        
        if (isJourneyContext) {
          console.log(`✅ [WHILE-LOOP-ITERATION-${iteration}] isJourneyContext is TRUE - will save iterations`);
          // Save iterations to journey
          // CRITICAL: currentItem from for-each IS the journey itself when itemVariable is "currentJourney"
          // So we can use it directly if it has journey_id or actions
          const journeyId = currentItem.journey_id || currentItem.id;
          
          // Try to find journey in journeysToExecute
          let journey = null;
          let journeyIndex = workflowState.journeysToExecute.findIndex(j => 
            (j.journey_id === journeyId) || (j.id === journeyId) ||
            (j.journey_id === currentItem.journey_id) || (j.id === currentItem.id)
          );
          
          if (journeyIndex >= 0) {
            journey = workflowState.journeysToExecute[journeyIndex];
          } else if (currentItem && (currentItem.journey_id || currentItem.actions)) {
            // currentItem IS the journey - use it directly and add to journeysToExecute if needed
            journey = currentItem;
            journeyIndex = workflowState.journeysToExecute.findIndex(j => j === currentItem);
            if (journeyIndex < 0) {
              workflowState.journeysToExecute.push(currentItem);
              journeyIndex = workflowState.journeysToExecute.length - 1;
            }
          }
          
          if (journey) {
            console.log(`✅ [WHILE-LOOP-ITERATION-${iteration}] Found journey ${journeyId} in journeysToExecute`);
            if (!Array.isArray(journey.iterations)) {
              journey.iterations = [];
            }
            
            // CRITICAL: Extract justification_status and ai_justification from justify_journey step result
            // The stepResult comes from justify_journey step and contains the justification data
            // Ensure justificationReason is always a string
            // CRITICAL: Get stepResult from multiple sources - it might be in workflowState.currentStepResult or iterationState
            let stepResultToUse = stepResult || workflowState.currentStepResult || workflowState.lastExecutionResult?.step_result;
            
            console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] DEBUG: stepResult sources:`, {
              stepResult: !!stepResult,
              currentStepResult: !!workflowState.currentStepResult,
              lastExecutionResult_step_result: !!workflowState.lastExecutionResult?.step_result,
              stepResultToUse: !!stepResultToUse,
              stepResultType: stepResultToUse ? typeof stepResultToUse : 'null',
              stepResultKeys: stepResultToUse && typeof stepResultToUse === 'object' ? Object.keys(stepResultToUse).join(', ') : 'N/A'
            });
            
            // CRITICAL: stepResult may be structured (wrapped in { value: ..., namespace: ... }), so unwrap it first
            let unwrappedResult = stepResultToUse;
            if (stepResultToUse && typeof stepResultToUse === 'object' && 'value' in stepResultToUse && 'namespace' in stepResultToUse) {
              console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] DEBUG: Unwrapping structured result`);
              unwrappedResult = stepResultToUse.value;
            }
            
            console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] DEBUG: unwrappedResult:`, {
              exists: !!unwrappedResult,
              type: unwrappedResult ? typeof unwrappedResult : 'null',
              keys: unwrappedResult && typeof unwrappedResult === 'object' ? Object.keys(unwrappedResult).join(', ') : 'N/A',
              hasOpenaiResponse: !!(unwrappedResult?.openai_response),
              hasResult: !!(unwrappedResult?.result),
              hasReason: !!(unwrappedResult?.reason),
              hasStatus: !!(unwrappedResult?.status)
            });
            
            // CRITICAL: Extract reason/justification - handle structured format { value: ..., namespace: ... }
            // The result is structured: { reason: { value: "text", namespace: "step" }, status: { value: "pending", namespace: "step" }, ... }
            const extractValue = (obj) => {
              if (!obj) return null;
              if (typeof obj === 'string') return obj;
              if (typeof obj === 'object' && 'value' in obj) return obj.value;
              return obj.toString ? obj.toString() : JSON.stringify(obj);
            };
            
            // Check multiple possible locations for the AI response data
            let justificationReason = '';
            const aiResponse = unwrappedResult?.openai_response || unwrappedResult?.result || unwrappedResult;
            
            // Extract status and expected_outcome_verified FIRST before using in console.log
            const statusValue = extractValue(aiResponse?.status) || extractValue(aiResponse?.completion_status) || 
                               extractValue(unwrappedResult?.status) || extractValue(unwrappedResult?.completion_status) ||
                               status;
            let justificationStatus = typeof statusValue === 'string' ? statusValue : (statusValue?.toString ? statusValue.toString() : status);
            const expectedOutcomeValue = extractValue(aiResponse?.expected_outcome_verified) || 
                                       extractValue(unwrappedResult?.expected_outcome_verified);
            let expectedOutcomeVerified = expectedOutcomeValue !== null && expectedOutcomeValue !== undefined ? 
                                           (typeof expectedOutcomeValue === 'boolean' ? expectedOutcomeValue : expectedOutcomeValue === 'true' || expectedOutcomeValue === true) : 
                                           undefined;
            
            // Try reason first (primary source) - handle structured format
            if (aiResponse?.reason) {
              justificationReason = extractValue(aiResponse.reason);
            } else if (aiResponse?.verification_details) {
              justificationReason = extractValue(aiResponse.verification_details);
            } else if (aiResponse?.ai_justification) {
              justificationReason = extractValue(aiResponse.ai_justification);
            } else if (unwrappedResult?.reason) {
              justificationReason = extractValue(unwrappedResult.reason);
            } else if (unwrappedResult?.verification_details) {
              justificationReason = extractValue(unwrappedResult.verification_details);
            }
            
            console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] Extracted justificationReason: ${justificationReason ? justificationReason.substring(0, 100) + '...' : 'EMPTY'}`);
            console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] DEBUG: Final extraction result:`, {
              justificationReason: justificationReason ? `${justificationReason.length} chars` : 'EMPTY',
              justificationStatus: justificationStatus || 'N/A',
              expectedOutcomeVerified: expectedOutcomeVerified !== undefined ? expectedOutcomeVerified : 'undefined',
              willSetOnJourney: !!journey
            });
            
            // Debug logging - detailed extraction trace
            console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] DEBUG: Extracting justification from aiResponse:`, {
              aiResponseExists: !!aiResponse,
              aiResponseType: aiResponse ? typeof aiResponse : 'null',
              aiResponseKeys: aiResponse && typeof aiResponse === 'object' ? Object.keys(aiResponse).join(', ') : 'N/A',
              hasReason: !!(aiResponse?.reason),
              hasVerificationDetails: !!(aiResponse?.verification_details),
              hasAiJustification: !!(aiResponse?.ai_justification),
              reasonType: aiResponse?.reason ? typeof aiResponse.reason : 'N/A',
              reasonLength: aiResponse?.reason ? (typeof aiResponse.reason === 'string' ? aiResponse.reason.length : 'not string') : 'N/A'
            });
            
            // Map status based on expected_outcome_verified (primary source)
            let finalJustificationStatus = justificationStatus;
            if (justificationStatus === 'pending') {
              finalJustificationStatus = 'pending';
            } else if (expectedOutcomeVerified === true) {
              finalJustificationStatus = 'success';
            } else if (expectedOutcomeVerified === false) {
              finalJustificationStatus = 'failure';
            }
            
            // Update journey with justification_status and ai_justification
            journey.justification_status = finalJustificationStatus;
            journey.ai_justification = justificationReason;
            if (expectedOutcomeVerified !== undefined) {
              journey.expected_outcome_verified = expectedOutcomeVerified;
            }
            if (unwrappedResult?.verification_details) {
              journey.verification_details = typeof unwrappedResult.verification_details === 'string' ? unwrappedResult.verification_details : (unwrappedResult.verification_details.toString ? unwrappedResult.verification_details.toString() : JSON.stringify(unwrappedResult.verification_details));
            }
            
            console.log(`✅ [WHILE-LOOP-ITERATION-${iteration}] DEBUG: Journey updated with justification:`, {
              journey_id: journey.journey_id,
              ai_justification: journey.ai_justification ? `${journey.ai_justification.length} chars` : 'NULL',
              justification_status: journey.justification_status || 'NULL',
              expected_outcome_verified: journey.expected_outcome_verified !== undefined ? journey.expected_outcome_verified : 'undefined'
            });
            
            // CRITICAL: Extract actions executed in this iteration from the script
            // NO FALLBACKS - only assign actions that were actually executed in this iteration
            // Parse the executed script to identify which actions were executed
            let iterationActions = [];
            const executedScript = workflowState.legScriptToExecute || workflowState.journeyScriptToExecute || '';
            
            if (executedScript && journey.actions && Array.isArray(journey.actions) && journey.actions.length > 0) {
              // Filter out verification/check actions first
              const interactiveActions = journey.actions.filter(action => {
                const actionType = (action.type || '').toLowerCase();
                return actionType !== 'verify' && actionType !== 'check';
              });
              
              // Match actions to script execution by checking if action selectors/elements appear in the script
              // For multi-step wizards, match actions based on current step visible in screenshot
              iterationActions = interactiveActions.filter(action => {
                // Check if action selector appears in the executed script
                const selector = action.selector || action.element_selector || '';
                const actionId = action.action_id || action.id || '';
                const actionText = action.text || action.description || '';
                
                if (!selector && !actionId && !actionText) {
                  return false; // No way to match this action
                }
                
                // Check if selector appears in script (normalized)
                const normalizedSelector = selector.replace(/['"]/g, '');
                const scriptContainsSelector = selector && executedScript.includes(normalizedSelector);
                
                // Check if action_id appears in script
                const scriptContainsActionId = actionId && executedScript.includes(actionId);
                
                // For multi-step: only include actions that match the current step
                // This is a heuristic - ideally we'd track which step we're on
                // For now, we'll include actions that appear in the script
                return scriptContainsSelector || scriptContainsActionId;
              });
              
              console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] Matched ${iterationActions.length} actions from ${interactiveActions.length} interactive actions based on script execution`);
            }
            
            const screenshotBefore = unwrapStructuredValue(
              workflowState[`screenshot_before`]?.result?.screenshot_file_id ||
              workflowState[`screenshot-before-action`]?.result?.screenshot_file_id ||
              null
            );
            const screenshotAfter = unwrapStructuredValue(
              workflowState[`screenshot_after`]?.result?.screenshot_file_id ||
              workflowState[`screenshot-after-action`]?.result?.screenshot_file_id ||
              null
            );

            const iterationData = {
              iteration_number: iteration,
              attempt_number: iteration,
              result: isSuccess ? 'success' : (isFailure ? 'failure' : 'in_progress'),
              status: status,
              completion_status: (aiResponse?.completion_status || stepResult?.completion_status || status),
              is_complete: isSuccess || isFailure,
              reason: justificationReason,
              error: isFailure ? (justificationReason || 'Journey execution failed') : null,
              script_executed: (() => {
                // Get script from generate_journey_script step result
                const generateScriptStepId = 'generate_journey_script';
                const generateScriptSlug = 'generate-journey-script';
                const scriptStepData = workflowState.variablePool?.steps?.[generateScriptSlug] ||
                                      workflowState[generateScriptStepId] ||
                                      workflowState.results?.[generateScriptStepId] ||
                                      workflowState.variablePool?.steps?.[generateScriptStepId] ||
                                      null;
                if (scriptStepData) {
                  const scriptResult = scriptStepData.result || scriptStepData;
                  if (scriptResult?.playwright_script) {
                    return scriptResult.playwright_script;
                  }
                }
                return workflowState.legScriptToExecute || '';
              })(),
              execution_result: workflowState.lastExecutionResult || {},
              page_url_before: workflowState.urlBeforeAction || '',
              page_url_after: page.url(),
              screenshot_before: screenshotBefore,
              screenshot_after: screenshotAfter,
              timestamp: new Date().toISOString(),
              actions: iterationActions // CRITICAL: Store filtered interactive actions for this iteration
            };
            
            // Check if this iteration already exists (update) or add new
            const existingIterationIndex = journey.iterations.findIndex(iter => iter.iteration_number === iteration);
            const isNewIteration = existingIterationIndex < 0;
            
            console.log(`💾 [WHILE-LOOP-ITERATION-${iteration}] Adding iteration data: iteration_number=${iterationData.iteration_number}, status=${iterationData.status}, actions_count=${iterationData.actions?.length || 0}, reason=${iterationData.reason ? iterationData.reason.substring(0, 50) + '...' : 'N/A'}`);
            
            if (existingIterationIndex >= 0) {
              journey.iterations[existingIterationIndex] = iterationData;
              console.log(`💾 [WHILE-LOOP-ITERATION-${iteration}] Updated existing iteration at index ${existingIterationIndex}`);
            } else {
              journey.iterations.push(iterationData);
              console.log(`💾 [WHILE-LOOP-ITERATION-${iteration}] Added new iteration. Journey now has ${journey.iterations.length} iteration(s)`);
            }
            
            // CRITICAL: Update journey group when new iteration is discovered
            if (isNewIteration) {
              // Update group based on iteration count (multi-step journey)
              const totalIterations = journey.iterations.length;
              if (totalIterations > 1) {
                journey.group = `Multi-step journey (${totalIterations} steps)`;
              } else if (totalIterations === 1) {
                journey.group = 'Single-step journey';
              }
              
              console.log(`📝 [WHILE-LOOP-ITERATION-${iteration}] Updated journey ${journeyId} group (${totalIterations} iteration(s))`);
            }
            
            // Also update in workflowState.journeys if it exists
            if (workflowState.journeys && Array.isArray(workflowState.journeys)) {
              const journeysIndex = workflowState.journeys.findIndex(j => 
                (j.journey_id === journeyId) || (j.id === journeyId)
              );
              if (journeysIndex >= 0) {
                if (!Array.isArray(workflowState.journeys[journeysIndex].iterations)) {
                  workflowState.journeys[journeysIndex].iterations = [];
                }
                // Update journey with justification fields
                workflowState.journeys[journeysIndex].justification_status = finalJustificationStatus;
                workflowState.journeys[journeysIndex].ai_justification = justificationReason;
                if (expectedOutcomeVerified !== undefined) {
                  workflowState.journeys[journeysIndex].expected_outcome_verified = expectedOutcomeVerified;
                }
                if (stepResult.verification_details) {
                  workflowState.journeys[journeysIndex].verification_details = stepResult.verification_details;
                }
                
                // CRITICAL: Also update description and group in workflowState.journeys
                if (isNewIteration) {
                  workflowState.journeys[journeysIndex].description = journey.description;
                  workflowState.journeys[journeysIndex].test_instructions = journey.test_instructions;
                  workflowState.journeys[journeysIndex].group = journey.group;
                }
                
                const existingIterIndex = workflowState.journeys[journeysIndex].iterations.findIndex(iter => iter.iteration_number === iteration);
                if (existingIterIndex >= 0) {
                  workflowState.journeys[journeysIndex].iterations[existingIterIndex] = iterationData;
                } else {
                  workflowState.journeys[journeysIndex].iterations.push(iterationData);
                }
              }
            }
            
            console.log(`✅ Updated journey ${journeyId} with iteration ${iteration} result: ${status}, justification_status: ${finalJustificationStatus}, ai_justification: ${justificationReason ? 'YES (' + justificationReason.substring(0, 50) + '...)' : 'NO'}`);
            console.log(`🔍 [WHILE-LOOP-ITERATION-${iteration}] Journey ${journeyId} now has ${journey.iterations.length} iteration(s)`);
            
            // CRITICAL: Save journey iterations immediately to make results visible in UI right away
            if (workflowState.workflowId) {
              try {
                const payload = {
                  saveLegs: false,
                  journeys: [journey],
                  job_id: jobId
                };
                console.log(`💾 [WHILE-LOOP-ITERATION-${iteration}] Saving journey ${journeyId} with ${journey.iterations.length} iteration(s) and justification_status=${finalJustificationStatus} to page ${workflowState.pageId}`);
                console.log(`💾 [WHILE-LOOP-ITERATION-${iteration}] DEBUG: Journey object:`, JSON.stringify({
                  journey_id: journey.journey_id,
                  iterations_count: journey.iterations?.length || 0,
                  iterations: journey.iterations?.map(i => ({
                    iteration_number: i.iteration_number,
                    status: i.status,
                    actions_count: i.actions?.length || 0
                  })) || []
                }, null, 2));
                await axios.post(
                  `${this.backendUrl}/api/pages/${workflowState.pageId}/save-analysis`,
                  payload,
                  { headers: this.getAuthHeaders() }
                );
                console.log(`💾 [WHILE-LOOP-ITERATION-${iteration}] ✅ Successfully saved iteration ${iteration} for journey ${journeyId} with justification_status=${finalJustificationStatus} to page`);
              } catch (saveError) {
                console.error(`❌ [WHILE-LOOP-ITERATION-${iteration}] Failed to immediately save journey iteration: ${saveError.message}`, saveError);
              }
            } else {
              console.warn(`⚠️ [WHILE-LOOP-ITERATION-${iteration}] Cannot save journey iteration: workflowId is missing`);
            }
          } else {
            console.warn(`⚠️ [WHILE-LOOP-ITERATION-${iteration}] Journey not found in journeysToExecute. journeyId=${journeyId}, journeysToExecute.length=${workflowState.journeysToExecute?.length || 0}`);
          }
        } else {
          console.warn(`⚠️ [WHILE-LOOP-ITERATION-${iteration}] isJourneyContext is FALSE - skipping iteration save. hasJourneyId=${hasJourneyId}, journeysToExecute exists=${!!workflowState.journeysToExecute}, isArray=${Array.isArray(workflowState.journeysToExecute)}`);
        }
        
        if (currentItem.leg_id && workflowState.legsToExecute && Array.isArray(workflowState.legsToExecute)) {
          // Legacy: Save iterations to leg
          const legIndex = workflowState.legsToExecute.findIndex(l => 
            (l.leg_id === currentItem.leg_id) || 
            (l.id === currentItem.leg_id) ||
            (l.leg_id === currentItem.id) ||
            (l.id === currentItem.id)
          );
          
          if (legIndex >= 0) {
            const leg = workflowState.legsToExecute[legIndex];
            if (!Array.isArray(leg.iterations)) {
              leg.iterations = [];
            }
            
            // Build iteration object with all relevant data
            const iterationData = {
              iteration_number: iteration,
              attempt_number: iteration,
              result: isSuccess ? 'success' : (isFailure ? 'failure' : 'in_progress'),
              status: status,
              completion_status: determineCompletionResult.completion_status || status,
              is_complete: isSuccess || isFailure,
              reason: determineCompletionResult.reason || determineCompletionResult.what_happened || '',
              error: isFailure ? (determineCompletionResult.reason || determineCompletionResult.what_happened || 'Leg execution failed') : null,
              script_executed: workflowState.legScriptToExecute || '',
              execution_result: workflowState.lastExecutionResult || {},
              page_url_before: workflowState.urlBeforeAction || '',
              page_url_after: page.url(),
              screenshot_before: workflowState[`screenshot_before_leg`]?.result?.screenshot_file_id || null,
              screenshot_after: workflowState[`screenshot_after`]?.result?.screenshot_file_id || null,
              timestamp: new Date().toISOString()
            };
            
            // Check if this iteration already exists (update) or add new
            const existingIterationIndex = leg.iterations.findIndex(iter => iter.iteration_number === iteration);
            if (existingIterationIndex >= 0) {
              leg.iterations[existingIterationIndex] = iterationData;
            } else {
              leg.iterations.push(iterationData);
            }
            
            // Also update in workflowState.legs if it exists
            if (workflowState.legs && Array.isArray(workflowState.legs)) {
              const legsIndex = workflowState.legs.findIndex(l => 
                (l.leg_id === currentItem.leg_id) || 
                (l.id === currentItem.leg_id) ||
                (l.leg_id === currentItem.id) ||
                (l.id === currentItem.id)
              );
              if (legsIndex >= 0) {
                if (!Array.isArray(workflowState.legs[legsIndex].iterations)) {
                  workflowState.legs[legsIndex].iterations = [];
                }
                const existingIterIndex = workflowState.legs[legsIndex].iterations.findIndex(iter => iter.iteration_number === iteration);
                if (existingIterIndex >= 0) {
                  workflowState.legs[legsIndex].iterations[existingIterIndex] = iterationData;
                } else {
                  workflowState.legs[legsIndex].iterations.push(iterationData);
                }
              }
            }
            
            // Also update currentItem for reference
            currentItem.iterations = leg.iterations;
            
            console.log(`✅ Updated leg ${currentItem.leg_id} with iteration ${iteration} result: ${status}`);
            
            // CRITICAL: Save immediately to make results visible in UI right away
            if (workflowState.workflowId) {
              try {
                await this.saveLegIterationsToWorkflow(workflowState, [leg], jobId);
                console.log(`💾 Immediately saved iteration ${iteration} for leg ${currentItem.leg_id} to workflow`);
              } catch (saveError) {
                console.warn(`⚠️ Failed to immediately save iteration: ${saveError.message}`);
              }
            }
          }
        }
        
        // Send log to backend
        await this.sendLogToBackend(jobId, 'info', `🔄 Iteration ${iteration} complete: condition=${condition} (should continue=${invertCondition ? !condition : condition})`, 'WORKFLOW-ANALYZER', {
          step_id: step.id,
          step_name: step.name || step.type,
          step_type: 'while-loop',
          iteration: iteration,
          condition: condition,
          inverted: invertCondition,
          should_continue: invertCondition ? !condition : condition
        });
        
      } catch (iterationError) {
        console.error(`❌ Iteration ${iteration} failed: ${iterationError.message}`);
        
        // Send error log to backend
        await this.sendLogToBackend(jobId, 'error', `❌ Iteration ${iteration} failed: ${iterationError.message}`, 'WORKFLOW-ANALYZER', {
          step_id: step.id,
          step_name: step.name || step.type,
          step_type: 'while-loop',
          iteration: iteration,
          error: iterationError.message
        });
        
        loopState.iterations.push({
          iteration,
          error: iterationError.message,
          timestamp: new Date().toISOString()
        });
        
        // Break on critical errors
        if (iterationError.message.includes('critical') || iteration >= maxIterations) {
          break;
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Extract determine_completion result from last iteration and promote to top level
    // CRITICAL: After loop completes, we need to make determine_completion accessible at top level
    let lastDetermineCompletion = null;
    
    // Strategy 1: Check if already stored at top level from last iteration
    lastDetermineCompletion = workflowState.determine_completion?.result || workflowState.determine_completion;
    
    // Strategy 2: Extract from loop iterations
    if ((!lastDetermineCompletion || (!lastDetermineCompletion.status && !lastDetermineCompletion.completion_status)) 
        && loopState.iterations && loopState.iterations.length > 0) {
      const lastIteration = loopState.iterations[loopState.iterations.length - 1];
      
      // Check multiple possible locations in last iteration
      lastDetermineCompletion = 
        lastIteration?.determine_completion?.result ||
        lastIteration?.determine_completion ||
        lastIteration?.lastResult?.determine_completion?.result ||
        lastIteration?.lastResult?.determine_completion ||
        lastDetermineCompletion;
    }
    
    // Strategy 3: Check workflowState.results (by step ID)
    if ((!lastDetermineCompletion || (!lastDetermineCompletion.status && !lastDetermineCompletion.completion_status))
        && workflowState.results?.determine_completion) {
      lastDetermineCompletion = workflowState.results.determine_completion.result ||
                                workflowState.results.determine_completion ||
                                lastDetermineCompletion;
    }
    
    // Promote to top level for easy access (even if empty, for debugging)
    if (lastDetermineCompletion) {
      // Avoid circular references by cloning the result and not nesting it under "result"
      let safeResult;
      try {
        safeResult = JSON.parse(JSON.stringify(lastDetermineCompletion));
      } catch (cloneErr) {
        console.warn(`⚠️ Failed to deep clone determine_completion result: ${cloneErr.message}. Falling back to shallow copy.`);
        safeResult = { ...(lastDetermineCompletion || {}) };
      }

      workflowState.determine_completion = safeResult;

      if (!workflowState.results) {
        workflowState.results = {};
      }
      workflowState.results.determine_completion = safeResult;
      
      const statusDisplay = safeResult.status || safeResult.completion_status || 'none';
      console.log(`✅ Promoted determine_completion result: status=${statusDisplay}, is_complete=${safeResult.is_complete}`);
    } else {
      console.warn(`⚠️ No determine_completion result found after ${iteration} iterations`);
    }
    
    // Determine final status from last determine_completion result
    // Reuse existing currentLeg from earlier in the function
    const finalCurrentLeg = workflowState.currentLeg || workflowState.currentItem || {};
    let finalLegStatus = null;
    let finalLegResult = 'skipped';
    let finalLegError = null;
    
    // CRITICAL: Check if loop exited early (condition=false means action completed successfully)
    // If condition is false and we have iterations, the action likely succeeded
    // Loop exits when: (invertCondition ? !condition : condition) === false
    // Which means: (invertCondition ? condition : !condition) === true
    const shouldContinue = invertCondition ? !condition : condition;
    const loopExitedEarly = iteration < maxIterations && !shouldContinue;
    
    // Only check determine_completion status if we haven't already set finalLegStatus from loopExitedEarly
    if (!finalLegStatus && lastDetermineCompletion) {
      const status = lastDetermineCompletion.status || lastDetermineCompletion.completion_status || 'unknown';
      const isComplete = lastDetermineCompletion.is_complete === true;
      
      console.log(`🔍 Determining final status from determine_completion: status=${status}, isComplete=${isComplete}, loopExitedEarly=${loopExitedEarly}`);
      
      // Check determine_completion status only if loopExitedEarly didn't already set the status
      if (status === 'success' || (isComplete && status !== 'failure' && status !== 'continue' && status !== 'stuck')) {
        finalLegStatus = 'success';
        finalLegResult = 'success';
      } else if (!finalLegStatus && (status === 'failure' || (isComplete && status === 'failure'))) {
        // CRITICAL: Only process failure if we haven't already set finalLegStatus to success
        // If loop exited early but determine_completion says failure, 
        // check if execution actually succeeded (execution result takes precedence)
        if (loopExitedEarly) {
          const executionSucceeded = 
            workflowState.lastExecutionResult?.success === true ||
            (workflowState.lastExecutionResult?.success !== false && !workflowState.executionErrorType) ||
            workflowState.lastExecutionResult?.error === undefined ||
            !workflowState.lastExecutionResult?.error;
          
          if (executionSucceeded) {
            finalLegStatus = 'success';
            finalLegResult = 'success';
            console.log(`✅ Loop exited early with successful execution - overriding determine_completion failure status`);
          } else {
            // Check if failure is due to execution error
            const hasExecutionError = workflowState.executionErrorType === 'execution' ||
                                      lastDetermineCompletion.execution_error_type === 'execution' ||
                                      lastDetermineCompletion.error_type === 'execution';
            
            if (hasExecutionError) {
              finalLegStatus = 'execution_failure';
              finalLegResult = 'execution_failure';
            } else {
              finalLegStatus = 'failure';
              finalLegResult = 'failure';
            }
            finalLegError = lastDetermineCompletion.reason || lastDetermineCompletion.what_happened || 'Action execution failed';
          }
        } else {
          // Check if failure is due to execution error
          const hasExecutionError = workflowState.executionErrorType === 'execution' ||
                                    lastDetermineCompletion.execution_error_type === 'execution' ||
                                    lastDetermineCompletion.error_type === 'execution';
          
          if (hasExecutionError) {
            finalLegStatus = 'execution_failure';
            finalLegResult = 'execution_failure';
          } else {
            finalLegStatus = 'failure';
            finalLegResult = 'failure';
          }
          finalLegError = lastDetermineCompletion.reason || lastDetermineCompletion.what_happened || 'Action execution failed';
        }
      } else if (status === 'continue' || status === 'stuck') {
        // If max iterations reached and status is still 'continue' or 'stuck', mark as failure
        // This indicates the action couldn't be completed within the iteration limit
        if (iteration >= maxIterations) {
          finalLegStatus = 'failure';
          finalLegResult = 'failure';
          finalLegError = lastDetermineCompletion.reason || lastDetermineCompletion.what_happened || `Action could not be completed: status was '${status}' after ${iteration} iterations`;
        } else if (loopExitedEarly) {
          // Loop exited early with condition=false, which typically means success
          // But if status is 'continue' or 'stuck', we need to check execution result
          const executionSucceeded = workflowState.lastExecutionResult?.success !== false;
          if (executionSucceeded) {
            finalLegStatus = 'success';
            finalLegResult = 'success';
          } else {
            finalLegStatus = 'failure';
            finalLegResult = 'failure';
            finalLegError = lastDetermineCompletion.reason || lastDetermineCompletion.what_happened || 'Action execution did not complete successfully';
          }
        }
        // If not at max iterations yet and loop didn't exit early, finalLegStatus remains null so loop can continue
      } else if (loopExitedEarly && iteration > 0) {
        // Loop exited early but no clear status - check execution result
        const executionSucceeded = workflowState.lastExecutionResult?.success !== false;
        if (executionSucceeded) {
          finalLegStatus = 'success';
          finalLegResult = 'success';
        } else {
          finalLegStatus = 'failure';
          finalLegResult = 'failure';
          finalLegError = lastDetermineCompletion?.reason || lastDetermineCompletion?.what_happened || 'Action execution did not complete successfully';
        }
      }
    } else if (loopExitedEarly && iteration > 0) {
      // No determine_completion result but loop exited early - check execution result
      // If loop exited early and no errors, assume success
      const executionSucceeded = 
        workflowState.lastExecutionResult?.success === true ||
        workflowState.lastExecutionResult?.success !== false && !workflowState.executionErrorType ||
        workflowState.lastExecutionResult?.error === undefined ||
        !workflowState.lastExecutionResult?.error;
      
      if (executionSucceeded) {
        finalLegStatus = 'success';
        finalLegResult = 'success';
        console.log(`✅ Loop exited early with successful execution (no determine_completion) - marking leg as success`);
      } else {
        finalLegStatus = 'failure';
        finalLegResult = 'failure';
        finalLegError = workflowState.lastExecutionResult?.error || 'Action execution did not complete successfully';
        console.log(`⚠️ Loop exited early but execution may have failed - marking leg as failure`);
      }
    }
    
    // If still no final status and max iterations reached, mark as failure
    if (!finalLegStatus && iteration >= maxIterations) {
      finalLegStatus = 'failure';
      finalLegResult = 'failure';
      finalLegError = lastDetermineCompletion?.reason || lastDetermineCompletion?.what_happened || 'Max iterations reached without completion';
    }
    
    // Log final status determination for debugging
    if (finalLegStatus) {
      console.log(`✅ Determined final leg status: ${finalLegStatus} (result: ${finalLegResult}, iterations: ${iteration}, loopExitedEarly: ${loopExitedEarly}, lastExecutionResult.success: ${workflowState.lastExecutionResult?.success})`);
      // Send log to backend
      if (jobId) {
        await this.sendLogToBackend(jobId, 'info', `✅ Determined final leg status: ${finalLegStatus} (result: ${finalLegResult})`, 'WORKFLOW-ANALYZER', {
          leg_id: finalCurrentLeg?.leg_id,
          final_status: finalLegStatus,
          final_result: finalLegResult,
          iterations: iteration,
          loop_exited_early: loopExitedEarly,
          has_determine_completion: !!lastDetermineCompletion,
          last_execution_result: workflowState.lastExecutionResult ? Object.keys(workflowState.lastExecutionResult) : null
        });
      }
    } else {
      console.warn(`⚠️ Could not determine final leg status (iterations: ${iteration}, hasDetermineCompletion: ${!!lastDetermineCompletion}, loopExitedEarly: ${loopExitedEarly})`);
      // Send warning to backend
      if (jobId) {
        await this.sendLogToBackend(jobId, 'warn', `⚠️ Could not determine final leg status`, 'WORKFLOW-ANALYZER', {
          leg_id: finalCurrentLeg?.leg_id,
          iterations: iteration,
          has_determine_completion: !!lastDetermineCompletion,
          loop_exited_early: loopExitedEarly,
          last_execution_result: workflowState.lastExecutionResult ? Object.keys(workflowState.lastExecutionResult) : null
        });
      }
    }
    
    // Update leg with final status if we have a leg
    if (finalCurrentLeg && finalCurrentLeg.leg_id && workflowState.legsToExecute && Array.isArray(workflowState.legsToExecute)) {
      const legIndex = workflowState.legsToExecute.findIndex(l => 
        (l.leg_id === finalCurrentLeg.leg_id) || 
        (l.id === finalCurrentLeg.leg_id) ||
        (l.leg_id === finalCurrentLeg.id) ||
        (l.id === finalCurrentLeg.id)
      );
      
      if (legIndex >= 0 && finalLegStatus) {
        const leg = workflowState.legsToExecute[legIndex];
        leg.status = finalLegStatus;
        leg.final_result = finalLegResult;
        if (finalLegError) {
          leg.error = finalLegError;
        }
        
        // Also update in workflowState.legs if it exists
        if (workflowState.legs && Array.isArray(workflowState.legs)) {
          const legsIndex = workflowState.legs.findIndex(l => 
            (l.leg_id === currentLeg.leg_id) || 
            (l.id === currentLeg.leg_id) ||
            (l.leg_id === currentLeg.id) ||
            (l.id === currentLeg.id)
          );
          if (legsIndex >= 0) {
            workflowState.legs[legsIndex].status = finalLegStatus;
            workflowState.legs[legsIndex].final_result = finalLegResult;
            if (finalLegError) {
              workflowState.legs[legsIndex].error = finalLegError;
            }
          }
        }
        
        // CRITICAL: Save leg with final status via save-data endpoint
        if (workflowState.workflowId && jobId) {
          try {
            // Ensure leg has all required fields
            const legToSave = {
              ...leg,
              leg_id: leg.leg_id || finalCurrentLeg.leg_id,
              status: finalLegStatus,
              final_result: finalLegResult,
              iterations: leg.iterations || [],
              error: finalLegError || null
            };
            
            console.log(`💾 Saving leg ${legToSave.leg_id} with final status: ${finalLegStatus} (workflowId: ${workflowState.workflowId}, jobId: ${jobId})`);
            await this.saveLegIterationsToWorkflow(workflowState, [legToSave], jobId);
            console.log(`✅ Saved leg ${legToSave.leg_id} with final status: ${finalLegStatus}`);
            
            // Also call complete-leg endpoint to update action status
            try {
              const axios = (await import('axios')).default;
              const completeResponse = await axios.post(
                `${this.backendUrl}/api/workflows/${workflowState.workflowId}/legs/${legToSave.leg_id}/complete`,
                {
                  final_result: finalLegResult,
                  error: finalLegError,
                  job_id: jobId
                },
                {
                  headers: this.getAuthHeaders(),
                  timeout: 10000
                }
              );
              console.log(`✅ Called complete-leg endpoint for leg ${legToSave.leg_id}:`, completeResponse.data);
            } catch (completeError) {
              console.error(`❌ Failed to call complete-leg endpoint: ${completeError.message}`, completeError.response?.data);
            }
          } catch (saveError) {
            console.error(`❌ Failed to save final leg status: ${saveError.message}`, saveError);
          }
        } else {
          console.warn(`⚠️ Cannot save leg status: workflowId=${workflowState.workflowId}, jobId=${jobId}`);
        }
      } else {
        console.warn(`⚠️ Cannot update leg: legIndex=${legIndex}, finalLegStatus=${finalLegStatus}, hasLegsToExecute=${!!workflowState.legsToExecute}`);
      }
    } else {
      console.warn(`⚠️ Cannot update leg: finalCurrentLeg=${!!finalCurrentLeg}, leg_id=${finalCurrentLeg?.leg_id}, hasLegsToExecute=${!!workflowState.legsToExecute}`);
    }
    
    // CRITICAL: Extract justification_status and ai_justification from the last justify_journey step result
    // This is needed for journeys in simplified workflow
    let finalJustificationStatus = finalLegStatus;
    let finalAiJustification = '';
    let finalExpectedOutcomeVerified = undefined;
    
    // Get the last iteration's step result (should contain justify_journey result)
    if (loopState.iterations && loopState.iterations.length > 0) {
      const lastIteration = loopState.iterations[loopState.iterations.length - 1];
      const lastStepResult = lastIteration?.step_result;
      
      if (lastStepResult) {
        // CRITICAL: Extract justification data from justify_journey step result - handle structured format
        const extractValue = (obj) => {
          if (!obj) return null;
          if (typeof obj === 'string') return obj;
          if (typeof obj === 'object' && 'value' in obj) return obj.value;
          return obj.toString ? obj.toString() : JSON.stringify(obj);
        };
        
        let justificationReason = '';
        const reasonValue = extractValue(lastStepResult.reason) || extractValue(lastStepResult.verification_details) || extractValue(lastStepResult.ai_justification);
        if (reasonValue) {
          justificationReason = typeof reasonValue === 'string' ? reasonValue : (reasonValue.toString ? reasonValue.toString() : JSON.stringify(reasonValue));
        }
        
        if (justificationReason) {
          finalAiJustification = justificationReason;
        }
        
        // Extract status - handle structured format
        const statusValue = extractValue(lastStepResult.status) || extractValue(lastStepResult.completion_status) || finalLegStatus;
        if (statusValue) {
          finalJustificationStatus = typeof statusValue === 'string' ? statusValue : (statusValue.toString ? statusValue.toString() : finalLegStatus);
        }
        
        // Extract expected_outcome_verified - handle structured format
        const expectedOutcomeValue = extractValue(lastStepResult.expected_outcome_verified);
        if (expectedOutcomeValue !== null && expectedOutcomeValue !== undefined) {
          finalExpectedOutcomeVerified = typeof expectedOutcomeValue === 'boolean' ? expectedOutcomeValue : (expectedOutcomeValue === 'true' || expectedOutcomeValue === true);
          // Map status based on expected_outcome_verified
          if (finalExpectedOutcomeVerified === true) {
            finalJustificationStatus = 'success';
          } else if (finalExpectedOutcomeVerified === false) {
            finalJustificationStatus = 'failure';
          }
        }
      }
    }
    
    // CRITICAL: Update journey with final justification_status and ai_justification after while-loop completes
    // Check multiple locations: currentJourney (from template), currentItem (default), or find from journeysToExecute
    const currentJourney = workflowState.currentJourney || workflowState.currentItem || null;
    if (currentJourney && workflowState.journeysToExecute && Array.isArray(workflowState.journeysToExecute)) {
      const journeyId = currentJourney.journey_id || currentJourney.id;
      const journeyIndex = workflowState.journeysToExecute.findIndex(j => 
        (j.journey_id === journeyId) || (j.id === journeyId)
      );
      
      if (journeyIndex >= 0) {
        const journey = workflowState.journeysToExecute[journeyIndex];
        // CRITICAL: Use journey's existing ai_justification if it was set during iterations (PATH-1)
        // Only override if finalAiJustification exists and journey doesn't have one
        if (!journey.ai_justification && finalAiJustification) {
          journey.ai_justification = finalAiJustification;
        } else if (journey.ai_justification && !finalAiJustification) {
          // Journey has justification but finalAiJustification doesn't - use journey's value
          finalAiJustification = journey.ai_justification;
        }
        journey.justification_status = finalJustificationStatus || journey.justification_status || 'discovered';
        if (finalExpectedOutcomeVerified !== undefined) {
          journey.expected_outcome_verified = finalExpectedOutcomeVerified;
        }
        
        // Also update in workflowState.journeys if it exists
        if (workflowState.journeys && Array.isArray(workflowState.journeys)) {
          const journeysIndex = workflowState.journeys.findIndex(j => 
            (j.journey_id === journeyId) || (j.id === journeyId)
          );
          if (journeysIndex >= 0) {
            // CRITICAL: Use journey's existing ai_justification if it was set during iterations (PATH-1)
            if (!workflowState.journeys[journeysIndex].ai_justification && finalAiJustification) {
              workflowState.journeys[journeysIndex].ai_justification = finalAiJustification;
            } else if (workflowState.journeys[journeysIndex].ai_justification && !finalAiJustification) {
              // Journey has justification but finalAiJustification doesn't - use journey's value
              finalAiJustification = workflowState.journeys[journeysIndex].ai_justification;
            }
            workflowState.journeys[journeysIndex].justification_status = finalJustificationStatus || workflowState.journeys[journeysIndex].justification_status || 'discovered';
            if (finalExpectedOutcomeVerified !== undefined) {
              workflowState.journeys[journeysIndex].expected_outcome_verified = finalExpectedOutcomeVerified;
            }
          }
        }
        
        // Save journey with final justification immediately
        if (workflowState.workflowId) {
          try {
            // CRITICAL: Ensure journey has all justification fields before saving
            const journeyToSave = {
              ...journey,
              ai_justification: journey.ai_justification || finalAiJustification || null,
              justification_status: journey.justification_status || finalJustificationStatus || null,
              expected_outcome_verified: journey.expected_outcome_verified !== undefined ? journey.expected_outcome_verified : (finalExpectedOutcomeVerified !== undefined ? finalExpectedOutcomeVerified : undefined),
              verification_details: journey.verification_details || null
            };
            
            const payload = {
              saveLegs: false,
              journeys: [journeyToSave],
              job_id: jobId
            };
            console.log(`💾 [WHILE-LOOP-COMPLETE] Saving journey ${journeyId} with final justification_status=${journeyToSave.justification_status || 'N/A'}, ai_justification=${journeyToSave.ai_justification ? `YES (${journeyToSave.ai_justification.length} chars)` : 'NO'} to page ${workflowState.pageId}`);
            await axios.post(
              `${this.backendUrl}/api/pages/${workflowState.pageId}/save-analysis`,
              payload,
              { headers: this.getAuthHeaders() }
            );
            console.log(`💾 [WHILE-LOOP-COMPLETE] ✅ Successfully saved journey ${journeyId} with final justification after while-loop completion`);
          } catch (saveError) {
            console.error(`❌ [WHILE-LOOP-COMPLETE] Failed to save journey final justification: ${saveError.message}`, saveError);
          }
        }
      }
    }
    
    const finalResult = {
      iterations: loopState.iterations || [],
      total_iterations: iteration,
      condition_result: invertCondition ? !condition : condition,
      maxIterations,
      exitedEarly: iteration < maxIterations && (invertCondition ? condition : !condition),
      finalCondition: condition,
      loopHistory: loopState.iterations,
      determine_completion: lastDetermineCompletion, // Include in final result for extraction
      finalLegStatus: finalJustificationStatus || finalLegStatus,
      finalLegResult,
      justification_status: finalJustificationStatus,
      ai_justification: finalAiJustification
    };
    
    this.storeStepResult(step, finalResult, workflowState);
    console.log(`✅ While-loop completed after ${iteration} iterations${finalJustificationStatus ? ` (final justification_status: ${finalJustificationStatus})` : (finalLegStatus ? ` (final status: ${finalLegStatus})` : '')}`);
    
    // CRITICAL: Final save of iterations at end of while-loop
    // This ensures iterations are saved even if they weren't saved during individual iterations
    if (workflowState.journeysToExecute && Array.isArray(workflowState.journeysToExecute) && workflowState.journeysToExecute.length > 0 && workflowState.workflowId) {
      const currentItem = workflowState.currentJourney || workflowState.currentItem || {};
      const journeyId = currentItem.journey_id || currentItem.id;
      if (journeyId) {
        const journey = workflowState.journeysToExecute.find(j => (j.journey_id === journeyId) || (j.id === journeyId));
        if (journey && journey.iterations && journey.iterations.length > 0) {
          try {
            console.log(`💾 [WHILE-LOOP-FINAL] Saving ${journey.iterations.length} iteration(s) for journey ${journeyId} at end of while-loop`);
            await axios.post(
              `${this.backendUrl}/api/pages/${workflowState.pageId}/save-analysis`,
              {
                saveLegs: false,
                journeys: [journey],
                job_id: jobId
              },
              { headers: this.getAuthHeaders() }
            );
            console.log(`💾 [WHILE-LOOP-FINAL] ✅ Successfully saved ${journey.iterations.length} iteration(s) for journey ${journeyId}`);
          } catch (saveError) {
            console.error(`❌ [WHILE-LOOP-FINAL] Failed to save iterations: ${saveError.message}`);
          }
        }
      }
    }
    
    // Send log to backend for job history
    if (jobId) {
      try {
        await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
          jobId: jobId,
          level: 'info',
          message: `✅ While-loop completed after ${iteration} iterations${finalLegStatus ? ` (final status: ${finalLegStatus})` : ''}`,
          component: 'WORKFLOW-ANALYZER',
          metadata: {
            step_id: step.id,
            step_name: step.name || step.type,
            step_type: 'while-loop',
            iterations: iteration,
            max_iterations: maxIterations,
            exited_early: finalResult.exitedEarly,
            final_condition: finalResult.finalCondition,
            final_leg_status: finalLegStatus,
            final_leg_result: finalLegResult,
            timestamp: new Date().toISOString()
          }
        }, {
          headers: this.getAuthHeaders()
        });
      } catch (error) {
        console.error(`⚠️ Failed to log while-loop completion: ${error.message}`);
      }
    }
  }

  /**
   * Execute if-step - conditionally executes nested steps based on a condition
   * General-purpose conditional element
   */
  async executeIfStep(page, step, workflowState, jobId) {
    console.log(`🔀 Executing if-step (${step.name})`);
    
    // Send log to backend
    await this.sendLogToBackend(jobId, 'info', `🔀 Executing if-step (${step.name})`, 'WORKFLOW-ANALYZER', {
      step_id: step.id,
      step_name: step.name || step.type,
      step_type: 'if-step'
    });
    
    const config = step.config || {};
    const conditionCode = config.conditionCode; // JavaScript code that returns boolean
    const conditionPath = config.conditionPath; // Path to check for condition value
    const conditionType = config.conditionType || 'code'; // 'code', 'path', or 'ai-response'
    const nestedSteps = config.steps || [];
    const elseSteps = config.elseSteps || []; // Optional else branch
    
    // Validate required fields based on conditionType
    if (conditionType === 'code' && !conditionCode) {
      const errorMessage = `Missing required field "conditionCode" in if-step "${step.name || step.id}" (conditionType is "code")`;
      const missingPath = 'step.config.conditionCode';
      console.error(`❌ ${errorMessage}`);
      console.error(`❌ Missing JSON path: ${missingPath}`);
      console.error(`❌ Full step:`, JSON.stringify(step, null, 2));
      console.error(`❌ Step config:`, JSON.stringify(step.config, null, 2));
      
      const fullContext = {
        step_id: step.id,
        step_name: step.name || step.type,
        step_type: step.type,
        step_config: step.config,
        conditionType: conditionType,
        full_step: step
      };
      
      if (jobId && this.backendLogger) {
        try {
          await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', {
            ...fullContext,
            missing_path: missingPath
          });
        } catch (e) {
          console.error(`❌ Failed to log error to backend:`, e.message);
        }
      }
      
      throw new Error(`${errorMessage}\nMissing JSON path: ${missingPath}\nFull step: ${JSON.stringify(step, null, 2)}`);
    }
    
    if ((conditionType === 'path' || conditionType === 'ai-response') && !conditionPath) {
      const errorMessage = `Missing required field "conditionPath" in if-step "${step.name || step.id}" (conditionType is "${conditionType}")`;
      const missingPath = 'step.config.conditionPath';
      console.error(`❌ ${errorMessage}`);
      console.error(`❌ Missing JSON path: ${missingPath}`);
      console.error(`❌ Full step:`, JSON.stringify(step, null, 2));
      console.error(`❌ Step config:`, JSON.stringify(step.config, null, 2));
      
      const fullContext = {
        step_id: step.id,
        step_name: step.name || step.type,
        step_type: step.type,
        step_config: step.config,
        conditionType: conditionType,
        full_step: step
      };
      
      if (jobId && this.backendLogger) {
        try {
          await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', {
            ...fullContext,
            missing_path: missingPath
          });
        } catch (e) {
          console.error(`❌ Failed to log error to backend:`, e.message);
        }
      }
      
      throw new Error(`${errorMessage}\nMissing JSON path: ${missingPath}\nFull step: ${JSON.stringify(step, null, 2)}`);
    }
    
    if (!nestedSteps.length) {
      console.log(`⚠️ If-step has no nested steps`);
      return;
    }
    
    let condition = false;
    
    try {
      // Evaluate condition
      if (conditionType === 'code' && conditionCode) {
        // Clean the code before execution
        let cleanedCode = this.cleanScript(conditionCode);
        if (!cleanedCode || cleanedCode.trim().length === 0) {
          throw new Error('Condition code is empty after cleaning');
        }
        // Execute code to get condition
        const conditionResult = await page.evaluate(
          ({ code, workflowState }) => {
            const runner = new Function('workflowState', `return (${code});`);
            return runner(workflowState);
          },
          { code: cleanedCode, workflowState }
        );
        condition = conditionResult === true || conditionResult === 'true' || conditionResult === 1;
        
      } else if (conditionType === 'path' || conditionType === 'ai-response') {
        // Get condition from workflowState path
        const conditionValue = this.resolvePathValue(workflowState, conditionPath || 'determine_completion.is_complete', 'results');
        
        if (conditionValue !== undefined && conditionValue !== null) {
          condition = conditionValue === true || conditionValue === 'true' || conditionValue === 1 || conditionValue === 'complete';
        }
      }
      
      console.log(`🔀 Condition evaluated: ${condition}`);
      
      // Send log to backend
      await this.sendLogToBackend(jobId, 'info', `🔀 Condition evaluated: ${condition}`, 'WORKFLOW-ANALYZER', {
        step_id: step.id,
        step_name: step.name || step.type,
        step_type: 'if-step',
        condition: condition,
        condition_type: conditionType
      });
      
      // Execute appropriate branch
      const stepsToExecute = condition ? nestedSteps : elseSteps;
      
      if (stepsToExecute.length > 0) {
        for (let nestedIdx = 0; nestedIdx < stepsToExecute.length; nestedIdx++) {
          const nestedStep = stepsToExecute[nestedIdx];
          
          try {
            await this.executeStepByType(page, nestedStep, workflowState, jobId, {
              stepIndex: nestedIdx,
              siblings: stepsToExecute
            });
          } catch (nestedError) {
            console.error(`❌ Nested step ${nestedIdx + 1} failed in if-step: ${nestedError.message}`);
            if (nestedStep.config?.critical) {
              throw nestedError;
            }
          }
        }
      }
      
      const result = {
        condition,
        conditionType,
        executedBranch: condition ? 'then' : 'else',
        stepsExecuted: stepsToExecute.length
      };
      
      this.storeStepResult(step, result, workflowState);
      console.log(`✅ If-step completed: executed ${condition ? 'then' : 'else'} branch (${stepsToExecute.length} steps)`);
      
      // Send log to backend
      await this.sendLogToBackend(jobId, 'info', `✅ If-step completed: executed ${condition ? 'then' : 'else'} branch (${stepsToExecute.length} steps)`, 'WORKFLOW-ANALYZER', {
        step_id: step.id,
        step_name: step.name || step.type,
        step_type: 'if-step',
        condition: condition,
        executed_branch: condition ? 'then' : 'else',
        steps_executed: stepsToExecute.length
      });
      
    } catch (error) {
      console.error(`❌ If-step failed: ${error.message}`);
      
      // Send error log to backend
      await this.sendLogToBackend(jobId, 'error', `❌ If-step failed: ${error.message}`, 'WORKFLOW-ANALYZER', {
        step_id: step.id,
        step_name: step.name || step.type,
        step_type: 'if-step',
        error: error.message
      });
      
      throw error;
    }
  }

  /**
   * @deprecated Use while-loop instead. This method is kept for backward compatibility but will be removed.
   * Execute test-leg-iteratively step - recursively tests a leg until AI says it's complete
   */
  async executeTestLegIterativelyStep(page, step, workflowState, jobId) {
    console.log(`🔄 Executing iterative leg test (${step.name})`);
    
    const config = step.config || {};
    // CRITICAL: Force 1 iteration per job - no multiple iterations allowed
    const maxIterations = 1;
    
    // Get current leg from context
    const currentLeg = workflowState.currentLeg || workflowState.currentItem || {};
    const currentLegIndex = workflowState.currentLegIndex ?? 0;
    
    if (!currentLeg || !currentLeg.leg_id) {
      throw new Error(`No current leg found for iterative testing`);
    }
    
    let iteration = 0;
    let lastExecutionResult = null;
    let finalResult = null;
    let executionErrorType = null; // Track if error is execution-related
    
    console.log(`🔄 Starting iterative testing for leg: ${currentLeg.title || currentLeg.description || currentLeg.leg_id} (1 iteration only)`);
    
    // Update status to 'testing' when starting to test this action
    if (workflowState.workflowId && currentLeg.leg_id) {
      try {
        await this.updateLegStatus(workflowState.workflowId, currentLeg.leg_id, 'testing', jobId);
        console.log(`📊 Updated action status to 'testing' for leg: ${currentLeg.leg_id}`);
        
        // Also update in workflowState for immediate access
        if (workflowState.legsToExecute && Array.isArray(workflowState.legsToExecute)) {
          const legIndex = workflowState.legsToExecute.findIndex(l => 
            (l.leg_id === currentLeg.leg_id) || (l.id === currentLeg.leg_id)
          );
          if (legIndex >= 0) {
            workflowState.legsToExecute[legIndex].status = 'testing';
          }
        }
      } catch (statusError) {
        console.warn(`⚠️ Failed to update status to 'testing': ${statusError.message}`);
      }
    }
    
    // CRITICAL: Only one iteration per job - stop after first
    while (iteration < maxIterations) {
      iteration++;
      console.log(`🔄 Iteration ${iteration}/${maxIterations} for leg: ${currentLeg.leg_id}`);
      
      try {
        // Step 1: Capture page state before action (only visible elements)
        await this.executePlaywrightAnalysisStep(page, {
          id: `${step.id}_iteration_${iteration}_analysis`,
          name: `Page Analysis (Iteration ${iteration})`,
          type: 'playwright-analysis',
          config: { collectForms: true, collectLinks: true, collectInteractiveElements: true }
        }, workflowState, jobId);
        
        await this.executeScreenshotStep(page, {
          id: `${step.id}_iteration_${iteration}_screenshot`,
          name: `Screenshot (Iteration ${iteration})`,
          type: 'screenshot',
          config: { fullPage: true, quality: 90 }
        }, workflowState, jobId, workflowState.pageId);
        
        // Step 2: Get page description
        await this.executePageDescriptionStep(page, {
          id: `${step.id}_iteration_${iteration}_description`,
          name: `Page Description (Iteration ${iteration})`,
          type: 'page-description',
          config: {
            prompt_slug: 'describe-page',
            attachments: ['visible_text', 'interactive_elements', 'screenshot'],
            maxRetries: 1
          }
        }, workflowState, jobId);
        
        // Step 3: Generate action script (only on first iteration, or if new content detected, or if no script is stored)
        if (iteration === 1 || (lastExecutionResult && lastExecutionResult.new_content_detected) || !workflowState.legScriptToExecute) {
          // Get previous execution history for this leg (from both database and current loop execution)
          let previousExecutionHistory = [];
          
          // First, check for iterations from current loop execution (previous iterations in this while-loop)
          if (workflowState.legsToExecute && Array.isArray(workflowState.legsToExecute)) {
            const legIndex = workflowState.legsToExecute.findIndex(l => 
              (l.leg_id === currentLeg.leg_id) || 
              (l.id === currentLeg.leg_id) ||
              (l.leg_id === currentLeg.id) ||
              (l.id === currentLeg.id)
            );
            
            if (legIndex >= 0) {
              const currentLegData = workflowState.legsToExecute[legIndex];
              if (currentLegData.iterations && Array.isArray(currentLegData.iterations) && currentLegData.iterations.length > 0) {
                // Build execution history from current loop's previous iterations
                previousExecutionHistory = currentLegData.iterations
                  .filter(iter => iter.script_executed || iter.error || iter.reason) // Include attempts with scripts, errors, or reasoning
                  .map(iter => ({
                    attempt_number: iter.attempt_number || iter.iteration_number || 0,
                    iteration_number: iter.iteration_number || null,
                    script_executed: iter.script_executed ? iter.script_executed.substring(0, 1000) : null, // Truncate for context
                    result: iter.result || 'unknown',
                    status: iter.status || iter.completion_status || null,
                    reason: iter.reason || iter.what_happened || null, // CRITICAL: Include reasoning from determine_completion
                    error: iter.error || null,
                    page_url_before: iter.page_url_before || null,
                    page_url_after: iter.page_url_after || null,
                    is_retry: iter.is_retry || (iter.attempt_number > 1) || false
                  }));
              }
            }
          }
          
          // Also try to get leg iterations from workflow database if available (for persistence across runs)
          if (workflowState.workflowId && currentLeg.leg_id && previousExecutionHistory.length === 0) {
            try {
              const workflowResponse = await axios.get(
                `${this.backendUrl}/api/workflows/${workflowState.workflowId}`,
                { headers: this.getAuthHeaders() }
              );
              const workflow = workflowResponse.data;
              const leg = workflow.legs?.find(l => l.leg_id === currentLeg.leg_id);
              
              if (leg && leg.iterations && leg.iterations.length > 0) {
                // Build execution history with reasoning from previous attempts
                previousExecutionHistory = leg.iterations
                  .filter(iter => iter.script_executed || iter.error || iter.reason) // Include attempts with scripts, errors, or reasoning
                  .map(iter => ({
                    attempt_number: iter.attempt_number || iter.iteration_number || 0,
                    iteration_number: iter.iteration_number || null,
                    script_executed: iter.script_executed ? iter.script_executed.substring(0, 1000) : null, // Truncate for context
                    result: iter.result || 'unknown',
                    status: iter.status || iter.completion_status || null,
                    reason: iter.reason || iter.what_happened || null, // CRITICAL: Include reasoning from determine_completion
                    error: iter.error || null,
                    page_url_before: iter.page_url_before || null,
                    page_url_after: iter.page_url_after || null,
                    is_retry: iter.is_retry || (iter.attempt_number > 1) || false
                  }))
                  .slice(-5); // Only last 5 attempts to avoid too much context
              }
            } catch (error) {
              console.warn(`Could not fetch leg iterations from workflow: ${error.message}`);
            }
          }
          
          // Store execution history for attachment (only if there's history)
          if (previousExecutionHistory.length > 0) {
            workflowState.execution_history = JSON.stringify(previousExecutionHistory, null, 2);
            console.log(`📚 Built execution history with ${previousExecutionHistory.length} previous attempts (including reasoning)`);
          }
          
          await this.executeAIPromptStep(page, {
            id: `${step.id}_iteration_${iteration}_generate_script`,
            name: `Generate Action Script (Iteration ${iteration})`,
            type: 'ai-prompt',
            config: {
              prompt_slug: 'generate-playwright-script',
              attachments: previousExecutionHistory.length > 0 
                ? ['page_description', 'interactive_elements', 'forms', 'current_leg', 'playwright_analysis', 'execution_history']
                : ['page_description', 'interactive_elements', 'forms', 'current_leg', 'playwright_analysis'],
              maxRetries: 2
            }
          }, workflowState, jobId);
          
          // Get the generated script
          const generateStepId = `${step.id}_iteration_${iteration}_generate_script`;
          const generateResult = workflowState[generateStepId]?.result || workflowState.results?.[generateStepId]?.result || {};
          let script = generateResult.playwright_script || generateResult.code || '';
          
          if (!script || script.trim() === '') {
            throw new Error(`No Playwright script generated for iteration ${iteration}`);
          }
          
          // Clean the script to remove markdown code blocks and function declarations
          script = this.cleanScript(script);
          
          if (!script || script.trim().length === 0) {
            throw new Error(`Script is empty after cleaning for iteration ${iteration}`);
          }
          
          workflowState.legScriptToExecute = script;
        }
        
        // Step 4: Execute the script
        try {
          await this.executeCodeFromVariableStep(page, {
            id: `${step.id}_iteration_${iteration}_execute`,
            name: `Execute Action Script (Iteration ${iteration})`,
            type: 'execute-code-from-variable',
            config: {
              sourceField: 'legScriptToExecute',
              timeout: 45000
            }
          }, workflowState);
          
          const executeStepId = `${step.id}_iteration_${iteration}_execute`;
          lastExecutionResult = workflowState[executeStepId]?.result || workflowState.lastExecutionResult || {};
          executionErrorType = null; // Reset error type on success
        } catch (execError) {
          // Catch execution errors (syntax errors, timeouts, etc.)
          console.error(`❌ Execution error for leg ${currentLeg.leg_id}:`, execError.message);
          executionErrorType = 'execution';
          lastExecutionResult = {
            error: execError.message,
            execution_failed: true,
            error_type: 'execution'
          };
          
          // Check error type to determine if it's execution failure
          const errorMsg = execError.message?.toLowerCase() || '';
          if (errorMsg.includes('syntax') || 
              errorMsg.includes('timeout') || 
              errorMsg.includes('referenceerror') ||
              errorMsg.includes('typeerror') ||
              errorMsg.includes('script')) {
            executionErrorType = 'execution';
          }
        }
        
        // Step 5: Capture page state after action (only visible elements)
        await this.executePlaywrightAnalysisStep(page, {
          id: `${step.id}_iteration_${iteration}_analysis_after`,
          name: `Page Analysis After Action (Iteration ${iteration})`,
          type: 'playwright-analysis',
          config: { collectForms: true, collectLinks: true, collectInteractiveElements: true }
        }, workflowState, jobId);
        
        await this.executeScreenshotStep(page, {
          id: `${step.id}_iteration_${iteration}_screenshot_after`,
          name: `Screenshot After Action (Iteration ${iteration})`,
          type: 'screenshot',
          config: { fullPage: true, quality: 90 }
        }, workflowState, jobId, workflowState.pageId);
        
        await this.executePageDescriptionStep(page, {
          id: `${step.id}_iteration_${iteration}_description_after`,
          name: `Page Description After Action (Iteration ${iteration})`,
          type: 'page-description',
          config: {
            prompt_slug: 'describe-page',
            attachments: ['visible_text', 'interactive_elements', 'screenshot'],
            maxRetries: 1
          }
        }, workflowState, jobId);
        
        // Step 6: Use AI to determine if leg testing is complete
        // Build attachments list - include execution_history if available
        const determineAttachments = ['current_leg', 'last_execution_result', 'page_description', 'visible_text', 'interactive_elements', 'forms'];
        if (workflowState.execution_history) {
          determineAttachments.push('execution_history');
        }
        
        await this.executeAIPromptStep(page, {
          id: `${step.id}_iteration_${iteration}_determine_completion`,
          name: `Determine Completion (Iteration ${iteration})`,
          type: 'ai-prompt',
          config: {
            prompt_slug: 'determine-leg-completion',
            attachments: determineAttachments,
            maxRetries: 1
          }
        }, workflowState, jobId);
        
        const completionStepId = `${step.id}_iteration_${iteration}_determine_completion`;
        const completionResult = workflowState[completionStepId]?.result || workflowState.results?.[completionStepId]?.result || {};
        
        // Extract completion decision
        const status = completionResult.status || completionResult.completion_status || 'unknown';
        const legFailed = status === 'failure' || completionResult.completion_status === 'failed';
        const legSucceeded = status === 'success' || (completionResult.is_complete === true && !legFailed);
        
        // CRITICAL: Update leg with iteration result immediately so it can be saved by "Save Page Data" step
        if (workflowState.legsToExecute && Array.isArray(workflowState.legsToExecute)) {
          const legIndex = workflowState.legsToExecute.findIndex(l => 
            (l.leg_id === currentLeg.leg_id) || 
            (l.id === currentLeg.leg_id) ||
            (l.leg_id === currentLeg.id) ||
            (l.id === currentLeg.id)
          );
          
          if (legIndex >= 0) {
            const leg = workflowState.legsToExecute[legIndex];
            if (!Array.isArray(leg.iterations)) {
              leg.iterations = [];
            }
            
            // Determine error type: execution_failure vs failure
            let iterationResult = 'in_progress';
            let iterationError = null;
            
            if (legSucceeded) {
              iterationResult = 'success';
            } else if (legFailed) {
              // Check if failure is due to execution error (syntax, timeout, etc.) or action failure
              if (executionErrorType === 'execution' || 
                  (lastExecutionResult && (lastExecutionResult.error_type === 'execution' || lastExecutionResult.execution_failed))) {
                iterationResult = 'execution_failure';
              } else {
                iterationResult = 'failure';
              }
              iterationError = completionResult.reason || completionResult.what_happened || lastExecutionResult?.error || 'Leg execution failed';
            }
            
            // Build iteration object with all relevant data
            const iterationData = {
              iteration_number: iteration,
              attempt_number: iteration,
              result: iterationResult,
              status: status,
              completion_status: completionResult.completion_status || status,
              is_complete: legSucceeded || legFailed,
              reason: completionResult.reason || completionResult.what_happened || '',
              error: iterationError,
              execution_error_type: executionErrorType || (iterationResult === 'execution_failure' ? 'execution' : null),
              script_executed: workflowState.legScriptToExecute || '',
              execution_result: lastExecutionResult,
              page_url_before: workflowState.urlBeforeAction || '',
              page_url_after: page.url(),
              screenshot_before: workflowState[`${step.id}_iteration_${iteration}_screenshot`]?.result?.screenshot_file_id || null,
              screenshot_after: workflowState[`${step.id}_iteration_${iteration}_screenshot_after`]?.result?.screenshot_file_id || null,
              timestamp: new Date().toISOString()
            };
            
            // Store execution error type for final status determination
            if (executionErrorType) {
              workflowState.executionErrorType = executionErrorType;
            }
            
            leg.iterations.push(iterationData);
            
            // Update leg status based on iteration result
            if (legSucceeded) {
              leg.status = 'success';
              finalResult = 'success';
            } else if (legFailed) {
              if (executionErrorType === 'execution' || iterationResult === 'execution_failure') {
                leg.status = 'execution_failure';
                finalResult = 'execution_failure';
              } else {
                leg.status = 'failure';
                finalResult = 'failure';
              }
            }
            
            // Store execution error type for final status determination
            if (executionErrorType) {
              workflowState.executionErrorType = executionErrorType;
            }
            
            // Also update in workflowState.legs if it exists
            if (workflowState.legs && Array.isArray(workflowState.legs)) {
              const legsIndex = workflowState.legs.findIndex(l => 
                (l.leg_id === currentLeg.leg_id) || 
                (l.id === currentLeg.leg_id) ||
                (l.leg_id === currentLeg.id) ||
                (l.id === currentLeg.id)
              );
              if (legsIndex >= 0) {
                if (!Array.isArray(workflowState.legs[legsIndex].iterations)) {
                  workflowState.legs[legsIndex].iterations = [];
                }
                workflowState.legs[legsIndex].iterations.push(iterationData);
                workflowState.legs[legsIndex].status = leg.status; // Update status in legs array too
              }
            }
            
            // CRITICAL: Also update in workflowState.legsToExecute so iterations are available for next iteration
            if (workflowState.legsToExecute && Array.isArray(workflowState.legsToExecute)) {
              const legsToExecuteIndex = workflowState.legsToExecute.findIndex(l => 
                (l.leg_id === currentLeg.leg_id) || 
                (l.id === currentLeg.leg_id) ||
                (l.leg_id === currentLeg.id) ||
                (l.id === currentLeg.id)
              );
              if (legsToExecuteIndex >= 0) {
                if (!Array.isArray(workflowState.legsToExecute[legsToExecuteIndex].iterations)) {
                  workflowState.legsToExecute[legsToExecuteIndex].iterations = [];
                }
                workflowState.legsToExecute[legsToExecuteIndex].iterations.push(iterationData);
                workflowState.legsToExecute[legsToExecuteIndex].status = leg.status; // Update status
              }
            }
            
            // Update action status via save-data to ensure it's persisted
            // Include status in leg object so save-data endpoint updates it
            leg.status = leg.status || 'testing'; // Ensure status is set
            
            // Save iteration immediately to workflow (status will be updated via save-data)
            try {
              await this.saveLegIterationsToWorkflow(workflowState, [leg], jobId);
              console.log(`💾 Immediately saved iteration ${iteration} for leg ${currentLeg.leg_id} to workflow with status: ${leg.status}`);
            } catch (saveError) {
              console.warn(`⚠️ Failed to save iteration: ${saveError.message}`);
            }
            
            // Also update currentLeg for reference
            currentLeg.iterations = leg.iterations;
            
            console.log(`✅ Updated leg ${currentLeg.leg_id} with iteration ${iteration} result: ${status}`);
            
            // CRITICAL: Save immediately to make results visible in UI right away
            if (workflowState.workflowId) {
              try {
                await this.saveLegIterationsToWorkflow(workflowState, [leg], jobId);
                console.log(`💾 Immediately saved iteration ${iteration} for leg ${currentLeg.leg_id} to workflow`);
              } catch (saveError) {
                console.warn(`⚠️ Failed to immediately save iteration: ${saveError.message}`);
              }
            }
          }
        }
        
        console.log(`🔄 Iteration ${iteration} complete: legSucceeded=${legSucceeded}, legFailed=${legFailed}`);
        
        // Clear exit conditions: if OpenAI says succeeded or failed - exit the loop
        if (legSucceeded) {
          console.log(`✅ Leg testing succeeded after ${iteration} iterations. Reason: ${completionResult.reason || 'AI determined success'}`);
          finalResult = {
            success: true,
            completed: true,
            iterations: iteration,
            finalExecutionResult: lastExecutionResult,
            completionReason: completionResult.reason
          };
          break;
        }
        
        if (legFailed) {
          console.log(`❌ Leg testing failed after ${iteration} iterations. Reason: ${completionResult.reason || 'AI determined failure'}`);
          finalResult = {
            success: false,
            completed: true,
            iterations: iteration,
            finalExecutionResult: lastExecutionResult,
            completionReason: completionResult.reason || 'Leg failed',
            error: completionResult.reason || 'Leg failed completely'
          };
          break;
        }
        
        // Otherwise, continue to next iteration
        console.log(`🔄 Continuing iteration - leg not yet succeeded or failed`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (iterationError) {
        console.error(`❌ Iteration ${iteration} failed: ${iterationError.message}`);
        
        // NOTE: Saving is now handled by workflow steps (save-data elements), not hardcoded here
        // This deprecated method should not be used - use while-loop workflow step instead
        
        // If max iterations reached, exit
        if (iteration >= maxIterations) {
          console.log(`⚠️ Max iterations (${maxIterations}) reached`);
          finalResult = {
            success: false,
            completed: false,
            iterations: iteration,
            error: `Max iterations reached: ${iterationError.message}`,
            maxIterationsReached: true
          };
          break;
        }
        
        // Continue to next iteration
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Final result - if loop exited without setting finalResult, it means max iterations reached
    if (!finalResult) {
      finalResult = {
        success: false,
        completed: false,
        iterations: iteration,
        reason: 'Max iterations reached',
        maxIterationsReached: true
      };
    }
    
    // Store result
    this.storeStepResult(step, finalResult, workflowState);
    
    // Update leg result
    const legIndex = currentLegIndex;
    if (!Array.isArray(workflowState.legResults)) {
      workflowState.legResults = [];
    }
    workflowState.legResults[legIndex] = {
      ...currentLeg,
      ...finalResult,
      finished_at: new Date().toISOString()
    };
    
    console.log(`✅ Iterative leg testing completed: ${finalResult.completed ? 'COMPLETE' : 'INCOMPLETE'} after ${finalResult.iterations} iterations`);
    
    return finalResult;
  }

  /**
   * Execute step by type (used by for-each to execute nested steps)
   */
  async executeStepByType(page, step, workflowState, jobId, stepContext = null) {
    switch (step.type) {
      case 'browser-config':
        await this.executeBrowserConfigStep(page, step, workflowState, jobId);
        break;
      case 'screenshot':
        await this.executeScreenshotStep(page, step, workflowState, jobId, workflowState.pageId);
        break;
      case 'playwright-analysis':
        await this.executePlaywrightAnalysisStep(page, step, workflowState, jobId);
        break;
      case 'page-description':
        await this.executePageDescriptionStep(page, step, workflowState, jobId, stepContext);
        break;
      case 'ai-prompt':
        try {
          await this.executeAIPromptStep(page, step, workflowState, jobId, stepContext);
        } catch (stepError) {
          const errorMessage = `Step "${step.name || step.id}" (ai-prompt) failed: ${stepError.message}`;
          console.error(`❌ ${errorMessage}`);
          console.error(`❌ Step config:`, JSON.stringify(step.config, null, 2));
          console.error(`❌ Full step:`, JSON.stringify(step, null, 2));
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', {
              step_id: step.id,
              step_name: step.name,
              step_type: step.type,
              step_config: step.config,
              error: stepError.message,
              error_stack: stepError.stack,
              full_step: step
            });
          }
          throw stepError; // Re-throw to fail workflow
        }
        break;
      case 'workflow-analysis':
        await this.executeWorkflowAnalysisStep(page, step, workflowState, jobId, stepContext);
        break;
      case 'update-workflow':
        await this.executeUpdateWorkflowStep(step, workflowState, jobId);
        break;
      case 'page-discovery':
        // DEPRECATED: page-discovery step type has been removed
        // Each workflow step must save its own data when executed
        console.warn(`⚠️ DEPRECATED: page-discovery step type has been removed. Skipping step "${step.name || step.id}".`);
        console.warn(`⚠️ Each workflow step must save its own data when executed.`);
        // Skip this step - data should already be saved by individual steps
        break;
        
      case 'save-page-data':
        await this.executeSavePageDataStep(page, step, workflowState, jobId);
        break;
      case 'execute-code':
        await this.executeCodeStep(page, step, workflowState);
        break;
      case 'execute-code-from-variable':
        try {
          await this.executeCodeFromVariableStep(page, step, workflowState, jobId);
        } catch (stepError) {
          const errorMessage = `Step "${step.name || step.id}" (execute-code-from-variable) failed: ${stepError.message}`;
          console.error(`❌ ${errorMessage}`);
          console.error(`❌ Step config:`, JSON.stringify(step.config, null, 2));
          console.error(`❌ Full step:`, JSON.stringify(step, null, 2));
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', {
              step_id: step.id,
              step_name: step.name,
              step_type: step.type,
              step_config: step.config,
              error: stepError.message,
              error_stack: stepError.stack,
              full_step: step
            });
          }
          throw stepError; // Re-throw to fail workflow
        }
        break;
      case 'validate-response':
        await this.executeValidateResponseStep(step, workflowState);
        break;
      case 'filter-response':
        await this.executeFilterResponseStep(step, workflowState);
        break;
      case 'job-configuration':
        await this.executeJobConfigurationStep(step, workflowState, jobId);
        break;
      case 'print':
        await this.executePrintStep(step, workflowState, jobId);
        break;
      case 'var-dump':
        await this.executeVarDumpStep(step, workflowState, jobId);
        break;
      case 'sleep':
        await this.executeSleepStep(step, workflowState);
        break;
      case 'cookie-add':
        await this.executeCookieAddStep(step, workflowState, jobId);
        break;
      case 'cookie-update':
        await this.executeCookieUpdateStep(step, workflowState, jobId);
        break;
      case 'cookie-remove':
        await this.executeCookieRemoveStep(step, workflowState, jobId);
        break;
      case 'cookie-collect':
        await this.executeCookieCollectStep(page, step, workflowState, jobId);
        break;
      case 'for-each':
        await this.executeForEachStep(page, step, workflowState, jobId);
        break;
      case 'while-loop':
        await this.executeWhileLoopStep(page, step, workflowState, jobId);
        break;
      case 'if':
      case 'if-step':
        await this.executeIfStep(page, step, workflowState, jobId);
        break;
      case 'save-page-data':
        await this.executeSavePageDataStep(page, step, workflowState, jobId);
        break;
      default:
        console.log(`⚠️ Unknown nested step type: ${step.type}`);
    }
  }

  /**
   * Resolve path value from object (supports both context and results)
   */
  resolvePathValue(source, path, sourceType = 'context') {
    if (!path || !source) {
      return undefined;
    }

    const segments = path.split('.').map(part => part.trim()).filter(Boolean);

    // CRITICAL: First check variable pool for direct variable access (e.g., 'legsToExecute', 'visible_text', 'playwright_script')
    if (segments.length === 1 && source.variablePool) {
      const varName = segments[0];
      // Check in order: cycle (current) -> page -> job
      const cycleIndex = source.cycleStack?.length - 1;
      if (cycleIndex >= 0 && source.variablePool.cycle[cycleIndex]?.[varName]) {
        const varData = source.variablePool.cycle[cycleIndex][varName];
        const value = varData?.value !== undefined ? varData.value : varData;
        if (value !== undefined) {
          console.log(`✅ Resolved "${path}" from variablePool.cycle[${cycleIndex}]: ${typeof value}`);
          return value;
        }
      }
      if (source.variablePool.page[varName]) {
        const varData = source.variablePool.page[varName];
        const value = varData?.value !== undefined ? varData.value : varData;
        if (value !== undefined) {
          console.log(`✅ Resolved "${path}" from variablePool.page: ${typeof value}`);
          return value;
        }
      }
      if (source.variablePool.job[varName]) {
        const varData = source.variablePool.job[varName];
        const value = varData?.value !== undefined ? varData.value : varData;
        if (value !== undefined) {
          console.log(`✅ Resolved "${path}" from variablePool.job: ${typeof value}`);
          return value;
        }
      }
    }
    
    // Also check direct access on source (for workflowState.playwright_script)
    if (segments.length === 1 && source[segments[0]] !== undefined) {
      const value = source[segments[0]];
      if (typeof value === 'string' || (typeof value === 'object' && value !== null)) {
        console.log(`✅ Resolved "${path}" from direct source access: ${typeof value}`);
        return value;
      }
    }

    // Determine starting point based on sourceType
    let current;
    if (sourceType === 'results') {
      // For results, look in source.results or source itself
      current = source.results || source;
    } else {
      // For context, try multiple locations: source.context, source directly, or source[path]
      // First try source.context
      if (source.context && segments.length > 0 && source.context[segments[0]] !== undefined) {
        current = source.context;
      } else if (segments.length > 0 && source[segments[0]] !== undefined) {
        // Try direct access on source
        current = source;
      } else {
        // Fallback to context or source
        current = source.context || source;
      }
    }

    // Use getNestedValue which handles structured format automatically
    let value = this.getNestedValue(current, path);
    if (value !== undefined) {
      return value;
    }
    
    // Fallback to manual traversal for backward compatibility
    for (const segment of segments) {
      if (current === null || current === undefined) {
        return undefined;
      }

      if (Array.isArray(current)) {
        const index = Number(segment);
        if (Number.isNaN(index) || index < 0 || index >= current.length) {
          return undefined;
        }
        current = current[index];
      } else if (typeof current === 'object') {
        // Handle structured format: {value: ..., namespace: ...}
        if (current.value !== undefined && current.namespace !== undefined) {
          current = current.value;
        }
        
        if (Object.prototype.hasOwnProperty.call(current, segment)) {
          current = current[segment];
        } else if (current.result && typeof current.result === 'object' && Object.prototype.hasOwnProperty.call(current.result, segment)) {
          current = current.result[segment];
        } else if (current.metadata && typeof current.metadata === 'object' && Object.prototype.hasOwnProperty.call(current.metadata, segment)) {
          current = current.metadata[segment];
        } else {
          current = undefined;
        }
      } else {
        return undefined;
      }
    }

    // Handle structured format in final value
    if (current && typeof current === 'object' && !Array.isArray(current) && current.value !== undefined && current.namespace !== undefined) {
      return current.value;
    }
    
    return current;
  }

  /**
   * Coerce value to integer
   */
  coerceToInteger(value) {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        return null;
      }
      return Math.trunc(value);
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed === '') {
        return null;
      }
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        return null;
      }
      return Math.trunc(parsed);
    }

    return null;
  }

  buildVarDumpSnapshot(step, workflowState, options, config) {
    const snapshot = {};
    const scopes = [];
    const statistics = {
      legs: Array.isArray(workflowState.legs) ? workflowState.legs.length : 0,
      completedLegs: Array.isArray(workflowState.legResults)
        ? workflowState.legResults.filter(Boolean).length
        : 0,
      loopIterations: workflowState.currentIteration || 0
    };

    if (config.includeShared !== false) {
      const sharedScope = {
        job: {
          id: workflowState.jobId,
          workflowId: workflowState.workflowId,
          pageUrl: workflowState.pageUrl,
          pageTitle: workflowState.pageTitle
        },
        runtimeOptions: workflowState.runtimeOptions,
        aiAnalysisResult: workflowState.aiAnalysisResult,
        lastExecutionResult: workflowState.lastExecutionResult,
        lastScriptFailure: workflowState.lastScriptFailure,
        results: workflowState.results,
        determine_completion: workflowState['determine_completion'],
        conversationHistory: Array.isArray(workflowState.conversationHistory)
          ? workflowState.conversationHistory.slice(-5)
          : [],
        collectedCookies: Array.isArray(workflowState.collectedCookies)
          ? workflowState.collectedCookies.slice(-5)
          : [],
        screenshot: workflowState.screenshotUrl ? {
          url: workflowState.screenshotUrl,
          fileId: workflowState.screenshotFileId
        } : null
      };
      snapshot.shared = this.truncateForVarDump(sharedScope, options);
      scopes.push('shared');
    }

    if (config.includeCurrentLoop) {
      const loopScope = {
        currentIteration: workflowState.currentIteration || null,
        loopState: workflowState.loopState || null,
        loopStack: workflowState.loopStack || null
      };
      snapshot.currentLoop = this.truncateForVarDump(loopScope, options);
      scopes.push('currentLoop');
    }

    if (config.includeStepsSummary) {
      const legsSummary = Array.isArray(workflowState.legs)
        ? workflowState.legs.map(leg => ({
            leg_id: leg.leg_id,
            title: leg.title || leg.description,
            type: leg.type,
            final_result: leg.final_result || leg.result || null,
            iterations: Array.isArray(leg.iterations) ? leg.iterations.length : 0
          }))
        : [];
      const summaryScope = {
        legs: legsSummary,
        legResults: workflowState.legResults || [],
        actionsSummary: workflowState.actionsSummary || null
      };
      snapshot.steps = this.truncateForVarDump(summaryScope, options);
      scopes.push('stepsSummary');
    }

    if (config.includeContext) {
      snapshot.context = this.truncateForVarDump(workflowState.context || {}, options);
      scopes.push('context');
    }

    // CRITICAL: Always include legsToExecute explicitly in snapshot for visibility
    // This ensures legs are visible in var-dumps even if context is truncated
    if (workflowState.legsToExecute && Array.isArray(workflowState.legsToExecute)) {
      snapshot.legsToExecute = this.truncateForVarDump(workflowState.legsToExecute, options);
      scopes.push('legsToExecute');
    } else if (workflowState.context?.legsToExecute && Array.isArray(workflowState.context.legsToExecute)) {
      snapshot.legsToExecute = this.truncateForVarDump(workflowState.context.legsToExecute, options);
      scopes.push('legsToExecute');
    }

    // Always include variablePool in var-dump for visibility (always initialize if missing)
    if (!workflowState.variablePool) {
      this.initializeVariablePool(workflowState);
    }
    
    // Always include variablePool in snapshot
    snapshot.variablePool = {
      job: this.truncateForVarDump(workflowState.variablePool?.job || {}, options),
      page: this.truncateForVarDump(workflowState.variablePool?.page || {}, options),
      cycle: this.truncateForVarDump(workflowState.variablePool?.cycle || [], options),
      steps: this.truncateForVarDump(workflowState.variablePool?.steps || {}, options),
      cycleDepth: workflowState.cycleDepth || 0,
      cycleStackLength: workflowState.cycleStack?.length || 0
    };
    scopes.push('variablePool');

    if (scopes.length === 0) {
      snapshot.shared = this.truncateForVarDump(workflowState, options);
      scopes.push('workflowState');
    }

    snapshot.metadata = {
      jobId: workflowState.jobId,
      pageUrl: workflowState.pageUrl,
      pageTitle: workflowState.pageTitle,
      workflowId: workflowState.workflowId,
      timestamp: new Date().toISOString()
    };

    return { snapshot, scopes, statistics };
  }

  truncateForVarDump(value, options, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string') {
      const limit = options.maxStringLength ?? 1000;
      return value.length > limit ? `${value.slice(0, limit)}…` : value;
    }

    if (typeof value !== 'object') {
      return value;
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    const maxDepth = options.maxDepth ?? 4;
    if (depth >= maxDepth) {
      if (Array.isArray(value)) {
        return `[Array(${value.length})]`;
      }
      return `[Object keys=${Object.keys(value).length}]`;
    }

    if (Array.isArray(value)) {
      const maxItems = options.maxArrayLength ?? 20;
      const sliced = value.slice(0, maxItems).map(item =>
        this.truncateForVarDump(item, options, depth + 1, seen)
      );
      if (value.length > maxItems) {
        sliced.push(`… +${value.length - maxItems} more`);
      }
      return sliced;
    }

    const result = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = this.truncateForVarDump(val, options, depth + 1, seen);
    }
    return result;
  }

  createVarDumpPreview(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      return [];
    }

    return Object.entries(snapshot)
      .filter(([scope]) => scope !== 'metadata')
      .map(([scope, value]) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return {
            scope,
            keys: Object.keys(value).slice(0, 10)
          };
        }
        if (Array.isArray(value)) {
          return {
            scope,
            keys: [`Array(${value.length})`]
          };
        }
        return {
          scope,
          keys: [typeof value]
        };
      });
  }

  /**
   * Apply filter to response data
   */
  applyFilter(data, filter) {
    // Basic filtering implementation - can be enhanced
    if (filter.startsWith('.') && data && typeof data === 'object') {
      const path = filter.substring(1).split('.');
      let result = data;
      for (const key of path) {
        if (result && typeof result === 'object') {
          result = result[key];
        } else {
          return null;
        }
      }
      return result;
    }
    return data;
  }

  /**
   * Get nested value from object using dot notation
   */
  getNestedValue(obj, path) {
    if (!obj || !path) return undefined;
    
    return path.split('.').reduce((current, key) => {
      if (!current || current[key] === undefined) return undefined;
      
      const value = current[key];
      
      // If value is in structured format {value: ..., namespace: ...}, extract the value
      if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value && 'namespace' in value) {
        return value.value;
      }
      
      return value;
    }, obj);
  }

  /**
   * Execute self-adjustable AI workflow step
   * Retries failed script execution with modified prompts up to a configurable number of times
   */
  async executeSelfAdjustableAIWorkflowStep(page, step, workflowState, jobId, pageId, projectId) {
    console.log(`🔄 Executing self-adjustable AI workflow step (${step.name})`);
    
    // Get configuration
    const config = step.config || {};
    const maxRetries = config.maxRetries ?? 3;
    const explanation = config.explanation || '';
    const includeContext = config.includeContext ?? true;
    const includeError = config.includeError ?? true;
    const includePreviousScript = config.includePreviousScript ?? true;
    const includeScreenshot = config.includeScreenshot ?? true;
    const includeHTML = config.includeHTML ?? true;
    
    // Get retry count from workflow state or initialize
    const retryCount = workflowState.selfAdjustableRetryCount || 0;
    
    // Check if we've exceeded max retries
    if (retryCount >= maxRetries) {
      console.log(`❌ Max retries (${maxRetries}) exceeded for self-adjustable AI workflow`);
      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'error',
        message: `Max retries (${maxRetries}) exceeded for self-adjustable AI workflow`,
        component: 'WORKFLOW-STEP',
        metadata: { step: step.name, retryCount, maxRetries }
      }, {
        headers: this.getAuthHeaders()
      });
      throw new Error(`Max retries (${maxRetries}) exceeded`);
    }
    
    // Check if there was a previous script failure
    const lastFailure = workflowState.lastScriptFailure;
    if (!lastFailure) {
      console.log(`ℹ️ No previous script failure found, skipping retry`);
      return;
    }
    
    console.log(`🔄 Retry ${retryCount + 1}/${maxRetries} for failed script execution`);
    
    // Log retry attempt
    await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
      jobId: jobId,
      level: 'info',
      message: `🔄 Self-adjustable AI workflow retry ${retryCount + 1}/${maxRetries}`,
      component: 'WORKFLOW-STEP',
      metadata: {
        step: step.name,
        retryCount: retryCount + 1,
        maxRetries,
        previousError: lastFailure.error,
        explanation
      }
    }, {
      headers: this.getAuthHeaders()
    });
    
    // Use the script generation step from the failure info (exact step that generated the failed script)
    const scriptGenerationStep = lastFailure.scriptGenerationStep;
    const scriptGenerationStepIndex = lastFailure.scriptGenerationStepIndex;
    
    if (!scriptGenerationStep || scriptGenerationStepIndex === null) {
      console.error(`❌ No script generation step found in failure info`);
      throw new Error('No script generation step found in failure info');
    }
    
    console.log(`📍 Found script generation step at index ${scriptGenerationStepIndex}: ${scriptGenerationStep.name || scriptGenerationStep.id}`);
    
    // Get current page state for retry
    const pageUrl = page.url();
    const pageTitle = await page.title().catch(() => '');
    let htmlContent = null;
    let screenshotBase64 = null;
    
    if (includeHTML) {
      htmlContent = await page.content().catch(() => null);
    }
    
    if (includeScreenshot) {
      try {
        const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
        screenshotBase64 = screenshot.toString('base64');
      } catch (e) {
        console.warn(`⚠️ Failed to capture screenshot: ${e.message}`);
      }
    }
    
    // Modify the prompt for retry
    const originalTemplate = scriptGenerationStep.config?.template || 
                            scriptGenerationStep.config?.user_message_template || 
                            '';
    
    if (!originalTemplate) {
      console.error(`❌ No template found in script generation step`);
      throw new Error('No template found in script generation step');
    }
    
    const modifiedPrompt = this.modifyPromptForRetry(
      originalTemplate,
      {
        retryNumber: retryCount + 1,
        maxRetries,
        previousError: lastFailure.error,
        explanation,
        previousScript: includePreviousScript ? lastFailure.script : null,
        includeContext,
        includeError,
        includeScreenshot,
        includeHTML,
        htmlContent,
        screenshotBase64,
        pageUrl,
        pageTitle
      },
      workflowState
    );
    
    // Create a new workflow for this page with modified prompt
    const newWorkflowName = `AI-Generated Workflow - Retry ${retryCount + 1} - ${new Date().toISOString()}`;
    const newWorkflow = {
      name: newWorkflowName,
      description: `Auto-generated workflow for retry ${retryCount + 1} after script execution failure`,
      type: 'page',
      project_id: projectId,
      page_id: pageId,
      is_ai_generated: true,
      parent_workflow_id: this.workflowTemplate._id,
      retry_number: retryCount + 1,
      folder: 'AI-generated workflows',
      steps: this.workflowTemplate.steps.map(s => {
        if (s.id === scriptGenerationStep.id || s.name === scriptGenerationStep.name) {
          // Modify the script generation step with new prompt
          return {
            ...s,
            config: {
              ...s.config,
              template: modifiedPrompt,
              user_message_template: modifiedPrompt
            }
          };
        }
        return s;
      })
    };
    
    // Store the new workflow in MongoDB
    try {
      const workflowResponse = await axios.post(
        `${this.backendUrl}/api/workflow-templates`,
        newWorkflow,
        {
          headers: this.getAuthHeaders()
        }
      );
      
      const newWorkflowId = workflowResponse.data._id;
      console.log(`✅ Created new AI-generated workflow: ${newWorkflowId}`);
      
      // Update workflow state with new workflow ID
      workflowState.aiGeneratedWorkflowId = newWorkflowId;
      workflowState.selfAdjustableRetryCount = retryCount + 1;
      
      // Log workflow creation
      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'info',
        message: `✅ Created new AI-generated workflow for retry ${retryCount + 1}`,
        component: 'WORKFLOW-STEP',
        metadata: {
          step: step.name,
          workflowId: newWorkflowId,
          workflowName: newWorkflowName,
          retryCount: retryCount + 1,
          parentWorkflowId: this.workflowTemplate._id
        }
      }, {
        headers: this.getAuthHeaders()
      });
      
      // Load the new workflow and continue execution from the script generation step
      const newWorkflowResponse = await axios.get(
        `${this.backendUrl}/api/workflow-templates/${newWorkflowId}`,
        {
          headers: this.getAuthHeaders()
        }
      );
      
      const newWorkflowTemplate = newWorkflowResponse.data;
      
      // Update the current workflow template to use the new one
      this.workflowTemplate = newWorkflowTemplate;
      
      // Set flag to continue from the script generation step (where we'll regenerate the script)
      workflowState.shouldRetryFromStep = scriptGenerationStepIndex;
      workflowState.retryWorkflowId = newWorkflowId;
      
      console.log(`🔄 Loaded new workflow, will continue from step ${scriptGenerationStepIndex} (script generation step)`);
      
      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'info',
        message: `🔄 Continuing execution from step ${scriptGenerationStepIndex} with new adjusted workflow`,
        component: 'SELF-ADJUSTABLE-WORKFLOW',
        metadata: {
          retry_from_step: scriptGenerationStepIndex,
          new_workflow_id: newWorkflowId,
          page_id: pageId
        }
      }, {
        headers: this.getAuthHeaders()
      });
      
      // Continue execution from the script generation step
      // We need to re-execute from that step with the new workflow
      // This will be handled by the main workflow execution loop
      // by checking workflowState.shouldRetryFromStep
      
      return {
        success: true,
        workflowId: newWorkflowId,
        retryCount: retryCount + 1,
        shouldRetryFromStep: scriptGenerationStepIndex,
        message: `Created new workflow for retry ${retryCount + 1}, continuing from step ${scriptGenerationStepIndex}`
      };
    } catch (error) {
      console.error(`❌ Failed to create new workflow: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Modify prompt for retry with additional context
   */
  modifyPromptForRetry(originalTemplate, retryContext, workflowState) {
    let modifiedPrompt = originalTemplate;
    
    // Add workflow system context first, so OpenAI understands the system
    modifiedPrompt += `\n\n--- WORKFLOW SYSTEM CONTEXT ---\n`;
    modifiedPrompt += `You are part of an automated testing workflow system. Here's how it works:\n`;
    modifiedPrompt += `1. The system analyzes web pages and creates test workflows automatically.\n`;
    modifiedPrompt += `2. You generate Playwright scripts to interact with page elements.\n`;
    modifiedPrompt += `3. The system executes these scripts in a real browser.\n`;
    modifiedPrompt += `4. If a script fails, the system adjusts the workflow and retries.\n`;
    modifiedPrompt += `5. Each workflow consists of multiple steps executed in sequence.\n`;
    modifiedPrompt += `6. The current step is part of a larger workflow that tests page functionality.\n`;
    modifiedPrompt += `7. Your script will be executed immediately after generation, so it must be correct and complete.\n`;
    modifiedPrompt += `8. The script must handle page loading, element selection, and interactions properly.\n`;
    modifiedPrompt += `9. Consider timing issues, dynamic content, and element availability.\n`;
    modifiedPrompt += `10. The script should be robust and handle edge cases.\n\n`;
    
    // Add retry context
    if (retryContext.includeError && retryContext.previousError) {
      modifiedPrompt += `--- RETRY CONTEXT ---\n`;
      modifiedPrompt += `⚠️ IMPORTANT: This is retry attempt ${retryContext.retryNumber} of ${retryContext.maxRetries}.\n`;
      modifiedPrompt += `The previous script execution FAILED with the following error:\n`;
      modifiedPrompt += `Error: ${retryContext.previousError}\n\n`;
      
      if (retryContext.previousScript && retryContext.includePreviousScript) {
        modifiedPrompt += `The previous script that failed was:\n`;
        modifiedPrompt += `\`\`\`javascript\n${retryContext.previousScript}\n\`\`\`\n\n`;
        modifiedPrompt += `Please analyze what went wrong with this script and why it failed.\n`;
        modifiedPrompt += `Common issues include:\n`;
        modifiedPrompt += `- Wrong selectors (element not found or changed)\n`;
        modifiedPrompt += `- Timing issues (element not ready when accessed)\n`;
        modifiedPrompt += `- Element not visible or not interactable\n`;
        modifiedPrompt += `- Page structure changed or element moved\n`;
        modifiedPrompt += `- JavaScript errors in the script\n`;
        modifiedPrompt += `- Network issues or page not loaded\n\n`;
      }
      
      if (retryContext.explanation) {
        modifiedPrompt += `Additional context from workflow configuration: ${retryContext.explanation}\n\n`;
      }
      
      modifiedPrompt += `Current page state:\n`;
      modifiedPrompt += `- URL: ${retryContext.pageUrl}\n`;
      modifiedPrompt += `- Title: ${retryContext.pageTitle}\n`;
      
      if (retryContext.htmlContent && retryContext.includeHTML) {
        modifiedPrompt += `- HTML structure (first 5000 chars): ${retryContext.htmlContent.substring(0, 5000)}...\n`;
      }
      
      modifiedPrompt += `\n--- YOUR TASK ---\n`;
      modifiedPrompt += `Based on the error analysis and current page state, generate an IMPROVED Playwright script that:\n`;
      modifiedPrompt += `1. Addresses the specific failure from the previous attempt\n`;
      modifiedPrompt += `2. Uses more robust selectors and error handling\n`;
      modifiedPrompt += `3. Handles timing and element availability properly\n`;
      modifiedPrompt += `4. Is complete and ready to execute\n`;
      modifiedPrompt += `5. Follows Playwright best practices\n`;
      modifiedPrompt += `\nThe script must be valid JavaScript that can be executed directly in a Playwright page context.\n`;
      modifiedPrompt += `Do not include explanations or comments that are not executable code.\n`;
    }
    
    return modifiedPrompt;
  }

  /**
   * Upsert script to scripts collection for tracking
   */
  async upsertScriptToCollection(scriptCode, parsedResponse, step, workflowState, jobId, stepContext = null) {
    try {
      // Get page_id and project_id from workflowState or context
      const pageId = workflowState.pageId || this.context?.page_id || stepContext?.pageId;
      const projectId = workflowState.projectId || this.context?.project_id || stepContext?.projectId;
      
      if (!pageId || !projectId) {
        console.warn(`⚠️ Cannot upsert script: missing pageId or projectId (pageId: ${pageId}, projectId: ${projectId})`);
        return;
      }

      // Get journey and action information from workflowState
      const currentJourney = workflowState.currentLeg || workflowState.currentJourney || workflowState.legsToExecute?.[workflowState.currentLegIndex];
      const journeyId = currentJourney?.journey_id || currentJourney?.leg_id || currentJourney?.id;
      const actionId = currentJourney?.action_id || stepContext?.action_id;

      // Build script name and description
      const scriptName = parsedResponse.name || 
                        parsedResponse.description?.substring(0, 100) ||
                        step.name || 
                        step.id || 
                        `Script for ${journeyId || 'journey'}`;
      const scriptDescription = parsedResponse.description || 
                                parsedResponse.expected_result ||
                                `Generated script for ${step.name || step.id}`;

      // Build script data
      const scriptData = {
        project_id: projectId,
        page_id: pageId,
        action_id: actionId || null,
        name: scriptName,
        description: scriptDescription,
        script_type: 'playwright',
        script_code: scriptCode,
        parameters: parsedResponse.parameters || {},
        generated_by: 'ai',
        ai_prompt: step.config?.user_message_template || step.config?.prompt || null,
        ai_model: 'gpt-5-mini',
        generation_date: new Date(),
        expected_outcome: parsedResponse.expected_result || parsedResponse.expected_outcome || null,
        validation_rules: parsedResponse.validation_rules || [],
        status: 'active',
        tags: [step.id, step.name].filter(Boolean),
        updated_at: new Date()
      };

      // Try to find existing script by page_id, journey_id, and action_id
      const findQuery = {
        project_id: projectId,
        page_id: pageId,
        status: { $ne: 'archived' }
      };
      if (journeyId) {
        findQuery['tags'] = { $in: [journeyId] };
      }
      if (actionId) {
        findQuery.action_id = actionId;
      }

      // Use backend API to upsert script
      const backendUrl = this.backendUrl || process.env.BACKEND_URL || 'http://back:4000';
      
      // First try to find existing script
      const authHeaders = this.getAuthHeaders();
      const findResponse = await fetch(`${backendUrl}/api/scripts?project_id=${projectId}&page_id=${pageId}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        }
      });

      let existingScript = null;
      if (findResponse.ok) {
        const scripts = await findResponse.json();
        // Find script matching journey/action
        existingScript = scripts.find(s => {
          if (actionId && s.action_id?.toString() === actionId.toString()) return true;
          if (journeyId && s.tags?.includes(journeyId)) return true;
          if (s.name === scriptName) return true;
          return false;
        });
      }

      if (existingScript) {
        // Update existing script
        const updateResponse = await fetch(`${backendUrl}/api/scripts/${existingScript._id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders
          },
          body: JSON.stringify({
            ...scriptData,
            execution_count: existingScript.execution_count || 0,
            last_executed_at: existingScript.last_executed_at,
            last_result: existingScript.last_result,
            success_rate: existingScript.success_rate || 0,
            created_at: existingScript.created_at
          })
        });

        if (updateResponse.ok) {
          console.log(`✅ Updated existing script in collection: ${existingScript._id}`);
        } else {
          console.warn(`⚠️ Failed to update script: ${updateResponse.statusText}`);
        }
      } else {
        // Create new script
        scriptData.created_at = new Date();
        scriptData.execution_count = 0;
        scriptData.last_executed_at = null;
        scriptData.last_result = null;
        scriptData.success_rate = 0;

        const createResponse = await fetch(`${backendUrl}/api/scripts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders
          },
          body: JSON.stringify(scriptData)
        });

        if (createResponse.ok) {
          const newScript = await createResponse.json();
          console.log(`✅ Created new script in collection: ${newScript._id}`);
        } else {
          const errorText = await createResponse.text();
          console.warn(`⚠️ Failed to create script: ${createResponse.statusText} - ${errorText}`);
        }
      }
    } catch (error) {
      console.warn(`⚠️ Error upserting script to collection: ${error.message}`);
      // Don't throw - script is still stored in workflowState
    }
  }
}

export default WorkflowAnalyzer;


// Force rebuild Wed 15 Oct 2025 23:26:24 AEDT
// Force rebuild Tue 28 Oct 2025 15:43:46 AEDT

