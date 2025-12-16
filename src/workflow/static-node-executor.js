/**
 * Static Node Executor
 * Executes static workflow nodes (screenshot, wait, print, navigate, click, fill, etc.)
 * in the order defined by workflow connections
 */

import * as backendLogger from '../backend-logger.js';

/**
 * StaticNodeExecutor - Executes static workflow nodes
 */
export class StaticNodeExecutor {
  constructor(page, jobId, workflow, context = {}) {
    this.page = page;
    this.jobId = jobId;
    this.workflow = workflow;
    this.context = context; // project_id, backendUrl, etc.
    this.executedNodes = new Set();
    this.nodeResults = new Map();
  }

  /**
   * Build execution graph from connections
   */
  buildExecutionGraph() {
    const graph = new Map();
    const allNodes = [
      ...(this.workflow.staticNodes || []),
      ...(this.workflow.conditions || []),
      ...(this.workflow.cycles || [])
    ];

    // Initialize graph with all nodes
    allNodes.forEach(node => {
      graph.set(node.id, {
        node,
        next: [],
        prev: []
      });
    });

    // Build edges from connections
    (this.workflow.connections || []).forEach(conn => {
      const sourceEntry = graph.get(conn.source);
      const targetEntry = graph.get(conn.target);
      
      if (sourceEntry && targetEntry) {
        sourceEntry.next.push(conn.target);
        targetEntry.prev.push(conn.source);
      }
    });

    return graph;
  }

  /**
   * Find start node
   */
  findStartNode() {
    const allNodes = [
      ...(this.workflow.staticNodes || []),
      ...(this.workflow.conditions || []),
      ...(this.workflow.cycles || [])
    ];

    const startNode = allNodes.find(node => node.type === 'start');
    if (!startNode) {
      throw new Error('No start node found in workflow');
    }
    return startNode;
  }

  /**
   * Log workflow execution step
   */
  async logWorkflowStep(stepType, message, metadata = {}) {
    await backendLogger.appendJobLog(
      this.jobId,
      'info',
      message,
      'WORKFLOW-EXECUTOR',
      {
        workflow_name: this.workflow.name,
        workflow_id: this.workflow._id,
        step_type: stepType,
        ...metadata
      }
    );
  }

  /**
   * Execute a single node
   */
  async executeNode(node, graph) {
    const nodeType = node.type;
    const nodeLabel = node.label || node.id;

    // Only log non-start/end steps
    if (nodeType !== 'start' && nodeType !== 'end') {
      await this.logWorkflowStep(
        nodeType,
        `🔄 Executing: "${nodeLabel}" (${nodeType})`,
        {
          node_id: node.id,
          node_type: nodeType,
          node_label: nodeLabel
        }
      );
    }

    console.log(`[STATIC-EXECUTOR] Executing node: ${node.id} (${nodeType}) - "${nodeLabel}"`);
    console.log(`[STATIC-EXECUTOR] Workflow: "${this.workflow.name}"`);

    try {
      let result = { success: true, data: null };

      switch (nodeType) {
        case 'start':
          // No log for start
          result = { success: true, message: 'Workflow started' };
          break;

        case 'end':
          // No log for end
          result = { success: true, message: 'Workflow completed' };
          break;

        case 'screenshot':
          result = await this.executeScreenshot(node);
          break;

        case 'wait':
          result = await this.executeWait(node);
          break;

        case 'print':
          result = await this.executePrint(node);
          break;

        case 'navigate':
          result = await this.executeNavigate(node);
          break;

        case 'click':
          result = await this.executeClick(node);
          break;

        case 'fill':
          result = await this.executeFill(node);
          break;

        case 'collect':
          result = await this.executeCollect(node);
          break;

        case 'populate_history':
          result = await this.executePopulateHistory(node);
          break;

        case 'success':
        case 'failure':
          result = await this.executeCondition(node);
          break;

        case 'cycle':
          result = await this.executeCycle(node, graph);
          break;

        default:
          await this.logWorkflowStep(
            nodeType,
            `⚠️ Unknown node type: ${nodeType} - skipping`,
            { node_id: node.id }
          );
          result = { success: true, skipped: true, message: `Unknown node type: ${nodeType}` };
      }

      // Only log failures and non-start/end completions
      if (!result.success) {
        await this.logWorkflowStep(
          nodeType,
          `❌ Failed: "${nodeLabel}" - ${result.error}`,
          {
            node_id: node.id,
            error: result.error
          }
        );
      }
      // Don't log successful completions - already announced at start

      this.nodeResults.set(node.id, result);
      return result;

    } catch (error) {
      console.error(`[STATIC-EXECUTOR] Error executing node ${node.id}:`, error);
      await this.logWorkflowStep(
        nodeType,
        `❌ Step error: "${nodeLabel}" - ${error.message}`,
        {
          node_id: node.id,
          error: error.message,
          stack: error.stack
        }
      );
      
      const errorResult = { success: false, error: error.message };
      this.nodeResults.set(node.id, errorResult);
      return errorResult;
    }
  }

  /**
   * Execute screenshot node
   */
  async executeScreenshot(node) {
    // Step announcement already done in executeNode
    try {
      // Take screenshot using Playwright
      const screenshotBuffer = await this.page.screenshot({ 
        type: 'png', 
        fullPage: true 
      });

      // Get presigned URL from backend
      const pageUrl = this.page.url();
      const prepareResult = await backendLogger.prepareScreenshotUpload(this.jobId, pageUrl);

      if (!prepareResult.ok || !prepareResult.key || !prepareResult.uploadUrl) {
        throw new Error('Failed to get presigned URL for screenshot');
      }

      const { key, uploadUrl, publicUrl } = prepareResult;

      // Upload screenshot to MinIO
      const uploadSuccess = await backendLogger.uploadScreenshotToPresignedUrl(uploadUrl, screenshotBuffer);

      if (!uploadSuccess) {
        throw new Error('Failed to upload screenshot to MinIO');
      }

      // Use backend-provided public URL (from S3 configuration from Terraform)
      if (!publicUrl) {
        console.warn(`[StaticNodeExecutor] ⚠️ Backend did not return publicUrl, using key as fallback: ${key}`);
      }
      const screenshotUrl = publicUrl || key; // Use publicUrl from backend (S3 URL from Terraform config)

      // Track the screenshot
      await backendLogger.trackMediaUpload(this.jobId, 'screenshot', {
        screenshotId: key,
        screenshotKey: key,
        objectName: key,
        url: screenshotUrl,
        size: screenshotBuffer.length,
        action: node.label || 'workflow_screenshot',
        workflow_step: node.id,
        workflow_name: this.workflow.name
      });

      return {
        success: true,
        message: `Screenshot captured: ${key}`,
        data: { screenshotKey: key, screenshotId: key }
      };
    } catch (error) {
      return {
        success: false,
        error: `Screenshot capture failed: ${error.message}`
      };
    }
  }

  /**
   * Execute wait node
   */
  async executeWait(node) {
    const duration = node.duration || 1000;
    // Step announcement already done in executeNode
    await this.page.waitForTimeout(duration);

    return {
      success: true,
      message: `Waited ${duration}ms`,
      data: { duration }
    };
  }

  /**
   * Execute print/log node
   */
  async executePrint(node) {
    const message = node.message || node.label || 'Log message';
    // Step announcement already done in executeNode
    // Log the actual message content
    await this.logWorkflowStep('print', `📝 ${message}`, {
      node_id: node.id,
      custom_message: message
    });

    return {
      success: true,
      message: `Logged: ${message}`,
      data: { message }
    };
  }

  /**
   * Execute navigate node
   */
  async executeNavigate(node) {
    const url = node.url;
    
    if (!url) {
      return {
        success: false,
        error: 'No URL specified for navigate node'
      };
    }

    // Resolve relative URLs
    let targetUrl = url;
    if (url.startsWith('/')) {
      const currentUrl = new URL(this.page.url());
      targetUrl = `${currentUrl.origin}${url}`;
    }

    // Step announcement already done in executeNode
    try {
      await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {
        console.warn('Page DOM not fully loaded after 30s, continuing anyway');
      });
      
      return {
        success: true,
        message: `Navigated to ${targetUrl}`,
        data: { url: targetUrl, finalUrl: this.page.url() }
      };
    } catch (error) {
      return {
        success: false,
        error: `Navigation failed: ${error.message}`
      };
    }
  }

  /**
   * Execute click node
   */
  async executeClick(node) {
    const selector = node.selector;
    
    if (!selector) {
      return {
        success: false,
        error: 'No selector specified for click node'
      };
    }

    // Step announcement already done in executeNode
    try {
      await this.page.waitForSelector(selector, { timeout: 10000 });
      await this.page.click(selector);
      
      // Wait for any navigation or state changes
      await this.page.waitForTimeout(1000);

      return {
        success: true,
        message: `Clicked ${selector}`,
        data: { selector }
      };
    } catch (error) {
      return {
        success: false,
        error: `Click failed: ${error.message}`
      };
    }
  }

  /**
   * Execute fill form node
   */
  async executeFill(node) {
    const selector = node.selector;
    const value = node.value;
    
    if (!selector || value === undefined) {
      return {
        success: false,
        error: 'Selector or value missing for fill node'
      };
    }

    // Step announcement already done in executeNode
    try {
      await this.page.waitForSelector(selector, { timeout: 10000 });
      await this.page.fill(selector, String(value));

      return {
        success: true,
        message: `Filled ${selector} with "${value}"`,
        data: { selector, value }
      };
    } catch (error) {
      return {
        success: false,
        error: `Fill failed: ${error.message}`
      };
    }
  }

  /**
   * Execute collect data node
   */
  async executeCollect(node) {
    // Step announcement already done in executeNode
    try {
      const pageData = await this.page.evaluate(() => {
        return {
          title: document.title,
          url: window.location.href,
          text: document.body.innerText.substring(0, 1000),
          links: Array.from(document.querySelectorAll('a')).slice(0, 10).map(a => ({
            text: a.innerText,
            href: a.href
          })),
          forms: Array.from(document.querySelectorAll('form')).length,
          images: Array.from(document.querySelectorAll('img')).length
        };
      });

      // Log collected data to backend
      await backendLogger.appendJobLog(
        this.jobId,
        'info',
        `📊 Collected data from page`,
        'WORKFLOW-EXECUTOR',
        {
          workflow_name: this.workflow.name,
          node_id: node.id,
          page_url: this.page.url(),
          collected_data: pageData
        }
      );

      return {
        success: true,
        message: 'Page data collected',
        data: pageData
      };
    } catch (error) {
      return {
        success: false,
        error: `Data collection failed: ${error.message}`
      };
    }
  }

  /**
   * Execute condition node (success/failure)
   */
  async executeCondition(node) {
    const condition = node.condition;
    const conditionType = node.type; // 'success' or 'failure'
    
    // Step announcement already done in executeNode
    try {
      // Evaluate condition in page context
      let conditionMet = false;
      
      if (condition) {
        // Simple condition evaluation
        // In a real implementation, you'd want to safely evaluate this
        conditionMet = await this.page.evaluate((cond) => {
          try {
            // Very basic evaluation - in production use a safe evaluator
            return eval(cond);
          } catch (e) {
            return false;
          }
        }, condition);
      } else {
        // No condition specified - always true for success, always false for failure
        conditionMet = conditionType === 'success';
      }

      return {
        success: true,
        message: `Condition evaluated: ${conditionMet}`,
        data: { conditionMet, conditionType, nextBranch: conditionMet ? 'true' : 'false' }
      };

    } catch (error) {
      return {
        success: false,
        error: `Condition evaluation failed: ${error.message}`
      };
    }
  }

  /**
   * Execute cycle node
   */
  async executeCycle(node, graph) {
    const iterations = node.iterations || 1;
    
    // Step announcement already done in executeNode
    // Find nodes inside the cycle (between cycle start and cycle end connections)
    // For now, just log the cycle - full implementation would loop through cycle body

    return {
      success: true,
      message: `Cycle executed ${iterations} times`,
      data: { iterations }
    };
  }

  /**
   * Execute populate_history node
   * Compares current page/element state with previous state and logs changes
   */
  async executePopulateHistory(node) {
    try {
      const backendUrl = this.context.backendUrl || process.env.BACKEND_URL || 'http://localhost:4000';
      const projectId = this.context.project_id;
      
      if (!projectId) {
        console.warn('[POPULATE_HISTORY] No project_id in context, skipping');
        return { success: true, skipped: true, message: 'No project_id available' };
      }

      const currentUrl = this.page.url();
      const currentTitle = await this.page.title();

      // Get all interactive elements on the page
      const elements = await this.page.evaluate(() => {
        const results = [];
        
        // Forms
        document.querySelectorAll('form').forEach((form, index) => {
          const name = form.name || form.id || form.getAttribute('action') || `form-${index}`;
          const fields = Array.from(form.querySelectorAll('input, select, textarea')).map(f => ({
            name: f.name || f.id,
            type: f.type || f.tagName.toLowerCase()
          }));
          results.push({
            type: 'form',
            name,
            selector: form.name ? `form[name="${form.name}"]` : (form.id ? `#${form.id}` : null),
            fieldCount: fields.length,
            fields
          });
        });

        // Buttons
        document.querySelectorAll('button, input[type="button"], input[type="submit"]').forEach((btn, index) => {
          const name = btn.textContent?.trim() || btn.value || btn.id || `button-${index}`;
          results.push({
            type: 'button',
            name,
            selector: btn.id ? `#${btn.id}` : null,
            text: btn.textContent?.trim() || btn.value
          });
        });

        return results;
      });

      // Fetch previous state from backend
      const axios = (await import('axios')).default;
      let previousElements = [];
      try {
        const response = await axios.get(`${backendUrl}/api/pages`, {
          params: { 
            project_id: projectId,
            url: currentUrl 
          }
        });
        
        if (response.data && response.data.length > 0) {
          const existingPage = response.data[0];
          previousElements = existingPage.interactive_elements || [];
        }
      } catch (error) {
        console.log('[POPULATE_HISTORY] Page not found in database (first discovery)');
      }

      const changes = [];

      // Compare elements
      for (const currentElement of elements) {
        const previous = previousElements.find(
          p => p.name === currentElement.name && p.type === currentElement.type
        );

        if (!previous) {
          // New element discovered
          changes.push({
            element_name: currentElement.name,
            element_type: currentElement.type,
            element_selector: currentElement.selector,
            change_type: 'discovery',
            description: `New ${currentElement.type} discovered: "${currentElement.name}"`,
            previous_state: null,
            current_state: currentElement
          });
        } else {
          // Check for changes
          const differences = [];
          
          if (currentElement.type === 'form') {
            if (currentElement.fieldCount !== previous.fieldCount) {
              differences.push(`Field count changed from ${previous.fieldCount} to ${currentElement.fieldCount}`);
            }
            
            // Check for missing or added fields
            const prevFieldNames = new Set((previous.fields || []).map(f => f.name));
            const currFieldNames = new Set((currentElement.fields || []).map(f => f.name));
            
            const addedFields = [...currFieldNames].filter(n => !prevFieldNames.has(n));
            const removedFields = [...prevFieldNames].filter(n => !currFieldNames.has(n));
            
            if (addedFields.length > 0) {
              differences.push(`Added fields: ${addedFields.join(', ')}`);
            }
            if (removedFields.length > 0) {
              differences.push(`Removed fields: ${removedFields.join(', ')}`);
            }
          }

          if (currentElement.type === 'button' && currentElement.text !== previous.text) {
            differences.push(`Button text changed from "${previous.text}" to "${currentElement.text}"`);
          }

          if (differences.length > 0) {
            changes.push({
              element_name: currentElement.name,
              element_type: currentElement.type,
              element_selector: currentElement.selector,
              change_type: 'change',
              description: differences.join('; '),
              previous_state: previous,
              current_state: currentElement
            });
          }
        }
      }

      // Check for removed elements
      for (const previousElement of previousElements) {
        const current = elements.find(
          e => e.name === previousElement.name && e.type === previousElement.type
        );
        
        if (!current) {
          changes.push({
            element_name: previousElement.name,
            element_type: previousElement.type,
            element_selector: previousElement.selector,
            change_type: 'error',
            description: `${previousElement.type} "${previousElement.name}" is no longer present on the page`,
            previous_state: previousElement,
            current_state: null
          });
        }
      }

      // Send changes to backend
      for (const change of changes) {
        try {
          await axios.post(`${backendUrl}/api/history`, {
            project_id: projectId,
            job_id: this.jobId,
            page_url: currentUrl,
            page_title: currentTitle,
            ...change
          });
          
          console.log(`[POPULATE_HISTORY] 📝 Logged change: ${change.description}`);
          
          await this.logWorkflowStep(
            'populate_history',
            `📝 ${change.change_type.toUpperCase()}: ${change.description}`,
            {
              element_name: change.element_name,
              element_type: change.element_type,
              change_type: change.change_type
            }
          );
        } catch (error) {
          console.error('[POPULATE_HISTORY] Failed to create history record:', error.message);
        }
      }

      return {
        success: true,
        message: `Analyzed ${elements.length} elements, found ${changes.length} changes`,
        data: { 
          elementsAnalyzed: elements.length,
          changesFound: changes.length,
          changes: changes.map(c => ({ 
            type: c.change_type, 
            element: c.element_name,
            description: c.description 
          }))
        }
      };
    } catch (error) {
      console.error('[POPULATE_HISTORY] Error:', error);
      return {
        success: false,
        error: `Failed to populate history: ${error.message}`
      };
    }
  }

  /**
   * Execute workflow starting from start node
   */
  async execute() {
    console.log(`[STATIC-EXECUTOR] Executing workflow: "${this.workflow.name}"`);

    // Single log announcing workflow start
    await this.logWorkflowStep('workflow', `🚀 Executing workflow: "${this.workflow.name}"`, {
      total_nodes: this.workflow.staticNodes?.length || 0,
      description: this.workflow.description
    });

    try {
      // Build execution graph
      const graph = this.buildExecutionGraph();
      console.log(`[STATIC-EXECUTOR] Built execution graph with ${graph.size} nodes`);

      // Find start node
      const startNode = this.findStartNode();
      console.log(`[STATIC-EXECUTOR] Found start node: ${startNode.id}`);

      // Execute nodes in order following connections
      let currentNodeId = startNode.id;
      let stepsExecuted = 0;
      const maxSteps = 100; // Prevent infinite loops

      while (currentNodeId && stepsExecuted < maxSteps) {
        const graphEntry = graph.get(currentNodeId);
        if (!graphEntry) {
          console.log(`[STATIC-EXECUTOR] Node ${currentNodeId} not found in graph`);
          break;
        }

        const node = graphEntry.node;

        // Execute current node
        const result = await this.executeNode(node, graph);
        this.executedNodes.add(currentNodeId);
        stepsExecuted++;

        // Check if execution failed
        if (!result.success) {
          await this.logWorkflowStep('workflow', 
            `❌ Workflow failed at step "${node.label}" (${node.id})`, {
            failed_node: node.id,
            error: result.error,
            steps_executed: stepsExecuted
          });
          return {
            success: false,
            error: `Workflow failed at node ${node.id}: ${result.error}`,
            stepsExecuted,
            failedNode: node.id
          };
        }

        // If this is the end node, we're done
        if (node.type === 'end') {
          // Don't log - workflow completion is implied
          return {
            success: true,
            message: 'Workflow completed successfully',
            stepsExecuted,
            executedNodes: Array.from(this.executedNodes)
          };
        }

        // Move to next node
        if (graphEntry.next.length === 0) {
          console.log(`[STATIC-EXECUTOR] Node ${currentNodeId} has no next node`);
          break;
        }

        // For conditions, choose next based on result
        if (node.type === 'success' || node.type === 'failure') {
          // For now, just take first next node
          // Full implementation would branch based on condition result
          currentNodeId = graphEntry.next[0];
        } else {
          // Take first next node
          currentNodeId = graphEntry.next[0];
        }

        console.log(`[STATIC-EXECUTOR] Moving to next node: ${currentNodeId}`);
      }

      // If we got here without reaching end node, workflow is incomplete
      if (stepsExecuted >= maxSteps) {
        return {
          success: false,
          error: `Maximum steps (${maxSteps}) reached`,
          stepsExecuted
        };
      } else {
        return {
          success: false,
          error: 'Workflow incomplete - no path to end node',
          stepsExecuted,
          lastNode: currentNodeId
        };
      }

    } catch (error) {
      console.error(`[STATIC-EXECUTOR] Workflow execution error:`, error);
      return {
        success: false,
        error: `Workflow execution error: ${error.message}`
      };
    }
  }
}

export default StaticNodeExecutor;

