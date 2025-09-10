#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load contract files
function loadContract(filename) {
  const filePath = path.join(__dirname, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Contract file not found: ${filename}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Validate JSON schema structure
function validateSchema(schema, name) {
  const errors = [];
  
  if (!schema || typeof schema !== 'object') {
    errors.push(`${name}: Schema must be an object`);
    return errors;
  }
  
  // Basic validation for required fields
  if (schema.endpoints) {
    for (const [endpointName, endpoint] of Object.entries(schema.endpoints)) {
      if (!endpoint.method || !endpoint.path) {
        errors.push(`${name}.${endpointName}: Missing method or path`);
      }
      if (!endpoint.request && !endpoint.response) {
        errors.push(`${name}.${endpointName}: Missing request or response schema`);
      }
    }
  }
  
  return errors;
}

// Main validation function
function validateContracts(contractType = null) {
  console.log('🔍 Validating API contracts...\n');
  
  const contracts = [];
  
  if (!contractType || contractType === 'login') {
    contracts.push({ name: 'Login Contracts', file: 'login-contracts.json' });
  }
  
  if (!contractType || contractType === 'crawler') {
    contracts.push({ name: 'Crawler Contracts', file: 'crawler-contracts.json' });
  }
  
  if (!contractType) {
    contracts.push({ name: 'Common Types', file: 'common-types.json' });
  }
  
  let hasErrors = false;
  
  for (const contract of contracts) {
    try {
      console.log(`📋 Validating ${contract.name}...`);
      const schema = loadContract(contract.file);
      const errors = validateSchema(schema, contract.name);
      
      if (errors.length > 0) {
        console.log(`❌ ${contract.name} validation failed:`);
        errors.forEach(error => console.log(`   - ${error}`));
        hasErrors = true;
      } else {
        console.log(`✅ ${contract.name} is valid`);
      }
    } catch (error) {
      console.log(`❌ ${contract.name} validation failed: ${error.message}`);
      hasErrors = true;
    }
  }
  
  console.log('\n' + '='.repeat(50));
  
  if (hasErrors) {
    console.log('❌ Contract validation failed');
    process.exit(1);
  } else {
    console.log('✅ All contracts are valid');
    console.log('\n📝 Next steps:');
    console.log('   1. Update backend code to match contracts');
    console.log('   2. Update agent module code to match contracts');
    console.log('   3. Test API integration');
  }
}

// CLI interface
const args = process.argv.slice(2);
const contractType = args[0] || null;

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node validate-contracts.js [contract-type]

Contract types:
  login     - Validate only login contracts
  crawler   - Validate only crawler contracts
  (none)    - Validate all contracts

Examples:
  node validate-contracts.js
  node validate-contracts.js login
  node validate-contracts.js crawler
`);
  process.exit(0);
}

validateContracts(contractType);
