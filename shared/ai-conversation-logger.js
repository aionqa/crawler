/**
 * AI Conversation Logger for AionQA Agents
 * 
 * This module provides a standardized way for all agents (crawlers and login agents)
 * to log AI conversations to the backend for the ChatMode feature.
 */

import { StructuredAIResponse } from './structured-ai-response.js';
import OpenAI from 'openai';

export class AIConversationLogger {
  constructor(backendUrl = null) {
    // Use environment variable if available, otherwise fallback to default
    this.backendUrl = backendUrl || process.env.BACKEND_URL || 'http://back:4000';
    this.openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  /**
   * Send structured AI conversation to backend for chat mode
   * @param {Object} structuredResponse - StructuredAIResponse object
   */
  async sendStructuredConversation(structuredResponse) {
    console.log(`[AI-CONVERSATION] 🚀 Sending structured AI conversation for job ${structuredResponse.metadata.job_id} by agent ${structuredResponse.metadata.agent_name}`);
    try {
      const conversationData = {
        job_id: structuredResponse.metadata.job_id,
        agent_name: structuredResponse.metadata.agent_name,
        conversation_type: structuredResponse.metadata.conversation_type,
        structured_response: structuredResponse,
        timestamp: structuredResponse.metadata.timestamp
      };

      const httpResponse = await fetch(`${this.backendUrl}/ai-conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(conversationData)
      });

      if (httpResponse.ok) {
        console.log(`[AI-CONVERSATION] 🤖 Structured AI conversation sent to chat mode for job ${structuredResponse.metadata.job_id} by agent ${structuredResponse.metadata.agent_name}`);
      } else {
        console.log(`[AI-CONVERSATION] ⚠️ Failed to send structured AI conversation: ${httpResponse.status}`);
      }
    } catch (error) {
      console.log(`[AI-CONVERSATION] ⚠️ Error sending structured AI conversation: ${error.message}`);
    }
  }

  /**
   * Send AI conversation to backend for chat mode (updated structured format)
   * @param {string} jobId - Job ID this conversation belongs to
   * @param {string} agentName - Name of the agent (e.g., crawler-simplified, login-text)
   * @param {string} conversationType - Type of conversation (e.g., page_analysis, login_attempt, content_extraction)
   * @param {string} textRequest - The text request sent to AI
   * @param {Object} sourcePayload - Source data provided to AI (HTML, forms, screenshots, etc.)
   * @param {Object} aiResponse - The AI response
   * @param {string} screenshotId - Optional screenshot ID associated with this conversation
   * @param {string} pageUrl - Optional page URL this conversation relates to
   */
  async sendAIConversation(jobId, agentName, conversationType, textRequest, sourcePayload, aiResponse, screenshotId = null, pageUrl = null) {
    console.log(`[AI-CONVERSATION] 🚀 Attempting to send structured AI conversation for job ${jobId} by agent ${agentName}`);
    try {
      // Generate human-readable descriptions using AI
      const [humanRequest, humanResponse] = await Promise.all([
        this.generateCrawlerIntent(conversationType, textRequest, pageUrl),
        this.generateAIIntent(conversationType, aiResponse, pageUrl)
      ]);

      const conversationData = {
        job_id: jobId,
        agent_name: agentName,
        conversation_type: conversationType,
        text_request: textRequest,
        source_payload: sourcePayload || {},
        ai_response: aiResponse,
        human_request: humanRequest,
        human_response: humanResponse,
        screenshot_id: screenshotId,
        page_url: pageUrl,
        timestamp: new Date(),
        structured_response: true
      };

      const httpResponse = await fetch(`${this.backendUrl}/ai-conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(conversationData)
      });

      if (httpResponse.ok) {
        console.log(`[AI-CONVERSATION] 🤖 Structured AI conversation sent to chat mode for job ${jobId} by agent ${agentName}`);
        console.log(`[AI-CONVERSATION] 📝 Human Request: ${humanRequest}`);
        console.log(`[AI-CONVERSATION] 🤖 AI Response: ${humanResponse}`);
      } else {
        console.log(`[AI-CONVERSATION] ⚠️ Failed to send structured AI conversation: ${httpResponse.status}`);
      }
    } catch (error) {
      console.log(`[AI-CONVERSATION] ⚠️ Error sending structured AI conversation: ${error.message}`);
    }
  }

  /**
   * Generate human-readable crawler intent using AI
   */
  async generateCrawlerIntent(conversationType, textRequest, pageUrl) {
    try {
      // Extract key information from the technical prompt
      let extractedInfo = '';
      if (typeof textRequest === 'string') {
        // Look for key patterns in the technical prompt
        const urlMatch = textRequest.match(/Target URL:\s*([^\n]+)/);
        const titleMatch = textRequest.match(/Page Title:\s*([^\n]+)/);
        const taskMatch = textRequest.match(/Task:\s*([^\n]+)/);
        
        if (urlMatch) extractedInfo += `URL: ${urlMatch[1]}\n`;
        if (titleMatch) extractedInfo += `Page: ${titleMatch[1]}\n`;
        if (taskMatch) extractedInfo += `Task: ${taskMatch[1]}\n`;
      }

      const intentPrompt = `You are an AI assistant that generates human-readable descriptions for web automation requests in a chat interface.

Based on this web automation request, generate a clear, conversational description of what the HUMAN wants to accomplish:

Conversation Type: ${conversationType}
Page URL: ${pageUrl}
${extractedInfo ? `Key Info:\n${extractedInfo}` : ''}

Requirements:
- Write in first person from the human's perspective ("I want to...", "I need to...")
- Use clear, conversational language
- Focus on the goal/intent, not the technical details
- Keep it concise (1-2 sentences)
- Make it sound natural for a chat interface

Examples:
- "I want to analyze this login page to understand how to automate the login process"
- "I need to extract all the forms and interactive elements from this webpage"
- "I want to test if I can successfully log into this website with the provided credentials"
- "I need to crawl through this website and catalog all the pages and content"

Respond with ONLY the human-readable description, no quotes or explanations.`;

      const response = await this.openaiClient.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: intentPrompt }],
        max_tokens: 100,
        temperature: 0.7
      });

      return response.choices[0].message.content.trim();
    } catch (error) {
      console.warn('[AI-CONVERSATION] ⚠️ Failed to generate AI intent, using fallback:', error.message);
      
      // Fallback to static mapping
      const intentMap = {
        'page_analysis': `I want to analyze this webpage to understand its structure and content for crawling.`,
        'login_attempt': `I want to attempt to log into this page using the provided credentials.`,
        'form_analysis': `I need to analyze this form structure to understand how to interact with it.`,
        'screenshot_analysis': `I want to analyze this screenshot to understand the page structure and form elements.`,
        'script_generation': `I need to generate a Playwright script to interact with this page.`,
        'execution_analysis': `I want to analyze the results of my previous action to see if it was successful.`,
        'final_evaluation': `I need to evaluate the overall results and determine if the mission was successful.`,
        'content_extraction': `I want to extract content from this page for analysis.`,
        'crawl_summary': `I want to get a summary of the crawling operation and its results.`
      };
      return intentMap[conversationType] || `I want to perform ${conversationType} on this page.`;
    }
  }

  /**
   * Generate human-readable AI intent using AI
   */
  async generateAIIntent(conversationType, aiResponse, pageUrl) {
    try {
      // Extract key information from the AI response
      let extractedInfo = '';
      if (typeof aiResponse === 'string') {
        // Look for key patterns in the response
        const formsMatch = aiResponse.match(/Found.*?(\d+).*?form/i);
        const elementsMatch = aiResponse.match(/Found.*?(\d+).*?element/i);
        const successMatch = aiResponse.match(/success.*?(true|false)/i);
        
        if (formsMatch) extractedInfo += `Forms found: ${formsMatch[1]}\n`;
        if (elementsMatch) extractedInfo += `Elements found: ${elementsMatch[1]}\n`;
        if (successMatch) extractedInfo += `Success: ${successMatch[1]}\n`;
      } else if (typeof aiResponse === 'object' && aiResponse !== null) {
        // Extract from structured response
        if (aiResponse.forms) extractedInfo += `Forms: ${Array.isArray(aiResponse.forms) ? aiResponse.forms.length : 'found'}\n`;
        if (aiResponse.success !== undefined) extractedInfo += `Success: ${aiResponse.success}\n`;
        if (aiResponse.confidence) extractedInfo += `Confidence: ${aiResponse.confidence}\n`;
      }

      const responsePrompt = `You are an AI assistant that generates human-readable descriptions for web automation responses in a chat interface.

Based on this AI response, generate a clear, conversational description of what the AI accomplished or found:

Conversation Type: ${conversationType}
Page URL: ${pageUrl}
${extractedInfo ? `Key Results:\n${extractedInfo}` : ''}

Requirements:
- Write in first person from the AI's perspective ("I found...", "I discovered...", "I generated...")
- Use clear, conversational language
- Focus on what was accomplished or discovered
- Keep it concise (1-2 sentences)
- Make it sound natural for a chat interface
- Mention key findings or results

Examples:
- "I found 3 login forms on this page and generated a script to automate the login process"
- "I discovered 12 interactive elements and 5 forms that can be crawled"
- "I successfully analyzed the page structure and identified the best approach for automation"
- "I generated a Playwright script that should handle the login form interaction"

Respond with ONLY the human-readable description, no quotes or explanations.`;

      const response = await this.openaiClient.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: responsePrompt }],
        max_tokens: 100,
        temperature: 0.7
      });

      return response.choices[0].message.content.trim();
    } catch (error) {
      console.warn('[AI-CONVERSATION] ⚠️ Failed to generate AI response description, using fallback:', error.message);
      
      // Fallback to static mapping
      const intentMap = {
        'page_analysis': `I've analyzed the page structure and identified key elements. Here's what I found and my recommendations for next steps.`,
        'login_attempt': `I've analyzed the login attempt. Here's what happened and whether the login was successful.`,
        'form_analysis': `I've analyzed the form structure and identified the best approach for interaction.`,
        'screenshot_analysis': `I've analyzed the screenshot and identified key form elements and interaction points.`,
        'script_generation': `I've generated a Playwright script based on my analysis. Here's the code that should accomplish your goal.`,
        'execution_analysis': `I've analyzed the execution results. Here's my assessment of what happened and what should happen next.`,
        'final_evaluation': `I've completed the final evaluation of the session. Here's my comprehensive analysis and conclusions.`,
        'content_extraction': `I've extracted and analyzed the content from this page. Here's what I found.`,
        'crawl_summary': `I've completed the crawling operation and generated a summary of the results.`
      };
      return intentMap[conversationType] || `I've processed your request for ${conversationType}. Here's my analysis and recommendations.`;
    }
  }

  /**
   * Wrapper for OpenAI chat completions that automatically logs conversations
   * @param {Object} openaiClient - OpenAI client instance
   * @param {string} jobId - Job ID
   * @param {string} agentName - Agent name
   * @param {string} conversationType - Conversation type
   * @param {Object} options - OpenAI chat completion options
   * @param {string} screenshotId - Optional screenshot ID
   * @param {string} pageUrl - Optional page URL
   * @param {Object} sourcePayload - Optional source data (HTML, forms, etc.)
   * @returns {Promise<Object>} OpenAI response
   */
  async createChatCompletion(openaiClient, jobId, agentName, conversationType, options, screenshotId = null, pageUrl = null, sourcePayload = null) {
    try {
      const response = await openaiClient.chat.completions.create(options);
      
      // Extract the main user message for logging
      const userMessage = options.messages.find(msg => msg.role === 'user')?.content || '';
      
      // Log the conversation with enhanced human-readable descriptions
      await this.sendAIConversation(
        jobId,
        agentName,
        conversationType,
        userMessage,
        sourcePayload || {
          model: options.model,
          messages: options.messages,
          ...(options.temperature !== undefined && { temperature: options.temperature }),
          ...(options.max_tokens !== undefined && { max_tokens: options.max_tokens }),
          response_format: options.response_format
        },
        {
          choices: response.choices,
          usage: response.usage,
          model: response.model,
          id: response.id,
          content: response.choices[0]?.message?.content || ''
        },
        screenshotId,
        pageUrl
      );

      return response;
    } catch (error) {
      // Log failed conversation
      const userMessage = options.messages.find(msg => msg.role === 'user')?.content || '';
      
      await this.sendAIConversation(
        jobId,
        agentName,
        conversationType,
        userMessage,
        sourcePayload || {
          model: options.model,
          messages: options.messages,
          ...(options.temperature !== undefined && { temperature: options.temperature }),
          ...(options.max_tokens !== undefined && { max_tokens: options.max_tokens }),
          response_format: options.response_format
        },
        {
          error: error.message,
          success: false
        },
        screenshotId,
        pageUrl
      );
      
      throw error;
    }
  }

        /**
         * Analyze request and response with AI to generate clean descriptions
         */
        async analyzeConversationWithAI(jobId, agentName, pageUrl, requestData, responseData, screenshotId = null) {
          try {
            const analysisPrompt = `You are an AI assistant that generates human-readable descriptions for web automation conversations in a chat interface.
            
            Analyze the following request and response data and provide a JSON response with:
            
            1. request_description: A clear, human-readable description of what the HUMAN wants to do (the intent/purpose)
            2. response_description: A clear, human-readable description of what the AI accomplished or found
            3. request_summary: Key details from the request (forms found, page info, etc.)
            4. response_summary: Key details from the response (actions taken, results, etc.)
            5. key_findings: Array of important findings or insights
            6. confidence_score: 0-1 confidence in the analysis
            7. playwright_script: Extract any Playwright script from the response (if present)
            8. html_content: Extract any HTML content from the response (if present)
            9. forms_data: Extract any forms data from the request (if present)
            10. screenshot_data: Extract any screenshot data from the request (if present)
            
            IMPORTANT: 
            - request_description should describe what the HUMAN wants to accomplish (the goal/intent)
            - response_description should describe what the AI found or accomplished
            - Use clear, conversational language that a human would understand
            
            Examples:
            - request_description: "Analyze login page structure and identify form elements for automated authentication"
            - response_description: "Found 2 login forms with username and password fields, generated Playwright script for automated login"
            
            - request_description: "Extract page content and catalog interactive elements for crawling"
            - response_description: "Discovered 5 forms and 12 links, created navigation script to crawl all pages"
            
            - request_description: "Test login functionality with provided credentials"
            - response_description: "Login successful, user redirected to dashboard page"
            
            Request Data:
            ${JSON.stringify(requestData, null, 2)}
            
            Response Data:
            ${JSON.stringify(responseData, null, 2)}
            
            Agent: ${agentName}
            Page URL: ${pageUrl}
            
            Respond with valid JSON only.`;

      const analysisResponse = await this.openaiClient.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: analysisPrompt }],
        response_format: { type: "json_object" }
      });

      const aiAnalysis = JSON.parse(analysisResponse.choices[0].message.content);
      
      // Create structured response with AI analysis
      const structuredResponse = StructuredAIResponse.createAIAnalyzedResponse(
        agentName,
        jobId,
        pageUrl,
        requestData,
        responseData,
        aiAnalysis,
        screenshotId
      );

      // Send the analyzed conversation
      await this.sendStructuredConversation(structuredResponse);

      return structuredResponse;
    } catch (error) {
      console.warn('[AI-CONVERSATION] ⚠️ Failed to analyze conversation with AI:', error.message);
      
      // Fallback to regular logging if AI analysis fails
      await this.sendAIConversation(
        jobId,
        agentName,
        'conversation_analysis_failed',
        requestData,
        { error: error.message, success: false },
        screenshotId,
        pageUrl
      );
      
      throw error;
    }
  }
}

// Create a default instance using environment variable
export const aiConversationLogger = new AIConversationLogger();
