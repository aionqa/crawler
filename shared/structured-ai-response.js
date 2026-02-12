/**
 * Structured AI Response Format for AionQA
 * 
 * This module provides a clean, structured format for AI responses
 * that separates context, content, and metadata for better UI rendering.
 */

export class StructuredAIResponse {
  constructor() {
    this.response = {
      metadata: {},
      context: {},
      content: {},
      actions: [],
      artifacts: []
    }
  }

  /**
   * Set metadata about the AI interaction
   */
  setMetadata(data) {
    this.response.metadata = {
      agent_name: data.agent_name,
      conversation_type: data.conversation_type,
      timestamp: new Date(),
      job_id: data.job_id,
      page_url: data.page_url,
      screenshot_id: data.screenshot_id,
      model: data.model,
      usage: data.usage,
      ...data.metadata
    }
    return this
  }

  /**
   * Set context information (what the user sent)
   */
  setContext(data) {
    this.response.context = {
      user_input: data.user_input || null,
      images: data.images || [],
      page_info: data.page_info || null,
      form_data: data.form_data || null,
      ...data.context
    }
    return this
  }

  /**
   * Set content information (what the AI will do)
   */
  setContent(data) {
    this.response.content = {
      description: data.description || null,
      html_content: data.html_content || null,
      playwright_script: data.playwright_script || null,
      analysis_result: data.analysis_result || null,
      ...data.content
    }
    return this
  }

  /**
   * Add action items (step-by-step what will happen)
   */
  addAction(action) {
    this.response.actions.push({
      id: `action_${this.response.actions.length + 1}`,
      type: action.type,
      description: action.description,
      status: action.status || 'pending',
      details: action.details || null,
      timestamp: new Date()
    })
    return this
  }

  /**
   * Add artifacts (files, images, etc.)
   */
  addArtifact(artifact) {
    this.response.artifacts.push({
      id: `artifact_${this.response.artifacts.length + 1}`,
      type: artifact.type, // 'html', 'image', 'screenshot', 'script', 'forms', 'payload'
      name: artifact.name,
      content: artifact.content,
      url: artifact.url || null,
      downloadable: artifact.downloadable || false,
      preview: artifact.preview || false,
      metadata: artifact.metadata || {},
      step: artifact.step || null,
      action: artifact.action || null
    })
    return this
  }

  /**
   * Add separate payload components (HTML, forms, screenshots, etc.)
   */
  addPayloadComponent(component) {
    this.response.payload_components = this.response.payload_components || [];
    this.response.payload_components.push({
      id: `payload_${this.response.payload_components.length + 1}`,
      type: component.type, // 'html', 'forms', 'screenshot', 'page_info', 'actions'
      name: component.name,
      content: component.content,
      data: component.data || null,
      url: component.url || null,
      step: component.step || null,
      action: component.action || null,
      timestamp: new Date(),
      metadata: component.metadata || {}
    })
    return this
  }

  /**
   * Add screenshot with metadata
   */
  addScreenshot(screenshot) {
    return this.addPayloadComponent({
      type: 'screenshot',
      name: screenshot.name || 'screenshot.png',
      content: screenshot.content || null,
      url: screenshot.url || null,
      step: screenshot.step || null,
      action: screenshot.action || null,
      metadata: {
        screenshot_id: screenshot.screenshot_id,
        full_hd: screenshot.full_hd || false,
        before_action: screenshot.before_action || false,
        after_action: screenshot.after_action || false,
        ...screenshot.metadata
      }
    })
  }

  /**
   * Add HTML content as separate payload
   */
  addHTMLPayload(html) {
    return this.addPayloadComponent({
      type: 'html',
      name: html.name || 'page-content.html',
      content: html.content,
      step: html.step || null,
      action: html.action || null,
      metadata: {
        page_url: html.page_url,
        page_title: html.page_title,
        content_length: html.content?.length || 0,
        ...html.metadata
      }
    })
  }

  /**
   * Add forms data as separate payload
   */
  addFormsPayload(forms) {
    return this.addPayloadComponent({
      type: 'forms',
      name: forms.name || 'forms-data.json',
      data: forms.data,
      content: typeof forms.data === 'string' ? forms.data : JSON.stringify(forms.data, null, 2),
      step: forms.step || null,
      action: forms.action || null,
      metadata: {
        form_count: Array.isArray(forms.data) ? forms.data.length : (forms.data?.forms?.length || 0),
        has_login_form: forms.has_login_form || false,
        ...forms.metadata
      }
    })
  }

  /**
   * Get the structured response
   */
  build() {
    return this.response
  }

  /**
   * Create a structured response for form analysis
   */
  static createFormAnalysis(agentName, jobId, pageUrl, formData, analysisResult) {
    return new StructuredAIResponse()
      .setMetadata({
        agent_name: agentName,
        conversation_type: 'form_analysis',
        job_id: jobId,
        page_url: pageUrl,
        model: 'gpt-5-nano'
      })
      .setContext({
        user_input: 'Analyze login form structure and identify input fields',
        page_info: {
          url: pageUrl,
          title: formData.title || 'Login Page'
        },
        form_data: formData
      })
      .setContent({
        description: 'I will analyze the login form structure, identify username and password fields, and determine the best approach for automated login',
        analysis_result: analysisResult
      })
      .addAction({
        type: 'analyze',
        description: 'Identify form fields and structure',
        status: 'completed'
      })
      .addAction({
        type: 'validate',
        description: 'Validate form accessibility and selectors',
        status: 'completed'
      })
      .addArtifact({
        type: 'html',
        name: 'form-preview.html',
        content: formData.html_content,
        downloadable: true,
        preview: true
      })
      .build()
  }

  /**
   * Create a structured response for Playwright code generation
   */
  static createPlaywrightGeneration(agentName, jobId, pageUrl, description, script, htmlContent) {
    return new StructuredAIResponse()
      .setMetadata({
        agent_name: agentName,
        conversation_type: 'playwright_code_generation',
        job_id: jobId,
        page_url: pageUrl,
        model: 'gpt-5-nano'
      })
      .setContext({
        user_input: 'Generate Playwright script for form interaction',
        page_info: {
          url: pageUrl
        }
      })
      .setContent({
        description: description,
        playwright_script: script
      })
      .addAction({
        type: 'generate',
        description: 'Generate Playwright automation script',
        status: 'completed'
      })
      .addAction({
        type: 'validate',
        description: 'Validate script syntax and logic',
        status: 'completed'
      })
      .addArtifact({
        type: 'script',
        name: 'playwright-script.js',
        content: script,
        downloadable: true,
        preview: false
      })
      .addArtifact({
        type: 'html',
        name: 'form-preview.html',
        content: htmlContent,
        downloadable: true,
        preview: true
      })
      .build()
  }

  /**
   * Create a structured response for page analysis
   */
  static createPageAnalysis(agentName, jobId, pageUrl, description, analysisResult, screenshotId) {
    return new StructuredAIResponse()
      .setMetadata({
        agent_name: agentName,
        conversation_type: 'page_analysis',
        job_id: jobId,
        page_url: pageUrl,
        screenshot_id: screenshotId,
        model: 'gpt-5-nano'
      })
      .setContext({
        user_input: 'Analyze page structure and extract interactive elements',
        page_info: {
          url: pageUrl
        }
      })
      .setContent({
        description: description,
        analysis_result: analysisResult
      })
      .addAction({
        type: 'analyze',
        description: 'Extract page structure and elements',
        status: 'completed'
      })
      .addAction({
        type: 'catalog',
        description: 'Catalog interactive elements and forms',
        status: 'completed'
      })
      .addArtifact({
        type: 'screenshot',
        name: 'page-screenshot.png',
        url: screenshotId ? `/files/${screenshotId}` : null,
        preview: true
      })
      .build()
  }

  /**
   * Create a structured response for login success analysis
   */
  static createLoginSuccessAnalysis(agentName, jobId, pageUrl, successResult, screenshotId) {
    return new StructuredAIResponse()
      .setMetadata({
        agent_name: agentName,
        conversation_type: 'login_success_analysis',
        job_id: jobId,
        page_url: pageUrl,
        screenshot_id: screenshotId,
        model: 'gpt-5-nano'
      })
      .setContext({
        user_input: 'Analyze if login was successful',
        page_info: {
          url: pageUrl
        }
      })
      .setContent({
        description: 'I will analyze the current page state to determine if the login was successful by checking for success indicators',
        analysis_result: successResult
      })
      .addAction({
        type: 'analyze',
        description: 'Check for success indicators',
        status: 'completed'
      })
      .addAction({
        type: 'evaluate',
        description: 'Evaluate login success probability',
        status: 'completed'
      })
      .addArtifact({
        type: 'screenshot',
        name: 'result-screenshot.png',
        url: screenshotId ? `/files/${screenshotId}` : null,
        preview: true
      })
      .build()
  }

  /**
   * Create a structured response with AI analysis of request and response
   */
  static createAIAnalyzedResponse(agentName, jobId, pageUrl, requestData, responseData, aiAnalysis, screenshotId = null) {
    const response = new StructuredAIResponse()
      .setMetadata({
        agent_name: agentName,
        conversation_type: 'ai_analyzed_conversation',
        job_id: jobId,
        page_url: pageUrl,
        screenshot_id: screenshotId,
        model: 'gpt-5-nano'
      })
      .setContext({
        user_input: 'AI analyzed conversation',
        page_info: { url: pageUrl },
        raw_request: requestData
      })
      .setContent({
        description: 'AI analyzed conversation',
        request_description: aiAnalysis.request_description || 'AI analyzed request',
        response_description: aiAnalysis.response_description || 'AI analyzed response',
        request_summary: aiAnalysis.request_summary || null,
        response_summary: aiAnalysis.response_summary || null,
        key_findings: aiAnalysis.key_findings || [],
        confidence_score: aiAnalysis.confidence_score || 0,
        raw_response: responseData
      })
      .addAction({
        type: 'analyze',
        description: 'AI analyzed conversation request and response',
        status: 'completed'
      })

    // Add Playwright script as artifact if present
    if (aiAnalysis.playwright_script) {
      response.addArtifact({
        type: 'script',
        name: 'playwright-script.js',
        content: aiAnalysis.playwright_script,
        downloadable: true,
        preview: false
      })
    }

    // Add HTML content as artifact if present
    if (aiAnalysis.html_content) {
      response.addArtifact({
        type: 'html',
        name: 'page-content.html',
        content: aiAnalysis.html_content,
        downloadable: true,
        preview: true
      })
    }

    // Add forms data as artifact if present
    if (aiAnalysis.forms_data) {
      response.addArtifact({
        type: 'json',
        name: 'forms-data.json',
        content: JSON.stringify(aiAnalysis.forms_data, null, 2),
        downloadable: true,
        preview: false
      })
    }

    // Add screenshot data as artifact if present
    if (aiAnalysis.screenshot_data) {
      response.addArtifact({
        type: 'image',
        name: 'screenshot.png',
        content: aiAnalysis.screenshot_data,
        downloadable: true,
        preview: true
      })
    }

    return response.build()
  }

  /**
   * Create a structured response with separate payload components
   */
  static createEnhancedResponse(agentName, jobId, pageUrl, requestData, responseData, payloadComponents = [], screenshotData = []) {
    const response = new StructuredAIResponse()
      .setMetadata({
        agent_name: agentName,
        conversation_type: 'enhanced_conversation',
        job_id: jobId,
        page_url: pageUrl,
        model: 'gpt-5-nano'
      })
      .setContext({
        user_input: 'Enhanced conversation with separate payload components',
        page_info: { url: pageUrl },
        raw_request: requestData
      })
      .setContent({
        description: 'Enhanced conversation with separate payload components',
        raw_response: responseData
      })

    // Add payload components
    payloadComponents.forEach(component => {
      response.addPayloadComponent(component)
    })

    // Add screenshots with metadata
    screenshotData.forEach(screenshot => {
      response.addScreenshot(screenshot)
    })

    return response.build()
  }

  /**
   * Create a conversation flow response (screenshot → user → AI → action → screenshot)
   */
  static createConversationFlowResponse(agentName, jobId, pageUrl, flowSteps = []) {
    const response = new StructuredAIResponse()
      .setMetadata({
        agent_name: agentName,
        conversation_type: 'conversation_flow',
        job_id: jobId,
        page_url: pageUrl,
        model: 'gpt-5-nano'
      })
      .setContext({
        user_input: 'Conversation flow with step-by-step screenshots and actions',
        page_info: { url: pageUrl }
      })
      .setContent({
        description: 'Step-by-step conversation flow with screenshots before and after each action'
      })

    // Add flow steps
    flowSteps.forEach((step, index) => {
      response.addAction({
        type: step.type,
        description: step.description,
        status: step.status || 'completed',
        details: step.details || null
      })

      // Add screenshot if present
      if (step.screenshot) {
        response.addScreenshot({
          name: `step-${index + 1}-screenshot.png`,
          content: step.screenshot.content,
          url: step.screenshot.url,
          step: `step_${index + 1}`,
          action: step.action,
          before_action: step.before_action || false,
          after_action: step.after_action || false,
          metadata: step.screenshot.metadata || {}
        })
      }

      // Add payload component if present
      if (step.payload) {
        response.addPayloadComponent({
          type: step.payload.type,
          name: step.payload.name,
          content: step.payload.content,
          data: step.payload.data,
          step: `step_${index + 1}`,
          action: step.action,
          metadata: step.payload.metadata || {}
        })
      }
    })

    return response.build()
  }
}

export default StructuredAIResponse
