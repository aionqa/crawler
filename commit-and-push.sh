#!/bin/bash

# AionQA - Auto Commit and Push Script
# This script stages, commits, and pushes all changes with auto-generated commit messages

set -e  # Exit on any error

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

# Function to generate commit message based on changes
generate_commit_message() {
    local changes=$(git status --porcelain)
    local message=""
    
    # Count different types of changes
    local added=$(echo "$changes" | grep -c "^A" || true)
    local modified=$(echo "$changes" | grep -c "^M" || true)
    local deleted=$(echo "$changes" | grep -c "^D" || true)
    local untracked=$(echo "$changes" | grep -c "^??" || true)
    local renamed=$(echo "$changes" | grep -c "^R" || true)
    
    # Generate commit message based on changes
    if [ $untracked -gt 0 ] && [ $modified -eq 0 ] && [ $deleted -eq 0 ]; then
        message="Add new files and features"
    elif [ $modified -gt 0 ] && [ $untracked -eq 0 ] && [ $deleted -eq 0 ]; then
        message="Update existing functionality"
    elif [ $deleted -gt 0 ] && [ $modified -eq 0 ] && [ $untracked -eq 0 ]; then
        message="Remove obsolete code and files"
    elif [ $renamed -gt 0 ]; then
        message="Refactor and reorganize code structure"
    else
        message="Update codebase with mixed changes"
    fi
    
    # Add specific details based on file types
    if echo "$changes" | grep -q "\.vue$"; then
        message="$message (Vue.js components)"
    fi
    
    if echo "$changes" | grep -q "\.js$"; then
        message="$message (JavaScript modules)"
    fi
    
    if echo "$changes" | grep -q "\.json$"; then
        message="$message (configuration files)"
    fi
    
    if echo "$changes" | grep -q "\.md$"; then
        message="$message (documentation)"
    fi
    
    if echo "$changes" | grep -q "Dockerfile"; then
        message="$message (Docker configuration)"
    fi
    
    if echo "$changes" | grep -q "docker-compose"; then
        message="$message (Docker Compose setup)"
    fi
    
    # Add timestamp
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    message="$message - $timestamp"
    
    echo "$message"
}

# Function to check if we're in a git repository
check_git_repo() {
    if ! git rev-parse --git-dir > /dev/null 2>&1; then
        print_error "Not in a git repository!"
        exit 1
    fi
}

# Function to check if there are any changes
check_changes() {
    if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
        print_warning "No changes to commit!"
        exit 0
    fi
}

# Function to show changes summary
show_changes_summary() {
    print_status "Changes to be committed:"
    echo ""
    
    # Show staged changes
    local staged=$(git diff --cached --name-status 2>/dev/null || true)
    if [ -n "$staged" ]; then
        echo -e "${GREEN}Staged changes:${NC}"
        echo "$staged" | while read status file; do
            case $status in
                A) echo -e "  ${GREEN}+${NC} $file" ;;
                M) echo -e "  ${YELLOW}~${NC} $file" ;;
                D) echo -e "  ${RED}-${NC} $file" ;;
                R*) echo -e "  ${BLUE}→${NC} $file" ;;
                *) echo -e "  ${BLUE}?${NC} $file" ;;
            esac
        done
        echo ""
    fi
    
    # Show unstaged changes
    local unstaged=$(git diff --name-status 2>/dev/null || true)
    if [ -n "$unstaged" ]; then
        echo -e "${YELLOW}Unstaged changes:${NC}"
        echo "$unstaged" | while read status file; do
            case $status in
                A) echo -e "  ${GREEN}+${NC} $file" ;;
                M) echo -e "  ${YELLOW}~${NC} $file" ;;
                D) echo -e "  ${RED}-${NC} $file" ;;
                R*) echo -e "  ${BLUE}→${NC} $file" ;;
                *) echo -e "  ${BLUE}?${NC} $file" ;;
            esac
        done
        echo ""
    fi
    
    # Show untracked files
    local untracked=$(git ls-files --others --exclude-standard 2>/dev/null || true)
    if [ -n "$untracked" ]; then
        echo -e "${BLUE}Untracked files:${NC}"
        echo "$untracked" | while read file; do
            echo -e "  ${BLUE}+${NC} $file"
        done
        echo ""
    fi
}

# Function to handle submodules
handle_submodules() {
    print_status "Checking for submodule changes..."
    
    # Get list of submodules
    local submodules=$(git submodule status | awk '{print $2}' || true)
    
    if [ -n "$submodules" ]; then
        echo "$submodules" | while read submodule; do
            if [ -d "$submodule" ]; then
                print_status "Processing submodule: $submodule"
                cd "$submodule"
                
                # Check if submodule has changes
                if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
                    print_status "Submodule $submodule has changes, committing..."
                    
                    # Generate commit message for submodule
                    local submodule_commit_msg=$(generate_commit_message)
                    submodule_commit_msg="Submodule $submodule: $submodule_commit_msg"
                    
                    # Stage, commit, and push submodule changes
                    git add .
                    git commit -m "$submodule_commit_msg" || print_warning "No changes to commit in submodule $submodule"
                    git push || print_warning "Failed to push submodule $submodule"
                    
                    print_success "Submodule $submodule committed and pushed"
                else
                    print_status "Submodule $submodule has no changes"
                fi
                
                cd - > /dev/null
            fi
        done
    fi
}

# Function to commit and push main repository
commit_and_push_main() {
    print_status "Staging all changes..."
    git add .
    
    print_status "Generating commit message..."
    local commit_message=$(generate_commit_message)
    
    print_status "Commit message: $commit_message"
    echo ""
    
    # Show changes summary
    show_changes_summary
    
    # Ask for confirmation
    read -p "Do you want to proceed with commit and push? (y/N): " -n 1 -r
    echo ""
    
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_warning "Operation cancelled by user"
        exit 0
    fi
    
    print_status "Committing changes..."
    git commit -m "$commit_message"
    
    print_status "Pushing to remote repository..."
    git push
    
    print_success "All changes committed and pushed successfully!"
}

# Function to show help
show_help() {
    echo "AionQA - Auto Commit and Push Script"
    echo ""
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -h, --help     Show this help message"
    echo "  -f, --force    Skip confirmation prompt"
    echo "  -s, --submodules-only  Only process submodules"
    echo "  -m, --main-only       Only process main repository"
    echo ""
    echo "This script will:"
    echo "  1. Check for changes in main repository and submodules"
    echo "  2. Generate appropriate commit messages"
    echo "  3. Stage, commit, and push all changes"
    echo ""
}

# Main execution
main() {
    local force=false
    local submodules_only=false
    local main_only=false
    
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--help)
                show_help
                exit 0
                ;;
            -f|--force)
                force=true
                shift
                ;;
            -s|--submodules-only)
                submodules_only=true
                shift
                ;;
            -m|--main-only)
                main_only=true
                shift
                ;;
            *)
                print_error "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done
    
    print_status "Starting AionQA commit and push process..."
    echo ""
    
    # Check if we're in a git repository
    check_git_repo
    
    # Check if there are any changes
    check_changes
    
    # Handle submodules if not main-only
    if [ "$main_only" = false ]; then
        handle_submodules
    fi
    
    # Handle main repository if not submodules-only
    if [ "$submodules_only" = false ]; then
        commit_and_push_main
    fi
    
    print_success "All operations completed successfully!"
}

# Run main function
main "$@"
