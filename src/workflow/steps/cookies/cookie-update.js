/**
 * Execute Cookie Update Step
 * Updates an existing cookie in the project
 */

import axios from 'axios';

export async function executeCookieUpdateStep(step, workflowState, jobId, workflowAnalyzer) {
  console.log(`✏️ Updating cookie (${step.name})`);
  
  const config = step.config || {};
  if (!config.cookieName || !config.value) {
    const missingFields = [];
    if (!config.cookieName) missingFields.push('cookieName');
    if (!config.value) missingFields.push('value');
    const errorMessage = `Missing required field(s) "${missingFields.join('", "')}" in cookie-update step "${step.name || step.id}"`;
    const missingPath = `step.config.${missingFields[0]}`;
    console.error(`❌ ${errorMessage}`);
    console.error(`❌ Missing JSON path: ${missingPath}`);
    console.error(`❌ Full step:`, JSON.stringify(step, null, 2));
    console.error(`❌ Step config:`, JSON.stringify(step.config, null, 2));
    
    const fullContext = {
      step_id: step.id,
      step_name: step.name || step.type,
      step_type: step.type,
      step_config: step.config,
      missing_fields: missingFields,
      full_step: step
    };
    
    if (jobId && workflowAnalyzer.backendLogger) {
      try {
        await workflowAnalyzer.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', {
          ...fullContext,
          missing_path: missingPath
        });
      } catch (e) {
        console.error(`❌ Failed to log error to backend:`, e.message);
      }
    }
    
    throw new Error(`${errorMessage}\nMissing JSON path: ${missingPath}\nFull step: ${JSON.stringify(step, null, 2)}`);
  }

  try {
    // Get project ID from job
    const jobResponse = await axios.get(`${workflowAnalyzer.backendUrl}/api/jobs/${jobId}`, {
      headers: workflowAnalyzer.getAuthHeaders()
    });
    // Handle both ObjectId and string formats
    let projectId = null;
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
    
    if (!projectId) {
      throw new Error(`Could not find project ID for job: ${jobId}`);
    }

    // Get current cookies
    const currentCookiesResponse = await axios.get(`${workflowAnalyzer.backendUrl}/api/projects/${projectId}/cookies`, {
      headers: workflowAnalyzer.getAuthHeaders()
    });
    const currentCookies = currentCookiesResponse.data || [];

    // Update cookie
    const updatedCookies = currentCookies.map(cookie => {
      if (cookie.name === config.cookieName) {
        return {
          ...cookie,
          value: config.value,
          domain: config.domain !== undefined ? config.domain : cookie.domain,
          path: config.path !== undefined ? config.path : cookie.path,
          expires: config.expires !== undefined ? config.expires : cookie.expires,
          secure: config.secure !== undefined ? config.secure : cookie.secure,
          httpOnly: config.httpOnly !== undefined ? config.httpOnly : cookie.httpOnly,
          sameSite: config.sameSite !== undefined ? config.sameSite : cookie.sameSite
        };
      }
      return cookie;
    });

    // Check if cookie was found
    const cookieExists = currentCookies.some(c => c.name === config.cookieName);
    if (!cookieExists) {
      throw new Error(`Cookie "${config.cookieName}" not found`);
    }

    // Update project cookies
    await axios.post(`${workflowAnalyzer.backendUrl}/api/projects/${projectId}/cookies`, {
      cookies: updatedCookies,
      source: 'workflow'
    }, {
      headers: workflowAnalyzer.getAuthHeaders()
    });

    workflowAnalyzer.storeStepResult(step, { cookieName: config.cookieName, updated: true }, workflowState);
    console.log(`✅ Cookie "${config.cookieName}" updated successfully`);
  } catch (error) {
    console.error(`❌ Cookie update failed: ${error.message}`);
    throw error;
  }
}




















