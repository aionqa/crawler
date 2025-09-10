// Example usage of API contract validation schemas
// This shows how to use the validation schemas in backend and agent code

import { 
  validateLoginRequest, 
  validateLoginResponse,
  validateBackendLoginRequest,
  validateBackendLoginResponse,
  validateCrawlerRequest,
  validateCrawlerResponse,
  validateBackendCrawlerRequest,
  validateBackendCrawlerResponse
} from './validation-schemas.js';

// Example: Backend sending request to login agent
function sendLoginRequestToAgent(agentUrl, requestData) {
  try {
    // Validate the request data before sending
    const validatedRequest = validateBackendLoginRequest(requestData);
    
    // Convert to JSON-RPC format for agent
    const jsonRpcRequest = {
      jsonrpc: "2.0",
      method: "attemptLogin",
      params: {
        url: validatedRequest.target_url,
        username: validatedRequest.credentials.username,
        password: validatedRequest.credentials.password,
        headless: validatedRequest.options.headless,
        timeout: validatedRequest.options.timeout
      },
      id: Date.now()
    };
    
    // Send request to agent
    return fetch(`${agentUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jsonRpcRequest)
    });
    
  } catch (error) {
    console.error('Request validation failed:', error.message);
    throw new Error(`Invalid request data: ${error.message}`);
  }
}

// Example: Login agent processing request
function processLoginRequest(jsonRpcRequest) {
  try {
    // Validate incoming JSON-RPC request
    const validatedRequest = validateLoginRequest(jsonRpcRequest);
    
    // Process login logic here...
    const result = {
      success: true,
      cookies: [],
      screenshot: "base64...",
      pageContent: "<html>...</html>",
      redirectUrl: "https://example.com/dashboard"
    };
    
    // Validate response before sending
    const validatedResponse = validateLoginResponse({
      jsonrpc: "2.0",
      result: result,
      id: validatedRequest.id
    });
    
    return validatedResponse;
    
  } catch (error) {
    console.error('Request/Response validation failed:', error.message);
    return {
      jsonrpc: "2.0",
      error: {
        code: "INVALID_REQUEST",
        message: error.message
      },
      id: jsonRpcRequest.id || 0
    };
  }
}

// Example: Backend sending request to crawler agent
function sendCrawlerRequestToAgent(agentUrl, requestData) {
  try {
    // Validate the request data before sending
    const validatedRequest = validateBackendCrawlerRequest(requestData);
    
    // Convert to JSON-RPC format for agent
    const jsonRpcRequest = {
      jsonrpc: "2.0",
      method: "startCrawl",
      params: {
        startUrl: validatedRequest.start_url,
        maxPages: validatedRequest.max_pages,
        maxDepth: validatedRequest.max_depth,
        headless: validatedRequest.options.headless,
        timeout: validatedRequest.options.timeout,
        cookies: validatedRequest.cookies,
        analysisSettings: {
          takeScreenshots: true,
          extractText: true,
          extractLinks: true,
          extractForms: true,
          aiAnalysis: true
        }
      },
      id: Date.now()
    };
    
    // Send request to agent
    return fetch(`${agentUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jsonRpcRequest)
    });
    
  } catch (error) {
    console.error('Request validation failed:', error.message);
    throw new Error(`Invalid request data: ${error.message}`);
  }
}

// Example: Crawler agent processing request
function processCrawlerRequest(jsonRpcRequest) {
  try {
    // Validate incoming JSON-RPC request
    const validatedRequest = validateCrawlerRequest(jsonRpcRequest);
    
    // Process crawling logic here...
    const result = {
      success: true,
      pages: [
        {
          url: "https://example.com",
          title: "Example Page",
          content: "<html>...</html>",
          screenshot: "base64...",
          links: ["https://example.com/page1", "https://example.com/page2"],
          forms: [],
          aiAnalysis: {}
        }
      ]
    };
    
    // Validate response before sending
    const validatedResponse = validateCrawlerResponse({
      jsonrpc: "2.0",
      result: result,
      id: validatedRequest.id
    });
    
    return validatedResponse;
    
  } catch (error) {
    console.error('Request/Response validation failed:', error.message);
    return {
      jsonrpc: "2.0",
      error: {
        code: "INVALID_REQUEST",
        message: error.message
      },
      id: jsonRpcRequest.id || 0
    };
  }
}

export {
  sendLoginRequestToAgent,
  processLoginRequest,
  sendCrawlerRequestToAgent,
  processCrawlerRequest
};
