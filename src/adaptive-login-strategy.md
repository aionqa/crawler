# Adaptive Universal Login Strategy

## Overview
This login workflow automatically adapts to different authentication systems without manual configuration.

## Key Adaptive Features

### 1. **Multi-Step Login Detection**
- Automatically detects email-first authentication flows
- Handles password fields that appear after email submission
- Supports OAuth redirect flows
- Manages session tokens across domains

### 2. **Dynamic Element Detection**
- Uses AI to identify form fields and submit buttons
- Adapts to different form structures:
  - Traditional username/password forms
  - Email-first multi-step forms
  - OAuth login flows
  - Captcha-protected forms

### 3. **Smart Selector Resolution**
- Extracts ID-based selectors from complex selectors
- Falls back to multiple selector strategies
- Handles dynamic button IDs and classes

### 4. **Navigation Handling**
- Waits for page navigation with configurable timeouts
- Handles OAuth redirects between domains
- Detects success by URL changes and cookie presence

### 5. **Cookie Collection**
- Collects cookies from all domains
- Identifies authentication tokens automatically
- Stores cookies for use in subsequent requests

## Workflow Steps

1. **Navigate** - Go to login page
2. **Screenshot** - Capture page state
3. **Collect Elements** - Gather interactive elements
4. **AI Detection** - Analyze form structure
5. **Fill Credentials** - Input username/email
6. **Submit Form** - Click submit button
7. **Detect Multi-Step** - Check for password field
8. **Fill Password** - If multi-step, fill password
9. **Submit Password** - Submit password form
10. **Collect Cookies** - Gather all authentication cookies
11. **Validate Success** - Verify login completion

## Supported Login Types

✅ Traditional username/password  
✅ Email-first multi-step authentication  
✅ OAuth flows (Google, Microsoft, etc.)  
✅ Redirect-based authentication  
✅ Session-based systems  
✅ Token-based authentication  

## Configuration Options

- `adaptiveMultiStep`: Automatically handle multi-step flows
- `waitForNavigation`: Wait for redirects after submission
- `timeout`: Configurable timeouts for each step
- `allDomains`: Collect cookies from all domains

## Error Handling

- Retries failed operations with exponential backoff
- Falls back to alternative selectors if primary fails
- Logs detailed error information for debugging
- Validates success before completing workflow

## Usage

This workflow is now the default for all login operations. It will automatically adapt to any login system without manual configuration.


