# plugin-rclone-manager

Manage one or multiple **Rclone Remote Control (`rclone rcd`)** nodes from NocoBase 2.x (`client` v1 & `client-v2`), with Workflow-driven non-blocking transfers and granular ACL controls for high-privilege operations.

## Quick Start (`rclone rcd`)

Run Rclone in daemon mode with `--rc-serve` enabled (for direct streaming downloads and HTTP `Range` support without ephemeral ports):

```bash
docker run -d \
  --name rclone-rcd \
  -p 5572:5572 \
  -v ~/.config/rclone:/config/rclone \
  rclone/rclone:latest \
  rcd --rc-serve --rc-addr=0.0.0.0:5572 --rc-user=admin --rc-pass='change-me'
```

Then open **Plugin Settings -> Rclone Manager -> Connections & Config** in NocoBase and register `http://rclone-rcd:5572` (supports `{{$env.VAR}}` secret references).

## Modules & ACL Snippets

- `pm.plugin-rclone-manager.access`: Display Rclone Manager in settings / embedded blocks.
- `pm.plugin-rclone-manager.read`: View Dashboard, cloud remotes (secrets masked), File Explorer, and Transfers.
- `pm.plugin-rclone-manager.transfer`: Upload, download stream, `mkdir`, `delete`, in-place rename, stop jobs, and dispatch Copy / Move / Sync workflows.
- `pm.plugin-rclone-manager.remotes`: Create, update, and delete cloud storage remotes (`/config/providers` dynamic schema).
- `pm.plugin-rclone-manager.local-fs` *(High privilege)*: Browse and transfer on host local disks (`/core/disks`, local paths, `type=local` remotes).
- `pm.plugin-rclone-manager.mounts` *(High privilege)*: Manage FUSE mounts (`/mount/*`).
- `pm.plugin-rclone-manager.serves` *(High privilege)*: Start/stop HTTP, WebDAV, SFTP, FTP, DLNA, and S3 serve endpoints (`/serve/*`).
- `pm.plugin-rclone-manager.raw-config` *(High privilege)*: Tune runtime flags (`Transfers`, `Checkers`, `BwLimit`, `TPSLimit`, `LogLevel`) and edit `rclone.conf`.
- `pm.plugin-rclone-manager.connections` *(High privilege)*: Manage `rclone rcd` connections.

## Workflow Integration (`rclone-transfer`)

All asynchronous `sync/copy`, `sync/move`, `sync/sync`, `sync/bisync`, `operations/copyfile`, and `operations/movefile` operations run through NocoBase Workflow (`JOB_STATUS.PENDING` + background `RcloneJobReconciler` calling `workflow.resume(job)` on completion).
