# GitHub Release Publication - Quick Start

## ⚠️ Prerequisites
- Network access (required for GitHub API)
- Git command line with GitHub credentials
- GitHub Personal Access Token (PAT) with `repo` scope

## 🚀 Step-by-Step Publication

### 1. Get Your GitHub Token

Visit: https://github.com/settings/tokens

Click "Generate new token (classic)" and:
- Select scope: `repo` (full control of private repositories)
- Copy the generated token (won't show again!)

### 2. Run Publication Script

From your local machine in the repo directory:

```bash
# Navigate to repo
cd /path/to/hermes-sidebar

# Set your GitHub token
export GITHUB_TOKEN=your_github_token_here

# Run publication (option A: automated script)
bash scripts/publish-release.sh

# OR option B: manual command
python3 scripts/release/publish_github_release.py \
  --repo yansinan/hermes-sidebar \
  --tag v0.1.2-20260515 \
  --asset releases/hermes-sidebar-v0.1.2-20260515.crx \
  --notes-file releases/RELEASE_NOTES_v0.1.2-20260515.txt
```

### 3. Verify Publication

Visit: https://github.com/yansinan/hermes-sidebar/releases/tag/v0.1.2-20260515

Check that:
- ✅ Release title matches
- ✅ Release notes are displayed
- ✅ CRX file is attached (1.2 MB)
- ✅ Tag is created

---

## 📋 Release Contents Being Published

| File | Size | Description |
|------|------|-------------|
| **hermes-sidebar-v0.1.2-20260515.crx** | 1.2 MB | Signed Chrome extension (CRX3 format) |
| **RELEASE_NOTES_v0.1.2-20260515.txt** | 1.4 KB | Release notes/changelog |

## 🔐 Release Details

- **Version**: v0.1.2-20260515
- **Tag**: v0.1.2-20260515
- **Branch**: main
- **Commit**: 49ff72a (includes CRX signing infra)
- **Signing**: SHA-256 with dist.pem

## 🎯 What Gets Published

```
GitHub Release Page
├── Title: v0.1.2-20260515
├── Tag: v0.1.2-20260515
├── Description: (from RELEASE_NOTES_v0.1.2-20260515.txt)
├── Assets:
│   └── hermes-sidebar-v0.1.2-20260515.crx (1.2 MB)
└── Metadata:
    ├── Created by: [your GitHub account]
    ├── Date: [current date]
    └── URL: https://github.com/yansinan/hermes-sidebar/releases/tag/v0.1.2-20260515
```

## ⚡ Quick Troubleshooting

### Error: "GITHUB_TOKEN not set"
```bash
# Set the token
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxx

# Verify it's set
echo $GITHUB_TOKEN
```

### Error: "Authentication failed"
- Check token has `repo` scope
- Token may have expired
- Get a new token from https://github.com/settings/tokens

### Error: "Release already exists"
- Release was already published
- To update: manually edit on GitHub or delete and recreate

### Error: "Asset not found"
- Verify file exists: `ls -lh releases/hermes-sidebar-v0.1.2-20260515.crx`
- Check path is correct relative to repo root

---

## ✅ Post-Publication Tasks

After successful publication:

1. **Announce Release**
   - Tweet/social media
   - Discord/community channels
   - Email subscribers

2. **Update Documentation**
   - Update README.md with installation link
   - Pin release in GitHub discussions
   - Add to changelog/history

3. **Monitor**
   - Check GitHub issues for feedback
   - Monitor Chrome Web Store (if submitted)

---

## 📖 Additional Resources

- [GitHub REST API - Releases](https://docs.github.com/en/rest/releases/releases)
- [Creating Personal Access Tokens](https://github.com/settings/tokens)
- [Chrome Extension Publishing Guide](https://developer.chrome.com/docs/webstore/)
- Project Scripts:
  - `npm run build` — Full build with all bundles
  - `npm run build:crx` — Generate signed CRX
  - `npm run release:github` — Publish to GitHub

---

**Release Tag**: v0.1.2-20260515  
**Status**: Ready to publish  
**Repository**: https://github.com/yansinan/hermes-sidebar
