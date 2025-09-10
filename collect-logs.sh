#!/bin/bash

# AionQA Container Logs Collection Script
# This script collects logs from all AionQA containers and saves them to timestamped files

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS_DIR="${SCRIPT_DIR}/logs"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
COMPOSE_FILE="docker-compose-minimal.yml"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if container is running
is_container_running() {
    local container_name=$1
    docker ps --format "table {{.Names}}" | grep -q "^${container_name}$"
}

# Function to collect logs from a container
collect_container_logs() {
    local container_name=$1
    local log_file="${LOGS_DIR}/${container_name}_${TIMESTAMP}.log"
    
    if is_container_running "$container_name"; then
        print_status "Collecting logs from $container_name..."
        docker logs "$container_name" > "$log_file" 2>&1
        print_success "Logs saved to: $log_file"
        echo "  Size: $(du -h "$log_file" | cut -f1)"
        echo "  Lines: $(wc -l < "$log_file")"
    else
        print_warning "Container $container_name is not running"
        echo "Container $container_name is not running at $(date)" > "$log_file"
    fi
    echo
}

# Function to collect system information
collect_system_info() {
    local info_file="${LOGS_DIR}/system_info_${TIMESTAMP}.txt"
    
    print_status "Collecting system information..."
    {
        echo "=== AionQA System Information ==="
        echo "Collection Time: $(date)"
        echo "Hostname: $(hostname)"
        echo "User: $(whoami)"
        echo "Working Directory: $(pwd)"
        echo
        
        echo "=== Docker Version ==="
        docker --version
        echo
        
        echo "=== Docker Compose Version ==="
        docker compose version
        echo
        
        echo "=== Container Status ==="
        docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
        echo
        
        echo "=== Container Resource Usage ==="
        docker stats --no-stream --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}"
        echo
        
        echo "=== Disk Usage ==="
        df -h
        echo
        
        echo "=== Memory Usage ==="
        free -h
        echo
        
        echo "=== Network Interfaces ==="
        ip addr show
        echo
        
        echo "=== Docker Networks ==="
        docker network ls
        echo
        
        echo "=== Docker Volumes ==="
        docker volume ls
        echo
        
    } > "$info_file"
    
    print_success "System information saved to: $info_file"
    echo
}

# Function to collect container-specific information
collect_container_info() {
    local container_name=$1
    local info_file="${LOGS_DIR}/${container_name}_info_${TIMESTAMP}.txt"
    
    if is_container_running "$container_name"; then
        print_status "Collecting detailed info for $container_name..."
        {
            echo "=== Container Information: $container_name ==="
            echo "Collection Time: $(date)"
            echo
            
            echo "=== Container Details ==="
            docker inspect "$container_name"
            echo
            
            echo "=== Container Processes ==="
            docker exec "$container_name" ps aux 2>/dev/null || echo "Cannot access processes"
            echo
            
            echo "=== Container Environment Variables ==="
            docker exec "$container_name" env 2>/dev/null || echo "Cannot access environment"
            echo
            
            echo "=== Container Network ==="
            docker exec "$container_name" netstat -tulpn 2>/dev/null || echo "Cannot access network info"
            echo
            
        } > "$info_file"
        print_success "Container info saved to: $info_file"
    else
        print_warning "Container $container_name is not running, skipping detailed info"
    fi
    echo
}

# Function to create summary report
create_summary_report() {
    local summary_file="${LOGS_DIR}/summary_${TIMESTAMP}.txt"
    
    print_status "Creating summary report..."
    {
        echo "=== AionQA Logs Collection Summary ==="
        echo "Collection Time: $(date)"
        echo "Logs Directory: $LOGS_DIR"
        echo
        
        echo "=== Collected Files ==="
        ls -la "$LOGS_DIR"/*_${TIMESTAMP}.* 2>/dev/null | while read -r line; do
            echo "  $line"
        done
        echo
        
        echo "=== Container Status Summary ==="
        all_containers=$(docker ps -a --filter "name=aionqa-" --format "{{.Names}}")
        for container in $all_containers; do
            if is_container_running "$container"; then
                echo "  ✓ $container - Running"
            else
                echo "  ✗ $container - Not Running"
            fi
        done
        echo
        
        echo "=== Recent Errors (last 10 errors from each container) ==="
        all_containers=$(docker ps -a --filter "name=aionqa-" --format "{{.Names}}")
        for container in $all_containers; do
            if is_container_running "$container"; then
                echo "--- $container ---"
                docker logs "$container" 2>&1 | grep -i error | tail -10 || echo "No errors found"
                echo
            fi
        done
        
    } > "$summary_file"
    
    print_success "Summary report saved to: $summary_file"
    echo
}

# Main execution
main() {
    echo "=========================================="
    echo "    AionQA Container Logs Collection"
    echo "=========================================="
    echo "Timestamp: $TIMESTAMP"
    echo "Logs Directory: $LOGS_DIR"
    echo
    
    # Create logs directory
    mkdir -p "$LOGS_DIR"
    print_success "Created logs directory: $LOGS_DIR"
    echo
    
    # Check if we're in the right directory
    if [[ ! -f "$COMPOSE_FILE" ]]; then
        print_error "Docker compose file '$COMPOSE_FILE' not found in current directory"
        print_error "Please run this script from the AionQA project root directory"
        exit 1
    fi
    
    # Collect system information
    collect_system_info
    
    # Define containers to collect logs from
    containers=(
        "aionqa-mongo"
        "aionqa-redis" 
        "aionqa-back"
        "aionqa-ui"
        "aionqa-ai-service"
    )
    
    # Also collect logs from any dynamically created containers
    dynamic_containers=$(docker ps --filter "name=aionqa-" --format "{{.Names}}" | grep -v -E "^(aionqa-mongo|aionqa-redis|aionqa-back|aionqa-ui|aionqa-ai-service)$" || true)
    
    if [[ -n "$dynamic_containers" ]]; then
        print_status "Found additional AionQA containers:"
        echo "$dynamic_containers" | while read -r container; do
            echo "  - $container"
            containers+=("$container")
        done
        echo
    fi
    
    # Collect logs from each container
    print_status "Starting log collection from containers..."
    echo
    
    for container in "${containers[@]}"; do
        collect_container_logs "$container"
        collect_container_info "$container"
    done
    
    # Create summary report
    create_summary_report
    
    # Show final summary
    echo "=========================================="
    echo "           Collection Complete"
    echo "=========================================="
    print_success "All logs collected successfully!"
    echo
    echo "Files created:"
    ls -la "$LOGS_DIR"/*_${TIMESTAMP}.* 2>/dev/null | while read -r line; do
        echo "  $line"
    done
    echo
    echo "Total size: $(du -sh "$LOGS_DIR" | cut -f1)"
    echo
    print_status "You can now analyze the logs or share them for debugging."
    echo
}

# Handle script arguments
case "${1:-}" in
    --help|-h)
        echo "Usage: $0 [options]"
        echo
        echo "Options:"
        echo "  --help, -h     Show this help message"
        echo "  --clean        Clean old log files before collection"
        echo "  --containers   List available containers"
        echo
        echo "This script collects logs from all AionQA containers and saves them"
        echo "to timestamped files in the 'logs' directory."
        exit 0
        ;;
    --clean)
        print_status "Cleaning old log files..."
        rm -rf "$LOGS_DIR"/*
        print_success "Old log files cleaned"
        echo
        ;;
    --containers)
        print_status "Available AionQA containers:"
        docker ps -a --filter "name=aionqa-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
        exit 0
        ;;
    "")
        # No arguments, run main function
        ;;
    *)
        print_error "Unknown option: $1"
        echo "Use --help for usage information"
        exit 1
        ;;
esac

# Run main function
main
