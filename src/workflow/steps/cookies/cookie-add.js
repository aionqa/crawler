/**
 * Execute Cookie Add Step
 * Adds a cookie to the project
 */

import axios from 'axios';

export async function executeCookieAddStep(step, workflowState, jobId, workflowAnalyzer) {
  console.log(`🍪 Adding cookie (${step.name})`);
  
  const config = step.config || {};
  if (!config.name || !config.value) {
    const missingFields = [];
    if (!config.name) missingFields.push('name');
    if (!config.value) missingFields.push('value');
    const errorMessage = `Missing required field(s) "${missingFields.join('", "')}" in cookie-add step "${step.name || step.id}"`;
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

    // Create new cookie
    const newCookie = {
      name: config.name,
      value: config.value,
      domain: config.domain || undefined,
      path: config.path || '/',
      expires: config.expires || undefined,
      secure: config.secure || false,
      httpOnly: config.httpOnly || false,
      sameSite: config.sameSite || undefined
    };

    // Add to existing cookies
    const updatedCookies = [...currentCookies, newCookie];

    // Update project cookies
    await axios.post(`${workflowAnalyzer.backendUrl}/api/projects/${projectId}/cookies`, {
      cookies: updatedCookies,
      source: 'workflow'
    }, {
      headers: workflowAnalyzer.getAuthHeaders()
    });

    workflowAnalyzer.storeStepResult(step, { cookie: newCookie, added: true }, workflowState);
    console.log(`✅ Cookie "${config.name}" added successfully`);
  } catch (error) {
    console.error(`❌ Cookie add failed: ${error.message}`);
    throw error;
  }
}




















