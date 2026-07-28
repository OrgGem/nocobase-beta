---
name: manage-confluence
description: Full Confluence Server/Data Center or self-hosted content operations through confluence.js, using a configured base URL and Bearer PAT. Use when the user asks to inspect, search, create, update, move, publish, comment on, or otherwise automate Confluence spaces, pages, attachments, or content.
---

# Manage self-hosted Confluence

Use `scripts/confluence.mjs` to invoke every v1/v2 client API with consistent configuration.

## Configure

Require Node.js 22+ (confluence.js 3.x is ESM-only) and run `npm install` once in this skill directory, then set:

```powershell
$env:CONFLUENCE_BASE_URL = 'https://confluence.example.local'
$env:CONFLUENCE_PAT = '<token>'
```

The runner passes `{ type: 'bearer', token: PAT }`, which produces the required `Authorization: Bearer` header. Do not use Basic auth. Keep PAT only in the environment and redact it from output.

## Operate

```powershell
node .codex/skills/manage-confluence/scripts/confluence.mjs list
node .codex/skills/manage-confluence/scripts/confluence.mjs list v2 page
node .codex/skills/manage-confluence/scripts/confluence.mjs call v2 page.getPageById '{"id":"123"}'
node .codex/skills/manage-confluence/scripts/confluence.mjs call v2 page.createPage '{"spaceId":"456","status":"current","title":"Example","body":{"representation":"storage","value":"<p>Hello</p>"}}'
```

Use `v1` for legacy Server/DC endpoints and `v2` for supported modern endpoints; inspect `list` first. Confirm destructive writes, use the smallest requested scope, and verify writes by reading the returned ID. For method groups and Server/DC caveats, read `references/api.md` and installed typings.
