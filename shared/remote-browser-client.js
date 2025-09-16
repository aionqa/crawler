/**
 * Remote Browser Client
 * Connects to remote browser instances managed by the backend
 */

export class RemoteBrowserClient {
  constructor(browserServiceUrl) {
    this.browserServiceUrl = browserServiceUrl;
    this.activeContexts = new Map();
  }

  /**
   * Create a new remote browser context
   */
  async createContext(options = {}) {
    try {
      const response = await fetch(`${this.browserServiceUrl}/browser/context`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          viewport: options.viewport || { width: 1280, height: 720 },
          cookies: options.cookies || [],
          userAgent: options.userAgent,
          metadata: {
            jobId: options.jobId,
            projectId: options.projectId,
            agentType: options.agentType,
            ...options.metadata
          },
          ...options
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to create browser context: ${response.status}`);
      }

      const contextData = await response.json();
      const contextId = contextData.contextId;
      
      this.activeContexts.set(contextId, {
        contextId,
        createdAt: new Date(),
        options,
        metadata: contextData.metadata || {}
      });

      console.log(`[REMOTE-BROWSER] ✅ Created context ${contextId} for job ${options.jobId || 'unknown'}`);

      return {
        contextId,
        page: new RemotePage(this.browserServiceUrl, contextId),
        context: new RemoteContext(this.browserServiceUrl, contextId)
      };
    } catch (error) {
      console.error('[REMOTE-BROWSER] ❌ Error creating context:', error);
      throw error;
    }
  }

  /**
   * Close a browser context
   */
  async closeContext(contextId) {
    try {
      const response = await fetch(`${this.browserServiceUrl}/browser/context/${contextId}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error(`Failed to close browser context: ${response.status}`);
      }

      this.activeContexts.delete(contextId);
      return true;
    } catch (error) {
      console.error('[REMOTE-BROWSER] ❌ Error closing context:', error);
      throw error;
    }
  }

  /**
   * Get active contexts
   */
  getActiveContexts() {
    return Array.from(this.activeContexts.values());
  }

  /**
   * Close all contexts
   */
  async closeAll() {
    const promises = Array.from(this.activeContexts.keys()).map(contextId => 
      this.closeContext(contextId)
    );
    await Promise.all(promises);
  }
}

/**
 * Remote Page - proxy for page operations
 */
class RemotePage {
  constructor(browserServiceUrl, contextId) {
    this.browserServiceUrl = browserServiceUrl;
    this.contextId = contextId;
  }

  async goto(url, options = {}) {
    const response = await fetch(`${this.browserServiceUrl}/browser/context/${this.contextId}/page/goto`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url, ...options })
    });

    if (!response.ok) {
      throw new Error(`Failed to navigate to ${url}: ${response.status}`);
    }

    return await response.json();
  }

  async screenshot(options = {}) {
    const response = await fetch(`${this.browserServiceUrl}/browser/context/${this.contextId}/page/screenshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(options)
    });

    if (!response.ok) {
      throw new Error(`Failed to take screenshot: ${response.status}`);
    }

    const result = await response.json();
    return Buffer.from(result.data, 'base64');
  }

  async fill(selector, value) {
    const response = await fetch(`${this.browserServiceUrl}/browser/context/${this.contextId}/page/fill`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ selector, value })
    });

    if (!response.ok) {
      throw new Error(`Failed to fill ${selector}: ${response.status}`);
    }

    return await response.json();
  }

  async click(selector, options = {}) {
    const response = await fetch(`${this.browserServiceUrl}/browser/context/${this.contextId}/page/click`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ selector, ...options })
    });

    if (!response.ok) {
      throw new Error(`Failed to click ${selector}: ${response.status}`);
    }

    return await response.json();
  }

  async waitForSelector(selector, options = {}) {
    const response = await fetch(`${this.browserServiceUrl}/browser/context/${this.contextId}/page/wait-for-selector`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ selector, ...options })
    });

    if (!response.ok) {
      throw new Error(`Failed to wait for selector ${selector}: ${response.status}`);
    }

    return await response.json();
  }

  async waitForLoadState(state = 'load', options = {}) {
    const response = await fetch(`${this.browserServiceUrl}/browser/context/${this.contextId}/page/wait-for-load-state`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ state, ...options })
    });

    if (!response.ok) {
      throw new Error(`Failed to wait for load state ${state}: ${response.status}`);
    }

    return await response.json();
  }

  async url() {
    const response = await fetch(`${this.browserServiceUrl}/browser/context/${this.contextId}/page/url`);
    
    if (!response.ok) {
      throw new Error(`Failed to get URL: ${response.status}`);
    }

    const result = await response.json();
    return result.url;
  }

  async title() {
    const response = await fetch(`${this.browserServiceUrl}/browser/context/${this.contextId}/page/title`);
    
    if (!response.ok) {
      throw new Error(`Failed to get title: ${response.status}`);
    }

    const result = await response.json();
    return result.title;
  }

  async evaluate(fn, ...args) {
    const response = await fetch(`${this.browserServiceUrl}/browser/context/${this.contextId}/page/evaluate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        function: fn.toString(), 
        args 
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to evaluate function: ${response.status}`);
    }

    return await response.json();
  }

  async $$eval(selector, fn, ...args) {
    const response = await fetch(`${this.browserServiceUrl}/browser/context/${this.contextId}/page/$$eval`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        selector,
        function: fn.toString(), 
        args 
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to evaluate selector ${selector}: ${response.status}`);
    }

    return await response.json();
  }

  // Event handling
  on(event, handler) {
    // Remote browsers handle events on the server side
    // This is a placeholder for compatibility
    console.log(`[REMOTE-PAGE] Event listener registered for ${event}`);
  }

  // Video recording (placeholder - not supported in remote browsers yet)
  video() {
    return {
      saveAs: async (path) => {
        console.log(`[REMOTE-PAGE] Video recording not supported in remote browsers yet`);
        return null;
      }
    };
  }
}

/**
 * Remote Context - proxy for context operations
 */
class RemoteContext {
  constructor(browserServiceUrl, contextId) {
    this.browserServiceUrl = browserServiceUrl;
    this.contextId = contextId;
  }

  async newPage() {
    const response = await fetch(`${this.browserServiceUrl}/browser/context/${this.contextId}/new-page`, {
      method: 'POST'
    });

    if (!response.ok) {
      throw new Error(`Failed to create new page: ${response.status}`);
    }

    const result = await response.json();
    return new RemotePage(this.browserServiceUrl, this.contextId);
  }

  async addCookies(cookies) {
    const response = await fetch(`${this.browserServiceUrl}/browser/context/${this.contextId}/cookies`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ cookies })
    });

    if (!response.ok) {
      throw new Error(`Failed to add cookies: ${response.status}`);
    }

    return await response.json();
  }

  async cookies() {
    const response = await fetch(`${this.browserServiceUrl}/browser/context/${this.contextId}/cookies`);
    
    if (!response.ok) {
      throw new Error(`Failed to get cookies: ${response.status}`);
    }

    const result = await response.json();
    return result.cookies;
  }
}

/**
 * Create a remote browser context (convenience function)
 */
export async function createRemoteBrowserContext(browserServiceUrl, options = {}) {
  const client = new RemoteBrowserClient(browserServiceUrl);
  return await client.createContext(options);
}

export default RemoteBrowserClient;
