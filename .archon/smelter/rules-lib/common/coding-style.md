# Coding Style

**Immutability:** Always return new objects, never mutate in-place.

**File size:** 200–400 lines typical, 800 max. Many small files > few large files. Organize by feature/domain.

**Error handling:** Handle explicitly at every level. User-friendly in UI, detailed in logs. Never swallow silently.

**Input validation:** Validate at system boundaries. Schema-based where possible. Fail fast. Never trust external data.

## Checklist

- [ ] Readable, well-named
- [ ] Functions <50 lines, files <800 lines
- [ ] No deep nesting (>4 levels)
- [ ] No hardcoded values
- [ ] No mutation (immutable patterns)
- [ ] Errors handled, inputs validated
