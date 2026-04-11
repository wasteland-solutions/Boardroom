---
name: web-design-guidelines
description: Review UI code for Web Interface Guidelines compliance. Use when asked to review UI, check accessibility, audit design, review UX, or check against best practices.
---

Review UI code for compliance with Web Interface Guidelines. Fetch the latest rules, read specified files, check against all rules, and output findings in `file:line` format.

## Rules Source

Fetch current rules from:
```
https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
```

## Process

1. Fetch the latest guidelines from the source URL above
2. Read specified files (or ask user for files/pattern if none provided)
3. Check against all rules in the fetched guidelines
4. Output findings in `file:line` format grouped by file

## Output Format

Group by file. Use `file:line` format. Terse findings.

```text
## src/Button.tsx

src/Button.tsx:42 - icon button missing aria-label
src/Button.tsx:18 - input lacks label
src/Button.tsx:55 - animation missing prefers-reduced-motion

## src/Card.tsx

✓ pass
```

State issue + location. Skip explanation unless fix non-obvious. No preamble.
