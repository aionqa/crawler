import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import axios from 'axios';

dotenv.config();

const app = express();
const PORT = process.env.AI_SERVICE_PORT || 5000;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(cors());
app.use(express.json());

// System prompt for the AI assistant
const SYSTEM_PROMPT = `You are an AI assistant for AionQA, a web crawling and analysis system. You can help users with:

1. **Page Analysis**: Scan and analyze web pages
2. **Test Generation**: Create automated tests for web pages
3. **Configuration Management**: Help with crawl settings and configurations
4. **Content Analysis**: Analyze page content, forms, and interactive elements
5. **Troubleshooting**: Help debug crawling issues
6. **Data Retrieval**: Get information about pages, jobs, configurations, and logs
7. **Script Generation**: Create Playwright scripts for automation
8. **Page Management**: Filter and manage pages by status, patterns, or URLs

Available commands you can execute:
- scan <url> - Scan and analyze a web page
- analyze <page_id> - Analyze a specific page by ID
- generate_tests <page_id> - Generate tests for a page
- generate_script <page_id> - Generate a Playwright script for a page
- get_config <project_id> - Get project configuration
- list_pages <project_id> - List pages in a project
- get_failed_pages <project_id> - Get pages with failed status
- get_pages_by_pattern <project_id> <pattern> - Get pages matching a URL pattern
- get_pages_by_urls <project_id> <urls> - Get specific pages by URLs
- crawl <url> - Start crawling a website
- get_jobs <project_id> - Get job information
- get_logs <job_id> - Get logs for a specific job
- generate_prompt <type> - Generate AI prompts for analysis

When users ask you to perform actions, use the available API endpoints to interact with the AionQA backend. Always provide helpful, detailed responses and explain what you're doing.

Be conversational and helpful. If you need more information from the user, ask for it clearly.`;

// Function to call AionQA backend APIs
async function callBackendAPI(endpoint, method = 'GET', data = null) {
  try {
    const config = {
      method,
      url: `${BACKEND_URL}${endpoint}`,
      headers: {
        'Content-Type': 'application/json',
      },
    };
    
    if (data) {
      config.data = data;
    }
    
    const response = await axios(config);
    return response.data;
  } catch (error) {
    console.error(`Backend API call failed: ${error.message}`);
    throw new Error(`Failed to call backend: ${error.response?.data?.error || error.message}`);
  }
}

// Function to process user commands
async function processCommand(message, projectId) {
  const lowerMessage = message.toLowerCase();
  
  // Extract URL from message
  const urlMatch = message.match(/https?:\/\/[^\s]+/);
  const url = urlMatch ? urlMatch[0] : null;
  
  // Extract page ID from message
  const pageIdMatch = message.match(/page[_\s]*id[:\s]*([a-f0-9]{24})/i);
  const pageId = pageIdMatch ? pageIdMatch[1] : null;
  
  try {
    if (lowerMessage.includes('scan') && url) {
      // Scan a URL
      const result = await callBackendAPI('/test-script', 'POST', {
        script: `return { url: '${url}', title: document.title, content: document.body.innerText.substring(0, 1000) };`,
        testUrl: url
      });
      
      return `I've scanned ${url}:\n\n**Title:** ${result.title || 'Unknown'}\n**Content Preview:** ${result.content || 'No content found'}\n\nWould you like me to perform a more detailed analysis or generate tests for this page?`;
    }
    
    if (lowerMessage.includes('analyze') && pageId) {
      // Analyze a specific page
      const page = await callBackendAPI(`/pages/${pageId}`);
      return `**Page Analysis for ${page.title}:**\n\n**URL:** ${page.url}\n**Status:** ${page.analyzed ? 'Analyzed' : 'Not analyzed'}\n**Created:** ${new Date(page.created_at).toLocaleString()}\n\nWould you like me to perform a detailed analysis or generate tests for this page?`;
    }
    
    if (lowerMessage.includes('generate') && lowerMessage.includes('test') && pageId) {
      // Generate tests for a page
      const page = await callBackendAPI(`/pages/${pageId}`);
      const testScript = `// Test for ${page.title}
async function testPage() {
  await page.goto('${page.url}');
  
  // Test page title
  const title = await page.title();
  console.log('Page title:', title);
  
  // Test for common elements
  const forms = await page.$$('form');
  console.log('Found', forms.length, 'forms');
  
  const buttons = await page.$$('button');
  console.log('Found', buttons.length, 'buttons');
  
  const links = await page.$$('a');
  console.log('Found', links.length, 'links');
  
  return {
    title: title,
    forms: forms.length,
    buttons: buttons.length,
    links: links.length
  };
}

return await testPage();`;
      
      return `I've generated a test script for **${page.title}**:\n\n\`\`\`javascript\n${testScript}\n\`\`\`\n\nThis test will check the page title and count forms, buttons, and links. Would you like me to run this test or modify it?`;
    }
    
    if (lowerMessage.includes('config') && projectId) {
      // Get project configuration
      const configs = await callBackendAPI(`/configurations?project_id=${projectId}`);
      if (configs.length === 0) {
        return `No configurations found for this project. Would you like me to help you create one?`;
      }
      
      const config = configs[0];
      return `**Project Configuration:**\n\n**Domain:** ${config.domain}\n**Login Enabled:** ${config.login_enabled ? 'Yes' : 'No'}\n**Headless Mode:** ${config.headless ? 'Yes' : 'No'}\n**Timeout:** ${config.timeout}ms\n**Save Cookies:** ${config.save_cookies ? 'Yes' : 'No'}\n\nWould you like me to help you modify these settings?`;
    }
    
    if (lowerMessage.includes('list') && lowerMessage.includes('page') && projectId) {
      // List pages in project
      const pages = await callBackendAPI(`/pages?project_id=${projectId}`);
      if (pages.length === 0) {
        return `No pages found in this project. Would you like me to help you start crawling a website?`;
      }
      
      const pageList = pages.slice(0, 10).map(page => 
        `• **${page.title || 'Untitled'}** - ${page.url} (${page.analyzed ? 'Analyzed' : 'Not analyzed'})`
      ).join('\n');
      
      return `**Pages in this project (${pages.length} total):**\n\n${pageList}\n\n${pages.length > 10 ? `... and ${pages.length - 10} more pages` : ''}\n\nWould you like me to analyze any specific page or generate tests?`;
    }
    
    if (lowerMessage.includes('crawl') && url) {
      // Start crawling
      if (!projectId) {
        return `I need a project ID to start crawling. Please select a project first.`;
      }
      
      // Get or create configuration
      const configs = await callBackendAPI(`/configurations?project_id=${projectId}`);
      let configId;
      
      if (configs.length === 0) {
        // Create a new configuration
        const newConfig = await callBackendAPI('/configurations', 'POST', {
          project_id: projectId,
          name: 'AI Generated Config',
          domain: url,
          login_enabled: false,
          save_cookies: false,
          headless: true,
          timeout: 30000
        });
        configId = newConfig._id;
      } else {
        configId = configs[0]._id;
      }
      
      // Start crawl
      const result = await callBackendAPI(`/configurations/${configId}/start-crawl`, 'POST', {
        project_id: projectId,
        max_pages: 50,
        max_depth: 3
      });
      
      return `I've started crawling **${url}**!\n\n**Job ID:** ${result.job_id}\n**Max Pages:** 50\n**Max Depth:** 3\n\nYou can monitor the progress in the Jobs tab. The crawl will discover and analyze pages automatically.`;
    }
    
    if (lowerMessage.includes('generate') && lowerMessage.includes('script') && pageId) {
      // Generate Playwright script for a page
      const page = await callBackendAPI(`/pages/${pageId}`);
      const script = `// Playwright script for ${page.title}
import { test, expect } from '@playwright/test';

test('${page.title} - Automated Test', async ({ page }) => {
  // Navigate to the page
  await page.goto('${page.url}');
  
  // Wait for page to load
  await page.waitForLoadState('networkidle');
  
  // Check page title
  await expect(page).toHaveTitle(/.*/);
  
  // Take a screenshot
  await page.screenshot({ path: '${page.title.replace(/[^a-zA-Z0-9]/g, '_')}_screenshot.png' });
  
  // Check for common elements
  const body = await page.locator('body');
  await expect(body).toBeVisible();
  
  // Add more specific tests based on page content
  console.log('Page loaded successfully: ${page.url}');
});`;
      
      return `I've generated a Playwright script for ${page.title}:\n\n\`\`\`javascript\n${script}\n\`\`\`\n\nThis script will navigate to the page, take a screenshot, and perform basic checks. You can customize it further based on your specific testing needs.`;
    }
    
    if (lowerMessage.includes('failed') && lowerMessage.includes('pages')) {
      // Get failed pages
      const pages = await callBackendAPI(`/pages?project_id=${projectId}`);
      const failedPages = pages.filter(p => p.status === 'failed' || p.analyzed === false);
      
      if (failedPages.length === 0) {
        return `No failed pages found in the project. All pages appear to be successfully analyzed.`;
      }
      
      const pageList = failedPages.map(p => `- **${p.title}** (${p.url}) - Status: ${p.status || 'Not analyzed'}`).join('\n');
      return `Found ${failedPages.length} failed or unanalyzed pages:\n\n${pageList}\n\nWould you like me to retry analysis for any of these pages or generate scripts for them?`;
    }
    
    if (lowerMessage.includes('pages') && lowerMessage.includes('pattern')) {
      // Get pages by pattern
      const patternMatch = message.match(/pattern[:\s]+(.+)/i);
      if (patternMatch) {
        const pattern = patternMatch[1].trim();
        const pages = await callBackendAPI(`/pages?project_id=${projectId}`);
        const matchingPages = pages.filter(p => p.url.includes(pattern));
        
        if (matchingPages.length === 0) {
          return `No pages found matching pattern "${pattern}".`;
        }
        
        const pageList = matchingPages.map(p => `- **${p.title}** (${p.url})`).join('\n');
        return `Found ${matchingPages.length} pages matching pattern "${pattern}":\n\n${pageList}`;
      }
    }
    
    if (lowerMessage.includes('pages') && lowerMessage.includes('url')) {
      // Get pages by specific URLs
      const urls = message.match(/https?:\/\/[^\s]+/g);
      if (urls && urls.length > 0) {
        const pages = await callBackendAPI(`/pages?project_id=${projectId}`);
        const matchingPages = pages.filter(p => urls.some(url => p.url.includes(url)));
        
        if (matchingPages.length === 0) {
          return `No pages found for the specified URLs.`;
        }
        
        const pageList = matchingPages.map(p => `- **${p.title}** (${p.url}) - Status: ${p.status || 'Unknown'}`).join('\n');
        return `Found ${matchingPages.length} pages for the specified URLs:\n\n${pageList}`;
      }
    }
    
    if (lowerMessage.includes('jobs')) {
      // Get job information
      const jobs = await callBackendAPI(`/runs?project_id=${projectId}`);
      
      if (jobs.length === 0) {
        return `No jobs found for this project.`;
      }
      
      const jobList = jobs.map(job => `- **Job ${job.id}** - Status: ${job.status} - Created: ${new Date(job.created_at).toLocaleString()}`).join('\n');
      return `Found ${jobs.length} jobs:\n\n${jobList}`;
    }
    
    if (lowerMessage.includes('logs')) {
      // Get logs for a job
      const jobIdMatch = message.match(/job[_\s]*id[:\s]*([a-f0-9]{24})/i);
      if (jobIdMatch) {
        const jobId = jobIdMatch[1];
        const logs = await callBackendAPI(`/runs/${jobId}/logs`);
        
        if (logs.length === 0) {
          return `No logs found for job ${jobId}.`;
        }
        
        const logEntries = logs.slice(-10).map(log => `- ${log}`).join('\n');
        return `Recent logs for job ${jobId}:\n\n${logEntries}`;
      }
    }
    
    if (lowerMessage.includes('generate') && lowerMessage.includes('prompt')) {
      // Generate AI prompts
      const promptTypes = {
        'page analysis': 'Analyze this web page and provide insights about its structure, content, and functionality.',
        'form detection': 'Identify all forms on this page and describe their fields and purposes.',
        'link analysis': 'Find all links on this page and categorize them by type and destination.',
        'content extraction': 'Extract the main content from this page, excluding navigation and ads.',
        'accessibility': 'Check this page for accessibility issues and provide recommendations.'
      };
      
      const typeMatch = message.match(/prompt[:\s]+(.+)/i);
      if (typeMatch) {
        const type = typeMatch[1].trim().toLowerCase();
        const prompt = promptTypes[type] || promptTypes['page analysis'];
        return `Here's a prompt for ${type}:\n\n**${prompt}**\n\nYou can use this prompt with the AI analysis features to get specific insights about your pages.`;
      }
      
      return `Available prompt types:\n\n${Object.keys(promptTypes).map(key => `- **${key}**: ${promptTypes[key]}`).join('\n')}\n\nAsk me to generate a prompt for any of these types.`;
    }
    
    return null; // No specific command matched
  } catch (error) {
    return `Sorry, I encountered an error: ${error.message}`;
  }
}

// Chat endpoint
app.post('/chat', async (req, res) => {
  const startTime = Date.now();
  const requestId = Math.random().toString(36).substr(2, 9);
  
  try {
    const { message, projectId, conversationHistory = [] } = req.body;
    
    console.log(`[${new Date().toISOString()}] AI_REQUEST | ${requestId} | Project: ${projectId} | Message: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`);
    
    if (!message) {
      console.log(`[${new Date().toISOString()}] AI_ERROR | ${requestId} | Missing message`);
      return res.status(400).json({ error: 'Message is required' });
    }
    
    // First, try to process as a command
    const commandResponse = await processCommand(message, projectId);
    
    if (commandResponse) {
      const duration = Date.now() - startTime;
      console.log(`[${new Date().toISOString()}] AI_COMMAND | ${requestId} | Duration: ${duration}ms | Response: ${commandResponse.substring(0, 100)}${commandResponse.length > 100 ? '...' : ''}`);
      return res.json({ response: commandResponse });
    }
    
    // If no command matched, use OpenAI for general conversation
    console.log(`[${new Date().toISOString()}] AI_OPENAI | ${requestId} | Using OpenAI for general conversation`);
    
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...conversationHistory.slice(-10), // Keep last 10 messages for context
      { role: 'user', content: message }
    ];
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 1000,
      temperature: 0.7,
    });
    
    const response = completion.choices[0].message.content;
    const duration = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] AI_OPENAI_RESPONSE | ${requestId} | Duration: ${duration}ms | Tokens: ${completion.usage?.total_tokens || 'unknown'} | Response: ${response.substring(0, 100)}${response.length > 100 ? '...' : ''}`);
    
    res.json({ response });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] AI_ERROR | ${requestId} | Duration: ${duration}ms | Error: ${error.message}`);
    res.status(500).json({ 
      error: error.message || 'An error occurred while processing your request' 
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🤖 AI Service running on port ${PORT}`);
  console.log(`🔗 Backend URL: ${BACKEND_URL}`);
});
