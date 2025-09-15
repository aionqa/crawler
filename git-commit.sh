#!/bin/bash

# Simple wrapper for git-manager.sh
# Usage: ./git-commit.sh [commit message]

if [ -z "$1" ]; then
    echo "Usage: $0 \"commit message\""
    echo "Example: $0 \"Fix login bug and update UI\""
    exit 1
fi

./git-manager.sh commit "$1"
