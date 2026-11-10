# Fix validation receipt

Validation for the Git review fixes, run on 2026-11-10. Tested package versions were `plugin-git-manager@1.3.1` and `plugin-workflow-git-review@1.0.1`. Lookup coverage uses the canonical full package name in the GM fixture and the short alias in the native Workflow fixture to exercise compatibility fallback. This receipt is separate from the earlier focused-suite totals in `validation.md`.

## Native Workflow ACL regressions

The test extends `src/server/__tests__/native-workflow.integration.test.ts` with real HTTP resource reads through NocoBase `getApp`:

- `jobs.upstream:get` with a forged `filterByTk`, both with and without a projected primary key.
- `jobs.execution:get` expanding child jobs, including a projection that omits child IDs.
- A custom `belongsTo jobs` association whose `targetKey` is `nodeKey`, not the job primary key.
- A nested `executions.jobs.upstream(recursively=true)` append through an unrelated workflow.
- Positive controls for a reader with Git repository access and an unmanaged workflow/job; negative controls for a non-root workflow-only reader.

Every denied-reader assertion checks only whether the response contains the fixture diff marker; raw review diff data is not printed. The custom `belongsTo` request omits `job.id`, but NocoBase serializes the related row identity in this response, so its authorized positive result is expected. The direct singular and `jobs.execution` cases also check that omitted-ID requests do not reveal the managed diff to the unauthorized reader.

## Other native Workflow integration coverage

The same eight-test file also exercises:

- Quick and Full native LLM graphs, manual approvals, same-project queued reruns, and release after approval.
- Durable continuation after an LLM resume-delivery failure without invoking the provider again, plus duplicate predecessor delivery across independent local lock managers.
- Recovery of an orphan native approval job using its original job ID and durable task checkpoint.
- Reconciliation after publication succeeds but the Workflow publish checkpoint is missing, without another provider request.
- Non-MR commit review through a manual-policy graph, with no manual task or publication.
- Immediate provider rejection, late results after fencing, and suppression of provider start after ownership is lost.

## Commands and results

Scoped lint passed with exit 0:

```powershell
yarn eslint --fix packages/plugins/plugin-workflow-git-review/src/server/__tests__/native-workflow.integration.test.ts
```

SQLite focused HTTP test passed with exit 0: 1 passed, 7 skipped.

```powershell
$env:NODE_PATH = Join-Path $env:TEMP 'nocobase-git-review-test-deps\node_modules'
$env:DB_DIALECT = 'sqlite'
yarn test packages/plugins/plugin-workflow-git-review/src/server/__tests__/native-workflow.integration.test.ts --run --reporter=dot -t 'scopes native workflow job history'
```

PostgreSQL focused HTTP test passed with exit 0: 1 passed, 7 skipped. It used the isolated loopback-only container `codex-git-review-fix-pg-20261110` and database `codex_native_workflow_fix_20261110`; no host bind mount or existing application volume was used.

```powershell
$env:NODE_PATH = Join-Path $env:TEMP 'nocobase-git-review-test-deps\node_modules'
$env:DB_DIALECT = 'postgres'
$env:DB_HOST = '127.0.0.1'
$env:DB_PORT = '63465'
$env:DB_USER = 'postgres'
$env:DB_DATABASE = 'codex_native_workflow_fix_20261110'
yarn test packages/plugins/plugin-workflow-git-review/src/server/__tests__/native-workflow.integration.test.ts --run --reporter=dot -t 'scopes native workflow job history'
```

Both focused runs used the real Workflow server and database adapter. GitLab and LLM provider traffic was stubbed; no external provider or production service was contacted. The test emitted a Workflow warning for a synthetic fixture job without a matching flow node; both runs completed successfully.

After the ACL extension, the complete native Workflow integration file was rerun sequentially against both adapters:

| Database | Result | Duration | Log |
| --- | --- | ---: | --- |
| SQLite | 8/8 passed; exit 0 | 19.65 s | `%TEMP%\git-review-native-final-sqlite-20261110.log` |
| PostgreSQL | 8/8 passed; exit 0 | 23.23 s | `%TEMP%\git-review-native-final-postgres-20261110.log` |

The full-suite command was:

```powershell
yarn test packages/plugins/plugin-workflow-git-review/src/server/__tests__/native-workflow.integration.test.ts --run --reporter=dot
```

## Limits

This receipt verifies the scoped HTTP read-guard paths and all eight native Workflow integration cases on SQLite and disposable PostgreSQL. It does not establish production browser behavior, deployment state, or access behavior against an external Git provider.

## Test-resource cleanup

After the GM PostgreSQL tests completed, the owned disposable container `codex-git-review-fix-pg-20261110` was stopped. Inspection had confirmed that its only mount was the Docker-generated anonymous volume `2d06596ee9d8f944cc4aa5ffc860b16cc1cbad00600da0f3b3bd5271d5a0bfdf` at `/var/lib/postgresql/data`, labeled `com.docker.volume.anonymous`. The container auto-removed on stop; the follow-up `docker rm -v` reported no such container. Verification found no matching container in `docker ps -a` and no matching volume in `docker volume ls`.

The temporary SQLite driver directory `%TEMP%\nocobase-git-review-test-deps` was preserved. The unrelated root-level `Process_d_kd2eqqnruu` SQLite database was also preserved.
