#!/bin/bash

# AionQA Git Manager
# This script manages git operations across the main repository and all submodules

set -e

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

# Function to check if we're in the main repo
check_main_repo() {
    if [ ! -f ".gitmodules" ]; then
        print_error "This script must be run from the main AionQA repository root"
        exit 1
    fi
}

# Function to get git status for a directory
get_git_status() {
    local dir=$1
    if [ -d "$dir/.git" ]; then
        cd "$dir"
        local status=$(git status --porcelain)
        local branch=$(git branch --show-current)
        cd - > /dev/null
        echo "$status|$branch"
    else
        echo "no-git|no-branch"
    fi
}

# Function to commit and push changes in a directory
commit_and_push() {
    local dir=$1
    local message=$2
    local force=$3
    
    if [ ! -d "$dir/.git" ]; then
        print_warning "No git repository in $dir, skipping..."
        return 0
    fi
    
    print_status "Processing $dir..."
    cd "$dir"
    
    # Check if there are changes
    if [ -z "$(git status --porcelain)" ]; then
        print_status "No changes in $dir"
        cd - > /dev/null
        return 0
    fi
    
    # Add all changes
    git add .
    
    # Commit with message
    if [ -n "$message" ]; then
        git commit -m "$message"
    else
        git commit -m "Update $dir - $(date '+%Y-%m-%d %H:%M:%S')"
    fi
    
    # Push changes
    if [ "$force" = "true" ]; then
        git push --force-with-lease
    else
        git push
    fi
    
    print_success "Successfully committed and pushed changes in $dir"
    cd - > /dev/null
}

# Function to show status of all repositories
show_status() {
    print_status "Git Status for all repositories:"
    echo "=================================="
    
    # Main repository
    print_status "Main Repository:"
    local main_status=$(get_git_status ".")
    local main_changes=$(echo "$main_status" | cut -d'|' -f1)
    local main_branch=$(echo "$main_status" | cut -d'|' -f2)
    
    if [ -n "$main_changes" ]; then
        echo -e "  ${YELLOW}Changes:${NC} $main_changes"
    else
        echo -e "  ${GREEN}Clean${NC}"
    fi
    echo -e "  ${BLUE}Branch:${NC} $main_branch"
    echo
    
    # Submodules
    print_status "Submodules:"
    while IFS= read -r line; do
        if [[ $line == \[submodule* ]]; then
            local name=$(echo "$line" | sed 's/\[submodule "\(.*\)"\]/\1/')
            local submodule_status=$(get_git_status "$name")
            local submodule_changes=$(echo "$submodule_status" | cut -d'|' -f1)
            local submodule_branch=$(echo "$submodule_status" | cut -d'|' -f2)
            
            echo -e "  ${BLUE}$name:${NC}"
            if [ -n "$submodule_changes" ] && [ "$submodule_changes" != "no-git" ]; then
                echo -e "    ${YELLOW}Changes:${NC} $submodule_changes"
            else
                echo -e "    ${GREEN}Clean${NC}"
            fi
            echo -e "    ${BLUE}Branch:${NC} $submodule_branch"
        fi
    done < .gitmodules
}

# Function to commit and push all changes
commit_all() {
    local message=$1
    local force=$2
    
    print_status "Starting commit and push process..."
    
    # First, commit and push all submodules
    while IFS= read -r line; do
        if [[ $line == \[submodule* ]]; then
            local name=$(echo "$line" | sed 's/\[submodule "\(.*\)"\]/\1/')
            commit_and_push "$name" "$message" "$force"
        fi
    done < .gitmodules
    
    # Then commit and push the main repository
    print_status "Processing main repository..."
    if [ -n "$(git status --porcelain)" ]; then
        git add .
        if [ -n "$message" ]; then
            git commit -m "$message"
        else
            git commit -m "Update main repository - $(date '+%Y-%m-%d %H:%M:%S')"
        fi
        
        if [ "$force" = "true" ]; then
            git push --force-with-lease
        else
            git push
        fi
        
        print_success "Successfully committed and pushed main repository"
    else
        print_status "No changes in main repository"
    fi
    
    print_success "All repositories have been processed!"
}

# Function to pull latest changes
pull_all() {
    print_status "Pulling latest changes from all repositories..."
    
    # Pull main repository
    print_status "Pulling main repository..."
    git pull
    
    # Update and pull all submodules
    print_status "Updating submodules..."
    git submodule update --remote --merge
    
    print_success "All repositories updated!"
}

# Function to initialize submodules (for new clones)
init_submodules() {
    print_status "Initializing submodules..."
    git submodule update --init --recursive
    print_success "Submodules initialized!"
}

# Function to show help
show_help() {
    echo "AionQA Git Manager"
    echo "=================="
    echo
    echo "Usage: $0 [COMMAND] [OPTIONS]"
    echo
    echo "Commands:"
    echo "  status                    Show status of all repositories"
    echo "  commit [MESSAGE]          Commit and push changes in all repositories"
    echo "  commit-force [MESSAGE]    Force commit and push changes"
    echo "  pull                      Pull latest changes from all repositories"
    echo "  init                      Initialize submodules (for new clones)"
    echo "  help                      Show this help message"
    echo
    echo "Examples:"
    echo "  $0 status"
    echo "  $0 commit \"Fix login bug\""
    echo "  $0 commit-force \"Emergency fix\""
    echo "  $0 pull"
    echo
}

# Main script logic
main() {
    check_main_repo
    
    case "${1:-help}" in
        "status")
            show_status
            ;;
        "commit")
            commit_all "$2" "false"
            ;;
        "commit-force")
            commit_all "$2" "true"
            ;;
        "pull")
            pull_all
            ;;
        "init")
            init_submodules
            ;;
        "help"|*)
            show_help
            ;;
    esac
}

# Run main function with all arguments
main "$@"
