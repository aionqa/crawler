# Graylog Setup Status

## ✅ Completed

### 1. Graylog Infrastructure
- **MongoDB**: Running on port 27017
- **Elasticsearch**: Running and healthy
- **Graylog Server**: Running on port 9000 (web interface accessible)
- **GELF Endpoint**: Configured on port 12201

### 2. GELF Client Integration
- **Backend Service**: Already integrated with `graylogService.js`
- **Login Agents**: GELF client integrated in `login-simplified`
- **Crawler Agents**: GELF client integrated in `crawler-simplified`
- **Shared GELF Client**: Available in `shared/gelf-client.js`

### 3. Docker Configuration
- **Graylog Stack**: `docker-compose-graylog.yml` configured
- **Network**: `aionqa_graylog` network created
- **Volumes**: Persistent storage for MongoDB, Elasticsearch, and Graylog data

## 🔧 Current Status

### Services Running
```bash
# Check status
docker compose -f docker-compose-graylog.yml ps

# View logs
docker compose -f docker-compose-graylog.yml logs -f graylog
```

### Web Interface
- **URL**: http://localhost:9000
- **Credentials**: admin / admin
- **Status**: Accessible (HTTP 200)

## 🚧 Next Steps

### 1. Configure GELF Input in Graylog Web Interface

1. **Login to Graylog**:
   - Open http://localhost:9000
   - Login with admin / admin

2. **Create GELF Input**:
   - Go to System → Inputs
   - Click "Select input" → "GELF HTTP"
   - Click "Launch new input"
   - Configure:
     - **Title**: AionQA GELF Input
     - **Bind address**: 0.0.0.0
     - **Port**: 12201
     - **Decompress size limit**: 2097152
   - Click "Save"

3. **Verify Input**:
   - Input should show as "Running"
   - Status should be green

### 2. Test Log Forwarding

Once the GELF input is configured, test with:

```bash
# Test script
node test-gelf.js

# Or direct curl test
echo '{"version":"1.1","host":"test","short_message":"Test message","level":6}' | \
curl -X POST http://localhost:12201/gelf \
-H "Content-Type: application/json" \
-d @-
```

### 3. View Logs in Graylog

1. **Go to Search**: http://localhost:9000/search
2. **Query**: `*` (to see all logs)
3. **Filter by source**: Look for logs from `aionqa-agent`, `login-simplified`, `crawler-simplified`

## 📊 Log Structure

### GELF Message Format
```json
{
  "version": "1.1",
  "host": "aionqa-agent",
  "short_message": "Login job completed successfully",
  "timestamp": 1695123456.789,
  "level": 6,
  "_jobId": "job-123",
  "_component": "login-simplified",
  "_agentName": "login-simplified",
  "_projectId": "project-456",
  "_url": "https://example.com",
  "_duration_ms": 1500
}
```

### Log Levels
- **7**: Debug
- **6**: Info
- **4**: Warning
- **3**: Error
- **2**: Critical
- **1**: Alert
- **0**: Emergency

## 🔍 Troubleshooting

### GELF Connection Issues
```bash
# Check if GELF port is accessible
telnet localhost 12201

# Check Graylog logs
docker compose -f docker-compose-graylog.yml logs graylog | grep -i gelf
```

### Elasticsearch Issues
```bash
# Check Elasticsearch health
curl http://localhost:9200/_cluster/health

# Check indices
curl http://localhost:9200/_cat/indices
```

### MongoDB Issues
```bash
# Check MongoDB connection
docker exec -it aionqa-mongo mongosh --eval "db.adminCommand('ping')"
```

## 🎯 Integration Points

### Backend Service
- **File**: `back/src/graylogService.js`
- **Usage**: Automatic log forwarding for all backend operations
- **Configuration**: Environment variables for Graylog connection

### Agent Services
- **Login Agents**: Send job logs with login-specific metadata
- **Crawler Agents**: Send job logs with crawling-specific metadata
- **Shared Client**: `shared/gelf-client.js` for consistent logging

### Environment Variables
```bash
GRAYLOG_ENABLED=true
GRAYLOG_URL=http://graylog:9000
GRAYLOG_GELF_URL=http://graylog:12201
GRAYLOG_USERNAME=admin
GRAYLOG_PASSWORD=admin
```

## 📈 Monitoring

### Key Metrics to Monitor
- **Log Volume**: Number of logs per minute/hour
- **Error Rate**: Percentage of error-level logs
- **Job Duration**: Average job execution time
- **Agent Performance**: Success/failure rates per agent

### Useful Queries
```bash
# All logs from last hour
timestamp:[now-1h TO now]

# Error logs only
level:3

# Logs from specific agent
_agentName:"login-simplified"

# Logs for specific job
_jobId:"job-123"
```

## 🚀 Production Considerations

1. **Resource Limits**: Adjust memory limits for Elasticsearch
2. **Retention Policy**: Configure log retention in Graylog
3. **Backup Strategy**: Regular backups of MongoDB and Elasticsearch
4. **Security**: Change default passwords and enable HTTPS
5. **Scaling**: Consider cluster setup for high-volume logging

---

**Status**: Graylog infrastructure is running and accessible. GELF input configuration needed in web interface to complete setup.
