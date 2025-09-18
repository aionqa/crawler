#!/bin/bash

# AionQA - Quick Commit and Push Script
# Simple script for daily commits

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🚀 AionQA Quick Commit${NC}"
echo ""

# Check if we're in a git repo
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo "❌ Not in a git repository!"
    exit 1
fi

# Check for changes
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
    echo "ℹ️  No changes to commit!"
    exit 0
fi

# Generate commit message
timestamp=$(date '+%Y-%m-%d %H:%M:%S')
changes=$(git status --porcelain)

# Count changes
added=$(echo "$changes" | grep -c "^A" 2>/dev/null || echo "0")
modified=$(echo "$changes" | grep -c "^M" 2>/dev/null || echo "0")
deleted=$(echo "$changes" | grep -c "^D" 2>/dev/null || echo "0")
untracked=$(echo "$changes" | grep -c "^??" 2>/dev/null || echo "0")

# Create commit message
if [ $untracked -gt 0 ] && [ $modified -eq 0 ]; then
    msg="Add new features and files"
elif [ $modified -gt 0 ] && [ $untracked -eq 0 ]; then
    msg="Update existing functionality"
elif [ $deleted -gt 0 ]; then
    msg="Remove obsolete code"
else
    msg="Update codebase"
fi

# Add file type context
if echo "$changes" | grep -q "\.vue$"; then
    msg="$msg (Vue components)"
fi
if echo "$changes" | grep -q "\.js$"; then
    msg="$msg (JavaScript)"
fi
if echo "$changes" | grep -q "Dockerfile"; then
    msg="$msg (Docker)"
fi

msg="$msg - $timestamp"

echo "📝 Commit message: $msg"
echo ""

# Show summary
echo "📊 Changes summary:"
if [ $added -gt 0 ]; then echo "  ➕ Added: $added files"; fi
if [ $modified -gt 0 ]; then echo "  ✏️  Modified: $modified files"; fi
if [ $deleted -gt 0 ]; then echo "  ➖ Deleted: $deleted files"; fi
if [ $untracked -gt 0 ]; then echo "  🆕 Untracked: $untracked files"; fi
echo ""

# Stage, commit, and push
echo "📦 Staging changes..."
git add .

echo "💾 Committing..."
git commit -m "$msg"

echo "🚀 Pushing to remote..."
git push

echo ""
echo -e "${GREEN}✅ All changes committed and pushed successfully!${NC}"
