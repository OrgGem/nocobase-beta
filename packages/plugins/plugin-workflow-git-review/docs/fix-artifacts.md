# Artifact and validation receipt

Snapshot date: 2026-11-10. This receipt covers Git Manager 1.3.1, Workflow Git Review 1.0.1, their client/server validation, and the packaged artifacts. Native Workflow integration results are recorded separately in `docs/fix-validation.md`.

## Builds

| Plugin | Command | Exit |
| --- | --- | ---: |
| Git Manager 1.3.1 | `yarn nocobase build plugin-git-manager --no-dts` | 0 |
| Workflow Git Review 1.0.1 | `yarn nocobase build plugin-workflow-git-review --no-dts` | 0 |

Both builds emitted client v1, client v2, server, locale, and `externalVersion.js` outputs. `node --check` passed for the root, client, client-v2, server, and external-version JavaScript entrypoints in both builds, and for the nested Git Manager server bundle. The expected English, Chinese, and Vietnamese locale JSON files are present. Scanning all emitted client-v2 JavaScript files found no `@nocobase/client` imports.

Workflow Git Review's build printed `An error occurred while minifying. The result will not be minified.` while bundling the Git Manager dependency. The log did not include a cause. The resulting 907,669-byte nested server entry parsed successfully; no clean-minification claim is made.

## Tests

All server tests were run sequentially.

| Area | Result |
| --- | --- |
| Client `workflowRoutes.test.ts` | 2/2 passed |
| Client `CommitHistory.test.tsx` | 2/2 passed |
| Client `RunReviewButton.test.tsx` | 2/2 passed |
| Client `ReviewHistory.test.tsx` | 1/1 passed |
| Git Manager integration, SQLite | 15 passed, 1 PostgreSQL-only case skipped |
| Git Manager integration, PostgreSQL | 16/16 passed |
| `review-source.test.ts` | 5/5 passed |
| `review.test.ts` | 4/4 passed |
| `repository-access.test.ts` | 77/77 passed |
| `role-permissions.test.ts` | 9/9 passed |
| `smoke.test.ts` | 17/17 passed |

Each client result came from `yarn test <file> --run --reporter=dot`. The Git Manager integration file was run with `DB_DIALECT=sqlite` and `DB_DIALECT=postgres` respectively; PostgreSQL used the disposable local test database. The smoke test's method-rejection requests emitted expected 405 log entries while all tests passed.

## Focused TypeScript diagnostics

The source-mapped TypeScript 5.6 harness in `%TEMP%\nocobase-typecheck-ts56-20261110` covered the plugin source against workspace package entrypoints.

- Workflow Git Review had **0 diagnostics in its plugin source**. The workspace program still reports 7,576 diagnostics overall.
- Git Manager had **0 new feature-code diagnostics**. The eight diagnostics matching changed paths remain at the task-baseline sites: `role-permissions.ts` lines 167 and 181, and implicit `ctx`/`next` parameters in `plugin.ts` lines 147, 280, and 349. The workspace program reports 7,098 diagnostics overall.

These focused results do not establish a clean repository-wide typecheck.

## Packages

Git Manager was packed directly after its native build. Workflow Git Review was packed from a fresh temporary copy of the native build output because the native dependency copy included an old Git Manager 1.3.0 archive and nested editor/MCP/test configuration files. The staged copy preserved the current Workflow `dist` output and copied only the nested Git Manager package's declared `files` entries. The plugin's original `dist` tree was left intact.

| Artifact | Workspace path | Size | Files | SHA-256 |
| --- | --- | ---: | ---: | --- |
| Git Manager 1.3.1 | `packages/plugins/plugin-git-manager/plugin-git-manager-1.3.1.tgz` | 1,292,280 bytes | 952 | `2803A861F7C028FE84D234E67A57651947D0CA19BBF3F6C7ED2DE96B15600EF7` |
| Workflow Git Review 1.0.1 | `packages/plugins/plugin-workflow-git-review/plugin-workflow-git-review-1.0.1.tgz` | 1,574,006 bytes | 1,012 | `247B266A2EC76F144E304B4AF28AF0BFD8BE691FFA1AAC7A62175A0A909DA373` |

The final Workflow archive's nested `plugin-git-manager/package.json` reports version 1.3.1. It does not contain the old 1.3.0 tarball or the nested `.env.e2e.example`, `.mcp.json`, editor MCP files, or `tsconfig.json`. The final archive filename scan found no actual `.env`, `.npmrc`, PEM, or token-named files.

The nested Git Manager `gitReviewRequests.js` contains `llmClaims` and is byte-identical to the standalone 1.3.1 output (SHA-256 `610A4934C67565C25E08B7A85E510650F48AD454EF011023F836CD39F0A2AA4D`). The nested source files and eight copied production outputs checked match the standalone package. The original workflow build omitted `node_modules/zod/LICENSE` from the nested copy, so the final staging package includes that license from the standalone 1.3.1 output (SHA-256 `3F1189B28E3866E0D979968D466B78F813F76827CFDCA1FBB124CC0A5C8841F8`). The nested distribution now has all 859 standalone files. The Workflow build re-bundles Git Manager's `server/index.js`, so that file is expected to differ byte-for-byte; its current bundle contains the canonical `plugin-git-manager` lookup with `git-manager` fallback, `legacyPostProjectKey`, the same-fingerprint guard, and post-claim fencing checks, and it passes `node --check`.

`@langchain/core` is declared as external peer version 1.1.49. `@langchain/core/messages` resolved from the extracted package to the workspace's root `node_modules`; this verifies workspace resolution only, not resolution in a production host.

## Structural package inspection

The standard `inspect_plugin.py --artifacts --archive` check returned `success: true` and no errors for both final archives. It reports the same informational warning for each plugin: `client.d.ts`, `client-v2.d.ts`, and `server.d.ts` exist without a standard generated `index.d.ts`. The inspector explicitly checks structure only; it does not prove build freshness, semantic typing, dependency resolution, or runtime behavior.

## Limits

These checks cover local tests, builds, package manifests and extracted artifacts. They do not verify installation or runtime behavior in a production NocoBase host. The Workflow server dependency minifier warning remains documented above; its emitted JavaScript passed syntax checks.
