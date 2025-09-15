# AionQA Standardized Communication Format

## Overview

This document defines the standardized communication format between the AionQA backend and all agent modules (login and crawler agents). This format ensures consistent, reliable communication and proper success/failure detection.

## Core Principles

1. **Strict Input/Output Format**: Only specified fields are allowed in requests and responses
2. **AI-Driven Success Evaluation**: Each module uses AI to determine actual success/failure
3. **Comprehensive Artifact Collection**: All interactions must capture screenshots, prompts, and code
4. **Standardized Error Handling**: Consistent error reporting across all modules
5. **No Custom Fields**: Any additional fields beyond the standard are considered failures

## Standard Input Format

All agent modules MUST accept requests in this exact format:

```json
{
  "url": "string (required) - Target URL for the operation",
  "cookies": [
    {
      "name": "string (required)",
      "value": "string (required)", 
      "domain": "string (optional)",
      "path": "string (optional)",
      "expires": "number (optional)",
      "httpOnly": "boolean (optional)",
      "secure": "boolean (optional)"
    }
  ],
  "context": {
    "project_id": "string (required)",
    "configuration_id": "string (optional)",
    "job_id": "string (optional)",
    "credentials": {
      "username": "string (optional)",
      "password": "string (optional)"
    },
    "options": {
      "headless": "boolean (default: true)",
      "timeout": "number (default: 30000)",
      "max_retries": "number (default: 2)",
      "enable_screenshots": "boolean (default: true)",
      "enable_video_recording": "boolean (default: false)"
    }
  }
}
```

## Standard Output Format

All agent modules MUST return responses in this exact format:

```json
{
  "success": "boolean (required) - AI-determined success status",
  "confidence": "number (required) - AI confidence level (0-100)",
  "summary": "string (required) - Human-readable summary of the operation",
  "result": {
    "url_after": "string (required) - Final URL after operation",
    "cookies": [
      {
        "name": "string (required)",
        "value": "string (required)",
        "domain": "string (optional)",
        "path": "string (optional)", 
        "expires": "number (optional)",
        "httpOnly": "boolean (optional)",
        "secure": "boolean (optional)"
      }
    ],
    "page_content": "string (required) - HTML content of final page",
    "page_title": "string (required) - Title of final page",
    "redirect_chain": [
      "string (optional) - Array of URLs in redirect chain"
    ]
  },
  "artifacts": {
    "screenshots": [
      {
        "filename": "string (required)",
        "data": "string (required) - Base64 encoded image",
        "timestamp": "string (required) - ISO timestamp",
        "description": "string (required) - Description of screenshot"
      }
    ],
    "video_file_id": "string (optional) - GridFS file ID for video recording",
    "playwright_code": "string (required) - Complete Playwright code executed",
    "ai_prompts": [
      {
        "prompt": "string (required)",
        "response": "string (required)",
        "timestamp": "string (required) - ISO timestamp",
        "purpose": "string (required) - Purpose of the prompt"
      }
    ]
  },
  "ai_analysis": {
    "success_indicators": [
      "string (required) - Array of indicators that suggest success"
    ],
    "failure_indicators": [
      "string (required) - Array of indicators that suggest failure"
    ],
    "reasoning": "string (required) - AI reasoning for success/failure determination",
    "next_actions": [
      "string (optional) - Array of suggested next actions"
    ]
  },
  "ai_summary": {
    "executive_summary": "string (required) - Brief 1-2 sentence summary of what happened",
    "detailed_summary": "string (required) - Comprehensive breakdown of the entire operation",
    "key_findings": [
      "string (required) - Array of important discoveries"
    ],
    "success_factors": [
      "string (required) - Array of what contributed to success"
    ],
    "failure_factors": [
      "string (required) - Array of what caused failures"
    ],
    "recommendations": [
      "string (required) - Array of what should be done next"
    ],
    "technical_details": {
      "pages_analyzed": "number (required)",
      "interactions_performed": "number (required)",
      "ai_decisions_made": "number (required)",
      "artifacts_collected": "number (required)"
    },
    "generated_at": "string (required) - ISO timestamp",
    "operation_type": "string (required) - Type of operation (login/crawl)",
    "context_used": {
      "project_id": "string (optional)",
      "configuration_id": "string (optional)",
      "job_id": "string (optional)",
      "has_credentials": "boolean (required)"
    }
  },
  "metadata": {
    "module_name": "string (required) - Name of the agent module",
    "duration_ms": "number (required) - Total operation duration",
    "attempts": "number (required) - Number of attempts made",
    "timestamp": "string (required) - ISO timestamp of completion"
  }
}
```

## AI Success Evaluation Requirements

Each module MUST implement AI-based success evaluation with the following criteria:

### Login Modules
- **Success Indicators**: URL change to non-login pages, presence of session cookies, user-specific content, logout buttons
- **Failure Indicators**: Error messages, remaining on login page, invalid credentials messages, no session cookies
- **Confidence Threshold**: Minimum 70% confidence required for success determination

### Crawler Modules  
- **Success Indicators**: Successful page loads, content extraction, link discovery, form detection
- **Failure Indicators**: Network errors, empty content, blocked requests, timeout errors
- **Confidence Threshold**: Minimum 60% confidence required for success determination

## Error Handling

### Standard Error Format
```json
{
  "success": false,
  "confidence": 0,
  "summary": "string (required) - Error description",
  "result": null,
  "artifacts": {
    "screenshots": [],
    "video_file_id": null,
    "playwright_code": "string (required) - Code that was attempted",
    "ai_prompts": []
  },
  "ai_analysis": {
    "success_indicators": [],
    "failure_indicators": ["string (required) - Error description"],
    "reasoning": "string (required) - Why the operation failed",
    "next_actions": []
  },
  "metadata": {
    "module_name": "string (required)",
    "duration_ms": "number (required)",
    "attempts": "number (required)",
    "timestamp": "string (required)"
  },
  "error": {
    "code": "string (required) - Error code",
    "message": "string (required) - Error message",
    "details": "object (optional) - Additional error details"
  }
}
```

## Implementation Requirements

### Backend Changes
1. **Request Validation**: Validate all incoming requests against the standard format
2. **Response Processing**: Process only standardized response fields
3. **Success Detection**: Use AI-determined success status, not custom logic
4. **Artifact Storage**: Store all artifacts (screenshots, videos, code) in GridFS
5. **Error Handling**: Handle all errors through the standard error format

### Agent Module Changes
1. **Input Validation**: Reject requests that don't match the standard format
2. **AI Integration**: Implement AI success evaluation for all operations
3. **Artifact Collection**: Capture all required artifacts during execution
4. **Response Formatting**: Return only standardized response fields
5. **Error Reporting**: Use standard error format for all failures

## Validation Rules

### Input Validation
- Reject requests with unknown fields
- Require all mandatory fields
- Validate field types and formats
- Return validation errors in standard format

### Output Validation  
- Ensure all required fields are present
- Validate field types and formats
- Reject responses with unknown fields
- Log validation failures for debugging

## Migration Strategy

1. **Phase 1**: Update API contracts and validation schemas
2. **Phase 2**: Implement AI evaluation in all modules
3. **Phase 3**: Update backend to use standardized responses
4. **Phase 4**: Deploy and test all modules
5. **Phase 5**: Remove legacy communication code

## Testing Requirements

### Unit Tests
- Test input validation for all modules
- Test output format compliance
- Test AI evaluation accuracy
- Test error handling

### Integration Tests
- Test end-to-end communication
- Test artifact collection and storage
- Test success/failure detection
- Test error propagation

### Performance Tests
- Test response times with new format
- Test artifact upload performance
- Test AI evaluation latency
- Test memory usage with artifacts

## Compliance Checklist

- [ ] All modules accept only standardized input format
- [ ] All modules return only standardized output format
- [ ] AI success evaluation implemented in all modules
- [ ] Artifact collection implemented in all modules
- [ ] Error handling uses standard format
- [ ] Backend processes only standardized responses
- [ ] Validation schemas updated
- [ ] Tests updated for new format
- [ ] Documentation updated

## Enforcement

**CRITICAL**: Any module that does not comply with this standard will be considered non-functional. The backend will reject non-compliant responses and mark the operation as failed.

This standard ensures reliable, consistent communication and proper success detection across the entire AionQA system.
