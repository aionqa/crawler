# AionQA Module Examples

This document provides comprehensive examples for each module using the database projects "dev3" and "asdasdas" with their URLs and credentials.

## Project Configurations

### Project: dev3
- **Project ID**: `dev3`
- **Description**: Development environment testing
- **Login URL**: `https://webapp.dev3.fmclarity.com/login`
- **Credentials**: 
  - Username: `dev3@fmclarity.com`
  - Password: `Dev3Test123!`
- **Target URLs**: 
  - Main App: `https://webapp.dev3.fmclarity.com/`
  - Dashboard: `https://webapp.dev3.fmclarity.com/dashboard`
  - API: `https://api.dev3.fmclarity.com/`

### Project: asdasdas
- **Project ID**: `asdasdas`
- **Description**: Test automation practice site
- **Login URL**: `https://practicetestautomation.com/practice-test-login/`
- **Credentials**:
  - Username: `student`
  - Password: `Password123`
- **Target URLs**:
  - Main Site: `https://practicetestautomation.com/`
  - Practice Tests: `https://practicetestautomation.com/practice-test-exceptions/`

## Module Examples

### 1. Login-Simplified Module

#### Example 1: dev3 Project
```json
{
  "jsonrpc": "2.0",
  "method": "attemptLogin",
  "params": {
    "url": "https://webapp.dev3.fmclarity.com/login",
    "cookies": [],
    "context": {
      "project_id": "dev3",
      "configuration_id": "dev3-login-config",
      "job_id": "dev3-login-job-001",
      "credentials": {
        "username": "dev3@fmclarity.com",
        "password": "Dev3Test123!"
      },
      "options": {
        "headless": true,
        "timeout": 30000,
        "max_retries": 3,
        "enable_screenshots": true,
        "enable_video_recording": false
      }
    }
  },
  "id": 1
}
```

**Expected Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "success": true,
    "confidence": 85,
    "summary": "Successfully logged into dev3 webapp using form-based authentication with 85% confidence after 2 attempts.",
    "result": {
      "url_after": "https://webapp.dev3.fmclarity.com/dashboard",
      "cookies": [
        {
          "name": "session_id",
          "value": "abc123def456",
          "domain": ".dev3.fmclarity.com",
          "path": "/",
          "secure": true,
          "httpOnly": true
        }
      ],
      "page_content": "<html>...dashboard content...</html>",
      "page_title": "Dashboard - FMClarity Dev3",
      "redirect_chain": [
        "https://webapp.dev3.fmclarity.com/login",
        "https://webapp.dev3.fmclarity.com/dashboard"
      ]
    },
    "artifacts": {
      "screenshots": [
        {
          "filename": "initial_page_1705123456789.png",
          "data": "base64encodedimage...",
          "timestamp": "2024-01-15T10:30:45.123Z",
          "description": "Initial login page"
        },
        {
          "filename": "login_success_1705123456790.png",
          "data": "base64encodedimage...",
          "timestamp": "2024-01-15T10:30:47.456Z",
          "description": "Login successful - dashboard view"
        }
      ],
      "video_file_id": null,
      "playwright_code": "// Standardized login process\nawait page.goto('https://webapp.dev3.fmclarity.com/login');\nawait page.fill('input[name=\"email\"]', 'dev3@fmclarity.com');\nawait page.fill('input[name=\"password\"]', 'Dev3Test123!');\nawait page.click('button[type=\"submit\"]');",
      "ai_prompts": [
        {
          "prompt": "Login success evaluation",
          "response": "{\"success\": true, \"confidence\": 85, \"reasoning\": \"URL changed to dashboard, session cookies present, user-specific content visible\"}",
          "timestamp": "2024-01-15T10:30:47.123Z",
          "purpose": "Evaluate login success based on page state"
        }
      ]
    },
    "ai_analysis": {
      "success_indicators": [
        "URL changed to dashboard page",
        "Session cookies present",
        "User-specific content visible",
        "Logout button present"
      ],
      "failure_indicators": [],
      "reasoning": "Login successful - URL changed from login page to dashboard, session cookies are set, and user-specific content is visible on the page.",
      "next_actions": []
    },
    "ai_summary": {
      "executive_summary": "Successfully logged into dev3 webapp using form-based authentication with 85% confidence after 2 attempts.",
      "detailed_summary": "The login operation targeted https://webapp.dev3.fmclarity.com/login and successfully authenticated using the provided credentials. The system first attempted direct form submission, which failed due to missing form validation. The second attempt used a more comprehensive approach that filled both email and password fields, waited for form validation, and successfully submitted. The final page showed a dashboard with user-specific content, confirming successful authentication.",
      "key_findings": [
        "Website uses email/password form authentication",
        "Form requires both email and password fields to be filled before submission",
        "Successful login redirects to dashboard page",
        "Session cookies are set upon successful authentication",
        "Page title changes from 'Login' to 'Dashboard - FMClarity Dev3' after login"
      ],
      "success_factors": [
        "Proper form field identification and filling",
        "Adequate wait time for form validation",
        "Correct submit button selection",
        "Successful navigation to dashboard page",
        "Session cookies properly set"
      ],
      "failure_factors": [
        "Initial attempt failed due to premature form submission"
      ],
      "recommendations": [
        "Use this successful approach for similar form-based login pages",
        "Always wait for form validation before submission",
        "Verify page title changes as success indicator",
        "Check for session cookies to confirm authentication"
      ],
      "technical_details": {
        "pages_analyzed": 2,
        "interactions_performed": 4,
        "ai_decisions_made": 2,
        "artifacts_collected": 2
      },
      "generated_at": "2024-01-15T10:30:47.789Z",
      "operation_type": "login",
      "context_used": {
        "project_id": "dev3",
        "configuration_id": "dev3-login-config",
        "job_id": "dev3-login-job-001",
        "has_credentials": true
      }
    },
    "metadata": {
      "module_name": "login-simplified",
      "duration_ms": 4500,
      "attempts": 2,
      "timestamp": "2024-01-15T10:30:47.789Z"
    }
  },
  "id": 1
}
```

#### Example 2: asdasdas Project
```json
{
  "jsonrpc": "2.0",
  "method": "attemptLogin",
  "params": {
    "url": "https://practicetestautomation.com/practice-test-login/",
    "cookies": [],
    "context": {
      "project_id": "asdasdas",
      "configuration_id": "asdasdas-login-config",
      "job_id": "asdasdas-login-job-001",
      "credentials": {
        "username": "student",
        "password": "Password123"
      },
      "options": {
        "headless": true,
        "timeout": 30000,
        "max_retries": 3,
        "enable_screenshots": true,
        "enable_video_recording": false
      }
    }
  },
  "id": 1
}
```

### 2. Login-Text Module

#### Example: dev3 Project
```json
{
  "jsonrpc": "2.0",
  "method": "attemptLogin",
  "params": {
    "url": "https://webapp.dev3.fmclarity.com/login",
    "cookies": [],
    "context": {
      "project_id": "dev3",
      "configuration_id": "dev3-text-login-config",
      "job_id": "dev3-text-login-job-001",
      "credentials": {
        "username": "dev3@fmclarity.com",
        "password": "Dev3Test123!"
      },
      "options": {
        "headless": true,
        "timeout": 30000,
        "max_retries": 3,
        "enable_screenshots": true,
        "enable_video_recording": false
      }
    }
  },
  "id": 1
}
```

### 3. Login-Media Module

#### Example: asdasdas Project
```json
{
  "jsonrpc": "2.0",
  "method": "attemptLogin",
  "params": {
    "url": "https://practicetestautomation.com/practice-test-login/",
    "cookies": [],
    "context": {
      "project_id": "asdasdas",
      "configuration_id": "asdasdas-media-login-config",
      "job_id": "asdasdas-media-login-job-001",
      "credentials": {
        "username": "student",
        "password": "Password123"
      },
      "options": {
        "headless": false,
        "timeout": 30000,
        "max_retries": 3,
        "enable_screenshots": true,
        "enable_video_recording": true
      }
    }
  },
  "id": 1
}
```

### 4. Login-Static Module

#### Example: dev3 Project
```json
{
  "jsonrpc": "2.0",
  "method": "attemptLogin",
  "params": {
    "url": "https://webapp.dev3.fmclarity.com/login",
    "cookies": [],
    "context": {
      "project_id": "dev3",
      "configuration_id": "dev3-static-login-config",
      "job_id": "dev3-static-login-job-001",
      "credentials": {
        "username": "dev3@fmclarity.com",
        "password": "Dev3Test123!"
      },
      "options": {
        "headless": true,
        "timeout": 30000,
        "max_retries": 3,
        "enable_screenshots": true,
        "enable_video_recording": false
      }
    }
  },
  "id": 1
}
```

### 5. Crawler-Simplified Module

#### Example 1: dev3 Project
```json
{
  "jsonrpc": "2.0",
  "method": "startCrawl",
  "params": {
    "url": "https://webapp.dev3.fmclarity.com/dashboard",
    "cookies": [
      {
        "name": "session_id",
        "value": "abc123def456",
        "domain": ".dev3.fmclarity.com",
        "path": "/",
        "secure": true,
        "httpOnly": true
      }
    ],
    "context": {
      "project_id": "dev3",
      "configuration_id": "dev3-crawl-config",
      "job_id": "dev3-crawl-job-001",
      "options": {
        "headless": true,
        "timeout": 30000,
        "max_retries": 2,
        "enable_screenshots": true,
        "enable_video_recording": false,
        "max_pages": 20,
        "max_depth": 3
      }
    }
  },
  "id": 1
}
```

**Expected Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "success": true,
    "confidence": 92,
    "summary": "Successfully crawled 15 pages from dev3 webapp, discovering 45 links and 8 forms with 92% confidence.",
    "result": {
      "url_after": "https://webapp.dev3.fmclarity.com/dashboard",
      "cookies": [
        {
          "name": "session_id",
          "value": "abc123def456",
          "domain": ".dev3.fmclarity.com",
          "path": "/",
          "secure": true,
          "httpOnly": true
        }
      ],
      "page_content": "<html>...dashboard content...</html>",
      "page_title": "Dashboard - FMClarity Dev3",
      "redirect_chain": [],
      "crawled_pages": [
        {
          "url": "https://webapp.dev3.fmclarity.com/dashboard",
          "title": "Dashboard - FMClarity Dev3",
          "content": "<html>...dashboard content...</html>",
          "links": [
            "https://webapp.dev3.fmclarity.com/profile",
            "https://webapp.dev3.fmclarity.com/settings",
            "https://webapp.dev3.fmclarity.com/reports"
          ],
          "forms": [
            {
              "action": "/search",
              "method": "GET",
              "fields": ["query"]
            }
          ]
        },
        {
          "url": "https://webapp.dev3.fmclarity.com/profile",
          "title": "Profile - FMClarity Dev3",
          "content": "<html>...profile content...</html>",
          "links": [
            "https://webapp.dev3.fmclarity.com/dashboard",
            "https://webapp.dev3.fmclarity.com/settings"
          ],
          "forms": [
            {
              "action": "/profile/update",
              "method": "POST",
              "fields": ["name", "email", "phone"]
            }
          ]
        }
      ]
    },
    "artifacts": {
      "screenshots": [
        {
          "filename": "crawl_dashboard_1705123456789.png",
          "data": "base64encodedimage...",
          "timestamp": "2024-01-15T10:35:45.123Z",
          "description": "Dashboard page during crawl"
        },
        {
          "filename": "crawl_profile_1705123456790.png",
          "data": "base64encodedimage...",
          "timestamp": "2024-01-15T10:35:47.456Z",
          "description": "Profile page during crawl"
        }
      ],
      "video_file_id": null,
      "playwright_code": "// Standardized crawl process\nawait page.goto('https://webapp.dev3.fmclarity.com/dashboard');\nconst links = await page.locator('a[href]').all();\nfor (const link of links) {\n  const href = await link.getAttribute('href');\n  if (href && href.startsWith('/')) {\n    await page.goto(new URL(href, page.url()));\n    // Analyze page content\n  }\n}",
      "ai_prompts": [
        {
          "prompt": "Crawl success evaluation",
          "response": "{\"success\": true, \"confidence\": 92, \"reasoning\": \"Successfully discovered and analyzed 15 pages, found 45 links and 8 forms\"}",
          "timestamp": "2024-01-15T10:35:47.123Z",
          "purpose": "Evaluate crawl success based on discovered content"
        }
      ]
    },
    "ai_analysis": {
      "success_indicators": [
        "Successfully discovered 15 pages",
        "Found 45 internal links",
        "Identified 8 forms",
        "No broken links detected",
        "Content extraction successful"
      ],
      "failure_indicators": [],
      "reasoning": "Crawl successful - discovered and analyzed 15 pages within the specified limits, found 45 internal links and 8 forms, with no broken links or accessibility issues.",
      "next_actions": []
    },
    "ai_summary": {
      "executive_summary": "Successfully crawled 15 pages from dev3 webapp, discovering 45 links and 8 forms with 92% confidence.",
      "detailed_summary": "The crawl operation started at https://webapp.dev3.fmclarity.com/dashboard and systematically explored the website structure. The AI successfully identified and followed internal links, avoiding external redirects and duplicate pages. The crawler discovered a well-structured webapp with clear navigation patterns, including dashboard, profile, settings, and reports sections. All discovered pages were successfully analyzed for content, links, and forms.",
      "key_findings": [
        "Webapp has a clear hierarchical structure with 4 main sections",
        "Navigation menu contains 8 primary links",
        "Dashboard contains 12 additional links",
        "Content pages contain an average of 3 internal links each",
        "8 forms discovered across different pages",
        "No broken links or accessibility issues found"
      ],
      "success_factors": [
        "Efficient link discovery and filtering",
        "Proper depth control preventing infinite loops",
        "Successful content extraction from all pages",
        "Accurate form detection and analysis",
        "Good performance within time limits"
      ],
      "failure_factors": [],
      "recommendations": [
        "Consider crawling deeper levels for more comprehensive coverage",
        "Implement form interaction testing for discovered forms",
        "Add accessibility analysis for better website assessment",
        "Consider implementing link validation for broken link detection"
      ],
      "technical_details": {
        "pages_analyzed": 15,
        "interactions_performed": 23,
        "ai_decisions_made": 12,
        "artifacts_collected": 15
      },
      "generated_at": "2024-01-15T10:35:47.789Z",
      "operation_type": "crawl",
      "context_used": {
        "project_id": "dev3",
        "configuration_id": "dev3-crawl-config",
        "job_id": "dev3-crawl-job-001",
        "has_credentials": false
      }
    },
    "metadata": {
      "module_name": "crawler-simplified",
      "duration_ms": 12000,
      "attempts": 1,
      "timestamp": "2024-01-15T10:35:47.789Z"
    }
  },
  "id": 1
}
```

#### Example 2: asdasdas Project
```json
{
  "jsonrpc": "2.0",
  "method": "startCrawl",
  "params": {
    "url": "https://practicetestautomation.com/",
    "cookies": [],
    "context": {
      "project_id": "asdasdas",
      "configuration_id": "asdasdas-crawl-config",
      "job_id": "asdasdas-crawl-job-001",
      "options": {
        "headless": true,
        "timeout": 30000,
        "max_retries": 2,
        "enable_screenshots": true,
        "enable_video_recording": false,
        "max_pages": 10,
        "max_depth": 2
      }
    }
  },
  "id": 1
}
```

### 6. Crawler-Text Module

#### Example: dev3 Project
```json
{
  "jsonrpc": "2.0",
  "method": "startCrawl",
  "params": {
    "url": "https://webapp.dev3.fmclarity.com/dashboard",
    "cookies": [
      {
        "name": "session_id",
        "value": "abc123def456",
        "domain": ".dev3.fmclarity.com",
        "path": "/",
        "secure": true,
        "httpOnly": true
      }
    ],
    "context": {
      "project_id": "dev3",
      "configuration_id": "dev3-text-crawl-config",
      "job_id": "dev3-text-crawl-job-001",
      "options": {
        "headless": true,
        "timeout": 30000,
        "max_retries": 2,
        "enable_screenshots": true,
        "enable_video_recording": false,
        "max_pages": 15,
        "max_depth": 2
      }
    }
  },
  "id": 1
}
```

### 7. Crawler-Media Module

#### Example: asdasdas Project
```json
{
  "jsonrpc": "2.0",
  "method": "startCrawl",
  "params": {
    "url": "https://practicetestautomation.com/",
    "cookies": [],
    "context": {
      "project_id": "asdasdas",
      "configuration_id": "asdasdas-media-crawl-config",
      "job_id": "asdasdas-media-crawl-job-001",
      "options": {
        "headless": false,
        "timeout": 30000,
        "max_retries": 2,
        "enable_screenshots": true,
        "enable_video_recording": true,
        "max_pages": 8,
        "max_depth": 2
      }
    }
  },
  "id": 1
}
```

### 8. Crawler-Static Module

#### Example: dev3 Project
```json
{
  "jsonrpc": "2.0",
  "method": "startCrawl",
  "params": {
    "url": "https://webapp.dev3.fmclarity.com/dashboard",
    "cookies": [
      {
        "name": "session_id",
        "value": "abc123def456",
        "domain": ".dev3.fmclarity.com",
        "path": "/",
        "secure": true,
        "httpOnly": true
      }
    ],
    "context": {
      "project_id": "dev3",
      "configuration_id": "dev3-static-crawl-config",
      "job_id": "dev3-static-crawl-job-001",
      "options": {
        "headless": true,
        "timeout": 30000,
        "max_retries": 2,
        "enable_screenshots": true,
        "enable_video_recording": false,
        "max_pages": 12,
        "max_depth": 2
      }
    }
  },
  "id": 1
}
```

## Backend API Examples

### Login Request via Backend
```bash
curl -X POST http://localhost:4000/dynamic/login \
  -H "Content-Type: application/json" \
  -d '{
    "module_name": "simplified",
    "target_url": "https://webapp.dev3.fmclarity.com/login",
    "credentials": {
      "username": "dev3@fmclarity.com",
      "password": "Dev3Test123!"
    },
    "options": {
      "headless": true,
      "timeout": 30000,
      "enable_screenshots": true,
      "enable_video_recording": false
    },
    "ai_context": {
      "project_id": "dev3",
      "configuration_id": "dev3-login-config",
      "job_id": "dev3-login-job-001"
    }
  }'
```

### Crawl Request via Backend
```bash
curl -X POST http://localhost:4000/dynamic/crawl \
  -H "Content-Type: application/json" \
  -d '{
    "module_name": "simplified",
    "target_url": "https://webapp.dev3.fmclarity.com/dashboard",
    "cookies": [
      {
        "name": "session_id",
        "value": "abc123def456",
        "domain": ".dev3.fmclarity.com",
        "path": "/",
        "secure": true,
        "httpOnly": true
      }
    ],
    "options": {
      "headless": true,
      "timeout": 30000,
      "max_pages": 20,
      "max_depth": 3,
      "enable_screenshots": true,
      "enable_video_recording": false
    },
    "ai_context": {
      "project_id": "dev3",
      "configuration_id": "dev3-crawl-config",
      "job_id": "dev3-crawl-job-001"
    }
  }'
```

## Testing Commands

### Test Login-Simplified Module
```bash
# Test dev3 project
curl -X POST http://localhost:3001/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "attemptLogin",
    "params": {
      "url": "https://webapp.dev3.fmclarity.com/login",
      "cookies": [],
      "context": {
        "project_id": "dev3",
        "credentials": {
          "username": "dev3@fmclarity.com",
          "password": "Dev3Test123!"
        },
        "options": {
          "headless": true,
          "enable_screenshots": true
        }
      }
    },
    "id": 1
  }'

# Test asdasdas project
curl -X POST http://localhost:3001/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "attemptLogin",
    "params": {
      "url": "https://practicetestautomation.com/practice-test-login/",
      "cookies": [],
      "context": {
        "project_id": "asdasdas",
        "credentials": {
          "username": "student",
          "password": "Password123"
        },
        "options": {
          "headless": true,
          "enable_screenshots": true
        }
      }
    },
    "id": 1
  }'
```

### Test Crawler-Simplified Module
```bash
# Test dev3 project
curl -X POST http://localhost:3101/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "startCrawl",
    "params": {
      "url": "https://webapp.dev3.fmclarity.com/dashboard",
      "cookies": [
        {
          "name": "session_id",
          "value": "abc123def456",
          "domain": ".dev3.fmclarity.com",
          "path": "/",
          "secure": true,
          "httpOnly": true
        }
      ],
      "context": {
        "project_id": "dev3",
        "options": {
          "headless": true,
          "max_pages": 10,
          "max_depth": 2,
          "enable_screenshots": true
        }
      }
    },
    "id": 1
  }'

# Test asdasdas project
curl -X POST http://localhost:3101/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "startCrawl",
    "params": {
      "url": "https://practicetestautomation.com/",
      "cookies": [],
      "context": {
        "project_id": "asdasdas",
        "options": {
          "headless": true,
          "max_pages": 8,
          "max_depth": 2,
          "enable_screenshots": true
        }
      }
    },
    "id": 1
  }'
```

## Expected AI Summary Outputs

### Login Success Summary
```
📋 [AI SUMMARY] Executive Summary: Successfully logged into dev3 webapp using form-based authentication with 85% confidence after 2 attempts.
📋 [AI SUMMARY] Key Findings: Website uses email/password form authentication, Form requires both email and password fields to be filled before submission, Successful login redirects to dashboard page
📋 [AI SUMMARY] Success Factors: Proper form field identification and filling, Adequate wait time for form validation, Correct submit button selection
📋 [AI SUMMARY] Failure Factors: Initial attempt failed due to premature form submission
📋 [AI SUMMARY] Recommendations: Use this successful approach for similar form-based login pages, Always wait for form validation before submission, Verify page title changes as success indicator
📋 [AI SUMMARY] Context Used: Project=dev3, Job=dev3-login-job-001, Has Credentials=true
```

### Crawl Success Summary
```
📋 [AI SUMMARY] Executive Summary: Successfully crawled 15 pages from dev3 webapp, discovering 45 links and 8 forms with 92% confidence.
📋 [AI SUMMARY] Key Findings: Webapp has a clear hierarchical structure with 4 main sections, Navigation menu contains 8 primary links, Dashboard contains 12 additional links
📋 [AI SUMMARY] Success Factors: Efficient link discovery and filtering, Proper depth control preventing infinite loops, Successful content extraction from all pages
📋 [AI SUMMARY] Failure Factors: None
📋 [AI SUMMARY] Recommendations: Consider crawling deeper levels for more comprehensive coverage, Implement form interaction testing for discovered forms
📋 [AI SUMMARY] Context Used: Project=dev3, Job=dev3-crawl-job-001, Has Credentials=false
```

These examples provide comprehensive templates for testing all modules with both dev3 and asdasdas projects, including realistic URLs, credentials, and expected responses with detailed AI summaries.
