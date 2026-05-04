# NocoBase Kubernetes Production HA

This manifest starts the NocoBase app cluster only. Worker pods are created later by the Cluster Manager plugin.

## Startup Model

1. Apply `nocobase-ha.yaml`.
2. Kubernetes starts infrastructure services and the `app-primary` Deployment.
3. Scale the app cluster by changing `app-primary.spec.replicas`.
4. Open NocoBase admin UI, then go to Cluster Manager -> Orchestrator.
5. Create one or more worker stacks and scale them from the plugin.

The bootstrap manifest intentionally does not create worker Deployments. This lets operators create separate worker groups, for example:

- `app-workers` for normal background jobs.
- `app-worker-sandbox` for sandbox-enabled workers.
- Extra worker stacks with different images, commands, environment variables, or resource limits.

## Default Worker Stack

The Cluster Manager worker-stack form is prefilled for this manifest:

- Adapter: `kubernetes`
- Image: `nocobase-git:latest`
- Namespace: `nocobase`
- Deployment name: `app-workers`
- Service account: `nocobase-orchestrator`
- EnvFrom: `nocobase-config` and `nocobase-secret`
- Volumes: `app-storage` PVC and `nocobase-scripts` ConfigMap
- Environment: `APP_ROLE=worker`, `WORKER_MODE=*`, `APP_PORT=13000`

After creating the stack, set Desired replicas and click Scale. The Kubernetes adapter creates the Deployment if it does not exist, then patches replicas on later scale operations.

## Package Installation

Use Cluster Manager -> Packages to install OS packages, Python modules, or global npm modules.

The installer supports three targets:

- App nodes only.
- Worker nodes only.
- All app and worker nodes.

Each node checks whether each package/module is already installed before running an installer.

## RBAC

`nocobase-orchestrator` can create and scale worker Deployments in the `nocobase` namespace. App nodes use this ServiceAccount so the app-cluster leader can perform orchestrator writes.

Worker-only nodes do not participate in orchestrator leader election, but they still load the plugin for monitoring, log access, and package-install PubSub events.
