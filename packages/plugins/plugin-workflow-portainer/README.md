# plugin-workflow-portainer

NocoBase 2.x workflow integration (`client` v1, `client-v2`, and `server`) for orchestrating CI/CD builds, redeployments, and lifecycle controls on **Portainer** environments and stacks.

## Features

- **Portainer Instance Management (`portainerInstances`)**:
  - Store Portainer URLs and Personal Access Tokens (`X-API-Key`) encrypted at rest (`aesEncryptor`) and masked in API responses.
  - Test connectivity (`GET /api/status` & `GET /api/endpoints`) and browse Environments + Stacks directly from Plugin Settings.
  - Optional self-signed TLS support (`:9443`) and fallback Git credentials.
- **Workflow Node: `Run / Redeploy Stack` (`portainer-stack-redeploy`)**:
  - Select **Portainer Instance → Environment (`endpointId`) → Stack (`stackId`)** via live cascading dropdowns or bind dynamic workflow variables (`{{...}}`).
  - **Git-backed Stacks**: Triggers `PUT /api/stacks/{id}/git/redeploy?endpointId={endpointId}`, preserving existing Portainer `GitCredentialID` / repository settings while allowing optional branch/tag overrides (`gitReference`).
  - **Separate Compose Deploy Stacks**: Automatically detects non-Git stacks, fetches `GET /api/stacks/{id}/file`, and updates via `PUT /api/stacks/{id}?endpointId={endpointId}` with optional `repullImage` and `prune` flags.
  - **Stack Webhooks**: Supports triggering `/api/stacks/webhooks/{token}?tag=...` without exposing `X-API-Key`.
  - **Full Environment Variable Control**: `Merge & override` (preserving existing Portainer Stack `Env` keys) or `Replace all`, one-click **Load Env from Stack**, Key–Value pairs with `Secret` log redaction, multi-line `.env` input, and dynamic JSON variables.
  - **Asynchronous Settlement**: Runs as a non-blocking background workflow job and polls asynchronous Portainer deployments (`Status = 3` Deploying → `1` Active / `4` Error) before advancing downstream nodes.
- **Workflow Node: `Control / Inspect Stack` (`portainer-stack-control`)**:
  - Supports **Inspect Stack & Health** (container running/total counts and Docker health states), **Start Stack**, and **Stop Stack**.

## Build & Test

```powershell
yarn test packages/plugins/plugin-workflow-portainer/src/server/__tests__/portainer-workflow.test.ts --run
yarn test packages/plugins/plugin-workflow-portainer/src/client-v2/__tests__/workflow-registration.test.tsx --run
yarn nocobase build plugin-workflow-portainer --no-dts
```

## License

Apache-2.0
