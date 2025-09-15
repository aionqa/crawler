#!/usr/bin/env node

/**
 * Test script for the new standardized communication format
 * 
 * This script tests the standardized communication between backend and agent modules
 * to ensure proper success/failure detection and AI evaluation.
 */

import fetch from 'node-fetch';

const BACKEND_URL = 'http://localhost:4000';
const LOGIN_AGENT_URL = 'http://localhost:3001';

// Test data
const testProject = {
  project_id: 'test-standardized-comm',
  configuration_id: 'test-config-1',
  job_id: 'test-job-1'
};

const testCredentials = {
  username: 'testuser',
  password: 'testpass'
};

const testUrl = 'https://practicetestautomation.com/practice-test-login/';

/**
 * Test the standardized login request format
 */
async function testStandardizedLoginRequest() {
  console.log('\n🧪 Testing Standardized Login Request Format...');
  
  try {
    const payload = {
      jsonrpc: '2.0',
      method: 'attemptLogin',
      params: {
        url: testUrl,
        cookies: [],
        context: {
          project_id: testProject.project_id,
          configuration_id: testProject.configuration_id,
          job_id: testProject.job_id,
          credentials: testCredentials,
          options: {
            headless: true,
            timeout: 30000,
            max_retries: 2,
            enable_screenshots: true,
            enable_video_recording: false
          }
        }
      },
      id: 1
    };

    console.log('📤 Sending standardized request to login agent...');
    console.log('📋 Request payload:', JSON.stringify(payload, null, 2));

    const response = await fetch(`${LOGIN_AGENT_URL}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    console.log('📥 Response received:');
    console.log('📊 Success:', result.result?.success);
    console.log('🎯 Confidence:', result.result?.confidence);
    console.log('📝 Summary:', result.result?.summary);
    
    if (result.result?.ai_analysis) {
      console.log('🤖 AI Analysis:');
      console.log('   Reasoning:', result.result.ai_analysis.reasoning);
      console.log('   Success indicators:', result.result.ai_analysis.success_indicators);
      console.log('   Failure indicators:', result.result.ai_analysis.failure_indicators);
    }
    
    if (result.result?.ai_summary) {
      console.log('📋 AI Summary:');
      console.log('   Executive Summary:', result.result.ai_summary.executive_summary);
      console.log('   Key Findings:', result.result.ai_summary.key_findings);
      console.log('   Success Factors:', result.result.ai_summary.success_factors);
      console.log('   Failure Factors:', result.result.ai_summary.failure_factors);
      console.log('   Recommendations:', result.result.ai_summary.recommendations);
      console.log('   Context Used:', result.result.ai_summary.context_used);
      console.log('   Technical Details:', result.result.ai_summary.technical_details);
    }
    
    if (result.result?.artifacts) {
      console.log('📸 Artifacts:');
      console.log('   Screenshots:', result.result.artifacts.screenshots?.length || 0);
      console.log('   AI prompts:', result.result.artifacts.ai_prompts?.length || 0);
      console.log('   Playwright code length:', result.result.artifacts.playwright_code?.length || 0);
    }
    
    if (result.result?.metadata) {
      console.log('📊 Metadata:');
      console.log('   Module:', result.result.metadata.module_name);
      console.log('   Duration:', result.result.metadata.duration_ms, 'ms');
      console.log('   Attempts:', result.result.metadata.attempts);
    }

    // Validate response format
    const validation = validateStandardizedResponse(result.result);
    if (validation.isValid) {
      console.log('✅ Response format validation: PASSED');
    } else {
      console.log('❌ Response format validation: FAILED');
      console.log('   Errors:', validation.errors);
    }

    return result.result;

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    return null;
  }
}

/**
 * Test the backend's handling of standardized responses
 */
async function testBackendStandardizedHandling() {
  console.log('\n🧪 Testing Backend Standardized Response Handling...');
  
  try {
    const payload = {
      module_name: 'simplified',
      target_url: testUrl,
      credentials: testCredentials,
      options: {
        headless: true,
        timeout: 30000,
        enable_screenshots: true,
        enable_video_recording: false
      },
      ai_context: testProject
    };

    console.log('📤 Sending request to backend...');
    console.log('📋 Request payload:', JSON.stringify(payload, null, 2));

    const response = await fetch(`${BACKEND_URL}/dynamic/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    console.log('📥 Backend response:');
    console.log('📊 Success:', result.success);
    console.log('🎯 Confidence:', result.confidence);
    console.log('📝 Summary:', result.summary);
    console.log('🔧 Is Standardized Response:', result.isStandardizedResponse);
    
    if (result.result?.result) {
      console.log('🤖 Agent AI Analysis:');
      console.log('   Reasoning:', result.result.result.ai_analysis?.reasoning);
      console.log('   Success indicators:', result.result.result.ai_analysis?.success_indicators);
      console.log('   Failure indicators:', result.result.result.ai_analysis?.failure_indicators);
    }

    return result;

  } catch (error) {
    console.error('❌ Backend test failed:', error.message);
    return null;
  }
}

/**
 * Validate standardized response format
 */
function validateStandardizedResponse(response) {
  const errors = [];
  
  if (!response) {
    errors.push('Response is null or undefined');
    return { isValid: false, errors };
  }
  
  // Check required top-level fields
  const requiredFields = ['success', 'confidence', 'summary', 'result', 'artifacts', 'ai_analysis', 'ai_summary', 'metadata'];
  for (const field of requiredFields) {
    if (!(field in response)) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  
  // Check success field type
  if (typeof response.success !== 'boolean') {
    errors.push('Field "success" must be a boolean');
  }
  
  // Check confidence field
  if (typeof response.confidence !== 'number' || response.confidence < 0 || response.confidence > 100) {
    errors.push('Field "confidence" must be a number between 0 and 100');
  }
  
  // Check summary field
  if (typeof response.summary !== 'string') {
    errors.push('Field "summary" must be a string');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Run all tests
 */
async function runTests() {
  console.log('🚀 Starting Standardized Communication Tests...');
  console.log('📋 Test Configuration:');
  console.log(`   Backend URL: ${BACKEND_URL}`);
  console.log(`   Login Agent URL: ${LOGIN_AGENT_URL}`);
  console.log(`   Test URL: ${testUrl}`);
  console.log(`   Project ID: ${testProject.project_id}`);
  
  // Test 1: Direct agent communication
  const agentResult = await testStandardizedLoginRequest();
  
  // Test 2: Backend communication
  const backendResult = await testBackendStandardizedHandling();
  
  // Summary
  console.log('\n📊 Test Summary:');
  console.log('   Agent Direct Test:', agentResult ? '✅ PASSED' : '❌ FAILED');
  console.log('   Backend Integration Test:', backendResult ? '✅ PASSED' : '❌ FAILED');
  
  if (agentResult && backendResult) {
    console.log('\n🎉 All tests passed! Standardized communication is working correctly.');
  } else {
    console.log('\n⚠️  Some tests failed. Check the logs above for details.');
  }
}

// Run tests if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().catch(console.error);
}

export { testStandardizedLoginRequest, testBackendStandardizedHandling, validateStandardizedResponse };
