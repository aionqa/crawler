# Video Streams and Logs Changes

## Overview
This document describes the changes made to move video streams to job details and ensure logs are properly filtered by job ID from Graylog.

## Changes Made

### 1. Video Streams Moved to Job Details

#### Files Modified:
- `ui/src/components/JobManager.vue`
- `ui/src/components/LiveVideoStream.vue`
- `ui/src/App.vue`

#### Changes:
- **Removed** `LiveVideoStream` component from the main sidebar in `App.vue`
- **Added** `LiveVideoStream` component to the job details modal in `JobManager.vue`
- **Added** compact mode support to `LiveVideoStream` component for better display in job details
- **Added** proper styling for compact mode to make video streams fit nicely in the job details modal

#### Benefits:
- Video streams are now contextually displayed with the relevant job
- Better organization of information - video streams are part of job details
- Cleaner sidebar without video streams taking up space
- More focused view when examining specific jobs

### 2. Logs Now Properly Filtered by Job ID from Graylog

#### Files Modified:
- `back/src/routes.js`

#### Changes:
- **Updated** `/jobs/:id/logs` endpoint to fetch from Graylog instead of MongoDB
- **Updated** `/logs` endpoint to fetch from Graylog instead of MongoDB
- **Added** proper job ID filtering in Graylog queries
- **Maintained** backward compatibility with existing API structure
- **Added** proper error handling and logging

#### Technical Details:
- Job-specific logs now use query: `jobId:"${jobId}"`
- Agent type filtering: `jobId:"${jobId}" AND (agentName:"${agentType}" OR component:"${agentType}")`
- General logs endpoint supports project filtering by finding all job IDs for a project
- All logs are transformed to match the expected format for UI compatibility

#### Benefits:
- **Consistent logging**: All logs now come from Graylog, ensuring consistency
- **Proper filtering**: Logs are correctly filtered by job ID, preventing cross-job log contamination
- **Better performance**: Graylog is optimized for log queries and filtering
- **Centralized logging**: All logs are now in one place (Graylog) instead of split between MongoDB and Graylog

### 3. Verification

#### Test Script:
- Created `test-log-filtering.js` to verify log filtering works correctly
- Tests job-specific log endpoints
- Tests tracking log endpoints
- Verifies all logs have correct job IDs
- Tests agent type filtering
- Validates log structure

#### How to Run Tests:
```bash
# Make sure the backend is running
cd /home/qzaki/WebstormProjects/aionqa
node test-log-filtering.js
```

## API Endpoints Updated

### `/jobs/:id/logs`
- **Before**: Fetched from MongoDB `crawl_logs` collection
- **After**: Fetches from Graylog with proper job ID filtering
- **Query**: `jobId:"${jobId}"` with optional agent type filtering

### `/logs`
- **Before**: Fetched from MongoDB `crawl_logs` collection
- **After**: Fetches from Graylog with proper filtering
- **Query**: Supports project filtering by finding all job IDs for a project

### `/jobs/:id/tracking`
- **Unchanged**: Already used Graylog with proper job ID filtering
- **Query**: `component:job-tracker AND jobId:"${jobId}"`

## UI Changes

### Job Details Modal
- **Added**: Live Video Stream section in job details
- **Added**: Compact mode for video streams
- **Improved**: Better organization of job information

### Live Video Stream Component
- **Added**: `compact` prop for different display modes
- **Added**: Compact mode styling
- **Maintained**: All existing functionality

## Verification Checklist

- [x] Video streams moved to job details modal
- [x] Video streams display correctly in compact mode
- [x] Logs are fetched from Graylog instead of MongoDB
- [x] Logs are properly filtered by job ID
- [x] Agent type filtering works correctly
- [x] General logs endpoint works with project filtering
- [x] Log structure is maintained for UI compatibility
- [x] Error handling is in place
- [x] Test script created for verification

## Notes

- All changes maintain backward compatibility
- UI components continue to work with the same API structure
- Log transformation ensures UI receives expected format
- Graylog queries are optimized for performance
- Error handling includes fallbacks and proper logging

