import axios from 'axios';

/**
 * WorkflowAnalyzer
 * Handles initial page analysis using Playwright + OpenAI
 * Creates workflow structure with testable legs
 */
class WorkflowAnalyzer {
  constructor(backendUrl, aiLogger) {
    this.backendUrl = backendUrl;
    this.aiLogger = aiLogger;
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

    // Step 1: Playwright Analysis - collect forms, links, interactive elements
    // NOTE: Links are collected for PAGE DISCOVERY (crawling), but NOT for workflow legs (testing)
    const playwrightAnalysis = await this.performPlaywrightAnalysis(page);
    
    console.log(`[WorkflowAnalyzer] Found ${playwrightAnalysis.forms.length} forms, ${playwrightAnalysis.links.length} links (for discovery), ${playwrightAnalysis.interactive_elements.length} interactive elements`);

    // Step 2: Take screenshot
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    const screenshotBase64 = screenshot.toString('base64');

    // Step 3: Get HTML content (FULL - no trimming)
    const htmlContent = await page.content();
    const pageTitle = await page.title();
    
    // Step 3.5: Send initial page discovery update (real-time)
    await this.updatePageDiscovery(jobId, pageId, projectId, page.url(), {
      title: pageTitle,
      content: htmlContent,
      forms: playwrightAnalysis.forms,
      links: playwrightAnalysis.links,
      interactive_elements: playwrightAnalysis.interactive_elements,
      analyzed: false
    });

    // Step 4: Create workflow document in backend
    const workflow = await this.createWorkflow(pageId, projectId, page.url(), playwrightAnalysis);
    
    console.log(`[WorkflowAnalyzer] Created workflow: ${workflow._id}`);

    // Step 5: Send to OpenAI for analysis with FULL context
    // Prepare interactive elements as JSON string
    // NOTE: Links are excluded - they are for page discovery only, NOT testable legs
    const interactiveElementsJson = JSON.stringify({
      forms: playwrightAnalysis.forms,
      // links: playwrightAnalysis.links,  // EXCLUDED - links are not testable legs
      interactive_elements: playwrightAnalysis.interactive_elements
    }, null, 2);
    
    console.log(`[WorkflowAnalyzer] Sending FULL context to OpenAI (HTML: ${htmlContent.length} chars, Elements: ${playwrightAnalysis.interactive_elements.length})`);
    
    // Update sub-status with descriptive information
    await this.updateJobSubstatus(jobId, `Analyzing page structure for testing: ${pageTitle}`, {
      current_page: page.url(),
      page_title: pageTitle,
      forms_count: playwrightAnalysis.forms.length,
      interactive_elements_count: playwrightAnalysis.interactive_elements.length
    });
    
    // Build complete payload with all data
    const fullPayload = {
      page_url: page.url(),
      page_title: pageTitle,
      html_content: htmlContent,  // FULL HTML - no trimming
      interactive_elements_json: interactiveElementsJson,
      playwright_analysis: playwrightAnalysis,
      screenshot_base64: screenshotBase64  // For vision API
    };
    
    const aiAnalysisResult = await this.aiLogger.makeAICallWithPrompt(
      'analyze-page-for-workflow',
      fullPayload,
      jobId,
      'workflow-analyzer',
      page.url(),
      null,  // screenshotId
      fullPayload  // Pass as sourcePayload for attachment logging
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
}

export default WorkflowAnalyzer;


