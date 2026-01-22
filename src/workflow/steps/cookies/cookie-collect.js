/**
 * Execute Cookie Collect Step
 * Collects cookies from the browser
 */

import axios from 'axios';

export async function executeCookieCollectStep(page, step, workflowState, jobId, workflowAnalyzer) {
  console.log(`🔍 Collecting cookies from browser (${step.name})`);
  
  const config = step.config || {};
  let collectedCookies = []; // Declare early so it's available in catch block

  try {
    // Always collect from browser - this is self-explanatory
    if (!page) {
      throw new Error('Playwright page is not available - cannot collect cookies from browser');
    }
    
    // Collect all cookies from the browser context
    const contextCookies = await page.context().cookies();
    collectedCookies = contextCookies;
    console.log(`✅ Collected ${collectedCookies.length} cookie(s) from browser`);
    
    // Try to get project_id to save cookies to project (optional)
    let projectId = null;
    if (config.saveToProject !== false) {
      try {
        const jobResponse = await axios.get(`${workflowAnalyzer.backendUrl}/api/jobs/${jobId}`, {
          headers: workflowAnalyzer.getAuthHeaders()
        });
        // Handle both ObjectId and string formats
        const rawProjectId = jobResponse.data?.project_id;
        if (rawProjectId) {
          projectId = typeof rawProjectId === 'object' && rawProjectId.toString ? rawProjectId.toString() : String(rawProjectId);
        }
        
        // Also try to get from context if API call didn't return it
        if (!projectId && workflowAnalyzer.context?.project_id) {
          const ctxProjectId = workflowAnalyzer.context.project_id;
          projectId = typeof ctxProjectId === 'object' && ctxProjectId.toString ? ctxProjectId.toString() : String(ctxProjectId);
          console.log(`ℹ️ Using project_id from context: ${projectId}`);
        }
      } catch (jobError) {
        console.warn(`⚠️ Could not fetch job to get project_id: ${jobError.message}`);
        
        // Try to get from context as fallback
        if (workflowAnalyzer.context?.project_id) {
          const ctxProjectId = workflowAnalyzer.context.project_id;
          projectId = typeof ctxProjectId === 'object' && ctxProjectId.toString ? ctxProjectId.toString() : String(ctxProjectId);
          console.log(`ℹ️ Using project_id from context as fallback: ${projectId}`);
        }
        // Don't throw - we already have cookies
      }
    }

    // Store collected cookies in workflow state
    if (config.outputVariable) {
      workflowState[config.outputVariable] = collectedCookies;
    }
    workflowState.collectedCookies = collectedCookies;

    // Optionally save to project (only if projectId is available)
    if (config.saveToProject !== false && projectId) {
      try {
        await axios.post(`${workflowAnalyzer.backendUrl}/api/projects/${projectId}/cookies`, {
          cookies: collectedCookies,
          source: 'workflow'
        }, {
          headers: workflowAnalyzer.getAuthHeaders()
        });
        console.log(`✅ Saved ${collectedCookies.length} cookie(s) to project`);
      } catch (saveError) {
        console.warn(`⚠️ Failed to save cookies to project: ${saveError.message}`);
        // Don't throw - cookies are still collected
      }
    }

    workflowAnalyzer.storeStepResult(step, { cookies: collectedCookies, count: collectedCookies.length }, workflowState);
    console.log(`✅ Collected ${collectedCookies.length} cookie(s) successfully`);
  } catch (error) {
    // If we have cookies collected, don't fail the step
    if (collectedCookies && collectedCookies.length > 0) {
      console.warn(`⚠️ Cookie collect had errors but cookies were collected: ${error.message}`);
      workflowAnalyzer.storeStepResult(step, { cookies: collectedCookies }, workflowState);
      console.log(`✅ Cookie collection completed despite errors: ${collectedCookies.length} cookie(s)`);
      return; // Success - cookies collected
    }
    console.error(`❌ Cookie collect failed: ${error.message}`);
    throw error;
  }
}























































