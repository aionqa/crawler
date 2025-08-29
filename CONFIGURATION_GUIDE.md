# Configuration Management Guide

This guide explains how to set up and manage crawling configurations for your AI Crawler system, including domain settings, login credentials, and cookie management.

## Overview

The Configuration Management system allows you to:

- **Define target domains** for analysis
- **Configure login credentials** for authenticated sites
- **Manage cookies** for session persistence
- **Set browser parameters** like user agent, timeout, and headless mode
- **Test configurations** before running analysis

## How to Use

### 1. Access Configuration Management

1. **Start the system:**
   ```bash
   ./start-all.sh
   ```

2. **Navigate to the frontend:** `http://localhost:5173`

3. **Scroll down** to the "Data Management" section

4. **Click on the "Configurations" tab**

### 2. Create a New Configuration

1. **Select a project** from the dropdown in the top toolbar
2. **Click "+ New Configuration"**
3. **Fill in the configuration details:**

#### Basic Settings
- **Configuration Name:** A descriptive name (e.g., "Production Site Config")
- **Domain URL:** The base URL to analyze (e.g., `https://example.com`)

#### Login Settings (Optional)
- **Enable Login:** Check this if the site requires authentication
- **Login URL:** The login page URL (e.g., `https://example.com/login`)
- **Username:** Your login username/email
- **Password:** Your login password

#### Cookie Management
- **Save and reuse cookies:** Check this to persist login sessions
- When enabled, cookies will be saved after login and reused for subsequent requests

#### Browser Settings
- **User Agent:** Custom browser user agent (optional)
- **Timeout:** Page load timeout in milliseconds (default: 30000ms)
- **Run in headless mode:** Check to run browser without visible window

### 3. Example Configuration

Here's an example configuration for an e-commerce site:

```json
{
  "name": "E-commerce Site Analysis",
  "domain": "https://shop.example.com",
  "login_enabled": true,
  "login_url": "https://shop.example.com/account/login",
  "username": "user@example.com",
  "password": "your_password",
  "save_cookies": true,
  "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "headless": true,
  "timeout": 30000
}
```

## Configuration Features

### Domain Analysis
- **Base URL:** The main domain to crawl and analyze
- **URL Validation:** Ensures proper URL format
- **Project Association:** Links configuration to specific projects

### Login Management
- **Flexible Login:** Enable/disable login as needed
- **Credential Storage:** Securely store username and password
- **Login URL:** Specify custom login page location
- **Session Persistence:** Save cookies for authenticated sessions

### Cookie Management
- **Automatic Cookie Saving:** When enabled, saves cookies after login
- **Session Reuse:** Automatically applies saved cookies to subsequent requests
- **Cross-Request Persistence:** Maintains login state across multiple page visits

### Browser Configuration
- **User Agent Customization:** Set custom browser identification
- **Timeout Control:** Configure page load timeouts
- **Headless Mode:** Run browser without visible window for automation
- **Performance Optimization:** Balance between speed and reliability

## API Endpoints

### Create Configuration
```bash
POST /configurations
Content-Type: application/json

{
  "project_id": "64e9f3bd2ba5d9d82f4a1d10",
  "name": "My Config",
  "domain": "https://example.com",
  "login_enabled": true,
  "login_url": "https://example.com/login",
  "username": "user@example.com",
  "password": "password123",
  "save_cookies": true,
  "headless": true,
  "timeout": 30000
}
```

### List Configurations
```bash
GET /configurations?project_id=64e9f3bd2ba5d9d82f4a1d10
```

### Update Configuration
```bash
PUT /configurations/{id}
Content-Type: application/json

{
  "name": "Updated Config",
  "domain": "https://updated-example.com"
}
```

### Test Configuration
```bash
POST /configurations/{id}/test
```

### Delete Configuration
```bash
DELETE /configurations/{id}
```

## Integration with Analyzer

The configuration system integrates with the main analyzer to provide:

### Automatic Login
When a configuration has login enabled:
1. **Browser starts** with the specified settings
2. **Navigates to login URL** if provided
3. **Fills in credentials** automatically
4. **Submits login form** and waits for success
5. **Saves cookies** if cookie saving is enabled
6. **Proceeds with analysis** using authenticated session

### Cookie Persistence
When cookie saving is enabled:
1. **Cookies are captured** after successful login
2. **Stored in database** associated with the configuration
3. **Automatically applied** to subsequent requests
4. **Maintains session** across multiple page visits

### Domain-Specific Analysis
The configuration provides:
- **Base domain** for crawling scope
- **Browser settings** for optimal performance
- **Authentication state** for protected content
- **Session management** for complex workflows

## Best Practices

### Security
- **Use strong passwords** for login credentials
- **Consider encryption** for sensitive data in production
- **Regular credential updates** for long-running projects
- **Access control** for configuration management

### Performance
- **Optimize timeouts** based on site response times
- **Use headless mode** for automation
- **Custom user agents** to avoid detection
- **Cookie management** for session efficiency

### Reliability
- **Test configurations** before running analysis
- **Validate URLs** and credentials
- **Monitor login success** rates
- **Handle authentication failures** gracefully

## Troubleshooting

### Common Issues

1. **Login Fails**
   - Check login URL format
   - Verify username/password
   - Ensure login page loads correctly
   - Test manually in browser first

2. **Cookies Not Saving**
   - Enable cookie saving in configuration
   - Check if login was successful
   - Verify domain matches cookie scope

3. **Timeout Errors**
   - Increase timeout value
   - Check network connectivity
   - Verify domain accessibility

4. **Configuration Not Found**
   - Ensure project is selected
   - Check configuration exists
   - Verify API endpoints are accessible

### Testing Configurations

Use the "Test" button in the configuration manager to:
- **Validate configuration** settings
- **Check URL accessibility**
- **Verify login credentials**
- **Test cookie functionality**

## Next Steps

After creating configurations:

1. **Create pages** to analyze specific URLs
2. **Set up prompts** for AI analysis
3. **Define actions** for interactive elements
4. **Run analysis** using the configured settings

The configuration system provides the foundation for automated, authenticated web analysis with persistent sessions and optimized browser settings.
