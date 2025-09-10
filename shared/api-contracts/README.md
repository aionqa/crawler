# AionQA API Contracts

This directory contains standardized API contracts between the backend and agent modules (login/crawler). These contracts ensure synchronization when making changes to either side.

## Structure

- `login-contracts.json` - Login agent API specifications
- `crawler-contracts.json` - Crawler agent API specifications
- `common-types.json` - Shared types and schemas
- `validation-schemas.js` - Zod validation schemas for TypeScript/JavaScript

## Usage

When making changes to API contracts:

1. **Update the contract files** in this directory
2. **Update backend code** to match the contracts
3. **Update agent module code** to match the contracts
4. **Run validation** to ensure compatibility

## Validation

```bash
# Validate all contracts
node shared/api-contracts/validate-contracts.js

# Validate specific contract
node shared/api-contracts/validate-contracts.js login
```

## Cursor AI Integration

Each module's `.cursorrules` file references these contracts to ensure Cursor AI maintains synchronization when making changes.
