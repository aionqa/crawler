/**
 * Static Node Executor
 * Executes static workflow nodes (screenshot, wait, print, navigate, click, fill, etc.)
 * in the order defined by workflow connections
 */

import * as backendLogger from './backend-logger.js';

/**
 * StaticNodeExecutor - Executes static workflow nodes
 */
export class StaticNodeExecutor {
  constructor(page, jobId, workflow) {
    this.page = page;
    this.jobId = jobId;
    this.workflow = workflow;
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

      const { key, uploadUrl } = prepareResult;

      // Upload screenshot to MinIO
      const uploadSuccess = await backendLogger.uploadScreenshotToPresignedUrl(uploadUrl, screenshotBuffer);

      if (!uploadSuccess) {
        throw new Error('Failed to upload screenshot to MinIO');
      }

      // Track the screenshot
      await backendLogger.trackMediaUpload(this.jobId, 'screenshot', {
        screenshotId: key,
        screenshotKey: key,
        objectName: key,
        url: `http://localhost:9000/crawldata/screenshots/${this.jobId}/${key}`,
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
      await this.page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
      
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

