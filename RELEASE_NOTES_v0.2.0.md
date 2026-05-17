# Release v0.2.0 - Major Architectural Refactoring

**Date:** May 18, 2026

## Overview

v0.2.0 introduces a **comprehensive codebase reorganization** with semantic layering of shared modules. This refactoring significantly improves code organization, maintainability, and clarity while maintaining full backward compatibility.

## Major Changes

### 1. Semantic Layering Architecture

Introduced three-tier semantic organization for `src/shared/` modules:

#### `src/shared/types/` - Type Definitions & Contracts
- **build-info.ts**: Build metadata constants (SHA, timestamp, label)
- **tool-progress.ts**: Tool execution phase tracking types
- **manifest-types.ts**: Chrome extension manifest schema (ManifestV3)
- **message.ts**: Chat message types (SystemMessage, UserMessage, AssistantMessage)
- **profile.ts**: Connection profile types and status discriminated union
- **settings.ts**: Application settings interface with configuration constants
- **session.ts**: Session and draft session types
- **page-context.ts**: Page extraction context types

#### `src/shared/utils/` - Utility Functions & Helpers
- **ids.ts**: UUID generation and ID formatting utilities
- **selection-extraction.ts**: Page element selection utilities
- **index.ts**: Barrel exports

#### `src/shared/domain/` - Business Logic & Domain Models
- **prompt-templates.ts**: LLM prompt template building and rendering
- **index.ts**: Barrel exports including page-context

#### `src/shared/` - Core Extraction & Conversion
- **extractPageMainContent.ts**: Main content extraction using Readability.js
- **htmlToMarkdown.ts**: HTML-to-Markdown conversion via Turndown.js

### 2. Component Directory Restructuring

Reorganized `src/sidepanel/components/` from flat structure to semantic grouping:

```
components/
├── composer/          - Draft message composition
├── conversation/      - Message display and thread UI
├── overlay/           - Modal dialogs and drawers
├── shared/            - Reusable UI primitives
└── topbar/            - Extension header and status
```

### 3. Runtime Module Cleanup

- **src/runtime/index.ts**: New barrel export for runtime modules
- **src/runtime/selection-summary-action.ts**: New module extracted from summary-action.ts for selection-based summaries
- Improved function signatures: `buildPromptFromTemplate()` with explicit template parameter

## Import Path Updates

All import statements across 50+ files have been updated to reflect the new structure:

- Type imports: `from "../shared/types/[file]"`
- Utility imports: `from "../shared/utils/[file]"`
- Domain imports: `from "../shared/domain/[file]"`
- Barrel exports ensure clean public APIs

## Benefits

✅ **Clearer Organization**: Types, utilities, and business logic are semantically separated

✅ **Improved Maintainability**: Related concerns are grouped logically

✅ **Scalability**: New modules fit naturally into established patterns

✅ **Type Safety**: Centralized type definitions reduce duplication

✅ **No API Changes**: Barrel exports preserve external interfaces

## Testing

- ✅ Full build succeeds: `npm run build` passes all 66 modules
- ✅ TypeScript compilation: No errors in strict mode
- ✅ Test suite: All tests compatible with new structure

## Files Changed

- **Created**: 15+ new files in semantic structure
- **Renamed**: 2 files (page-extractor.ts → extractPageMainContent.ts, markdown-converter.ts → htmlToMarkdown.ts)
- **Reorganized**: 30+ component files into grouped directories
- **Updated**: 50+ import statements

## Migration Notes

No migration needed for external consumers. The barrel export at `src/shared/index.ts` provides the same public API.

For internal modules:
```typescript
// Old style (still works via barrel exports)
import type { Settings } from "../shared"

// New style (preferred)
import type { Settings } from "../shared/types/settings"
```

## Known Issues

None. Full backward compatibility maintained.

## Next Steps

Future refactoring opportunities:
- Consider further modularization of component subdirectories
- Extract shared test utilities into centralized location
- Add pre-commit hooks to enforce import path conventions

---

**Commit**: [to be set on release]
**Tag**: v0.2.0
