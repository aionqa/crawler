/**
 * Login operations for unified crawler
 * Simplified version for testing
 */

import gelfClient from '/app/shared/gelf-client.js';

/**
 * Sends a log message
 */
async function sendLog(jobId, level, message, data = {}) {
  // Send to Graylog via GELF
  await gelfClient.sendJobLog(jobId, level, message, 'unified-crawler', data);
}

/**
 * Performs the main login attempt with AI-driven approach
 */
export async function performInitialLogin(page, credentials, openaiClient, context = {}) {
  const jobId = context.job_id || 'unknown-job';
  await sendLog(jobId, 'info', '🚀 Starting AI-driven login process...');
  
  try {
    // Simplified login implementation for testing
    const htmlContent = await page.content();
    const currentUrl = page.url();
    const currentTitle = await page.title();
    
    // Look for common login form elements
    const usernameField = await page.$('input[name="username"], input[name="user"], input[name="email"], input[type="email"]');
    const passwordField = await page.$('input[name="password"], input[type="password"]');
    const submitButton = await page.$('button[type="submit"], input[type="submit"]');
    
    if (!usernameField || !passwordField) {
      return {
        success: false,
        message: 'Could not find username or password fields',
        details: {
          usernameFieldFound: !!usernameField,
          passwordFieldFound: !!passwordField,
          submitButtonFound: !!submitButton
        }
      };
    }
    
    // Fill the form
    await usernameField.fill(credentials.username);
    await passwordField.fill(credentials.password);
    
    if (submitButton) {
      await submitButton.click();
    } else {
      // Try pressing Enter on password field
      await passwordField.press('Enter');
    }
    
    // Wait for navigation or response
    await page.waitForTimeout(3000);
    
    return {
      success: true,
      message: 'Login form submitted successfully',
      details: {
        usernameFieldFound: true,
        passwordFieldFound: true,
        submitButtonFound: !!submitButton,
        finalUrl: page.url(),
        finalTitle: await page.title()
      }
    };
    
  } catch (error) {
    return {
      success: false,
      message: `Login failed: ${error.message}`,
      details: {
        error: error.stack
      }
    };
  }
}

/**
 * Simplified fallback form analysis
 */
export async function performFallbackFormAnalysis(page) {
  try {
    // Simple fallback analysis
    const forms = await page.$$('form');
    const inputs = await page.$$('input');
    
    return {
      forms: forms.map((form, index) => ({
        index,
        action: await form.getAttribute('action') || '',
        method: await form.getAttribute('method') || 'get',
        inputs: []
      })),
      standaloneInputs: inputs.map((input, index) => ({
        index,
        type: await input.getAttribute('type') || 'text',
        name: await input.getAttribute('name') || '',
        id: await input.getAttribute('id') || ''
      })),
      confidence_score: 0.5
    };
  } catch (error) {
    return {
      forms: [],
      standaloneInputs: [],
      confidence_score: 0.0,
      error: error.message
    };
  }
}