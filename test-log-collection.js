#!/usr/bin/env node

/**
 * Test script to verify log collection is working
 */

import axios from 'axios';

async function testLogCollection() {
  console.log('🧪 Testing AionQA log collection...');
  
  try {
    // Send a test log to Graylog
    const testLog = {
      version: '1.1',
      host: 'aionqa-test',
      short_message: 'AionQA log collection test - ' + new Date().toISOString(),
      timestamp: Date.now() / 1000,
      level: 6,
      _component: 'test',
      _agentName: 'test-agent',
      _jobId: 'test-job-' + Date.now(),
      _projectId: 'test-project',
      _testType: 'log_collection_verification'
    };
    
    console.log('📤 Sending test log to Graylog...');
    const response = await axios.post('http://localhost:12201/gelf', testLog, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000
    });
    
    console.log(`✅ Test log sent successfully! Status: ${response.status}`);
    console.log('🌐 Check Graylog web interface at: http://localhost:9000');
    console.log('🔍 Search for: "AionQA log collection test"');
    console.log('👤 Login: admin / admin');
    
    // Wait a moment for the log to be processed
    console.log('⏳ Waiting 5 seconds for log processing...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    console.log('✅ Log collection test completed!');
    console.log('');
    console.log('📊 Next steps:');
    console.log('1. Open http://localhost:9000');
    console.log('2. Login with admin/admin');
    console.log('3. Go to Search tab');
    console.log('4. Look for your test log');
    console.log('5. Your AionQA agents will now send logs automatically!');
    
  } catch (error) {
    console.error('❌ Log collection test failed:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
  }
}

testLogCollection();
