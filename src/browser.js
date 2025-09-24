/**
 * Browser automation and Playwright operations
 */

import { chromium } from 'playwright';
import { uploadLogs, uploadScreenshot, uploadVideo, streamFrame } from './backend.js';
import { createRemoteBrowserContext } from '/app/shared/remote-browser-client.js';

/**
 * Executes an action with browser automation
 */
export async function withBrowser(action, options = {}) {
  // Check if we should use remote browser service
  // Prioritize options.useRemoteBrowser over environment variable
  const useRemoteBrowser = options.useRemoteBrowser !== undefined ? options.useRemoteBrowser : (process.env.USE_REMOTE_BROWSER === 'true');
  const browserServiceUrl = process.env.BROWSER_SERVICE_URL || 'http://back:4000';

  console.log(`[BROWSER] 🔧 useRemoteBrowser: ${useRemoteBrowser}, options.useRemoteBrowser: ${options.useRemoteBrowser}, env.USE_REMOTE_BROWSER: ${process.env.USE_REMOTE_BROWSER}`);

  if (useRemoteBrowser) {
    console.log('[BROWSER] 🌐 Attempting to use remote browser service...');
    try {
      return await withBrowserlessService(action, options);
    } catch (error) {
      console.log(`[BROWSER] ❌ Remote browser failed (${error.message}), falling back to local browser...`);
      return await withLocalBrowser(action, options);
    }
  } else {
    console.log('[BROWSER] 🏠 Using local browser...');
    return await withLocalBrowser(action, options);
  }
}

/**
 * Executes an action with local browser automation
 */
async function withLocalBrowser(action, options = {}) {
  const browser = await chromium.launch({
    headless: options.headless !== false,
      executablePath: '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const browserContext = await browser.newContext({
      viewport: { width: 1280, height: 720 }
    });

    // Add initial cookies if provided
    if (options.cookies && options.cookies.length > 0) {
      await browserContext.addCookies(options.cookies);
    }

    const page = await browserContext.newPage();
    
    // Set up video recording if endpoint is provided
    let videoPath = null;
    let videoBuffer = null;
    if (options.backend_endpoints?.video) {
      try {
        const video = page.video();
        if (video) {
          videoPath = `/tmp/login-video-${Date.now()}.webm`;
          await video.saveAs(videoPath);
        } else {
          console.log('[VIDEO] ⚠️ Video recording not available for this page');
        }
      } catch (error) {
        console.log('[VIDEO] ⚠️ Video recording setup failed:', error.message);
      }
    }

    // Set up logging and streaming
    const logs = [];
    const screenshots = [];
    let streamInterval = null;
    let logInterval = null;

    // Start streaming frames if endpoint is provided
    if (options.backend_endpoints?.stream) {
      streamInterval = setInterval(async () => {
        try {
          const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 });
          await streamFrame(options.backend_endpoints.stream, screenshot, {
            timestamp: new Date().toISOString(),
            url: page.url()
          });
        } catch (error) {
          console.log('[STREAM] ❌ Error streaming frame:', error.message);
        }
      }, 5000);
    }

    // Start uploading logs if endpoint is provided
    if (options.backend_endpoints?.logs) {
      logInterval = setInterval(async () => {
        if (logs.length > 0) {
          await uploadLogs(options.backend_endpoints.logs, [...logs]);
          logs.length = 0; // Clear uploaded logs
        }
      }, 5000);
    }

    // Override console methods to capture logs
    page.on('console', msg => {
      const logEntry = {
        type: msg.type(),
        text: msg.text(),
        timestamp: new Date().toISOString(),
        url: page.url()
      };
      logs.push(logEntry);
      console.log(`[BROWSER-${msg.type().toUpperCase()}] ${msg.text()}`);
    });

    // Capture screenshots periodically if endpoint is provided
    if (options.backend_endpoints?.screenshots) {
      const screenshotInterval = setInterval(async () => {
        try {
          const screenshot = await page.screenshot({ fullPage: true });
          const filename = `screenshot-${Date.now()}.png`;
          await uploadScreenshot(options.backend_endpoints.screenshots, screenshot, {
            filename,
            timestamp: new Date().toISOString(),
            url: page.url(),
            jobId: options.job_id || 'unknown-job'
          });
        } catch (error) {
          console.log('[SCREENSHOT] ❌ Error capturing screenshot:', error.message);
        }
      }, 60000); // Changed from 10 seconds to 60 seconds
      
      // Store interval reference for cleanup
      page.screenshotInterval = screenshotInterval;
    }

    const result = await action(page, browserContext);

    // Clean up intervals
    if (streamInterval) clearInterval(streamInterval);
    if (logInterval) clearInterval(logInterval);
    if (page.screenshotInterval) clearInterval(page.screenshotInterval);

    // Upload final logs if endpoint is provided
    if (options.backend_endpoints?.logs && logs.length > 0) {
      await uploadLogs(options.backend_endpoints.logs, logs);
    }

    // Handle video upload if endpoint is provided
    if (options.backend_endpoints?.video && videoPath) {
      try {
        const fs = await import('fs');
        if (fs.existsSync(videoPath)) {
          videoBuffer = fs.readFileSync(videoPath);
          await uploadVideo(options.backend_endpoints.video, videoBuffer, {
            timestamp: new Date().toISOString(),
            duration: Date.now() - result.startTime
          });
          fs.unlinkSync(videoPath); // Clean up temp file
        }
      } catch (error) {
        console.log('[VIDEO] ❌ Error uploading video:', error.message);
      }
    }

    // Get final cookies
    const cookies = await browserContext.cookies();
    
    // If no backend endpoints, return data in result
    const returnData = {
      ...result,
      cookies,
      logs: options.backend_endpoints?.logs ? [] : logs, // Only return if no upload endpoint
      screenshots: options.backend_endpoints?.screenshots ? [] : screenshots, // Only return if no upload endpoint
      video: options.backend_endpoints?.video ? null : (videoBuffer ? videoBuffer.toString('base64') : null) // Only return if no upload endpoint
    };

    return returnData;

  } finally {
    await browser.close();
  }
}

/**
 * Executes an action with browserless service (multiple browser instances)
 */
async function withBrowserlessService(action, options = {}) {
  const browserUrls = process.env.BROWSER_SERVICE_URLS?.split(',') || [
    'http://browser-1:3000',
    'http://browser-2:3000', 
    'http://browser-3:3000',
    'http://browser-4:3000',
    'http://browser-5:3000'
  ];
  
  let browserUrl = null;
  let browser = null;
  let context = null;
  
  try {
    // Try to find an available browser
    for (const url of browserUrls) {
      try {
        console.log(`[BROWSERLESS] 🔍 Trying browser at ${url}...`);
        
        // Connect to browserless service
        browser = await chromium.connectOverCDP(url);
        context = await browser.newContext({
          viewport: { width: 1280, height: 720 }
        });
        
        browserUrl = url;
        console.log(`[BROWSERLESS] ✅ Connected to browser at ${url}`);
        break;
        
      } catch (error) {
        console.log(`[BROWSERLESS] ❌ Browser at ${url} unavailable: ${error.message}`);
        continue;
      }
    }
    
    if (!browser || !context) {
      throw new Error('No available browser instances found');
    }
    
    const page = await context.newPage();
    
    // Add initial cookies if provided
    if (options.cookies && options.cookies.length > 0) {
      await context.addCookies(options.cookies);
    }
    
    // Execute the action
    const result = await action(page, context);
    
    // Get final cookies
    const cookies = await context.cookies();
    
    return {
      ...result,
      cookies: cookies,
      browserUrl: browserUrl
    };
    
  } catch (error) {
    console.error(`[BROWSERLESS] ❌ Error: ${error.message}`);
    throw error;
  } finally {
    // Clean up
    if (context) {
      await context.close();
    }
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * Executes an action with remote browser automation
 */
async function withRemoteBrowser(action, options = {}, browserServiceUrl) {
  let remoteContext = null;
  
  try {
    console.log('[REMOTE-BROWSER] 🔍 Creating remote browser context...');
    remoteContext = await createRemoteBrowserContext(browserServiceUrl, {
      jobId: options.jobId,
      projectId: options.projectId,
      agentType: 'unified-crawler',
      useDedicatedBrowser: true, // Force dedicated browser instance for login operations
      metadata: {
        operation: 'login',
        timestamp: new Date().toISOString(),
        useDedicatedBrowser: true
      }
    });
    
    const { page, context } = remoteContext;
    
    // Set up logging and streaming
    const logs = [];
    const screenshots = [];
    let streamInterval = null;
    let logInterval = null;

    // Start streaming frames if endpoint is provided
    if (options.backend_endpoints?.stream) {
      streamInterval = setInterval(async () => {
        try {
          const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 });
          await streamFrame(options.backend_endpoints.stream, screenshot, {
            timestamp: new Date().toISOString(),
            url: await page.url()
          });
        } catch (error) {
          console.log('[STREAM] ❌ Error streaming frame:', error.message);
        }
      }, 5000);
    }

    // Start uploading logs if endpoint is provided
    if (options.backend_endpoints?.logs) {
      logInterval = setInterval(async () => {
        if (logs.length > 0) {
          await uploadLogs(options.backend_endpoints.logs, [...logs]);
          logs.length = 0; // Clear uploaded logs
        }
      }, 5000);
    }

    // Capture screenshots periodically if endpoint is provided
    if (options.backend_endpoints?.screenshots) {
      const screenshotInterval = setInterval(async () => {
        try {
          const screenshot = await page.screenshot({ fullPage: true });
          const filename = `screenshot-${Date.now()}.png`;
          await uploadScreenshot(options.backend_endpoints.screenshots, screenshot, {
            filename,
            timestamp: new Date().toISOString(),
            url: await page.url(),
            jobId: options.job_id || 'unknown-job'
          });
        } catch (error) {
          console.log('[SCREENSHOT] ❌ Error capturing screenshot:', error.message);
        }
      }, 60000); // Changed from 10 seconds to 60 seconds
      
      // Store interval reference for cleanup
      page.screenshotInterval = screenshotInterval;
    }

    const result = await action(page, context);

    // Clean up intervals
    if (streamInterval) clearInterval(streamInterval);
    if (logInterval) clearInterval(logInterval);
    if (page.screenshotInterval) clearInterval(page.screenshotInterval);

    // Upload final logs if endpoint is provided
    if (options.backend_endpoints?.logs && logs.length > 0) {
      await uploadLogs(options.backend_endpoints.logs, logs);
    }

    // Get final cookies from remote browser
    let cookies = [];
    try {
      cookies = await context.cookies();
      console.log(`[REMOTE-BROWSER] 🍪 Retrieved ${cookies.length} cookies from remote browser`);
    } catch (error) {
      console.log(`[REMOTE-BROWSER] ❌ Failed to get cookies:`, error.message);
      cookies = [];
    }
    
    // If no backend endpoints, return data in result
    const returnData = {
      ...result,
      cookies,
      logs: options.backend_endpoints?.logs ? [] : logs, // Only return if no upload endpoint
      screenshots: options.backend_endpoints?.screenshots ? [] : screenshots, // Only return if no upload endpoint
      video: null, // Remote browsers don't support video recording yet
      browser_context_id: remoteContext.contextId, // Include browser context ID for tracking
      browser_metadata: remoteContext.metadata || {}
    };

    return returnData;

  } finally {
    if (remoteContext) {
      await remoteContext.close();
    }
  }
}

/**
 * Executes Playwright code generated by AI
 */
export async function executePlaywrightCode(page, credentials, code) {
  console.log('[BROWSER] 🎭 Executing AI-generated Playwright code...');
  
  try {
    // Clean up the code to remove any problematic patterns
    let cleanedCode = code;
    
    // Remove markdown code blocks
    cleanedCode = cleanedCode.replace(/```javascript|```js|```/g, '').trim();
    
    // Remove any standalone return statements that might be outside functions
    cleanedCode = cleanedCode.replace(/^return\s+/gm, '');
    
    // Remove any function declarations that might be outside the main function
    cleanedCode = cleanedCode.replace(/^async\s+function\s+\w+.*?\{/gm, '');
    cleanedCode = cleanedCode.replace(/^function\s+\w+.*?\{/gm, '');
    
    // Remove any closing braces that might be orphaned
    cleanedCode = cleanedCode.replace(/^\s*\}\s*$/gm, '');
    
    // Clean up any extra whitespace
    cleanedCode = cleanedCode.trim();
    
    // Try to fix common syntax issues
    cleanedCode = fixCommonSyntaxIssues(cleanedCode);
    
    // If the code doesn't end with a return statement, add one
    if (!cleanedCode.includes('return') || !cleanedCode.trim().endsWith('}')) {
      cleanedCode += '\nreturn { success: true, message: "Login attempt completed", details: {} };';
    }
    
    // Wrap the code in a function that returns the result
    const wrappedCode = `
      async function executeLogin(page, credentials) {
        ${cleanedCode}
      }
      return await executeLogin(page, credentials);
    `;
    
    console.log('[BROWSER] 🔍 Generated code preview:', wrappedCode.substring(0, 300) + '...');
    console.log('[BROWSER] 🔍 Full generated code:', wrappedCode);
    
    // Validate the code before executing
    try {
      // Try to parse the code to check for syntax errors
      new Function(wrappedCode);
    } catch (syntaxError) {
      console.error('[BROWSER] ❌ Syntax error in generated code:', syntaxError.message);
      console.error('[BROWSER] 🔍 Problematic code:', wrappedCode);
      return {
        success: false,
        message: `Generated code has syntax error: ${syntaxError.message}`,
        details: { error: syntaxError.stack, code: wrappedCode }
      };
    }
    
    const result = await eval(wrappedCode);
    console.log('[BROWSER] ✅ Playwright code execution completed');
    return result;
  } catch (error) {
    console.error('[BROWSER] ❌ Error executing Playwright code:', error);
    console.error('[BROWSER] 🔍 Code that failed:', code.substring(0, 500) + '...');
    return {
      success: false,
      message: `Code execution failed: ${error.message}`,
      details: { error: error.stack }
    };
  }
}

/**
 * Fixes common syntax issues in AI-generated code
 */
function fixCommonSyntaxIssues(code) {
  let fixedCode = code;
  
  // Fix missing closing braces in if statements
  // Look for if statements that don't have proper closing braces
  const ifStatements = fixedCode.match(/if\s*\([^)]+\)\s*\{[^}]*$/gm);
  if (ifStatements) {
    ifStatements.forEach(ifStatement => {
      // Count opening and closing braces in the if statement
      const openBraces = (ifStatement.match(/\{/g) || []).length;
      const closeBraces = (ifStatement.match(/\}/g) || []).length;
      
      // If there are more opening braces than closing braces, add missing ones
      if (openBraces > closeBraces) {
        const missingBraces = openBraces - closeBraces;
        fixedCode += '\n' + '}'.repeat(missingBraces);
      }
    });
  }
  
  // Fix missing closing braces in while loops
  const whileLoops = fixedCode.match(/while\s*\([^)]+\)\s*\{[^}]*$/gm);
  if (whileLoops) {
    whileLoops.forEach(whileLoop => {
      const openBraces = (whileLoop.match(/\{/g) || []).length;
      const closeBraces = (whileLoop.match(/\}/g) || []).length;
      
      if (openBraces > closeBraces) {
        const missingBraces = openBraces - closeBraces;
        fixedCode += '\n' + '}'.repeat(missingBraces);
      }
    });
  }
  
  // Fix missing closing braces in try-catch blocks
  const tryBlocks = fixedCode.match(/try\s*\{[^}]*$/gm);
  if (tryBlocks) {
    tryBlocks.forEach(tryBlock => {
      const openBraces = (tryBlock.match(/\{/g) || []).length;
      const closeBraces = (tryBlock.match(/\}/g) || []).length;
      
      if (openBraces > closeBraces) {
        const missingBraces = openBraces - closeBraces;
        fixedCode += '\n' + '}'.repeat(missingBraces);
      }
    });
  }
  
  // Fix orphaned catch blocks
  fixedCode = fixedCode.replace(/^\s*catch\s*\([^)]+\)\s*\{/gm, '} catch ($1) {');
  
  // Fix orphaned return statements
  fixedCode = fixedCode.replace(/^\s*return\s+/gm, '');
  
  // Ensure proper brace matching
  const openBraces = (fixedCode.match(/\{/g) || []).length;
  const closeBraces = (fixedCode.match(/\}/g) || []).length;
  
  if (openBraces > closeBraces) {
    const missingBraces = openBraces - closeBraces;
    fixedCode += '\n' + '}'.repeat(missingBraces);
  }
  
  return fixedCode;
}

/**
 * Collects forms and inputs using Playwright before feeding to AI
 */
export async function collectFormsAndInputs(page) {
  console.log('[BROWSER] 🔍 Collecting forms and inputs using Playwright...');
  
  const maxRetries = 3;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[BROWSER] 🔄 Form collection attempt ${attempt}/${maxRetries}`);
      
      // Wait for page to be stable before collecting elements
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
      await page.waitForTimeout(1000); // Additional wait for dynamic content
      
      // Check if page is still valid
      if (page.isClosed()) {
        throw new Error('Page was closed during form collection');
      }
    
    // Collect all forms with their inputs and buttons
    const forms = await page.$$eval('form', forms => {
      // Define the purpose determination function within the evaluation context
      function determineFieldPurpose(input) {
        const type = input.type?.toLowerCase() || '';
        const name = input.name?.toLowerCase() || '';
        const id = input.id?.toLowerCase() || '';
        const placeholder = input.placeholder?.toLowerCase() || '';
        const className = input.className?.toLowerCase() || '';
        
        // Check for username/email fields
        if (type === 'email' || 
            name.includes('user') || name.includes('email') || name.includes('login') ||
            id.includes('user') || id.includes('email') || id.includes('login') ||
            placeholder.includes('user') || placeholder.includes('email') ||
            className.includes('user') || className.includes('email')) {
          return 'username';
        }
        
        // Check for password fields
        if (type === 'password' || 
            name.includes('pass') || name.includes('pwd') ||
            id.includes('pass') || id.includes('pwd') ||
            placeholder.includes('pass') ||
            className.includes('pass')) {
          return 'password';
        }
        
        // Check for other common field types
        if (type === 'tel' || name.includes('phone') || id.includes('phone')) return 'phone';
        if (type === 'url' || name.includes('url') || id.includes('url')) return 'url';
        if (type === 'number' || name.includes('age') || name.includes('count')) return 'number';
        if (type === 'date' || name.includes('date') || id.includes('date')) return 'date';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'file') return 'file';
        if (type === 'hidden') return 'hidden';
        
        return 'text';
      }
      
      return forms.map((form, index) => ({
        index,
        action: form.action || '',
        method: form.method || 'get',
        enctype: form.enctype || '',
        fields: Array.from(form.querySelectorAll('input, select, textarea')).map(input => ({
          type: input.type || input.tagName.toLowerCase(),
          name: input.name || '',
          id: input.id || '',
          placeholder: input.placeholder || '',
          required: input.required || false,
          value: input.value || '',
          className: input.className || '',
          autocomplete: input.autocomplete || '',
          purpose: determineFieldPurpose(input)
        })),
        buttons: Array.from(form.querySelectorAll('button, input[type="submit"], input[type="button"]')).map(button => ({
          text: button.textContent?.trim() || button.value || '',
          type: button.type || 'button',
          className: button.className || '',
          id: button.id || ''
        }))
      }));
    });

    // Collect standalone inputs outside of forms
    const standaloneInputs = await page.$$eval('input:not(form input), select:not(form select), textarea:not(form textarea)', inputs => {
      // Define the purpose determination function within the evaluation context
      function determineFieldPurpose(input) {
        const type = input.type?.toLowerCase() || '';
        const name = input.name?.toLowerCase() || '';
        const id = input.id?.toLowerCase() || '';
        const placeholder = input.placeholder?.toLowerCase() || '';
        const className = input.className?.toLowerCase() || '';
        
        // Check for username/email fields
        if (type === 'email' || 
            name.includes('user') || name.includes('email') || name.includes('login') ||
            id.includes('user') || id.includes('email') || id.includes('login') ||
            placeholder.includes('user') || placeholder.includes('email') ||
            className.includes('user') || className.includes('email')) {
          return 'username';
        }
        
        // Check for password fields
        if (type === 'password' || 
            name.includes('pass') || name.includes('pwd') ||
            id.includes('pass') || id.includes('pwd') ||
            placeholder.includes('pass') ||
            className.includes('pass')) {
          return 'password';
        }
        
        // Check for other common field types
        if (type === 'tel' || name.includes('phone') || id.includes('phone')) return 'phone';
        if (type === 'url' || name.includes('url') || id.includes('url')) return 'url';
        if (type === 'number' || name.includes('age') || name.includes('count')) return 'number';
        if (type === 'date' || name.includes('date') || id.includes('date')) return 'date';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'file') return 'file';
        if (type === 'hidden') return 'hidden';
        
        return 'text';
      }
      
      return inputs.map(input => ({
        type: input.type || input.tagName.toLowerCase(),
        name: input.name || '',
        id: input.id || '',
        placeholder: input.placeholder || '',
        required: input.required || false,
        value: input.value || '',
        className: input.className || '',
        autocomplete: input.autocomplete || '',
        purpose: determineFieldPurpose(input)
      }));
    });

    // Collect standalone buttons outside of forms
    const standaloneButtons = await page.$$eval('button:not(form button), input[type="submit"]:not(form input), input[type="button"]:not(form input)', buttons => buttons.map(button => ({
      text: button.textContent?.trim() || button.value || '',
      type: button.type || 'button',
      className: button.className || '',
      id: button.id || ''
    })));

    // Collect links that might be relevant for navigation
    const links = await page.$$eval('a[href]', links => links.map(link => ({
      text: link.textContent?.trim() || '',
      href: link.href || '',
      className: link.className || '',
      id: link.id || ''
    })));

    // Collect page metadata
    const pageMetadata = {
      url: page.url(),
      title: await page.title(),
      formsCount: forms.length,
      standaloneInputsCount: standaloneInputs.length,
      standaloneButtonsCount: standaloneButtons.length,
      linksCount: links.length,
      hasLoginForm: forms.some(form => 
        form.fields.some(field => 
          field.purpose === 'username' || field.purpose === 'email' || field.purpose === 'password'
        )
      )
    };

      console.log(`[BROWSER] ✅ Form collection complete. Found ${forms.length} forms, ${standaloneInputs.length} standalone inputs, ${standaloneButtons.length} standalone buttons, ${links.length} links`);
      
      // Check if no interactive elements were found - consider this a failure
      const totalInteractiveElements = forms.length + standaloneInputs.length + standaloneButtons.length + links.length;
      if (totalInteractiveElements === 0) {
        console.log('[BROWSER] ❌ No forms, inputs, buttons, or links found - considering this a failure');
        return {
          forms,
          standaloneInputs,
          standaloneButtons,
          links,
          pageMetadata: {
            ...pageMetadata,
            hasInteractiveElements: false,
            failureReason: 'No forms, inputs, buttons, or links found on page'
          },
          collectedAt: new Date().toISOString(),
          isFailure: true,
          failureMessage: 'No interactive elements (forms, inputs, buttons, or links) found on the page'
        };
      }
      
      return {
        forms,
        standaloneInputs,
        standaloneButtons,
        links,
        pageMetadata: {
          ...pageMetadata,
          hasInteractiveElements: true,
          totalInteractiveElements
        },
        collectedAt: new Date().toISOString(),
        isFailure: false
      };
      
    } catch (error) {
      lastError = error;
      console.log(`[BROWSER] ⚠️ Form collection attempt ${attempt} failed:`, error.message);
      
      if (attempt < maxRetries) {
        console.log(`[BROWSER] 🔄 Retrying form collection in 2 seconds...`);
        await page.waitForTimeout(2000);
      }
    }
  }
  
  // If all retries failed, return error
  console.error('[BROWSER] ❌ All form collection attempts failed:', lastError);
  
  // Try to get basic page info even if collection failed
  let pageMetadata = {
    url: 'unknown',
    title: 'unknown',
    formsCount: 0,
    standaloneInputsCount: 0,
    standaloneButtonsCount: 0,
    linksCount: 0,
    hasLoginForm: false
  };
  
  try {
    if (!page.isClosed()) {
      pageMetadata.url = page.url();
      pageMetadata.title = await page.title();
    }
  } catch (metaError) {
    console.log('[BROWSER] ⚠️ Could not get page metadata:', metaError.message);
  }
  
  return {
    forms: [],
    standaloneInputs: [],
    standaloneButtons: [],
    links: [],
    pageMetadata,
    collectedAt: new Date().toISOString(),
    error: lastError.message,
    isFailure: true,
    failureMessage: `Error collecting page elements: ${lastError.message}`
  };
}


/**
 * Performs fallback form analysis when AI fails
 */
export async function performFallbackFormAnalysis(page) {
  console.log('[BROWSER] 🔍 Performing fallback form analysis...');
  
  try {
    const forms = await page.$$eval('form', forms => forms.map((form, index) => ({
      index,
      action: form.action || '',
      method: form.method || 'get',
      fields: Array.from(form.querySelectorAll('input')).map(input => ({
        type: input.type || 'text',
        name: input.name || '',
        id: input.id || '',
        placeholder: input.placeholder || '',
        required: input.required || false
      })),
      buttons: Array.from(form.querySelectorAll('button, input[type="submit"]')).map(button => ({
        text: button.textContent?.trim() || button.value || '',
        type: button.type || 'button'
      }))
    })));

    // Also look for inputs outside of forms
    const standaloneInputs = await page.$$eval('input:not(form input)', inputs => inputs.map(input => ({
      type: input.type || 'text',
      name: input.name || '',
      id: input.id || '',
      placeholder: input.placeholder || '',
      required: input.required || false
    })));

    const standaloneButtons = await page.$$eval('button:not(form button), input[type="submit"]:not(form input)', buttons => buttons.map(button => ({
      text: button.textContent?.trim() || button.value || '',
      type: button.type || 'button'
    })));

    console.log(`[BROWSER] ✅ Fallback analysis complete. Found ${forms.length} forms, ${standaloneInputs.length} standalone inputs, ${standaloneButtons.length} standalone buttons`);
    
    return {
      forms,
      standaloneInputs,
      standaloneButtons,
      recommended_approach: 'Use first form with username/password inputs',
      potential_issues: ['Limited analysis without AI'],
      confidence_score: 0.6
    };
  } catch (error) {
    console.error('[BROWSER] ❌ Error in fallback form analysis:', error);
    return {
      forms: [],
      standaloneInputs: [],
      standaloneButtons: [],
      recommended_approach: 'Manual inspection required',
      potential_issues: ['Form analysis failed'],
      confidence_score: 0.1
    };
  }
}

/**
 * Tests a specific action on the page
 */
export async function testAction(page, action, credentials, actionIndex) {
  console.log(`[BROWSER] 🧪 Testing action ${actionIndex}: ${action.description}`);
  
  try {
    // Fill username field
    if (action.fieldMapping.usernameField) {
      const usernameSelector = action.fieldMapping.usernameField.name 
        ? `[name="${action.fieldMapping.usernameField.name}"]`
        : `#${action.fieldMapping.usernameField.id}`;
      
      await page.waitForSelector(usernameSelector, { timeout: 5000 });
      await page.fill(usernameSelector, credentials.username);
      console.log(`[BROWSER] ✅ Filled username field: ${usernameSelector}`);
    }

    // Fill password field
    if (action.fieldMapping.passwordField) {
      const passwordSelector = action.fieldMapping.passwordField.name 
        ? `[name="${action.fieldMapping.passwordField.name}"]`
        : `#${action.fieldMapping.passwordField.id}`;
      
      await page.waitForSelector(passwordSelector, { timeout: 5000 });
      await page.fill(passwordSelector, credentials.password);
      console.log(`[BROWSER] ✅ Filled password field: ${passwordSelector}`);
    }

    // Click submit button
    const buttonSelector = action.button.text 
      ? `button:has-text("${action.button.text}")`
      : action.button.type === 'submit' 
        ? 'input[type="submit"]'
        : 'button';
    
    await page.waitForSelector(buttonSelector, { timeout: 5000 });
    await page.click(buttonSelector);
    console.log(`[BROWSER] ✅ Clicked button: ${buttonSelector}`);

    // Wait for navigation or form submission
    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch (error) {
      console.log('[BROWSER] ⚠️ Navigation timeout, continuing...');
    }

    const currentUrl = page.url();
    const currentTitle = await page.title();
    
    console.log(`[BROWSER] ✅ Action ${actionIndex} completed. URL: ${currentUrl}, Title: ${currentTitle}`);
    
    return {
      success: true,
      message: `Action ${actionIndex} executed successfully`,
      details: {
        action: action.description,
        finalUrl: currentUrl,
        finalTitle: currentTitle,
        urlChanged: currentUrl !== page.url()
      }
    };
  } catch (error) {
    console.error(`[BROWSER] ❌ Action ${actionIndex} failed:`, error);
    return {
      success: false,
      message: `Action ${actionIndex} failed: ${error.message}`,
      details: {
        action: action.description,
        error: error.stack
      }
    };
  }
}
