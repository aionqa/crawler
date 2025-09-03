# Domain Crawler Guide

This guide explains how to use the AI Crawler's domain crawling functionality to automatically discover and analyze entire websites, including pages, actions, and interactive elements.

## Overview

The Domain Crawler is a powerful tool that:

- **Crawls entire domains** starting from a base URL
- **Discovers pages** by following links within the same domain
- **Analyzes each page** with AI to extract interactive elements
- **Saves pages and actions** to the database for further analysis
- **Handles authentication** with login credentials and cookie persistence
- **Configurable crawling** with depth and page limits

## How to Start Domain Crawling

### Method 1: Using the Web Interface (Recommended)

1. **Start the system:**
   ```bash
   ./start-all.sh
   ```

2. **Navigate to:** `http://localhost:5173`

3. **Create a project** (if you haven't already)

4. **Create a configuration:**
   - Go to "Data Management" → "Configurations" tab
   - Click "+ New Configuration"
   - Fill in domain URL and settings
   - Add login credentials if needed
   - Enable cookie saving if desired

5. **Start the crawl:**
   - In the configurations list, click "Start Crawl"
   - Set maximum pages and depth
   - Click "Start Crawl" to begin

### Method 2: Using Command Line

```bash
# Basic crawl
npm run crawl -- --project <PROJECT_ID> --config <CONFIG_ID>

# With custom limits
npm run crawl -- --project <PROJECT_ID> --config <CONFIG_ID> --max-pages 200 --max-depth 4
```

## Crawling Process

### 1. Initialization
- **Loads configuration** (domain, login settings, browser options)
- **Creates run record** to track progress
- **Initializes browser** with specified settings
- **Loads saved cookies** if available

### 2. Authentication (if enabled)
- **Navigates to login URL**
- **Fills username/password** automatically
- **Submits login form**
- **Saves cookies** if cookie saving is enabled
- **Validates login success**

### 3. Domain Crawling
- **Starts from seed URL** (configuration domain)
- **Discovers links** on each page
- **Follows same-domain links** only
- **Respects depth limits** to prevent infinite crawling
- **Tracks visited URLs** to avoid duplicates

### 4. Page Analysis
For each discovered page:
- **Captures HTML** and screenshots
- **Analyzes with AI** to extract interactive elements
- **Saves page data** to database
- **Extracts actions** (links, forms, buttons)
- **Discovers new URLs** for crawling

### 5. Action Discovery
The crawler automatically identifies:
- **Links** - for navigation and URL discovery
- **Forms** - with input fields and submission details
- **Buttons** - clickable elements
- **Interactive elements** - with selectors and properties

## Configuration Options

### Basic Settings
- **Domain URL** - Starting point for crawling
- **Configuration Name** - Descriptive name for the config

### Login Settings
- **Enable Login** - Check if site requires authentication
- **Login URL** - Page where login form is located
- **Username/Password** - Credentials for authentication
- **Save Cookies** - Persist login session across requests

### Browser Settings
- **User Agent** - Custom browser identification
- **Timeout** - Page load timeout (default: 30 seconds)
- **Headless Mode** - Run without visible browser window

### Crawling Limits
- **Max Pages** - Maximum number of pages to analyze (default: 100)
- **Max Depth** - Maximum link depth to follow (default: 3)

## Example Configurations

### Public Website
```json
{
  "name": "Public Blog Crawl",
  "domain": "https://example-blog.com",
  "login_enabled": false,
  "save_cookies": false,
  "headless": true,
  "timeout": 30000
}
```

### E-commerce Site with Login
```json
{
  "name": "E-commerce Crawl",
  "domain": "https://shop.example.com",
  "login_enabled": true,
  "login_url": "https://shop.example.com/login",
  "username": "user@example.com",
  "password": "your_password",
  "save_cookies": true,
  "headless": true,
  "timeout": 30000
}
```

### Development Site
```json
{
  "name": "Dev Site Crawl",
  "domain": "http://localhost:3000",
  "login_enabled": false,
  "save_cookies": false,
  "headless": false,
  "timeout": 10000
}
```

## What Gets Discovered

### Pages
- **URL** - Full page URL
- **Title** - Page title from HTML
- **Content** - First 1000 characters of HTML
- **Summary** - AI-generated page summary
- **Screenshot** - Full page screenshot
- **HTML** - Complete page HTML stored in GridFS

### Actions
- **Links** - Navigation links with href and text
- **Forms** - Forms with action, method, and input fields
- **Buttons** - Clickable buttons with selectors
- **Interactive Elements** - Other clickable elements

### Metadata
- **Project Association** - Links to specific project
- **Run Tracking** - Which crawl run discovered the page
- **Timestamps** - When page was analyzed
- **Selectors** - CSS/XPath selectors for elements

## Monitoring Progress

### Web Interface
- **Real-time updates** in the configurations list
- **Run status** tracking
- **Progress indicators** for active crawls

### Database Tracking
- **Runs collection** - Tracks crawl progress
- **Pages collection** - Stores discovered pages
- **Actions collection** - Stores interactive elements

### Logs
The crawler provides detailed console output:
```
🚀 Initializing domain crawler...
✅ Browser initialized with config: E-commerce Crawl
🔐 Attempting login...
✅ Login appears successful
💾 Saved 5 cookies
🌐 Starting domain crawl: https://shop.example.com
📄 Analyzing page 1/100: https://shop.example.com (depth: 0)
💾 Saved 12 actions for page
📄 Analyzing page 2/100: https://shop.example.com/products (depth: 1)
✅ Domain crawl complete. Analyzed 45 pages.
```

## Best Practices

### Performance
- **Start small** - Begin with low page limits
- **Use headless mode** - Faster execution
- **Optimize timeouts** - Based on site response times
- **Monitor resources** - Crawling can be resource-intensive

### Respectful Crawling
- **Check robots.txt** - Respect site crawling policies
- **Add delays** - Don't overwhelm servers
- **Use appropriate user agents** - Identify your crawler
- **Get permission** - For large-scale crawling

### Authentication
- **Test login manually** - Before configuring
- **Use strong credentials** - Secure login details
- **Enable cookie saving** - For session persistence
- **Monitor login success** - Check for failures

### Data Management
- **Regular backups** - Of crawled data
- **Clean up old runs** - Remove completed crawl records
- **Monitor storage** - Screenshots and HTML can be large
- **Validate data** - Check for complete captures

## Troubleshooting

### Common Issues

1. **Login Fails**
   - Verify login URL is correct
   - Check username/password
   - Ensure login page loads properly
   - Test manually in browser first

2. **Crawl Stops Early**
   - Check max pages limit
   - Verify domain restrictions
   - Look for JavaScript-heavy sites
   - Check for anti-bot measures

3. **Slow Performance**
   - Reduce timeout values
   - Use headless mode
   - Limit concurrent requests
   - Check network connectivity

4. **Missing Pages**
   - Increase max depth
   - Check for JavaScript navigation
   - Verify same-domain filtering
   - Look for dynamic content

### Debugging Tips

1. **Enable non-headless mode** to see browser activity
2. **Check console logs** for detailed error messages
3. **Verify configuration** settings before starting
4. **Test with small limits** first
5. **Monitor database** for saved data

## Advanced Features

### Custom Selectors
The crawler automatically detects common login form patterns:
- Username fields: `input[name="username"]`, `input[type="email"]`
- Password fields: `input[name="password"]`, `input[type="password"]`
- Submit buttons: `button[type="submit"]`, `input[type="submit"]`

### Cookie Management
- **Automatic saving** after successful login
- **Session persistence** across page requests
- **Domain-specific** cookie storage
- **Secure handling** of authentication tokens

### URL Discovery
- **Same-domain filtering** - Only follows links within the domain
- **Depth tracking** - Prevents infinite crawling
- **Duplicate prevention** - Avoids analyzing same page twice
- **Normalized URLs** - Handles URL variations

## Next Steps

After completing a domain crawl:

1. **Review discovered pages** in the Pages tab
2. **Examine extracted actions** in the Actions tab
3. **Create prompts** for AI analysis of specific elements
4. **Set up automated workflows** using discovered actions
5. **Analyze patterns** in the crawled data

The domain crawler provides a comprehensive foundation for understanding website structure and extracting actionable insights from web content.




