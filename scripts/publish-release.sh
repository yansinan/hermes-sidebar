#!/bin/bash
# publish-release.sh - GitHub Release Publication Script
# Run this on your local machine to publish v0.1.2-20260515

set -e

REPO="yansinan/hermes-sidebar"
TAG="v0.1.2-20260515"
CRX_ASSET="releases/hermes-sidebar-v0.1.2-20260515.crx"
NOTES_FILE="releases/RELEASE_NOTES_v0.1.2-20260515.txt"

echo "📦 Publishing Hermes Sidebar Release"
echo "=================================="
echo ""
echo "Repository: $REPO"
echo "Tag: $TAG"
echo "CRX Asset: $CRX_ASSET"
echo "Release Notes: $NOTES_FILE"
echo ""

# Check if GITHUB_TOKEN is set
if [ -z "$GITHUB_TOKEN" ]; then
    echo "❌ Error: GITHUB_TOKEN environment variable not set"
    echo ""
    echo "To set your token:"
    echo "  1. Go to https://github.com/settings/tokens"
    echo "  2. Generate new token (classic) with 'repo' scope"
    echo "  3. Run: export GITHUB_TOKEN=your_token_here"
    echo ""
    exit 1
fi

# Push tag to GitHub
echo "1️⃣  Pushing tag to GitHub..."
git push origin "$TAG" || {
    echo "ℹ️  Tag may already be pushed, continuing..."
}

echo ""
echo "2️⃣  Publishing GitHub release..."

# Run the Python script
python3 scripts/release/publish_github_release.py \
    --repo "$REPO" \
    --tag "$TAG" \
    --asset "$CRX_ASSET" \
    --notes-file "$NOTES_FILE"

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Release published successfully!"
    echo ""
    echo "📍 View release: https://github.com/$REPO/releases/tag/$TAG"
else
    echo ""
    echo "❌ Release publication failed"
    exit 1
fi
