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
    if (!this.context.workflow_template_id) {
      console.error(`[WorkflowAnalyzer] ❌ No workflow template ID provided - workflows are mandatory!`);
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
   */
  getPromptTemplate(promptName) {
    if (!this.workflowTemplate || !this.workflowTemplate.prompts) {
      console.log(`[WorkflowAnalyzer] 📋 Using DEFAULT prompt from database: "${promptName}"`);
      return null;
    }

    const prompt = this.workflowTemplate.prompts.find(p => p.name === promptName);
    if (prompt && prompt.template) {
      console.log(`[WorkflowAnalyzer] ✅ Using CUSTOM prompt from workflow template: "${promptName}"`);
      console.log(`[WorkflowAnalyzer] 📝 Prompt text: ${prompt.template.substring(0, 100)}...`);
      return prompt.template;
    } else {
      console.log(`[WorkflowAnalyzer] 📋 Prompt "${promptName}" not found in template or template is empty, using DEFAULT from database`);
      return null;
    }
  }

  /**
   * Analyze page with Playwright and create initial workflow
   * @param {Page} page - Playwright page object
   * @param {string} jobId - Job ID for logging
   * @param {string} pageId - Page ID in MongoDB
   * @param {string} projectId - Project ID
   * @returns {Object} workflow object
   */
  async analyzePage(page, jobId, pageId, projectId) {
    console.log(`[WorkflowAnalyzer] Analyzing page: ${page.url()}`);

    // Load workflow template if specified
    await this.loadWorkflowTemplate();

    // EXECUTE STATIC WORKFLOW NODES (screenshot, wait, print, navigate, click, fill, etc.)
    if (this.workflowTemplate && this.workflowTemplate.staticNodes && this.workflowTemplate.staticNodes.length > 0) {
      console.log(`[WorkflowAnalyzer] 🎯 Executing static workflow nodes for: "${this.workflowTemplate.name}"`);
      
      try {
        const staticExecutor = new StaticNodeExecutor(
          page,
          jobId,
          this.workflowTemplate,
          {
            ...this.context,
            backendUrl: this.backendUrl
          }
        );
        
        const executionResult = await staticExecutor.execute();
        
        if (executionResult.success) {
          console.log(`[WorkflowAnalyzer] ✅ Static workflow completed successfully: ${executionResult.stepsExecuted} steps executed`);
        } else {
          console.log(`[WorkflowAnalyzer] ❌ Static workflow failed: ${executionResult.error}`);
        }
      } catch (staticError) {
        console.error(`[WorkflowAnalyzer] ❌ Static workflow execution error:`, staticError);
        // Continue with page analysis even if static workflow fails
      }
    } else {
      console.log(`[WorkflowAnalyzer] ℹ️ No static nodes in workflow, proceeding with AI-driven analysis`);
    }

    // Step 1: Playwright Analysis - collect forms, links, interactive elements
    // NOTE: Links are collected for PAGE DISCOVERY (crawling), but NOT for workflow legs (testing)
    const playwrightAnalysis = await this.performPlaywrightAnalysis(page);
    
    console.log(`[WorkflowAnalyzer] Found ${playwrightAnalysis.forms.length} forms, ${playwrightAnalysis.links.length} links (for discovery), ${playwrightAnalysis.interactive_elements.length} interactive elements`);

    // Step 2: Take screenshot
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    const screenshotBase64 = screenshot.toString('base64');

    // Step 2.1: Upload screenshot to MinIO IMMEDIATELY and link to page as icon
    // CRITICAL: This ensures pages have screenshots as icons in the UI
    let screenshotUrl = null;
    let screenshotFileId = null;
    try {
      const axios = (await import('axios')).default;
      
      console.log(`[WorkflowAnalyzer] 📸 Requesting presigned URL for screenshot upload...`);
      
      // Request presigned URL from backend
      const presignedResponse = await axios.post(`${this.backendUrl}/api/upload/presigned-url`, {
        type: 'screenshot',
        jobId: jobId,
        contentType: 'image/png'
      }, {
        timeout: 10000
      });
      
      console.log(`[WorkflowAnalyzer] ✅ Got presigned URL from backend`);
      
      const { url: presignedUrl, key, publicUrl } = presignedResponse.data;
      screenshotFileId = key;
      screenshotUrl = publicUrl;
      
      console.log(`[WorkflowAnalyzer] 📤 Uploading screenshot to MinIO (${screenshot.length} bytes)...`);
      
      // Upload screenshot to MinIO using presigned URL
      await axios.put(presignedUrl, screenshot, {
        headers: {
          'Content-Type': 'image/png'
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 30000
      });
      
      console.log(`[WorkflowAnalyzer] ✅ Screenshot uploaded to MinIO: ${publicUrl}`);
      
      // Update page document with screenshot URL IMMEDIATELY
      console.log(`[WorkflowAnalyzer] 📝 Updating page ${pageId} with screenshot file ID...`);
      
      const updateResponse = await axios.post(`${this.backendUrl}/api/pages/${pageId}/screenshot`, {
        fileId: screenshotFileId,
        jobId: jobId
      }, {
        timeout: 10000
      });
      
      console.log(`[WorkflowAnalyzer] ✅ Page ${pageId} updated with screenshot (icon set) - Response:`, updateResponse.status);
    } catch (screenshotError) {
      console.error(`[WorkflowAnalyzer] ❌ Failed to upload screenshot: ${screenshotError.message}`);
      console.error(`[WorkflowAnalyzer] Error stack:`, screenshotError.stack);
      // Continue anyway - screenshot is nice to have but not critical for analysis
    }

    // Step 3: Get HTML content (FULL - no trimming)
    const htmlContent = await page.content();
    const pageTitle = await page.title();
    
    // Step 3.1: Extract visible text content (for page description)
    const visibleText = await page.evaluate(() => {
      // Remove scripts, styles, and hidden elements
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll('script, style, noscript, meta, link').forEach(el => el.remove());
      
      // Get visible text
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
    
    // Step 3.2: Generate page description using AI (minimal token usage)
    console.log(`[WorkflowAnalyzer] Generating page description with visible text (${visibleText.length} chars)`);
    let pageDescription = null;
    let conversationHistory = [];
    try {
      const descriptionPayload = {
        page_title: pageTitle,
        page_url: page.url(),
        visible_text: visibleText
      };
      
      // Use custom prompt template if available
      const promptName = 'generate-page-description';
      const customTemplate = this.getPromptTemplate(promptName);
      const promptSource = customTemplate ? 'workflow-template' : 'database';
      
      // Log prompt usage
      await this.logPromptUsage(promptName, promptSource, customTemplate || 'Default from database', descriptionPayload);
      
      pageDescription = await this.aiLogger.makeAICallWithPrompt(
        promptName,
        descriptionPayload,
        jobId,
        'page-descriptor',
        page.url(),
        null,
        descriptionPayload,
        customTemplate // Pass custom template if available
      );
      
      console.log(`[WorkflowAnalyzer] Page description generated: ${pageDescription.short_description}`);
      
      // Add to conversation history
      conversationHistory.push({
        timestamp: new Date().toISOString(),
        action: 'page-description-generated',
        description: pageDescription.short_description
      });
      
      // Step 3.3: Log page description to job history with attachments (appears ABOVE AI chats)
      await this.logPageDescription(jobId, page.url(), pageTitle, pageDescription, {
        visible_text_length: visibleText.length,
        forms_count: playwrightAnalysis.forms.length,
        interactive_elements_count: playwrightAnalysis.interactive_elements.length
      }, htmlContent, screenshotBase64);
      
    } catch (error) {
      console.warn(`[WorkflowAnalyzer] Failed to generate page description: ${error.message}`);
      pageDescription = {
        short_description: `Page: ${pageTitle}`,
        full_description: `Analysis of ${page.url()}`,
        purpose: 'Information page',
        conversation_context: 'Analyzing page structure and content'
      };
    }
    
    // Step 3.5: Send initial page discovery update (real-time)
    await this.updatePageDiscovery(jobId, pageId, projectId, page.url(), {
      title: pageTitle,
      content: htmlContent,
      forms: playwrightAnalysis.forms,
      links: playwrightAnalysis.links,
      interactive_elements: playwrightAnalysis.interactive_elements,
      page_description: pageDescription,
      visible_text: visibleText,
      analyzed: false
    });

    // Step 4: Create workflow document in backend
    const workflow = await this.createWorkflow(pageId, projectId, page.url(), playwrightAnalysis);
    
    console.log(`[WorkflowAnalyzer] Created workflow: ${workflow._id}`);

    // Step 5: Send to OpenAI for analysis with OPTIMIZED context (interactive elements only)
    // Prepare interactive elements as JSON string
    // NOTE: Links are excluded - they are for page discovery only, NOT testable legs
    const interactiveElementsJson = JSON.stringify({
      forms: playwrightAnalysis.forms,
      // links: playwrightAnalysis.links,  // EXCLUDED - links are not testable legs
      interactive_elements: playwrightAnalysis.interactive_elements
    }, null, 2);
    
    console.log(`[WorkflowAnalyzer] Sending OPTIMIZED context to OpenAI (Interactive elements only, no HTML/screenshot)`);
    
    // Update sub-status with descriptive information
    await this.updateJobSubstatus(jobId, `Analyzing page structure for testing: ${pageTitle}`, {
      current_page: page.url(),
      page_title: pageTitle,
      forms_count: playwrightAnalysis.forms.length,
      interactive_elements_count: playwrightAnalysis.interactive_elements.length
    });
    
    // Build OPTIMIZED payload - only interactive elements + description + history
    const optimizedPayload = {
      page_url: page.url(),
      page_title: pageTitle,
      page_description: pageDescription,  // AI-generated description
      interactive_elements_json: interactiveElementsJson,  // Only interactive elements
      conversation_history: conversationHistory  // History of analysis
      // NO html_content - saved in PAGE-ANALYZER attachments
      // NO screenshot_base64 - saved in PAGE-ANALYZER attachments
    };
    
      // Use custom prompt template if available
      const workflowPromptName = 'analyze-page-for-workflow';
      const customWorkflowTemplate = this.getPromptTemplate(workflowPromptName);
      const workflowPromptSource = customWorkflowTemplate ? 'workflow-template' : 'database';
      
      // Log prompt usage
      await this.logPromptUsage(workflowPromptName, workflowPromptSource, customWorkflowTemplate || 'Default from database', optimizedPayload);
      
      const aiAnalysisResult = await this.aiLogger.makeAICallWithPrompt(
        workflowPromptName,
        optimizedPayload,
        jobId,
        'workflow-analyzer',
        page.url(),
        null,  // screenshotId
        optimizedPayload,  // Pass as sourcePayload for attachment logging
        customWorkflowTemplate // Pass custom template if available
      );

    if (!aiAnalysisResult || !aiAnalysisResult.legs) {
      throw new Error('OpenAI did not return valid workflow legs');
    }

    console.log(`[WorkflowAnalyzer] OpenAI identified ${aiAnalysisResult.legs.length} testable legs`);

    // Step 6: Update workflow with AI analysis and legs
    await this.updateWorkflowWithAnalysis(workflow._id, aiAnalysisResult.page_description, aiAnalysisResult.legs);

    console.log(`[WorkflowAnalyzer] Workflow ready for testing`);
    
    // Step 7: Send final page update with AI analysis and workflow (real-time)
    await this.updatePageDiscovery(jobId, pageId, projectId, page.url(), {
      workflow_id: workflow._id,
      ai_analysis: {
        page_description: aiAnalysisResult.page_description,
        legs_count: aiAnalysisResult.legs.length,
        analyzed_at: new Date().toISOString()
      },
      analyzed: true
    });

    return {
      workflow_id: workflow._id,
      legs_count: aiAnalysisResult.legs.length,
      page_description: aiAnalysisResult.page_description,
      legs: aiAnalysisResult.legs
    };
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
        
        const formData = {
          selector: await this.getElementSelector(form),
          action: await form.getAttribute('action'),
          method: await form.getAttribute('method'),
          fields: []
        };

        for (const input of inputs) {
          const type = await input.getAttribute('type') || 'text';
          const name = await input.getAttribute('name');
          const id = await input.getAttribute('id');
          const placeholder = await input.getAttribute('placeholder');
          
          formData.fields.push({
            type,
            name,
            id,
            placeholder,
            selector: await this.getElementSelector(input)
          });
        }

        formData.buttons = [];
        for (const button of buttons) {
          const text = await button.textContent();
          formData.buttons.push({
            text: text?.trim(),
            selector: await this.getElementSelector(button)
          });
        }

        analysis.forms.push(formData);
      }

      // Extract links
      const links = await page.$$('a[href]');
      for (const link of links.slice(0, 50)) { // Limit to first 50 links
        const href = await link.getAttribute('href');
        const text = await link.textContent();
        
        if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
          analysis.links.push({
            href,
            text: text?.trim(),
            selector: await this.getElementSelector(link)
          });
        }
      }

      // Extract interactive elements (buttons, clickable divs, etc.)
      const buttons = await page.$$('button:not(form button), input[type="button"], [role="button"], [onclick]');
      for (const button of buttons) {
        const text = await button.textContent();
        const role = await button.getAttribute('role');
        const onclick = await button.getAttribute('onclick');
        
        analysis.interactive_elements.push({
          type: 'button',
          text: text?.trim(),
          role,
          onclick: onclick ? 'yes' : 'no',
          selector: await this.getElementSelector(button)
        });
      }

    } catch (error) {
      console.error('[WorkflowAnalyzer] Error during Playwright analysis:', error);
    }

    return analysis;
  }

  /**
   * Get a reliable selector for an element
   */
  async getElementSelector(element) {
    try {
      // Try ID first
      const id = await element.getAttribute('id');
      if (id) return `#${id}`;

      // Try name
      const name = await element.getAttribute('name');
      const tagName = await element.evaluate(el => el.tagName.toLowerCase());
      if (name) return `${tagName}[name="${name}"]`;

      // Try type for inputs
      const type = await element.getAttribute('type');
      if (type) return `${tagName}[type="${type}"]`;

      // Fallback to nth-child
      return tagName;
    } catch (error) {
      return 'unknown';
    }
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
}

export default WorkflowAnalyzer;


// Force rebuild Wed 15 Oct 2025 23:26:24 AEDT
