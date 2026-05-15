# Release v0.1.2-20260515 - Publication Checklist

## ✅ Pre-Publication Tasks (Completed)

### Build & Package
- [x] Full project build: `npm run build`
- [x] Bundles generated:
  - [x] readability.bundle.js (34 KB)
  - [x] turndown.bundle.js (12.5 KB)
  - [x] markdown.bundle.js (159.9 KB) — React Markdown fix
- [x] Signed CRX created: `releases/hermes-sidebar-v0.1.2-20260515.crx` (1.2 MB)
- [x] ZIP package created: `releases/hermes-sidebar-v0.1.2-20260515.zip` (327 KB)

### Version Control
- [x] Main branch merged with feature branch
- [x] Git tag created: `v0.1.2-20260515`
- [x] Commits prepared:
  - [x] `7f2702c` - feat: Add react-markdown bundle for stable markdown rendering
  - [x] `49ff72a` - chore: Add CRX signing with dist.pem and release documentation

### Documentation
- [x] RELEASE_NOTES_v0.1.2.md — Detailed changelog
- [x] RELEASE_NOTES_v0.1.2-20260515.txt — GitHub format
- [x] RELEASE_PUBLICATION_GUIDE.md — Complete CRX & publication guide
- [x] GITHUB_RELEASE_GUIDE.md — Step-by-step GitHub instructions
- [x] scripts/publish-release.sh — Automated publication script

### Testing
- [x] All tests passing (markdown.test.tsx 2/2 ✓)
- [x] No TypeScript errors
- [x] CRX file verified: "Google Chrome extension, version 3"
- [x] Bundles verified: all present in dist/

### Files Ready for GitHub Release
```
releases/
├── hermes-sidebar-v0.1.2-20260515.crx          ✓ 1.2 MB — Main asset
├── hermes-sidebar-v0.1.2-20260515.zip          ✓ 327 KB — Backup format
├── RELEASE_NOTES_v0.1.2-20260515.txt           ✓ Release body
└── dist.crx                                    ✓ Previous (v0.1.1)
```

---

## ⏳ GitHub Publication (Next Steps - Run on Local Machine)

### Prerequisites
- [ ] Network access
- [ ] Git command line configured
- [ ] GitHub Personal Access Token (get at https://github.com/settings/tokens)

### Publication Steps

**Option A: Automated Script**
```bash
cd /path/to/hermes-sidebar
export GITHUB_TOKEN=your_github_token_here
bash scripts/publish-release.sh
```

**Option B: Manual Command**
```bash
cd /path/to/hermes-sidebar
python3 scripts/release/publish_github_release.py \
  --repo yansinan/hermes-sidebar \
  --tag v0.1.2-20260515 \
  --asset releases/hermes-sidebar-v0.1.2-20260515.crx \
  --notes-file releases/RELEASE_NOTES_v0.1.2-20260515.txt
```

### Publication Checklist
- [ ] GITHUB_TOKEN set
- [ ] Tag pushed: `git push origin v0.1.2-20260515`
- [ ] Release published via script
- [ ] GitHub release page accessible: https://github.com/yansinan/hermes-sidebar/releases/tag/v0.1.2-20260515
- [ ] CRX asset downloadable
- [ ] Release notes displayed correctly

---

## 📊 Release Summary

| Item | Value |
|------|-------|
| Version | v0.1.2-20260515 |
| Release Date | May 15, 2026 |
| Main Feature | React-markdown for stable rendering |
| CRX Size | 1.2 MB |
| Signed With | dist.pem (SHA-256) |
| Build Status | ✅ Complete |
| Tests | ✅ Passing (2/2) |
| TypeScript | ✅ No errors |
| Git Tag | ✅ Created |
| GitHub Ready | ✅ Yes |

---

## 🎯 After Publication

Once published to GitHub:
- [ ] Verify release page live
- [ ] Test CRX installation
- [ ] Announce on social media
- [ ] Update README installation docs
- [ ] Consider Chrome Web Store submission

---

**Next**: Run publication script from local machine with GITHUB_TOKEN
