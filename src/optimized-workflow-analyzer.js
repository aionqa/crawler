/**
 * Optimized Workflow Analyzer - QA-like testing with minimal token usage
 * Implements 6-depth iteration system for comprehensive testing
 */

import axios from 'axios';
import OptimizedPageAnalyzer from '../shared/optimized-page-analyzer.js';
import { AIConversationLogger } from '../shared/ai-conversation-logger.js';
import * as backendLogger from './backend-logger.js';

export class OptimizedWorkflowAnalyzer {
  constructor(backendUrl = null) {
    this.backendUrl = backendUrl || process.env.BACKEND_URL || 'http://back:4000';
    this.pageAnalyzer = new OptimizedPageAnalyzer(backendUrl);
    this.aiLogger = new AIConversationLogger(backendUrl);
    this.maxDepth = 6;
  }

  /**
   * Analyze page with optimized data collection and QA-like testing
   */
  async analyzePage(page, jobId, pageId, projectId, openaiClient) {
    const pageUrl = page.url();
    const pageTitle = await page.title();
    
    console.log(`[OptimizedWorkflowAnalyzer] 🔍 Starting QA-like analysis of ${pageTitle}`);
    
    try {
      // Step 1: Collect all page data (visible text, interactive elements, AX tree, DOM snapshot)
      const pageData = await this.pageAnalyzer.collectPageData(page, jobId, pageUrl, true, true);
      
      // Step 2: Send page data to backend for storage
      await this.pageAnalyzer.sendPageDataToBackend(jobId, pageData);
      
      // Step 3: Generate page description for job history
      await this.addPageDescriptionToJobHistory(jobId, pageData);
      
      // Step 4: Start QA-like testing iterations
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
        const optimizedPayload = this.pageAnalyzer.createOptimizedPayload(currentPageData, conversationHistory);
        
        // Send to OpenAI for analysis and action generation
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
        currentPageData = await this.pageAnalyzer.collectPageData(page, jobId, page.url(), true, true);
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
   * Execute Playwright script generated by AI
   */
  async executePlaywrightScript(page, script, jobId, depth) {
    try {
      console.log(`[OptimizedWorkflowAnalyzer] 🎭 Executing Playwright script at depth ${depth + 1}`);
      
      // Take screenshot before action
      const beforeScreenshot = await page.screenshot({ type: 'png', fullPage: true });
      
      // Execute the script
      await page.evaluate(script);
      
      // Wait for page to settle
      await page.waitForTimeout(2000);
      
      // Take screenshot after action
      const afterScreenshot = await page.screenshot({ type: 'png', fullPage: true });
      
      return {
        success: true,
        before_screenshot: beforeScreenshot.toString('base64'),
        after_screenshot: afterScreenshot.toString('base64'),
        url_before: page.url(),
        url_after: page.url(),
        page_title_after: await page.title()
      };
      
    } catch (error) {
      console.error(`[OptimizedWorkflowAnalyzer] ❌ Script execution failed: ${error.message}`);
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
