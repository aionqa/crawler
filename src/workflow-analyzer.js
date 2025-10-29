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
      
      return this.workflowTemplate;
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Failed to load workflow template: ${error.message}`);
      throw new Error(`Failed to load workflow template ${this.context.workflow_template_id}: ${error.message}`);
    }
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
      interactive_elements: []
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

    } catch (error) {
      console.error('[WorkflowAnalyzer] Error during Playwright analysis:', error);
    }

    return analysis;
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
  async updateWorkflowWithAnalysis(workflowId, pageDescription, legs) {
    try {
      const response = await axios.put(
        `${this.backendUrl}/api/workflows/${workflowId}/analysis`,
        {
          ai_analysis: {
            page_description: pageDescription,
            analyzed_at: new Date().toISOString()
          },
          legs: legs,
          create_actions: true  // Signal backend to create action documents
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
        payload
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
      legs: []
    };
    
    // Execute each step in sequence
    for (let i = 0; i < this.workflowTemplate.steps.length; i++) {
      const step = this.workflowTemplate.steps[i];
      console.log(`[WorkflowAnalyzer] ═══════════════════════════════════════════════════════`);
      console.log(`[WorkflowAnalyzer] 🔄 EXECUTING STEP ${i + 1}/${this.workflowTemplate.steps.length}: ${step.name}`);
      console.log(`[WorkflowAnalyzer] Type: ${step.type}`);
      console.log(`[WorkflowAnalyzer] ═══════════════════════════════════════════════════════`);
      
      try {
        switch (step.type) {
          case 'screenshot':
            await this.executeScreenshotStep(page, step, workflowState, jobId, pageId);
            break;
            
          case 'collect-elements':
            await this.executeCollectElementsStep(page, step, workflowState);
            break;
            
          case 'playwright-analysis':
            await this.executePlaywrightAnalysisStep(page, step, workflowState);
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
            
          case 'create-workflow':
            await this.executeCreateWorkflowStep(step, workflowState, pageId, projectId);
            break;
            
          case 'update-workflow':
            await this.executeUpdateWorkflowStep(step, workflowState);
            break;
            
          case 'page-discovery':
            await this.executePageDiscoveryStep(step, workflowState, jobId, pageId, projectId);
            break;
            
          case 'execute-code':
            await this.executeCodeStep(page, step, workflowState);
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
   * Execute screenshot step
   */
  async executeScreenshotStep(page, step, workflowState, jobId, pageId) {
    console.log(`[WorkflowAnalyzer] 📸 Taking screenshot (${step.name})`);
    
    const screenshot = await page.screenshot({ 
      fullPage: step.config?.fullPage !== false, 
      type: 'png',
      quality: step.config?.quality || 90
    });
    
    workflowState.screenshotBase64 = screenshot.toString('base64');
    console.log(`[WorkflowAnalyzer] ✅ Screenshot taken (${screenshot.length} bytes)`);
    
    // Upload to MinIO if configured
    if (step.config?.upload !== false) {
      try {
        const axios = (await import('axios')).default;
        
        console.log(`[WorkflowAnalyzer] 📸 Requesting presigned URL for screenshot upload...`);
        
        const presignedResponse = await axios.post(`${this.backendUrl}/api/upload/presigned-url`, {
          type: 'screenshot',
          jobId: jobId,
          contentType: 'image/png'
        }, { timeout: 10000 });
        
        const { url: presignedUrl, key, publicUrl } = presignedResponse.data;
        workflowState.screenshotFileId = key;
        workflowState.screenshotUrl = publicUrl;
        
        await axios.put(presignedUrl, screenshot, {
          headers: { 'Content-Type': 'image/png' },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 30000
        });
        
        console.log(`[WorkflowAnalyzer] ✅ Screenshot uploaded to MinIO: ${publicUrl}`);
        
        // Update page document with screenshot
        await axios.post(`${this.backendUrl}/api/pages/${pageId}/screenshot`, {
          fileId: workflowState.screenshotFileId,
          jobId: jobId
        }, { timeout: 10000 });
        
        console.log(`[WorkflowAnalyzer] ✅ Page ${pageId} updated with screenshot`);
      } catch (error) {
        console.error(`[WorkflowAnalyzer] ❌ Failed to upload screenshot: ${error.message}`);
      }
    }
  }

  /**
   * Execute collect elements step
   */
  async executeCollectElementsStep(page, step, workflowState) {
    console.log(`[WorkflowAnalyzer] 🔍 Collecting interactive elements (${step.name})`);
    
    const elements = await page.$$eval('button, input, select, textarea, a[href], [onclick], [role="button"]', 
      elements => elements.map(el => ({
        tag: el.tagName,
        text: el.textContent?.trim() || '',
        type: el.type || '',
        href: el.href || '',
        id: el.id || '',
        className: el.className || '',
        role: el.getAttribute('role') || '',
        onclick: el.getAttribute('onclick') || ''
      }))
    );
    
    workflowState.collectedElements = elements;
    console.log(`[WorkflowAnalyzer] ✅ Collected ${elements.length} interactive elements`);
  }

  /**
   * Execute Playwright analysis step
   */
  async executePlaywrightAnalysisStep(page, step, workflowState) {
    console.log(`[WorkflowAnalyzer] 🔍 Performing Playwright analysis (${step.name})`);
    
    const analysis = await this.performPlaywrightAnalysis(page);
    workflowState.playwrightAnalysis = analysis;
    
    console.log(`[WorkflowAnalyzer] ✅ Found ${analysis.forms.length} forms, ${analysis.links.length} links, ${analysis.interactive_elements.length} interactive elements`);
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
      
    } catch (error) {
      console.warn(`[WorkflowAnalyzer] Failed to generate page description: ${error.message}`);
      workflowState.pageDescription = {
        short_description: `Page: ${workflowState.pageTitle}`,
        full_description: `Analysis of ${workflowState.pageUrl}`,
        purpose: 'Information page',
        conversation_context: 'Analyzing page structure and content'
      };
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
      
      // Store response in workflow state
      workflowState[`${step.name}_response`] = aiResponse;
      
      console.log(`[WorkflowAnalyzer] ✅ AI prompt completed: ${aiResponse?.substring(0, 100)}...`);
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
    
    // Prepare interactive elements as JSON string
    const interactiveElementsJson = JSON.stringify({
      forms: workflowState.playwrightAnalysis?.forms || [],
      interactive_elements: workflowState.playwrightAnalysis?.interactive_elements || []
    }, null, 2);
    
    const optimizedPayload = {
      page_url: workflowState.pageUrl,
      page_title: workflowState.pageTitle,
      page_description: workflowState.pageDescription,
      interactive_elements_json: interactiveElementsJson,
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
  async executeCreateWorkflowStep(step, workflowState, pageId, projectId) {
    console.log(`[WorkflowAnalyzer] 📝 Creating workflow document (${step.name})`);
    
    try {
      const workflow = await this.createWorkflow(pageId, projectId, workflowState.pageUrl, workflowState.playwrightAnalysis);
      workflowState.workflowId = workflow._id;
      console.log(`[WorkflowAnalyzer] ✅ Created workflow: ${workflow._id}`);
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Failed to create workflow: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute update workflow step
   */
  async executeUpdateWorkflowStep(step, workflowState) {
    console.log(`[WorkflowAnalyzer] 📝 Updating workflow with analysis (${step.name})`);
    
    if (!workflowState.workflowId) {
      throw new Error('No workflow ID available for update');
    }
    
    try {
      await this.updateWorkflowWithAnalysis(
        workflowState.workflowId, 
        workflowState.aiAnalysisResult?.page_description || workflowState.pageDescription, 
        workflowState.legs
      );
      console.log(`[WorkflowAnalyzer] ✅ Workflow updated with analysis`);
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
    
    const discoveryData = {
      title: workflowState.pageTitle,
      content: workflowState.htmlContent,
      forms: workflowState.playwrightAnalysis?.forms || [],
      links: workflowState.playwrightAnalysis?.links || [],
      interactive_elements: workflowState.playwrightAnalysis?.interactive_elements || [],
      page_description: workflowState.pageDescription,
      visible_text: workflowState.visibleText,
      analyzed: step.config?.analyzed || false
    };
    
    if (workflowState.workflowId) {
      discoveryData.workflow_id = workflowState.workflowId;
    }
    
    if (workflowState.aiAnalysisResult) {
      discoveryData.ai_analysis = {
        page_description: workflowState.aiAnalysisResult.page_description,
        legs_count: workflowState.legs.length,
        analyzed_at: new Date().toISOString()
      };
      discoveryData.analyzed = true;
    }
    
    try {
      await this.updatePageDiscovery(jobId, pageId, projectId, workflowState.pageUrl, discoveryData);
      console.log(`[WorkflowAnalyzer] ✅ Page discovery updated`);
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Failed to update page discovery: ${error.message}`);
    }
  }

  /**
   * Execute code step
   */
  async executeCodeStep(page, step, workflowState) {
    console.log(`[WorkflowAnalyzer] 🚀 Executing code (${step.name})`);
    
    const code = step.config?.code || step.code;
    if (!code) {
      throw new Error(`No code provided for step: ${step.name}`);
    }
    
    try {
      const result = await page.evaluate(code);
      workflowState[`${step.name}_result`] = result;
      console.log(`[WorkflowAnalyzer] ✅ Code execution completed: ${JSON.stringify(result).substring(0, 100)}...`);
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Code execution failed: ${error.message}`);
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
