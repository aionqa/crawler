import axios from 'axios';
import { StaticNodeExecutor } from './static-node-executor.js';
import { appendRequirementToTemplate, getRequirementTextForNextStep } from './step-requirements.js';

/**
 * WorkflowAnalyzer - Updated 2025-10-15
 * Handles initial page analysis using Playwright + OpenAI
 * Creates workflow structure with testable legs
 */
class WorkflowAnalyzer {
  constructor(backendUrl, aiLogger, context = {}) {
    this.backendUrl = backendUrl;
    this.aiLogger = aiLogger;
    this.context = context;
    this.workflowTemplate = null;
    this.workflowCapabilities = this.detectCapabilities([]);
  }

  /**
   * Load workflow template from backend
   */
  async loadWorkflowTemplate() {
    console.log(`[WorkflowAnalyzer] 🔍 Context received:`, JSON.stringify(this.context, null, 2));
    if (!this.context.workflow_template_id) {
      console.error(`[WorkflowAnalyzer] ❌ No workflow template ID provided - workflows are mandatory!`);
      console.error(`[WorkflowAnalyzer] ❌ Context keys:`, Object.keys(this.context));
      throw new Error('workflow_template_id is required - all jobs must use workflows stored in MongoDB');
    }

    try {
      if (this.workflowTemplate && (this.workflowTemplate._id?.toString() === this.context.workflow_template_id)) {
        return this.workflowTemplate;
      }

      const response = await axios.get(`${this.backendUrl}/api/workflow-templates/${this.context.workflow_template_id}`, {
        headers: this.getAuthHeaders()
      });
      this.workflowTemplate = response.data;
      console.log(`[WorkflowAnalyzer] ✅ Loaded workflow: "${this.workflowTemplate.name}" (ID: ${this.context.workflow_template_id})`);
      console.log(`[WorkflowAnalyzer] 📄 Workflow contains ${this.workflowTemplate.prompts?.length || 0} prompts`);
      
      // Log workflow usage
      if (this.workflowTemplate.prompts && this.workflowTemplate.prompts.length > 0) {
        console.log(`[WorkflowAnalyzer] 📝 Custom prompts in template:`);
        this.workflowTemplate.prompts.forEach(p => {
          console.log(`[WorkflowAnalyzer]    - ${p.name}: ${p.template?.substring(0, 80)}...`);
        });
      }
      
      await this.logWorkflowDecision(
        `Using workflow: "${this.workflowTemplate.name}" (ID: ${this.context.workflow_template_id})`,
        `Workflow contains ${this.workflowTemplate.prompts?.length || 0} prompts`
      );

      this.workflowCapabilities = this.detectCapabilities(this.workflowTemplate.steps || []);
      console.log(`[WorkflowAnalyzer] ⚙️ Workflow capabilities:`, JSON.stringify(this.workflowCapabilities));
      
      return this.workflowTemplate;
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Failed to load workflow template: ${error.message}`);
      throw new Error(`Failed to load workflow template ${this.context.workflow_template_id}: ${error.message}`);
    }
  }

  /**
   * Get timeout for a workflow step (in milliseconds)
   * Returns step-specific timeout or default based on step type
   * Range: 1 minute (60000ms) to 10 minutes (600000ms)
   */
  getStepTimeout(step) {
    // If step has explicit timeout config, use it (clamped to 1m-10m range)
    if (step.config?.timeout_ms !== undefined) {
      const timeout = Math.max(60000, Math.min(600000, step.config.timeout_ms));
      return timeout;
    }
    if (step.config?.timeout !== undefined) {
      const timeout = Math.max(60000, Math.min(600000, step.config.timeout));
      return timeout;
    }

    // Default timeouts by step type (in milliseconds)
    const defaultTimeouts = {
      'ai-prompt': 180000,           // 3 minutes - AI calls can take time
      'workflow-analysis': 180000,   // 3 minutes - Complex analysis
      'page-description': 120000,    // 2 minutes - Page analysis
      'playwright-analysis': 120000, // 2 minutes - Playwright analysis
      'execute-code': 120000,        // 2 minutes - Code execution
      'execute-code-from-variable': 120000, // 2 minutes
      'while-loop': 60000,           // 1 minute - Loops timeout quickly
      'for-each': 60000,             // 1 minute - Iterations timeout quickly
      'self-adjustable-ai-workflow': 240000, // 4 minutes - Complex workflow
      'screenshot': 60000,           // 1 minute - Quick operation
      'cookie-collect': 60000,       // 1 minute - Quick operation
      'validate-login': 60000,      // 1 minute - Quick validation
      'var-export': 60000,           // 1 minute - Quick operation
      'var-dump': 60000,            // 1 minute - Quick operation
      'print': 30000,               // 30 seconds - Very quick
      'sleep': 60000,               // 1 minute - Sleep operations
      'page-discovery': 180000,     // 3 minutes - Discovery can take time
      'sitemap-exploration': 240000, // 4 minutes - Sitemap exploration
      'unlighthouse': 300000,       // 5 minutes - Performance audit
      'save-data': 120000,          // 2 minutes - Data saving
      'create-workflow': 120000,    // 2 minutes
      'update-workflow': 120000,    // 2 minutes
      'hardcoded-workflow-analysis': 120000, // 2 minutes
    };

    const stepType = step.type || 'ai-prompt';
    return defaultTimeouts[stepType] || 120000; // Default: 2 minutes
  }

  detectCapabilities(steps = []) {
    const stepList = Array.isArray(steps) ? steps : [];
    const hasStep = (...types) => stepList.some(step => types.includes(step.type));

    const capabilities = {
      hasSteps: stepList.length > 0,
      usesPlaywrightAnalysis: hasStep('playwright-analysis', 'workflow-analysis', 'hardcoded-workflow-analysis', 'page-discovery'),
      usesAIModel: hasStep('ai-request', 'ai-prompt', 'page-description', 'workflow-analysis', 'hardcoded-workflow-analysis', 'create-workflow', 'update-workflow'),
      usesLinkDiscovery: hasStep('page-discovery'),
      usesPerformanceAudit: hasStep('unlighthouse'),
      usesScreenshotStep: hasStep('screenshot'),
      usesCookieOperations: hasStep('cookie-add', 'cookie-update', 'cookie-remove', 'cookie-collect')
    };

    return capabilities;
  }

  getCapabilities() {
    return this.workflowCapabilities;
  }

  hasExecutableSteps() {
    return !!(this.workflowCapabilities?.hasSteps);
  }


  /**
   * Analyze page using workflow template steps only
   * @param {Page} page - Playwright page object
   * @param {string} jobId - Job ID for logging
   * @param {string} pageId - Page ID in MongoDB
   * @param {string} projectId - Project ID
   * @returns {Object} workflow object
   */
  async analyzePage(page, jobId, pageId, projectId) {
    // CRITICAL: job_id must always be available - use from context if not provided as parameter
    // Backend always provides job_id in context, so this ensures workflows can link to the job
    const effectiveJobId = jobId || this.context.job_id;
    if (!effectiveJobId) {
      console.warn(`[WorkflowAnalyzer] ⚠️ No job_id provided - workflows/actions/pages may not be linked to job`);
    }
    
    console.log(`[WorkflowAnalyzer] Analyzing page: ${page.url()} (job_id: ${effectiveJobId || 'none'})`);

    // Load workflow template - MANDATORY
    await this.loadWorkflowTemplate();

    // Validate workflow template has steps
    if (!this.workflowTemplate || !this.workflowTemplate.steps || this.workflowTemplate.steps.length === 0) {
      throw new Error(`Workflow template "${this.context.workflow_template_id}" has no steps defined. All analysis must be defined in workflow template steps.`);
    }

    console.log(`[WorkflowAnalyzer] 🎯 Executing workflow template: "${this.workflowTemplate.name}"`);
    console.log(`[WorkflowAnalyzer] 📋 Workflow template has ${this.workflowTemplate.steps.length} steps to execute`);

    // Execute workflow template steps ONLY
    try {
      // Use jobId from parameter or fallback to context (backend always provides job_id in context)
      const effectiveJobId = jobId || this.context.job_id;
      const results = await this.executeWorkflowSteps(page, effectiveJobId, pageId, projectId);
      console.log(`[WorkflowAnalyzer] ✅ Workflow template steps completed successfully`);
      
      return results;
    } catch (stepError) {
      console.error(`[WorkflowAnalyzer] ❌ Workflow template execution failed:`, stepError);
      throw new Error(`Workflow execution failed: ${stepError.message}`);
    }
  }

  /**
   * Perform Playwright analysis to extract forms, links, interactive elements
   */
  async performPlaywrightAnalysis(page) {
    const analysis = {
      forms: [],
      links: [],
      interactive_elements: [],
      non_interactive_elements: []
    };

    try {
      // Extract forms
      const forms = await page.$$('form');
      for (const form of forms) {
        const inputs = await form.$$('input, textarea, select');
        const buttons = await form.$$('button, input[type="submit"]');
        
        // Get selectors with all strategies
        const formSelectors = await this.getElementSelector(form);
        const formData = {
          selector: formSelectors[0]?.selector, // Use primary selector for backward compatibility
          selectors: formSelectors, // Store all strategies for robust matching
          action: await form.getAttribute('action'),
          method: await form.getAttribute('method'),
          fields: []
        };

        for (const input of inputs) {
          const type = await input.getAttribute('type') || 'text';
          const name = await input.getAttribute('name');
          const id = await input.getAttribute('id');
          const placeholder = await input.getAttribute('placeholder');
          
          const inputSelectors = await this.getElementSelector(input);
          formData.fields.push({
            type,
            name,
            id,
            placeholder,
            selector: inputSelectors[0]?.selector, // Primary selector
            selectors: inputSelectors // All strategies
          });
        }

        formData.buttons = [];
        for (const button of buttons) {
          const text = await button.textContent();
          const buttonSelectors = await this.getElementSelector(button);
          formData.buttons.push({
            text: text?.trim(),
            selector: buttonSelectors[0]?.selector, // Primary selector
            selectors: buttonSelectors // All strategies
          });
        }

        analysis.forms.push(formData);
      }

      // Extract links (excluding anchors - they should not be separate pages)
      const links = await page.$$('a[href]');
      for (const link of links.slice(0, 50)) { // Limit to first 50 links
        const href = await link.getAttribute('href');
        const text = await link.textContent();
        
        // FIXED: Exclude anchor links (#) - they should not be treated as separate pages
        // Only include external links and internal page links, not anchors
        if (href && 
            !href.startsWith('javascript:') && 
            !href.startsWith('#') && 
            !href.startsWith('mailto:') &&
            !href.startsWith('tel:') &&
            href.trim() !== '') {
          const linkSelectors = await this.getElementSelector(link);
          analysis.links.push({
            href,
            text: text?.trim(),
            selector: linkSelectors[0]?.selector, // Primary selector
            selectors: linkSelectors // All strategies
          });
        }
      }

      // Extract interactive elements (buttons, clickable divs, etc.)
      const buttons = await page.$$('button:not(form button), input[type="button"], [role="button"], [onclick]');
      for (const button of buttons) {
        const text = await button.textContent();
        const role = await button.getAttribute('role');
        const onclick = await button.getAttribute('onclick');

        const buttonSelectors = await this.getElementSelector(button);
        analysis.interactive_elements.push({
          type: 'button',
          text: text?.trim(),
          role,
          onclick: onclick ? 'yes' : 'no',
          selector: buttonSelectors[0]?.selector, // Primary selector
          selectors: buttonSelectors // All strategies
        });
      }

      // Extract non-interactive elements (informational content, headings, labels)
      const nonInteractiveElements = await page.$$eval(
        'p, h1, h2, h3, h4, h5, h6, span, div, label',
        elements => elements
          .filter(el => {
            const text = el.textContent?.trim() || '';
            if (!text) return false;
            if (text.length > 500) return false; // skip very long blobs
            const style = window.getComputedStyle(el);
            return style && style.visibility !== 'hidden' && style.display !== 'none';
          })
          .slice(0, 50)
          .map(el => ({
            type: el.tagName.toLowerCase(),
            text: el.textContent.trim(),
            selector: el.id
              ? `#${el.id}`
              : (el.className && el.className.trim()
                ? `.${el.className.trim().split(/\s+/)[0]}`
                : el.tagName.toLowerCase())
          }))
      );

      analysis.non_interactive_elements = nonInteractiveElements;

    } catch (error) {
      console.error('[WorkflowAnalyzer] Error during Playwright analysis:', error);
    }

    return analysis;
  }

  generateLegsFromPlaywrightAnalysis(playwrightAnalysis = {}, pageUrl = '') {
    const legs = [];
    const forms = Array.isArray(playwrightAnalysis.forms) ? playwrightAnalysis.forms.slice(0, 20) : [];
    const interactiveElements = Array.isArray(playwrightAnalysis.interactive_elements)
      ? playwrightAnalysis.interactive_elements.slice(0, 20)
      : [];
    const links = Array.isArray(playwrightAnalysis.links) ? playwrightAnalysis.links.slice(0, 30) : [];

    forms.forEach((form, index) => {
      const legId = `auto-form-${index + 1}`;
      legs.push({
        leg_id: legId,
        type: 'form_submit',
        action: 'submit_form',
        description: `Submit detected form #${index + 1}`,
        test_instructions: 'Fill detected fields with sample data and submit the form. Confirm that the page responds with a success state or expected validation.',
        element_info: {
          selector: form.selector,
          selectors: form.selectors || [],
          fields: form.fields || [],
          buttons: form.buttons || [],
          method: form.method || 'get',
          action: form.action || null
        },
        confidence: 0.6,
        status: 'pending',
        metadata: {
          generated_by: 'playwright-analysis',
          source: 'form'
        }
      });
    });

    interactiveElements.forEach((element, index) => {
      const legId = `auto-interactive-${index + 1}`;
      legs.push({
        leg_id: legId,
        type: 'click',
        action: 'click',
        description: `Click interactive element #${index + 1}${element.text ? ` (${element.text})` : ''}`.trim(),
        test_instructions: 'Click the element and verify that the expected UI change or navigation occurs.',
        element_info: {
          selector: element.selector,
          selectors: element.selectors || [],
          text: element.text,
          role: element.role,
          onclick: element.onclick
        },
        confidence: 0.5,
        status: 'pending',
        metadata: {
          generated_by: 'playwright-analysis',
          source: 'interactive-element'
        }
      });
    });

    if (links.length) {
      let baseOrigin = null;
      try {
        baseOrigin = new URL(pageUrl).origin;
      } catch (_) {
        baseOrigin = null;
      }

      links.forEach((link, index) => {
        if (!link.href) {
          return;
        }

        if (baseOrigin) {
          const isSameOrigin = link.href.startsWith(baseOrigin) || link.href.startsWith('/') || link.href.startsWith('./');
          if (!isSameOrigin) {
            return;
          }
        }

        const legId = `auto-link-${index + 1}`;
        legs.push({
          leg_id: legId,
          type: 'navigate',
          action: 'navigate',
          description: `Follow link #${index + 1} to ${link.href}`,
          test_instructions: 'Click the link and verify that the destination page loads successfully without errors.',
          element_info: {
            selector: link.selector,
            selectors: link.selectors || [],
            href: link.href,
            text: link.text
          },
          confidence: 0.4,
          status: 'pending',
          metadata: {
            generated_by: 'playwright-analysis',
            source: 'link'
          }
        });
      });
    }

    return legs;
  }

  buildActionsSummary(legs = []) {
    if (!Array.isArray(legs) || legs.length === 0) {
      return {
        total: 0,
        pending: 0,
        in_progress: 0,
        completed: 0,
        failed: 0,
        by_type: {}
      };
    }

    const summary = {
      total: legs.length,
      pending: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
      by_type: {},
      sample: []
    };

    legs.forEach((leg) => {
      const type = (leg.type || leg.action || 'action').toLowerCase();
      summary.by_type[type] = (summary.by_type[type] || 0) + 1;

      const status = (leg.status || 'pending').toLowerCase();
      if (status === 'completed' || status === 'success') {
        summary.completed += 1;
      } else if (status === 'failed' || status === 'error') {
        summary.failed += 1;
      } else if (status === 'skipped') {
        summary.pending += 1;
      } else if (status === 'in_progress') {
        summary.in_progress += 1;
      } else {
        summary.pending += 1;
      }

      if (summary.sample.length < 15) {
        const iterations = Array.isArray(leg.iterations) ? leg.iterations : [];
        const lastIteration = iterations.length ? iterations[iterations.length - 1] : null;
        summary.sample.push({
          leg_id: leg.leg_id,
          type,
          status,
          description: leg.description,
          test_instructions: leg.test_instructions,
          last_result: lastIteration?.result || null,
          last_message: lastIteration?.message || lastIteration?.error || null
        });
      }
    });

    return summary;
  }

  enforceLegInstructionsInTemplate(template) {
    if (!template || typeof template !== 'string') {
      return template;
    }

    const normalized = template.toLowerCase();
    if (normalized.includes('"legs"') || normalized.includes(' legs array') || normalized.includes('workflow legs')) {
      return template;
    }

    return `${template.trim()}

IMPORTANT OUTPUT REQUIREMENTS:
- Return valid JSON that includes all of the page summary fields above.
- ALSO include a top-level "legs" array describing the highest value interactive test actions (buttons, toggles, form submissions, input flows).
- Each item in "legs" MUST include:
  - "leg_id": unique snake_case string identifier
  - "description": concise sentence describing the action and purpose
  - "type": one of click | form_submit | input | navigation_toggle | custom (avoid plain navigation link testing)
  - "selector": CSS selector (or Playwright-compatible selector such as xpath=...) to locate the element
  - "expected_outcome": what should be verified after performing the action
  - "test_instructions": detailed steps or notes for running the action
  - "priority": high | medium | low
  - "confidence": number between 0 and 1
  - "element_info": extra helpful selector/text/attribute data (ids, aria-labels, text, XPath, etc.)
- Do NOT include duplicate actions or simple navigation links unless the navigation triggers a meaningful state change or workflow step.`;
  }

  applyLegsToWorkflowState(rawLegs, workflowState, source = 'page-summary') {
    if (!Array.isArray(rawLegs) || rawLegs.length === 0 || !workflowState) {
      return [];
    }

    const normalizeType = (rawType) => {
      if (!rawType) return 'click';
      const type = String(rawType).trim().toLowerCase();
      if (!type) return 'click';
      const mappings = {
        press: 'click',
        click: 'click',
        tap: 'click',
        submit: 'form_submit',
        form: 'form_submit',
        form_submit: 'form_submit',
        input: 'input',
        type_text: 'input',
        fill: 'input',
        toggle: 'navigation_toggle',
        navigation_toggle: 'navigation_toggle',
        dropdown: 'navigation_toggle',
        custom: 'custom',
        interaction: 'custom',
        action: 'custom'
      };
      const normalized = mappings[type] || type;
      if (normalized === 'navigate' || normalized === 'navigation') {
        return 'navigation';
      }
      return normalized;
    };

    const normalizePriority = (rawPriority) => {
      if (!rawPriority && rawPriority !== 0) return 'medium';
      const value = String(rawPriority).trim().toLowerCase();
      if (value === 'high' || value === 'medium' || value === 'low') {
        return value;
      }
      if (value === 'critical' || value === 'highest') return 'high';
      if (value === 'lowest') return 'low';
      return 'medium';
    };

    const normalizeConfidence = (rawConfidence) => {
      if (rawConfidence === null || rawConfidence === undefined) return null;
      const numeric = Number(rawConfidence);
      if (Number.isNaN(numeric)) return null;
      return Math.max(0, Math.min(1, numeric));
    };

    const sanitizeSelector = (candidate) => {
      if (!candidate && candidate !== 0) return null;
      if (typeof candidate === 'string') {
        const trimmed = candidate.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith('//')) {
          return trimmed.startsWith('xpath=') ? trimmed : `xpath=${trimmed}`;
        }
        return trimmed;
      }
      return null;
    };

    const pickSelector = (leg) => {
      const candidates = [
        leg.selector,
        leg.css_selector,
        leg.cssSelector,
        leg.element_selector,
        leg.elementSelector,
        leg.target_selector,
        leg.targetSelector,
        leg.locator,
        leg.element?.selector,
        leg.element_info?.selector,
        leg.element_info?.css_selector,
        leg.element_info?.cssSelector,
        ...(Array.isArray(leg.selectors) ? leg.selectors : []),
        ...(Array.isArray(leg.element_info?.selectors) ? leg.element_info.selectors : []),
        leg.xpath,
        leg.element_info?.xpath
      ];

      for (const candidate of candidates) {
        const selector = sanitizeSelector(candidate);
        if (selector) {
          return selector;
        }
      }
      return null;
    };

    const seenIds = new Set();
    const generateLegId = (leg, index) => {
      const candidates = [
        leg.leg_id,
        leg.legId,
        leg.id,
        leg.action_id,
        leg.source_leg_id,
        leg.original_leg_id,
        leg.slug,
        leg.selector,
        leg.description,
        leg.name
      ];

      let baseId = null;
      for (const candidate of candidates) {
        if (!candidate && candidate !== 0) continue;
        const candidateString = String(candidate).trim();
        if (candidateString) {
          baseId = candidateString;
          break;
        }
      }

      if (!baseId) {
        baseId = `${source}_leg_${index + 1}`;
      }

      let sanitized = baseId
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

      if (!sanitized) {
        sanitized = `${source}_leg_${index + 1}`;
      }

      let finalId = sanitized;
      let suffix = 2;
      while (seenIds.has(finalId)) {
        finalId = `${sanitized}_${suffix}`;
        suffix += 1;
      }
      seenIds.add(finalId);

      return finalId;
    };

    const normalizedLegs = [];
    rawLegs.forEach((rawLeg, index) => {
      if (!rawLeg || typeof rawLeg !== 'object') {
        return;
      }

      const type = normalizeType(rawLeg.type || rawLeg.action || rawLeg.action_type || rawLeg.kind);
      if (type === 'navigation') {
        console.log('[WorkflowAnalyzer] ⚠️ Skipping navigation leg emitted by page summary');
        return;
      }

      const selector = pickSelector(rawLeg);
      if (!selector) {
        console.log('[WorkflowAnalyzer] ⚠️ Skipping leg because no selector was supplied:', rawLeg.description || rawLeg.leg_id || `index_${index}`);
        return;
      }

      const legId = generateLegId(rawLeg, index);
      const description = rawLeg.description || rawLeg.summary || rawLeg.name || rawLeg.label || `Leg ${index + 1}`;
      const expectedOutcome = rawLeg.expected_outcome || rawLeg.expectedOutcome || rawLeg.expected_result || rawLeg.result || '';
      const testInstructions = rawLeg.test_instructions || rawLeg.instructions || rawLeg.steps || '';
      const priority = normalizePriority(rawLeg.priority || rawLeg.importance);
      const confidence = normalizeConfidence(rawLeg.confidence ?? rawLeg.score ?? rawLeg.confidence_score);

      const normalizedLeg = {
        ...rawLeg,
        leg_id: legId,
        original_leg_id: rawLeg.original_leg_id || legId,
        source_leg_id: rawLeg.source_leg_id || legId,
        type,
        description: String(description).trim(),
        selector,
        expected_outcome: expectedOutcome ? String(expectedOutcome).trim() : '',
        test_instructions: testInstructions ? String(testInstructions).trim() : '',
        priority,
        confidence,
        status: rawLeg.status || 'pending',
        iterations: Array.isArray(rawLeg.iterations) ? rawLeg.iterations : [],
        element_info: rawLeg.element_info || rawLeg.elementInfo || rawLeg.element || {},
        metadata: {
          ...(rawLeg.metadata || {}),
          generated_from: source
        }
      };

      if (!normalizedLeg.element_info.selector) {
        normalizedLeg.element_info.selector = selector;
      }

      normalizedLegs.push(normalizedLeg);
    });

    if (normalizedLegs.length === 0) {
      console.log(`[WorkflowAnalyzer] ⚠️ No valid legs produced from ${source} response`);
      return [];
    }

    workflowState.legs = normalizedLegs;
    workflowState.legsSource = source;
    workflowState.legResults = new Array(normalizedLegs.length).fill(null);
    workflowState.actionsSummary = this.buildActionsSummary(normalizedLegs);

    workflowState.aiAnalysisResult = workflowState.aiAnalysisResult || {};
    if (!workflowState.aiAnalysisResult.page_description && workflowState.pageDescription) {
      workflowState.aiAnalysisResult.page_description = workflowState.pageDescription;
    }
    workflowState.aiAnalysisResult.legs = normalizedLegs;
    workflowState.aiAnalysisResult.source = source;

    console.log(`[WorkflowAnalyzer] ✅ Normalized ${normalizedLegs.length} legs from ${source}`);

    return normalizedLegs;
  }

  createFallbackPageDescription(stats = {}, workflowState = {}) {
    const title = workflowState.pageTitle || workflowState.pageUrl || 'Page';
    const url = workflowState.pageUrl || '';
    const summaryParts = [];

    if (typeof stats.forms === 'number') summaryParts.push(`${stats.forms} form${stats.forms === 1 ? '' : 's'}`);
    if (typeof stats.links === 'number') summaryParts.push(`${stats.links} link${stats.links === 1 ? '' : 's'}`);
    if (typeof stats.interactive === 'number') summaryParts.push(`${stats.interactive} interactive element${stats.interactive === 1 ? '' : 's'}`);

    const shortDescription = summaryParts.length
      ? `${title} (${summaryParts.join(', ')})`
      : title;

    const fullDescription = `Automatically generated summary for ${url || 'the current page'}. The crawler detected ${summaryParts.join(', ') || 'no significant interactive elements'} during Playwright analysis.`;

    return {
      short_description: shortDescription,
      full_description: fullDescription,
      purpose: 'auto-generated summary from crawler analysis',
      conversation_context: 'Generated without AI prompt execution'
    };
  }

  /**
   * Get a reliable selector for an element
   * Returns multiple selector strategies for robust element matching
   */
  async getElementSelector(element) {
    const selectors = [];
    
    try {
      const tagName = await element.evaluate(el => el.tagName.toLowerCase());
      
      // Strategy 1: ID selector (most reliable if stable)
      const id = await element.getAttribute('id');
      if (id) {
        selectors.push({
          strategy: 'id',
          selector: `#${id}`,
          priority: 1,
          stability: 'high'
        });
      }

      // Strategy 2: Name + type selector
      const name = await element.getAttribute('name');
      if (name) {
        selectors.push({
          strategy: 'name',
          selector: `${tagName}[name="${name}"]`,
          priority: 2,
          stability: 'high'
        });
      }

      // Strategy 3: Type selector for inputs
      const type = await element.getAttribute('type');
      if (type) {
        selectors.push({
          strategy: 'type',
          selector: `${tagName}[type="${type}"]`,
          priority: 3,
          stability: 'medium'
        });
      }

      // Strategy 4: Text-based selector (for buttons, links)
      const text = await element.textContent();
      if (text && text.trim()) {
        const cleanText = text.trim().substring(0, 50);
        selectors.push({
          strategy: 'text',
          selector: `text="${cleanText}"`,
          priority: 4,
          stability: 'medium',
          text_content: cleanText
        });
      }

      // Strategy 5: Role selector
      const role = await element.getAttribute('role');
      if (role) {
        selectors.push({
          strategy: 'role',
          selector: `[role="${role}"]`,
          priority: 5,
          stability: 'medium'
        });
      }

      // Strategy 6: Placeholder selector for inputs
      const placeholder = await element.getAttribute('placeholder');
      if (placeholder) {
        selectors.push({
          strategy: 'placeholder',
          selector: `${tagName}[placeholder="${placeholder}"]`,
          priority: 6,
          stability: 'low'
        });
      }

      // Strategy 7: Class selector (if few classes, stable)
      const className = await element.getAttribute('class');
      if (className) {
        const classes = className.trim().split(/\s+/).filter(c => c);
        if (classes.length <= 3 && classes.length > 0) {
          selectors.push({
            strategy: 'class',
            selector: `.${classes.join('.')}`,
            priority: 7,
            stability: classes.length === 1 ? 'medium' : 'low',
            classes: classes
          });
        }
      }

      // Strategy 8: Fallback to tag
      selectors.push({
        strategy: 'tag',
        selector: tagName,
        priority: 8,
        stability: 'very-low'
      });

    } catch (error) {
      console.error('[WorkflowAnalyzer] Error generating selectors:', error);
      return [{
        strategy: 'fallback',
        selector: 'unknown',
        priority: 9,
        stability: 'none'
      }];
    }

    return selectors;
  }

  /**
   * Get element selector in legacy format (backward compatibility)
   */
  async getElementSelectorLegacy(element) {
    const selectors = await this.getElementSelector(element);
    // Return the first (highest priority) selector
    return selectors[0]?.selector || 'unknown';
  }

  /**
   * Log page description to job history with attachments (appears above AI chats)
   */
  async logPageDescription(jobId, pageUrl, pageTitle, pageDescription, metadata = {}, htmlContent = null, screenshotBase64 = null) {
    try {
      // Extract short_description with fallbacks (handle different response structures)
      const shortDescription = pageDescription?.short_description ||
                               pageDescription?.description ||
                               pageDescription?.summary ||
                               pageDescription?.short_summary ||
                               (pageDescription && typeof pageDescription === 'string' ? pageDescription : null) ||
                               pageTitle ||
                               'Page analysis completed';
      
      const message = `📄 Page Analysis: ${shortDescription}`;
      
      const logMetadata = {
        page_analysis: true,
        page_title: pageTitle,
        page_url: pageUrl,
        short_description: shortDescription,
        full_description: pageDescription?.full_description || pageDescription?.description || '',
        purpose: pageDescription?.purpose || '',
        conversation_context: pageDescription?.conversation_context || '',
        legs_count: Array.isArray(pageDescription?.legs) ? pageDescription.legs.length : 0,
        ...metadata
      };
      
      // Create attachments for full data (with content for display)
      const attachments = [];
      
      // 1. HTML content attachment
      if (htmlContent) {
        attachments.push({
          type: 'html_content',
          filename: `page_content_${Date.now()}.html`,
          content: htmlContent,  // Full HTML for display
          mimeType: 'text/html',
          size: htmlContent.length,
          timestamp: new Date().toISOString()
        });
      }
      
      // 2. Screenshot attachment (store as base64 data URL for display)
      if (screenshotBase64) {
        // Ensure screenshotBase64 is properly formatted as base64 string
        let screenshotContent = screenshotBase64;
        if (typeof screenshotBase64 === 'string') {
          // If it's already a data URL, use it as-is
          if (screenshotBase64.startsWith('data:image/')) {
            screenshotContent = screenshotBase64;
          } else {
            // If it's raw base64, add data URL prefix
            if (screenshotBase64.length > 100 && /^[A-Za-z0-9+/=]+$/.test(screenshotBase64)) {
              screenshotContent = `data:image/png;base64,${screenshotBase64}`;
            } else {
              screenshotContent = screenshotBase64;
            }
          }
        } else {
          // If it's a Buffer, convert to base64 data URL
          screenshotContent = `data:image/png;base64,${screenshotBase64.toString('base64')}`;
        }
        
        const size = typeof screenshotBase64 === 'string' 
          ? (screenshotBase64.startsWith('data:image/') ? screenshotBase64.length - 22 : screenshotBase64.length)
          : screenshotBase64.length;
        
        attachments.push({
          type: 'screenshot',
          filename: `page_screenshot_${Date.now()}.png`,
          content: screenshotContent,  // Base64 data URL for display
          mimeType: 'image/png',
          size: size,
          timestamp: new Date().toISOString()
        });
      }
      
      // Use backend logger to append job log with attachments
      console.log(`[WorkflowAnalyzer] Sending ${attachments.length} attachments:`, attachments.map(a => `${a.type} (${a.size} bytes)`));
      
      const response = await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'info',
        message: message,
        component: 'PAGE-ANALYZER',
        metadata: logMetadata,
        attachments: attachments
      });
      
      console.log(`[WorkflowAnalyzer] Page description logged to job history with ${attachments.length} attachments`);
      return response.data;
    } catch (error) {
      console.error('[WorkflowAnalyzer] Error logging page description:', error.message);
      // Don't throw - this is not critical
    }
  }

  /**
   * Create workflow document via backend API
   */
  async createWorkflow(pageId, projectId, url, playwrightAnalysis, jobId = null) {
    try {
      const workflowData = {
        page_id: pageId,
        project_id: projectId,
        url: url,
        playwright_analysis: playwrightAnalysis
      };
      
      // Include job_id if available (so workflows are linked to the job that created them)
      if (jobId) {
        workflowData.job_id = jobId;
      }
      
      const response = await axios.post(`${this.backendUrl}/api/workflows`, workflowData, {
        headers: this.getAuthHeaders()
      });

      return response.data;
    } catch (error) {
      console.error('[WorkflowAnalyzer] Error creating workflow:', error.message);
      throw error;
    }
  }

  /**
   * Update workflow with AI analysis and legs
   * Also creates action documents for each leg
   */
  async updateWorkflowWithAnalysis(workflowId, pageDescription, legs, createActions = true, jobId = null) {
    try {
      const response = await axios.put(
        `${this.backendUrl}/api/workflows/${workflowId}/analysis`,
        {
          ai_analysis: {
            page_description: pageDescription,
            analyzed_at: new Date().toISOString()
          },
          legs: legs,
          create_actions: createActions,  // Signal backend to create action documents
          job_id: jobId  // Pass job_id so actions can be linked to the job
        },
        {
          headers: this.getAuthHeaders()
        }
      );

      return response.data;
    } catch (error) {
      console.error('[WorkflowAnalyzer] Error updating workflow:', error.message);
      throw error;
    }
  }
  
  /**
   * Send real-time page discovery/update to backend
   * @param {string} jobId - Job ID
   * @param {string} pageId - Page ID
   * @param {string} projectId - Project ID
   * @param {string} url - Page URL
   * @param {Object} data - Page data to update
   */
  async updatePageDiscovery(jobId, pageId, projectId, url, data) {
    try {
      const payload = {
        project_id: projectId,
        job_id: jobId,
        url: url,
        ...data
      };
      
      // Validate required fields
      if (!projectId || !jobId || !url) {
        console.error('[WorkflowAnalyzer] Missing required fields for page discovery:', {
          projectId: !!projectId,
          jobId: !!jobId,
          url: !!url
        });
        return;
      }
      
      const response = await axios.post(
        `${this.backendUrl}/api/pages/discover`,
        payload,
        {
          headers: this.getAuthHeaders()
        }
      );
      
      console.log(`[WorkflowAnalyzer] Page discovery updated: ${url} (${response.data.isNew ? 'new' : 'updated'})`);
      return response.data;
    } catch (error) {
      console.error('[WorkflowAnalyzer] Error updating page discovery:', error.message);
      if (error.response) {
        console.error('[WorkflowAnalyzer] Response status:', error.response.status);
        console.error('[WorkflowAnalyzer] Response data:', error.response.data);
      }
      // Don't throw - page discovery updates are non-critical
    }
  }

  /**
   * Update job substatus in real-time
   * @param {string} jobId - Job ID
   * @param {string} substatus - Current substatus
   * @param {object} progress - Progress details (optional)
   */
  async updateJobSubstatus(jobId, substatus, progress = {}) {
    try {
      await axios.post(`${this.backendUrl}/jobs/${jobId}/substatus`, {
        substatus, 
        ...progress,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      // Silent fail - don't block execution
      console.error(`Failed to update substatus: ${error.message}`);
    }
  }

  /**
   * Update job progress with current iteration and step information
   */
  async updateJobProgress(jobId, progress = {}) {
    try {
      await axios.put(`${this.backendUrl}/api/jobs/${jobId}/progress`, {
        ...progress,
        timestamp: new Date().toISOString()
      }, {
        headers: this.getAuthHeaders()
      });
    } catch (error) {
      // Silent fail - don't block execution
      console.error(`Failed to update job progress: ${error.message}`);
    }
  }

  /**
   * Log workflow decision to job history
   * Shows which workflow from MongoDB is being used (ID and name)
   */
  async logWorkflowDecision(decision, details) {
    try {
      const jobId = this.context.job_id;
      if (!jobId) return;
      
      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'info',
        message: `🔄 WORKFLOW: ${decision}`,
        component: 'WORKFLOW-ANALYZER',
        metadata: {
          workflow_decision: true,
          workflow_id: this.context.workflow_template_id,
          workflow_name: this.workflowTemplate?.name,
          details: details,
          prompts_count: this.workflowTemplate?.prompts?.length || 0,
          timestamp: new Date().toISOString()
        }
      });
      
      console.log(`[WorkflowAnalyzer] 📝 Logged workflow: ${decision}`);
    } catch (error) {
      console.error('[WorkflowAnalyzer] Error logging workflow decision:', error.message);
    }
  }
  
  /**
   * Log prompt usage to job history
   * Shows which prompt was used (custom from template or default from database)
   * @param {string} promptName - Name of the prompt
   * @param {string} source - Source of the prompt ('workflow-step', 'workflow-template', 'database')
   * @param {string} promptText - The prompt text (optional)
   * @param {object} payload - The payload sent to the prompt (optional)
   * @param {object} stepInfo - Step information {step, stepIndex, totalSteps} (optional)
   */
  async logPromptUsage(promptName, source, promptText, payload, stepInfo = null) {
    try {
      const jobId = this.context.job_id;
      if (!jobId) return;
      
      // Format message with step information if available
      let message = `📝 PROMPT USAGE: "${promptName}"`;
      
      if (stepInfo && stepInfo.step && stepInfo.stepIndex !== undefined) {
        const stepNumber = stepInfo.stepIndex + 1; // 1-indexed for display
        const stepName = stepInfo.step.name || stepInfo.step.type || 'Unknown';
        const totalSteps = stepInfo.totalSteps || this.workflowTemplate?.steps?.length || '?';
        message += ` from Step ${stepNumber}/${totalSteps}: "${stepName}"`;
      } else if (source) {
        message += ` from ${source}`;
      }
      
      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'info',
        message: message,
        component: 'WORKFLOW-ANALYZER',
        metadata: {
          prompt_usage: true,
          prompt_name: promptName,
          prompt_source: source, // 'workflow-template' or 'database'
          prompt_text_preview: promptText ? promptText.substring(0, 200) : 'N/A',
          workflow_template_id: this.context.workflow_template_id || null,
          workflow_template_name: this.workflowTemplate?.name || null,
          payload_keys: Object.keys(payload || {}),
          step_name: stepInfo?.step?.name || null,
          step_type: stepInfo?.step?.type || null,
          step_number: stepInfo?.stepIndex !== undefined ? stepInfo.stepIndex + 1 : null,
          total_steps: stepInfo?.totalSteps || this.workflowTemplate?.steps?.length || null,
          timestamp: new Date().toISOString()
        }
      });
      
      console.log(`[WorkflowAnalyzer] 📝 Logged prompt usage: ${promptName}${stepInfo && stepInfo.step ? ` (Step ${stepInfo.stepIndex + 1}: ${stepInfo.step.name || stepInfo.step.type})` : ''}`);
    } catch (error) {
      console.error('[WorkflowAnalyzer] Error logging prompt usage:', error.message);
    }
  }

  /**
   * Log step execution with parameters
   */
  async logStepExecution(step, jobId) {
    try {
      const stepConfig = step.config || {};
      const logData = {
        step_type: step.type,
        step_name: step.name || step.type,
        step_slug: step.slug || null,
        parameters: stepConfig,
        timestamp: new Date().toISOString()
      };

      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'info',
        message: `🔧 [${step.type.toUpperCase()}] Executing step: "${step.name || step.type}"`,
        component: 'WORKFLOW-STEP',
        metadata: logData
      }, {
        headers: this.getAuthHeaders()
      });

      console.log(`[WorkflowAnalyzer] 📋 STEP PARAMS: ${JSON.stringify(stepConfig, null, 2)}`);
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ⚠️ Failed to log step execution: ${error.message}`);
    }
  }

  /**
   * Log step outcome with summary metadata
   */
  async logStepOutcome(step, jobId, message, metadata = {}, level = 'info', attachments = []) {
    if (!jobId) {
      return;
    }

    try {
      const slug = step.slug || this.generateSlug(step.name || step.type);
      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: level,
        message: message,
        component: 'WORKFLOW-STEP',
        metadata: {
          step_type: step.type,
          step_name: step.name || step.type,
          step_slug: slug,
          ...metadata,
          timestamp: new Date().toISOString()
        },
        attachments: attachments.length > 0 ? attachments : undefined
      }, {
        headers: this.getAuthHeaders()
      });
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ⚠️ Failed to log step outcome: ${error.message}`);
    }
  }

  /**
   * Helper to send log to backend (for crucial workflow execution logs)
   */
  async sendLogToBackend(jobId, level, message, component = 'WORKFLOW-ANALYZER', metadata = {}) {
    if (!jobId) {
      return;
    }

    try {
      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: level,
        message: message,
        component: component,
        metadata: {
          ...metadata,
          timestamp: new Date().toISOString()
        }
      }, {
        headers: this.getAuthHeaders()
      });
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ⚠️ Failed to send log to backend: ${error.message}`);
    }
  }

  /**
   * Execute workflow template steps and return results
   * @param {Page} page - Playwright page object
   * @param {string} jobId - Job ID for logging
   * @param {string} pageId - Page ID in MongoDB
   * @param {string} projectId - Project ID
   * @returns {Object} workflow results
   */
  async executeWorkflowSteps(page, jobId, pageId, projectId) {
    // CRITICAL: job_id must always be available - use from context if not provided as parameter
    // Backend always provides job_id in context, so this ensures workflows can link to the job
    const effectiveJobId = jobId || this.context.job_id;
    if (!effectiveJobId) {
      console.warn(`[WorkflowAnalyzer] ⚠️ No job_id available - workflows/actions/pages may not be linked to job`);
    }
    
    console.log(`[WorkflowAnalyzer] ═══════════════════════════════════════════════════════`);
    console.log(`[WorkflowAnalyzer] 🔄 EXECUTING WORKFLOW TEMPLATE STEPS (job_id: ${effectiveJobId || 'none'})`);
    console.log(`[WorkflowAnalyzer] ═══════════════════════════════════════════════════════`);
    
    const resolvedOptions = {
      ...(this.context?.options || {})
    };
    if (this.context?.single_action_only !== undefined && resolvedOptions.single_action_only === undefined) {
      resolvedOptions.single_action_only = this.context.single_action_only;
    }
    const singleActionOnly =
      resolvedOptions.single_action_only === true ||
      resolvedOptions.single_action_only === 'true';

    // Initialize workflow state
    const workflowState = {
      pageTitle: null,
      pageUrl: page.url(),
      htmlContent: null,
      visibleText: null,
      screenshotBase64: null,
      screenshotUrl: null,
      screenshotFileId: null,
      playwrightAnalysis: null,
      pageDescription: null,
      conversationHistory: [],
      aiAnalysisResult: null,
      workflowId: null,
      legs: [],
      legResults: [],
      options: resolvedOptions,
      runtimeOptions: resolvedOptions,
      singleActionOnly,
      context: {
        ...(this.context?.context || {}),
        options: resolvedOptions
      },
      inputCredentials: this.context?.credentials || {
        username: this.context?.username || null,
        password: this.context?.password || null
      }
    };
    
    workflowState.pageId = pageId || null;
    workflowState.projectId = projectId || null;
    workflowState.jobId = effectiveJobId; // Use effectiveJobId (from parameter or context)
    
    // Check if we should retry from a specific step (after self-adjustable workflow)
    let startStepIndex = 0;
    if (workflowState.shouldRetryFromStep !== undefined && workflowState.shouldRetryFromStep !== null) {
      startStepIndex = workflowState.shouldRetryFromStep;
      console.log(`[WorkflowAnalyzer] 🔄 Retrying from step ${startStepIndex} with adjusted workflow`);
      // Clear the flag so we don't loop
      delete workflowState.shouldRetryFromStep;
      // Clear the last script failure so self-adjustable workflow doesn't trigger again
      delete workflowState.lastScriptFailure;
    }
    
    // Execute each step in sequence
    for (let i = startStepIndex; i < this.workflowTemplate.steps.length; i++) {
      const step = this.workflowTemplate.steps[i];
      console.log(`[WorkflowAnalyzer] ═══════════════════════════════════════════════════════`);
      console.log(`[WorkflowAnalyzer] 🔄 EXECUTING STEP ${i + 1}/${this.workflowTemplate.steps.length}: ${step.name}`);
      console.log(`[WorkflowAnalyzer] Type: ${step.type}`);
      console.log(`[WorkflowAnalyzer] ═══════════════════════════════════════════════════════`);
      
      // Send log to backend
      await this.sendLogToBackend(effectiveJobId, 'info', `🔄 EXECUTING STEP ${i + 1}/${this.workflowTemplate.steps.length}: ${step.name} (${step.type})`, 'WORKFLOW-ANALYZER', {
        step_id: step.id,
        step_name: step.name || step.type,
        step_type: step.type,
        step_order: i + 1,
        total_steps: this.workflowTemplate.steps.length
      });
      
      try {
        // Get step timeout
        const stepTimeout = this.getStepTimeout(step);
        console.log(`[WorkflowAnalyzer] ⏱️  Step timeout: ${Math.round(stepTimeout / 1000)}s`);
        
        // Log step execution with parameters
        await this.logStepExecution(step, jobId);
        
        // Execute step with timeout
        await Promise.race([
          (async () => {
            switch (step.type) {
          case 'screenshot':
            await this.executeScreenshotStep(page, step, workflowState, effectiveJobId, pageId);
            break;
            
          case 'playwright-analysis':
            await this.executePlaywrightAnalysisStep(page, step, workflowState, effectiveJobId);
            break;
            
          case 'page-description':
            await this.executePageDescriptionStep(page, step, workflowState, effectiveJobId, {
              stepIndex: i,
              siblings: this.workflowTemplate.steps
            });
            break;
            
          case 'ai-prompt':
            await this.executeAIPromptStep(page, step, workflowState, effectiveJobId, {
              stepIndex: i,
              siblings: this.workflowTemplate.steps
            });
            break;
            
          case 'workflow-analysis':
            await this.executeWorkflowAnalysisStep(page, step, workflowState, effectiveJobId, {
              stepIndex: i,
              siblings: this.workflowTemplate.steps
            });
            break;
          
          // Deterministic, hardcoded analysis for specific domains (e.g., Practical Test Automation)
          case 'hardcoded-workflow-analysis':
            await this.executeHardcodedWorkflowAnalysisStep(page, step, workflowState, effectiveJobId);
            break;
            
          case 'create-workflow':
            await this.executeCreateWorkflowStep(step, workflowState, pageId, projectId, effectiveJobId);
            break;
            
          case 'update-workflow':
            await this.executeUpdateWorkflowStep(step, workflowState, effectiveJobId);
            break;
            
          case 'page-discovery':
            await this.executePageDiscoveryStep(step, workflowState, effectiveJobId, pageId, projectId);
            break;
            
          case 'save-data':
            await this.executeSaveDataStep(page, step, workflowState, effectiveJobId);
            break;
            
          case 'execute-code':
            const nextStepForCode = i + 1 < this.workflowTemplate.steps.length ? this.workflowTemplate.steps[i + 1] : null;
            await this.executeCodeStep(page, step, workflowState, effectiveJobId, nextStepForCode);
            break;
            
          case 'execute-code-from-variable':
            const nextStep = i + 1 < this.workflowTemplate.steps.length ? this.workflowTemplate.steps[i + 1] : null;
            await this.executeCodeFromVariableStep(page, step, workflowState, jobId, nextStep);
            break;
            
          case 'cookie-add':
            await this.executeCookieAddStep(step, workflowState, jobId);
            break;
            
          case 'cookie-update':
            await this.executeCookieUpdateStep(step, workflowState, jobId);
            break;
            
          case 'cookie-remove':
            await this.executeCookieRemoveStep(step, workflowState, jobId);
            break;
            
          case 'cookie-collect':
            await this.executeCookieCollectStep(page, step, workflowState, jobId);
            break;
            
          case 'self-adjustable-ai-workflow':
            await this.executeSelfAdjustableAIWorkflowStep(page, step, workflowState, jobId, pageId, projectId);
            break;
            
            case 'validate-response':
            await this.executeValidateResponseStep(step, workflowState);
            break;
            
          case 'filter-response':
            await this.executeFilterResponseStep(step, workflowState);
            break;
            
          case 'cycle-start':
            console.log(`[WorkflowAnalyzer] 🔄 Starting cycle (${step.name})`);
            break;
            
          case 'cycle-end':
            console.log(`[WorkflowAnalyzer] 🔚 Ending cycle (${step.name})`);
            break;
            
          case 'conditional':
            await this.executeConditionalStep(step, workflowState);
            break;
            
          case 'print':
            await this.executePrintStep(step, workflowState, jobId);
            break;

          case 'var-dump':
            await this.executeVarDumpStep(step, workflowState, jobId);
            break;
            
          case 'sleep':
            await this.executeSleepStep(step, workflowState);
            break;
            
          case 'complete-leg':
            await this.executeCompleteLegStep(step, workflowState, jobId);
            break;
            
          case 'for-each':
            await this.executeForEachStep(page, step, workflowState, effectiveJobId);
            break;
            
          case 'while-loop':
            await this.executeWhileLoopStep(page, step, workflowState, effectiveJobId);
            break;
            
          case 'if':
          case 'if-step':
            await this.executeIfStep(page, step, workflowState, jobId);
            break;
            
          case 'self-adjustable-ai-workflow':
            await this.executeSelfAdjustableAIWorkflowStep(page, step, workflowState, jobId, pageId, projectId);
            break;
            
          default:
            console.log(`[WorkflowAnalyzer] ⚠️ Unknown step type: ${step.type}`);
        }
          })(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Step "${step.name || step.id}" timed out after ${Math.round(stepTimeout / 1000)}s`)), stepTimeout)
          )
        ]);
        
        // Add delay between steps
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (stepError) {
        console.error(`[WorkflowAnalyzer] ❌ Step ${i + 1} failed: ${stepError.message}`);
        
        // Send error log to backend
        await this.sendLogToBackend(effectiveJobId, 'error', `❌ Step ${i + 1} failed: ${stepError.message}`, 'WORKFLOW-ANALYZER', {
          step_id: step.id,
          step_name: step.name || step.type,
          step_type: step.type,
          step_order: i + 1,
          error: stepError.message
        });
        
        // Check if this is a script execution failure and next step is self-adjustable-ai-workflow
        const isScriptExecutionFailure = (
          step.type === 'execute-code' || 
          step.type === 'execute-code-from-variable'
        );
        const nextStepIndex = i + 1;
        const nextStep = nextStepIndex < this.workflowTemplate.steps.length 
          ? this.workflowTemplate.steps[nextStepIndex] 
          : null;
        const nextStepIsAdjustable = nextStep && nextStep.type === 'self-adjustable-ai-workflow';
        
        if (isScriptExecutionFailure && nextStepIsAdjustable) {
          console.log(`[WorkflowAnalyzer] 🔄 Script execution failed, next step is self-adjustable-ai-workflow - will retry`);
          // Store failure info for retry, including which step failed and which step generated the script
          // Find the AI prompt step that generated this script (should be before the execute step)
          let scriptGenerationStep = null;
          for (let j = i - 1; j >= 0; j--) {
            const prevStep = this.workflowTemplate.steps[j];
            if (prevStep.type === 'ai-prompt') {
              scriptGenerationStep = prevStep;
              break;
            }
          }
          workflowState.lastScriptFailure = {
            step: step,
            stepIndex: i,
            scriptGenerationStep: scriptGenerationStep,
            scriptGenerationStepIndex: scriptGenerationStep ? this.workflowTemplate.steps.findIndex(s => s.id === scriptGenerationStep.id || s.name === scriptGenerationStep.name) : null,
            error: stepError.message,
            script: workflowState.lastExecutionResult?.script || workflowState.lastExecutionResult?.code || null,
            timestamp: new Date(),
            executionResult: workflowState.lastExecutionResult || null
          };
          // Continue to next step (self-adjustable-ai-workflow) which will handle retry
        } else if (step.config?.critical && !nextStepIsAdjustable) {
          throw stepError;
        }
      }
    }
    
    console.log(`[WorkflowAnalyzer] ═══════════════════════════════════════════════════════`);
    console.log(`[WorkflowAnalyzer] ✅ ALL WORKFLOW STEPS COMPLETED`);
    console.log(`[WorkflowAnalyzer] ═══════════════════════════════════════════════════════`);
    
    // Send log to backend
    await this.sendLogToBackend(effectiveJobId, 'info', `✅ ALL WORKFLOW STEPS COMPLETED`, 'WORKFLOW-ANALYZER', {
      total_steps: this.workflowTemplate.steps.length,
      workflow_id: workflowState.workflowId
    });
    
    // CRITICAL: Include all step results in the return value
    // Step results are stored by step.id, step.slug, and in workflowState.results
    // This allows login-operations.js to extract determine_completion and other step results
    
    // Build result object with all step results accessible
    const result = {
      workflow_id: workflowState.workflowId,
      legs_count: workflowState.legs.length,
      page_description: workflowState.pageDescription,
      legs: workflowState.legs,
      ai_analysis: workflowState.aiAnalysisResult,
      context: workflowState.context || {},
      collectedCookies: workflowState.collectedCookies || [],
      login_status: workflowState.context?.login_status || workflowState.loginStatus || null,
      screenshotUrl: workflowState.screenshotUrl || null,
      screenshotFileId: workflowState.screenshotFileId || null,
      // Include all step results by ID (e.g., determine_completion, perform_login_attempts, etc.)
      results: workflowState.results || {}
    };
    
    // Also include step results directly on the result object for backward compatibility
    // This allows analysisResult.determine_completion to work
    if (workflowState.results) {
      for (const [stepId, stepResult] of Object.entries(workflowState.results)) {
        if (stepResult && typeof stepResult === 'object') {
          result[stepId] = stepResult;
        }
      }
    }
    
    // Also include step results stored by slug or name (storeStepResult stores in multiple places)
    // Check for common step IDs like determine_completion, perform_login_attempts, etc.
    const importantStepIds = ['determine_completion', 'perform_login_attempts', 'collect_iteration_cookies', 'collect_final_cookies'];
    for (const stepId of importantStepIds) {
      if (workflowState[stepId] && !result[stepId]) {
        result[stepId] = workflowState[stepId];
      }
      // Also check for slug-based storage
      const stepSlug = workflowState[stepId]?.stepName ? 
        workflowState[stepId].stepName.toLowerCase().replace(/\s+/g, '_') : null;
      if (stepSlug && workflowState[stepSlug] && !result[stepSlug]) {
        result[stepSlug] = workflowState[stepSlug];
      }
    }
    
    console.log(`[WorkflowAnalyzer] ✅ Returning workflow results with step results:`, Object.keys(result.results || {}));
    
    return result;
  }

  /**
   * Execute hardcoded workflow analysis step
   * Reproduces deterministic page analysis: pages → actions → elements
   * Tailored for domains like practicaltestautomation.com to avoid heavy AI usage
   */
  async executeHardcodedWorkflowAnalysisStep(page, step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 🧩 Performing hardcoded workflow analysis (${step.name})`);
    const url = workflowState.pageUrl;

    // Ensure Playwright analysis exists (forms, links, interactive elements)
    if (!workflowState.playwrightAnalysis) {
      const analysis = await this.performPlaywrightAnalysis(page);
      workflowState.playwrightAnalysis = analysis;
    }

    // Domain detection (default to enabled if step.config.force === true)
    const force = step.config?.force === true;
    const isPracticalTestAutomation = typeof url === 'string' && /practicaltestautomation/i.test(url);
    if (!force && !isPracticalTestAutomation) {
      console.log(`[WorkflowAnalyzer] ℹ️ Hardcoded analysis skipped (domain not matched, use config.force=true to override)`);
      return;
    }

    const legs = this.generateLegsFromPlaywrightAnalysis(workflowState.playwrightAnalysis, url);

    if (legs.length === 0) {
      console.log(`[WorkflowAnalyzer] ⚠️ Hardcoded analysis produced no legs`);
      return;
    }

    workflowState.legs = legs;
    workflowState.aiAnalysisResult = workflowState.aiAnalysisResult || {};
    workflowState.aiAnalysisResult.page_description = workflowState.aiAnalysisResult.page_description || workflowState.pageDescription || null;
    workflowState.aiAnalysisResult.legs = legs;
    console.log(`[WorkflowAnalyzer] ✅ Hardcoded analysis completed: ${legs.length} legs identified`);
  }

  /**
   * Execute screenshot step
   */
  async executeScreenshotStep(page, step, workflowState, jobId, pageId) {
    console.log(`[WorkflowAnalyzer] 📸 Taking screenshot (${step.name})`);
    const config = step.config || {};
    const fullPage = config.fullPage !== false;
    const upload = config.upload !== false;
    const format = (config.format || config.type || 'png').toLowerCase();
    const quality = typeof config.quality === 'number' ? config.quality : 90;

    const screenshotOptions = {
      fullPage,
      type: format === 'jpeg' || format === 'jpg' ? 'jpeg' : 'png'
    };

    if (screenshotOptions.type === 'jpeg' && typeof quality === 'number') {
      screenshotOptions.quality = quality;
    }

    console.log('[WorkflowAnalyzer] Screenshot options resolved:', screenshotOptions);

    const screenshot = await page.screenshot(screenshotOptions);

    workflowState.screenshotBase64 = screenshot.toString('base64');
    console.log(`[WorkflowAnalyzer] ✅ Screenshot taken (${screenshot.length} bytes)`);

    let uploaded = false;
    let publicUrl = null;
    let fileId = null;

    if (upload) {
      try {
        console.log(`[WorkflowAnalyzer] 📸 Requesting presigned URL for screenshot upload...`);

        const mimeType = screenshotOptions.type === 'jpeg' ? 'image/jpeg' : 'image/png';

        const presignedResponse = await axios.post(`${this.backendUrl}/api/upload/presigned-url`, {
          type: 'screenshot',
          jobId: jobId,
          contentType: mimeType
        }, {
          timeout: 10000,
          headers: this.getAuthHeaders()
        });

        const { url: presignedUrl, key, publicUrl: returnedUrl } = presignedResponse.data;
        workflowState.screenshotFileId = key;
        workflowState.screenshotUrl = returnedUrl;
        fileId = key;
        publicUrl = returnedUrl;

        await axios.put(presignedUrl, screenshot, {
          headers: { 'Content-Type': mimeType },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 30000
        });

        uploaded = true;
        console.log(`[WorkflowAnalyzer] ✅ Screenshot uploaded to MinIO: ${returnedUrl}`);

        if (pageId) {
          await axios.post(`${this.backendUrl}/api/pages/${pageId}/screenshot`, {
            fileId: workflowState.screenshotFileId,
            jobId: jobId
          }, {
            timeout: 10000,
            headers: this.getAuthHeaders()
          });

          console.log(`[WorkflowAnalyzer] ✅ Page ${pageId} updated with screenshot`);
        }
      } catch (error) {
        console.error(`[WorkflowAnalyzer] ❌ Failed to upload screenshot: ${error.message}`);
      }
    }

    this.storeStepResult(step, {
      size_bytes: screenshot.length,
      uploaded,
      fileId,
      publicUrl,
      fullPage,
      quality
    }, workflowState);

    // Create screenshot attachment for display in job history
    const screenshotAttachments = [];
    if (uploaded && publicUrl) {
      // If uploaded, create attachment with reference to the uploaded file
      screenshotAttachments.push({
        type: 'screenshot',
        filename: `screenshot_${fileId || Date.now()}.png`,
        screenshot_id: fileId,
        screenshot_url: publicUrl,
        mimeType: 'image/png',
        size: screenshot.length,
        timestamp: new Date().toISOString()
      });
    } else if (screenshot) {
      // If not uploaded, include base64 screenshot data
      screenshotAttachments.push({
        type: 'screenshot',
        filename: `screenshot_${Date.now()}.png`,
        content: screenshot.toString('base64'),
        mimeType: 'image/png',
        size: screenshot.length,
        timestamp: new Date().toISOString()
      });
    }

    await this.logStepOutcome(
      step,
      jobId,
      uploaded
        ? `📸 [SCREENSHOT] Uploaded screenshot (${screenshot.length} bytes)`
        : `📸 [SCREENSHOT] Captured screenshot locally (${screenshot.length} bytes)`,
      {
        uploaded,
        fileId,
        fullPage,
        quality,
        size_bytes: screenshot.length
      },
      'info',
      screenshotAttachments
    );
  }

  /**
   * Execute Playwright analysis step
   */
  async executePlaywrightAnalysisStep(page, step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 🔍 Performing Playwright analysis (${step.name})`);
    
    const analysis = await this.performPlaywrightAnalysis(page);
    workflowState.playwrightAnalysis = analysis;
    
    this.storeStepResult(step, analysis, workflowState);

    const metadata = {
      forms_count: analysis.forms.length,
      links_count: analysis.links.length,
      interactive_count: analysis.interactive_elements.length,
      non_interactive_count: analysis.non_interactive_elements.length
    };

    if (analysis.forms.length > 0) {
      metadata.sample_forms = analysis.forms.slice(0, 3).map(form => form.selector || form.action || 'unknown-form');
    }
    if (analysis.links.length > 0) {
      metadata.sample_links = analysis.links.slice(0, 3).map(link => link.href || link.text || 'unknown-link');
    }
    if (analysis.interactive_elements.length > 0) {
      metadata.sample_interactive = analysis.interactive_elements.slice(0, 3).map(el => el.selector || el.text || el.type || 'interactive');
    }

    await this.logStepOutcome(
      step,
      jobId,
      `📊 [PLAYWRIGHT] Found ${analysis.forms.length} forms, ${analysis.links.length} links, ${analysis.interactive_elements.length} interactive elements, ${analysis.non_interactive_elements.length} non-interactive elements`,
      metadata
    );
  }

  resolveStepContext(step, stepContext, fallbackSiblings = null) {
    const info = {
      stepIndex: null,
      siblings: Array.isArray(fallbackSiblings) ? fallbackSiblings : null,
      nextStep: null
    };

    if (typeof stepContext === 'number') {
      info.stepIndex = stepContext;
    } else if (stepContext && typeof stepContext === 'object') {
      if (typeof stepContext.stepIndex === 'number') {
        info.stepIndex = stepContext.stepIndex;
      }
      if (Array.isArray(stepContext.siblings)) {
        info.siblings = stepContext.siblings;
      }
      if (stepContext.nextStep) {
        info.nextStep = stepContext.nextStep;
      }
    }

    if (!Array.isArray(info.siblings) && Array.isArray(this.workflowTemplate?.steps)) {
      info.siblings = this.workflowTemplate.steps;
    }

    if (Array.isArray(fallbackSiblings) && (!Array.isArray(info.siblings) || info.siblings.length === 0)) {
      info.siblings = fallbackSiblings;
    }

    if (Array.isArray(info.siblings) && info.siblings.length > 0) {
      if (info.stepIndex === null || info.stepIndex < 0) {
        const derivedIndex = info.siblings.findIndex(candidate => {
          if (!candidate) return false;
          if (candidate === step) return true;
          if (candidate.id && step.id && candidate.id === step.id) return true;
          if (candidate.name && step.name && candidate.name === step.name) return true;
          return false;
        });
        if (derivedIndex !== -1) {
          info.stepIndex = derivedIndex;
        }
      }

      if (!info.nextStep && info.stepIndex !== null && info.stepIndex >= 0) {
        info.nextStep = info.siblings[info.stepIndex + 1] || null;
      }
    }

    return {
      ...info,
      requirementText: getRequirementTextForNextStep(info.nextStep)
    };
  }

  /**
   * Execute page description step
   */
  async executePageDescriptionStep(page, step, workflowState, jobId, stepContext = null) {
    console.log(`[WorkflowAnalyzer] 📝 Generating page description (${step.name})`);
    
    // Get page title and content if not already collected
    if (!workflowState.pageTitle) {
      workflowState.pageTitle = await page.title();
    }
    if (!workflowState.htmlContent) {
      workflowState.htmlContent = await page.content();
    }
    if (!workflowState.visibleText) {
      workflowState.visibleText = await page.evaluate(() => {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: function(node) {
              const parent = node.parentElement;
              if (!parent) return NodeFilter.FILTER_REJECT;
              const style = window.getComputedStyle(parent);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                return NodeFilter.FILTER_REJECT;
              }
              const text = node.textContent?.trim();
              if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            }
          }
        );
        
        const textNodes = [];
        let node;
        while (node = walker.nextNode()) {
          textNodes.push(node.textContent.trim());
        }
        
        return textNodes.join(' ').replace(/\s+/g, ' ').trim().substring(0, 2000);
      });
    }
    
    // Prompt template MUST be embedded directly in step config
    const customTemplate = step.config?.template || step.config?.user_message_template || null;
    
    if (!customTemplate) {
      throw new Error(`No embedded prompt template found in workflow step "${step.name || step.id}". All prompts must be embedded in workflow step configs.`);
    }
    
    const promptIdentifier = step.id || step.name || 'page-description';
    const promptSource = 'workflow-step';
    const contextInfo = this.resolveStepContext(step, stepContext, this.workflowTemplate?.steps);
    const requirementText = contextInfo.requirementText;
    const decoratedTemplate = appendRequirementToTemplate(customTemplate, requirementText);
    const templateForExecution = this.enforceLegInstructionsInTemplate(decoratedTemplate);
    
    const descriptionPayload = {
      page_title: workflowState.pageTitle,
      page_url: workflowState.pageUrl,
      visible_text: workflowState.visibleText,
      additional_prompt_text: this.context.additional_prompt_text || ''
    };

    const attachments = Array.isArray(step.config?.attachments)
      ? step.config.attachments
      : [];

    if (attachments.includes('interactive_elements') && workflowState.playwrightAnalysis?.interactive_elements) {
      const interactiveElements = workflowState.playwrightAnalysis.interactive_elements.slice(0, 50);
      descriptionPayload.interactive_elements = interactiveElements;
      descriptionPayload.interactive_elements_json = JSON.stringify(interactiveElements, null, 2);
    }

    if (attachments.includes('forms') && workflowState.playwrightAnalysis?.forms) {
      const forms = workflowState.playwrightAnalysis.forms.slice(0, 30);
      descriptionPayload.forms = forms;
      descriptionPayload.forms_json = JSON.stringify(forms, null, 2);
    }

    if (attachments.includes('links') && workflowState.playwrightAnalysis?.links) {
      const links = workflowState.playwrightAnalysis.links.slice(0, 40);
      descriptionPayload.links = links;
      descriptionPayload.links_json = JSON.stringify(links, null, 2);
    }
    
    // Log prompt usage with step information
    const currentStepIndex = contextInfo.stepIndex !== null ? contextInfo.stepIndex : (this.workflowTemplate?.steps?.findIndex(s => s.id === step.id || s.name === step.name) ?? -1);
    await this.logPromptUsage(promptIdentifier, promptSource, templateForExecution, descriptionPayload, {
      step: step,
      stepIndex: currentStepIndex >= 0 ? currentStepIndex : (this.workflowTemplate?.steps?.findIndex(s => s.type === step.type) ?? -1),
      totalSteps: this.workflowTemplate?.steps?.length
    });
    
    try {
      workflowState.pageDescription = await this.aiLogger.makeAICallWithPrompt(
        promptIdentifier,
        descriptionPayload,
        jobId,
        'page-descriptor',
        workflowState.pageUrl,
        null,
        descriptionPayload,
        templateForExecution // Pass decorated template (required - no fallback to database)
      );
      
      // Extract short_description with fallbacks (handle different response structures)
      const shortDescription = workflowState.pageDescription?.short_description ||
                               workflowState.pageDescription?.description ||
                               workflowState.pageDescription?.summary ||
                               workflowState.pageDescription?.short_summary ||
                               (workflowState.pageDescription && typeof workflowState.pageDescription === 'string' ? workflowState.pageDescription : null) ||
                               workflowState.pageTitle ||
                               'Page description generated';
      
      console.log(`[WorkflowAnalyzer] ✅ Page description generated: ${shortDescription}`);
      
      // Ensure pageDescription has short_description if it's missing
      if (workflowState.pageDescription && !workflowState.pageDescription.short_description) {
        workflowState.pageDescription.short_description = shortDescription;
      }
      
      // If the response includes actions/legs, normalize and store them immediately
      const candidateLegs = Array.isArray(workflowState.pageDescription?.legs)
        ? workflowState.pageDescription.legs
        : Array.isArray(workflowState.pageDescription?.actions)
          ? workflowState.pageDescription.actions
          : [];

      let normalizedFromSummary = [];
      if (candidateLegs.length > 0) {
        normalizedFromSummary = this.applyLegsToWorkflowState(candidateLegs, workflowState, 'page-summary');
        if (normalizedFromSummary.length > 0) {
          workflowState.pageDescription.legs = normalizedFromSummary;
          if (!Array.isArray(workflowState.pageDescription.actions) || workflowState.pageDescription.actions.length === 0) {
            workflowState.pageDescription.actions = normalizedFromSummary;
          }
          console.log(`[WorkflowAnalyzer] ✅ Page summary included ${normalizedFromSummary.length} legs`);
        }
      }
      
      // Add to conversation history
      workflowState.conversationHistory.push({
        timestamp: new Date().toISOString(),
        action: 'page-description-generated',
        description: shortDescription
      });
      
      // Log page description to job history
      await this.logPageDescription(jobId, workflowState.pageUrl, workflowState.pageTitle, workflowState.pageDescription, {
        visible_text_length: workflowState.visibleText.length,
        forms_count: workflowState.playwrightAnalysis?.forms?.length || 0,
        interactive_elements_count: workflowState.playwrightAnalysis?.interactive_elements?.length || 0,
        legs_count: Array.isArray(workflowState.pageDescription?.legs) ? workflowState.pageDescription.legs.length : 0
      }, workflowState.htmlContent, workflowState.screenshotBase64);

      this.storeStepResult(step, {
        description: workflowState.pageDescription,
        legs: workflowState.pageDescription?.legs || [],
        visible_text_length: workflowState.visibleText.length,
        attachments: step.config?.attachments || []
      }, workflowState);

      workflowState.aiAnalysisResult = workflowState.aiAnalysisResult || {};
      workflowState.aiAnalysisResult.page_description = workflowState.pageDescription;
      if (normalizedFromSummary.length > 0) {
        workflowState.aiAnalysisResult.legs = normalizedFromSummary;
        workflowState.aiAnalysisResult.source = 'page-summary';
      }

      await this.logStepOutcome(
        step,
        jobId,
        `📝 [PAGE-DESCRIPTION] Generated summary: ${shortDescription}`,
        {
          short_description: shortDescription,
          attachments: step.config?.attachments || [],
          visible_text_length: workflowState.visibleText.length,
          legs_count: Array.isArray(workflowState.pageDescription?.legs) ? workflowState.pageDescription.legs.length : 0
        }
      );
      
    } catch (error) {
      console.warn(`[WorkflowAnalyzer] Failed to generate page description: ${error.message}`);
      workflowState.pageDescription = {
        short_description: `Page: ${workflowState.pageTitle}`,
        full_description: `Analysis of ${workflowState.pageUrl}`,
        purpose: 'Information page',
        conversation_context: 'Analyzing page structure and content'
      };

      workflowState.aiAnalysisResult = workflowState.aiAnalysisResult || {};
      workflowState.aiAnalysisResult.page_description = workflowState.pageDescription;

      this.storeStepResult(step, {
        description: workflowState.pageDescription,
        visible_text_length: workflowState.visibleText?.length || 0,
        attachments: step.config?.attachments || [],
        fallback: true,
        error: error.message
      }, workflowState);

      await this.logStepOutcome(
        step,
        jobId,
        `📝 [PAGE-DESCRIPTION] Fallback description generated due to error`,
        {
          error: error.message,
          fallback: true,
          short_description: workflowState.pageDescription.short_description
        },
        'warn'
      );
    }
  }

  /**
   * Execute AI prompt step
   */
  async executeAIPromptStep(page, step, workflowState, jobId, stepContext = null) {
    console.log(`[WorkflowAnalyzer] 🤖 Executing AI prompt (${step.name})`);
    
    // Prompt template MUST be embedded directly in step config, not fetched from database
    const customTemplate = step.config?.template || step.config?.user_message_template || null;
    const systemMessage = step.config?.system_message || step.config?.system_message_template || null;
    const responseSchema = step.config?.response_schema || null;
    
    if (!customTemplate) {
      throw new Error(`No embedded prompt template found in workflow step "${step.name || step.id}". All prompts must be embedded in workflow step configs.`);
    }
    
    const promptIdentifier = step.id || step.name || 'workflow-step';
    const promptSource = 'workflow-step';
    const contextInfo = this.resolveStepContext(step, stepContext, this.workflowTemplate?.steps);
    const requirementText = contextInfo.requirementText;
    const decoratedTemplate = appendRequirementToTemplate(customTemplate, requirementText);
    
    // Prepare payload based on step configuration
    const stepPayload = {
      page_url: workflowState.pageUrl,
      page_title: workflowState.pageTitle || await page.title(),
      page_content: workflowState.htmlContent || await page.content(),
      additional_prompt_text: this.context.additional_prompt_text || ''
    };
    if (workflowState.inputCredentials) {
      stepPayload.input_credentials = workflowState.inputCredentials;
    }
    
    // Add additional data based on step attachments
    if (step.config?.attachments) {
      if (step.config.attachments.includes('visible_text') && workflowState.visibleText) {
        stepPayload.visible_text = workflowState.visibleText;
      }
      if (step.config.attachments.includes('interactive_elements') && workflowState.playwrightAnalysis) {
        stepPayload.interactive_elements = workflowState.playwrightAnalysis.interactive_elements;
      }
      if (step.config.attachments.includes('forms') && workflowState.playwrightAnalysis) {
        stepPayload.forms = workflowState.playwrightAnalysis.forms;
      }
      if (step.config.attachments.includes('page_description') && workflowState.pageDescription) {
        stepPayload.page_description = workflowState.pageDescription;
      }
      if (step.config.attachments.includes('current_leg') && workflowState.currentLeg) {
        stepPayload.current_leg = workflowState.currentLeg;
      }
      if (step.config.attachments.includes('last_execution_result') && workflowState.lastExecutionResult) {
        stepPayload.execution_result = workflowState.lastExecutionResult;
      }
      if (step.config.attachments.includes('playwright_analysis') && workflowState.playwrightAnalysis) {
        stepPayload.playwright_analysis = workflowState.playwrightAnalysis;
      }
      if (step.config.attachments.includes('url_before_action') && workflowState.urlBeforeAction) {
        stepPayload.url_before_action = workflowState.urlBeforeAction;
        stepPayload.before_url = workflowState.urlBeforeAction;
      }
      if (step.config.attachments.includes('url_after_action') && workflowState.urlAfterAction) {
        stepPayload.url_after_action = workflowState.urlAfterAction;
        stepPayload.after_url = workflowState.urlAfterAction;
      }
    }
    
    // Log prompt usage with step information
    const currentStepIndex = contextInfo.stepIndex !== null ? contextInfo.stepIndex : (this.workflowTemplate?.steps?.findIndex(s => s.id === step.id || s.name === step.name) ?? -1);
    await this.logPromptUsage(promptIdentifier, promptSource, decoratedTemplate, stepPayload, {
      step: step,
      stepIndex: currentStepIndex >= 0 ? currentStepIndex : (this.workflowTemplate?.steps?.findIndex(s => s.type === step.type) ?? -1),
      totalSteps: this.workflowTemplate?.steps?.length
    });
    
    try {
      // Use embedded template from step config (required - no fallback to database)
      const promptConfig = {
        user_message_template: decoratedTemplate,
        system_message: systemMessage,
        response_schema: responseSchema
      };
      
      const aiResponse = await this.aiLogger.makeAICallWithPrompt(
        promptIdentifier,
        stepPayload,
        jobId,
        'workflow-step',
        workflowState.pageUrl,
        null,
        stepPayload,
        promptConfig // Pass full config (required - no fallback to database)
      );
      
      let parsedResponse = aiResponse;
      if (typeof aiResponse === 'string') {
        try {
          parsedResponse = JSON.parse(aiResponse);
        } catch (_) {
          // keep original string when JSON parse fails
        }
      }

      // Debug: Log what was returned
      console.log(`[WorkflowAnalyzer] 🔍 AI Response for step ${step.id}:`, JSON.stringify(parsedResponse, null, 2).substring(0, 500));
      if (parsedResponse && typeof parsedResponse === 'object') {
        console.log(`[WorkflowAnalyzer] 🔍 Response keys: ${Object.keys(parsedResponse).join(', ')}`);
        if (parsedResponse.playwright_script) {
          console.log(`[WorkflowAnalyzer] ✅ playwright_script found: ${parsedResponse.playwright_script.length} chars`);
          // Log to job history
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'info',
              `✅ playwright_script extracted: ${parsedResponse.playwright_script.length} chars`,
              'WORKFLOW-ANALYZER',
              {
                step_id: step.id,
                script_length: parsedResponse.playwright_script.length,
                script_preview: parsedResponse.playwright_script.substring(0, 200),
                script_ends_with: parsedResponse.playwright_script.substring(Math.max(0, parsedResponse.playwright_script.length - 100))
              }
            );
          }

          const cleanedScript = this.cleanScript(parsedResponse.playwright_script);
          if (cleanedScript && cleanedScript.trim().length > 0) {
            workflowState.legScriptToExecute = cleanedScript;
            if (!workflowState.context) {
              workflowState.context = {};
            }
            workflowState.context.legScriptToExecute = cleanedScript;
          }
        } else {
          console.log(`[WorkflowAnalyzer] ⚠️ playwright_script NOT found in response`);
          // Log to job history
          if (jobId && this.backendLogger) {
            await this.backendLogger.appendJobLog(jobId, 'warn',
              `⚠️ playwright_script NOT found in AI response`,
              'WORKFLOW-ANALYZER',
              {
                step_id: step.id,
                response_keys: Object.keys(parsedResponse).join(', '),
                response_preview: JSON.stringify(parsedResponse).substring(0, 500)
              }
            );
          }
        }

        if (!workflowState.legScriptToExecute) {
          const fallbackScript =
            parsedResponse.script ||
            parsedResponse.code ||
            parsedResponse.legScriptToExecute ||
            null;

          if (typeof fallbackScript === 'string' && fallbackScript.trim().length > 0) {
            const cleanedFallback = this.cleanScript(fallbackScript);
            if (cleanedFallback && cleanedFallback.trim().length > 0) {
              workflowState.legScriptToExecute = cleanedFallback;
              if (!workflowState.context) {
                workflowState.context = {};
              }
              workflowState.context.legScriptToExecute = cleanedFallback;
            }
          }

        }
      }

      // Store response in workflow state (legacy key and slug-based)
      workflowState[`${step.name}_response`] = parsedResponse;
      this.storeStepResult(step, parsedResponse, workflowState);
      
      // CRITICAL: For determine_completion step, also store directly by ID for easy access
      if (step.id === 'determine_completion' || step.name?.includes('Determine Login Progress')) {
        if (!workflowState.determine_completion) {
          workflowState.determine_completion = {};
        }
        workflowState.determine_completion.result = parsedResponse;
        
        if (!workflowState.results) {
          workflowState.results = {};
        }
        if (!workflowState.results.determine_completion) {
          workflowState.results.determine_completion = {};
        }
        workflowState.results.determine_completion.result = parsedResponse;
        
        console.log(`[WorkflowAnalyzer] ✅ Stored determine_completion result: status=${parsedResponse?.status || parsedResponse?.completion_status || 'none'}`);
      }
      
      const logPreview = typeof aiResponse === 'string' ? aiResponse.substring(0, 100) : JSON.stringify(parsedResponse).substring(0, 100);
      console.log(`[WorkflowAnalyzer] ✅ AI prompt completed: ${logPreview}...`);
    } catch (aiError) {
      console.error(`[WorkflowAnalyzer] ❌ AI prompt failed: ${aiError.message}`);
      throw aiError;
    }
  }

  /**
   * Execute workflow analysis step
   */
  async executeWorkflowAnalysisStep(page, step, workflowState, jobId, stepContext = null) {
    console.log(`[WorkflowAnalyzer] 🔍 Performing workflow analysis (${step.name})`);
    
    // Prompt template MUST be embedded directly in step config
    const customTemplate = step.config?.template || step.config?.user_message_template || null;
    
    if (!customTemplate) {
      throw new Error(`No embedded prompt template found in workflow step "${step.name || step.id}". All prompts must be embedded in workflow step configs.`);
    }
    
    const promptIdentifier = step.id || step.name || 'workflow-analysis';
    const promptSource = 'workflow-step';
    const contextInfo = this.resolveStepContext(step, stepContext, this.workflowTemplate?.steps);
    const requirementText = contextInfo.requirementText;
    const decoratedTemplate = appendRequirementToTemplate(customTemplate, requirementText);
    const templateForExecution = this.enforceLegInstructionsInTemplate(decoratedTemplate);

    const legsFromPageSummary = Array.isArray(workflowState.pageDescription?.legs)
      ? workflowState.pageDescription.legs
      : null;

    const summaryLegCount = legsFromPageSummary ? legsFromPageSummary.length : 0;
    const existingLegCount = Array.isArray(workflowState.legs) ? workflowState.legs.length : 0;
    console.log(`[WorkflowAnalyzer] ♻️ Summary legs count before workflow-analysis: ${summaryLegCount} (existing legs: ${existingLegCount}, source: ${workflowState.legsSource || 'none'})`);

    if (legsFromPageSummary && legsFromPageSummary.length > 0) {
      if (!Array.isArray(workflowState.legs) || workflowState.legs.length === 0) {
        this.applyLegsToWorkflowState(legsFromPageSummary, workflowState, 'page-summary');
      } else if (workflowState.legsSource !== 'page-summary') {
        this.applyLegsToWorkflowState(legsFromPageSummary, workflowState, 'page-summary');
      }

      console.log(`[WorkflowAnalyzer] ♻️ Reusing ${workflowState.legs.length} legs from page summary; skipping additional workflow-analysis request`);
      workflowState.aiAnalysisResult = workflowState.aiAnalysisResult || {};
      workflowState.aiAnalysisResult.page_description = workflowState.aiAnalysisResult.page_description || workflowState.pageDescription || null;
      workflowState.aiAnalysisResult.legs = workflowState.legs;
      workflowState.aiAnalysisResult.source = workflowState.aiAnalysisResult.source || 'page-summary';
      this.storeStepResult(step, {
        legs: workflowState.legs,
        reusedFrom: 'page-summary'
      }, workflowState);

      await this.logStepOutcome(
        step,
        jobId,
        `🧠 [WORKFLOW-ANALYSIS] Reused ${workflowState.legs.length} legs from page summary`,
        {
          legs_count: workflowState.legs.length,
          reused_from: 'page-summary'
        }
      );
      return;
    }
    
    // Prepare playbook data as JSON strings (trimmed to reasonable sizes for prompts)
    const formsData = Array.isArray(workflowState.playwrightAnalysis?.forms)
      ? workflowState.playwrightAnalysis.forms.slice(0, 20)
      : [];
    const interactiveData = Array.isArray(workflowState.playwrightAnalysis?.interactive_elements)
      ? workflowState.playwrightAnalysis.interactive_elements.slice(0, 30)
      : [];
    const linksData = Array.isArray(workflowState.playwrightAnalysis?.links)
      ? workflowState.playwrightAnalysis.links.slice(0, 40)
      : [];

    const interactiveElementsJson = JSON.stringify({
      forms: formsData,
      interactive_elements: interactiveData,
      links: linksData
    }, null, 2);
    
    const optimizedPayload = {
      page_url: workflowState.pageUrl,
      page_title: workflowState.pageTitle,
      page_description: workflowState.pageDescription,
      interactive_elements_json: interactiveElementsJson,
      forms_json: JSON.stringify(formsData, null, 2),
      links_json: JSON.stringify(linksData, null, 2),
      conversation_history: workflowState.conversationHistory,
      additional_prompt_text: this.context.additional_prompt_text || ''
    };
    
    // Log prompt usage with step information
    const currentStepIndex = contextInfo.stepIndex !== null ? contextInfo.stepIndex : (this.workflowTemplate?.steps?.findIndex(s => s.id === step.id || s.name === step.name) ?? -1);
    await this.logPromptUsage(promptIdentifier, promptSource, templateForExecution, optimizedPayload, {
      step: step,
      stepIndex: currentStepIndex >= 0 ? currentStepIndex : (this.workflowTemplate?.steps?.findIndex(s => s.type === step.type) ?? -1),
      totalSteps: this.workflowTemplate?.steps?.length
    });
    
    try {
      workflowState.aiAnalysisResult = await this.aiLogger.makeAICallWithPrompt(
        promptIdentifier,
        optimizedPayload,
        jobId,
        'workflow-analyzer',
        workflowState.pageUrl,
        null,
        optimizedPayload,
        templateForExecution // Pass decorated template (required - no fallback to database)
      );
      
      if (workflowState.aiAnalysisResult && Array.isArray(workflowState.aiAnalysisResult.legs)) {
        const normalizedLegs = this.applyLegsToWorkflowState(
          workflowState.aiAnalysisResult.legs,
          workflowState,
          step.id || 'workflow-analysis'
        );

        if (normalizedLegs.length === 0) {
          throw new Error('OpenAI did not return valid workflow legs');
        }

        workflowState.aiAnalysisResult.legs = normalizedLegs;
        console.log(`[WorkflowAnalyzer] ✅ Workflow analysis completed: ${normalizedLegs.length} legs identified`);
        this.storeStepResult(step, {
          legs: normalizedLegs,
          aiAnalysis: workflowState.aiAnalysisResult
        }, workflowState);

        await this.logStepOutcome(
          step,
          jobId,
          `🧠 [WORKFLOW-ANALYSIS] Identified ${normalizedLegs.length} workflow legs`,
          {
            legs_count: normalizedLegs.length,
            sample_legs: normalizedLegs.slice(0, 3).map(leg => leg.description || leg.type || 'leg')
          }
        );
      } else {
        throw new Error('OpenAI did not return valid workflow legs');
      }
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Workflow analysis failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute create workflow step
   */
  async executeCreateWorkflowStep(step, workflowState, pageId, projectId, jobId) {
    console.log(`[WorkflowAnalyzer] 📝 Creating workflow document (${step.name})`);
    
    try {
      const workflow = await this.createWorkflow(pageId, projectId, workflowState.pageUrl, workflowState.playwrightAnalysis, jobId);
      workflowState.workflowId = workflow._id;
      console.log(`[WorkflowAnalyzer] ✅ Created workflow: ${workflow._id}${jobId ? ` (linked to job ${jobId})` : ''}`);

      // CRITICAL: Automatically discover page immediately when workflow is created
      // This ensures pages appear in the UI as soon as they're analyzed
      try {
        await this.updatePageDiscovery(
          jobId,
          pageId,
          projectId,
          workflowState.pageUrl,
          {
            title: workflowState.pageTitle,
            workflow_id: workflow._id,
            analyzed: false // Will be marked as analyzed after AI analysis completes
          }
        );
        console.log(`[WorkflowAnalyzer] ✅ Page discovered immediately after workflow creation`);
      } catch (discoveryError) {
        console.warn(`[WorkflowAnalyzer] ⚠️ Failed to discover page immediately: ${discoveryError.message}`);
        // Don't fail the workflow if page discovery fails
      }

      this.storeStepResult(step, {
        workflowId: workflow._id,
        pageId,
        projectId
      }, workflowState);

      await this.logStepOutcome(
        step,
        jobId,
        `📝 [CREATE-WORKFLOW] Created workflow ${workflow._id}`,
        {
          workflow_id: workflow._id,
          page_id: pageId,
          project_id: projectId
        }
      );
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Failed to create workflow: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute update workflow step
   */
  async executeUpdateWorkflowStep(step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 📝 Updating workflow with analysis (${step.name})`);
    
    if (!workflowState.workflowId) {
      throw new Error('No workflow ID available for update');
    }
    
    try {
      const createActions = step.config?.createActions !== false;

      const hasExistingLegs = Array.isArray(workflowState.legs) && workflowState.legs.length > 0;
      const canGenerateFromAnalysis = !!workflowState.playwrightAnalysis;

      if (!hasExistingLegs && canGenerateFromAnalysis) {
        const derivedLegs = this.generateLegsFromPlaywrightAnalysis(
          workflowState.playwrightAnalysis,
          workflowState.pageUrl
        );
        workflowState.legs = derivedLegs;
        console.log(`[WorkflowAnalyzer] ✅ Derived ${derivedLegs.length} default legs from Playwright analysis`);
      } else if (!hasExistingLegs && !canGenerateFromAnalysis) {
        console.warn('[WorkflowAnalyzer] ⚠️ Missing Playwright analysis, unable to derive fallback legs');
        workflowState.legs = [];
      }

      if (!workflowState.aiAnalysisResult) {
        workflowState.aiAnalysisResult = {
          page_description: workflowState.pageDescription || null,
          legs: workflowState.legs
        };
      } else {
        if (!workflowState.aiAnalysisResult.legs && workflowState.legs) {
          workflowState.aiAnalysisResult.legs = workflowState.legs;
        }
        if (!workflowState.aiAnalysisResult.page_description && workflowState.pageDescription) {
          workflowState.aiAnalysisResult.page_description = workflowState.pageDescription;
        }
      }

      const updateResult = await this.updateWorkflowWithAnalysis(
        workflowState.workflowId,
        workflowState.aiAnalysisResult?.page_description || workflowState.pageDescription,
        workflowState.legs,
        createActions,
        jobId  // Pass jobId so actions are linked to the current job
      );
      console.log(`[WorkflowAnalyzer] ✅ Workflow updated with analysis${createActions ? ' (actions created immediately)' : ''}`);

      if (updateResult?.legs && Array.isArray(updateResult.legs)) {
        workflowState.legs = updateResult.legs;
      }

      workflowState.actionsSummary = this.buildActionsSummary(workflowState.legs);
      
      // CRITICAL: Update page discovery immediately after actions are created
      // This ensures the page shows the latest analysis and action count
      if (workflowState.pageId && workflowState.projectId) {
        try {
          await this.updatePageDiscovery(
            jobId,
            workflowState.pageId,
            workflowState.projectId,
            workflowState.pageUrl,
            {
              title: workflowState.pageTitle,
              workflow_id: workflowState.workflowId,
              page_description: workflowState.aiAnalysisResult?.page_description || workflowState.pageDescription,
              analyzed: true,
              ai_analysis: workflowState.aiAnalysisResult,
              actions_summary: workflowState.actionsSummary
            }
          );
          console.log(`[WorkflowAnalyzer] ✅ Page discovery updated with analysis and actions`);
        } catch (discoveryError) {
          console.warn(`[WorkflowAnalyzer] ⚠️ Failed to update page discovery: ${discoveryError.message}`);
          // Don't fail the workflow if page discovery update fails
        }
      }

      this.storeStepResult(step, {
        workflowId: workflowState.workflowId,
        legsUpdated: workflowState.legs?.length || 0,
        createActions,
        updateResult,
        actionsSummary: workflowState.actionsSummary
      }, workflowState);

      await this.logStepOutcome(
        step,
        jobId,
        `📝 [UPDATE-WORKFLOW] Updated workflow ${workflowState.workflowId} (${workflowState.legs?.length || 0} legs, actions: ${createActions ? 'enabled' : 'skipped'})`,
        {
          workflow_id: workflowState.workflowId,
          legs_count: workflowState.legs?.length || 0,
          actions_created: createActions,
          response_has_legs: Array.isArray(updateResult?.legs),
          actions_summary: workflowState.actionsSummary || null
        }
      );
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Failed to update workflow: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute page discovery step
   */
  async executePageDiscoveryStep(step, workflowState, jobId, pageId, projectId) {
    console.log(`[WorkflowAnalyzer] 📡 Updating page discovery (${step.name})`);
    
    const config = step.config || {};
    const includeContent = config.includeContent !== false;
    const includeForms = config.includeForms !== false;
    const includeLinks = config.includeLinks !== false;
    const includeInteractive = config.includeInteractiveElements !== false;
    const includeNonInteractive = config.includeNonInteractiveElements !== false;
    const includeDescription = config.includePageDescription !== false;
    const includeVisibleText = config.includeVisibleText !== false;
    const includeScreenshot = config.includeScreenshot !== false;
    const markAsAnalyzed = config.markAsAnalyzed !== false;
    const includeAiAnalysis = config.includeAiAnalysis !== false;
    const includeActions = config.includeActions === true;
    const actionsScope = config.actionsScope || 'all';
    const saveLegsData = config.saveLegsData === true;
    
    const discoveryData = {
      title: workflowState.pageTitle,
      analyzed: markAsAnalyzed
    };
    
    if (includeContent && workflowState.htmlContent) {
      discoveryData.content = workflowState.htmlContent;
    }
    if (includeForms && workflowState.playwrightAnalysis?.forms) {
      discoveryData.forms = workflowState.playwrightAnalysis.forms;
    }
    if (includeLinks && workflowState.playwrightAnalysis?.links) {
      discoveryData.links = workflowState.playwrightAnalysis.links;
    }
    if (includeInteractive && workflowState.playwrightAnalysis?.interactive_elements) {
      discoveryData.interactive_elements = workflowState.playwrightAnalysis.interactive_elements;
    }
    if (includeNonInteractive && workflowState.playwrightAnalysis?.non_interactive_elements) {
      discoveryData.non_interactive_elements = workflowState.playwrightAnalysis.non_interactive_elements;
    }
    if (includeDescription && workflowState.pageDescription) {
      discoveryData.page_description = workflowState.pageDescription;
    }
    if (includeVisibleText && workflowState.visibleText) {
      discoveryData.visible_text = workflowState.visibleText;
    }
    if (includeScreenshot && workflowState.screenshotFileId) {
      discoveryData.screenshot_file_id = workflowState.screenshotFileId;
    }
    
    if (workflowState.workflowId) {
      discoveryData.workflow_id = workflowState.workflowId;
    }
    
    if (includeAiAnalysis && workflowState.aiAnalysisResult) {
      discoveryData.ai_analysis = {
        page_description: workflowState.aiAnalysisResult.page_description,
        legs_count: workflowState.legs.length,
        analyzed_at: new Date().toISOString()
      };
      discoveryData.analyzed = true;
    }

    const stats = {
      forms: workflowState.playwrightAnalysis?.forms?.length || 0,
      links: workflowState.playwrightAnalysis?.links?.length || 0,
      interactive: workflowState.playwrightAnalysis?.interactive_elements?.length || 0,
      non_interactive: workflowState.playwrightAnalysis?.non_interactive_elements?.length || 0,
      generated_at: new Date().toISOString()
    };

    let actionsSummary = workflowState.actionsSummary;
    if (!actionsSummary) {
      actionsSummary = this.buildActionsSummary(workflowState.legs);
      workflowState.actionsSummary = actionsSummary;
    }

    stats.actions_total = actionsSummary.total;
    stats.actions_completed = actionsSummary.completed;
    stats.actions_failed = actionsSummary.failed;
    stats.actions_pending = actionsSummary.pending;

    discoveryData.page_stats = stats;

    if (includeActions && actionsSummary.total > 0) {
      discoveryData.actions_summary = actionsSummary;
    }

    if (!discoveryData.page_description) {
      const fallbackDescription = this.createFallbackPageDescription(stats, workflowState);
      discoveryData.page_description = fallbackDescription;
      workflowState.pageDescription = fallbackDescription;
    }
    
    const jobIdentifier = workflowState.jobId || jobId;
    const effectiveProjectId = workflowState.projectId || projectId;

    try {
      console.log('[WorkflowAnalyzer] 🚀 Page discovery payload summary:', {
        url: workflowState.pageUrl,
        hasDescription: !!discoveryData.page_description,
        stats,
        actionsSummaryTotal: actionsSummary?.total || 0,
        includeFlags: config
      });
      const resolvedLegId = workflowState.currentLeg?.original_leg_id ||
        workflowState.currentLegOriginalId ||
        workflowState.currentLegResolvedId ||
        workflowState.currentLeg?.leg_id ||
        workflowState.currentLeg?.source_leg_id ||
        workflowState.currentLeg?.id ||
        null;
      const response = await this.updatePageDiscovery(jobIdentifier, pageId, effectiveProjectId, workflowState.pageUrl, discoveryData);
      console.log(`[WorkflowAnalyzer] ✅ Page discovery updated`);
 
      let legSaveResults = null;
      if (saveLegsData && workflowState.workflowId) {
        let legsToSave = Array.isArray(workflowState.legs) ? workflowState.legs : [];
        console.log('[WorkflowAnalyzer] 🧾 Leg save candidates before filtering:', {
          total: Array.isArray(legsToSave) ? legsToSave.length : 0,
          workflowId: workflowState.workflowId,
          legIds: Array.isArray(legsToSave) ? legsToSave.map(leg => leg.leg_id) : []
        });
        console.log('[WorkflowAnalyzer] 🔎 Current leg id for save:', workflowState.currentLeg?.leg_id);
        if (actionsScope === 'current_leg') {
          if (resolvedLegId) {
            legsToSave = legsToSave.filter(leg => leg.leg_id === resolvedLegId || leg.leg_id === workflowState.currentLeg?.leg_id);
          } else if (workflowState.currentLeg?.description) {
            const targetDescription = workflowState.currentLeg.description.toLowerCase();
            legsToSave = legsToSave.filter(leg => (leg.description || '').toLowerCase() === targetDescription);
          }
        }
        console.log('[WorkflowAnalyzer] 📊 Leg iterations snapshot:', legsToSave.map(leg => ({
          leg_id: leg.leg_id,
          iterations: Array.isArray(leg.iterations) ? leg.iterations.length : 0
        })));
        legsToSave = legsToSave.filter(leg => Array.isArray(leg.iterations) && leg.iterations.length > 0);
        console.log('[WorkflowAnalyzer] 🧮 Leg save candidates after filtering:', {
          total: legsToSave.length,
          legIds: legsToSave.map(leg => leg.leg_id)
        });
        if (legsToSave.length > 0) {
          legSaveResults = await this.saveLegIterationsToWorkflow(workflowState, legsToSave, jobId);
        }
      }

      const discoverySummary = {
        included: {
          content: includeContent && !!discoveryData.content,
          visible_text: includeVisibleText && !!discoveryData.visible_text,
          forms: includeForms && !!discoveryData.forms,
          interactive_elements: includeInteractive && !!discoveryData.interactive_elements,
          non_interactive_elements: includeNonInteractive && !!discoveryData.non_interactive_elements,
          links: includeLinks && !!discoveryData.links,
          description: includeDescription && !!discoveryData.page_description,
          ai_analysis: includeAiAnalysis && !!discoveryData.ai_analysis,
          screenshot: includeScreenshot && !!discoveryData.screenshot_file_id,
          actions: includeActions && !!discoveryData.actions_summary
        },
        counts: stats
      };

      await this.logStepOutcome(
        step,
        jobId,
        `📡 [PAGE-DISCOVERY] Upserted page data for ${workflowState.pageUrl}`,
        {
          included: discoverySummary.included,
          counts: discoverySummary.counts,
          analyzed: discoveryData.analyzed,
          page_stats: stats,
          actions_summary: includeActions && actionsSummary.total > 0 ? actionsSummary : null,
          leg_save_results: legSaveResults
        }
      );
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Failed to update page discovery: ${error.message}`);
    }
  }

  async saveLegIterationsToWorkflow(workflowState, legs, jobId) {
    if (!Array.isArray(legs) || legs.length === 0 || !workflowState.workflowId) {
      return null;
    }

    try {
      const legsPayload = JSON.parse(JSON.stringify(legs));

      const response = await axios.post(
        `${this.backendUrl}/api/workflows/${workflowState.workflowId}/save-data`,
        {
          saveLegs: true,
          saveInteractiveElements: false,
          saveNonInteractiveElements: false,
          saveLinks: false,
          saveCookies: false,
          legs: legsPayload,
          job_id: jobId
        },
        {
          headers: this.getAuthHeaders()
        }
      );

      const results = response.data?.results || null;
      if (results) {
        console.log('[WorkflowAnalyzer] 💾 Saved leg iterations via page-discovery:', results.legs || results);
      }
      return results;
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Failed to save leg iterations: ${error.message}`);
      return null;
    }
  }

  /**
   * Execute save-data step - saves discovered data immediately to database
   */
  async executeSaveDataStep(page, step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 💾 Executing save-data step (${step.name})`);
    
    if (!workflowState.workflowId) {
      throw new Error('No workflow ID available for save-data step');
    }
    
    const config = step.config || {};
    
    // Determine what to save based on config
    const saveLegs = config.saveLegs !== false; // Default true
    const saveInteractiveElements = config.saveInteractiveElements === true;
    const saveNonInteractiveElements = config.saveNonInteractiveElements === true;
    const saveLinks = config.saveLinks === true;
    const saveCookies = config.saveCookies === true;
    
    // Collect data from workflowState
    const legs = workflowState.legs || [];
    const interactiveElements = workflowState.playwrightAnalysis?.interactive_elements || [];
    const nonInteractiveElements = workflowState.playwrightAnalysis?.non_interactive_elements || [];
    const links = workflowState.playwrightAnalysis?.links || [];
    
    // Get cookies from page context
    let cookies = [];
    if (saveCookies) {
      try {
        const pageCookies = await page.context().cookies();
        cookies = pageCookies;
      } catch (error) {
        console.warn(`[WorkflowAnalyzer] Failed to collect cookies: ${error.message}`);
      }
    }
    
    // Prepare payload
    const payload = {
      saveLegs,
      saveInteractiveElements,
      saveNonInteractiveElements,
      saveLinks,
      saveCookies,
      legs: saveLegs ? legs : [],
      interactiveElements: saveInteractiveElements ? interactiveElements : [],
      nonInteractiveElements: saveNonInteractiveElements ? nonInteractiveElements : [],
      links: saveLinks ? links : [],
      cookies: saveCookies ? cookies : [],
      job_id: jobId
    };
    
    try {
      const response = await axios.post(
        `${this.backendUrl}/api/workflows/${workflowState.workflowId}/save-data`,
        payload,
        {
          headers: this.getAuthHeaders()
        }
      );
      
      const results = response.data?.results || {};
      
      console.log(`[WorkflowAnalyzer] ✅ Saved data:`, {
        legs: results.legs,
        actions: results.actions,
        page: results.page,
        cookies: results.cookies
      });
      
      this.storeStepResult(step, {
        success: true,
        results
      }, workflowState);
      
      await this.logStepOutcome(
        step,
        jobId,
        `💾 [SAVE-DATA] Saved ${results.legs?.created || 0} new legs, ${results.legs?.updated || 0} updated legs, ${results.actions?.created || 0} new actions, ${results.actions?.updated || 0} updated actions`,
        {
          results,
          config: {
            saveLegs,
            saveInteractiveElements,
            saveNonInteractiveElements,
            saveLinks,
            saveCookies
          }
        }
      );
      
      return results;
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Failed to save data: ${error.message}`);
      throw error;
    }
  }

  /**
   * Store step result by slug
   */
  storeStepResult(step, result, workflowState) {
    const slug = step.slug || this.generateSlug(step.name || 'step');
    if (!workflowState[slug]) {
      workflowState[slug] = {};
    }
    workflowState[slug].result = result;
    workflowState[slug].stepName = step.name;
    workflowState[slug].stepType = step.type;
    // Also store by name for backward compatibility
    workflowState[`${step.name}_result`] = result;
    
    // Also store by step ID if it exists (for nested steps in for-each)
    if (step.id) {
      if (!workflowState.results) {
        workflowState.results = {};
      }
      if (!workflowState.results[step.id]) {
        workflowState.results[step.id] = {};
      }
      workflowState.results[step.id].result = result;
      workflowState.results[step.id].stepName = step.name;
      workflowState.results[step.id].stepType = step.type;
      
      // Also store directly on workflowState for easier access
      workflowState[step.id] = {
        result,
        stepName: step.name,
        stepType: step.type
      };
    }
  }

  /**
   * Generate slug from name
   */
  generateSlug(name) {
    if (!name) return 'step';
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 50);
  }

  /**
   * Resolve path with slug support
   * Supports both slug-based paths (e.g., "generate-login-code.playwright_code") 
   * and direct paths (e.g., "lastAIResponse.playwright_code")
   */
  resolvePath(path, workflowState) {
    // Remove workflowState. prefix if present
    const normalizedPath = path.startsWith('workflowState.')
      ? path.substring('workflowState.'.length)
      : path;
    
    // Check if path starts with a step slug (slug-based reference)
    const parts = normalizedPath.split('.');
    if (parts.length > 0) {
      const firstPart = parts[0];
      // Check if first part matches any step slug
      const stepSlug = Object.keys(workflowState).find(key => {
        const stepData = workflowState[key];
        return stepData && stepData.stepName && this.generateSlug(stepData.stepName) === firstPart;
      }) || Object.keys(workflowState).find(key => {
        return this.generateSlug(key) === firstPart;
      });
      
      if (stepSlug && workflowState[stepSlug]) {
        // It's a slug-based reference
        const stepData = workflowState[stepSlug];
        if (parts.length === 1) {
          // Just the slug - return the whole step data
          return stepData;
        } else {
          // Slug with path - resolve the nested path
          const remainingPath = parts.slice(1).join('.');
          return this.getNestedValue(stepData, remainingPath);
        }
      }
    }
    
    // Fall back to direct path resolution
    return this.getNestedValue(workflowState, normalizedPath);
  }

  /**
   * Check if script ends with an incomplete string literal
   * Returns true if there's an unmatched quote at the end
   */
  checkIncompleteString(script) {
    if (!script || typeof script !== 'string') {
      return false;
    }
    
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inTemplateLiteral = false;
    let escapeNext = false;
    
    for (let i = 0; i < script.length; i++) {
      const char = script[i];
      
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      
      if (char === '\\') {
        escapeNext = true;
        continue;
      }
      
      // Handle template literals first (they can contain ${})
      if (char === '`' && !inSingleQuote && !inDoubleQuote) {
        inTemplateLiteral = !inTemplateLiteral;
        continue;
      }
      
      // Only check single/double quotes if not in template literal
      if (!inTemplateLiteral) {
        if (char === "'" && !inDoubleQuote) {
          inSingleQuote = !inSingleQuote;
        } else if (char === '"' && !inSingleQuote) {
          inDoubleQuote = !inDoubleQuote;
        }
      }
    }
    
    // If we're still inside a string at the end, it's incomplete
    return inSingleQuote || inDoubleQuote || inTemplateLiteral;
  }

  /**
   * Clean script to remove markdown code blocks and function declarations
   */
  cleanScript(script) {
    if (!script || typeof script !== 'string') {
      return script;
    }
    
    let cleaned = script.trim();
    // Preserve async IIFE wrappers (return await (async () => { ... })()) to avoid breaking structure
    const asyncIifePattern = /^return\s+await\s+\(async\s*\(\)\s*=>\s*\{/;
    if (asyncIifePattern.test(cleaned)) {
      return cleaned;
    }
    
    // First, extract code from markdown code blocks if present
    const codeBlockRegex = /```[\w]*\s*\n?([\s\S]*?)\n?```/g;
    const codeBlockMatches = [...cleaned.matchAll(codeBlockRegex)];
    if (codeBlockMatches.length > 0) {
      cleaned = codeBlockMatches.map(match => match[1]).join('\n\n');
    } else {
      cleaned = cleaned.replace(/^```[\w]*\s*\n?/gm, '');
      cleaned = cleaned.replace(/\n?\s*```$/gm, '');
      cleaned = cleaned.replace(/^\s*```[\w]*\s*$/gm, '');
      cleaned = cleaned.replace(/```[\w]*/g, '');
    }
    
    // Extract function bodies instead of removing functions completely
    const extractFunctionBodies = (text) => {
      const patterns = [
        /async\s+function\s*\([^)]*\)\s*\{/g,
        /async\s+function\s+\w+\s*\([^)]*\)\s*\{/g,
        /function\s*\([^)]*\)\s*\{/g,
        /function\s+\w+\s*\([^)]*\)\s*\{/g
      ];
      
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
          const start = match.index;
          const openBracePos = match.index + match[0].length - 1;
          let braceCount = 1;
          let pos = openBracePos + 1;
          const bodyStart = pos;
          
          while (braceCount > 0 && pos < text.length) {
            if (text[pos] === '{') braceCount++;
            else if (text[pos] === '}') braceCount--;
            pos++;
          }
          
          if (braceCount === 0) {
            const bodyEnd = pos - 1;
            const functionBody = text.slice(bodyStart, bodyEnd).trim();
            text = text.slice(0, start) + functionBody + text.slice(pos);
            pattern.lastIndex = 0;
          }
        }
      }
      
      return text;
    };
    
    cleaned = extractFunctionBodies(cleaned);
    
    // Remove IIFE wrappers
    cleaned = cleaned.replace(/\(async\s*\([^)]*\)\s*=>\s*\{/g, '');
    cleaned = cleaned.replace(/\(async\s+function\s*\([^)]*\)\s*\{[^}]*\}\)\s*\(\)/g, '');
    cleaned = cleaned.replace(/\(async\s*\(\)\s*=>\s*\{[^}]*\}\)\s*\(\)/g, '');
    
    // Remove require statements
    cleaned = cleaned.replace(/const\s+\{[^}]*\}\s*=\s*require\s*\([^)]*\)\s*;?\s*/g, '');
    cleaned = cleaned.replace(/const\s+\w+\s*=\s*require\s*\([^)]*\)\s*;?\s*/g, '');
    cleaned = cleaned.replace(/require\s*\([^)]*\)\s*;?\s*/g, '');
    
    // Remove module.exports
    cleaned = cleaned.replace(/module\.exports\s*=\s*[^;]+;?\s*/g, '');
    cleaned = cleaned.replace(/module\.exports\s*=\s*async\s+function[^}]*\}/g, '');
    
    // Remove browser/page creation
    cleaned = cleaned.replace(/const\s+browser\s*=\s*await\s+chromium\.launch[^;]+;?\s*/g, '');
    cleaned = cleaned.replace(/const\s+page\s*=\s*await\s+browser\.newPage[^;]+;?\s*/g, '');
    cleaned = cleaned.replace(/const\s+context\s*=\s*await\s+browser\.newContext[^;]+;?\s*/g, '');
    cleaned = cleaned.replace(/const\s+page\s*=\s*await\s+context\.newPage[^;]+;?\s*/g, '');
    cleaned = cleaned.replace(/await\s+browser\.close[^;]+;?\s*/g, '');
    cleaned = cleaned.replace(/await\s+context\.close[^;]+;?\s*/g, '');
    
    // Remove template variables
    cleaned = cleaned.replace(/\{\{[^}]+\}\}/g, '');
    
    // Remove comments
    cleaned = cleaned.replace(/\/\/[^\n]*/g, '');
    cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
    
    // Clean up extra whitespace
    cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n');
    cleaned = cleaned.trim();
    
    // If the script is wrapped in braces, unwrap them
    if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
      cleaned = cleaned.slice(1, -1).trim();
    }
    
    return cleaned;
  }

  /**
   * Execute code step (static code)
   */
  async executeCodeStep(page, step, workflowState, jobId = null, nextStep = null) {
    const startTime = Date.now();
    console.log(`[WorkflowAnalyzer] 🚀 Executing static code (${step.name})`);
    
    // Log execution start
    if (jobId) {
      try {
        await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
          jobId: jobId,
          level: 'debug',
          message: `🚀 Starting code execution: ${step.name}`,
          component: 'WORKFLOW-ANALYZER',
          metadata: {
            step_id: step.id,
            step_name: step.name,
            step_type: 'execute-code',
            page_url: page.url()
          }
        }, {
          headers: this.getAuthHeaders()
        });
      } catch (e) {
        // Silent fail - don't block execution
      }
    }
    
    let code = step.config?.code || step.code;
    const originalCodeLength = code?.length || 0;
    
    if (!code) {
      if (jobId) {
        try {
          await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'error',
            message: `❌ No code provided for step: ${step.name}`,
            component: 'WORKFLOW-ANALYZER',
            metadata: { step_id: step.id, step_name: step.name }
          }, {
            headers: this.getAuthHeaders()
          });
        } catch (e) {}
      }
      throw new Error(`No code provided for step: ${step.name}`);
    }
    
    // Clean the code to remove markdown code blocks and function declarations
    code = this.cleanScript(code);
    const cleanedCodeLength = code?.length || 0;
    
    if (!code || code.trim().length === 0) {
      if (jobId) {
        try {
          await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'error',
            message: `❌ Script is empty after cleaning for step: ${step.name}`,
            component: 'WORKFLOW-ANALYZER',
            metadata: {
              step_id: step.id,
              step_name: step.name,
              original_code_length: originalCodeLength,
              cleaned_code_length: cleanedCodeLength,
              original_code_preview: step.config?.code?.substring(0, 500) || step.code?.substring(0, 500) || 'N/A'
            }
          }, {
            headers: this.getAuthHeaders()
          });
        } catch (e) {}
      }
      throw new Error(`Script is empty after cleaning for step: ${step.name}`);
    }
    
    // Log cleaned code info
    if (jobId) {
      try {
        await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
          jobId: jobId,
          level: 'debug',
          message: `📝 Code cleaned (${originalCodeLength} → ${cleanedCodeLength} chars)`,
          component: 'WORKFLOW-ANALYZER',
          metadata: {
            step_id: step.id,
            step_name: step.name,
            cleaned_code_preview: code.substring(0, 500),
            cleaning_removed_chars: originalCodeLength - cleanedCodeLength
          }
        }, {
          headers: this.getAuthHeaders()
        });
      } catch (e) {}
    }
    
    try {
      const timeout = step.config?.timeout || 30000;
      const urlBefore = page.url();
      const titleBefore = await page.title();
      
      // Log execution start
      if (jobId) {
        try {
          await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'debug',
            message: `▶️ Executing code in browser context...`,
            component: 'WORKFLOW-ANALYZER',
            metadata: {
              step_id: step.id,
              step_name: step.name,
              url_before: urlBefore,
              title_before: titleBefore,
              timeout_ms: timeout
            }
          }, {
            headers: this.getAuthHeaders()
          });
        } catch (e) {}
      }
      
      const result = await page.evaluate(
        ({ code, workflowState, timeout }) => {
          // Extract commonly used variables from workflowState for direct access in browser context
          const analysis = workflowState?.analysis || workflowState?.playwrightAnalysis || {};
          const playwrightAnalysis = workflowState?.playwrightAnalysis || {};
          const collectedLinks = workflowState?.collectedLinks || playwrightAnalysis?.links || [];
          const collectedForms = workflowState?.collectedForms || playwrightAnalysis?.forms || [];
          const collectedInteractiveElements = workflowState?.collectedInteractiveElements || playwrightAnalysis?.interactive_elements || [];
          const visibleText = workflowState?.visibleText || workflowState?.visible_text || '';
          const interactiveElements = workflowState?.interactiveElements || workflowState?.interactive_elements || [];
          const forms = workflowState?.forms || [];
          const links = workflowState?.links || [];
          const pageUrl = workflowState?.pageUrl || workflowState?.page_url || '';
          const pageTitle = workflowState?.pageTitle || workflowState?.page_title || '';
          const pageDescription = workflowState?.pageDescription || workflowState?.page_description || '';
          const currentLeg = workflowState?.currentLeg || {};
          const currentItem = workflowState?.currentItem || {};
          const legsToExecute = workflowState?.legsToExecute || workflowState?.legs || [];
          const context = workflowState?.context || {};
          const lastExecutionResult = workflowState?.lastExecutionResult || null;
          const executionResult = lastExecutionResult;
          // Extract step results from workflowState (all stored step results)
          const results = workflowState?.results || {};
          // Common step result variables that might be referenced
          // Try multiple possible locations for playwright analysis result
          let playwrightStepResult = workflowState?.playwright_analysis?.result || 
            workflowState?.playwrightAnalysis || 
            results?.playwright_analysis?.result ||
            workflowState?.playwright_analysis ||
            {};
          // Try to find any step with playwright in its name/id
          if (!playwrightStepResult || typeof playwrightStepResult !== 'object' || Object.keys(playwrightStepResult).length === 0) {
            for (const [key, value] of Object.entries(workflowState)) {
              if (key && typeof key === 'string' && 
                  (key.includes('playwright') || key.includes('analysis')) && 
                  value && typeof value === 'object' && 
                  (value.result || value.forms || value.links || value.interactive_elements)) {
                playwrightStepResult = value.result || value;
                break;
              }
            }
          }
          // Fallback to empty object if still not found
          if (!playwrightStepResult || typeof playwrightStepResult !== 'object') {
            playwrightStepResult = {};
          }
          const stepResult = lastExecutionResult || {};
          
          // Create runner function with all extracted variables available in scope
          const runner = new Function(
            'workflowState',
            'analysis',
            'playwrightAnalysis',
            'collectedLinks',
            'collectedForms',
            'collectedInteractiveElements',
            'visibleText',
            'interactiveElements',
            'forms',
            'links',
            'pageUrl',
            'pageTitle',
            'pageDescription',
            'currentLeg',
            'currentItem',
            'legsToExecute',
            'context',
            'lastExecutionResult',
            'executionResult',
            'results',
            'playwrightStepResult',
            'stepResult',
            `return (async () => {\n${code}\n})();`
          );

          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error(`Code execution timed out after ${timeout}ms`));
            }, timeout);

            Promise.resolve(runner(
              workflowState,
              analysis,
              playwrightAnalysis,
              collectedLinks,
              collectedForms,
              collectedInteractiveElements,
              visibleText,
              interactiveElements,
              forms,
              links,
              pageUrl,
              pageTitle,
              pageDescription,
              currentLeg,
              currentItem,
              legsToExecute,
              context,
              lastExecutionResult,
              executionResult,
              results,
              playwrightStepResult,
              stepResult
            ))
              .then(result => {
                clearTimeout(timer);
                resolve(result);
              })
              .catch(error => {
                clearTimeout(timer);
                reject(error);
              });
          });
        },
        { code, workflowState, timeout }
      );
      
      const urlAfter = page.url();
      const titleAfter = await page.title();
      const executionTime = Date.now() - startTime;
      
      // Log successful execution
      if (jobId) {
        try {
          await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'info',
            message: `✅ Code executed successfully (${executionTime}ms): ${step.name}`,
            component: 'WORKFLOW-ANALYZER',
            metadata: {
              step_id: step.id,
              step_name: step.name,
              execution_time_ms: executionTime,
              url_before: urlBefore,
              url_after: urlAfter,
              title_before: titleBefore,
              title_after: titleAfter,
              url_changed: urlBefore !== urlAfter,
              title_changed: titleBefore !== titleAfter,
              result_preview: typeof result === 'object' ? JSON.stringify(result).substring(0, 500) : String(result).substring(0, 500)
            }
          }, {
            headers: this.getAuthHeaders()
          });
        } catch (e) {}
      }
      
      workflowState.lastExecutionResult = result;
      if (result && typeof result === 'object') {
        const scriptFromResult = result.legScriptToExecute || result.script || result.playwright_script || result.code || null;
        if (typeof scriptFromResult === 'string' && scriptFromResult.trim().length > 0) {
          workflowState.legScriptToExecute = scriptFromResult;
          if (!workflowState.context) {
            workflowState.context = {};
          }
          workflowState.context.legScriptToExecute = scriptFromResult;
        }
      }
      
      // If result contains workflowState updates (like legsToExecute, context updates), merge them
      const resultType = typeof result;
      const isResultArray = Array.isArray(result);
      const resultKeys = result && typeof result === 'object' && !Array.isArray(result) ? Object.keys(result) : [];
      
      console.log(`[WorkflowAnalyzer] 🔍 Checking result for merge - type: ${resultType}, isArray: ${isResultArray}, keys: ${resultKeys.join(', ') || 'N/A'}`);
      
      try {
        const resultStr = JSON.stringify(result);
        console.log(`[WorkflowAnalyzer] 🔍 Result preview: ${resultStr.substring(0, 500)}${resultStr.length > 500 ? '...' : ''}`);
      } catch (e) {
        console.log(`[WorkflowAnalyzer] ⚠️ Could not stringify result: ${e.message}`);
        console.log(`[WorkflowAnalyzer] 🔍 Result:`, result);
      }
      
      // Check if result has legsToExecute (handle both object and array results)
      let resultObj = result;
      if (isResultArray) {
        // If result is an array, check if it's actually legsToExecute
        if (result.length > 0) {
          const firstItem = result[0];
          const firstItemKeys = typeof firstItem === 'object' && firstItem !== null ? Object.keys(firstItem) : [];
          console.log(`[WorkflowAnalyzer] 🔍 Array result: length=${result.length}, first item keys: ${firstItemKeys.join(', ')}`);
          
          if (typeof firstItem === 'object' && firstItem !== null && (firstItem.leg_id || firstItem.legId || firstItem.id || firstItem.type)) {
            // It's an array of leg objects - wrap it
            resultObj = { legsToExecute: result };
            console.log(`[WorkflowAnalyzer] 🔄 Wrapped array result into object with legsToExecute (${result.length} items)`);
          } else {
            console.log(`[WorkflowAnalyzer] ⚠️ Result is array but doesn't appear to be legs. Length: ${result.length}, first item type: ${typeof firstItem}, keys: ${firstItemKeys.join(',') || 'N/A'}`);
            // Check if it's an array containing a single object with legsToExecute
            if (result.length === 1 && typeof result[0] === 'object' && result[0] !== null && result[0].legsToExecute) {
              console.log(`[WorkflowAnalyzer] 🔄 Found legsToExecute in nested array object`);
              resultObj = result[0];
            } else {
              resultObj = null; // Can't extract legsToExecute from this array
            }
          }
        } else {
          console.log(`[WorkflowAnalyzer] ⚠️ Result is empty array`);
          resultObj = null;
        }
      }
      
      if (resultObj && typeof resultObj === 'object' && !Array.isArray(resultObj)) {
        if (resultObj.legsToExecute && Array.isArray(resultObj.legsToExecute)) {
          console.log(`[WorkflowAnalyzer] 📦 Merging legsToExecute: ${resultObj.legsToExecute.length} items`);
          if (resultObj.summary) {
            console.log(`[WorkflowAnalyzer] 📊 Legs summary:`, JSON.stringify(resultObj.summary));
          }
          workflowState.legsToExecute = resultObj.legsToExecute;
          if (!workflowState.context) {
            workflowState.context = {};
          }
          workflowState.context.legsToExecute = resultObj.legsToExecute;
          console.log(`[WorkflowAnalyzer] ✅ Merged legsToExecute into workflowState and context`);
        } else {
          const availableKeys = Object.keys(resultObj);
          console.log(`[WorkflowAnalyzer] ⚠️ Result doesn't have legsToExecute array. Result keys: ${availableKeys.join(', ')}`);
          // Try to find legsToExecute with different naming
          const legsKey = availableKeys.find(k => k.toLowerCase().includes('leg') && k.toLowerCase().includes('execute'));
          if (legsKey && Array.isArray(resultObj[legsKey])) {
            console.log(`[WorkflowAnalyzer] 🔄 Found legsToExecute with different key name: ${legsKey}`);
            workflowState.legsToExecute = resultObj[legsKey];
            if (!workflowState.context) {
              workflowState.context = {};
            }
            workflowState.context.legsToExecute = resultObj[legsKey];
            console.log(`[WorkflowAnalyzer] ✅ Merged legsToExecute from key ${legsKey}`);
          }
        }
        if (resultObj.context && typeof resultObj.context === 'object') {
          workflowState.context = { ...workflowState.context, ...resultObj.context };
        }
        if (resultObj.legs && Array.isArray(resultObj.legs)) {
          workflowState.legs = resultObj.legs;
        }
      } else if (resultObj === null && isResultArray && result.length === 0) {
        console.log(`[WorkflowAnalyzer] ⚠️ Result is empty array - code may have failed or returned nothing`);
      }
      
      this.storeStepResult(step, result, workflowState);
      console.log(`[WorkflowAnalyzer] ✅ Code execution completed: ${JSON.stringify(result).substring(0, 100)}...`);
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error(`[WorkflowAnalyzer] ❌ Code execution failed: ${error.message}`);
      
      // Log execution failure
      if (jobId) {
        try {
          await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'error',
            message: `❌ Code execution failed: ${error.message}`,
            component: 'WORKFLOW-ANALYZER',
            metadata: {
              step_id: step.id,
              step_name: step.name,
              execution_time_ms: executionTime,
              error_message: error.message,
              error_stack: error.stack?.substring(0, 1000),
              code_preview: code?.substring(0, 500) || 'N/A',
              page_url: page.url()
            }
          }, {
            headers: this.getAuthHeaders()
          });
        } catch (e) {
          // Silent fail - don't block error throwing
        }
      }
      
      // If next step is self-adjustable-ai-workflow, don't throw - let workflow continue
      if (nextStep && nextStep.type === 'self-adjustable-ai-workflow') {
        console.log(`[WorkflowAnalyzer] 🔄 Script execution failed, but next step is self-adjustable-ai-workflow - will retry`);
        // Store failure info for retry
        workflowState.lastScriptFailure = {
          step: step,
          error: error.message,
          script: code?.substring(0, 500) || 'N/A',
          timestamp: new Date(),
          executionResult: {
            success: false,
            error: error.message
          }
        };
        return {
          success: false,
          error: error.message
        }; // Return error result instead of throwing
      }
      
      throw error;
    }
  }

  /**
   * Execute code from variable step
   */
  async executeCodeFromVariableStep(page, step, workflowState, jobId, nextStep = null) {
    console.log(`[WorkflowAnalyzer] 🚀 Executing code from variable (${step.name})`);
    
    const sourceField = step.config?.sourceField;
    if (!sourceField) {
      throw new Error(`No sourceField provided for step: ${step.name}`);
    }
    
    // Resolve the path with slug support
    let code = this.resolvePath(sourceField, workflowState);

    // Fall back to workflowState.context if direct resolution failed
    if (!code && workflowState?.context) {
      code = this.resolvePath(sourceField, workflowState.context);
    }

    // Fall back to checking plain context paths (e.g., context.legScriptToExecute)
    if (!code && workflowState?.context) {
      code = this.getNestedValue(workflowState.context, sourceField);
    }

    if (!code) {
      console.warn(`[WorkflowAnalyzer] ⚠️ Unable to resolve code for path "${sourceField}". Available keys:`, Object.keys(workflowState || {}));
      if (workflowState?.context) {
        console.warn(`[WorkflowAnalyzer] ⚠️ Context keys:`, Object.keys(workflowState.context));
      }
      throw new Error(`Code not found at path "${sourceField}" in workflowState for step: ${step.name}`);
    }
    
    console.log(`[WorkflowAnalyzer] 📦 Resolved code from "${sourceField}": ${code ? 'found' : 'not found'}`);
    
    // Clean the code to remove markdown code blocks and function declarations
    code = this.cleanScript(code);
    console.log(`[WorkflowAnalyzer] 🧾 Code preview (${step.name}): ${code.substring(0, 200)}${code.length > 200 ? '…' : ''}`);
    
    if (!code || code.trim().length === 0) {
      throw new Error(`Script is empty after cleaning for step: ${step.name}`);
    }
    
    try {
      const timeout = step.config?.timeout || 30000;
      
      // Capture URL before action
      const urlBeforeAction = page.url();
      workflowState.urlBeforeAction = urlBeforeAction;
      
      // Take screenshot before action
      let screenshotBeforeKey = null;
      try {
        const screenshotBefore = await page.screenshot({ fullPage: true, type: 'png' });
        const presignedBefore = await axios.post(`${this.backendUrl}/api/upload/presigned-url`, {
          type: 'screenshot',
          jobId: jobId,
          contentType: 'image/png'
        }, {
          headers: this.getAuthHeaders()
        });
        
        if (presignedBefore.data.key && presignedBefore.data.url) {
          await axios.put(presignedBefore.data.url, screenshotBefore, {
            headers: { 'Content-Type': 'image/png' },
            maxBodyLength: Infinity,
            maxContentLength: Infinity
          });
          screenshotBeforeKey = presignedBefore.data.key;
          
          // Store screenshot link with action metadata
          const currentLeg = workflowState.currentLeg || {};
          await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'info',
            message: `📸 Screenshot before action: ${step.name} - ${currentLeg.description || 'Action execution'}`,
            component: 'WORKFLOW-STEP',
            metadata: {
              screenshot_type: 'before_action',
              action: step.name,
              leg_id: currentLeg.leg_id,
              leg_description: currentLeg.description,
              screenshot_key: screenshotBeforeKey,
              url: urlBeforeAction
            }
          }, {
            headers: this.getAuthHeaders()
          });
        }
      } catch (screenshotError) {
        console.warn(`[WorkflowAnalyzer] ⚠️ Failed to capture before screenshot: ${screenshotError.message}`);
      }
      
      // Log execution start
      if (jobId) {
        try {
          await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'debug',
            message: `▶️ Executing Playwright script in Node.js context...`,
            component: 'WORKFLOW-ANALYZER',
            metadata: {
              step_id: step.id,
              step_name: step.name,
              url_before: urlBeforeAction,
              timeout_ms: timeout,
              script_length: code.length,
              script_preview: code.substring(0, 300)
            }
          }, {
            headers: this.getAuthHeaders()
          });
        } catch (e) {
          // Silent fail - don't block execution
        }
      }
      
      // Playwright scripts must execute in Node.js context, not browser context
      // The 'page' object is available in Node.js, not in browser
      // Create an async function that has access to the page object
      const executeInNodeContext = async (pageObj, scriptCode) => {
        // Use string concatenation (not template literals) to avoid escaping issues
        // This allows the script code to contain backticks, ${}, etc. without problems
        const functionBody = 'return (async function() {\n' + scriptCode + '\n})();';
        
        // Create a function with page as parameter
        const fn = new Function('page', functionBody);
        return await fn(pageObj);
      };
      
      // Wrap script execution with timeout
      const executionStartTime = Date.now();
      const result = await Promise.race([
        executeInNodeContext(page, code),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Code execution timed out after ${timeout}ms`)), timeout)
        )
      ]);
      
      const executionTime = Date.now() - executionStartTime;
      
      // Log successful execution
      if (jobId) {
        try {
          await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'info',
            message: `✅ Playwright script executed successfully (${executionTime}ms)`,
            component: 'WORKFLOW-ANALYZER',
            metadata: {
              step_id: step.id,
              step_name: step.name,
              execution_time_ms: executionTime,
              url_before: urlBeforeAction,
              url_after: page.url(),
              result_preview: typeof result === 'object' ? JSON.stringify(result).substring(0, 500) : String(result).substring(0, 500)
            }
          }, {
            headers: this.getAuthHeaders()
          });
        } catch (e) {
          // Silent fail - don't block execution
        }
      }
      
      // After executing code, wait for page to stabilize (navigation, DOM updates, etc.)
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {
          console.warn('[WorkflowAnalyzer] Page DOM not fully loaded after 30s, continuing anyway');
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (waitError) {
        console.log(`[WorkflowAnalyzer] ⚠️ Page wait warning: ${waitError.message}`);
      }
      
      // Capture URL after action
      const urlAfterAction = page.url();
      workflowState.urlAfterAction = urlAfterAction;
      const pageChanged = urlBeforeAction !== urlAfterAction;
      
      // Update workflow state with current page URL in case navigation occurred
      if (pageChanged) {
        console.log(`[WorkflowAnalyzer] 🔄 Page navigation detected: ${urlBeforeAction} → ${urlAfterAction}`);
        workflowState.pageUrl = urlAfterAction;
        workflowState.pageTitle = await page.title().catch(() => '');
      }
      
      // Take screenshot after action
      let screenshotAfterKey = null;
      try {
        const screenshotAfter = await page.screenshot({ fullPage: true, type: 'png' });
        const presignedAfter = await axios.post(`${this.backendUrl}/api/upload/presigned-url`, {
          type: 'screenshot',
          jobId: jobId,
          contentType: 'image/png'
        }, {
          headers: this.getAuthHeaders()
        });
        
        if (presignedAfter.data.key && presignedAfter.data.url) {
          await axios.put(presignedAfter.data.url, screenshotAfter, {
            headers: { 'Content-Type': 'image/png' },
            maxBodyLength: Infinity,
            maxContentLength: Infinity
          });
          screenshotAfterKey = presignedAfter.data.key;
          
          // Store screenshot link with action metadata
          const currentLeg = workflowState.currentLeg || {};
          await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
            jobId: jobId,
            level: 'info',
            message: `📸 Screenshot after action: ${step.name} - ${currentLeg.description || 'Action execution'} ${pageChanged ? '(page changed)' : '(same page)'}`,
            component: 'WORKFLOW-STEP',
            metadata: {
              screenshot_type: 'after_action',
              action: step.name,
              leg_id: currentLeg.leg_id,
              leg_description: currentLeg.description,
              screenshot_key: screenshotAfterKey,
              url: urlAfterAction,
              url_before: urlBeforeAction,
              url_after: urlAfterAction,
              page_changed: pageChanged
            }
          }, {
            headers: this.getAuthHeaders()
          });
        }
      } catch (screenshotError) {
        console.warn(`[WorkflowAnalyzer] ⚠️ Failed to capture after screenshot: ${screenshotError.message}`);
      }
      
      const executionResult = {
        ...result,
        urlBeforeAction,
        urlAfterAction,
        pageChanged,
        screenshotBeforeKey,
        screenshotAfterKey
      };
      
      try {
        const execPreview = JSON.stringify(executionResult);
        console.log(`[WorkflowAnalyzer] 🎯 Execution result preview: ${execPreview.substring(0, 300)}${execPreview.length > 300 ? '…' : ''}`);
      } catch (e) {
        console.log('[WorkflowAnalyzer] 🎯 Execution result (non-serializable)', executionResult);
      }

      workflowState.lastExecutionResult = executionResult;
      this.storeStepResult(step, executionResult, workflowState);
      
      console.log(`[WorkflowAnalyzer] ✅ Code execution completed. Page changed: ${pageChanged}`);
      
      return executionResult;
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Code execution failed: ${error.message}`);
      const urlAfterAction = page.url();
      const errorResult = {
        success: false,
        error: error.message,
        urlBeforeAction: workflowState.urlBeforeAction || page.url(),
        urlAfterAction,
        pageChanged: (workflowState.urlBeforeAction || '') !== urlAfterAction
      };
      workflowState.lastExecutionResult = errorResult;
      this.storeStepResult(step, errorResult, workflowState);
      
      // If next step is self-adjustable-ai-workflow, don't throw - let workflow continue
      if (nextStep && nextStep.type === 'self-adjustable-ai-workflow') {
        console.log(`[WorkflowAnalyzer] 🔄 Script execution failed, but next step is self-adjustable-ai-workflow - will retry`);
        // Store failure info for retry
        workflowState.lastScriptFailure = {
          step: step,
          error: error.message,
          script: workflowState[step.config?.sourceField] || null,
          timestamp: new Date(),
          executionResult: errorResult
        };
        return errorResult; // Return error result instead of throwing
      }
      
      throw error;
    }
  }

  /**
   * Get authentication headers for API calls
   */
  getAuthHeaders() {
    const headers = {};
    if (this.context.runner_token) {
      headers['Authorization'] = `Bearer ${this.context.runner_token}`;
    }
    return headers;
  }

  /**
   * Execute cookie add step
   */
  async executeCookieAddStep(step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 🍪 Adding cookie (${step.name})`);
    
    const config = step.config || {};
    if (!config.name || !config.value) {
      throw new Error(`Cookie name and value are required for step: ${step.name}`);
    }

    try {
      // Get project ID from job
      const jobResponse = await axios.get(`${this.backendUrl}/api/jobs/${jobId}`, {
        headers: this.getAuthHeaders()
      });
      // Handle both ObjectId and string formats
      let projectId = null;
      const rawProjectId = jobResponse.data?.project_id;
      if (rawProjectId) {
        projectId = typeof rawProjectId === 'object' && rawProjectId.toString ? rawProjectId.toString() : String(rawProjectId);
      }
      
      // Also try to get from context if API call didn't return it
      if (!projectId && this.context?.project_id) {
        const ctxProjectId = this.context.project_id;
        projectId = typeof ctxProjectId === 'object' && ctxProjectId.toString ? ctxProjectId.toString() : String(ctxProjectId);
        console.log(`[WorkflowAnalyzer] ℹ️ Using project_id from context: ${projectId}`);
      }
      
      if (!projectId) {
        throw new Error(`Could not find project ID for job: ${jobId}`);
      }

      // Get current cookies
      const currentCookiesResponse = await axios.get(`${this.backendUrl}/api/projects/${projectId}/cookies`, {
        headers: this.getAuthHeaders()
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
      await axios.post(`${this.backendUrl}/api/projects/${projectId}/cookies`, {
        cookies: updatedCookies,
        source: 'workflow'
      }, {
        headers: this.getAuthHeaders()
      });

      this.storeStepResult(step, { cookie: newCookie, added: true }, workflowState);
      console.log(`[WorkflowAnalyzer] ✅ Cookie "${config.name}" added successfully`);
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Cookie add failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute cookie update step
   */
  async executeCookieUpdateStep(step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] ✏️ Updating cookie (${step.name})`);
    
    const config = step.config || {};
    if (!config.cookieName || !config.value) {
      throw new Error(`Cookie name and value are required for step: ${step.name}`);
    }

    try {
      // Get project ID from job
      const jobResponse = await axios.get(`${this.backendUrl}/api/jobs/${jobId}`, {
        headers: this.getAuthHeaders()
      });
      // Handle both ObjectId and string formats
      let projectId = null;
      const rawProjectId = jobResponse.data?.project_id;
      if (rawProjectId) {
        projectId = typeof rawProjectId === 'object' && rawProjectId.toString ? rawProjectId.toString() : String(rawProjectId);
      }
      
      // Also try to get from context if API call didn't return it
      if (!projectId && this.context?.project_id) {
        const ctxProjectId = this.context.project_id;
        projectId = typeof ctxProjectId === 'object' && ctxProjectId.toString ? ctxProjectId.toString() : String(ctxProjectId);
        console.log(`[WorkflowAnalyzer] ℹ️ Using project_id from context: ${projectId}`);
      }
      
      if (!projectId) {
        throw new Error(`Could not find project ID for job: ${jobId}`);
      }

      // Get current cookies
      const currentCookiesResponse = await axios.get(`${this.backendUrl}/api/projects/${projectId}/cookies`, {
        headers: this.getAuthHeaders()
      });
      const currentCookies = currentCookiesResponse.data || [];

      // Update cookie
      const updatedCookies = currentCookies.map(cookie => {
        if (cookie.name === config.cookieName) {
          return {
            ...cookie,
            value: config.value,
            domain: config.domain !== undefined ? config.domain : cookie.domain,
            path: config.path !== undefined ? config.path : cookie.path,
            expires: config.expires !== undefined ? config.expires : cookie.expires,
            secure: config.secure !== undefined ? config.secure : cookie.secure,
            httpOnly: config.httpOnly !== undefined ? config.httpOnly : cookie.httpOnly,
            sameSite: config.sameSite !== undefined ? config.sameSite : cookie.sameSite
          };
        }
        return cookie;
      });

      // Check if cookie was found
      const cookieExists = currentCookies.some(c => c.name === config.cookieName);
      if (!cookieExists) {
        throw new Error(`Cookie "${config.cookieName}" not found`);
      }

      // Update project cookies
      await axios.post(`${this.backendUrl}/api/projects/${projectId}/cookies`, {
        cookies: updatedCookies,
        source: 'workflow'
      }, {
        headers: this.getAuthHeaders()
      });

      this.storeStepResult(step, { cookieName: config.cookieName, updated: true }, workflowState);
      console.log(`[WorkflowAnalyzer] ✅ Cookie "${config.cookieName}" updated successfully`);
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Cookie update failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute cookie remove step
   */
  async executeCookieRemoveStep(step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 🗑️ Removing cookie (${step.name})`);
    
    const config = step.config || {};
    const removeAll = config.removeAll || false;
    const cookieName = config.cookieName;

    if (!removeAll && !cookieName) {
      throw new Error(`Cookie name is required or removeAll must be true for step: ${step.name}`);
    }

    try {
      // Get project ID from job
      const jobResponse = await axios.get(`${this.backendUrl}/api/jobs/${jobId}`, {
        headers: this.getAuthHeaders()
      });
      // Handle both ObjectId and string formats
      let projectId = null;
      const rawProjectId = jobResponse.data?.project_id;
      if (rawProjectId) {
        projectId = typeof rawProjectId === 'object' && rawProjectId.toString ? rawProjectId.toString() : String(rawProjectId);
      }
      
      // Also try to get from context if API call didn't return it
      if (!projectId && this.context?.project_id) {
        const ctxProjectId = this.context.project_id;
        projectId = typeof ctxProjectId === 'object' && ctxProjectId.toString ? ctxProjectId.toString() : String(ctxProjectId);
        console.log(`[WorkflowAnalyzer] ℹ️ Using project_id from context: ${projectId}`);
      }
      
      if (!projectId) {
        throw new Error(`Could not find project ID for job: ${jobId}`);
      }

      if (removeAll) {
        // Clear all cookies
        await axios.delete(`${this.backendUrl}/api/projects/${projectId}/cookies`, {
          headers: this.getAuthHeaders()
        });
        this.storeStepResult(step, { removedAll: true }, workflowState);
        console.log(`[WorkflowAnalyzer] ✅ All cookies removed successfully`);
      } else {
        // Remove specific cookie
        const currentCookiesResponse = await axios.get(`${this.backendUrl}/api/projects/${projectId}/cookies`, {
          headers: this.getAuthHeaders()
        });
        const currentCookies = currentCookiesResponse.data || [];

        const updatedCookies = currentCookies.filter(cookie => cookie.name !== cookieName);

        if (updatedCookies.length === currentCookies.length) {
          throw new Error(`Cookie "${cookieName}" not found`);
        }

        await axios.post(`${this.backendUrl}/api/projects/${projectId}/cookies`, {
          cookies: updatedCookies,
          source: 'workflow'
        }, {
          headers: this.getAuthHeaders()
        });

        this.storeStepResult(step, { cookieName, removed: true }, workflowState);
        console.log(`[WorkflowAnalyzer] ✅ Cookie "${cookieName}" removed successfully`);
      }
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Cookie remove failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute cookie collect step
   */
  async executeCookieCollectStep(page, step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 🔍 Collecting cookies (${step.name})`);
    
    const config = step.config || {};
    const source = config.source || 'latest';
    let collectedCookies = []; // Declare early so it's available in catch block

    try {
      let projectId = null;
      
      // If source is 'browser', collect cookies FIRST (before trying to get project_id)
      // This ensures we have cookies even if project_id fetch fails
      if (source === 'browser') {
        if (!page) {
          throw new Error('Browser source requested but Playwright page is not available');
        }
        const contextCookies = await page.context().cookies();
        collectedCookies = contextCookies;
        console.log(`[WorkflowAnalyzer] ✅ Collected ${collectedCookies.length} cookie(s) from browser`);
        
        // Now try to get project_id if we need to save to project
        if (config.saveToProject !== false) {
          try {
            const jobResponse = await axios.get(`${this.backendUrl}/api/jobs/${jobId}`, {
              headers: this.getAuthHeaders()
            });
            // Handle both ObjectId and string formats
            const rawProjectId = jobResponse.data?.project_id;
            if (rawProjectId) {
              projectId = typeof rawProjectId === 'object' && rawProjectId.toString ? rawProjectId.toString() : String(rawProjectId);
            }
            
            // Also try to get from context if API call didn't return it
            if (!projectId && this.context?.project_id) {
              const ctxProjectId = this.context.project_id;
              projectId = typeof ctxProjectId === 'object' && ctxProjectId.toString ? ctxProjectId.toString() : String(ctxProjectId);
              console.log(`[WorkflowAnalyzer] ℹ️ Using project_id from context: ${projectId}`);
            }
          } catch (jobError) {
            console.warn(`[WorkflowAnalyzer] ⚠️ Could not fetch job to get project_id: ${jobError.message}`);
            
            // Try to get from context as fallback
            if (this.context?.project_id) {
              const ctxProjectId = this.context.project_id;
              projectId = typeof ctxProjectId === 'object' && ctxProjectId.toString ? ctxProjectId.toString() : String(ctxProjectId);
              console.log(`[WorkflowAnalyzer] ℹ️ Using project_id from context as fallback: ${projectId}`);
            }
            // Don't throw - we already have cookies
          }
        }
      } else {
        // For non-browser sources, we need project_id first
        try {
          const jobResponse = await axios.get(`${this.backendUrl}/api/jobs/${jobId}`, {
            headers: this.getAuthHeaders()
          });
          // Handle both ObjectId and string formats
          const rawProjectId = jobResponse.data?.project_id;
          if (rawProjectId) {
            // Convert ObjectId to string if needed
            projectId = typeof rawProjectId === 'object' && rawProjectId.toString ? rawProjectId.toString() : String(rawProjectId);
          }
          
          // Also try to get from context if API call didn't return it
          if (!projectId && this.context?.project_id) {
            const ctxProjectId = this.context.project_id;
            projectId = typeof ctxProjectId === 'object' && ctxProjectId.toString ? ctxProjectId.toString() : String(ctxProjectId);
            console.log(`[WorkflowAnalyzer] ℹ️ Using project_id from context: ${projectId}`);
          }
        } catch (jobError) {
          console.warn(`[WorkflowAnalyzer] ⚠️ Could not fetch job to get project_id: ${jobError.message}`);
          
          // Try to get from context as fallback
          if (this.context?.project_id) {
            const ctxProjectId = this.context.project_id;
            projectId = typeof ctxProjectId === 'object' && ctxProjectId.toString ? ctxProjectId.toString() : String(ctxProjectId);
            console.log(`[WorkflowAnalyzer] ℹ️ Using project_id from context as fallback: ${projectId}`);
          } else {
            throw new Error(`Could not find project ID for job: ${jobId}`);
          }
        }
        
        if (!projectId) {
          throw new Error(`Could not find project ID for job: ${jobId}`);
        }
        
        if (source === 'latest') {
          // Collect from latest login job
          const latestCookiesResponse = await axios.get(`${this.backendUrl}/api/projects/${projectId}/latest-cookies`, {
            headers: this.getAuthHeaders()
          });
          collectedCookies = latestCookiesResponse.data || [];
        } else if (source === 'job') {
          // Collect from specific job
          if (!config.jobId) {
            throw new Error(`Job ID is required when source is 'job'`);
          }
          const jobDataResponse = await axios.get(`${this.backendUrl}/api/jobs/${config.jobId}`, {
            headers: this.getAuthHeaders()
          });
          const jobData = jobDataResponse.data;
          if (jobData && jobData.result && jobData.result.cookies) {
            collectedCookies = jobData.result.cookies;
          }
        } else if (source === 'workflowState') {
          // Collect from workflow state
          if (!config.sourceField) {
            throw new Error(`sourceField is required when source is 'workflowState'`);
          }
          const cookiesData = this.resolvePath(config.sourceField, workflowState);
          if (Array.isArray(cookiesData)) {
            collectedCookies = cookiesData;
          } else {
            throw new Error(`Cookies at path "${config.sourceField}" is not an array`);
          }
        }
      }

      // Store collected cookies in workflow state
      if (config.outputVariable) {
        workflowState[config.outputVariable] = collectedCookies;
      }
      workflowState.collectedCookies = collectedCookies;

      // Optionally save to project (only if projectId is available)
      if (config.saveToProject !== false && projectId) {
        try {
          await axios.post(`${this.backendUrl}/api/projects/${projectId}/cookies`, {
            cookies: collectedCookies,
            source: 'workflow'
          }, {
            headers: this.getAuthHeaders()
          });
          console.log(`[WorkflowAnalyzer] ✅ Saved ${collectedCookies.length} cookie(s) to project`);
        } catch (saveError) {
          console.warn(`[WorkflowAnalyzer] ⚠️ Failed to save cookies to project: ${saveError.message}`);
          // Don't throw - cookies are still collected
        }
      }

      this.storeStepResult(step, { cookies: collectedCookies, count: collectedCookies.length }, workflowState);
      console.log(`[WorkflowAnalyzer] ✅ Collected ${collectedCookies.length} cookie(s) successfully`);
    } catch (error) {
      // If we have cookies collected, don't fail the step
      if (collectedCookies && collectedCookies.length > 0) {
        console.warn(`[WorkflowAnalyzer] ⚠️ Cookie collect had errors but cookies were collected: ${error.message}`);
        this.storeStepResult(step, { cookies: collectedCookies }, workflowState);
        console.log(`[WorkflowAnalyzer] ✅ Cookie collection completed despite errors: ${collectedCookies.length} cookie(s)`);
        return; // Success - cookies collected
      }
      console.error(`[WorkflowAnalyzer] ❌ Cookie collect failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute validate response step
   */
  async executeValidateResponseStep(step, workflowState) {
    console.log(`[WorkflowAnalyzer] ✅ Validating response (${step.name})`);
    
    const responseToValidate = workflowState[step.config?.responseField || 'last_ai_response'];
    const schema = step.config?.schema;
    
    if (!responseToValidate) {
      console.log(`[WorkflowAnalyzer] ⚠️ No response to validate for step: ${step.name}`);
      return;
    }
    
    // Basic validation logic - can be enhanced
    if (schema && typeof responseToValidate === 'object') {
      try {
        // Simple validation - check if required fields exist
        const requiredFields = schema.required || [];
        const missingFields = requiredFields.filter(field => !(field in responseToValidate));
        
        if (missingFields.length > 0) {
          throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
        }
        
        console.log(`[WorkflowAnalyzer] ✅ Response validation passed`);
      } catch (error) {
        console.error(`[WorkflowAnalyzer] ❌ Response validation failed: ${error.message}`);
        throw error;
      }
    }
  }

  /**
   * Execute filter response step
   */
  async executeFilterResponseStep(step, workflowState) {
    console.log(`[WorkflowAnalyzer] 🔍 Filtering response (${step.name})`);
    
    const responseToFilter = workflowState[step.config?.responseField || 'last_ai_response'];
    const filter = step.config?.filter;
    
    if (!responseToFilter || !filter) {
      console.log(`[WorkflowAnalyzer] ⚠️ No response or filter to apply for step: ${step.name}`);
      return;
    }
    
    // Basic filtering logic - can be enhanced with jq-like syntax
    try {
      const filteredResponse = this.applyFilter(responseToFilter, filter);
      workflowState[`${step.name}_filtered`] = filteredResponse;
      console.log(`[WorkflowAnalyzer] ✅ Response filtered successfully`);
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Response filtering failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute conditional step
   */
  async executeConditionalStep(step, workflowState) {
    console.log(`[WorkflowAnalyzer] ❓ Evaluating condition (${step.name})`);
    
    const field = step.config?.field;
    const operator = step.config?.operator || '==';
    const value = step.config?.value;
    const responseField = step.config?.responseField || 'last_ai_response';
    
    const responseToCheck = workflowState[responseField];
    if (!responseToCheck) {
      console.log(`[WorkflowAnalyzer] ⚠️ No response to check condition for step: ${step.name}`);
      return;
    }
    
    let conditionMet = false;
    const fieldValue = this.getNestedValue(responseToCheck, field);
    
    switch (operator) {
      case '==':
        conditionMet = fieldValue == value;
        break;
      case '!=':
        conditionMet = fieldValue != value;
        break;
      case '>':
        conditionMet = fieldValue > value;
        break;
      case '<':
        conditionMet = fieldValue < value;
        break;
      case 'contains':
        conditionMet = String(fieldValue).includes(String(value));
        break;
      default:
        console.log(`[WorkflowAnalyzer] ⚠️ Unknown operator: ${operator}`);
    }
    
    console.log(`[WorkflowAnalyzer] ${conditionMet ? '✅' : '❌'} Condition ${field} ${operator} ${value}: ${conditionMet}`);
    
    // Store condition result
    workflowState[`${step.name}_condition_met`] = conditionMet;
  }

  /**
   * Execute complete-leg step - marks a workflow leg as completed
   */
  async executeCompleteLegStep(step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] ✅ Executing complete-leg step (${step.name})`);
    
    const config = step.config || {};
    
    // Get leg ID from config or from currentLeg in workflowState
    const legId = config.legId || config.leg_id || workflowState.currentLeg?.leg_id || workflowState.currentItem?.leg_id;
    
    if (!legId) {
      throw new Error('complete-leg step requires leg_id in config or currentLeg in workflowState');
    }
    
    if (!workflowState.workflowId) {
      throw new Error('complete-leg step requires workflowId in workflowState');
    }
    
    // Determine final result from config or from determine_completion result
    let finalResult = config.final_result || config.finalResult || 'skipped';
    let error = config.error || null;
    
    // Try to get result from determine_completion step if not specified
    if (finalResult === 'skipped' || !config.final_result) {
      const determineResult = workflowState['determine_completion']?.result || 
                              workflowState.results?.['determine_completion']?.result ||
                              workflowState.lastExecutionResult;
      
      if (determineResult) {
        const status = determineResult.status || determineResult.completion_status || 'unknown';
        finalResult = status === 'success' ? 'success' : (status === 'failure' ? 'failure' : 'skipped');
        error = determineResult.error || determineResult.reason || null;
      }
    }
    
    // Try to get result from collect_iteration_data if still not found
    if (finalResult === 'skipped' || !config.final_result) {
      const collectResult = workflowState['collect_iteration_data']?.result || 
                          workflowState.results?.['collect_iteration_data']?.result;
      
      if (collectResult) {
        if (collectResult.legSucceeded !== undefined) {
          finalResult = collectResult.legSucceeded ? 'success' : (collectResult.legFailed ? 'failure' : 'skipped');
        }
      }
    }
    
    try {
      await axios.post(
        `${this.backendUrl}/api/workflows/${workflowState.workflowId}/legs/${legId}/complete`,
        {
          final_result: finalResult,
          error: error
        },
        {
          headers: this.getAuthHeaders()
        }
      );
      
      console.log(`[WorkflowAnalyzer] ✅ Marked leg ${legId} as ${finalResult}`);
      
      // Log to backend
      await this.sendLogToBackend(jobId, 'info', `✅ Leg ${legId} completed with status: ${finalResult}`, 'WORKFLOW-ANALYZER', {
        leg_id: legId,
        final_result: finalResult,
        error: error
      });
      
      this.storeStepResult(step, { 
        leg_id: legId,
        final_result: finalResult,
        error: error,
        completed: true
      }, workflowState);
      
    } catch (completeError) {
      console.error(`[WorkflowAnalyzer] ❌ Failed to mark leg ${legId} as completed: ${completeError.message}`);
      throw completeError;
    }
  }

  /**
   * Execute var-dump step - capture workflow state snapshot
   */
  async executeVarDumpStep(step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 🧾 Executing var-dump step (${step.name})`);

    const config = step.config || {};
    const options = {
      maxDepth: Math.max(1, this.coerceToInteger(config.maxDepth) ?? 4),
      maxArrayLength: Math.max(1, this.coerceToInteger(config.maxArrayLength) ?? 20),
      maxStringLength: Math.max(50, this.coerceToInteger(config.maxStringLength) ?? 1200)
    };

    const { snapshot, scopes, statistics } = this.buildVarDumpSnapshot(step, workflowState, options, config);

    if (!snapshot || Object.keys(snapshot).length === 0) {
      await this.sendLogToBackend(jobId, 'info', '🧾 Var dump skipped (no data)', 'WORKFLOW-VAR-DUMP', {
        step_type: 'var-dump',
        step_name: step.name,
        step_slug: step.slug || null
      });
      return;
    }

    const metadata = {
      step_type: 'var-dump',
      step_name: step.name,
      step_slug: step.slug || null,
      scopes,
      snapshot,
      statistics,
      includeShared: config.includeShared !== false,
      includeCurrentLoop: config.includeCurrentLoop === true,
      includeStepsSummary: config.includeStepsSummary === true,
      includeContext: config.includeContext === true,
      maxDepth: options.maxDepth,
      maxArrayLength: options.maxArrayLength,
      maxStringLength: options.maxStringLength
    };

    try {
      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId,
        level: 'info',
        message: `🧾 [VAR-DUMP] ${step.name || 'Workflow variables'}`,
        component: 'WORKFLOW-VAR-DUMP',
        metadata
      }, {
        headers: this.getAuthHeaders()
      });

      this.storeStepResult(step, {
        dumped_scopes: scopes,
        statistics,
        preview: this.createVarDumpPreview(snapshot)
      }, workflowState);

      console.log(`[WorkflowAnalyzer] ✅ Var dump captured (${scopes.join(', ')})`);
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Var dump step failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute print step - logs a message to job history
   */
  async executePrintStep(step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 📝 Printing message (${step.name})`);
    
    const config = step.config || {};
    const rawMessage = typeof config.message === 'string'
      ? config.message
      : (config.message?.toString?.() ?? 'No message provided');
    const level = config.level || 'info';

    const scope = this.buildTemplateScope(step, workflowState, jobId);
    let message = this.interpolateTemplate(rawMessage, scope);

    const itemsToLog = this.selectItemsForPrint(step, workflowState, scope, config);
    const itemsLabel = config.arrayLabel ||
      config.itemsLabel ||
      (itemsToLog === scope.legsToExecute ? 'Legs' : null) ||
      'Items';
    const formattedItems = Array.isArray(itemsToLog) && itemsToLog.length > 0
      ? this.formatItemsForPrint(itemsToLog, {
          maxItems: this.coerceToInteger(config.maxItemsToLog) ?? 10,
          label: itemsLabel
        })
      : '';

    if (formattedItems) {
      message = `${message}\n${formattedItems}`;
    }

    const metadata = {
      step_name: step.name,
      step_slug: step.slug || null,
      message: message,
      level: level
    };

    if (Array.isArray(itemsToLog) && itemsToLog.length > 0) {
      const preview = this.createItemsPreview(itemsToLog, config);
      metadata.array_path = config.arrayPath || config.itemsPath || 'legsToExecute';
      metadata.array_total = itemsToLog.length;
      if (preview.length > 0) {
        metadata.array_preview = preview;
      }
    }

    const legIndex = scope.currentLegIndex ?? workflowState?.currentLegIndex ?? workflowState?.context?.currentLegIndex;
    if (Number.isInteger(legIndex)) {
      metadata.current_leg_index = legIndex;
    }

    this.enrichPrintMetadata(metadata, scope, workflowState);

    try {
      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: level,
        message: `📝 [PRINT] ${message}`,
        component: 'WORKFLOW-PRINT',
        metadata
      }, {
        headers: this.getAuthHeaders()
      });

      this.storeStepResult(step, { 
        message,
        level,
        printed: true,
        items_logged: Array.isArray(itemsToLog) ? itemsToLog.length : 0
      }, workflowState);
      console.log(`[WorkflowAnalyzer] ✅ Printed message: "${message}" (level: ${level})`);
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Print step failed: ${error.message}`);
      throw error;
    }
  }

  buildTemplateScope(step, workflowState, jobId) {
    const scope = {};

    if (this.context && typeof this.context === 'object') {
      scope.jobContext = this.context;
      Object.entries(this.context).forEach(([key, value]) => {
        scope[key] = value;
      });
    }

    if (workflowState && typeof workflowState === 'object') {
      Object.entries(workflowState).forEach(([key, value]) => {
        scope[key] = value;
      });
    }

    if (workflowState?.context && typeof workflowState.context === 'object') {
      Object.entries(workflowState.context).forEach(([key, value]) => {
        scope[key] = value;
      });
    }

    scope.workflowState = workflowState;
    scope.state = workflowState;
    scope.context = workflowState?.context || {};
    scope.step = step;
    scope.config = step?.config || {};
    scope.jobId = jobId;
    scope.helpers = this.getTemplateHelpers();

    return scope;
  }

  getTemplateHelpers() {
    return {
      json: (value, spacing = 2) => {
        try {
          return JSON.stringify(value, null, spacing);
        } catch (error) {
          return '';
        }
      },
      list: (items, options = {}) => this.formatItemsForPrint(
        Array.isArray(items) ? items : [],
        { maxItems: this.coerceToInteger(options.maxItems) ?? 10, label: options.label }
      ),
      legs: (items, options = {}) => this.formatItemsForPrint(
        Array.isArray(items) ? items : [],
        { maxItems: this.coerceToInteger(options.maxItems) ?? 10, label: options.label || 'Legs' }
      ),
      describeLeg: (leg, index, options = {}) => this.describeLegForPrint(leg, index, options)
    };
  }

  interpolateTemplate(template, scope) {
    if (typeof template !== 'string' || !template.includes('{{')) {
      return template;
    }

    const expressionRegex = /\{\{\s*([^}]+?)\s*\}\}/g;
    return template.replace(expressionRegex, (_, expression) => {
      try {
        const fn = new Function(...Object.keys(scope), `return (${expression});`);
        const result = fn(...Object.values(scope));
        if (result === undefined || result === null) {
          return '';
        }
        if (typeof result === 'object') {
          return JSON.stringify(result, null, 2);
        }
        return String(result);
      } catch (error) {
        console.warn(`[WorkflowAnalyzer] ⚠️ Failed to evaluate print expression "${expression}": ${error.message}`);
        return '';
      }
    });
  }

  selectItemsForPrint(step, workflowState, scope, config) {
    const candidates = [];
    const arraySource = config.arraySource || config.sourceType || 'context';

    if (config.arrayPath) {
      const resolved = this.resolvePathValue(workflowState, config.arrayPath, arraySource);
      if (Array.isArray(resolved)) {
        candidates.push(resolved);
      }
    }

    if (config.itemsPath) {
      const resolvedItemsPath = this.resolvePathValue(workflowState, config.itemsPath, arraySource);
      if (Array.isArray(resolvedItemsPath)) {
        candidates.push(resolvedItemsPath);
      }
    }

    if (Array.isArray(scope.legsToExecute)) {
      candidates.push(scope.legsToExecute);
    }

    if (Array.isArray(workflowState?.legsToExecute)) {
      candidates.push(workflowState.legsToExecute);
    }

    if (Array.isArray(workflowState?.context?.legsToExecute)) {
      candidates.push(workflowState.context.legsToExecute);
    }

    const uniqueCandidates = candidates.filter((array, index, self) => {
      return Array.isArray(array) && array.length > 0 && self.findIndex(candidate => candidate === array) === index;
    });

    return uniqueCandidates.length > 0 ? uniqueCandidates[0] : null;
  }

  formatItemsForPrint(items, options = {}) {
    if (!Array.isArray(items) || items.length === 0) {
      return '';
    }

    const maxItems = Math.max(1, options.maxItems ?? 10);
    const label = options.label || 'Items';
    const limitedItems = items.slice(0, maxItems);
    const lines = limitedItems.map((item, index) => {
      if (item && typeof item === 'object') {
        const identifier = item.leg_id || item.id || item.action_id || item.name || `item_${index}`;
        const type = item.type || item.action_type || 'unknown';
        const description = item.description || item.title || item.text || item.name || item.selector || '';
        const selector = item.selector || item.element_selector || item.elementSelector;
        const parts = [
          `${index + 1}. [${type}] ${description}`.trim()
        ];
        if (identifier) {
          parts.push(`id: ${identifier}`);
        }
        if (selector) {
          parts.push(`selector: ${selector}`);
        }
        return `  ${parts.join(' — ')}`.trimEnd();
      }
      return `  ${index + 1}. ${String(item)}`;
    });

    if (items.length > maxItems) {
      lines.push(`  ... and ${items.length - maxItems} more`);
    }

    return `${label}:\n${lines.join('\n')}`;
  }

  createItemsPreview(items, config = {}) {
    if (!Array.isArray(items) || items.length === 0) {
      return [];
    }

    const previewLimit = Math.max(1, Math.min(this.coerceToInteger(config.previewItems) ?? 5, 20));
    return items.slice(0, previewLimit).map(item => this.summarizeItemForMetadata(item));
  }

  summarizeItemForMetadata(item) {
    if (!item || typeof item !== 'object') {
      return item;
    }

    return {
      id: item.leg_id || item.id || item.action_id || null,
      type: item.type || item.action_type || null,
      description: item.description || item.title || item.text || item.name || null,
      selector: item.selector || item.element_selector || item.elementSelector || null
    };
  }

  describeLegForPrint(leg, index, options = {}) {
    const includeId = options.includeId !== false;
    const includeSelector = options.includeSelector !== false;

    if (!leg || typeof leg !== 'object') {
      if (typeof index === 'number') {
        return `Leg #${index + 1}`;
      }
      return 'Leg';
    }

    const parts = [];

    if (typeof index === 'number') {
      parts.push(`#${index + 1}`);
    } else if (typeof leg.iteration === 'number') {
      parts.push(`#${leg.iteration + 1}`);
    }

    const type = leg.type || leg.action_type;
    if (type) {
      parts.push(`[${type}]`);
    }

    const description = leg.title || leg.description || leg.text || leg.name || leg.selector || leg.action || null;
    if (description) {
      parts.push(description);
    }

    if (includeSelector) {
      const selector = leg.selector || leg.element_selector || leg.elementSelector || null;
      if (selector) {
        parts.push(`selector: ${selector}`);
      }
    }

    if (includeId) {
      const identifier = leg.leg_id || leg.id || leg.action_id || leg.original_leg_id || null;
      if (identifier) {
        parts.push(`id: ${identifier}`);
      }
    }

    if (parts.length === 0) {
      return 'Leg';
    }

    return parts.join(' ');
  }

  enrichPrintMetadata(metadata, scope, workflowState) {
    if (!metadata || typeof metadata !== 'object') {
      return;
    }

    const currentLeg = this.resolveCurrentLeg(scope, workflowState);
    if (currentLeg && typeof currentLeg === 'object') {
      const legSummary = this.summarizeItemForMetadata(currentLeg);
      if (legSummary) {
        metadata.current_leg = legSummary;
      }
      const legId = this.toStringIdentifier(
        currentLeg.leg_id ||
        legSummary?.id ||
        currentLeg.id ||
        currentLeg.original_leg_id ||
        currentLeg.source_leg_id
      );
      if (legId) {
        metadata.current_leg_id = legId;
      }
      const actionId = this.toStringIdentifier(
        currentLeg.action_id ||
        currentLeg.actionId ||
        currentLeg.action?.id ||
        currentLeg.action?._id
      );
      if (actionId) {
        metadata.action_id = actionId;
      }
      const stableActionId = this.toStringIdentifier(
        currentLeg.stable_action_id || currentLeg.stableActionId
      );
      if (stableActionId) {
        metadata.stable_action_id = stableActionId;
      }
      const selector = currentLeg.selector || currentLeg.element_selector || currentLeg.elementSelector;
      if (selector && !metadata.current_selector) {
        metadata.current_selector = selector;
      }
    }

    const currentItem = scope.currentItem || workflowState?.currentItem;
    if (currentItem && typeof currentItem === 'object') {
      const itemSummary = this.summarizeItemForMetadata(currentItem);
      if (itemSummary) {
        metadata.current_item = itemSummary;
      }
      const itemLegId = this.toStringIdentifier(
        currentItem.leg_id ||
        currentItem.id ||
        currentItem.original_leg_id ||
        currentItem.source_leg_id
      );
      if (itemLegId && !metadata.current_leg_id) {
        metadata.current_leg_id = itemLegId;
      }
      const itemActionId = this.toStringIdentifier(
        currentItem.action_id ||
        currentItem.actionId ||
        currentItem.action?.id ||
        currentItem.action?._id
      );
      if (itemActionId && !metadata.action_id) {
        metadata.action_id = itemActionId;
      }
      const itemStableId = this.toStringIdentifier(
        currentItem.stable_action_id || currentItem.stableActionId
      );
      if (itemStableId && !metadata.stable_action_id) {
        metadata.stable_action_id = itemStableId;
      }
    }

    const resolvedLegId = this.toStringIdentifier(
      scope.currentLegResolvedId ||
      workflowState?.currentLegResolvedId
    );
    if (resolvedLegId) {
      metadata.current_leg_resolved_id = resolvedLegId;
    }

    const originalLegId = this.toStringIdentifier(
      scope.currentLegOriginalId ||
      workflowState?.currentLegOriginalId
    );
    if (originalLegId) {
      metadata.current_leg_original_id = originalLegId;
    }
  }

  resolveCurrentLeg(scope, workflowState) {
    if (scope?.currentLeg) {
      return scope.currentLeg;
    }
    if (workflowState?.currentLeg) {
      return workflowState.currentLeg;
    }
    if (workflowState?.context?.currentLeg) {
      return workflowState.context.currentLeg;
    }
    return null;
  }

  toStringIdentifier(value) {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (typeof value === 'object') {
      if (value.$oid && typeof value.$oid === 'string') {
        return value.$oid;
      }
      if (typeof value.toHexString === 'function') {
        try {
          return value.toHexString();
        } catch (error) {
          return null;
        }
      }
      if (value._id || value.id) {
        return this.toStringIdentifier(value._id || value.id);
      }
    }
    return null;
  }

  /**
   * Execute sleep step - pauses execution for specified milliseconds
   */
  async executeSleepStep(step, workflowState) {
    console.log(`[WorkflowAnalyzer] 😴 Sleeping (${step.name})`);
    
    const config = step.config || {};
    const ms = config.ms || 1000;

    if (ms < 0 || ms > 300000) {
      throw new Error(`Sleep duration must be between 0 and 300000ms, got: ${ms}`);
    }

    try {
      await new Promise(resolve => setTimeout(resolve, ms));
      this.storeStepResult(step, { duration: ms, slept: true }, workflowState);
      console.log(`[WorkflowAnalyzer] ✅ Slept for ${ms}ms`);
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Sleep step failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute for-each step - iterate over items and execute nested steps
   */
  async executeForEachStep(page, step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 🔁 Executing for-each step (${step.name})`);
    
    const config = step.config || {};
    const {
      itemsPath,
      sourceType = 'context',
      itemVariable = 'currentItem',
      indexVariable = `${itemVariable}Index`,
      maxItems,
      resultKey: providedResultKey,
      steps: nestedStepsConfig = []
    } = config;

    if (!itemsPath) {
      throw new Error(`for-each step ${step.id || ''} is missing required config.itemsPath`);
    }

    // Resolve items from context or results
    let items = this.resolvePathValue(workflowState, itemsPath, sourceType);
    
    console.log(`[WorkflowAnalyzer] 🔍 For-each resolving items from path "${itemsPath}" (source: ${sourceType})`);
    console.log(`[WorkflowAnalyzer] 🔍 Resolved items: ${Array.isArray(items) ? `array with ${items.length} items` : `not an array (${typeof items})`}`);
    
    // If not found, try multiple fallback locations
    if (!Array.isArray(items)) {
      // Try directly on workflowState (from merge logic)
      if (workflowState.legsToExecute && Array.isArray(workflowState.legsToExecute)) {
        console.log(`[WorkflowAnalyzer] 🔄 Found legsToExecute directly on workflowState (${workflowState.legsToExecute.length} items)`);
        items = workflowState.legsToExecute;
      }
      // Try from context (from merge logic)
      else if (workflowState.context?.legsToExecute && Array.isArray(workflowState.context.legsToExecute)) {
        console.log(`[WorkflowAnalyzer] 🔄 Found legsToExecute in context (${workflowState.context.legsToExecute.length} items)`);
        items = workflowState.context.legsToExecute;
      }
      // Try from legs (alternative name)
      else if (workflowState.legs && Array.isArray(workflowState.legs)) {
        console.log(`[WorkflowAnalyzer] 🔄 Found legs directly on workflowState (${workflowState.legs.length} items)`);
        items = workflowState.legs;
      }
      else if (workflowState.context?.legs && Array.isArray(workflowState.context.legs)) {
        console.log(`[WorkflowAnalyzer] 🔄 Found legs in context (${workflowState.context.legs.length} items)`);
        items = workflowState.context.legs;
      }
      // Try from lastExecutionResult (from previous step)
      else if (workflowState.lastExecutionResult) {
        const lastResult = workflowState.lastExecutionResult;
        if (Array.isArray(lastResult)) {
          // Check if it's an array of leg objects
          if (lastResult.length > 0 && typeof lastResult[0] === 'object' && (lastResult[0].leg_id || lastResult[0].id)) {
            console.log(`[WorkflowAnalyzer] 🔄 Found legsToExecute in lastExecutionResult as array (${lastResult.length} items)`);
            items = lastResult;
          }
        } else if (lastResult && typeof lastResult === 'object') {
          if (lastResult.legsToExecute && Array.isArray(lastResult.legsToExecute)) {
            console.log(`[WorkflowAnalyzer] 🔄 Found legsToExecute in lastExecutionResult object (${lastResult.legsToExecute.length} items)`);
            items = lastResult.legsToExecute;
          } else if (lastResult.legs && Array.isArray(lastResult.legs)) {
            console.log(`[WorkflowAnalyzer] 🔄 Found legs in lastExecutionResult object (${lastResult.legs.length} items)`);
            items = lastResult.legs;
          }
        }
      }
      // Try from previous step result by slug - search all possible slugs
      else {
        const possibleSlugs = ['prepare-legs-for-execution', 'prepare_legs_for_execution', 'workflow-analysis', 'workflow_analysis', 'ai-analysis', 'ai_analysis'];
        let found = false;
        for (const slug of possibleSlugs) {
          const prepareResult = workflowState[slug]?.result || workflowState.results?.[slug]?.result;
          if (prepareResult) {
            if (prepareResult.legsToExecute && Array.isArray(prepareResult.legsToExecute)) {
              items = prepareResult.legsToExecute;
              found = true;
              break;
            } else if (prepareResult.legs && Array.isArray(prepareResult.legs)) {
              items = prepareResult.legs;
              found = true;
              break;
            }
          }
        }
        
        // If still not found, search all workflowState keys for legsToExecute or legs
        if (!found) {
          for (const key of Object.keys(workflowState)) {
            if (workflowState[key] && typeof workflowState[key] === 'object') {
              const stepResult = workflowState[key].result || workflowState[key];
              if (stepResult && typeof stepResult === 'object') {
                if (stepResult.legsToExecute && Array.isArray(stepResult.legsToExecute)) {
                  items = stepResult.legsToExecute;
                  found = true;
                  break;
                } else if (stepResult.legs && Array.isArray(stepResult.legs)) {
                  items = stepResult.legs;
                  found = true;
                  break;
                }
              }
            }
          }
        }
        
        // Update workflowState if found
        if (found && Array.isArray(items)) {
          workflowState.legsToExecute = items;
          if (!workflowState.context) {
            workflowState.context = {};
          }
          workflowState.context.legsToExecute = items;
        }
      }
    }

    if (!Array.isArray(items)) {
      // Log available keys for debugging
      const availableKeys = Object.keys(workflowState || {}).slice(0, 20);
      const contextKeys = workflowState?.context ? Object.keys(workflowState.context).slice(0, 20) : [];
      console.error(`[WorkflowAnalyzer] ❌ For-each step failed to find array. Available workflowState keys: ${availableKeys.join(', ')}`);
      console.error(`[WorkflowAnalyzer] ❌ Available context keys: ${contextKeys.join(', ')}`);
      throw new Error(`for-each step expected an array at path "${itemsPath}" (source: ${sourceType}), got: ${typeof items}. Checked: lastExecutionResult, workflowState.legsToExecute, context.legsToExecute, workflowState.legs, context.legs`);
    }

    const isSingleActionMode =
      workflowState.singleActionOnly === true ||
      workflowState.options?.single_action_only === true ||
      this.context?.single_action_only === true ||
      this.context?.options?.single_action_only === true;

    if (isSingleActionMode && items.length > 1) {
      console.log(`[WorkflowAnalyzer] 🎯 Single-action mode enabled - limiting items from ${items.length} to 1`);
      items = items.slice(0, 1);
      workflowState.legsToExecute = items;
      if (!workflowState.context) {
        workflowState.context = {};
      }
      workflowState.context.legsToExecute = items;
    }

    const numericMaxItems = this.coerceToInteger(maxItems);
    const effectiveItems = numericMaxItems !== null ? items.slice(0, Math.max(numericMaxItems, 0)) : items;
    const resultKey = providedResultKey || `${step.id || 'for_each'}_results`;

    // Save previous values if they exist
    const hadItemVariable = Object.prototype.hasOwnProperty.call(workflowState, itemVariable);
    const previousItemValue = workflowState[itemVariable];
    const hadIndexVariable = Object.prototype.hasOwnProperty.call(workflowState, indexVariable);
    const previousIndexValue = workflowState[indexVariable];

    const nestedStepsArray = Array.isArray(nestedStepsConfig) ? nestedStepsConfig : [];
    const iterationSummaries = [];

    console.log(`[WorkflowAnalyzer] 🔁 Iterating over ${effectiveItems.length} items`);

    for (let idx = 0; idx < effectiveItems.length; idx++) {
      const item = effectiveItems[idx];
      workflowState[itemVariable] = item;
      workflowState[indexVariable] = idx;

      console.log(`[WorkflowAnalyzer] 🔁 Iteration ${idx + 1}/${effectiveItems.length}: Processing item`);
      
      // Report progress: current iteration
      await this.updateJobProgress(jobId, {
        current_iteration: idx + 1,
        total_iterations: effectiveItems.length,
        current_step: null, // Will be updated per nested step
        current_activity: `Iteration ${idx + 1} of ${effectiveItems.length} legs`
      });
      
      // Execute nested steps for this item
      if (nestedStepsArray.length > 0) {
        for (let nestedIdx = 0; nestedIdx < nestedStepsArray.length; nestedIdx++) {
          const nestedStep = nestedStepsArray[nestedIdx];
          
          // Create unique step ID for nested step
          const baseId = nestedStep.id || `nested-${nestedIdx}`;
          const nestedStepId = `${step.id || 'for-each'}::${idx}::${baseId}`;
          
          const nestedStepWithId = {
            ...nestedStep,
            id: nestedStepId,
            originalId: nestedStep.id || baseId
          };
          
          const stepName = nestedStep.name || nestedStep.type || 'Unknown step';
          const stepTypeLabel = nestedStep.type === 'ai-prompt' ? 'AI prompt' : 
                                nestedStep.type === 'execute-code' || nestedStep.type === 'execute-code-from-variable' ? 'Code execution' :
                                nestedStep.type === 'screenshot' ? 'Screenshot' :
                                nestedStep.type === 'playwright-analysis' ? 'Page analysis' :
                                stepName;
          
          console.log(`[WorkflowAnalyzer] 🔁 Executing nested step ${nestedIdx + 1}/${nestedStepsArray.length}: ${stepName} (iteration ${idx + 1})`);
          
          // Report progress: current step
          await this.updateJobProgress(jobId, {
            current_iteration: idx + 1,
            total_iterations: effectiveItems.length,
            current_step: stepName,
            current_activity: `Iteration ${idx + 1} of ${effectiveItems.length} legs • Current step: "${stepName}" (${stepTypeLabel})`
          });
          
          try {
            // Execute nested step using the same switch logic
            await this.executeStepByType(page, nestedStepWithId, workflowState, jobId, {
              stepIndex: nestedIdx,
              siblings: nestedStepsArray
            });
          } catch (nestedError) {
            console.error(`[WorkflowAnalyzer] ❌ Nested step failed in iteration ${idx + 1}: ${nestedError.message}`);
            // Continue with next step unless critical
            if (nestedStep.config?.critical) {
              throw nestedError;
            }
          }
        }
      }

      // Collect step results for this iteration
      const stepResults = nestedStepsArray.map((nestedStep, nestedIndex) => {
        const baseId = nestedStep.id || `nested-${nestedIndex}`;
        const nestedStepId = `${step.id || 'for-each'}::${idx}::${baseId}`;
        return {
          stepId: nestedStepId,
          originalStepId: nestedStep.id || baseId,
          result: workflowState[nestedStepId]
        };
      });

      iterationSummaries.push({
        index: idx,
        item,
        stepResults
      });
    }

    // Restore previous values
    if (hadItemVariable) {
      workflowState[itemVariable] = previousItemValue;
    } else {
      delete workflowState[itemVariable];
    }

    if (hadIndexVariable) {
      workflowState[indexVariable] = previousIndexValue;
    } else {
      delete workflowState[indexVariable];
    }

    // Store results
    workflowState[resultKey] = iterationSummaries;
    if (!workflowState.context) {
      workflowState.context = {};
    }
    workflowState.context[resultKey] = iterationSummaries;

    this.storeStepResult(step, {
      iterations: iterationSummaries,
      totalIterations: iterationSummaries.length,
      resultKey
    }, workflowState);

    console.log(`[WorkflowAnalyzer] ✅ For-each step completed: ${iterationSummaries.length} iterations`);
  }

  /**
   * Execute while-loop step - loops while condition is true
   * General-purpose looping element that can loop based on conditions from code or AI
   */
  async executeWhileLoopStep(page, step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 🔄 Executing while-loop (${step.name})`);
    
    const config = step.config || {};
    const maxIterations = config.maxIterations || 10;
    const conditionPath = config.conditionPath; // Path to check for condition (e.g., 'determine_completion.is_complete')
    const conditionType = config.conditionType || 'code'; // 'code', 'ai-response', or 'path'
    const invertCondition = config.invertCondition === true; // If true, loop while condition is false
    const nestedSteps = config.steps || [];
    
    if (!nestedSteps.length) {
      console.log(`[WorkflowAnalyzer] ⚠️ While-loop has no nested steps`);
      return;
    }
    
    let iteration = 0;
    let condition = true; // Start with true to enter loop
    let lastResult = null;
    
    console.log(`[WorkflowAnalyzer] 🔄 Starting while-loop (max ${maxIterations} iterations)`);
    
    // Send log to backend
    await this.sendLogToBackend(jobId, 'info', `🔄 Starting while-loop (max ${maxIterations} iterations)`, 'WORKFLOW-ANALYZER', {
      step_id: step.id,
      step_name: step.name || step.type,
      step_type: 'while-loop',
      max_iterations: maxIterations,
      condition_path: conditionPath,
      condition_type: conditionType
    });
    
    // Initialize loop state
    if (!workflowState.loopState) {
      workflowState.loopState = {};
    }
    if (!workflowState.loopState[step.id]) {
      workflowState.loopState[step.id] = {
        iterations: [],
        currentIteration: 0
      };
    }
    
    const loopState = workflowState.loopState[step.id];
    
    // Loop while condition is true (or false if inverted) and under max iterations
    while ((invertCondition ? !condition : condition) && iteration < maxIterations) {
      iteration++;
      loopState.currentIteration = iteration;
      // Also set workflowState.currentIteration for use by other steps
      workflowState.currentIteration = iteration;
      
      console.log(`[WorkflowAnalyzer] 🔄 While-loop iteration ${iteration}/${maxIterations}`);
      
      // Send log to backend
      await this.sendLogToBackend(jobId, 'info', `🔄 While-loop iteration ${iteration}/${maxIterations}`, 'WORKFLOW-ANALYZER', {
        step_id: step.id,
        step_name: step.name || step.type,
        step_type: 'while-loop',
        iteration: iteration,
        max_iterations: maxIterations
      });
      
      try {
        // Execute nested steps
        for (let nestedIdx = 0; nestedIdx < nestedSteps.length; nestedIdx++) {
          const nestedStep = nestedSteps[nestedIdx];
          
          try {
            await this.executeStepByType(page, nestedStep, workflowState, jobId, {
              stepIndex: nestedIdx,
              siblings: nestedSteps
            });
          } catch (nestedError) {
            console.error(`[WorkflowAnalyzer] ❌ Nested step ${nestedIdx + 1} failed in iteration ${iteration}: ${nestedError.message}`);
            if (nestedStep.config?.critical) {
              throw nestedError;
            }
          }
        }
        
        // Evaluate condition after nested steps
        if (conditionType === 'code' && config.conditionCode) {
          // Clean the code before execution
          let cleanedCode = this.cleanScript(config.conditionCode);
          if (!cleanedCode || cleanedCode.trim().length === 0) {
            throw new Error('Condition code is empty after cleaning');
          }
          // Execute code to get condition
          const conditionResult = await page.evaluate(
            ({ code, workflowState }) => {
              const runner = new Function('workflowState', `return (${code});`);
              return runner(workflowState);
            },
            { code: cleanedCode, workflowState }
          );
          condition = conditionResult === true || conditionResult === 'true' || conditionResult === 1;
          
        } else if (conditionType === 'ai-response' || conditionType === 'path') {
          // Get condition from workflowState path (check multiple locations)
          let conditionValue = this.resolvePathValue(workflowState, conditionPath || 'determine_completion.status', 'results');
          
          // If not found, try finding the determine_completion step result directly
          if (conditionValue === undefined || conditionValue === null) {
            const determineStepResult = workflowState['determine_completion']?.result || 
                                       workflowState.results?.['determine_completion']?.result ||
                                       workflowState.lastExecutionResult ||
                                       {};
            
            // Extract condition from step result
            if (conditionPath) {
              const pathSegments = conditionPath.split('.');
              let current = determineStepResult;
              for (const segment of pathSegments) {
                if (current && typeof current === 'object') {
                  current = current[segment];
                } else {
                  current = undefined;
                  break;
                }
              }
              conditionValue = current;
            } else {
              // Default: check status, fallback to is_complete
              conditionValue = determineStepResult.status || determineStepResult.is_complete;
            }
          }
          
          if (conditionValue !== undefined && conditionValue !== null) {
            // Support both new status field (success/failure/continue/stuck) and legacy is_complete
            if (typeof conditionValue === 'string') {
              // New format: status field with 'success', 'failure', 'continue', 'stuck'
              const expectedValue = config.conditionValue || 'continue';
              condition = conditionValue === expectedValue;
              console.log(`[WorkflowAnalyzer] 🔍 Checking status: ${conditionValue} === ${expectedValue} → ${condition} (will ${condition ? 'continue' : 'exit'})`);
            } else {
              // Legacy format: boolean is_complete
              condition = conditionValue === true || conditionValue === 'true' || conditionValue === 1 || conditionValue === 'complete';
            }
          } else {
            // If path not found and it's required, default to false (exit loop)
            if (conditionPath) {
              console.log(`[WorkflowAnalyzer] ⚠️ Condition path "${conditionPath}" not found, exiting loop`);
              
              // Send log to backend
              await this.sendLogToBackend(jobId, 'warn', `⚠️ Condition path "${conditionPath}" not found, exiting loop`, 'WORKFLOW-ANALYZER', {
                step_id: step.id,
                step_name: step.name || step.type,
                step_type: 'while-loop',
                condition_path: conditionPath,
                iteration: iteration
              });
              
              condition = invertCondition ? true : false;
            } else {
              // No condition path specified, default to false (exit loop)
              condition = false;
            }
          }
        }
        
        // Record iteration - include determine_completion from workflowState
        const iterationState = {
          iteration,
          condition,
          timestamp: new Date().toISOString(),
          lastResult: workflowState.lastExecutionResult || {},
          determine_completion: workflowState.determine_completion?.result || 
                               workflowState.results?.determine_completion?.result ||
                               workflowState.determine_completion ||
                               null
        };
        loopState.iterations.push(iterationState);
        
        // Also store in lastExecutionResult for next iteration
        if (!workflowState.lastExecutionResult) {
          workflowState.lastExecutionResult = {};
        }
        workflowState.lastExecutionResult.determine_completion = iterationState.determine_completion || 
                                                                workflowState.determine_completion;
        
        console.log(`[WorkflowAnalyzer] 🔄 Iteration ${iteration} complete: condition=${condition} (inverted=${invertCondition}, should continue=${invertCondition ? !condition : condition})`);
        
        // Send log to backend
        await this.sendLogToBackend(jobId, 'info', `🔄 Iteration ${iteration} complete: condition=${condition} (should continue=${invertCondition ? !condition : condition})`, 'WORKFLOW-ANALYZER', {
          step_id: step.id,
          step_name: step.name || step.type,
          step_type: 'while-loop',
          iteration: iteration,
          condition: condition,
          inverted: invertCondition,
          should_continue: invertCondition ? !condition : condition
        });
        
        // Small delay between iterations
        if (iteration < maxIterations && (invertCondition ? !condition : condition)) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
      } catch (iterationError) {
        console.error(`[WorkflowAnalyzer] ❌ Iteration ${iteration} failed: ${iterationError.message}`);
        
        // Send error log to backend
        await this.sendLogToBackend(jobId, 'error', `❌ Iteration ${iteration} failed: ${iterationError.message}`, 'WORKFLOW-ANALYZER', {
          step_id: step.id,
          step_name: step.name || step.type,
          step_type: 'while-loop',
          iteration: iteration,
          error: iterationError.message
        });
        
        loopState.iterations.push({
          iteration,
          error: iterationError.message,
          timestamp: new Date().toISOString()
        });
        
        // Break on critical errors
        if (iterationError.message.includes('critical') || iteration >= maxIterations) {
          break;
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Extract determine_completion result from last iteration and promote to top level
    // CRITICAL: After loop completes, we need to make determine_completion accessible at top level
    let lastDetermineCompletion = null;
    
    // Strategy 1: Check if already stored at top level from last iteration
    lastDetermineCompletion = workflowState.determine_completion?.result || workflowState.determine_completion;
    
    // Strategy 2: Extract from loop iterations
    if ((!lastDetermineCompletion || (!lastDetermineCompletion.status && !lastDetermineCompletion.completion_status)) 
        && loopState.iterations && loopState.iterations.length > 0) {
      const lastIteration = loopState.iterations[loopState.iterations.length - 1];
      
      // Check multiple possible locations in last iteration
      lastDetermineCompletion = 
        lastIteration?.determine_completion?.result ||
        lastIteration?.determine_completion ||
        lastIteration?.lastResult?.determine_completion?.result ||
        lastIteration?.lastResult?.determine_completion ||
        lastDetermineCompletion;
    }
    
    // Strategy 3: Check workflowState.results (by step ID)
    if ((!lastDetermineCompletion || (!lastDetermineCompletion.status && !lastDetermineCompletion.completion_status))
        && workflowState.results?.determine_completion) {
      lastDetermineCompletion = workflowState.results.determine_completion.result ||
                                workflowState.results.determine_completion ||
                                lastDetermineCompletion;
    }
    
    // Promote to top level for easy access (even if empty, for debugging)
    if (lastDetermineCompletion) {
      if (!workflowState.determine_completion) {
        workflowState.determine_completion = {};
      }
      workflowState.determine_completion.result = lastDetermineCompletion;
      
      if (!workflowState.results) {
        workflowState.results = {};
      }
      if (!workflowState.results.determine_completion) {
        workflowState.results.determine_completion = {};
      }
      workflowState.results.determine_completion.result = lastDetermineCompletion;
      
      const statusDisplay = lastDetermineCompletion.status || lastDetermineCompletion.completion_status || 'none';
      console.log(`[WorkflowAnalyzer] ✅ Promoted determine_completion result: status=${statusDisplay}, is_complete=${lastDetermineCompletion.is_complete}`);
    } else {
      console.warn(`[WorkflowAnalyzer] ⚠️ No determine_completion result found after ${iteration} iterations`);
    }
    
    const finalResult = {
      iterations: iteration,
      maxIterations,
      exitedEarly: iteration < maxIterations && (invertCondition ? condition : !condition),
      finalCondition: condition,
      loopHistory: loopState.iterations,
      determine_completion: lastDetermineCompletion // Include in final result for extraction
    };
    
    this.storeStepResult(step, finalResult, workflowState);
    console.log(`[WorkflowAnalyzer] ✅ While-loop completed after ${iteration} iterations`);
    
    // Send log to backend for job history
    if (jobId) {
      try {
        await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
          jobId: jobId,
          level: 'info',
          message: `✅ While-loop completed after ${iteration} iterations`,
          component: 'WORKFLOW-ANALYZER',
          metadata: {
            step_id: step.id,
            step_name: step.name || step.type,
            step_type: 'while-loop',
            iterations: iteration,
            max_iterations: maxIterations,
            exited_early: finalResult.exitedEarly,
            final_condition: finalResult.finalCondition,
            timestamp: new Date().toISOString()
          }
        }, {
          headers: this.getAuthHeaders()
        });
      } catch (error) {
        console.error(`[WorkflowAnalyzer] ⚠️ Failed to log while-loop completion: ${error.message}`);
      }
    }
  }

  /**
   * Execute if-step - conditionally executes nested steps based on a condition
   * General-purpose conditional element
   */
  async executeIfStep(page, step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 🔀 Executing if-step (${step.name})`);
    
    // Send log to backend
    await this.sendLogToBackend(jobId, 'info', `🔀 Executing if-step (${step.name})`, 'WORKFLOW-ANALYZER', {
      step_id: step.id,
      step_name: step.name || step.type,
      step_type: 'if-step'
    });
    
    const config = step.config || {};
    const conditionCode = config.conditionCode; // JavaScript code that returns boolean
    const conditionPath = config.conditionPath; // Path to check for condition value
    const conditionType = config.conditionType || 'code'; // 'code', 'path', or 'ai-response'
    const nestedSteps = config.steps || [];
    const elseSteps = config.elseSteps || []; // Optional else branch
    
    if (!nestedSteps.length) {
      console.log(`[WorkflowAnalyzer] ⚠️ If-step has no nested steps`);
      return;
    }
    
    let condition = false;
    
    try {
      // Evaluate condition
      if (conditionType === 'code' && conditionCode) {
        // Clean the code before execution
        let cleanedCode = this.cleanScript(conditionCode);
        if (!cleanedCode || cleanedCode.trim().length === 0) {
          throw new Error('Condition code is empty after cleaning');
        }
        // Execute code to get condition
        const conditionResult = await page.evaluate(
          ({ code, workflowState }) => {
            const runner = new Function('workflowState', `return (${code});`);
            return runner(workflowState);
          },
          { code: cleanedCode, workflowState }
        );
        condition = conditionResult === true || conditionResult === 'true' || conditionResult === 1;
        
      } else if (conditionType === 'path' || conditionType === 'ai-response') {
        // Get condition from workflowState path
        const conditionValue = this.resolvePathValue(workflowState, conditionPath || 'determine_completion.is_complete', 'results');
        
        if (conditionValue !== undefined && conditionValue !== null) {
          condition = conditionValue === true || conditionValue === 'true' || conditionValue === 1 || conditionValue === 'complete';
        }
      }
      
      console.log(`[WorkflowAnalyzer] 🔀 Condition evaluated: ${condition}`);
      
      // Send log to backend
      await this.sendLogToBackend(jobId, 'info', `🔀 Condition evaluated: ${condition}`, 'WORKFLOW-ANALYZER', {
        step_id: step.id,
        step_name: step.name || step.type,
        step_type: 'if-step',
        condition: condition,
        condition_type: conditionType
      });
      
      // Execute appropriate branch
      const stepsToExecute = condition ? nestedSteps : elseSteps;
      
      if (stepsToExecute.length > 0) {
        for (let nestedIdx = 0; nestedIdx < stepsToExecute.length; nestedIdx++) {
          const nestedStep = stepsToExecute[nestedIdx];
          
          try {
            await this.executeStepByType(page, nestedStep, workflowState, jobId, {
              stepIndex: nestedIdx,
              siblings: stepsToExecute
            });
          } catch (nestedError) {
            console.error(`[WorkflowAnalyzer] ❌ Nested step ${nestedIdx + 1} failed in if-step: ${nestedError.message}`);
            if (nestedStep.config?.critical) {
              throw nestedError;
            }
          }
        }
      }
      
      const result = {
        condition,
        conditionType,
        executedBranch: condition ? 'then' : 'else',
        stepsExecuted: stepsToExecute.length
      };
      
      this.storeStepResult(step, result, workflowState);
      console.log(`[WorkflowAnalyzer] ✅ If-step completed: executed ${condition ? 'then' : 'else'} branch (${stepsToExecute.length} steps)`);
      
      // Send log to backend
      await this.sendLogToBackend(jobId, 'info', `✅ If-step completed: executed ${condition ? 'then' : 'else'} branch (${stepsToExecute.length} steps)`, 'WORKFLOW-ANALYZER', {
        step_id: step.id,
        step_name: step.name || step.type,
        step_type: 'if-step',
        condition: condition,
        executed_branch: condition ? 'then' : 'else',
        steps_executed: stepsToExecute.length
      });
      
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ If-step failed: ${error.message}`);
      
      // Send error log to backend
      await this.sendLogToBackend(jobId, 'error', `❌ If-step failed: ${error.message}`, 'WORKFLOW-ANALYZER', {
        step_id: step.id,
        step_name: step.name || step.type,
        step_type: 'if-step',
        error: error.message
      });
      
      throw error;
    }
  }

  /**
   * @deprecated Use while-loop instead. This method is kept for backward compatibility but will be removed.
   * Execute test-leg-iteratively step - recursively tests a leg until AI says it's complete
   */
  async executeTestLegIterativelyStep(page, step, workflowState, jobId) {
    console.log(`[WorkflowAnalyzer] 🔄 Executing iterative leg test (${step.name})`);
    
    const config = step.config || {};
    const maxIterations = config.maxIterations || 10;
    
    // Get current leg from context
    const currentLeg = workflowState.currentLeg || workflowState.currentItem || {};
    const currentLegIndex = workflowState.currentLegIndex ?? 0;
    
    if (!currentLeg || !currentLeg.leg_id) {
      throw new Error(`No current leg found for iterative testing`);
    }
    
    let iteration = 0;
    let lastExecutionResult = null;
    let finalResult = null;
    
    console.log(`[WorkflowAnalyzer] 🔄 Starting iterative testing for leg: ${currentLeg.title || currentLeg.description || currentLeg.leg_id}`);
    
    // Iterate until leg succeeded, leg failed, or max iterations reached
    while (iteration < maxIterations) {
      iteration++;
      console.log(`[WorkflowAnalyzer] 🔄 Iteration ${iteration}/${maxIterations} for leg: ${currentLeg.leg_id}`);
      
      try {
        // Step 1: Capture page state before action (only visible elements)
        await this.executePlaywrightAnalysisStep(page, {
          id: `${step.id}_iteration_${iteration}_analysis`,
          name: `Page Analysis (Iteration ${iteration})`,
          type: 'playwright-analysis',
          config: { collectForms: true, collectLinks: true, collectInteractiveElements: true }
        }, workflowState, jobId);
        
        await this.executeScreenshotStep(page, {
          id: `${step.id}_iteration_${iteration}_screenshot`,
          name: `Screenshot (Iteration ${iteration})`,
          type: 'screenshot',
          config: { fullPage: true, quality: 90 }
        }, workflowState, jobId, workflowState.pageId);
        
        // Step 2: Get page description
        await this.executePageDescriptionStep(page, {
          id: `${step.id}_iteration_${iteration}_description`,
          name: `Page Description (Iteration ${iteration})`,
          type: 'page-description',
          config: {
            prompt_slug: 'describe-page',
            attachments: ['visible_text', 'interactive_elements', 'screenshot'],
            maxRetries: 1
          }
        }, workflowState, jobId);
        
        // Step 3: Generate action script (only on first iteration, or if new content detected, or if no script is stored)
        if (iteration === 1 || (lastExecutionResult && lastExecutionResult.new_content_detected) || !workflowState.legScriptToExecute) {
          // Get previous execution history for this leg (only what's needed for testification)
          let previousExecutionHistory = [];
          
          // Try to get leg iterations from workflow if available
          if (workflowState.workflowId && currentLeg.leg_id) {
            try {
              const workflowResponse = await axios.get(
                `${this.backendUrl}/api/workflows/${workflowState.workflowId}`,
                { headers: this.getAuthHeaders() }
              );
              const workflow = workflowResponse.data;
              const leg = workflow.legs?.find(l => l.leg_id === currentLeg.leg_id);
              
              if (leg && leg.iterations && leg.iterations.length > 0) {
                // Build minimal execution history (only what's needed for testification)
                previousExecutionHistory = leg.iterations
                  .filter(iter => iter.script_executed || iter.error) // Only include attempts with scripts or errors
                  .map(iter => ({
                    attempt_number: iter.attempt_number || iter.iteration_number || 0,
                    iteration_number: iter.iteration_number || null,
                    script_executed: iter.script_executed ? iter.script_executed.substring(0, 1000) : null, // Truncate for context
                    result: iter.result || 'unknown',
                    error: iter.error || null,
                    is_retry: iter.is_retry || (iter.attempt_number > 1) || false
                  }))
                  .slice(-5); // Only last 5 attempts to avoid too much context
              }
            } catch (error) {
              console.warn(`[WorkflowAnalyzer] Could not fetch leg iterations from workflow: ${error.message}`);
            }
          }
          
          // Store execution history for attachment (only if there's history)
          if (previousExecutionHistory.length > 0) {
            workflowState.execution_history = JSON.stringify(previousExecutionHistory, null, 2);
          }
          
          await this.executeAIPromptStep(page, {
            id: `${step.id}_iteration_${iteration}_generate_script`,
            name: `Generate Action Script (Iteration ${iteration})`,
            type: 'ai-prompt',
            config: {
              prompt_slug: 'generate-playwright-script',
              attachments: previousExecutionHistory.length > 0 
                ? ['page_description', 'interactive_elements', 'forms', 'current_leg', 'playwright_analysis', 'execution_history']
                : ['page_description', 'interactive_elements', 'forms', 'current_leg', 'playwright_analysis'],
              maxRetries: 2
            }
          }, workflowState, jobId);
          
          // Get the generated script
          const generateStepId = `${step.id}_iteration_${iteration}_generate_script`;
          const generateResult = workflowState[generateStepId]?.result || workflowState.results?.[generateStepId]?.result || {};
          let script = generateResult.playwright_script || generateResult.code || '';
          
          if (!script || script.trim() === '') {
            throw new Error(`No Playwright script generated for iteration ${iteration}`);
          }
          
          // Clean the script to remove markdown code blocks and function declarations
          script = this.cleanScript(script);
          
          if (!script || script.trim().length === 0) {
            throw new Error(`Script is empty after cleaning for iteration ${iteration}`);
          }
          
          workflowState.legScriptToExecute = script;
        }
        
        // Step 4: Execute the script
        await this.executeCodeFromVariableStep(page, {
          id: `${step.id}_iteration_${iteration}_execute`,
          name: `Execute Action Script (Iteration ${iteration})`,
          type: 'execute-code-from-variable',
          config: {
            sourceField: 'legScriptToExecute',
            timeout: 45000
          }
        }, workflowState);
        
        const executeStepId = `${step.id}_iteration_${iteration}_execute`;
        lastExecutionResult = workflowState[executeStepId]?.result || workflowState.lastExecutionResult || {};
        
        // Step 5: Capture page state after action (only visible elements)
        await this.executePlaywrightAnalysisStep(page, {
          id: `${step.id}_iteration_${iteration}_analysis_after`,
          name: `Page Analysis After Action (Iteration ${iteration})`,
          type: 'playwright-analysis',
          config: { collectForms: true, collectLinks: true, collectInteractiveElements: true }
        }, workflowState, jobId);
        
        await this.executeScreenshotStep(page, {
          id: `${step.id}_iteration_${iteration}_screenshot_after`,
          name: `Screenshot After Action (Iteration ${iteration})`,
          type: 'screenshot',
          config: { fullPage: true, quality: 90 }
        }, workflowState, jobId, workflowState.pageId);
        
        await this.executePageDescriptionStep(page, {
          id: `${step.id}_iteration_${iteration}_description_after`,
          name: `Page Description After Action (Iteration ${iteration})`,
          type: 'page-description',
          config: {
            prompt_slug: 'describe-page',
            attachments: ['visible_text', 'interactive_elements', 'screenshot'],
            maxRetries: 1
          }
        }, workflowState, jobId);
        
        // Step 6: Use AI to determine if leg testing is complete
        await this.executeAIPromptStep(page, {
          id: `${step.id}_iteration_${iteration}_determine_completion`,
          name: `Determine Completion (Iteration ${iteration})`,
          type: 'ai-prompt',
          config: {
            prompt_slug: 'determine-leg-completion',
            attachments: ['current_leg', 'last_execution_result', 'page_description', 'visible_text', 'interactive_elements', 'forms'],
            maxRetries: 1
          }
        }, workflowState, jobId);
        
        const completionStepId = `${step.id}_iteration_${iteration}_determine_completion`;
        const completionResult = workflowState[completionStepId]?.result || workflowState.results?.[completionStepId]?.result || {};
        
        // Extract completion decision
        const status = completionResult.status || completionResult.completion_status || 'unknown';
        const legFailed = status === 'failure' || completionResult.completion_status === 'failed';
        const legSucceeded = status === 'success' || (completionResult.is_complete === true && !legFailed);
        
        // NOTE: Saving is now handled by workflow steps (save-data elements), not hardcoded here
        // This deprecated method should not be used - use while-loop workflow step instead
        
        console.log(`[WorkflowAnalyzer] 🔄 Iteration ${iteration} complete: legSucceeded=${legSucceeded}, legFailed=${legFailed}`);
        
        // Clear exit conditions: if OpenAI says succeeded or failed - exit the loop
        if (legSucceeded) {
          console.log(`[WorkflowAnalyzer] ✅ Leg testing succeeded after ${iteration} iterations. Reason: ${completionResult.reason || 'AI determined success'}`);
          finalResult = {
            success: true,
            completed: true,
            iterations: iteration,
            finalExecutionResult: lastExecutionResult,
            completionReason: completionResult.reason
          };
          break;
        }
        
        if (legFailed) {
          console.log(`[WorkflowAnalyzer] ❌ Leg testing failed after ${iteration} iterations. Reason: ${completionResult.reason || 'AI determined failure'}`);
          finalResult = {
            success: false,
            completed: true,
            iterations: iteration,
            finalExecutionResult: lastExecutionResult,
            completionReason: completionResult.reason || 'Leg failed',
            error: completionResult.reason || 'Leg failed completely'
          };
          break;
        }
        
        // Otherwise, continue to next iteration
        console.log(`[WorkflowAnalyzer] 🔄 Continuing iteration - leg not yet succeeded or failed`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (iterationError) {
        console.error(`[WorkflowAnalyzer] ❌ Iteration ${iteration} failed: ${iterationError.message}`);
        
        // NOTE: Saving is now handled by workflow steps (save-data elements), not hardcoded here
        // This deprecated method should not be used - use while-loop workflow step instead
        
        // If max iterations reached, exit
        if (iteration >= maxIterations) {
          console.log(`[WorkflowAnalyzer] ⚠️ Max iterations (${maxIterations}) reached`);
          finalResult = {
            success: false,
            completed: false,
            iterations: iteration,
            error: `Max iterations reached: ${iterationError.message}`,
            maxIterationsReached: true
          };
          break;
        }
        
        // Continue to next iteration
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Final result - if loop exited without setting finalResult, it means max iterations reached
    if (!finalResult) {
      finalResult = {
        success: false,
        completed: false,
        iterations: iteration,
        reason: 'Max iterations reached',
        maxIterationsReached: true
      };
    }
    
    // Store result
    this.storeStepResult(step, finalResult, workflowState);
    
    // Update leg result
    const legIndex = currentLegIndex;
    if (!Array.isArray(workflowState.legResults)) {
      workflowState.legResults = [];
    }
    workflowState.legResults[legIndex] = {
      ...currentLeg,
      ...finalResult,
      finished_at: new Date().toISOString()
    };
    
    console.log(`[WorkflowAnalyzer] ✅ Iterative leg testing completed: ${finalResult.completed ? 'COMPLETE' : 'INCOMPLETE'} after ${finalResult.iterations} iterations`);
    
    return finalResult;
  }

  /**
   * Execute step by type (used by for-each to execute nested steps)
   */
  async executeStepByType(page, step, workflowState, jobId, stepContext = null) {
    switch (step.type) {
      case 'screenshot':
        await this.executeScreenshotStep(page, step, workflowState, jobId, workflowState.pageId);
        break;
      case 'playwright-analysis':
        await this.executePlaywrightAnalysisStep(page, step, workflowState, jobId);
        break;
      case 'page-description':
        await this.executePageDescriptionStep(page, step, workflowState, jobId, stepContext);
        break;
      case 'ai-prompt':
        await this.executeAIPromptStep(page, step, workflowState, jobId, stepContext);
        break;
      case 'workflow-analysis':
        await this.executeWorkflowAnalysisStep(page, step, workflowState, jobId, stepContext);
        break;
      case 'create-workflow':
        await this.executeCreateWorkflowStep(step, workflowState, workflowState.pageId, workflowState.projectId, jobId);
        break;
      case 'update-workflow':
        await this.executeUpdateWorkflowStep(step, workflowState, jobId);
        break;
      case 'page-discovery':
        await this.executePageDiscoveryStep(step, workflowState, jobId, workflowState.pageId, workflowState.projectId);
        break;
      case 'execute-code':
        await this.executeCodeStep(page, step, workflowState);
        break;
      case 'execute-code-from-variable':
        await this.executeCodeFromVariableStep(page, step, workflowState, jobId);
        break;
      case 'validate-response':
        await this.executeValidateResponseStep(step, workflowState);
        break;
      case 'filter-response':
        await this.executeFilterResponseStep(step, workflowState);
        break;
      case 'print':
        await this.executePrintStep(step, workflowState, jobId);
        break;
      case 'var-dump':
        await this.executeVarDumpStep(step, workflowState, jobId);
        break;
      case 'sleep':
        await this.executeSleepStep(step, workflowState);
        break;
      case 'for-each':
        await this.executeForEachStep(page, step, workflowState, jobId);
        break;
      case 'while-loop':
        await this.executeWhileLoopStep(page, step, workflowState, jobId);
        break;
      case 'if':
      case 'if-step':
        await this.executeIfStep(page, step, workflowState, jobId);
        break;
      case 'save-data':
        await this.executeSaveDataStep(page, step, workflowState, jobId);
        break;
      default:
        console.log(`[WorkflowAnalyzer] ⚠️ Unknown nested step type: ${step.type}`);
    }
  }

  /**
   * Resolve path value from object (supports both context and results)
   */
  resolvePathValue(source, path, sourceType = 'context') {
    if (!path || !source) {
      return undefined;
    }

    const segments = path.split('.').map(part => part.trim()).filter(Boolean);
    
    // Determine starting point based on sourceType
    let current;
    if (sourceType === 'results') {
      // For results, look in source.results or source itself
      current = source.results || source;
    } else {
      // For context, try multiple locations: source.context, source directly, or source[path]
      // First try source.context
      if (source.context && segments.length > 0 && source.context[segments[0]] !== undefined) {
        current = source.context;
      } else if (segments.length > 0 && source[segments[0]] !== undefined) {
        // Try direct access on source
        current = source;
      } else {
        // Fallback to context or source
        current = source.context || source;
      }
    }
    
    for (const segment of segments) {
      if (current === null || current === undefined) {
        return undefined;
      }

      if (Array.isArray(current)) {
        const index = Number(segment);
        if (Number.isNaN(index) || index < 0 || index >= current.length) {
          return undefined;
        }
        current = current[index];
      } else if (typeof current === 'object') {
        if (Object.prototype.hasOwnProperty.call(current, segment)) {
          current = current[segment];
        } else if (current.result && typeof current.result === 'object' && Object.prototype.hasOwnProperty.call(current.result, segment)) {
          current = current.result[segment];
        } else if (current.metadata && typeof current.metadata === 'object' && Object.prototype.hasOwnProperty.call(current.metadata, segment)) {
          current = current.metadata[segment];
        } else {
          current = undefined;
        }
      } else {
        return undefined;
      }
    }

    return current;
  }

  /**
   * Coerce value to integer
   */
  coerceToInteger(value) {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        return null;
      }
      return Math.trunc(value);
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed === '') {
        return null;
      }
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        return null;
      }
      return Math.trunc(parsed);
    }

    return null;
  }

  buildVarDumpSnapshot(step, workflowState, options, config) {
    const snapshot = {};
    const scopes = [];
    const statistics = {
      legs: Array.isArray(workflowState.legs) ? workflowState.legs.length : 0,
      completedLegs: Array.isArray(workflowState.legResults)
        ? workflowState.legResults.filter(Boolean).length
        : 0,
      loopIterations: workflowState.currentIteration || 0
    };

    if (config.includeShared !== false) {
      const sharedScope = {
        job: {
          id: workflowState.jobId,
          workflowId: workflowState.workflowId,
          pageUrl: workflowState.pageUrl,
          pageTitle: workflowState.pageTitle
        },
        runtimeOptions: workflowState.runtimeOptions,
        aiAnalysisResult: workflowState.aiAnalysisResult,
        lastExecutionResult: workflowState.lastExecutionResult,
        lastScriptFailure: workflowState.lastScriptFailure,
        results: workflowState.results,
        determine_completion: workflowState['determine_completion'],
        conversationHistory: Array.isArray(workflowState.conversationHistory)
          ? workflowState.conversationHistory.slice(-5)
          : [],
        collectedCookies: Array.isArray(workflowState.collectedCookies)
          ? workflowState.collectedCookies.slice(-5)
          : [],
        screenshot: workflowState.screenshotUrl ? {
          url: workflowState.screenshotUrl,
          fileId: workflowState.screenshotFileId
        } : null
      };
      snapshot.shared = this.truncateForVarDump(sharedScope, options);
      scopes.push('shared');
    }

    if (config.includeCurrentLoop) {
      const loopScope = {
        currentIteration: workflowState.currentIteration || null,
        loopState: workflowState.loopState || null,
        loopStack: workflowState.loopStack || null
      };
      snapshot.currentLoop = this.truncateForVarDump(loopScope, options);
      scopes.push('currentLoop');
    }

    if (config.includeStepsSummary) {
      const legsSummary = Array.isArray(workflowState.legs)
        ? workflowState.legs.map(leg => ({
            leg_id: leg.leg_id,
            title: leg.title || leg.description,
            type: leg.type,
            final_result: leg.final_result || leg.result || null,
            iterations: Array.isArray(leg.iterations) ? leg.iterations.length : 0
          }))
        : [];
      const summaryScope = {
        legs: legsSummary,
        legResults: workflowState.legResults || [],
        actionsSummary: workflowState.actionsSummary || null
      };
      snapshot.steps = this.truncateForVarDump(summaryScope, options);
      scopes.push('stepsSummary');
    }

    if (config.includeContext) {
      snapshot.context = this.truncateForVarDump(workflowState.context || {}, options);
      scopes.push('context');
    }

    if (scopes.length === 0) {
      snapshot.shared = this.truncateForVarDump(workflowState, options);
      scopes.push('workflowState');
    }

    snapshot.metadata = {
      jobId: workflowState.jobId,
      pageUrl: workflowState.pageUrl,
      pageTitle: workflowState.pageTitle,
      workflowId: workflowState.workflowId,
      timestamp: new Date().toISOString()
    };

    return { snapshot, scopes, statistics };
  }

  truncateForVarDump(value, options, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string') {
      const limit = options.maxStringLength ?? 1000;
      return value.length > limit ? `${value.slice(0, limit)}…` : value;
    }

    if (typeof value !== 'object') {
      return value;
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    const maxDepth = options.maxDepth ?? 4;
    if (depth >= maxDepth) {
      if (Array.isArray(value)) {
        return `[Array(${value.length})]`;
      }
      return `[Object keys=${Object.keys(value).length}]`;
    }

    if (Array.isArray(value)) {
      const maxItems = options.maxArrayLength ?? 20;
      const sliced = value.slice(0, maxItems).map(item =>
        this.truncateForVarDump(item, options, depth + 1, seen)
      );
      if (value.length > maxItems) {
        sliced.push(`… +${value.length - maxItems} more`);
      }
      return sliced;
    }

    const result = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = this.truncateForVarDump(val, options, depth + 1, seen);
    }
    return result;
  }

  createVarDumpPreview(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      return [];
    }

    return Object.entries(snapshot)
      .filter(([scope]) => scope !== 'metadata')
      .map(([scope, value]) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return {
            scope,
            keys: Object.keys(value).slice(0, 10)
          };
        }
        if (Array.isArray(value)) {
          return {
            scope,
            keys: [`Array(${value.length})`]
          };
        }
        return {
          scope,
          keys: [typeof value]
        };
      });
  }

  /**
   * Apply filter to response data
   */
  applyFilter(data, filter) {
    // Basic filtering implementation - can be enhanced
    if (filter.startsWith('.') && data && typeof data === 'object') {
      const path = filter.substring(1).split('.');
      let result = data;
      for (const key of path) {
        if (result && typeof result === 'object') {
          result = result[key];
        } else {
          return null;
        }
      }
      return result;
    }
    return data;
  }

  /**
   * Get nested value from object using dot notation
   */
  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
  }

  /**
   * Execute self-adjustable AI workflow step
   * Retries failed script execution with modified prompts up to a configurable number of times
   */
  async executeSelfAdjustableAIWorkflowStep(page, step, workflowState, jobId, pageId, projectId) {
    console.log(`[WorkflowAnalyzer] 🔄 Executing self-adjustable AI workflow step (${step.name})`);
    
    // Get configuration
    const config = step.config || {};
    const maxRetries = config.maxRetries ?? 3;
    const explanation = config.explanation || '';
    const includeContext = config.includeContext ?? true;
    const includeError = config.includeError ?? true;
    const includePreviousScript = config.includePreviousScript ?? true;
    const includeScreenshot = config.includeScreenshot ?? true;
    const includeHTML = config.includeHTML ?? true;
    
    // Get retry count from workflow state or initialize
    const retryCount = workflowState.selfAdjustableRetryCount || 0;
    
    // Check if we've exceeded max retries
    if (retryCount >= maxRetries) {
      console.log(`[WorkflowAnalyzer] ❌ Max retries (${maxRetries}) exceeded for self-adjustable AI workflow`);
      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'error',
        message: `Max retries (${maxRetries}) exceeded for self-adjustable AI workflow`,
        component: 'WORKFLOW-STEP',
        metadata: { step: step.name, retryCount, maxRetries }
      }, {
        headers: this.getAuthHeaders()
      });
      throw new Error(`Max retries (${maxRetries}) exceeded`);
    }
    
    // Check if there was a previous script failure
    const lastFailure = workflowState.lastScriptFailure;
    if (!lastFailure) {
      console.log(`[WorkflowAnalyzer] ℹ️ No previous script failure found, skipping retry`);
      return;
    }
    
    console.log(`[WorkflowAnalyzer] 🔄 Retry ${retryCount + 1}/${maxRetries} for failed script execution`);
    
    // Log retry attempt
    await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
      jobId: jobId,
      level: 'info',
      message: `🔄 Self-adjustable AI workflow retry ${retryCount + 1}/${maxRetries}`,
      component: 'WORKFLOW-STEP',
      metadata: {
        step: step.name,
        retryCount: retryCount + 1,
        maxRetries,
        previousError: lastFailure.error,
        explanation
      }
    }, {
      headers: this.getAuthHeaders()
    });
    
    // Use the script generation step from the failure info (exact step that generated the failed script)
    const scriptGenerationStep = lastFailure.scriptGenerationStep;
    const scriptGenerationStepIndex = lastFailure.scriptGenerationStepIndex;
    
    if (!scriptGenerationStep || scriptGenerationStepIndex === null) {
      console.error(`[WorkflowAnalyzer] ❌ No script generation step found in failure info`);
      throw new Error('No script generation step found in failure info');
    }
    
    console.log(`[WorkflowAnalyzer] 📍 Found script generation step at index ${scriptGenerationStepIndex}: ${scriptGenerationStep.name || scriptGenerationStep.id}`);
    
    // Get current page state for retry
    const pageUrl = page.url();
    const pageTitle = await page.title().catch(() => '');
    let htmlContent = null;
    let screenshotBase64 = null;
    
    if (includeHTML) {
      htmlContent = await page.content().catch(() => null);
    }
    
    if (includeScreenshot) {
      try {
        const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
        screenshotBase64 = screenshot.toString('base64');
      } catch (e) {
        console.warn(`[WorkflowAnalyzer] ⚠️ Failed to capture screenshot: ${e.message}`);
      }
    }
    
    // Modify the prompt for retry
    const originalTemplate = scriptGenerationStep.config?.template || 
                            scriptGenerationStep.config?.user_message_template || 
                            '';
    
    if (!originalTemplate) {
      console.error(`[WorkflowAnalyzer] ❌ No template found in script generation step`);
      throw new Error('No template found in script generation step');
    }
    
    const modifiedPrompt = this.modifyPromptForRetry(
      originalTemplate,
      {
        retryNumber: retryCount + 1,
        maxRetries,
        previousError: lastFailure.error,
        explanation,
        previousScript: includePreviousScript ? lastFailure.script : null,
        includeContext,
        includeError,
        includeScreenshot,
        includeHTML,
        htmlContent,
        screenshotBase64,
        pageUrl,
        pageTitle
      },
      workflowState
    );
    
    // Create a new workflow for this page with modified prompt
    const newWorkflowName = `AI-Generated Workflow - Retry ${retryCount + 1} - ${new Date().toISOString()}`;
    const newWorkflow = {
      name: newWorkflowName,
      description: `Auto-generated workflow for retry ${retryCount + 1} after script execution failure`,
      type: 'page',
      project_id: projectId,
      page_id: pageId,
      is_ai_generated: true,
      parent_workflow_id: this.workflowTemplate._id,
      retry_number: retryCount + 1,
      folder: 'AI-generated workflows',
      steps: this.workflowTemplate.steps.map(s => {
        if (s.id === scriptGenerationStep.id || s.name === scriptGenerationStep.name) {
          // Modify the script generation step with new prompt
          return {
            ...s,
            config: {
              ...s.config,
              template: modifiedPrompt,
              user_message_template: modifiedPrompt
            }
          };
        }
        return s;
      })
    };
    
    // Store the new workflow in MongoDB
    try {
      const workflowResponse = await axios.post(
        `${this.backendUrl}/api/workflow-templates`,
        newWorkflow,
        {
          headers: this.getAuthHeaders()
        }
      );
      
      const newWorkflowId = workflowResponse.data._id;
      console.log(`[WorkflowAnalyzer] ✅ Created new AI-generated workflow: ${newWorkflowId}`);
      
      // Update workflow state with new workflow ID
      workflowState.aiGeneratedWorkflowId = newWorkflowId;
      workflowState.selfAdjustableRetryCount = retryCount + 1;
      
      // Log workflow creation
      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'info',
        message: `✅ Created new AI-generated workflow for retry ${retryCount + 1}`,
        component: 'WORKFLOW-STEP',
        metadata: {
          step: step.name,
          workflowId: newWorkflowId,
          workflowName: newWorkflowName,
          retryCount: retryCount + 1,
          parentWorkflowId: this.workflowTemplate._id
        }
      }, {
        headers: this.getAuthHeaders()
      });
      
      // Load the new workflow and continue execution from the script generation step
      const newWorkflowResponse = await axios.get(
        `${this.backendUrl}/api/workflow-templates/${newWorkflowId}`,
        {
          headers: this.getAuthHeaders()
        }
      );
      
      const newWorkflowTemplate = newWorkflowResponse.data;
      
      // Update the current workflow template to use the new one
      this.workflowTemplate = newWorkflowTemplate;
      
      // Set flag to continue from the script generation step (where we'll regenerate the script)
      workflowState.shouldRetryFromStep = scriptGenerationStepIndex;
      workflowState.retryWorkflowId = newWorkflowId;
      
      console.log(`[WorkflowAnalyzer] 🔄 Loaded new workflow, will continue from step ${scriptGenerationStepIndex} (script generation step)`);
      
      await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
        jobId: jobId,
        level: 'info',
        message: `🔄 Continuing execution from step ${scriptGenerationStepIndex} with new adjusted workflow`,
        component: 'SELF-ADJUSTABLE-WORKFLOW',
        metadata: {
          retry_from_step: scriptGenerationStepIndex,
          new_workflow_id: newWorkflowId,
          page_id: pageId
        }
      }, {
        headers: this.getAuthHeaders()
      });
      
      // Continue execution from the script generation step
      // We need to re-execute from that step with the new workflow
      // This will be handled by the main workflow execution loop
      // by checking workflowState.shouldRetryFromStep
      
      return {
        success: true,
        workflowId: newWorkflowId,
        retryCount: retryCount + 1,
        shouldRetryFromStep: scriptGenerationStepIndex,
        message: `Created new workflow for retry ${retryCount + 1}, continuing from step ${scriptGenerationStepIndex}`
      };
    } catch (error) {
      console.error(`[WorkflowAnalyzer] ❌ Failed to create new workflow: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Modify prompt for retry with additional context
   */
  modifyPromptForRetry(originalTemplate, retryContext, workflowState) {
    let modifiedPrompt = originalTemplate;
    
    // Add workflow system context first, so OpenAI understands the system
    modifiedPrompt += `\n\n--- WORKFLOW SYSTEM CONTEXT ---\n`;
    modifiedPrompt += `You are part of an automated testing workflow system. Here's how it works:\n`;
    modifiedPrompt += `1. The system analyzes web pages and creates test workflows automatically.\n`;
    modifiedPrompt += `2. You generate Playwright scripts to interact with page elements.\n`;
    modifiedPrompt += `3. The system executes these scripts in a real browser.\n`;
    modifiedPrompt += `4. If a script fails, the system adjusts the workflow and retries.\n`;
    modifiedPrompt += `5. Each workflow consists of multiple steps executed in sequence.\n`;
    modifiedPrompt += `6. The current step is part of a larger workflow that tests page functionality.\n`;
    modifiedPrompt += `7. Your script will be executed immediately after generation, so it must be correct and complete.\n`;
    modifiedPrompt += `8. The script must handle page loading, element selection, and interactions properly.\n`;
    modifiedPrompt += `9. Consider timing issues, dynamic content, and element availability.\n`;
    modifiedPrompt += `10. The script should be robust and handle edge cases.\n\n`;
    
    // Add retry context
    if (retryContext.includeError && retryContext.previousError) {
      modifiedPrompt += `--- RETRY CONTEXT ---\n`;
      modifiedPrompt += `⚠️ IMPORTANT: This is retry attempt ${retryContext.retryNumber} of ${retryContext.maxRetries}.\n`;
      modifiedPrompt += `The previous script execution FAILED with the following error:\n`;
      modifiedPrompt += `Error: ${retryContext.previousError}\n\n`;
      
      if (retryContext.previousScript && retryContext.includePreviousScript) {
        modifiedPrompt += `The previous script that failed was:\n`;
        modifiedPrompt += `\`\`\`javascript\n${retryContext.previousScript}\n\`\`\`\n\n`;
        modifiedPrompt += `Please analyze what went wrong with this script and why it failed.\n`;
        modifiedPrompt += `Common issues include:\n`;
        modifiedPrompt += `- Wrong selectors (element not found or changed)\n`;
        modifiedPrompt += `- Timing issues (element not ready when accessed)\n`;
        modifiedPrompt += `- Element not visible or not interactable\n`;
        modifiedPrompt += `- Page structure changed or element moved\n`;
        modifiedPrompt += `- JavaScript errors in the script\n`;
        modifiedPrompt += `- Network issues or page not loaded\n\n`;
      }
      
      if (retryContext.explanation) {
        modifiedPrompt += `Additional context from workflow configuration: ${retryContext.explanation}\n\n`;
      }
      
      modifiedPrompt += `Current page state:\n`;
      modifiedPrompt += `- URL: ${retryContext.pageUrl}\n`;
      modifiedPrompt += `- Title: ${retryContext.pageTitle}\n`;
      
      if (retryContext.htmlContent && retryContext.includeHTML) {
        modifiedPrompt += `- HTML structure (first 5000 chars): ${retryContext.htmlContent.substring(0, 5000)}...\n`;
      }
      
      modifiedPrompt += `\n--- YOUR TASK ---\n`;
      modifiedPrompt += `Based on the error analysis and current page state, generate an IMPROVED Playwright script that:\n`;
      modifiedPrompt += `1. Addresses the specific failure from the previous attempt\n`;
      modifiedPrompt += `2. Uses more robust selectors and error handling\n`;
      modifiedPrompt += `3. Handles timing and element availability properly\n`;
      modifiedPrompt += `4. Is complete and ready to execute\n`;
      modifiedPrompt += `5. Follows Playwright best practices\n`;
      modifiedPrompt += `\nThe script must be valid JavaScript that can be executed directly in a Playwright page context.\n`;
      modifiedPrompt += `Do not include explanations or comments that are not executable code.\n`;
    }
    
    return modifiedPrompt;
  }
}

export default WorkflowAnalyzer;


// Force rebuild Wed 15 Oct 2025 23:26:24 AEDT
// Force rebuild Tue 28 Oct 2025 15:43:46 AEDT

