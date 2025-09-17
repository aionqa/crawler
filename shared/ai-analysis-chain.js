/**
 * AI Analysis Chain for AionQA Crawlers
 * 
 * Implements the required AI analysis chain:
 * 1. Page analysis (or screenshot for media crawler)
 * 2. AI generates playwright script
 * 3. Execute script with timeout
 * 4. AI analyzes result
 * 5. Repeat up to depth 5 if action not finished
 * 6. Final AI summary and success evaluation
 */

import { createScreenshotArtifact, createAIPromptArtifact } from './standardized-response.js';

export class AIAnalysisChain {
  constructor(openaiClient, options = {}) {
    this.openai = openaiClient;
    this.maxDepth = options.maxDepth || 5;
    this.timeout = options.timeout || 30000;
    this.backendUrl = options.backendUrl || 'http://back:4000';
  }

  /**
   * Main analysis chain execution
   * @param {Object} page - Playwright page object
   * @param {Object} context - Operation context
   * @param {string} crawlerType - Type of crawler (simplified, text, media, static)
   * @returns {Promise<Object>} Analysis result
   */
  async executeAnalysisChain(page, context, crawlerType) {
    const startTime = Date.now();
    const screenshots = [];
    const ai_prompts = [];
    const playwright_code = [];
    const attempts = [];
    const crawled_pages = [];
    let currentDepth = 0;
    let currentUrl = page.url();
    let finalCookies = [];

    console.log(`[AI-ANALYSIS] 🚀 Starting AI analysis chain for ${crawlerType} crawler`);
    console.log(`[AI-ANALYSIS] 🎯 Target URL: ${currentUrl}`);
    console.log(`[AI-ANALYSIS] 📊 Max depth: ${this.maxDepth}`);

    try {
      // Initial page analysis
      const initialAnalysis = await this.analyzePage(page, context, crawlerType, currentDepth);
      attempts.push(`Initial page analysis completed`);
      ai_prompts.push(createAIPromptArtifact(
        'Initial page analysis',
        JSON.stringify(initialAnalysis),
        'Analyze initial page state and determine next actions'
      ));

      // Capture initial screenshot
      if (context.options?.enable_screenshots !== false) {
        try {
          const screenshot = await page.screenshot({ type: 'png', fullPage: true });
          screenshots.push(createScreenshotArtifact(
            `initial_${crawlerType}_${Date.now()}.png`,
            screenshot,
            'Initial page state before analysis'
          ));
        } catch (error) {
          console.log(`[AI-ANALYSIS] Initial screenshot failed: ${error.message}`);
        }
      }

      // Main analysis loop
      while (currentDepth < this.maxDepth) {
        currentDepth++;
        console.log(`[AI-ANALYSIS] 🔄 Starting depth ${currentDepth}/${this.maxDepth}`);

        // Generate playwright script based on current analysis
        const scriptGeneration = await this.generatePlaywrightScript(
          page, context, crawlerType, currentDepth, initialAnalysis, attempts
        );
        
        if (!scriptGeneration.success) {
          console.log(`[AI-ANALYSIS] ❌ Script generation failed at depth ${currentDepth}`);
          break;
        }

        playwright_code.push(scriptGeneration.script);
        ai_prompts.push(createAIPromptArtifact(
          `Playwright script generation (depth ${currentDepth})`,
          scriptGeneration.script,
          'Generate script for page interaction'
        ));

        // Execute the script
        const executionResult = await this.executePlaywrightScript(
          page, scriptGeneration.script, context, currentDepth
        );

        attempts.push(`Depth ${currentDepth}: ${executionResult.message}`);
        
        // Capture screenshot after execution
        if (context.options?.enable_screenshots !== false) {
          try {
            const screenshot = await page.screenshot({ type: 'png', fullPage: true });
            screenshots.push(createScreenshotArtifact(
              `depth_${currentDepth}_${crawlerType}_${Date.now()}.png`,
              screenshot,
              `Page state after depth ${currentDepth} execution`
            ));
          } catch (error) {
            console.log(`[AI-ANALYSIS] Screenshot capture failed at depth ${currentDepth}: ${error.message}`);
          }
        }

        // Analyze execution result
        const resultAnalysis = await this.analyzeExecutionResult(
          page, context, crawlerType, currentDepth, executionResult
        );

        ai_prompts.push(createAIPromptArtifact(
          `Execution result analysis (depth ${currentDepth})`,
          JSON.stringify(resultAnalysis),
          'Analyze result of script execution'
        ));

        // Check if we should continue
        if (resultAnalysis.shouldContinue && currentDepth < this.maxDepth) {
          console.log(`[AI-ANALYSIS] ✅ Continuing to next depth based on AI analysis`);
          continue;
        } else {
          console.log(`[AI-ANALYSIS] 🏁 Stopping at depth ${currentDepth}: ${resultAnalysis.reason}`);
          break;
        }
      }

      // Final state collection
      currentUrl = page.url();
      const finalTitle = await page.title().catch(() => '');
      const finalContent = await page.content().catch(() => '');
      finalCookies = await page.context().cookies().catch(() => []);

      // Add final page to crawled pages
      crawled_pages.push({
        url: currentUrl,
        title: finalTitle,
        content_length: finalContent.length,
        depth_reached: currentDepth,
        total_attempts: attempts.length,
        screenshots_captured: screenshots.length
      });

      // Final AI evaluation
      const finalEvaluation = await this.generateFinalEvaluation(
        page, context, crawlerType, currentDepth, attempts, screenshots, ai_prompts
      );

      const duration = Date.now() - startTime;

      return {
        success: finalEvaluation.success,
        confidence: finalEvaluation.confidence,
        url_after: currentUrl,
        page_title: finalTitle,
        page_content: finalContent,
        cookies: finalCookies,
        redirect_chain: [context.initialUrl || currentUrl, currentUrl],
        crawled_pages,
        screenshots,
        playwright_code: playwright_code.join('\n\n'),
        ai_prompts,
        ai_analysis: {
          success_indicators: finalEvaluation.success_indicators,
          failure_indicators: finalEvaluation.failure_indicators,
          reasoning: finalEvaluation.reasoning,
          next_actions: finalEvaluation.next_actions
        },
        metadata: {
          depth_reached: currentDepth,
          total_attempts: attempts.length,
          duration_ms: duration,
          crawler_type: crawlerType
        }
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`[AI-ANALYSIS] ❌ Analysis chain failed: ${error.message}`);
      
      return {
        success: false,
        confidence: 0,
        url_after: page.url(),
        page_title: await page.title().catch(() => ''),
        page_content: await page.content().catch(() => ''),
        cookies: await page.context().cookies().catch(() => []),
        redirect_chain: [context.initialUrl || page.url(), page.url()],
        crawled_pages,
        screenshots,
        playwright_code: playwright_code.join('\n\n'),
        ai_prompts,
        ai_analysis: {
          success_indicators: [],
          failure_indicators: ['Analysis chain failed', error.message],
          reasoning: 'Analysis chain encountered an error',
          next_actions: []
        },
        metadata: {
          depth_reached: currentDepth,
          total_attempts: attempts.length,
          duration_ms: duration,
          crawler_type: crawlerType,
          error: error.message
        }
      };
    }
  }

  /**
   * Analyze the current page state
   */
  async analyzePage(page, context, crawlerType, depth) {
    const url = page.url();
    const title = await page.title().catch(() => '');
    const content = await page.content().catch(() => '');

    let pageData = { url, title, content };

    // For media crawler, focus on visual elements
    if (crawlerType === 'media') {
      const images = await page.$$eval('img', els => els.map(el => ({
        src: el.src,
        alt: el.alt,
        width: el.naturalWidth,
        height: el.naturalHeight
      })));
      const videos = await page.$$eval('video', els => els.map(el => ({
        src: el.src,
        poster: el.poster
      })));
      pageData = { ...pageData, images, videos };
    }

    // For text crawler, focus on text content
    if (crawlerType === 'text') {
      const textContent = await page.evaluate(() => {
        const scripts = document.querySelectorAll('script, style');
        scripts.forEach(el => el.remove());
        return document.body.innerText || document.body.textContent || '';
      });
      const links = await page.$$eval('a[href]', els => els.map(el => ({
        text: el.innerText.trim(),
        href: el.href
      })));
      pageData = { ...pageData, textContent, links };
    }

    // For simplified crawler, focus on interactive elements
    if (crawlerType === 'simplified') {
      const inputs = await page.$$eval('input,textarea,select', els => els.map((el, i) => ({
        index: i,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        id: el.id || '',
        placeholder: el.getAttribute('placeholder') || ''
      })));
      const buttons = await page.$$eval('button,input[type="submit"],a[role="button"]', els => els.map((el, i) => ({
        index: i,
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || '').trim().slice(0, 120)
      })));
      pageData = { ...pageData, inputs, buttons };
    }

    const prompt = `You are an AI assistant analyzing a web page for a ${crawlerType} crawler. Analyze the following page data and determine what actions should be taken next.

PAGE DATA:
- URL: ${url}
- Title: ${title}
- Content Length: ${content.length} characters
- Depth: ${depth}
- Crawler Type: ${crawlerType}

${crawlerType === 'media' ? `
MEDIA ELEMENTS:
- Images: ${pageData.images?.length || 0}
- Videos: ${pageData.videos?.length || 0}
` : ''}

${crawlerType === 'text' ? `
TEXT CONTENT:
- Text Length: ${pageData.textContent?.length || 0} characters
- Links: ${pageData.links?.length || 0}
` : ''}

${crawlerType === 'simplified' ? `
INTERACTIVE ELEMENTS:
- Inputs: ${pageData.inputs?.length || 0}
- Buttons: ${pageData.buttons?.length || 0}
` : ''}

CONTEXT:
- Project ID: ${context.project_id}
- Has Credentials: ${!!(context.credentials?.username && context.credentials?.password)}
- Username: ${context.credentials?.username || 'Not provided'}

Based on this analysis, determine:
1. What type of page this is (login, content, error, etc.)
2. What actions should be taken next
3. Whether login is needed
4. What elements should be interacted with
5. Whether this appears to be a successful state

Respond in JSON format:
{
  "page_type": "login|content|error|redirect|unknown",
  "needs_login": boolean,
  "interactive_elements": ["list of elements to interact with"],
  "suggested_actions": ["list of suggested actions"],
  "is_successful_state": boolean,
  "confidence": number,
  "reasoning": "explanation of analysis"
}`;

    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0.2
      });

      return JSON.parse(response.choices[0].message.content);
    } catch (error) {
      console.log(`[AI-ANALYSIS] Page analysis failed: ${error.message}`);
      return {
        page_type: 'unknown',
        needs_login: false,
        interactive_elements: [],
        suggested_actions: ['Continue analysis'],
        is_successful_state: false,
        confidence: 0,
        reasoning: 'Page analysis failed'
      };
    }
  }

  /**
   * Generate playwright script based on analysis
   */
  async generatePlaywrightScript(page, context, crawlerType, depth, analysis, attempts) {
    const url = page.url();
    const title = await page.title().catch(() => '');

    const prompt = `You are an AI assistant generating a Playwright script for a ${crawlerType} crawler. Based on the analysis, generate a script that will interact with the page.

CURRENT STATE:
- URL: ${url}
- Title: ${title}
- Depth: ${depth}
- Analysis: ${JSON.stringify(analysis)}
- Previous Attempts: ${attempts.slice(-3).join(', ')}

CONTEXT:
- Project ID: ${context.project_id}
- Username: ${context.credentials?.username || 'Not provided'}
- Password: ${context.credentials?.password ? '[PROVIDED]' : 'Not provided'}

REQUIREMENTS:
1. Generate a complete Playwright script that can be executed
2. Include proper error handling and timeouts
3. Do NOT wait for final page loads or redirects - use timeouts instead
4. Focus on the most important actions for this depth
5. If login is needed, fill forms and submit
6. If content extraction is needed, extract relevant data
7. Use appropriate selectors and wait strategies

Generate a script that:
- Takes a page object as parameter
- Returns a result object with success, message, and any extracted data
- Uses timeouts instead of waiting for page loads
- Handles errors gracefully

Respond with just the JavaScript code (no markdown formatting):`;

    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3
      });

      const script = response.choices[0].message.content.trim();
      
      return {
        success: true,
        script: script,
        message: 'Script generated successfully'
      };
    } catch (error) {
      console.log(`[AI-ANALYSIS] Script generation failed: ${error.message}`);
      return {
        success: false,
        script: '',
        message: `Script generation failed: ${error.message}`
      };
    }
  }

  /**
   * Execute the generated playwright script
   */
  async executePlaywrightScript(page, script, context, depth) {
    try {
      console.log(`[AI-ANALYSIS] 🎭 Executing script at depth ${depth}`);
      
      // Create a safe execution environment
      const scriptFunction = new Function('page', 'context', `
        return (async () => {
          try {
            ${script}
          } catch (error) {
            return {
              success: false,
              message: 'Script execution error: ' + error.message,
              error: error.stack
            };
          }
        })();
      `);

      // Execute with timeout
      const result = await Promise.race([
        scriptFunction(page, context),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Script execution timeout')), this.timeout)
        )
      ]);

      console.log(`[AI-ANALYSIS] ✅ Script execution completed: ${result.success ? 'SUCCESS' : 'FAILED'}`);
      return result;

    } catch (error) {
      console.log(`[AI-ANALYSIS] ❌ Script execution failed: ${error.message}`);
      return {
        success: false,
        message: `Script execution failed: ${error.message}`,
        error: error.stack
      };
    }
  }

  /**
   * Analyze the result of script execution
   */
  async analyzeExecutionResult(page, context, crawlerType, depth, executionResult) {
    const url = page.url();
    const title = await page.title().catch(() => '');
    const content = await page.content().catch(() => '');

    const prompt = `You are an AI assistant analyzing the result of a Playwright script execution for a ${crawlerType} crawler.

EXECUTION RESULT:
- Success: ${executionResult.success}
- Message: ${executionResult.message}
- Depth: ${depth}

CURRENT PAGE STATE:
- URL: ${url}
- Title: ${title}
- Content Length: ${content.length} characters

CONTEXT:
- Project ID: ${context.project_id}
- Max Depth: ${this.maxDepth}

Based on this analysis, determine:
1. Was the execution successful?
2. Should we continue to the next depth?
3. What is the current state of the page?
4. Are we in a successful final state?

Respond in JSON format:
{
  "execution_successful": boolean,
  "should_continue": boolean,
  "current_state": "login|content|error|success|unknown",
  "is_final_success": boolean,
  "confidence": number,
  "reasoning": "explanation of analysis",
  "next_actions": ["suggested next actions if continuing"]
}`;

    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0.2
      });

      const result = JSON.parse(response.choices[0].message.content);
      
      return {
        ...result,
        reason: result.should_continue ? 'Continue to next depth' : 'Reached completion or failure'
      };
    } catch (error) {
      console.log(`[AI-ANALYSIS] Result analysis failed: ${error.message}`);
      return {
        execution_successful: false,
        should_continue: false,
        current_state: 'unknown',
        is_final_success: false,
        confidence: 0,
        reasoning: 'Result analysis failed',
        next_actions: [],
        reason: 'Analysis failed'
      };
    }
  }

  /**
   * Generate final evaluation of the entire analysis chain
   */
  async generateFinalEvaluation(page, context, crawlerType, finalDepth, attempts, screenshots, ai_prompts) {
    const url = page.url();
    const title = await page.title().catch(() => '');
    const content = await page.content().catch(() => '');
    const cookies = await page.context().cookies().catch(() => []);

    const prompt = `You are an AI assistant providing a final evaluation of a ${crawlerType} crawler analysis chain.

FINAL STATE:
- URL: ${url}
- Title: ${title}
- Content Length: ${content.length} characters
- Cookies Count: ${cookies.length}
- Final Depth: ${finalDepth}
- Total Attempts: ${Array.isArray(attempts) ? attempts.length : 0}
- Screenshots Captured: ${screenshots.length}
- AI Prompts Used: ${ai_prompts.length}

ATTEMPTS MADE:
${Array.isArray(attempts) ? attempts.map((attempt, i) => `${i + 1}. ${attempt}`).join('\n') : 'No attempts recorded'}

CONTEXT:
- Project ID: ${context.project_id}
- Crawler Type: ${crawlerType}
- Max Depth: ${this.maxDepth}

Based on this comprehensive analysis, determine:
1. Was the overall operation successful?
2. What is the confidence level (0-100)?
3. What are the key success indicators?
4. What are the failure indicators?
5. What is the reasoning for this evaluation?
6. What are the recommended next actions?

Respond in JSON format:
{
  "success": boolean,
  "confidence": number,
  "reasoning": "detailed explanation of evaluation",
  "success_indicators": ["list of success indicators"],
  "failure_indicators": ["list of failure indicators"],
  "next_actions": ["recommended next actions"]
}`;

    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0.1
      });

      return JSON.parse(response.choices[0].message.content);
    } catch (error) {
      console.log(`[AI-ANALYSIS] Final evaluation failed: ${error.message}`);
      return {
        success: false,
        confidence: 0,
        reasoning: 'Final evaluation failed',
        success_indicators: [],
        failure_indicators: ['Final evaluation failed'],
        next_actions: ['Review logs for detailed information']
      };
    }
  }
}
