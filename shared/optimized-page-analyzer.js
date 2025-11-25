/**
 * Optimized Page Analyzer - Collects minimal, focused data for AI analysis
 * Reduces token usage by 90%+ while maintaining QA testing capabilities
 */

import { AIConversationLogger } from './ai-conversation-logger.js';

export class OptimizedPageAnalyzer {
  constructor(backendUrl = null) {
    this.aiLogger = new AIConversationLogger(backendUrl);
    this.backendUrl = backendUrl || process.env.BACKEND_URL || 'http://back:4000';
  }

  /**
   * Extract only visible text content from page (no HTML, CSS, scripts)
   */
  async extractVisibleText(page, maxLength = 2000) {
    return await page.evaluate((maxLen) => {
      // Remove all non-visible elements
      const scripts = document.querySelectorAll('script, style, noscript, meta, link[rel="stylesheet"], head');
      scripts.forEach(el => el.remove());
      
      // Get visible text content
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: function(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            
            const style = window.getComputedStyle(parent);
            
            // Skip hidden elements
            if (style.display === 'none' || style.visibility === 'hidden' || 
                style.opacity === '0' || parent.offsetHeight === 0 ||
                parent.offsetWidth === 0) {
              return NodeFilter.FILTER_REJECT;
            }
            
            // Skip empty or whitespace-only text
            const text = node.textContent?.trim();
            if (!text || text.length < 2) {
              return NodeFilter.FILTER_REJECT;
            }
            
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );
      
      const textNodes = [];
      let node;
      while (node = walker.nextNode()) {
        textNodes.push(node.textContent.trim());
      }
      
      const fullText = textNodes.join(' ').replace(/\s+/g, ' ').trim();
      return fullText.substring(0, maxLen) + (fullText.length > maxLen ? '...' : '');
    }, maxLength);
  }

  /**
   * Extract optimized interactive elements analysis
   */
  async extractInteractiveElements(page) {
    return await page.evaluate(() => {
      const result = {
        forms: [],
        buttons: [],
        links: [],
        inputs: [],
        interactive_count: 0
      };
      
      // Extract forms (only visible ones)
      const forms = document.querySelectorAll('form:not([style*="display: none"]):not([hidden])');
      forms.forEach((form, index) => {
        const inputs = Array.from(form.querySelectorAll('input, textarea, select')).filter(el => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetHeight > 0;
        });
        
        if (inputs.length > 0) {
          result.forms.push({
            id: form.id || `form_${index}`,
            selector: form.id ? `#${form.id}` : `form:nth-of-type(${index + 1})`,
            action: form.action || '',
            method: form.method || 'GET',
            field_count: inputs.length,
            fields: inputs.map(input => ({
              type: input.type || 'text',
              name: input.name || '',
              id: input.id || '',
              placeholder: input.placeholder || '',
              required: input.required || false
            }))
          });
        }
      });
      
      // Extract interactive elements
      const interactive = document.querySelectorAll('button, input[type="button"], input[type="submit"], a[href], [onclick], [role="button"]');
      interactive.forEach((el, index) => {
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden' && el.offsetHeight > 0) {
          const elementData = {
            id: el.id || `element_${index}`,
            tag: el.tagName.toLowerCase(),
            text: el.textContent?.trim().substring(0, 50) || '',
            selector: el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}:nth-of-type(${index + 1})`,
            type: el.type || 'clickable',
            href: el.href || ''
          };
          
          if (el.tagName === 'A') {
            result.links.push(elementData);
          } else if (el.tagName === 'BUTTON' || el.type === 'button' || el.type === 'submit') {
            result.buttons.push(elementData);
          } else if (el.tagName === 'INPUT') {
            result.inputs.push(elementData);
          }
        }
      });
      
      result.interactive_count = result.forms.length + result.buttons.length + result.links.length + result.inputs.length;
      return result;
    });
  }

  /**
   * Extract AX tree for accessibility analysis
   */
  async extractAXTree(page) {
    try {
      // Use Chrome DevTools Protocol to get accessibility tree
      const cdpSession = await page.context().newCDPSession(page);
      const { root } = await cdpSession.send('Accessibility.getFullAXTree');
      
      // Simplify the AX tree to essential information
      const simplifiedTree = this.simplifyAXTree(root);
      await cdpSession.detach();
      
      return simplifiedTree;
    } catch (error) {
      console.warn('[OptimizedPageAnalyzer] Failed to extract AX tree:', error.message);
      return { error: error.message, tree: null };
    }
  }

  /**
   * Simplify AX tree to reduce size
   */
  simplifyAXTree(node, depth = 0) {
    if (depth > 3) return null; // Limit depth to reduce size
    
    const simplified = {
      role: node.role?.value || 'unknown',
      name: node.name?.value || '',
      description: node.description?.value || '',
      children: []
    };
    
    if (node.children && depth < 3) {
      simplified.children = node.children
        .map(child => this.simplifyAXTree(child, depth + 1))
        .filter(child => child !== null);
    }
    
    return simplified;
  }

  /**
   * Extract DOM snapshot for structural analysis
   */
  async extractDOMSnapshot(page) {
    return await page.evaluate(() => {
      const snapshot = {
        title: document.title,
        url: window.location.href,
        structure: {
          total_elements: document.querySelectorAll('*').length,
          forms_count: document.querySelectorAll('form').length,
          buttons_count: document.querySelectorAll('button, input[type="button"], input[type="submit"]').length,
          links_count: document.querySelectorAll('a[href]').length,
          inputs_count: document.querySelectorAll('input, textarea, select').length
        },
        meta: {
          viewport: document.querySelector('meta[name="viewport"]')?.content || '',
          description: document.querySelector('meta[name="description"]')?.content || '',
          keywords: document.querySelector('meta[name="keywords"]')?.content || ''
        }
      };
      
      return snapshot;
    });
  }

  /**
   * Generate page description using AI (minimal token usage)
   */
  async generatePageDescription(page, jobId, pageUrl) {
    try {
      const visibleText = await this.extractVisibleText(page, 1000);
      const pageTitle = await page.title();
      
      const descriptionPayload = {
        page_title: pageTitle,
        page_url: pageUrl,
        visible_text: visibleText
      };
      
      const description = await this.aiLogger.makeAICallWithPrompt(
        'generate-page-description',
        descriptionPayload,
        jobId,
        'page-descriptor',
        pageUrl,
        null,
        descriptionPayload
      );
      
      return {
        short_description: description.short_description || `Page: ${pageTitle}`,
        full_description: description.full_description || visibleText.substring(0, 200),
        purpose: description.purpose || 'Information page',
        conversation_context: description.conversation_context || `Analyzing page structure and content`
      };
    } catch (error) {
      console.warn('[OptimizedPageAnalyzer] Failed to generate page description:', error.message);
      const pageTitle = await page.title();
      return {
        short_description: `Page: ${pageTitle}`,
        full_description: `Page at ${pageUrl}`,
        purpose: 'Information page',
        conversation_context: `Analyzing page structure and content`
      };
    }
  }

  /**
   * Collect all optimized page data
   */
  async collectPageData(page, jobId, pageUrl, includeAX = true, includeDOM = true) {
    const startTime = Date.now();
    
    console.log(`[OptimizedPageAnalyzer] 📊 Collecting optimized page data for ${pageUrl}`);
    
    const [visibleText, interactiveElements, pageDescription] = await Promise.all([
      this.extractVisibleText(page, 2000),
      this.extractInteractiveElements(page),
      this.generatePageDescription(page, jobId, pageUrl)
    ]);
    
    const data = {
      page_url: pageUrl,
      page_title: await page.title(),
      timestamp: new Date().toISOString(),
      collection_time_ms: Date.now() - startTime,
      visible_text: visibleText,
      interactive_elements: interactiveElements,
      page_description: pageDescription
    };
    
    // Add optional data if requested
    if (includeAX) {
      data.ax_tree = await this.extractAXTree(page);
    }
    
    if (includeDOM) {
      data.dom_snapshot = await this.extractDOMSnapshot(page);
    }
    
    console.log(`[OptimizedPageAnalyzer] ✅ Collected data in ${data.collection_time_ms}ms`);
    console.log(`[OptimizedPageAnalyzer] 📊 Data sizes: visible_text=${visibleText.length}, interactive=${JSON.stringify(interactiveElements).length}`);
    
    return data;
  }

  /**
   * Create optimized payload for OpenAI (minimal token usage)
   */
  createOptimizedPayload(pageData, conversationHistory = []) {
    return {
      page_url: pageData.page_url,
      page_title: pageData.page_title,
      interactive_elements: pageData.interactive_elements,
      visible_text_preview: pageData.visible_text.substring(0, 500),
      conversation_history: conversationHistory.slice(-3), // Only last 3 conversations
      page_description: pageData.page_description
    };
  }

  /**
   * Send page data to backend for storage
   */
  async sendPageDataToBackend(jobId, pageData) {
    try {
      const response = await fetch(`${this.backendUrl}/api/pages/analyzed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: jobId,
          page_data: pageData
        })
      });
      
      if (response.ok) {
        console.log(`[OptimizedPageAnalyzer] ✅ Page data sent to backend`);
      } else {
        console.warn(`[OptimizedPageAnalyzer] ⚠️ Failed to send page data: ${response.status}`);
      }
    } catch (error) {
      console.error(`[OptimizedPageAnalyzer] ❌ Error sending page data: ${error.message}`);
    }
  }
}

export default OptimizedPageAnalyzer;


