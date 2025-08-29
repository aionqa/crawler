# Crawling Management System Guide

This guide explains the comprehensive crawling management system that provides real-time control, parallel processing, live monitoring, and job management for the AI Crawler.

## 🚀 **System Overview**

The new crawling management system provides:

- **🎯 Real-time UI Controls** - Start/stop crawling directly from the web interface
- **⚡ Parallel Processing** - Run multiple crawl jobs simultaneously
- **📊 Live Monitoring** - Real-time progress tracking and statistics
- **📝 Live Logs** - Real-time log streaming with auto-scroll
- **🛑 Job Cancellation** - Stop running jobs with immediate effect
- **💾 Persistent Storage** - All logs and job data saved to database
- **🔔 Real-time Updates** - WebSocket-based live updates

## 🏗️ **Architecture**

### **Components:**

1. **Crawling Orchestrator** (`app/crawlingOrchestrator.js`)
   - Manages multiple crawl jobs in parallel
   - Handles job lifecycle (start, stop, monitor)
   - Real-time log collection and storage
   - Process management and cleanup

2. **Job Manager UI** (`ui/src/components/JobManager.vue`)
   - Real-time job monitoring dashboard
   - Live log viewer with auto-scroll
   - Job control buttons (start, stop, details)
   - Statistics and progress tracking

3. **Enhanced Domain Crawler** (`app/domainCrawler.js`)
   - Works with orchestrator for job management
   - Real-time progress reporting
   - Structured logging output
   - Graceful shutdown handling

4. **Backend API** (`back/src/routes.js`)
   - Job management endpoints
   - Real-time log streaming
   - Statistics and monitoring APIs

## 🎮 **How to Use**

### **1. Start the System**
```bash
./start-all.sh
```

### **2. Access Job Management**
1. Navigate to: `http://localhost:5173`
2. Go to "Data Management" section
3. Click on "Jobs" tab

### **3. Start a Crawl**
1. Go to "Configurations" tab
2. Create or select a configuration
3. Click "Start Crawl"
4. Set crawl parameters (max pages, depth)
5. Click "Start Crawl"

### **4. Monitor Progress**
- **Real-time Updates**: Job status updates automatically
- **Live Logs**: Click "Logs" to see real-time crawling output
- **Progress Bars**: Visual progress indicators
- **Statistics**: Click "Stats" for system overview

### **5. Control Jobs**
- **Stop Job**: Click "Stop" button on running jobs
- **View Details**: Click "Details" for comprehensive job info
- **View Logs**: Click "Logs" for real-time log streaming

## 📊 **Job Management Features**

### **Real-time Dashboard**
- **Active Jobs Count**: Shows currently running jobs
- **Total Jobs**: Historical job count
- **Success/Failure Rates**: Job completion statistics
- **Progress Tracking**: Visual progress bars for each job

### **Job Status Types**
- **🟡 Starting**: Job is initializing
- **🔵 Running**: Job is actively crawling
- **🟢 Completed**: Job finished successfully
- **🔴 Failed**: Job encountered an error
- **⚫ Cancelled**: Job was stopped by user

### **Live Log Viewer**
- **Real-time Streaming**: Logs appear as they happen
- **Auto-scroll**: Automatically scrolls to latest logs
- **Log Levels**: Color-coded info/error messages
- **Timestamp**: Precise timing for each log entry
- **Search/Filter**: Find specific log entries

### **Job Details Modal**
- **Basic Information**: Job ID, status, project, configuration
- **Crawl Settings**: Domain, max pages, max depth
- **Progress Metrics**: Analyzed pages, discovered URLs, errors
- **Timing Information**: Start time, duration, end time
- **Error Details**: Full error information if job failed

## 🔧 **API Endpoints**

### **Job Management**
```bash
# Get all jobs
GET /jobs

# Get active jobs only
GET /jobs/active

# Get specific job details
GET /jobs/{jobId}

# Get job logs
GET /jobs/{jobId}/logs?limit=100

# Stop a running job
POST /jobs/{jobId}/stop

# Get orchestrator statistics
GET /jobs/stats
```

### **Configuration Crawling**
```bash
# Start a new crawl job
POST /configurations/{configId}/start-crawl
{
  "max_pages": 100,
  "max_depth": 3
}
```

## 📈 **Real-time Features**

### **WebSocket Events**
- **jobStarted**: New job begins
- **jobStopped**: Job is stopped
- **jobCompleted**: Job finishes
- **log**: New log entry for specific job

### **Auto-refresh**
- **Job List**: Updates every 5 seconds
- **Live Logs**: Real-time streaming
- **Progress Bars**: Live progress updates
- **Status Badges**: Real-time status changes

### **Parallel Processing**
- **Multiple Jobs**: Run several crawls simultaneously
- **Resource Management**: Automatic process cleanup
- **Isolation**: Each job runs in separate process
- **Error Isolation**: One job failure doesn't affect others

## 🛠️ **Advanced Features**

### **Job Orchestration**
- **Process Management**: Spawns and manages child processes
- **Graceful Shutdown**: SIGTERM followed by SIGKILL
- **Resource Cleanup**: Automatic cleanup on job completion
- **Stuck Job Recovery**: Cleans up stuck jobs on startup

### **Log Management**
- **Database Storage**: All logs saved to MongoDB
- **Real-time Streaming**: WebSocket-based live updates
- **Log Buffering**: In-memory buffer for performance
- **Log Rotation**: Keeps last 1000 entries per job

### **Error Handling**
- **Process Monitoring**: Tracks exit codes and signals
- **Error Classification**: Distinguishes between failures and cancellations
- **Error Reporting**: Detailed error information in UI
- **Recovery**: Automatic cleanup of failed processes

## 📋 **Example Workflow**

### **1. Create Configuration**
```json
{
  "name": "E-commerce Crawl",
  "domain": "https://shop.example.com",
  "login_enabled": true,
  "login_url": "https://shop.example.com/login",
  "username": "user@example.com",
  "password": "password123",
  "save_cookies": true,
  "headless": true,
  "timeout": 30000
}
```

### **2. Start Multiple Crawls**
1. Start crawl for Configuration A (100 pages, depth 3)
2. Start crawl for Configuration B (50 pages, depth 2)
3. Both jobs run in parallel
4. Monitor both in real-time

### **3. Monitor Progress**
- Watch real-time progress bars
- View live logs for each job
- Check job statistics
- Monitor system resources

### **4. Control Jobs**
- Stop long-running jobs
- View detailed job information
- Analyze error logs
- Track completion rates

## 🔍 **Troubleshooting**

### **Common Issues**

1. **Job Won't Start**
   - Check configuration validity
   - Verify domain accessibility
   - Check login credentials
   - Review error logs

2. **Job Stuck**
   - Use "Stop" button to cancel
   - Check system resources
   - Review network connectivity
   - Check for anti-bot measures

3. **Logs Not Updating**
   - Refresh the page
   - Check WebSocket connection
   - Verify job is still running
   - Check browser console for errors

4. **Multiple Jobs Failing**
   - Check system resources (CPU, memory)
   - Verify network bandwidth
   - Review target site policies
   - Check orchestrator logs

### **Debugging Tips**

1. **Enable Non-headless Mode**: Set `headless: false` in configuration
2. **Check System Logs**: Monitor orchestrator console output
3. **Review Job Details**: Use "Details" button for comprehensive info
4. **Monitor Resources**: Use "Stats" button for system overview
5. **Check Database**: Review job and log collections directly

## 🚀 **Performance Optimization**

### **Best Practices**

1. **Resource Management**
   - Limit concurrent jobs based on system capacity
   - Monitor CPU and memory usage
   - Use appropriate timeouts

2. **Network Optimization**
   - Use headless mode for faster execution
   - Optimize page load timeouts
   - Implement rate limiting if needed

3. **Storage Management**
   - Monitor log storage growth
   - Clean up old job records periodically
   - Archive completed job data

4. **Error Prevention**
   - Test configurations before large crawls
   - Use appropriate max pages/depth limits
   - Monitor for common failure patterns

## 📚 **Next Steps**

After setting up the crawling management system:

1. **Create Configurations** for your target domains
2. **Start Multiple Crawls** to test parallel processing
3. **Monitor Progress** using the real-time dashboard
4. **Analyze Results** in the Pages and Actions tabs
5. **Set Up Automated Workflows** using discovered data

The crawling management system provides a robust foundation for large-scale web crawling with full control and visibility into the crawling process.
