# Artifact and client validation receipt

Validated on 2026-11-10 in `D:\Git\nocobase-beta-port` for `plugin-git-manager@1.3.0` and `plugin-workflow-git-review@1.0.0`.

## Lint and tests

- Focused `yarn eslint --fix` passed for all workflow plugin production TS/TSX and the changed Git Manager files `CommitHistory.tsx`, `RunReviewButton.tsx`, `actions/review.ts`, `collections/gitReviewRequests.ts`, and `services/review-service.ts`. Test files were excluded from this command.
- `yarn eslint --fix` passed on the two new server integration tests and the client tests.
- `yarn test packages/plugins/plugin-git-manager/src/client/__tests__/CommitHistory.test.tsx --run --reporter=verbose`: 2/2 passed. This covers a confirmed current branch and detached HEAD.
- `yarn test packages/plugins/plugin-git-manager/src/client/__tests__/RunReviewButton.test.tsx --run --reporter=verbose`: 2/2 passed. This covers managed queue submission and the absence of direct AI invocation.
- Sequential server tests, database details, and their evidence limits are recorded in [validation.md](./validation.md).

One broad `eslint --fix` sweep touched 32 unrelated Git Manager files. The Git Manager implementation owner restored those files and confirmed they matched `HEAD`; feature and test files were preserved. Final lint validation was scoped to changed production files and tests.

## Builds and TypeScript

Both native builds exited 0 after the final source patches and cleanup:

```powershell
yarn nocobase build plugin-git-manager --no-dts
yarn nocobase build plugin-workflow-git-review --no-dts
```

The final emitted bundles passed `node --check` for 47 Git Manager JS files and 17 workflow JS files, plus the external-version files and the nested Git Manager server entry and request-collection module. All six emitted `en-US`, `zh-CN`, and `vi-VN` locale JSON files parsed. Both client-v2 bundles contain no exact `@nocobase/client` v1 import.

The root TypeScript 5.1.3 compiler cannot parse the installed `@types/sanitize-html` 2.16.2 import-attribute declaration and reports TS1005 at its first line. A temporary TypeScript 5.6.3 strict check with real workspace source mappings reported 0 workflow-plugin-local diagnostics and 31 existing Git Manager diagnostics in legacy/unchanged files; it reported no diagnostics in the changed files checked above. The compiler processes still exited 2 because imported upstream/core/workspace sources produce 7,576 workflow and 7,098 Git Manager diagnostics. This is bounded source coverage, not a clean monorepo typecheck.

## Package artifacts

Final archives are stored in the plugin roots:

| Package | Archive | Size | SHA-256 |
| --- | --- | ---: | --- |
| `plugin-git-manager@1.3.0` | [`plugin-git-manager-1.3.0.tgz`](../../plugin-git-manager/plugin-git-manager-1.3.0.tgz) | 1,266,166 bytes | `C9B6425C2AF2D19B84C78B4CFAA349C52A6F56E311EA33A1FD9B440BDD6358B6` |
| `plugin-workflow-git-review@1.0.0` | [`plugin-workflow-git-review-1.0.0.tgz`](../plugin-workflow-git-review-1.0.0.tgz) | 1,351,348 bytes | `48D4BAA4BA6493315421F880058DB6D3C9348892952120328970ABE09659C216` |

The archives contain 947 and 1,002 files respectively. Their manifests include source trees, so they also carry test-like source/dependency files. Both archives contain no actual `.env`, `.npmrc`, or private-key files; neither contains hidden files.

The workflow build tool has a version-only cache for `dist/node_modules/<dependency>/package.json`. The existing generated `plugin-workflow-git-review/dist/node_modules/plugin-git-manager` still contains the previous 1.3.0 payload, whose `gitReviewRequests` collection lacks `llmClaims`. Removing the plugin `dist` directory was rejected by automatic execution review; no deletion was performed. The repo-wide `clean --dist` command is global and was not used.

To produce the authoritative workflow archive, the built plugin was copied into a new temporary staging directory, excluding only the stale nested Git Manager subtree. The current standalone Git Manager archive was unpacked into that location, then `npm pack` ran from the staging root. The resulting 947-file nested Git Manager copy matches the standalone Git Manager archive path-for-path and SHA-256-for-SHA-256. The staging directory remains at `%TEMP%\nocobase-git-review-staging-final-20261110\workflow-plugin-stage`; the final archives are the copies in the plugin roots above. Repacking directly from the workflow plugin root is unsafe until the generated dependency cache is refreshed.

The packed workflow declares `@langchain/core` peer version `1.1.49`; `dist/externalVersion.js` reports the same version and `dist/server/llm-instruction.js` keeps `@langchain/core/messages` external. In an unpacked host-like layout with the workspace `node_modules` linked as host dependencies, `require.resolve('@langchain/core/messages')` resolved successfully, and nested Git Manager `simple-git` resolved from its packaged dependency. This confirms package-layout resolution only, not a clean install or production runtime.
