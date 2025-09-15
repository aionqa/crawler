# AionQA Git Management System

This document explains how to manage git operations across the AionQA monorepo structure.

## Overview

AionQA uses a monorepo structure with git submodules. Each major component has its own GitHub repository:

- **Main Repository**: `https://github.com/qzaki/aicrawler.git`
- **Backend**: `https://github.com/qzaki/aionqa-back.git`
- **UI**: `https://github.com/qzaki/aionqa-ui.git`
- **Crawler Agents**: 
  - `https://github.com/qzaki/crawler-media.git`
  - `https://github.com/qzaki/crawler-simplified.git`
  - `https://github.com/qzaki/crawler-static.git`
  - `https://github.com/qzaki/crawler-text.git`
- **Login Agents**:
  - `https://github.com/qzaki/login-media.git`
  - `https://github.com/qzaki/login-simplified.git`
  - `https://github.com/qzaki/login-static.git`
  - `https://github.com/qzaki/login-text.git`

## Quick Start

### Check Status
```bash
./git-status.sh
```

### Commit and Push All Changes
```bash
./git-commit.sh "Your commit message here"
```

### Pull Latest Changes
```bash
./git-manager.sh pull
```

## Available Scripts

### `git-manager.sh`
The main management script with full functionality:

```bash
# Show status of all repositories
./git-manager.sh status

# Commit and push changes in all repositories
./git-manager.sh commit "Your commit message"

# Force commit and push (use with caution)
./git-manager.sh commit-force "Emergency fix"

# Pull latest changes from all repositories
./git-manager.sh pull

# Initialize submodules (for new clones)
./git-manager.sh init

# Show help
./git-manager.sh help
```

### `git-commit.sh`
Simple wrapper for committing changes:
```bash
./git-commit.sh "Your commit message"
```

### `git-status.sh`
Simple wrapper for checking status:
```bash
./git-status.sh
```

## How It Works

1. **Submodules**: Each component is a git submodule pointing to its own repository
2. **Credential Management**: Uses GitHub CLI (`gh`) for authentication
3. **Automatic Processing**: Scripts automatically process all repositories in the correct order
4. **Error Handling**: Scripts stop on errors and provide clear feedback

## Workflow

### Daily Development
1. Make changes in any component
2. Check status: `./git-status.sh`
3. Commit changes: `./git-commit.sh "Description of changes"`

### Getting Latest Changes
```bash
./git-manager.sh pull
```

### New Team Member Setup
```bash
git clone https://github.com/qzaki/aicrawler.git
cd aicrawler
./git-manager.sh init
```

## Authentication

The system uses GitHub CLI for authentication. Make sure you're logged in:

```bash
gh auth status
```

If not authenticated, login with:
```bash
gh auth login
```

## Troubleshooting

### Submodule Issues
If submodules get out of sync:
```bash
git submodule update --init --recursive
```

### Authentication Issues
If you get authentication errors:
```bash
gh auth refresh
```

### Force Push (Use with Caution)
If you need to force push (e.g., after rebasing):
```bash
./git-manager.sh commit-force "Your message"
```

## IDE Integration

### Cursor/VS Code
The scripts work seamlessly with Cursor and VS Code. You can:
- Run scripts from the integrated terminal
- Use the scripts in your IDE's git workflow
- The IDE will automatically detect changes in submodules

### WebStorm
WebStorm will automatically detect the submodule structure. You can:
- Use the built-in git tools for individual repositories
- Use the scripts for bulk operations
- The IDE will show changes in both main repo and submodules

## Best Practices

1. **Always use the scripts** for bulk operations
2. **Check status first** before committing
3. **Use descriptive commit messages**
4. **Pull before committing** if working in a team
5. **Don't manually edit .gitmodules** - use git submodule commands

## File Structure

```
aionqa/
├── .gitmodules              # Submodule configuration
├── git-manager.sh           # Main management script
├── git-commit.sh            # Simple commit wrapper
├── git-status.sh            # Simple status wrapper
├── back/                    # Backend submodule
├── ui/                      # UI submodule
├── crawler-*/               # Crawler agent submodules
├── login-*/                 # Login agent submodules
├── ai-service/              # Part of main repo
├── manual-analysis/         # Part of main repo
└── shared/                  # Part of main repo
```

## Support

If you encounter issues:
1. Check the script output for error messages
2. Verify GitHub CLI authentication: `gh auth status`
3. Check submodule status: `git submodule status`
4. Try pulling latest changes: `./git-manager.sh pull`
