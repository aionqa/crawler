/**
 * Failure Analyzer - Analyzes failed automation attempts with AI
 * 
 * When an automation attempt fails, this service:
 * 1. Captures the failure context, logs, and error details
 * 2. Sends everything to OpenAI for analysis
 * 3. Stores the failure, AI analysis, and recommendations in MongoDB
 */

import { AIConversationLogger } from './ai-conversation-logger.js';
import { getRunnerBackendUrl } from '../src/utils/runner-service-urls.js';

export class FailureAnalyzer {
  constructor(backendUrl = null) {
    this.backendUrl = backendUrl || getRunnerBackendUrl();
    this.aiLogger = new AIConversationLogger(this.backendUrl);
  }

  /**
   * Analyze a failed automation attempt
   * @param {Object} failureContext - Context about the failure
   * @returns {Promise<Object>} AI analysis of the failure
   */
  async analyzeFailure(failureContext) {
    const {
      job_id,
      page_url,
      approach,
      attempt_number,
      error_message,
      logs_before,
      ai_decision,
      page_state,
      what_happened,
      screenshot_id = null
    } = failureContext;

    console.log(`[FAILURE-ANALYZER] 🔍 Analyzing failure for job ${job_id}, attempt ${attempt_number}`);

    try {
      // 1. Call OpenAI to analyze the failure
      const analysis = await this.aiLogger.makeAICallWithPrompt(
        'analyze-failure',
        {
          job_id,
          page_url,
          approach,
          attempt_number,
          error_message,
          logs_before: this.formatLogs(logs_before),
          ai_decision: JSON.stringify(ai_decision, null, 2),
          page_state: JSON.stringify(page_state, null, 2),
          what_happened
        },
        job_id,
        'failure-analyzer',
        page_url,
        screenshot_id,
        {
          analysis_type: 'failure',
          attempt_number,
          approach
        }
      );

      console.log(`[FAILURE-ANALYZER] ✅ Analysis complete: ${analysis.root_cause}`);

      // 2. Store the failure and analysis in database
      await this.storeFailure({
        job_id,
        page_url,
        approach,
        attempt_number,
        error_message,
        logs_before,
        ai_decision,
        page_state,
        screenshot_id,
        analysis,
        timestamp: new Date()
      });

      return analysis;

    } catch (error) {
      console.error(`[FAILURE-ANALYZER] ❌ Failed to analyze: ${error.message}`);
      throw error;
    }
  }

  /**
   * Format logs for AI consumption
   */
  formatLogs(logs) {
    if (!logs || logs.length === 0) return 'No logs available';
    
    return logs.map(log => 
      `[${log.timestamp}] [${log.level.toUpperCase()}] ${log.message}`
    ).join('\n');
  }

  /**
   * Store failure analysis in database
   */
  async storeFailure(failureData) {
    try {
      const response = await fetch(`${this.backendUrl}/api/failures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(failureData)
      });

      if (!response.ok) {
        console.warn(`[FAILURE-ANALYZER] ⚠️ Failed to store: ${response.status}`);
      } else {
        console.log(`[FAILURE-ANALYZER] 💾 Failure stored in database`);
      }
    } catch (error) {
      console.error(`[FAILURE-ANALYZER] ❌ Storage error: ${error.message}`);
    }
  }

  /**
   * Get stored failures for a job
   */
  async getFailuresForJob(jobId) {
    try {
      const response = await fetch(`${this.backendUrl}/api/failures?job_id=${jobId}`);
      if (!response.ok) return [];
      return await response.json();
    } catch (error) {
      console.error(`[FAILURE-ANALYZER] ❌ Failed to fetch failures: ${error.message}`);
      return [];
    }
  }

  /**
   * Check if we should analyze this failure
   * (Only analyze first attempts to avoid spam)
   */
  shouldAnalyze(attemptNumber, maxAttempts = 2) {
    return attemptNumber <= maxAttempts;
  }
}

// Export singleton instance
export const failureAnalyzer = new FailureAnalyzer();

