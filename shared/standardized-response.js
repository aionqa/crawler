/**
 * Standardized Response Helper for AionQA Agent Modules
 * 
 * This module provides helper functions to create standardized responses
 * that comply with the STANDARDIZED_COMMUNICATION_FORMAT.md specification.
 */

/**
 * Creates a standardized success response with comprehensive AI summary
 * @param {Object} params - Response parameters
 * @param {string} params.url_after - Final URL after operation
 * @param {Array} params.cookies - Cookies after operation
 * @param {string} params.page_content - HTML content of final page
 * @param {string} params.page_title - Title of final page
 * @param {Array} params.redirect_chain - Array of URLs in redirect chain
 * @param {Array} params.screenshots - Array of screenshot objects
 * @param {string} params.video_file_id - GridFS file ID for video recording
 * @param {string} params.playwright_code - Complete Playwright code executed
 * @param {Array} params.ai_prompts - Array of AI prompt objects
 * @param {Array} params.success_indicators - Array of success indicators
 * @param {Array} params.failure_indicators - Array of failure indicators
 * @param {string} params.reasoning - AI reasoning for success/failure determination
 * @param {Array} params.next_actions - Array of suggested next actions
 * @param {string} params.module_name - Name of the agent module
 * @param {number} params.duration_ms - Total operation duration
 * @param {number} params.attempts - Number of attempts made
 * @param {number} params.confidence - AI confidence level (0-100)
 * @param {string} params.summary - Human-readable summary
 * @param {Object} params.additional_result - Additional result data (e.g., crawled_pages)
 * @param {Object} params.context - Operation context
 * @param {Array} params.attempts_made - Array of attempts made
 * @param {string} params.operation_type - Type of operation (login/crawl)
 * @param {Object} params.ai_summary - Comprehensive AI summary (optional)
 * @returns {Object} Standardized success response
 */
export function createSuccessResponse({
  url_after,
  cookies = [],
  page_content = '',
  page_title = '',
  redirect_chain = [],
  screenshots = [],
  video_file_id = null,
  playwright_code = '',
  ai_prompts = [],
  success_indicators = [],
  failure_indicators = [],
  reasoning = '',
  next_actions = [],
  module_name,
  duration_ms,
  attempts,
  confidence,
  summary,
  additional_result = {},
  context = {},
  attempts_made = [],
  operation_type = 'unknown',
  ai_summary = null
}) {
  return {
    success: true,
    confidence: Math.max(0, Math.min(100, confidence || 0)),
    summary: summary || 'Operation completed successfully',
    result: {
      url_after,
      cookies,
      page_content,
      page_title,
      redirect_chain,
      ...additional_result
    },
    artifacts: {
      screenshots,
      video_file_id,
      playwright_code,
      ai_prompts
    },
    ai_analysis: {
      success_indicators,
      failure_indicators,
      reasoning,
      next_actions
    },
    ai_summary: ai_summary || {
      executive_summary: summary || 'Operation completed successfully',
      detailed_summary: `Operation completed in ${duration_ms}ms with ${attempts} attempts. ${screenshots.length} screenshots captured.`,
      key_findings: success_indicators,
      success_factors: success_indicators,
      failure_factors: failure_indicators,
      recommendations: next_actions,
      technical_details: {
        pages_analyzed: 1,
        interactions_performed: attempts,
        ai_decisions_made: ai_prompts.length,
        artifacts_collected: screenshots.length
      },
      generated_at: new Date().toISOString(),
      operation_type,
      context_used: {
        project_id: context?.project_id,
        configuration_id: context?.configuration_id,
        job_id: context?.job_id,
        has_credentials: !!(context?.credentials?.username && context?.credentials?.password)
      }
    },
    metadata: {
      module_name,
      duration_ms,
      attempts,
      timestamp: new Date().toISOString()
    }
  };
}

/**
 * Creates a standardized error response with comprehensive AI summary
 * @param {Object} params - Error response parameters
 * @param {string} params.summary - Error description
 * @param {string} params.playwright_code - Code that was attempted
 * @param {Array} params.failure_indicators - Array of failure indicators
 * @param {string} params.reasoning - Why the operation failed
 * @param {string} params.module_name - Name of the agent module
 * @param {number} params.duration_ms - Total operation duration
 * @param {number} params.attempts - Number of attempts made
 * @param {string} params.error_code - Error code
 * @param {string} params.error_message - Error message
 * @param {Object} params.error_details - Additional error details
 * @param {Object} params.context - Operation context
 * @param {Array} params.attempts_made - Array of attempts made
 * @param {string} params.operation_type - Type of operation (login/crawl)
 * @param {Object} params.ai_summary - Comprehensive AI summary (optional)
 * @returns {Object} Standardized error response
 */
export function createErrorResponse({
  summary,
  playwright_code = '',
  failure_indicators = [],
  reasoning = '',
  module_name,
  duration_ms,
  attempts,
  error_code = 'OPERATION_FAILED',
  error_message = 'Operation failed',
  error_details = {},
  context = {},
  attempts_made = [],
  operation_type = 'unknown',
  ai_summary = null
}) {
  return {
    success: false,
    confidence: 0,
    summary: summary || 'Operation failed',
    result: null,
    artifacts: {
      screenshots: [],
      video_file_id: null,
      playwright_code,
      ai_prompts: []
    },
    ai_analysis: {
      success_indicators: [],
      failure_indicators,
      reasoning,
      next_actions: []
    },
    ai_summary: ai_summary || {
      executive_summary: summary || 'Operation failed',
      detailed_summary: `Operation failed after ${duration_ms}ms with ${attempts} attempts. Error: ${error_message}`,
      key_findings: failure_indicators,
      success_factors: [],
      failure_factors: failure_indicators,
      recommendations: ['Review error details and retry with different approach'],
      technical_details: {
        pages_analyzed: 0,
        interactions_performed: attempts,
        ai_decisions_made: 0,
        artifacts_collected: 0
      },
      generated_at: new Date().toISOString(),
      operation_type,
      context_used: {
        project_id: context?.project_id,
        configuration_id: context?.configuration_id,
        job_id: context?.job_id,
        has_credentials: !!(context?.credentials?.username && context?.credentials?.password)
      }
    },
    metadata: {
      module_name,
      duration_ms,
      attempts,
      timestamp: new Date().toISOString()
    },
    error: {
      code: error_code,
      message: error_message,
      details: error_details
    }
  };
}

/**
 * Creates a screenshot artifact object
 * @param {string} filename - Screenshot filename
 * @param {Buffer|string} data - Screenshot data (Buffer or base64 string)
 * @param {string} description - Description of the screenshot
 * @returns {Object} Screenshot artifact object
 */
export function createScreenshotArtifact(filename, data, description) {
  const base64Data = Buffer.isBuffer(data) ? data.toString('base64') : data;
  
  return {
    filename,
    data: base64Data,
    timestamp: new Date().toISOString(),
    description
  };
}

/**
 * Creates an AI prompt artifact object
 * @param {string} prompt - The prompt sent to AI
 * @param {string} response - The AI response
 * @param {string} purpose - Purpose of the prompt
 * @returns {Object} AI prompt artifact object
 */
export function createAIPromptArtifact(prompt, response, purpose) {
  return {
    prompt,
    response,
    timestamp: new Date().toISOString(),
    purpose
  };
}

/**
 * Validates that a response conforms to the standardized format
 * @param {Object} response - Response to validate
 * @returns {Object} Validation result with isValid and errors
 */
export function validateStandardizedResponse(response) {
  const errors = [];
  
  // Check required top-level fields
  const requiredFields = ['success', 'confidence', 'summary', 'result', 'artifacts', 'ai_analysis', 'metadata'];
  for (const field of requiredFields) {
    if (!(field in response)) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  
  // Check success field type
  if (typeof response.success !== 'boolean') {
    errors.push('Field "success" must be a boolean');
  }
  
  // Check confidence field
  if (typeof response.confidence !== 'number' || response.confidence < 0 || response.confidence > 100) {
    errors.push('Field "confidence" must be a number between 0 and 100');
  }
  
  // Check summary field
  if (typeof response.summary !== 'string') {
    errors.push('Field "summary" must be a string');
  }
  
  // Check result field structure
  if (response.success && response.result) {
    const requiredResultFields = ['url_after', 'cookies', 'page_content', 'page_title'];
    for (const field of requiredResultFields) {
      if (!(field in response.result)) {
        errors.push(`Missing required result field: ${field}`);
      }
    }
  }
  
  // Check artifacts field structure
  if (response.artifacts) {
    const requiredArtifactFields = ['screenshots', 'playwright_code', 'ai_prompts'];
    for (const field of requiredArtifactFields) {
      if (!(field in response.artifacts)) {
        errors.push(`Missing required artifact field: ${field}`);
      }
    }
  }
  
  // Check ai_analysis field structure
  if (response.ai_analysis) {
    const requiredAnalysisFields = ['success_indicators', 'failure_indicators', 'reasoning'];
    for (const field of requiredAnalysisFields) {
      if (!(field in response.ai_analysis)) {
        errors.push(`Missing required ai_analysis field: ${field}`);
      }
    }
  }
  
  // Check metadata field structure
  if (response.metadata) {
    const requiredMetadataFields = ['module_name', 'duration_ms', 'attempts', 'timestamp'];
    for (const field of requiredMetadataFields) {
      if (!(field in response.metadata)) {
        errors.push(`Missing required metadata field: ${field}`);
      }
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * AI Success Evaluation Helper
 * Evaluates login success based on comprehensive criteria and generates detailed summaries
 */
export class AISuccessEvaluator {
  constructor(openai) {
    this.openai = openai;
  }
  
  /**
   * Generates a comprehensive summary of what happened during the operation
   * @param {Object} operationData - Complete operation data
   * @param {string} operationData.operation_type - Type of operation (login/crawl)
   * @param {string} operationData.url - Target URL
   * @param {Object} operationData.context - Operation context
   * @param {Object} operationData.result - Operation result
   * @param {Array} operationData.attempts - Array of attempts made
   * @param {Array} operationData.screenshots - Screenshots captured
   * @param {Array} operationData.ai_prompts - AI prompts used
   * @param {number} operationData.duration_ms - Total duration
   * @param {boolean} operationData.success - Whether operation succeeded
   * @returns {Promise<Object>} Detailed summary with AI analysis
   */
  async generateOperationSummary(operationData) {
    const {
      operation_type = 'unknown',
      url,
      context,
      result,
      attempts = [],
      screenshots = [],
      ai_prompts = [],
      duration_ms,
      success
    } = operationData;
    
    try {
      
      const prompt = `You are an AI assistant providing a comprehensive summary of a ${operation_type} operation. Analyze the following data and provide a detailed summary of what happened.

OPERATION DETAILS:
- Type: ${operation_type}
- Target URL: ${url}
- Project ID: ${context?.project_id || 'Unknown'}
- Job ID: ${context?.job_id || 'Unknown'}
- Duration: ${duration_ms}ms
- Success: ${success}

CONTEXT PROVIDED:
- Project ID: ${context?.project_id || 'Not provided'}
- Configuration ID: ${context?.configuration_id || 'Not provided'}
- Job ID: ${context?.job_id || 'Not provided'}
- Username: ${context?.credentials?.username || 'Not provided'}
- Headless Mode: ${context?.options?.headless !== false}
- Timeout: ${context?.options?.timeout || 30000}ms
- Max Retries: ${context?.options?.max_retries || 2}
- Screenshots Enabled: ${context?.options?.enable_screenshots !== false}
- Video Recording: ${context?.options?.enable_video_recording || false}

ATTEMPTS MADE:
${Array.isArray(attempts) ? attempts.map((attempt, i) => `${i + 1}. ${attempt}`).join('\n') : 'No attempts recorded'}

FINAL RESULT:
- URL After: ${result?.url_after || 'Unknown'}
- Page Title: ${result?.page_title || 'Unknown'}
- Cookies Count: ${result?.cookies?.length || 0}
- Page Content Length: ${result?.page_content?.length || 0} characters

ARTIFACTS COLLECTED:
- Screenshots: ${screenshots.length}
- AI Prompts: ${ai_prompts.length}
- Playwright Code: ${result?.artifacts?.playwright_code ? 'Yes' : 'No'}

AI ANALYSIS:
- Success Indicators: ${result?.ai_analysis?.success_indicators?.join(', ') || 'None'}
- Failure Indicators: ${result?.ai_analysis?.failure_indicators?.join(', ') || 'None'}
- Reasoning: ${result?.ai_analysis?.reasoning || 'No reasoning provided'}

Based on this comprehensive data, provide a detailed summary that includes:

1. **What was attempted**: Clear description of the operation
2. **What happened**: Step-by-step breakdown of the process
3. **What was discovered**: Key findings about the target website
4. **What worked/didn't work**: Analysis of successful and failed approaches
5. **What was learned**: Insights gained from the operation
6. **What's the current state**: Final state of the operation
7. **What should happen next**: Recommended next steps

Respond in JSON format:
{
  "executive_summary": "Brief 1-2 sentence summary of what happened",
  "detailed_summary": "Comprehensive breakdown of the entire operation",
  "key_findings": ["List of important discoveries"],
  "success_factors": ["What contributed to success"],
  "failure_factors": ["What caused failures"],
  "recommendations": ["What should be done next"],
  "technical_details": {
    "pages_analyzed": number,
    "interactions_performed": number,
    "ai_decisions_made": number,
    "artifacts_collected": number
  }
}`;

      const response = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      });

      const summary = JSON.parse(response.choices[0].message.content);
      
      return {
        ...summary,
        generated_at: new Date().toISOString(),
        operation_type,
        context_used: {
          project_id: context?.project_id,
          configuration_id: context?.configuration_id,
          job_id: context?.job_id,
          has_credentials: !!(context?.credentials?.username && context?.credentials?.password)
        }
      };
      
    } catch (error) {
      console.log(`[AISuccessEvaluator] Summary generation error: ${error.message}`);
      return {
        executive_summary: `${operation_type} operation ${success ? 'succeeded' : 'failed'} after ${duration_ms}ms`,
        detailed_summary: `Operation completed with ${success ? 'success' : 'failure'}. Duration: ${duration_ms}ms, Attempts: ${Array.isArray(attempts) ? attempts.length : 0}, Screenshots: ${screenshots.length}`,
        key_findings: ['Summary generation failed'],
        success_factors: success ? ['Operation completed'] : ['Operation failed'],
        failure_factors: success ? [] : ['Operation did not succeed'],
        recommendations: ['Review logs for detailed information'],
        technical_details: {
          pages_analyzed: 1,
          interactions_performed: Array.isArray(attempts) ? attempts.length : 0,
          ai_decisions_made: ai_prompts.length,
          artifacts_collected: screenshots.length
        },
        generated_at: new Date().toISOString(),
        operation_type: operationData.operation_type,
        context_used: {
          project_id: operationData.context?.project_id,
          configuration_id: operationData.context?.configuration_id,
          job_id: operationData.context?.job_id,
          has_credentials: !!(operationData.context?.credentials?.username && operationData.context?.credentials?.password)
        }
      };
    }
  }
  
  /**
   * Evaluates login success using AI
   * @param {Object} pageData - Page data for evaluation
   * @param {string} pageData.url - Current URL
   * @param {string} pageData.title - Page title
   * @param {string} pageData.content - Page content
   * @param {Array} pageData.cookies - Current cookies
   * @param {Array} pageData.redirect_chain - Redirect chain
   * @param {string} pageData.module_type - Type of module (login/crawler)
   * @returns {Promise<Object>} AI evaluation result
   */
  async evaluateSuccess(pageData, module_type = 'login') {
    try {
      const { url, title, content, cookies, redirect_chain } = pageData;
      
      // Analyze page state
      const hasLoginForm = content.toLowerCase().includes('login') || content.toLowerCase().includes('sign in');
      const hasErrorMessages = content.toLowerCase().includes('error') || content.toLowerCase().includes('invalid') || content.toLowerCase().includes('incorrect');
      const hasSuccessIndicators = content.toLowerCase().includes('welcome') || content.toLowerCase().includes('dashboard') || content.toLowerCase().includes('profile');
      const isRedirectedToApp = url.includes('app') || url.includes('dashboard') || url.includes('home');
      
      // Analyze cookies for session indicators
      const sessionCookies = cookies.filter(c => 
        c.name.toLowerCase().includes('session') || 
        c.name.toLowerCase().includes('token') || 
        c.name.toLowerCase().includes('auth') ||
        c.name.toLowerCase().includes('jwt') ||
        c.name.toLowerCase().includes('access')
      );
      
      const prompt = `You are an AI assistant evaluating ${module_type} success for a web application. Analyze the following comprehensive information:

CURRENT STATE:
- URL: ${url}
- Page Title: ${title}
- Content Length: ${content.length} characters
- Has Login Form: ${hasLoginForm}
- Has Error Messages: ${hasErrorMessages}
- Has Success Indicators: ${hasSuccessIndicators}
- Is Redirected to App: ${isRedirectedToApp}
- Total Cookies: ${cookies.length}
- Session Cookies: ${sessionCookies.length}

SESSION COOKIES:
${sessionCookies.map(c => `${c.name}: ${c.value.substring(0, 30)}... (domain: ${c.domain}, secure: ${c.secure})`).join('\n')}

PAGE CONTENT PREVIEW (first 800 chars):
${content.substring(0, 800)}

${module_type.toUpperCase()} SUCCESS INDICATORS TO CONSIDER:
${module_type === 'login' ? `
1. URL changed to app/dashboard/home (not login/auth pages)
2. Presence of session/authentication cookies
3. Page content shows user-specific information
4. No error messages about invalid credentials
5. Page title indicates successful login
6. Presence of logout buttons or user menus` : `
1. Successful page loads and content extraction
2. Links and forms discovered
3. No network errors or timeouts
4. Content is not empty or blocked
5. Page structure is accessible`}

Based on this analysis, determine:
1. Is the ${module_type} successful? (true/false)
2. What is the confidence level? (0-100)
3. What are the key success/failure indicators?
4. What is the reasoning for this determination?

Respond in JSON format:
{
  "success": boolean,
  "confidence": number,
  "reasoning": string,
  "success_indicators": [string],
  "failure_indicators": [string]
}`;

      const response = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      });

      const result = JSON.parse(response.choices[0].message.content);
      
      return {
        success: result.success || false,
        confidence: Math.max(0, Math.min(100, result.confidence || 0)),
        reasoning: result.reasoning || 'AI evaluation completed',
        success_indicators: result.success_indicators || [],
        failure_indicators: result.failure_indicators || []
      };
    } catch (error) {
      console.log(`[AISuccessEvaluator] AI evaluation error: ${error.message}`);
      return {
        success: false,
        confidence: 0,
        reasoning: 'AI evaluation failed, defaulting to failure',
        success_indicators: [],
        failure_indicators: ['AI evaluation timeout or error']
      };
    }
  }
}
