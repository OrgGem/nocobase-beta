# confluence.js API navigation

`createV1Client` exposes legacy Server/DC-compatible APIs; `createV2Client` exposes modern REST v2 APIs. Both return grouped properties (for example `page`, `space`, `attachment`, `search`, and `comment`). Run `list`, then inspect the installed TypeScript declarations for exact method names and payload schemas because coverage differs by Confluence version.
