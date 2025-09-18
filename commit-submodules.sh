#!/bin/bash

# AionQA - Commit and Push Submodules Script
# Handles all submodules in the AionQA project

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🔧 AionQA Submodules Commit Script${NC}"
echo ""

# Function to process a submodule
process_submodule() {
    local submodule_path="$1"
    local submodule_name=$(basename "$submodule_path")
    
    echo -e "${BLUE}📁 Processing submodule: $submodule_name${NC}"
    
    cd "$submodule_path"
    
    # Check if there are changes
    if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
        echo -e "${YELLOW}  ℹ️  No changes in $submodule_name${NC}"
        cd - > /dev/null
        return
    fi
    
    # Show changes
    echo -e "${BLUE}  📊 Changes in $submodule_name:${NC}"
    git status --short | while read line; do
        echo -e "    $line"
    done
    
    # Generate commit message
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    local changes=$(git status --porcelain)
    
    local added=$(echo "$changes" | grep -c "^A" 2>/dev/null || echo "0")
    local modified=$(echo "$changes" | grep -c "^M" 2>/dev/null || echo "0")
    local deleted=$(echo "$changes" | grep -c "^D" 2>/dev/null || echo "0")
    local untracked=$(echo "$changes" | grep -c "^??" 2>/dev/null || echo "0")
    
    local msg=""
    if [ $untracked -gt 0 ] && [ $modified -eq 0 ]; then
        msg="Add new features to $submodule_name"
    elif [ $modified -gt 0 ] && [ $untracked -eq 0 ]; then
        msg="Update $submodule_name functionality"
    elif [ $deleted -gt 0 ]; then
        msg="Clean up $submodule_name code"
    else
        msg="Update $submodule_name codebase"
    fi
    
    # Add specific context based on submodule type
    case $submodule_name in
        login-*)
            msg="$msg (Login Agent)"
            ;;
        crawler-*)
            msg="$msg (Crawler Agent)"
            ;;
        *)
            msg="$msg (Agent Module)"
            ;;
    esac
    
    msg="$msg - $timestamp"
    
    echo -e "${BLUE}  📝 Commit message: $msg${NC}"
    
    # Stage, commit, and push
    echo -e "${BLUE}  📦 Staging changes...${NC}"
    git add .
    
    echo -e "${BLUE}  💾 Committing...${NC}"
    git commit -m "$msg" || echo -e "${YELLOW}  ⚠️  No changes to commit${NC}"
    
    echo -e "${BLUE}  🚀 Pushing to remote...${NC}"
    git push || echo -e "${RED}  ❌ Failed to push $submodule_name${NC}"
    
    echo -e "${GREEN}  ✅ $submodule_name completed${NC}"
    echo ""
    
    cd - > /dev/null
}

# Main execution
echo "🔍 Scanning for submodules..."

# Get list of submodules
submodules=$(git submodule status | awk '{print $2}' 2>/dev/null || true)

if [ -z "$submodules" ]; then
    echo -e "${YELLOW}ℹ️  No submodules found${NC}"
    exit 0
fi

echo "📋 Found submodules:"
echo "$submodules" | while read submodule; do
    echo "  - $submodule"
done
echo ""

# Process each submodule
echo "$submodules" | while read submodule; do
    if [ -d "$submodule" ]; then
        process_submodule "$submodule"
    else
        echo -e "${RED}❌ Submodule $submodule not found${NC}"
    fi
done

echo -e "${GREEN}🎉 All submodules processed!${NC}"
