/**
 * Optimized Workflow Analyzer - QA-like testing with minimal token usage
 * Implements 6-depth iteration system for comprehensive testing
 */

import axios from 'axios';
// Note: OptimizedPageAnalyzer is deprecated - using workflow-based approach instead
// import OptimizedPageAnalyzer from '../shared/optimized-page-analyzer.js';
// Note: AIConversationLogger import is handled dynamically in unified-operations.js
// import { AIConversationLogger } from '../../shared/ai-conversation-logger.js';
import * as backendLogger from './backend-logger.js';

export class OptimizedWorkflowAnalyzer {
  constructor(backendUrl = null, aiLogger = null) {
    this.backendUrl = backendUrl || process.env.BACKEND_URL || 'http://back:4000';
    // Note: OptimizedPageAnalyzer is deprecated - using workflow-based approach instead
    // this.pageAnalyzer = new OptimizedPageAnalyzer(backendUrl);
    // Note: aiLogger should be passed in from unified-operations.js
    this.aiLogger = aiLogger;
    this.maxDepth = 6;
  }

  /**
   * Analyze page with optimized data collection and QA-like testing
   * NOTE: This is deprecated - workflow mode uses WorkflowAnalyzer/WorkflowExecutor instead
   */
  async analyzePage(page, jobId, pageId, projectId, openaiClient) {
    const pageUrl = page.url();
    const pageTitle = await page.title();
    
    console.log(`[OptimizedWorkflowAnalyzer] ⚠️  Optimized mode is deprecated - use workflow mode instead`);
    console.log(`[OptimizedWorkflowAnalyzer] 🔍 Starting QA-like analysis of ${pageTitle}`);
    
    try {
      // Note: OptimizedPageAnalyzer is deprecated - using basic page data collection instead
      const visibleText = await page.evaluate(() => document.body.innerText || '');
      const interactiveElements = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]')).length;
        const links = Array.from(document.querySelectorAll('a[href]')).length;
        const inputs = Array.from(document.querySelectorAll('input, textarea, select')).length;
        return { buttons, links, inputs, interactive_count: buttons + links + inputs };
      });
      
      const pageData = {
        page_url: pageUrl,
        page_title: pageTitle,
        visible_text: visibleText.substring(0, 2000),
        interactive_elements: interactiveElements,
        collection_time_ms: Date.now()
      };
      
      // Step 2: Start QA-like testing iterations
      const testResults = await this.performQATesting(page, jobId, pageId, projectId, openaiClient, pageData);
      
      return {
        success: true,
        page_data: pageData,
        test_results: testResults,
        total_interactions: testResults.length
      };
      
    } catch (error) {
      console.error(`[OptimizedWorkflowAnalyzer] ❌ Analysis failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Add page description to job history (above AI chats)
   */
  async addPageDescriptionToJobHistory(jobId, pageData) {
    try {
      const message = `📄 Page Analysis: ${pageData.page_description.short_description}`;
      const metadata = {
        page_analysis: true,
        page_title: pageData.page_title,
        page_url: pageData.page_url,
        visible_text_preview: pageData.visible_text.substring(0, 200),
        interactive_elements_count: pageData.interactive_elements.interactive_count,
        forms_count: pageData.interactive_elements.forms.length,
        buttons_count: pageData.interactive_elements.buttons.length,
        links_count: pageData.interactive_elements.links.length,
        page_description: pageData.page_description,
        collection_time_ms: pageData.collection_time_ms
      };

      await backendLogger.appendJobLog(jobId, 'info', message, 'PAGE-ANALYZER', metadata);
      console.log(`[OptimizedWorkflowAnalyzer] ✅ Page description added to job history`);
      
    } catch (error) {
      console.error(`[OptimizedWorkflowAnalyzer] ❌ Failed to add page description: ${error.message}`);
    }
  }

  /**
   * Perform QA-like testing with 6-depth iteration system
   */
  async performQATesting(page, jobId, pageId, projectId, openaiClient, initialPageData) {
    const testResults = [];
    const conversationHistory = [];
    let currentDepth = 0;
    let currentPageData = initialPageData;
    
    console.log(`[OptimizedWorkflowAnalyzer] 🧪 Starting QA testing iterations (max depth: ${this.maxDepth})`);
    
    while (currentDepth < this.maxDepth) {
      try {
        console.log(`[OptimizedWorkflowAnalyzer] 🔄 Iteration ${currentDepth + 1}/${this.maxDepth}`);
        
        // Create optimized payload for OpenAI (minimal tokens)
        // Note: Using basic payload creation since OptimizedPageAnalyzer is deprecated
        const optimizedPayload = {
          page_url: currentPageData.page_url,
          page_title: currentPageData.page_title,
          visible_text: currentPageData.visible_text?.substring(0, 1000) || '',
          interactive_elements: currentPageData.interactive_elements || {},
          conversation_history: conversationHistory
        };
        
        // Send to OpenAI for analysis and action generation
        if (!this.aiLogger) {
          throw new Error('AIConversationLogger is required but not provided');
        }
        const aiResponse = await this.aiLogger.makeAICallWithPrompt(
          'analyze-interactive-elements',
          optimizedPayload,
          jobId,
          'qa-analyzer',
          currentPageData.page_url,
          null,
          optimizedPayload
        );
        
        // Store conversation in history
        conversationHistory.push({
          depth: currentDepth,
          page_url: currentPageData.page_url,
          conversation_description: aiResponse.conversation_description,
          response_description: aiResponse.response_description,
          timestamp: new Date().toISOString()
        });
        
        // Execute the generated Playwright script
        const executionResult = await this.executePlaywrightScript(page, aiResponse.playwright_script, jobId, currentDepth);
        
        // Store test result
        testResults.push({
          depth: currentDepth,
          page_url: currentPageData.page_url,
          page_title: currentPageData.page_title,
          conversation_description: aiResponse.conversation_description,
          response_description: aiResponse.response_description,
          playwright_script: aiResponse.playwright_script,
          execution_result: executionResult,
          timestamp: new Date().toISOString()
        });
        
        // Check if we should continue (page changed or action completed)
        const shouldContinue = await this.shouldContinueTesting(page, executionResult, currentPageData);
        
        if (!shouldContinue) {
          console.log(`[OptimizedWorkflowAnalyzer] ✅ Testing completed at depth ${currentDepth + 1}`);
          break;
        }
        
        // Collect new page data for next iteration
        // Note: Using basic page data collection since OptimizedPageAnalyzer is deprecated
        const visibleText = await page.evaluate(() => document.body.innerText || '');
        const interactiveElements = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]')).length;
          const links = Array.from(document.querySelectorAll('a[href]')).length;
          const inputs = Array.from(document.querySelectorAll('input, textarea, select')).length;
          return { buttons, links, inputs, interactive_count: buttons + links + inputs };
        });
        
        currentPageData = {
          page_url: page.url(),
          page_title: await page.title(),
          visible_text: visibleText.substring(0, 2000),
          interactive_elements: interactiveElements,
          collection_time_ms: Date.now()
        };
        currentDepth++;
        
      } catch (error) {
        console.error(`[OptimizedWorkflowAnalyzer] ❌ Iteration ${currentDepth + 1} failed: ${error.message}`);
        testResults.push({
          depth: currentDepth,
          page_url: currentPageData.page_url,
          error: error.message,
          timestamp: new Date().toISOString()
        });
        break;
      }
    }
    
    return testResults;
  }

  /**
   * Clean script to remove markdown code blocks and other formatting
   */
  cleanScript(script) {
    if (!script || typeof script !== 'string') {
      return script;
    }
    
    let cleaned = script.trim();
    
    // First, extract code from markdown code blocks if present
    // This handles cases where there's text before/after the code block
    const codeBlockRegex = /```[\w]*\s*\n?([\s\S]*?)\n?```/g;
    const codeBlockMatches = [...cleaned.matchAll(codeBlockRegex)];
    if (codeBlockMatches.length > 0) {
      // If code blocks are found, extract only the code from them
      cleaned = codeBlockMatches.map(match => match[1]).join('\n\n');
    } else {
      // No code blocks found, but remove any markdown markers that might be present
      cleaned = cleaned.replace(/^```[\w]*\s*\n?/gm, '');
      cleaned = cleaned.replace(/\n?\s*```$/gm, '');
      cleaned = cleaned.replace(/^\s*```[\w]*\s*$/gm, '');
      cleaned = cleaned.replace(/```[\w]*/g, '');
    }
    
    // Extract function bodies instead of removing functions completely
    // This handles nested braces by matching from function start to matching closing brace
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
          const openBracePos = match.index + match[0].length - 1; // Position of opening {
          let braceCount = 1;
          let pos = openBracePos + 1;
          const bodyStart = pos;
          
          // Find matching closing brace
          while (braceCount > 0 && pos < text.length) {
            if (text[pos] === '{') braceCount++;
            else if (text[pos] === '}') braceCount--;
            pos++;
          }
          
          if (braceCount === 0) {
            // Found matching brace, extract function body (content between braces)
            const bodyEnd = pos - 1; // Position just before closing }
            const functionBody = text.slice(bodyStart, bodyEnd).trim();
            // Replace function with just its body
            text = text.slice(0, start) + functionBody + text.slice(pos);
            pattern.lastIndex = 0; // Reset regex
          }
        }
      }
      
      return text;
    };
    
    cleaned = extractFunctionBodies(cleaned);
    
    // Remove IIFE wrappers (async () => { ... })() or (async function() { ... })()
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
    
    // Remove browser/page creation (we're already in a Playwright context)
    cleaned = cleaned.replace(/const\s+browser\s*=\s*await\s+chromium\.launch[^;]+;?\s*/g, '');
    cleaned = cleaned.replace(/const\s+page\s*=\s*await\s+browser\.newPage[^;]+;?\s*/g, '');
    cleaned = cleaned.replace(/const\s+context\s*=\s*await\s+browser\.newContext[^;]+;?\s*/g, '');
    cleaned = cleaned.replace(/const\s+page\s*=\s*await\s+context\.newPage[^;]+;?\s*/g, '');
    cleaned = cleaned.replace(/await\s+browser\.close[^;]+;?\s*/g, '');
    cleaned = cleaned.replace(/await\s+context\.close[^;]+;?\s*/g, '');
    
    // Remove template variables ({{action}}, {{page_context}}, etc.)
    cleaned = cleaned.replace(/\{\{[^}]+\}\}/g, '');
    
    // Remove comments
    cleaned = cleaned.replace(/\/\/[^\n]*/g, '');
    cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
    
    // Clean up extra whitespace and newlines
    cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n');
    cleaned = cleaned.trim();
    
    // If the script is wrapped in braces, unwrap them
    if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
      cleaned = cleaned.slice(1, -1).trim();
    }
    
    return cleaned;
  }

  /**
   * Execute Playwright script generated by AI
   */
  async executePlaywrightScript(page, script, jobId, depth) {
    const startTime = Date.now();
    const originalScriptLength = script?.length || 0;
    
    try {
      console.log(`[OptimizedWorkflowAnalyzer] 🎭 Executing Playwright script at depth ${depth + 1}`);
      
      // Log script execution start
      await backendLogger.appendJobLog(jobId, 'debug', 
        `🎭 Starting script execution (depth ${depth + 1})`,
        'OPTIMIZED-WORKFLOW-ANALYZER',
        {
          depth: depth + 1,
          original_script_length: originalScriptLength,
          script_preview: script?.substring(0, 300) || 'N/A',
          page_url: page.url()
        }
      );
      
      // Clean the script to remove markdown code blocks and other formatting
      const cleanedScript = this.cleanScript(script);
      const cleanedScriptLength = cleanedScript?.length || 0;
      
      if (!cleanedScript || cleanedScript.trim().length === 0) {
        const error = 'Script is empty after cleaning';
        await backendLogger.appendJobLog(jobId, 'error', 
          `❌ ${error}`,
          'OPTIMIZED-WORKFLOW-ANALYZER',
          {
            depth: depth + 1,
            original_script_length: originalScriptLength,
            cleaned_script_length: cleanedScriptLength,
            original_script_preview: script?.substring(0, 500) || 'N/A'
          }
        );
        throw new Error(error);
      }
      
      // Log cleaned script info
      await backendLogger.appendJobLog(jobId, 'debug',
        `📝 Script cleaned (${originalScriptLength} → ${cleanedScriptLength} chars)`,
        'OPTIMIZED-WORKFLOW-ANALYZER',
        {
          depth: depth + 1,
          cleaned_script_preview: cleanedScript.substring(0, 500),
          cleaning_removed_chars: originalScriptLength - cleanedScriptLength
        }
      );
      
      // Take screenshot before action
      const beforeScreenshot = await page.screenshot({ type: 'png', fullPage: true });
      const urlBefore = page.url();
      const titleBefore = await page.title();
      
      // Execute the script in browser context
      await backendLogger.appendJobLog(jobId, 'debug',
        `▶️ Executing script in browser context...`,
        'OPTIMIZED-WORKFLOW-ANALYZER',
        {
          depth: depth + 1,
          url_before: urlBefore,
          title_before: titleBefore
        }
      );
      
      // page.evaluate() can accept a string containing JavaScript code
      await page.evaluate(cleanedScript);
      
      // Wait for page to settle
      await page.waitForTimeout(2000);
      
      // Take screenshot after action
      const afterScreenshot = await page.screenshot({ type: 'png', fullPage: true });
      const urlAfter = page.url();
      const titleAfter = await page.title();
      const executionTime = Date.now() - startTime;
      
      // Log successful execution
      await backendLogger.appendJobLog(jobId, 'info',
        `✅ Script executed successfully (${executionTime}ms)`,
        'OPTIMIZED-WORKFLOW-ANALYZER',
        {
          depth: depth + 1,
          execution_time_ms: executionTime,
          url_before: urlBefore,
          url_after: urlAfter,
          title_before: titleBefore,
          title_after: titleAfter,
          url_changed: urlBefore !== urlAfter,
          title_changed: titleBefore !== titleAfter
        }
      );
      
      return {
        success: true,
        before_screenshot: beforeScreenshot.toString('base64'),
        after_screenshot: afterScreenshot.toString('base64'),
        url_before: urlBefore,
        url_after: urlAfter,
        page_title_after: titleAfter
      };
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error(`[OptimizedWorkflowAnalyzer] ❌ Script execution failed: ${error.message}`);
      console.error(`[OptimizedWorkflowAnalyzer] Script content (first 500 chars): ${script?.substring(0, 500)}`);
      
      // Log execution failure with details
      await backendLogger.appendJobLog(jobId, 'error',
        `❌ Script execution failed: ${error.message}`,
        'OPTIMIZED-WORKFLOW-ANALYZER',
        {
          depth: depth + 1,
          execution_time_ms: executionTime,
          error_message: error.message,
          error_stack: error.stack?.substring(0, 1000),
          original_script_preview: script?.substring(0, 500) || 'N/A',
          cleaned_script_preview: this.cleanScript(script)?.substring(0, 500) || 'N/A',
          page_url: page.url()
        }
      );
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Determine if testing should continue based on page changes
   */
  async shouldContinueTesting(page, executionResult, previousPageData) {
    const currentUrl = page.url();
    const currentTitle = await page.title();
    
    // Check if page URL changed significantly
    const urlChanged = currentUrl !== previousPageData.page_url;
    
    // Check if page title changed
    const titleChanged = currentTitle !== previousPageData.page_title;
    
    // Check if execution was successful
    const executionSuccessful = executionResult.success;
    
    // Continue if:
    // 1. Page changed (URL or title) AND execution was successful
    // 2. OR if we haven't reached max depth and execution was successful
    const shouldContinue = executionSuccessful && (urlChanged || titleChanged);
    
    console.log(`[OptimizedWorkflowAnalyzer] 🔍 Continue testing check:`, {
      urlChanged,
      titleChanged,
      executionSuccessful,
      shouldContinue
    });
    
    return shouldContinue;
  }

  /**
   * Send test results to backend
   */
  async sendTestResultsToBackend(jobId, pageId, projectId, testResults) {
    try {
      const response = await axios.post(`${this.backendUrl}/api/pages/${pageId}/test-results`, {
        job_id: jobId,
        project_id: projectId,
        test_results: testResults,
        total_interactions: testResults.length,
        completed_at: new Date().toISOString()
      });
      
      console.log(`[OptimizedWorkflowAnalyzer] ✅ Test results sent to backend`);
      return response.data;
      
    } catch (error) {
      console.error(`[OptimizedWorkflowAnalyzer] ❌ Failed to send test results: ${error.message}`);
      throw error;
    }
  }

  /**
   * Analyze random pages from a project
   */
  async analyzeRandomPages(projectId, count = 10, openaiClient) {
    try {
      console.log(`[OptimizedWorkflowAnalyzer] 🎲 Analyzing ${count} random pages from project ${projectId}`);
      
      // Get random pages from project
      const response = await axios.get(`${this.backendUrl}/api/pages/random`, {
        params: {
          project_id: projectId,
          count: count
        }
      });
      
      const pages = response.data;
      const results = [];
      
      for (let i = 0; i < pages.length; i++) {
        const pageInfo = pages[i];
        console.log(`[OptimizedWorkflowAnalyzer] 📄 Analyzing page ${i + 1}/${pages.length}: ${pageInfo.title}`);
        
        try {
          // Create a new page for analysis
          const page = await this.createPageForAnalysis(pageInfo.url);
          
          // Analyze the page
          const analysisResult = await this.analyzePage(page, `random-test-${Date.now()}`, pageInfo._id, projectId, openaiClient);
          
          results.push({
            page_id: pageInfo._id,
            page_title: pageInfo.title,
            page_url: pageInfo.url,
            analysis_result: analysisResult,
            success: true
          });
          
          await page.close();
          
        } catch (error) {
          console.error(`[OptimizedWorkflowAnalyzer] ❌ Failed to analyze page ${pageInfo.title}: ${error.message}`);
          results.push({
            page_id: pageInfo._id,
            page_title: pageInfo.title,
            page_url: pageInfo.url,
            error: error.message,
            success: false
          });
        }
      }
      
      console.log(`[OptimizedWorkflowAnalyzer] ✅ Completed analysis of ${count} pages`);
      return results;
      
    } catch (error) {
      console.error(`[OptimizedWorkflowAnalyzer] ❌ Random page analysis failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create a new page for analysis (placeholder - implement based on your browser setup)
   */
  async createPageForAnalysis(url) {
    // This is a placeholder - implement based on your browser context
    // You'll need to integrate with your existing browser setup
    throw new Error('createPageForAnalysis not implemented - integrate with existing browser setup');
  }
}

export default OptimizedWorkflowAnalyzer;
