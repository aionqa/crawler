/**
 * AI decision-making and OpenAI interactions
 */

import OpenAI from 'openai';
import { aiConversationLogger } from '/app/shared/ai-conversation-logger.js';
import { StructuredAIResponse } from '/app/shared/structured-ai-response.js';

console.log('[AI] 🔧 AI conversation logger imported successfully');

export function initializeOpenAI(apiKey) {
  if (!apiKey) {
    throw new Error('OpenAI API key is required');
  }
  
  return new OpenAI({
    apiKey: apiKey
  });
}

/**
 * Analyzes form structure and generates initial approach using AI
 */
export async function aiAnalyzeForm(page, openaiClient, credentials, context = {}) {
  console.log('[AI] 🤖 Starting AI form analysis...');
  
  try {
    const htmlContent = await page.content();
    const currentUrl = page.url();
    const currentTitle = await page.title();
    
    const aiPrompt = `You are an expert web automation engineer. Analyze this HTML page and provide a detailed form analysis.

CONTEXT:
- Target URL: ${currentUrl}
- Page Title: ${currentTitle}
- Username: ${credentials.username}
- Password: ${credentials.password}
- Task: ${context.task || 'Automated login'}
- Timeout: ${context.options?.timeout || 30000}ms
- Max Attempts: ${context.options?.max_attempts || 5}
- Headless Mode: ${context.options?.headless !== false}
- Initial Cookies: ${context.cookies?.length || 0} cookies
- Project ID: ${context.project_id || 'N/A'}

PLAYWRIGHT FORM COLLECTION DATA:
${JSON.stringify(context.formCollection || {}, null, 2)}

HTML CONTENT:
${htmlContent.substring(0, 10000)}${htmlContent.length > 10000 ? '...[truncated]' : ''}

ANALYSIS REQUIREMENTS:
1. Identify all input fields (type, name, id, placeholder, required)
2. Identify all buttons (text, type, form association)
3. Analyze form structure and relationships
4. Determine the most likely login approach
5. Identify potential issues or challenges

RESPONSE FORMAT (JSON only):
{
  "forms": [
    {
      "index": 0,
      "action": "form action URL",
      "method": "GET|POST",
      "fields": [
        {
          "type": "text|email|password",
          "name": "field name",
          "id": "field id",
          "placeholder": "placeholder text",
          "required": true|false,
          "purpose": "username|email|password|other"
        }
      ],
      "buttons": [
        {
          "text": "button text",
          "type": "submit|button",
          "form": "associated form index"
        }
      ]
    }
  ],
  "recommended_approach": "description of best approach",
  "potential_issues": ["list of potential problems"],
  "confidence_score": 0.0-1.0
}

Respond with ONLY valid JSON, no markdown, no explanations.`;

    console.log('[AI] 📝 Sending form analysis prompt to OpenAI...');
    console.log(`[AI] 🔧 Job ID: ${context.job_id}, Backend URL: ${process.env.BACKEND_URL || 'http://172.19.0.1:4000'}`);
    
    const completion = await aiConversationLogger.createChatCompletion(
      openaiClient,
      context.job_id,
      'unified-crawler',
      'form_analysis',
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: aiPrompt }],
        response_format: { type: "json_object" }
      },
      null, // screenshot_id
      currentUrl,
      {
        html_content: htmlContent.substring(0, 10000),
        page_title: currentTitle,
        credentials_provided: !!credentials,
        form_collection: context.formCollection || {}
      }
    );

    const response = completion.choices[0].message.content;
    console.log('[AI] 📥 Received AI response for form analysis');
    
    const analysis = JSON.parse(response);
    console.log(`[AI] ✅ Form analysis complete. Found ${analysis.forms?.length || 0} forms, confidence: ${analysis.confidence_score}`);
    
    return analysis;
  } catch (error) {
    console.error('[AI] ❌ Error in AI form analysis:', error);
    throw new Error(`AI form analysis failed: ${error.message}`);
  }
}

/**
 * Generates Playwright code for a specific approach
 */
export async function generatePlaywrightCodeForApproach(page, credentials, openaiClient, analysis, conversationHistory, approachNumber, context = {}) {
  console.log(`[AI] 🤖 Generating Playwright code for approach ${approachNumber}...`);
  
  try {
    const htmlContent = await page.content();
    const currentUrl = page.url();
    const currentTitle = await page.title();
    
    const conversationContext = conversationHistory.length > 0 
      ? `\nCONVERSATION HISTORY:\n${conversationHistory.map((entry, i) => `Attempt ${i + 1}: ${entry.action} - ${entry.result}`).join('\n')}`
      : '';
    
    const aiPrompt = `You are an expert Playwright automation engineer. Generate Playwright code to attempt login on this page.

CONTEXT:
- Target URL: ${currentUrl}
- Page Title: ${currentTitle}
- Username: ${credentials.username}
- Password: ${credentials.password}
- Task: ${context.task || 'Automated login'}
- Timeout: ${context.options?.timeout || 30000}ms
- Max Attempts: ${context.options?.max_attempts || 5}
- Headless Mode: ${context.options?.headless !== false}
- Initial Cookies: ${context.cookies?.length || 0} cookies
- Project ID: ${context.project_id || 'N/A'}
- Approach Number: ${approachNumber}

FORM ANALYSIS:
${JSON.stringify(analysis, null, 2)}
${conversationContext}

HTML CONTENT:
${htmlContent.substring(0, 8000)}${htmlContent.length > 8000 ? '...[truncated]' : ''}

REQUIREMENTS:
1. Generate working Playwright code that attempts to login
2. Use multiple selector strategies for robustness
3. Handle different form structures
4. Include proper error handling
5. Wait for navigation or form submission
6. Return the final page state

CODE REQUIREMENTS:
- Use only Playwright APIs available in Node.js context
- Do NOT use: require(), window, document, browser, or any browser-specific APIs
- Use page object methods: page.click(), page.fill(), page.waitForSelector(), etc.
- Return a result object with success status and details

RESPONSE FORMAT (JavaScript only):
Return ONLY valid JavaScript code that can be executed with eval(). No markdown, no explanations, no code blocks.

The code should:
1. Accept (page, credentials) as parameters
2. Return a Promise that resolves to { success: boolean, message: string, details: object }
3. Use try/catch for error handling
4. Include proper waits and timeouts

Example structure:
async function attemptLogin(page, credentials) {
  try {
    // Playwright code here
    return { success: true, message: 'Login successful', details: {} };
  } catch (error) {
    return { success: false, message: error.message, details: { error } };
  }
}`;

    console.log(`[AI] 📝 Sending Playwright code generation prompt for approach ${approachNumber}...`);
    
    const completion = await aiConversationLogger.createChatCompletion(
      openaiClient,
      context.job_id,
      'unified-crawler',
      'script_generation',
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: aiPrompt }]
      },
      null, // screenshot_id
      currentUrl,
      {
        html_content: htmlContent.substring(0, 8000),
        page_title: currentTitle,
        approach_number: approachNumber,
        credentials_provided: !!credentials,
        conversation_history: conversationHistory,
        analysis: analysis
      }
    );

    let response = completion.choices[0].message.content;
    console.log('[AI] 📥 Received AI response for Playwright code generation');
    
    // Clean up the response to ensure it's pure JavaScript
    response = response.replace(/```javascript|```js|```/g, '').trim();
    
    // Fix missing return statements - this is a critical fix for syntax errors
    // Handle various patterns of missing return statements
    response = response.replace(/\{\s*success:\s*true\s*,/g, 'return { success: true,');
    response = response.replace(/\{\s*success:\s*false\s*,/g, 'return { success: false,');
    
    // Fix patterns like: { success, message, details: { attempts } };
    response = response.replace(/\{\s*success,\s*message,\s*details:/g, 'return { success, message, details:');
    
    // Fix patterns where success is a variable
    response = response.replace(/\{\s*success\s*,/g, 'return { success,');
    
    // Fix any remaining patterns that start with { and contain success
    response = response.replace(/(\n\s*)\{\s*success\s*([^}]*)\s*;\s*(\n)/g, '$1return { success$2;\n');
    
    // More comprehensive fix for all object literals that should be return statements
    // This handles cases where the AI generates standalone object literals
    const lines = response.split('\n');
    const fixedLines = lines.map((line, index) => {
      // Check if line starts with whitespace followed by { and contains success
      if (/^\s*\{\s*success/.test(line) && !line.includes('return')) {
        // Add return keyword at the beginning of the object literal
        return line.replace(/^(\s*)\{/, '$1return {');
      }
      return line;
    });
    response = fixedLines.join('\n');
    
    // Validate that the response looks like JavaScript code
    if (!response.includes('async function') && !response.includes('function')) {
      throw new Error('AI response does not contain valid JavaScript function');
    }
    
    console.log(`[AI] ✅ Playwright code generated for approach ${approachNumber}`);
    return response;
  } catch (error) {
    console.error(`[AI] ❌ Error generating Playwright code for approach ${approachNumber}:`, error);
    throw new Error(`AI code generation failed: ${error.message}`);
  }
}

/**
 * Analyzes login success using AI
 */
export async function analyzeLoginSuccess(openaiClient, htmlContent, currentUrl, currentTitle, executionResult, context = {}) {
  console.log('[AI] 🤖 Analyzing login success...');
  
  try {
    const aiPrompt = `You are an expert web automation engineer. Analyze this page state to determine if login was successful.

CONTEXT:
- Current URL: ${currentUrl}
- Page Title: ${currentTitle}
- Task: ${context.task || 'Automated login'}
- Timeout: ${context.options?.timeout || 30000}ms
- Max Attempts: ${context.options?.max_attempts || 5}
- Headless Mode: ${context.options?.headless !== false}
- Initial Cookies: ${context.cookies?.length || 0} cookies
- Project ID: ${context.project_id || 'N/A'}

EXECUTION RESULT:
${JSON.stringify(executionResult, null, 2)}

CURRENT PAGE HTML:
${htmlContent.substring(0, 10000)}${htmlContent.length > 10000 ? '...[truncated]' : ''}

SUCCESS INDICATORS:
- URL changed to dashboard, profile, or protected area
- Page contains user-specific content
- Login form is no longer visible
- Success messages or welcome text
- Navigation menu shows logged-in state

FAILURE INDICATORS:
- Still on login page
- Error messages about invalid credentials
- Login form still visible
- URL did not change or changed to error page

ANALYSIS REQUIREMENTS:
1. Determine if login was successful (true/false)
2. Provide confidence score (0.0-1.0)
3. Identify specific success/failure indicators
4. Suggest next action if failed

RESPONSE FORMAT (JSON only):
{
  "success": true|false,
  "confidence": 0.0-1.0,
  "indicators": ["list of success/failure indicators found"],
  "reasoning": "explanation of decision",
  "next_action": "suggested next step if failed",
  "url_changed": true|false,
  "page_type": "login|dashboard|error|other"
}

Respond with ONLY valid JSON, no markdown, no explanations.`;

    console.log('[AI] 📝 Sending login success analysis prompt to OpenAI...');
    
    const completion = await aiConversationLogger.createChatCompletion(
      openaiClient,
      context.job_id,
      'unified-crawler',
      'login_success_analysis',
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: aiPrompt }],
        response_format: { type: "json_object" }
      },
      null, // screenshot_id
      currentUrl,
      {
        html_content: htmlContent.substring(0, 10000),
        page_title: currentTitle,
        execution_result: executionResult,
        analysis_type: 'login_success_analysis'
      }
    );

    const response = completion.choices[0].message.content;
    console.log('[AI] 📥 Received AI response for login success analysis');
    
    const analysis = JSON.parse(response);
    console.log(`[AI] ✅ Login success analysis complete. Success: ${analysis.success}, Confidence: ${analysis.confidence}`);
    
    return analysis;
  } catch (error) {
    console.error('[AI] ❌ Error in login success analysis:', error);
    // Fallback analysis
    const urlChanged = currentUrl !== executionResult.initialUrl;
    const hasErrorMessages = htmlContent.toLowerCase().includes('error') || 
                           htmlContent.toLowerCase().includes('invalid') ||
                           htmlContent.toLowerCase().includes('incorrect');
    
    return {
      success: urlChanged && !hasErrorMessages,
      confidence: 0.5,
      indicators: [`URL changed: ${urlChanged}`, `Error messages: ${hasErrorMessages}`],
      reasoning: 'Fallback analysis due to AI error',
      next_action: 'Try different approach',
      url_changed: urlChanged,
      page_type: hasErrorMessages ? 'error' : (urlChanged ? 'dashboard' : 'login')
    };
  }
}
