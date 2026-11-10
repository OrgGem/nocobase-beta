# Git review workflow validation

Validation completed on 2026-11-10 against the local source tree. Server test files were run sequentially with `yarn test <path> --run --reporter=dot`; they were not run in parallel.

## Test results

The focused existing server suites passed before formatting: 10 files, 141 tests. The two new integration files were then formatted with `yarn eslint --fix` by the artifact validation worker. After formatting, the affected Git Manager integration suite and both database runs of the native Workflow integration suite passed again. The related role-permissions suite also passed.

| Suite | Tests | Result |
| --- | ---: | --- |
| `plugin-git-manager/src/server/__tests__/review.test.ts` | 4 | 4 passed |
| `plugin-git-manager/src/server/__tests__/poller.test.ts` | 1 | 1 passed |
| `plugin-git-manager/src/server/__tests__/poller-lifecycle.test.ts` | 2 | 2 passed |
| `plugin-git-manager/src/server/__tests__/plugin-url-security.test.ts` | 2 | 2 passed |
| `plugin-git-manager/src/server/__tests__/git-security.test.ts` | 16 | 16 passed |
| `plugin-git-manager/src/server/__tests__/repository-access.test.ts` | 77 | 77 passed |
| `plugin-git-manager/src/server/services/__tests__/review-source.test.ts` | 5 | 5 passed |
| `plugin-git-manager/src/server/__tests__/review-service.integration.test.ts` | 5 | 5 passed; rerun after formatting, SQLite |
| `plugin-git-manager/src/server/__tests__/smoke.test.ts` | 17 | 17 passed |
| `plugin-git-manager/src/server/__tests__/role-permissions.test.ts` | 9 | 9 passed |
| `plugin-workflow-git-review/src/server/__tests__/review-result.test.ts` | 12 | 12 passed |
| `plugin-workflow-git-review/src/server/__tests__/native-workflow.integration.test.ts` | 4 | 4 passed on PostgreSQL; rerun after formatting |
| `plugin-workflow-git-review/src/server/__tests__/native-workflow.integration.test.ts` | 4 | 4 passed on SQLite; rerun after formatting |

There were 154 distinct passing test cases across the focused suites. The native Workflow tests were also run on both databases; the SQLite run repeats the same four cases to verify the SQLite transaction fix. Every invocation exited 0.

## Covered behavior

- Git Manager service tests use a disposable SQL test app and local Git repositories with a fake GitLab API. They cover canonical project aliases, event deduplication versus explicit reruns, same-project admission ordering, concurrent distinct projects, quarantine/recovery, legacy pending/running drain and stale queue delivery, and publication retry/marker/reset fencing.
- Native Workflow integration tests use NocoBase `getApp`, the real Workflow engine, native LLM node/provider registration, and native manual-task submission. Quick and Full execute through the engine; Full invokes four deterministic provider calls and checks synthesis references earlier results. Tests cover idempotent provisioning/repair revisions, approval fingerprint binding, queued rerun release, native replay deduplication while a provider call is pending (including a disabled service), non-MR completion through a manual-policy graph without a manual task or post, immediate rejection, late completion after fencing, and provider-start fencing after ownership is lost.
- The native integration fixtures use fake GitLab responses, local repositories and a deterministic test provider. The PostgreSQL run used a disposable `postgres:16-alpine` container named `codex-git-review-pg-validation-20261110`, bound only to loopback on an ephemeral test port, with no host bind mounts or existing application volumes. The SQLite driver was installed outside the repository and exposed only through test `NODE_PATH`; no repository manifest or lockfile was changed for it.

## Evidence limits

These results establish focused source-level tests on disposable local databases. They do not verify a real GitLab account/API, a production LLM provider, browser interaction, deployment, cutover against an existing production queue, or behavior across independently running production processes. No production database or service was started or modified.

The named disposable PostgreSQL container and its Docker-generated anonymous volume were removed and verified absent. The temporary SQLite dependency directory `%TEMP%\nocobase-git-review-test-deps` remains: the automatic execution review rejected recursive removal of that exact directory, so cleanup stopped there. The unrelated root-level `Process_d_kd2eqqnruu` SQLite database was preserved because its provenance was inconclusive.
