# AionQA Commit Scripts

This directory contains automated scripts for staging, committing, and pushing changes in the AionQA project.

## Available Scripts

### 1. `commit-and-push.sh` - Full Featured Script
**Purpose**: Comprehensive script with full control and options

**Features**:
- ✅ Automatic commit message generation
- ✅ Submodule handling
- ✅ Change summary display
- ✅ Confirmation prompts
- ✅ Color-coded output
- ✅ Error handling

**Usage**:
```bash
# Basic usage (with confirmation)
./commit-and-push.sh

# Skip confirmation prompt
./commit-and-push.sh --force

# Only process submodules
./commit-and-push.sh --submodules-only

# Only process main repository
./commit-and-push.sh --main-only

# Show help
./commit-and-push.sh --help
```

### 2. `quick-commit.sh` - Daily Use Script
**Purpose**: Simple, fast script for daily commits

**Features**:
- ✅ Quick execution
- ✅ Automatic commit message generation
- ✅ Change summary
- ✅ No confirmation prompts

**Usage**:
```bash
./quick-commit.sh
```

### 3. `commit-submodules.sh` - Submodules Only
**Purpose**: Handle only submodule changes

**Features**:
- ✅ Processes all submodules
- ✅ Agent-specific commit messages
- ✅ Individual submodule status

**Usage**:
```bash
./commit-submodules.sh
```

## Commit Message Generation

The scripts automatically generate commit messages based on:

### Change Types
- **New files**: "Add new features and files"
- **Modified files**: "Update existing functionality"
- **Deleted files**: "Remove obsolete code"
- **Mixed changes**: "Update codebase with mixed changes"

### File Type Context
- **Vue files**: Adds "(Vue.js components)"
- **JavaScript files**: Adds "(JavaScript modules)"
- **Docker files**: Adds "(Docker configuration)"
- **JSON files**: Adds "(configuration files)"
- **Markdown files**: Adds "(documentation)"

### Submodule Context
- **Login agents**: Adds "(Login Agent)"
- **Crawler agents**: Adds "(Crawler Agent)"
- **Other modules**: Adds "(Agent Module)"

### Timestamp
All commit messages include a timestamp: `YYYY-MM-DD HH:MM:SS`

## Examples

### Example 1: Daily Development
```bash
# Quick commit for daily work
./quick-commit.sh
```
**Output**: `Add new features and files (Vue.js components) - 2025-09-18 19:45:23`

### Example 2: Full Project Update
```bash
# Comprehensive commit with confirmation
./commit-and-push.sh
```
**Output**: 
```
[INFO] Changes to be committed:
Staged changes:
  + ui/src/components/JobLogsPanel.vue
  ~ back/src/graylogService.js

[INFO] Commit message: Update existing functionality (Vue.js components) (JavaScript modules) - 2025-09-18 19:45:23
Do you want to proceed with commit and push? (y/N):
```

### Example 3: Submodules Only
```bash
# Commit only submodule changes
./commit-submodules.sh
```
**Output**:
```
📁 Processing submodule: login-simplified
📊 Changes in login-simplified:
  M src/login.js
  A new-feature.js
📝 Commit message: Update login-simplified functionality (Login Agent) - 2025-09-18 19:45:23
✅ login-simplified completed
```

## Safety Features

### Error Handling
- ✅ Exits on any error (`set -e`)
- ✅ Checks for git repository
- ✅ Validates changes exist
- ✅ Handles submodule errors gracefully

### Confirmation
- ✅ Shows change summary before committing
- ✅ Requires user confirmation (except `--force`)
- ✅ Clear success/error messages

### Validation
- ✅ Git repository validation
- ✅ Change detection
- ✅ Submodule existence checks

## Integration with AionQA

These scripts are designed specifically for the AionQA project structure:

### Submodules Handled
- `login-simplified/`
- `login-text/`
- `login-media/`
- `login-static/`
- `crawler-simplified/`
- `crawler-text/`
- `crawler-media/`
- `crawler-static/`

### Main Repository
- Backend changes (`back/`)
- UI changes (`ui/`)
- Configuration files
- Documentation

## Best Practices

### Daily Development
1. Use `quick-commit.sh` for regular commits
2. Commit frequently with meaningful changes
3. Use descriptive commit messages

### Major Updates
1. Use `commit-and-push.sh` for comprehensive changes
2. Review changes before committing
3. Handle submodules separately if needed

### Submodule Management
1. Use `commit-submodules.sh` for agent updates
2. Test submodules before committing
3. Ensure submodule changes are compatible

## Troubleshooting

### Common Issues

**"Not in a git repository"**
- Ensure you're in the AionQA root directory
- Run `git status` to verify

**"No changes to commit"**
- Check `git status` for actual changes
- Ensure files are not ignored

**"Failed to push submodule"**
- Check submodule remote configuration
- Verify submodule has push permissions

**Permission denied**
- Ensure scripts are executable: `chmod +x *.sh`
- Check git credentials

### Recovery

If a commit fails:
1. Check the error message
2. Fix the underlying issue
3. Re-run the script
4. Use `git status` to verify state

## Customization

### Modify Commit Messages
Edit the `generate_commit_message()` function in the scripts to customize message generation.

### Add File Types
Add new file type detection in the commit message generation logic.

### Change Defaults
Modify default values like minimum/maximum height constraints or default commit message templates.

---

**Note**: These scripts are designed for the AionQA project structure. Modify as needed for other projects.
