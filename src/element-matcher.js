/**
 * ElementMatcher
 * Utility for robust element matching using multiple selector strategies
 * 
 * Problem: IDs and selectors may change between test runs
 * Solution: Try multiple selector strategies in order of reliability
 */

export class ElementMatcher {
  constructor(page) {
    this.page = page;
  }

  /**
   * Find an element using multiple selector strategies
   * @param {Array} selectors - Array of selector objects with {strategy, selector, priority, stability}
   * @param {Object} options - Options for matching
   * @returns {Object|null} - Found element or null
   */
  async findElement(selectors, options = {}) {
    if (!Array.isArray(selectors) || selectors.length === 0) {
      console.warn('[ElementMatcher] No selectors provided');
      return null;
    }

    // Try selectors in priority order (lower priority number = higher priority)
    const sortedSelectors = [...selectors].sort((a, b) => a.priority - b.priority);

    for (const selectorInfo of sortedSelectors) {
      try {
        const element = await this.findElementBySelector(selectorInfo, options);
        if (element) {
          console.log(`[ElementMatcher] ✅ Found element using ${selectorInfo.strategy} strategy: ${selectorInfo.selector}`);
          return element;
        }
      } catch (error) {
        console.log(`[ElementMatcher] ❌ ${selectorInfo.strategy} strategy failed: ${error.message}`);
      }
    }

    console.warn('[ElementMatcher] All selector strategies failed');
    return null;
  }

  /**
   * Find element using a single selector strategy
   */
  async findElementBySelector(selectorInfo, options = {}) {
    const { selector, strategy } = selectorInfo;
    const timeout = options.timeout || 5000;

    try {
      switch (strategy) {
        case 'id':
          return await this.page.$(`${selector}`, { timeout });

        case 'name':
        case 'type':
        case 'placeholder':
        case 'role':
          // CSS selector
          return await this.page.$(selector, { timeout });

        case 'text':
          // XPath or text content matching
          return await this.findElementByText(selectorInfo, timeout);

        case 'class':
          return await this.page.$(selector, { timeout });

        case 'tag':
          // Try to find the tag in context
          const elements = await this.page.$$(selector);
          if (elements.length > 0) {
            console.log(`[ElementMatcher] Found ${elements.length} elements with tag ${selector}, using first one`);
            return elements[0];
          }
          return null;

        default:
          console.warn(`[ElementMatcher] Unknown selector strategy: ${strategy}`);
          return await this.page.$(selector, { timeout });
      }
    } catch (error) {
      return null;
    }
  }

  /**
   * Find element by text content
   */
  async findElementByText(selectorInfo, timeout) {
    const text = selectorInfo.text_content || selectorInfo.selector.match(/text="([^"]+)"/)?.[1];
    
    if (!text) {
      return null;
    }

    // Try XPath approach
    const xpath = `//*[contains(text(), '${text}')]`;
    try {
      const elements = await this.page.$$(`xpath=${xpath}`);
      return elements.length > 0 ? elements[0] : null;
    } catch (error) {
      // Fallback: evaluate in browser context
      return await this.page.evaluate((searchText) => {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          null,
          false
        );

        let node;
        while (node = walker.nextNode()) {
          if (node.textContent.includes(searchText)) {
            return node.parentElement;
          }
        }
        return null;
      }, text);
    }
  }

  /**
   * Get element info for storage in workflow
   * This extracts all selectors and metadata for robust matching later
   */
  static async getElementInfo(element) {
    const info = {
      selectors: [],
      attributes: {},
      metadata: {}
    };

    try {
      // Get all selector strategies
      const id = await element.getAttribute('id');
      const name = await element.getAttribute('name');
      const type = await element.getAttribute('type');
      const role = await element.getAttribute('role');
      const placeholder = await element.getAttribute('placeholder');
      const className = await element.getAttribute('class');
      const text = await element.textContent();

      // Build selector strategies array
      if (id) {
        info.selectors.push({
          strategy: 'id',
          selector: `#${id}`,
          priority: 1,
          stability: 'high',
          value: id
        });
      }

      if (name) {
        const tagName = await element.evaluate(el => el.tagName.toLowerCase());
        info.selectors.push({
          strategy: 'name',
          selector: `${tagName}[name="${name}"]`,
          priority: 2,
          stability: 'high',
          value: name
        });
      }

      if (type) {
        const tagName = await element.evaluate(el => el.tagName.toLowerCase());
        info.selectors.push({
          strategy: 'type',
          selector: `${tagName}[type="${type}"]`,
          priority: 3,
          stability: 'medium',
          value: type
        });
      }

      if (role) {
        info.selectors.push({
          strategy: 'role',
          selector: `[role="${role}"]`,
          priority: 5,
          stability: 'medium',
          value: role
        });
      }

      if (placeholder) {
        const tagName = await element.evaluate(el => el.tagName.toLowerCase());
        info.selectors.push({
          strategy: 'placeholder',
          selector: `${tagName}[placeholder="${placeholder}"]`,
          priority: 6,
          stability: 'low',
          value: placeholder
        });
      }

      if (text && text.trim()) {
        info.selectors.push({
          strategy: 'text',
          selector: `text="${text.trim().substring(0, 50)}"`,
          priority: 4,
          stability: 'medium',
          text_content: text.trim()
        });
      }

      // Store attributes for additional matching context
      info.attributes = {
        id,
        name,
        type,
        role,
        placeholder,
        className: className ? className.split(/\s+/).filter(c => c) : [],
        text: text?.trim()
      };

      // Store metadata
      const tagName = await element.evaluate(el => el.tagName.toLowerCase());
      info.metadata = {
        tagName,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('[ElementMatcher] Error getting element info:', error);
    }

    return info;
  }

  /**
   * Create a Playwright selector from element info
   * This generates a robust selector that can be used in future runs
   */
  static createSelectorFromInfo(elementInfo) {
    if (!elementInfo.selectors || elementInfo.selectors.length === 0) {
      return null;
    }

    // Return the highest priority selector
    const sortedSelectors = [...elementInfo.selectors].sort((a, b) => a.priority - b.priority);
    return sortedSelectors[0].selector;
  }
}

export default ElementMatcher;
