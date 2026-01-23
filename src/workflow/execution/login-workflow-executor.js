/**
 * Login Workflow Executor
 * Specialized executor for login workflows that focuses on:
 * - Authentication and credential handling
 * - Cookie collection and storage
 * - Login status determination with AI justification
 * - Proper result extraction and storage
 */

import WorkflowAnalyzer from '../analysis/workflow-analyzer.js';
import axios from 'axios';

export class LoginWorkflowExecutor {
  constructor(backendUrl, aiLogger, backendLogger, context = {}) {
    this.backendUrl = backendUrl;
    this.aiLogger = aiLogger;
    this.backendLogger = backendLogger;
    this.context = context;
    
    // Create WorkflowAnalyzer instance for executing steps
    this.workflowAnalyzer = new WorkflowAnalyzer(backendUrl, aiLogger, context);
  }

  /**
   * Execute login workflow
   * Returns result with login status, cookies, and AI justification
   * Uses the same execution pattern as WorkflowAnalyzer for consistency
   */
  async executeLoginWorkflow(page, jobId, workflowTemplate) {
    console.log(`🔐 [LOGIN-WORKFLOW] Starting login workflow execution`);
    console.log(`🔐 [LOGIN-WORKFLOW] Job ID: ${jobId}`);
    console.log(`🔐 [LOGIN-WORKFLOW] Template: ${workflowTemplate.name || workflowTemplate._id}`);
    console.log(`🔐 [LOGIN-WORKFLOW] Page URL: ${page.url()}`);
    
    try {
      // CRITICAL: Use the same execution pattern as WorkflowAnalyzer
      // Load workflow template into the analyzer
      await this.workflowAnalyzer.loadWorkflowTemplate(workflowTemplate._id?.toString() || workflowTemplate.identifier || workflowTemplate._id);
      
      // Ensure context is properly set for login jobs
      const loginContext = {
        ...this.context,
        jobType: 'login',
        job_type: 'login',
        isLoginJob: true,
        preventCrawling: true,
        preventLinkDiscovery: true,
        credentials: this.context.credentials || this.context.login_credentials,
        must_login_first: this.context.must_login_first || true,
        automate_login: this.context.automate_login || true
      };
      
      // Update workflowAnalyzer context
      this.workflowAnalyzer.context = loginContext;
      
      // Execute workflow steps using the same method as regular workflows
      // This ensures consistency with test workflow execution
      const result = await this.workflowAnalyzer.analyzePage(
        page, 
        jobId, 
        null, // pageId (not needed for login)
        this.context.project_id || loginContext.project_id
      );
      
      // Extract login-specific results from the workflow execution
      const loginResult = this.extractLoginResults({}, result);
      
      console.log(`🔐 [LOGIN-WORKFLOW] Login workflow completed`);
      console.log(`🔐 [LOGIN-WORKFLOW] Status: ${loginResult.loginStatus}`);
      console.log(`🔐 [LOGIN-WORKFLOW] Cookies collected: ${loginResult.cookiesCollected.length}`);
      console.log(`🔐 [LOGIN-WORKFLOW] Reason: ${loginResult.loginReason ? loginResult.loginReason.substring(0, 100) : 'N/A'}`);
      
      return {
        success: loginResult.loginStatus === 'success',
        loginStatus: loginResult.loginStatus,
        loginReason: loginResult.loginReason,
        cookies: loginResult.cookiesCollected,
        cookiesCollected: loginResult.cookiesCollected.length,
        shouldCollectCookies: loginResult.shouldCollectCookies,
        workflowResult: result,
        determine_completion: loginResult.determine_completion || null,
        error: loginResult.loginStatus === 'failure' ? loginResult.loginReason : null
      };
    } catch (error) {
      console.error(`❌ [LOGIN-WORKFLOW] Login workflow failed: ${error.message}`);
      console.error(`❌ [LOGIN-WORKFLOW] Error stack: ${error.stack}`);
      
      return {
        success: false,
        loginStatus: 'failure',
        loginReason: `Workflow execution error: ${error.message}`,
        cookies: [],
        cookiesCollected: 0,
        shouldCollectCookies: false,
        workflowResult: null,
        error: error.message
      };
    }
  }

  /**
   * Extract login-specific results from workflow execution
   */
  extractLoginResults(workflowState, workflowResult) {
    console.log(`🔍 [LOGIN-WORKFLOW] Extracting login results from workflow`);
    
    let loginStatus = null;
    let loginReason = null;
    let cookiesCollected = [];
    let shouldCollectCookies = false;
    
    // 1. Extract determine_completion result from workflow result
    const determineResult = this.extractDetermineCompletion(workflowResult);
    
    if (determineResult) {
      loginStatus = determineResult.status || determineResult.completion_status;
      loginReason = determineResult.reason || determineResult.loginReason || 'No justification provided';
      shouldCollectCookies = determineResult.should_collect_cookies === true;
      
      console.log(`✅ [LOGIN-WORKFLOW] Found determine_completion result`);
      console.log(`   Status: ${loginStatus}`);
      console.log(`   Should collect cookies: ${shouldCollectCookies}`);
      console.log(`   Reason: ${loginReason ? loginReason.substring(0, 100) : 'N/A'}`);
      
      // Store determine_completion for later extraction
      workflowState.determine_completion = determineResult;
    } else {
      console.warn(`⚠️ [LOGIN-WORKFLOW] No determine_completion result found`);
    }
    
    // 2. Extract cookies from workflow result
    cookiesCollected = this.extractCookies(workflowResult);
    
    console.log(`✅ [LOGIN-WORKFLOW] Extracted ${cookiesCollected.length} cookie(s)`);
    
    // 3. If loginStatus is still null, infer from cookies
    if (!loginStatus && cookiesCollected.length > 0) {
      console.log(`ℹ️ [LOGIN-WORKFLOW] Inferring success from cookie presence`);
      loginStatus = 'success';
      loginReason = `Login successful - ${cookiesCollected.length} cookie(s) collected`;
      shouldCollectCookies = true;
    } else if (!loginStatus) {
      console.warn(`⚠️ [LOGIN-WORKFLOW] No login status found and no cookies collected`);
      loginStatus = 'failure';
      loginReason = 'Login status unclear - no cookies collected and no AI justification';
    }
    
    return {
      loginStatus,
      loginReason,
      cookiesCollected,
      shouldCollectCookies,
      determine_completion: determineResult
    };
  }

  /**
   * Extract determine_completion result from workflow result
   */
  extractDetermineCompletion(workflowResult) {
    if (!workflowResult) return null;
    
    // Check multiple locations for determine_completion result
    const locations = [
      workflowResult.determine_completion?.result,
      workflowResult.results?.determine_completion?.result,
      workflowResult.workflowState?.determine_completion?.result,
      workflowResult.variablePool?.steps?.determine_completion?.result,
      workflowResult.step_results?.determine_completion?.result,
      workflowResult.perform_login_attempts?.iterations?.[workflowResult.perform_login_attempts?.iterations?.length - 1]?.step_result,
      workflowResult.perform_login_attempts?.iterations?.[workflowResult.perform_login_attempts?.iterations?.length - 1]?.lastResult?.step_result,
      workflowResult.perform_login_attempts?.final_status
    ];
    
    for (const location of locations) {
      if (location) {
        // Handle both direct result and nested result structures
        const result = location.result || location;
        if (result.status || result.completion_status) {
          console.log(`✅ [LOGIN-WORKFLOW] Found determine_completion at location`);
          return result;
        }
      }
    }
    
    return null;
  }

  /**
   * Extract cookies from workflow result
   */
  extractCookies(workflowResult) {
    if (!workflowResult) return [];
    
    const cookieLocations = [
      workflowResult.collectedCookies,
      workflowResult.workflowState?.collectedCookies,
      workflowResult.variablePool?.job?.finalCookies,
      workflowResult.variablePool?.job?.iterationCookies,
      workflowResult.step_results?.collect_final_cookies?.cookies,
      workflowResult.step_results?.collect_final_cookies?.result?.cookies,
      workflowResult.variablePool?.steps?.collect_final_cookies?.cookies,
      workflowResult.variablePool?.steps?.collect_final_cookies?.result?.cookies
    ];
    
    for (const location of cookieLocations) {
      if (Array.isArray(location) && location.length > 0) {
        console.log(`✅ [LOGIN-WORKFLOW] Found ${location.length} cookie(s) at location`);
        return location;
      }
    }
    
    return [];
  }
}

