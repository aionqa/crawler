# AionQA Logs Collection Script

This script helps you collect logs from all AionQA containers for debugging and monitoring purposes.

## Usage

### Basic Usage
```bash
./collect-logs.sh
```

### Available Options
```bash
./collect-logs.sh --help          # Show help message
./collect-logs.sh --clean         # Clean old logs before collection
./collect-logs.sh --containers    # List available containers
```

## What It Collects

### Container Logs
- **aionqa-mongo**: MongoDB database logs
- **aionqa-redis**: Redis cache logs  
- **aionqa-back**: Backend API service logs
- **aionqa-ui**: Frontend UI service logs
- **aionqa-ai-service**: AI chat service logs
- **Dynamic containers**: Any additional AionQA containers (login agents, crawler agents, etc.)

### System Information
- Docker version and container status
- Container resource usage (CPU, memory, network, disk)
- System resource usage (disk, memory)
- Network interfaces and Docker networks
- Container environment variables and processes

### Detailed Container Info
- Container inspection details
- Running processes inside containers
- Environment variables
- Network configuration

## Output Files

All logs are saved to the `logs/` directory with timestamps:

```
logs/
├── aionqa-mongo_20250910_224405.log
├── aionqa-mongo_info_20250910_224405.txt
├── aionqa-redis_20250910_224405.log
├── aionqa-redis_info_20250910_224405.txt
├── aionqa-back_20250910_224405.log
├── aionqa-back_info_20250910_224405.txt
├── aionqa-ui_20250910_224405.log
├── aionqa-ui_info_20250910_224405.txt
├── aionqa-ai-service_20250910_224405.log
├── aionqa-ai-service_info_20250910_224405.txt
├── system_info_20250910_224405.txt
└── summary_20250910_224405.txt
```

## File Types

- **`*.log`**: Raw container logs
- **`*_info_*.txt`**: Detailed container information
- **`system_info_*.txt`**: System-wide information
- **`summary_*.txt`**: Summary report with status and recent errors

## When to Use

- **Debugging issues**: When containers are not working as expected
- **Performance monitoring**: Check resource usage and system health
- **Support requests**: Provide comprehensive logs to support team
- **System maintenance**: Regular health checks and monitoring
- **Troubleshooting**: When services are failing or behaving unexpectedly

## Example Output

```
==========================================
    AionQA Container Logs Collection
==========================================
Timestamp: 20250910_224405
Logs Directory: /home/qzaki/WebstormProjects/aionqa/logs

[SUCCESS] Created logs directory: /home/qzaki/WebstormProjects/aionqa/logs

[INFO] Collecting system information...
[SUCCESS] System information saved to: logs/system_info_20250910_224405.txt

[INFO] Starting log collection from containers...

[INFO] Collecting logs from aionqa-mongo...
[SUCCESS] Logs saved to: logs/aionqa-mongo_20250910_224405.log
  Size: 712K
  Lines: 2180

...

==========================================
           Collection Complete
==========================================
[SUCCESS] All logs collected successfully!

Total size: 836K
```

## Tips

1. **Run regularly**: Use this script for regular health checks
2. **Clean old logs**: Use `--clean` to remove old log files before collection
3. **Check summary**: Always review the summary file for quick status overview
4. **Share logs**: The collected logs can be easily shared for debugging
5. **Monitor errors**: The summary includes recent errors from all containers

## Troubleshooting

If the script fails:
1. Ensure you're running it from the AionQA project root directory
2. Check that Docker is running and accessible
3. Verify that containers are running with `./collect-logs.sh --containers`
4. Check file permissions: `chmod +x collect-logs.sh`
