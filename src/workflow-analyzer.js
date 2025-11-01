import axios from 'axios';
import { StaticNodeExecutor } from './static-node-executor.js';

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
    console.log(`[WorkflowAnalyzer] 🔍 Context received:`, JSON.stringify(this.context, null, 2));
    if (!this.context.workflow_template_id) {
      console.error(`[WorkflowAnalyzer] ❌ No workflow template ID provided - workflows are mandatory!`);
      console.error(`[WorkflowAnalyzer] ❌ Context keys:`, Object.keys(this.context));
      throw new Error('workflow_template_id is required - all jobs must use workflows stored in MongoDB');
    }

    try {
      if (this.workflowTemplate && (this.workflowTemplate._id?.toString() === this.context.workflow_template_id)) {
        return this.workflowTemplate;
      }

      const response = await axios.get(`${this.backendUrl}/api/workflow-templates/${this.context.workflow_template_id}`);
      this.workflowTemplate = response.data;
      console.log(`[WorkflowAnalyzer] ✅ Loaded workflow: "${this.workflowTemplate.name}" (ID: ${this.context.workflow_template_id})`);
      console.log(`[WorkflowAnalyzer] 📄 Workflow contains ${this.workflowTemplate.prompts?.length || 0} prompts`);
      
      // Log workflow usage
      if (this.workflowTemplate.prompts && this.workflowTemplate.prompts.length > 0) {
        console.log(`[WorkflowAnalyzer] 📝 Custom prompts in template:`);
        this.workflowTemplate.prompts.forEach(p => {
          console.log(`[WorkflowAnalyzer]    - ${p.name}: ${p.template?.substring(0, 80)}...`);
        });
      }
      
      await this.logWorkflowDecision(
        `Using workflow: "${this.workflowTemplate.name}" (ID: ${this.context.workflow_template_id})`,
        `Workflow contains ${this.workflowTemplate.prompts?.length || 0} prompts`
      );

      this.workflowCapabilities = this.detectCapabilities(this.workflowTemplate.steps || []);
      console.log(`[WorkflowAnalyzer] ⚙️ Workflow capabilities:`, JSON.stringify(this.workflowCapabilities));
      
      return this.workflowTemplate;
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Failed to load workflow template: ${error.message}`);
      throw new Error(`Failed to load workflow template ${this.context.workflow_template_id}: ${error.message}`);
    }
  }

  detectCapabilities(steps = []) {
    const stepList = Array.isArray(steps) ? steps : [];
    const hasStep = (...types) => stepList.some(step => types.includes(step.type));

    const capabilities = {
      hasSteps: stepList.length > 0,
      usesPlaywrightAnalysis: hasStep('playwright-analysis', 'workflow-analysis', 'hardcoded-workflow-analysis', 'page-discovery'),
      usesAIModel: hasStep('ai-request', 'ai-prompt', 'page-description', 'workflow-analysis', 'hardcoded-workflow-analysis', 'create-workflow', 'update-workflow'),
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
   * Get prompt template by name from workflow template
   * Supports both legacy prompts array and new steps array
   */
  getPromptTemplate(promptName) {
    if (!this.workflowTemplate) {
      console.log(`[WorkflowAnalyzer] 📋 No workflow template loaded, using DEFAULT prompt from database: "${promptName}"`);
      return null;
    }

    // Check new steps array first
    if (this.workflowTemplate.steps && Array.isArray(this.workflowTemplate.steps)) {
      const step = this.workflowTemplate.steps.find(s => 
        s.config?.prompt === promptName || 
        s.prompt_slug === promptName ||
        s.name === promptName
      );
      
      if (step && step.config?.template) {
        console.log(`[WorkflowAnalyzer] ✅ Using CUSTOM prompt from workflow template step: "${step.name}"`);
        console.log(`[WorkflowAnalyzer] 📝 Prompt text: ${step.config.template.substring(0, 100)}...`);
        return step.config.template;
      }
    }

    // Fallback to legacy prompts array
    if (this.workflowTemplate.prompts && Array.isArray(this.workflowTemplate.prompts)) {
      const prompt = this.workflowTemplate.prompts.find(p => p.name === promptName);
      if (prompt && prompt.template) {
        console.log(`[WorkflowAnalyzer] ✅ Using CUSTOM prompt from legacy workflow template: "${promptName}"`);
        console.log(`[WorkflowAnalyzer] 📝 Prompt text: ${prompt.template.substring(0, 100)}...`);
        return prompt.template;
      }
    }

    console.log(`[WorkflowAnalyzer] 📋 Prompt "${promptName}" not found in template, using DEFAULT from database`);
    return null;
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
    console.log(`[WorkflowAnalyzer] Analyzing page: ${page.url()}`);

    // Load workflow template - MANDATORY
    await this.loadWorkflowTemplate();

    // Validate workflow template has steps
    if (!this.workflowTemplate || !this.workflowTemplate.steps || this.workflowTemplate.steps.length === 0) {
      throw new Error(`Workflow template "${this.context.workflow_template_id}" has no steps defined. All analysis must be defined in workflow template steps.`);
    }

    console.log(`[WorkflowAnalyzer] 🎯 Executing workflow template: "${this.workflowTemplate.name}"`);
    console.log(`[WorkflowAnalyzer] 📋 Workflow template has ${this.workflowTemplate.steps.length} steps to execute`);

    // Execute workflow template steps ONLY
    try {
      const results = await this.executeWorkflowSteps(page, jobId, pageId, projectId);
      console.log(`[WorkflowAnalyzer] ✅ Workflow template steps completed successfully`);
      
      return results;
    } catch (stepError) {
      console.error(`[WorkflowAnalyzer] ❌ Workflow template execution failed:`, stepError);
      throw new Error(`Workflow execution failed: ${stepError.message}`);
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
      // Extract forms
      const forms = await page.$$('form');
      for (const form of forms) {
        const inputs = await form.$$('input, textarea, select');
        const buttons = await form.$$('button, input[type="submit"]');
        
        // Get selectors with all strategies
        const formSelectors = await this.getElementSelector(form);
        const formData = {
          selector: formSelectors[0]?.selector, // Use primary selector for backward compatibility
          selectors: formSelectors, // Store all strategies for robust matching
          action: await form.getAttribute('action'),
          method: await form.getAttribute('method'),
          fields: []
        };

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
            selector: inputSelectors[0]?.selector, // Primary selector
            selectors: inputSelectors // All strategies
          });
        }

        formData.buttons = [];
        for (const button of buttons) {
          const text = await button.textContent();
          const buttonSelectors = await this.getElementSelector(button);
          formData.buttons.push({
            text: text?.trim(),
            selector: buttonSelectors[0]?.selector, // Primary selector
            selectors: buttonSelectors // All strategies
          });
        }

        analysis.forms.push(formData);
      }

      // Extract links (excluding anchors - they should not be separate pages)
      const links = await page.$$('a[href]');
      for (const link of links.slice(0, 50)) { // Limit to first 50 links
        const href = await link.getAttribute('href');
        const text = await link.textContent();
        
        // FIXED: Exclude anchor links (#) - they should not be treated as separate pages
        // Only include external links and internal page links, not anchors
        if (href && 
            !href.startsWith('javascript:') && 
            !href.startsWith('#') && 
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

    } catch (error) {
      console.error('[WorkflowAnalyzer] Error during Playwright analysis:', error);
    }

    return analysis;
  }

  generateLegsFromPlaywrightAnalysis(playwrightAnalysis = {}, pageUrl = '') {
    const legs = [];
    const forms = Array.isArray(playwrightAnalysis.forms) ? playwrightAnalysis.forms.slice(0, 20) : [];
    const interactiveElements = Array.isArray(playwrightAnalysis.interactive_elements)
      ? playwrightAnalysis.interactive_elements.slice(0, 20)
      : [];
    const links = Array.isArray(playwrightAnalysis.links) ? playwrightAnalysis.links.slice(0, 30) : [];

    forms.forEach((form, index) => {
      const legId = `auto-form-${index + 1}`;
      legs.push({
        leg_id: legId,
        type: 'form_submit',
        action: 'submit_form',
        description: `Submit detected form #${index + 1}`,
        test_instructions: 'Fill detected fields with sample data and submit the form. Confirm that the page responds with a success state or expected validation.',
        element_info: {
          selector: form.selector,
          selectors: form.selectors || [],
          fields: form.fields || [],
          buttons: form.buttons || [],
          method: form.method || 'get',
          action: form.action || null
        },
        confidence: 0.6,
        status: 'pending',
        metadata: {
          generated_by: 'playwright-analysis',
          source: 'form'
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

        const legId = `auto-link-${index + 1}`;
        legs.push({
          leg_id: legId,
          type: 'navigate',
          action: 'navigate',
          description: `Follow link #${index + 1} to ${link.href}`,
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
      });
    }

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

  createFallbackPageDescription(stats = {}, workflowState = {}) {
    const title = workflowState.pageTitle || workflowState.pageUrl || 'Page';
    const url = workflowState.pageUrl || '';
    const summaryParts = [];

    if (typeof stats.forms === 'number') summaryParts.push(`${stats.forms} form${stats.forms === 1 ? '' : 's'}`);
    if (typeof stats.links === 'number') summaryParts.push(`${stats.links} link${stats.links === 1 ? '' : 's'}`);
    if (typeof stats.interactive === 'number') summaryParts.push(`${stats.interactive} interactive element${stats.interactive === 1 ? '' : 's'}`);

    const shortDescription = summaryParts.length
      ? `${title} (${summaryParts.join(', ')})`
      : title;

    const fullDescription = `Automatically generated summary for ${url || 'the current page'}. The crawler detected ${summaryParts.join(', ') || 'no significant interactive elements'} during Playwright analysis.`;

    return {
      short_description: shortDescription,
      full_description: fullDescription,
      purpose: 'auto-generated summary from crawler analysis',
      conversation_context: 'Generated without AI prompt execution'
    };
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
      console.error('[WorkflowAnalyzer] Error generating selectors:', error);
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
      const message = `📄 Page Analysis: ${pageDescription.short_description}`;
      
      const logMetadata = {
        page_analysis: true,
        page_title: pageTitle,
        page_url: pageUrl,
        short_description: pageDescription.short_description,
        full_description: pageDescription.full_description,
        purpose: pageDescription.purpose,
        conversation_context: pageDescription.conversation_context,
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
      
      // 2. Screenshot attachment (store reference, not full base64)
      if (screenshotBase64) {
        attachments.push({
          type: 'screenshot',
          filename: `page_screenshot_${Date.now()}.png`,
          content: screenshotBase64,  // Full base64 for display
          mimeType: 'image/png',
          size: screenshotBase64.length,
          timestamp: new Date().toISOString()
        });
      }
      
      // Use backend logger to append job log with attachments
      console.log(`[WorkflowAnalyzer] Sending ${attachments.length} attachments:`, attachments.map(a => `${a.type} (${a.size} bytes)`));
      
      const response = await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'info',
        message: message,
        component: 'PAGE-ANALYZER',
        metadata: logMetadata,
        attachments: attachments
      });
      
      console.log(`[WorkflowAnalyzer] Page description logged to job history with ${attachments.length} attachments`);
      return response.data;
    } catch (error) {
      console.error('[WorkflowAnalyzer] Error logging page description:', error.message);
      // Don't throw - this is not critical
    }
  }

  /**
   * Create workflow document via backend API
   */
  async createWorkflow(pageId, projectId, url, playwrightAnalysis) {
    try {
      const response = await axios.post(`${this.backendUrl}/api/workflows`, {
        page_id: pageId,
        project_id: projectId,
        url: url,
        playwright_analysis: playwrightAnalysis
      }, {
        headers: this.getAuthHeaders()
      });

      return response.data;
    } catch (error) {
      console.error('[WorkflowAnalyzer] Error creating workflow:', error.message);
      throw error;
    }
  }

  /**
   * Update workflow with AI analysis and legs
   * Also creates action documents for each leg
   */
  async updateWorkflowWithAnalysis(workflowId, pageDescription, legs, createActions = true) {
    try {
      const response = await axios.put(
        `${this.backendUrl}/api/workflows/${workflowId}/analysis`,
        {
          ai_analysis: {
            page_description: pageDescription,
            analyzed_at: new Date().toISOString()
          },
          legs: legs,
          create_actions: createActions  // Signal backend to create action documents
        },
        {
          headers: this.getAuthHeaders()
        }
      );

      return response.data;
    } catch (error) {
      console.error('[WorkflowAnalyzer] Error updating workflow:', error.message);
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
        console.error('[WorkflowAnalyzer] Missing required fields for page discovery:', {
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
      
      console.log(`[WorkflowAnalyzer] Page discovery updated: ${url} (${response.data.isNew ? 'new' : 'updated'})`);
      return response.data;
    } catch (error) {
      console.error('[WorkflowAnalyzer] Error updating page discovery:', error.message);
      if (error.response) {
        console.error('[WorkflowAnalyzer] Response status:', error.response.status);
        console.error('[WorkflowAnalyzer] Response data:', error.response.data);
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
      
      console.log(`[WorkflowAnalyzer] 📝 Logged workflow: ${decision}`);
    } catch (error) {
      console.error('[WorkflowAnalyzer] Error logging workflow decision:', error.message);
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
        component: 'WORKFLOW-ANALYZER',
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
      
      console.log(`[WorkflowAnalyzer] 📝 Logged prompt usage: ${promptName} (${source})`);
    } catch (error) {
      console.error('[WorkflowAnalyzer] Error logging prompt usage:', error.message);
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
        message: `🔧 [${step.type.toUpperCase()}] Executing step: "${step.name || step.type}" with params: ${JSON.stringify(stepConfig)}`,
        component: 'WORKFLOW-STEP',
        metadata: logData
      }, {
        headers: this.getAuthHeaders()
      });

      console.log(`[WorkflowAnalyzer] 📋 STEP PARAMS: ${JSON.stringify(stepConfig, null, 2)}`);
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ⚠️ Failed to log step execution: ${error.message}`);
    }
  }

  /**
   * Log step outcome with summary metadata
   */
  async logStepOutcome(step, jobId, message, metadata = {}, level = 'info') {
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
        }
      }, {
        headers: this.getAuthHeaders()
      });
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ⚠️ Failed to log step outcome: ${error.message}`);
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
    console.log(`[WorkflowAnalyzer] ═══════════════════════════════════════════════════════`);
    console.log(`[WorkflowAnalyzer] 🔄 EXECUTING WORKFLOW TEMPLATE STEPS`);
    console.log(`[WorkflowAnalyzer] ═══════════════════════════════════════════════════════`);
    
    // Initialize workflow state
    const workflowState = {
      pageTitle: null,
      pageUrl: page.url(),
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
      inputCredentials: this.context?.credentials || {
        username: this.context?.username || null,
        password: this.context?.password || null
      }
    };
    
    // Execute each step in sequence
    for (let i = 0; i < this.workflowTemplate.steps.length; i++) {
      const step = this.workflowTemplate.steps[i];
      console.log(`[WorkflowAnalyzer] ═══════════════════════════════════════════════════════`);
      console.log(`[WorkflowAnalyzer] 🔄 EXECUTING STEP ${i + 1}/${this.workflowTemplate.steps.length}: ${step.name}`);
      console.log(`[WorkflowAnalyzer] Type: ${step.type}`);
      console.log(`[WorkflowAnalyzer] ═══════════════════════════════════════════════════════`);
      
      try {
        // Log step execution with parameters
        await this.logStepExecution(step, jobId);
        
        switch (step.type) {
          case 'screenshot':
            await this.executeScreenshotStep(page, step, workflowState, jobId, pageId);
            break;
            
          case 'playwright-analysis':
            await this.executePlaywrightAnalysisStep(page, step, workflowState, jobId);
            break;
            
          case 'page-description':
            await this.executePageDescriptionStep(page, step, workflowState, jobId);
            break;
            
          case 'ai-prompt':
            await this.executeAIPromptStep(page, step, workflowState, jobId);
            break;
            
          case 'workflow-analysis':
            await this.executeWorkflowAnalysisStep(page, step, workflowState, jobId);
            break;
          
          // Deterministic, hardcoded analysis for specific domains (e.g., Practical Test Automation)
          case 'hardcoded-workflow-analysis':
            await this.executeHardcodedWorkflowAnalysisStep(page, step, workflowState, jobId);
            break;
            
          case 'create-workflow':
            await this.executeCreateWorkflowStep(step, workflowState, pageId, projectId, jobId);
            break;
            
          case 'update-workflow':
            await this.executeUpdateWorkflowStep(step, workflowState, jobId);
            break;
            
          case 'page-discovery':
            await this.executePageDiscoveryStep(step, workflowState, jobId, pageId, projectId);
            break;
            
          case 'execute-code':
            await this.executeCodeStep(page, step, workflowState);
            break;
            
          case 'execute-code-from-variable':
            await this.executeCodeFromVariableStep(page, step, workflowState);
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
            
          case 'validate-response':
            await this.executeValidateResponseStep(step, workflowState);
            break;
            
          case 'filter-response':
            await this.executeFilterResponseStep(step, workflowState);
            break;
            
          case 'cycle-start':
            console.log(`[WorkflowAnalyzer] 🔄 Starting cycle (${step.name})`);
            break;
            
          case 'cycle-end':
            console.log(`[WorkflowAnalyzer] 🔚 Ending cycle (${step.name})`);
            break;
            
          case 'conditional':
            await this.executeConditionalStep(step, workflowState);
            break;
            
          case 'print':
            await this.executePrintStep(step, workflowState, jobId);
            break;
            
          case 'sleep':
            await this.executeSleepStep(step, workflowState);
            break;
            
          default:
            console.log(`[WorkflowAnalyzer] ⚠️ Unknown step type: ${step.type}`);
        }
        
        // Add delay between steps
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (stepError) {
        console.error(`[WorkflowAnalyzer] ❌ Step ${i + 1} failed: ${stepError.message}`);
        // Continue with next step unless it's critical
        if (step.config?.critical) {
          throw stepError;
        }
      }
    }
    
    console.log(`[WorkflowAnalyzer] ═══════════════════════════════════════════════════════`);
    console.log(`[WorkflowAnalyzer] ✅ ALL WORKFLOW STEPS COMPLETED`);
    console.log(`[WorkflowAnalyzer] ═══════════════════════════════════════════════════════`);
    
    // Return workflow results
    return {
      workflow_id: workflowState.workflowId,
      legs_count: workflowState.legs.length,
      page_description: workflowState.pageDescription,
      legs: workflowState.legs,
      ai_analysis: workflowState.aiAnalysisResult
    };
  }

  /**
   * Execute hardcoded workflow analysis step
   * Reproduces deterministic page analysis: pages → actions → elements
   * Tailored for domains like practicaltestautomation.com to avoid heavy AI usage
   */
  async executeHardcodedWorkflowAnalysisStep(page, step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 🧩 Performing hardcoded workflow analysis (${step.name})`);
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
      console.log(`[WorkflowAnalyzer] ℹ️ Hardcoded analysis skipped (domain not matched, use config.force=true to override)`);
      return;
    }

    const legs = this.generateLegsFromPlaywrightAnalysis(workflowState.playwrightAnalysis, url);

    if (legs.length === 0) {
      console.log(`[WorkflowAnalyzer] ⚠️ Hardcoded analysis produced no legs`);
      return;
    }

    workflowState.legs = legs;
    workflowState.aiAnalysisResult = workflowState.aiAnalysisResult || {};
    workflowState.aiAnalysisResult.page_description = workflowState.aiAnalysisResult.page_description || workflowState.pageDescription || null;
    workflowState.aiAnalysisResult.legs = legs;
    console.log(`[WorkflowAnalyzer] ✅ Hardcoded analysis completed: ${legs.length} legs identified`);
  }

  /**
   * Execute screenshot step
   */
  async executeScreenshotStep(page, step, workflowState, jobId, pageId) {
    console.log(`[WorkflowAnalyzer] 📸 Taking screenshot (${step.name})`);
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

    console.log('[WorkflowAnalyzer] Screenshot options resolved:', screenshotOptions);

    const screenshot = await page.screenshot(screenshotOptions);

    workflowState.screenshotBase64 = screenshot.toString('base64');
    console.log(`[WorkflowAnalyzer] ✅ Screenshot taken (${screenshot.length} bytes)`);

    let uploaded = false;
    let publicUrl = null;
    let fileId = null;

    if (upload) {
      try {
        console.log(`[WorkflowAnalyzer] 📸 Requesting presigned URL for screenshot upload...`);

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
        console.log(`[WorkflowAnalyzer] ✅ Screenshot uploaded to MinIO: ${returnedUrl}`);

        if (pageId) {
          await axios.post(`${this.backendUrl}/api/pages/${pageId}/screenshot`, {
            fileId: workflowState.screenshotFileId,
            jobId: jobId
          }, {
            timeout: 10000,
            headers: this.getAuthHeaders()
          });

          console.log(`[WorkflowAnalyzer] ✅ Page ${pageId} updated with screenshot`);
        }
      } catch (error) {
        console.error(`[WorkflowAnalyzer] ❌ Failed to upload screenshot: ${error.message}`);
      }
    }

    this.storeStepResult(step, {
      size_bytes: screenshot.length,
      uploaded,
      fileId,
      publicUrl,
      fullPage,
      quality
    }, workflowState);

    await this.logStepOutcome(
      step,
      jobId,
      uploaded
        ? `📸 [SCREENSHOT] Uploaded screenshot (${screenshot.length} bytes)`
        : `📸 [SCREENSHOT] Captured screenshot locally (${screenshot.length} bytes)` ,
      {
        uploaded,
        fileId,
        fullPage,
        quality,
        size_bytes: screenshot.length
      }
    );
  }

  /**
   * Execute Playwright analysis step
   */
  async executePlaywrightAnalysisStep(page, step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 🔍 Performing Playwright analysis (${step.name})`);
    
    const analysis = await this.performPlaywrightAnalysis(page);
    workflowState.playwrightAnalysis = analysis;
    
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
  }

  /**
   * Execute page description step
   */
  async executePageDescriptionStep(page, step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 📝 Generating page description (${step.name})`);
    
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
    
    // Get prompt name from step configuration
    const promptName = step.config?.prompt || step.prompt_slug;
    if (!promptName) {
      throw new Error(`No prompt specified for step: ${step.name}`);
    }
    const customTemplate = this.getPromptTemplate(promptName);
    const promptSource = customTemplate ? 'workflow-template' : 'database';
    
    const descriptionPayload = {
      page_title: workflowState.pageTitle,
      page_url: workflowState.pageUrl,
      visible_text: workflowState.visibleText
    };

    const attachments = Array.isArray(step.config?.attachments)
      ? step.config.attachments
      : [];

    if (attachments.includes('interactive_elements') && workflowState.playwrightAnalysis?.interactive_elements) {
      descriptionPayload.interactive_elements = workflowState.playwrightAnalysis.interactive_elements.slice(0, 25);
    }

    if (attachments.includes('forms') && workflowState.playwrightAnalysis?.forms) {
      descriptionPayload.forms = workflowState.playwrightAnalysis.forms.slice(0, 15);
    }

    if (attachments.includes('links') && workflowState.playwrightAnalysis?.links) {
      descriptionPayload.links = workflowState.playwrightAnalysis.links.slice(0, 40);
    }
    
    // Log prompt usage
    await this.logPromptUsage(promptName, promptSource, customTemplate || 'Default from database', descriptionPayload);
    
    try {
      workflowState.pageDescription = await this.aiLogger.makeAICallWithPrompt(
        promptName,
        descriptionPayload,
        jobId,
        'page-descriptor',
        workflowState.pageUrl,
        null,
        descriptionPayload,
        customTemplate
      );
      
      console.log(`[WorkflowAnalyzer] ✅ Page description generated: ${workflowState.pageDescription.short_description}`);
      
      // Add to conversation history
      workflowState.conversationHistory.push({
        timestamp: new Date().toISOString(),
        action: 'page-description-generated',
        description: workflowState.pageDescription.short_description
      });
      
      // Log page description to job history
      await this.logPageDescription(jobId, workflowState.pageUrl, workflowState.pageTitle, workflowState.pageDescription, {
        visible_text_length: workflowState.visibleText.length,
        forms_count: workflowState.playwrightAnalysis?.forms?.length || 0,
        interactive_elements_count: workflowState.playwrightAnalysis?.interactive_elements?.length || 0
      }, workflowState.htmlContent, workflowState.screenshotBase64);

      this.storeStepResult(step, {
        description: workflowState.pageDescription,
        visible_text_length: workflowState.visibleText.length,
        attachments: step.config?.attachments || []
      }, workflowState);

      await this.logStepOutcome(
        step,
        jobId,
        `📝 [PAGE-DESCRIPTION] Generated summary: ${workflowState.pageDescription.short_description}`,
        {
          short_description: workflowState.pageDescription.short_description,
          attachments: step.config?.attachments || [],
          visible_text_length: workflowState.visibleText.length
        }
      );
      
    } catch (error) {
      console.warn(`[WorkflowAnalyzer] Failed to generate page description: ${error.message}`);
      workflowState.pageDescription = {
        short_description: `Page: ${workflowState.pageTitle}`,
        full_description: `Analysis of ${workflowState.pageUrl}`,
        purpose: 'Information page',
        conversation_context: 'Analyzing page structure and content'
      };

      this.storeStepResult(step, {
        description: workflowState.pageDescription,
        visible_text_length: workflowState.visibleText?.length || 0,
        attachments: step.config?.attachments || [],
        fallback: true,
        error: error.message
      }, workflowState);

      await this.logStepOutcome(
        step,
        jobId,
        `📝 [PAGE-DESCRIPTION] Fallback description generated due to error`,
        {
          error: error.message,
          fallback: true,
          short_description: workflowState.pageDescription.short_description
        },
        'warn'
      );
    }
  }

  /**
   * Execute AI prompt step
   */
  async executeAIPromptStep(page, step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 🤖 Executing AI prompt (${step.name})`);
    
    const promptName = step.config?.prompt || step.prompt_slug || step.name;
    const customTemplate = this.getPromptTemplate(promptName);
    const promptSource = customTemplate ? 'workflow-template' : 'database';
    
    // Prepare payload based on step configuration
    const stepPayload = {
      page_url: workflowState.pageUrl,
      page_title: workflowState.pageTitle || await page.title(),
      page_content: workflowState.htmlContent || await page.content()
    };
    if (workflowState.inputCredentials) {
      stepPayload.input_credentials = workflowState.inputCredentials;
    }
    
    // Add additional data based on step attachments
    if (step.config?.attachments) {
      if (step.config.attachments.includes('visible_text') && workflowState.visibleText) {
        stepPayload.visible_text = workflowState.visibleText;
      }
      if (step.config.attachments.includes('interactive_elements') && workflowState.playwrightAnalysis) {
        stepPayload.interactive_elements = workflowState.playwrightAnalysis.interactive_elements;
      }
      if (step.config.attachments.includes('forms') && workflowState.playwrightAnalysis) {
        stepPayload.forms = workflowState.playwrightAnalysis.forms;
      }
      if (step.config.attachments.includes('page_description') && workflowState.pageDescription) {
        stepPayload.page_description = workflowState.pageDescription;
      }
    }
    
    // Log prompt usage
    await this.logPromptUsage(promptName, promptSource, customTemplate || 'Default from database', stepPayload);
    
    try {
      const aiResponse = await this.aiLogger.makeAICallWithPrompt(
        promptName,
        stepPayload,
        jobId,
        'workflow-step',
        workflowState.pageUrl,
        null,
        stepPayload,
        customTemplate
      );
      
      let parsedResponse = aiResponse;
      if (typeof aiResponse === 'string') {
        try {
          parsedResponse = JSON.parse(aiResponse);
        } catch (_) {
          // keep original string when JSON parse fails
        }
      }

      // Store response in workflow state (legacy key and slug-based)
      workflowState[`${step.name}_response`] = parsedResponse;
      this.storeStepResult(step, parsedResponse, workflowState);
      
      const logPreview = typeof aiResponse === 'string' ? aiResponse.substring(0, 100) : JSON.stringify(parsedResponse).substring(0, 100);
      console.log(`[WorkflowAnalyzer] ✅ AI prompt completed: ${logPreview}...`);
    } catch (aiError) {
      console.error(`[WorkflowAnalyzer] ❌ AI prompt failed: ${aiError.message}`);
      throw aiError;
    }
  }

  /**
   * Execute workflow analysis step
   */
  async executeWorkflowAnalysisStep(page, step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 🔍 Performing workflow analysis (${step.name})`);
    
    const promptName = step.config?.prompt || step.prompt_slug;
    if (!promptName) {
      throw new Error(`No prompt specified for step: ${step.name}`);
    }
    const customTemplate = this.getPromptTemplate(promptName);
    const promptSource = customTemplate ? 'workflow-template' : 'database';
    
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
    
    // Log prompt usage
    await this.logPromptUsage(promptName, promptSource, customTemplate || 'Default from database', optimizedPayload);
    
    try {
      workflowState.aiAnalysisResult = await this.aiLogger.makeAICallWithPrompt(
        promptName,
        optimizedPayload,
        jobId,
        'workflow-analyzer',
        workflowState.pageUrl,
        null,
        optimizedPayload,
        customTemplate
      );
      
      if (workflowState.aiAnalysisResult && workflowState.aiAnalysisResult.legs) {
        workflowState.legs = workflowState.aiAnalysisResult.legs;
        console.log(`[WorkflowAnalyzer] ✅ Workflow analysis completed: ${workflowState.legs.length} legs identified`);
        this.storeStepResult(step, {
          legs: workflowState.legs,
          aiAnalysis: workflowState.aiAnalysisResult
        }, workflowState);

        await this.logStepOutcome(
          step,
          jobId,
          `🧠 [WORKFLOW-ANALYSIS] Identified ${workflowState.legs.length} workflow legs`,
          {
            legs_count: workflowState.legs.length,
            sample_legs: workflowState.legs.slice(0, 3).map(leg => leg.description || leg.type || 'leg')
          }
        );
      } else {
        throw new Error('OpenAI did not return valid workflow legs');
      }
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Workflow analysis failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute create workflow step
   */
  async executeCreateWorkflowStep(step, workflowState, pageId, projectId, jobId) {
    console.log(`[WorkflowAnalyzer] 📝 Creating workflow document (${step.name})`);
    
    try {
      const workflow = await this.createWorkflow(pageId, projectId, workflowState.pageUrl, workflowState.playwrightAnalysis);
      workflowState.workflowId = workflow._id;
      console.log(`[WorkflowAnalyzer] ✅ Created workflow: ${workflow._id}`);

      this.storeStepResult(step, {
        workflowId: workflow._id,
        pageId,
        projectId
      }, workflowState);

      await this.logStepOutcome(
        step,
        jobId,
        `📝 [CREATE-WORKFLOW] Created workflow ${workflow._id}`,
        {
          workflow_id: workflow._id,
          page_id: pageId,
          project_id: projectId
        }
      );
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Failed to create workflow: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute update workflow step
   */
  async executeUpdateWorkflowStep(step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 📝 Updating workflow with analysis (${step.name})`);
    
    if (!workflowState.workflowId) {
      throw new Error('No workflow ID available for update');
    }
    
    try {
      const createActions = step.config?.createActions !== false;

      const hasExistingLegs = Array.isArray(workflowState.legs) && workflowState.legs.length > 0;
      const canGenerateFromAnalysis = !!workflowState.playwrightAnalysis;

      if (!hasExistingLegs && canGenerateFromAnalysis) {
        const derivedLegs = this.generateLegsFromPlaywrightAnalysis(
          workflowState.playwrightAnalysis,
          workflowState.pageUrl
        );
        workflowState.legs = derivedLegs;
        console.log(`[WorkflowAnalyzer] ✅ Derived ${derivedLegs.length} default legs from Playwright analysis`);
      } else if (!hasExistingLegs && !canGenerateFromAnalysis) {
        console.warn('[WorkflowAnalyzer] ⚠️ Missing Playwright analysis, unable to derive fallback legs');
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
        createActions
      );
      console.log(`[WorkflowAnalyzer] ✅ Workflow updated with analysis${createActions ? ' (actions queued for creation)' : ''}`);

      if (updateResult?.legs && Array.isArray(updateResult.legs)) {
        workflowState.legs = updateResult.legs;
      }

      workflowState.actionsSummary = this.buildActionsSummary(workflowState.legs);

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
      console.error(`[WorkflowAnalyzer] ❌ Failed to update workflow: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute page discovery step
   */
  async executePageDiscoveryStep(step, workflowState, jobId, pageId, projectId) {
    console.log(`[WorkflowAnalyzer] 📡 Updating page discovery (${step.name})`);
    
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
    
    const discoveryData = {
      title: workflowState.pageTitle,
      analyzed: markAsAnalyzed
    };
    
    if (includeContent && workflowState.htmlContent) {
      discoveryData.content = workflowState.htmlContent;
    }
    if (includeForms && workflowState.playwrightAnalysis?.forms) {
      discoveryData.forms = workflowState.playwrightAnalysis.forms;
    }
    if (includeLinks && workflowState.playwrightAnalysis?.links) {
      discoveryData.links = workflowState.playwrightAnalysis.links;
    }
    if (includeInteractive && workflowState.playwrightAnalysis?.interactive_elements) {
      discoveryData.interactive_elements = workflowState.playwrightAnalysis.interactive_elements;
    }
    if (includeNonInteractive && workflowState.playwrightAnalysis?.non_interactive_elements) {
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
      discoveryData.ai_analysis = {
        page_description: workflowState.aiAnalysisResult.page_description,
        legs_count: workflowState.legs.length,
        analyzed_at: new Date().toISOString()
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

    if (actionsSummary.total > 0) {
      discoveryData.actions_summary = actionsSummary;
    }

    if (!discoveryData.page_description) {
      const fallbackDescription = this.createFallbackPageDescription(stats, workflowState);
      discoveryData.page_description = fallbackDescription;
      workflowState.pageDescription = fallbackDescription;
    }
    
    try {
      console.log('[WorkflowAnalyzer] 🚀 Page discovery payload summary:', {
        url: workflowState.pageUrl,
        hasDescription: !!discoveryData.page_description,
        stats,
        actionsSummaryTotal: actionsSummary?.total || 0,
        includeFlags: config
      });
      const response = await this.updatePageDiscovery(jobId, pageId, projectId, workflowState.pageUrl, discoveryData);
      console.log(`[WorkflowAnalyzer] ✅ Page discovery updated`);

      const discoverySummary = {
        included: {
          content: includeContent && !!workflowState.htmlContent,
          forms: includeForms,
          links: includeLinks,
          interactive: includeInteractive,
          non_interactive: includeNonInteractive,
          description: includeDescription,
          visible_text: includeVisibleText,
          screenshot: includeScreenshot && !!workflowState.screenshotFileId,
          ai_analysis: includeAiAnalysis
        },
        counts: {
          forms: workflowState.playwrightAnalysis?.forms?.length || 0,
          links: workflowState.playwrightAnalysis?.links?.length || 0,
          interactive: workflowState.playwrightAnalysis?.interactive_elements?.length || 0,
          non_interactive: workflowState.playwrightAnalysis?.non_interactive_elements?.length || 0
        },
        analyzed: discoveryData.analyzed,
        response: {
          isNew: response?.isNew,
          skipped: response?.skipped,
          pageId: response?.page?._id
        },
        stats,
        actions: actionsSummary
      };

      this.storeStepResult(step, discoverySummary, workflowState);

      await this.logStepOutcome(
        step,
        jobId,
        `📡 [PAGE-DISCOVERY] Upserted page data for ${workflowState.pageUrl}`,
        {
          included: discoverySummary.included,
          counts: discoverySummary.counts,
          analyzed: discoveryData.analyzed,
          page_stats: stats,
          actions_summary: actionsSummary.total > 0 ? actionsSummary : null
        }
      );
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Failed to update page discovery: ${error.message}`);
    }
  }

  /**
   * Store step result by slug
   */
  storeStepResult(step, result, workflowState) {
    const slug = step.slug || this.generateSlug(step.name || 'step');
    if (!workflowState[slug]) {
      workflowState[slug] = {};
    }
    workflowState[slug].result = result;
    workflowState[slug].stepName = step.name;
    workflowState[slug].stepType = step.type;
    // Also store by name for backward compatibility
    workflowState[`${step.name}_result`] = result;
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
   * Execute code step (static code)
   */
  async executeCodeStep(page, step, workflowState) {
    console.log(`[WorkflowAnalyzer] 🚀 Executing static code (${step.name})`);
    
    const code = step.config?.code || step.code;
    if (!code) {
      throw new Error(`No code provided for step: ${step.name}`);
    }
    
    try {
      const timeout = step.config?.timeout || 30000;
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
      this.storeStepResult(step, result, workflowState);
      console.log(`[WorkflowAnalyzer] ✅ Code execution completed: ${JSON.stringify(result).substring(0, 100)}...`);
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Code execution failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute code from variable step
   */
  async executeCodeFromVariableStep(page, step, workflowState) {
    console.log(`[WorkflowAnalyzer] 🚀 Executing code from variable (${step.name})`);
    
    const sourceField = step.config?.sourceField;
    if (!sourceField) {
      throw new Error(`No sourceField provided for step: ${step.name}`);
    }
    
    // Resolve the path with slug support
    const code = this.resolvePath(sourceField, workflowState);
    if (!code) {
      throw new Error(`Code not found at path "${sourceField}" in workflowState for step: ${step.name}`);
    }
    
    console.log(`[WorkflowAnalyzer] 📦 Resolved code from "${sourceField}": ${code ? 'found' : 'not found'}`);
    
    try {
      const timeout = step.config?.timeout || 30000;
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
      this.storeStepResult(step, result, workflowState);
      console.log(`[WorkflowAnalyzer] ✅ Code execution completed: ${JSON.stringify(result).substring(0, 100)}...`);
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Code execution failed: ${error.message}`);
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
   * Execute cookie add step
   */
  async executeCookieAddStep(step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 🍪 Adding cookie (${step.name})`);
    
    const config = step.config || {};
    if (!config.name || !config.value) {
      throw new Error(`Cookie name and value are required for step: ${step.name}`);
    }

    try {
      // Get project ID from job
      const jobResponse = await axios.get(`${this.backendUrl}/api/jobs/${jobId}`, {
        headers: this.getAuthHeaders()
      });
      const projectId = jobResponse.data?.project_id;
      
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
      console.log(`[WorkflowAnalyzer] ✅ Cookie "${config.name}" added successfully`);
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Cookie add failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute cookie update step
   */
  async executeCookieUpdateStep(step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] ✏️ Updating cookie (${step.name})`);
    
    const config = step.config || {};
    if (!config.cookieName || !config.value) {
      throw new Error(`Cookie name and value are required for step: ${step.name}`);
    }

    try {
      // Get project ID from job
      const jobResponse = await axios.get(`${this.backendUrl}/api/jobs/${jobId}`, {
        headers: this.getAuthHeaders()
      });
      const projectId = jobResponse.data?.project_id;
      
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
      console.log(`[WorkflowAnalyzer] ✅ Cookie "${config.cookieName}" updated successfully`);
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Cookie update failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute cookie remove step
   */
  async executeCookieRemoveStep(step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 🗑️ Removing cookie (${step.name})`);
    
    const config = step.config || {};
    const removeAll = config.removeAll || false;
    const cookieName = config.cookieName;

    if (!removeAll && !cookieName) {
      throw new Error(`Cookie name is required or removeAll must be true for step: ${step.name}`);
    }

    try {
      // Get project ID from job
      const jobResponse = await axios.get(`${this.backendUrl}/api/jobs/${jobId}`, {
        headers: this.getAuthHeaders()
      });
      const projectId = jobResponse.data?.project_id;
      
      if (!projectId) {
        throw new Error(`Could not find project ID for job: ${jobId}`);
      }

      if (removeAll) {
        // Clear all cookies
        await axios.delete(`${this.backendUrl}/api/projects/${projectId}/cookies`, {
          headers: this.getAuthHeaders()
        });
        this.storeStepResult(step, { removedAll: true }, workflowState);
        console.log(`[WorkflowAnalyzer] ✅ All cookies removed successfully`);
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
        console.log(`[WorkflowAnalyzer] ✅ Cookie "${cookieName}" removed successfully`);
      }
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Cookie remove failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute cookie collect step
   */
  async executeCookieCollectStep(page, step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 🔍 Collecting cookies (${step.name})`);
    
    const config = step.config || {};
    const source = config.source || 'latest';

    try {
      // Get project ID from job
      const jobResponse = await axios.get(`${this.backendUrl}/api/jobs/${jobId}`, {
        headers: this.getAuthHeaders()
      });
      const projectId = jobResponse.data?.project_id;
      
      if (!projectId) {
        throw new Error(`Could not find project ID for job: ${jobId}`);
      }

      let collectedCookies = [];

      if (source === 'browser') {
        if (!page) {
          throw new Error('Browser source requested but Playwright page is not available');
        }
        const contextCookies = await page.context().cookies();
        collectedCookies = contextCookies;
      } else if (source === 'latest') {
        // Collect from latest login job
        const latestCookiesResponse = await axios.get(`${this.backendUrl}/api/projects/${projectId}/latest-cookies`, {
          headers: this.getAuthHeaders()
        });
        collectedCookies = latestCookiesResponse.data || [];
      } else if (source === 'job') {
        // Collect from specific job
        if (!config.jobId) {
          throw new Error(`Job ID is required when source is 'job'`);
        }
        const jobDataResponse = await axios.get(`${this.backendUrl}/api/jobs/${config.jobId}`, {
          headers: this.getAuthHeaders()
        });
        const jobData = jobDataResponse.data;
        if (jobData && jobData.result && jobData.result.cookies) {
          collectedCookies = jobData.result.cookies;
        }
      } else if (source === 'workflowState') {
        // Collect from workflow state
        if (!config.sourceField) {
          throw new Error(`sourceField is required when source is 'workflowState'`);
        }
        const cookiesData = this.resolvePath(config.sourceField, workflowState);
        if (Array.isArray(cookiesData)) {
          collectedCookies = cookiesData;
        } else {
          throw new Error(`Cookies at path "${config.sourceField}" is not an array`);
        }
      }

      // Store collected cookies in workflow state
      if (config.outputVariable) {
        workflowState[config.outputVariable] = collectedCookies;
      }
      workflowState.collectedCookies = collectedCookies;

      // Optionally save to project
      if (config.saveToProject !== false) {
        await axios.post(`${this.backendUrl}/api/projects/${projectId}/cookies`, {
          cookies: collectedCookies,
          source: 'workflow'
        }, {
          headers: this.getAuthHeaders()
        });
      }

      this.storeStepResult(step, { cookies: collectedCookies, count: collectedCookies.length }, workflowState);
      console.log(`[WorkflowAnalyzer] ✅ Collected ${collectedCookies.length} cookie(s) successfully`);
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Cookie collect failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute validate response step
   */
  async executeValidateResponseStep(step, workflowState) {
    console.log(`[WorkflowAnalyzer] ✅ Validating response (${step.name})`);
    
    const responseToValidate = workflowState[step.config?.responseField || 'last_ai_response'];
    const schema = step.config?.schema;
    
    if (!responseToValidate) {
      console.log(`[WorkflowAnalyzer] ⚠️ No response to validate for step: ${step.name}`);
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
        
        console.log(`[WorkflowAnalyzer] ✅ Response validation passed`);
      } catch (error) {
        console.error(`[WorkflowAnalyzer] ❌ Response validation failed: ${error.message}`);
        throw error;
      }
    }
  }

  /**
   * Execute filter response step
   */
  async executeFilterResponseStep(step, workflowState) {
    console.log(`[WorkflowAnalyzer] 🔍 Filtering response (${step.name})`);
    
    const responseToFilter = workflowState[step.config?.responseField || 'last_ai_response'];
    const filter = step.config?.filter;
    
    if (!responseToFilter || !filter) {
      console.log(`[WorkflowAnalyzer] ⚠️ No response or filter to apply for step: ${step.name}`);
      return;
    }
    
    // Basic filtering logic - can be enhanced with jq-like syntax
    try {
      const filteredResponse = this.applyFilter(responseToFilter, filter);
      workflowState[`${step.name}_filtered`] = filteredResponse;
      console.log(`[WorkflowAnalyzer] ✅ Response filtered successfully`);
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Response filtering failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute conditional step
   */
  async executeConditionalStep(step, workflowState) {
    console.log(`[WorkflowAnalyzer] ❓ Evaluating condition (${step.name})`);
    
    const field = step.config?.field;
    const operator = step.config?.operator || '==';
    const value = step.config?.value;
    const responseField = step.config?.responseField || 'last_ai_response';
    
    const responseToCheck = workflowState[responseField];
    if (!responseToCheck) {
      console.log(`[WorkflowAnalyzer] ⚠️ No response to check condition for step: ${step.name}`);
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
        console.log(`[WorkflowAnalyzer] ⚠️ Unknown operator: ${operator}`);
    }
    
    console.log(`[WorkflowAnalyzer] ${conditionMet ? '✅' : '❌'} Condition ${field} ${operator} ${value}: ${conditionMet}`);
    
    // Store condition result
    workflowState[`${step.name}_condition_met`] = conditionMet;
  }

  /**
   * Execute print step - logs a message to job history
   */
  async executePrintStep(step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 📝 Printing message (${step.name})`);
    
    const config = step.config || {};
    const message = config.message || 'No message provided';
    const level = config.level || 'info';

    try {
      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: level,
        message: `📝 [PRINT] ${message}`,
        component: 'WORKFLOW-PRINT',
        metadata: {
          step_name: step.name,
          step_slug: step.slug || null,
          message: message,
          level: level
        }
      }, {
        headers: this.getAuthHeaders()
      });

      this.storeStepResult(step, { message, level, printed: true }, workflowState);
      console.log(`[WorkflowAnalyzer] ✅ Printed message: "${message}" (level: ${level})`);
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Print step failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute sleep step - pauses execution for specified milliseconds
   */
  async executeSleepStep(step, workflowState) {
    console.log(`[WorkflowAnalyzer] 😴 Sleeping (${step.name})`);
    
    const config = step.config || {};
    const ms = config.ms || 1000;

    if (ms < 0 || ms > 300000) {
      throw new Error(`Sleep duration must be between 0 and 300000ms, got: ${ms}`);
    }

    try {
      await new Promise(resolve => setTimeout(resolve, ms));
      this.storeStepResult(step, { duration: ms, slept: true }, workflowState);
      console.log(`[WorkflowAnalyzer] ✅ Slept for ${ms}ms`);
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Sleep step failed: ${error.message}`);
      throw error;
    }
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
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
  }
}

export default WorkflowAnalyzer;


// Force rebuild Wed 15 Oct 2025 23:26:24 AEDT
// Force rebuild Tue 28 Oct 2025 15:43:46 AEDT
