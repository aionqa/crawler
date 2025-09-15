#!/usr/bin/env node

/**
 * Test All Agents Script
 * 
 * This script tests all login-* and crawler-* agents to verify
 * the standardized local calling capabilities work correctly.
 * 
 * Usage:
 *   node test-all-agents.js
 *   node test-all-agents.js --quick
 *   node test-all-agents.js --agents login-simplified,crawler-simplified
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

// Agent configurations
const AGENTS = {
  'login-simplified': { port: 3001, testFile: 'test-local.js' },
  'login-text': { port: 3002, testFile: 'test-local.js' },
  'login-media': { port: 3003, testFile: 'test-local.js' },
  'login-static': { port: 3004, testFile: 'test-local.js' },
  'crawler-simplified': { port: 3101, testFile: 'test-local.js' },
  'crawler-text': { port: 3102, testFile: 'test-local.js' },
  'crawler-media': { port: 3103, testFile: 'test-local.js' },
  'crawler-static': { port: 3104, testFile: 'test-local.js' }
};

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    quick: false,
    agents: Object.keys(AGENTS),
    timeout: 30000
  };
  
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace('--', '');
    const value = args[i + 1];
    
    if (key === 'quick') {
      config.quick = true;
      i--; // No value for this flag
    } else if (key === 'agents' && value) {
      config.agents = value.split(',').map(a => a.trim());
    } else if (key === 'timeout' && value) {
      config.timeout = parseInt(value) || config.timeout;
    }
  }
  
  return config;
}

// Check if agent directory exists
function checkAgentExists(agentName) {
  const agentPath = join(process.cwd(), agentName);
  return existsSync(agentPath);
}

// Check if test file exists
function checkTestFileExists(agentName, testFile) {
  const testPath = join(process.cwd(), agentName, testFile);
  return existsSync(testPath);
}

// Run test for a single agent
async function testAgent(agentName, config) {
  return new Promise((resolve) => {
    console.log(`\n🧪 Testing ${agentName}...`);
    console.log('='.repeat(50));
    
    // Check if agent directory exists
    if (!checkAgentExists(agentName)) {
      console.log(`❌ Agent directory not found: ${agentName}`);
      resolve({ agent: agentName, success: false, error: 'Directory not found' });
      return;
    }
    
    // Check if test file exists
    const testFile = AGENTS[agentName].testFile;
    if (!checkTestFileExists(agentName, testFile)) {
      console.log(`❌ Test file not found: ${agentName}/${testFile}`);
      resolve({ agent: agentName, success: false, error: 'Test file not found' });
      return;
    }
    
    // Prepare test command
    const testArgs = [testFile];
    if (config.quick) {
      testArgs.push('--timeout', '10000'); // Shorter timeout for quick tests
    }
    
    // Run the test
    const testProcess = spawn('node', testArgs, {
      cwd: join(process.cwd(), agentName),
      stdio: 'pipe'
    });
    
    let stdout = '';
    let stderr = '';
    
    testProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    testProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    // Set timeout
    const timeout = setTimeout(() => {
      testProcess.kill();
      console.log(`⏰ Test timed out after ${config.timeout}ms`);
      resolve({ agent: agentName, success: false, error: 'Timeout' });
    }, config.timeout);
    
    testProcess.on('close', (code) => {
      clearTimeout(timeout);
      
      if (code === 0) {
        console.log(`✅ ${agentName} test passed`);
        resolve({ agent: agentName, success: true, stdout, stderr });
      } else {
        console.log(`❌ ${agentName} test failed with code ${code}`);
        console.log('STDOUT:', stdout);
        console.log('STDERR:', stderr);
        resolve({ agent: agentName, success: false, error: `Exit code ${code}`, stdout, stderr });
      }
    });
    
    testProcess.on('error', (error) => {
      clearTimeout(timeout);
      console.log(`❌ ${agentName} test error: ${error.message}`);
      resolve({ agent: agentName, success: false, error: error.message });
    });
  });
}

// Main test function
async function runAllTests() {
  console.log('🚀 Starting All Agents Test');
  console.log('============================');
  
  const config = parseArgs();
  
  console.log('📋 Test Configuration:');
  console.log(`   Quick Mode: ${config.quick}`);
  console.log(`   Timeout: ${config.timeout}ms`);
  console.log(`   Agents: ${config.agents.join(', ')}`);
  console.log('');
  
  // Filter agents that exist
  const existingAgents = config.agents.filter(agent => {
    if (!AGENTS[agent]) {
      console.log(`⚠️  Unknown agent: ${agent}`);
      return false;
    }
    return checkAgentExists(agent);
  });
  
  if (existingAgents.length === 0) {
    console.log('❌ No valid agents found to test');
    process.exit(1);
  }
  
  console.log(`🎯 Testing ${existingAgents.length} agents: ${existingAgents.join(', ')}`);
  
  // Run tests for each agent
  const results = [];
  for (const agent of existingAgents) {
    const result = await testAgent(agent, config);
    results.push(result);
  }
  
  // Print summary
  console.log('\n📊 Test Summary');
  console.log('================');
  
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📊 Total: ${results.length}`);
  
  if (failed > 0) {
    console.log('\n❌ Failed Tests:');
    results.filter(r => !r.success).forEach(result => {
      console.log(`   ${result.agent}: ${result.error}`);
    });
  }
  
  console.log('\n📝 Detailed Results:');
  results.forEach(result => {
    const status = result.success ? '✅' : '❌';
    console.log(`   ${status} ${result.agent}`);
  });
  
  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Run the tests
runAllTests();
