# plugin-haproxy-dataplane

Full zero-SSH multi-server **HAProxy Data Plane API v3** (`haproxytech/dataplaneapi`) administration for NocoBase 2.x across Legacy Client (`client`) and Modern Client (`client-v2`).

## Capabilities (100% HTTP/HTTPS — No SSH Required)

- **Fleet Overview**: Unified health, configuration `version` drift detection, active connection counts, open transaction counts, and reload status across all registered HAProxy servers.
- **Reverse Proxy (`In → Out`) Matrix**: Single-screen view of all Inbound listeners (`IP:Port` / Domain / Path / SSL) → Outbound targets (`IP:Port` + live `UP/DOWN` status) across all HAProxy nodes (with Node IP, Inbound, Outbound, and Health/Timeout filters, plus 1-step Create, Edit, Enable/Disable toggle, and Delete).
- **Live Stats & Zero-Reload Runtime**: Real-time metrics (`/v3/info`, `/v3/services/haproxy/runtime/info`, `/v3/services/haproxy/stats/native`), live backend server controls (`ready`, `drain`, `maint`, `weight` `0..256`, transient server add/remove), Runtime Maps (`force_sync` to disk), and Stick Table inspection.
- **Structured Configuration & Transactions**: Manage Frontends, Binds (including TLS termination), ACL definitions, `use_backend` switching rules, HTTP Request rules, Backends, and permanent Backend Servers — either applied directly with optimistic `version` locking or staged inside atomic Data Plane API Transactions (`/v3/services/haproxy/transactions`).
- **Transactions & Reload History**: Commit/discard transactions and inspect HAProxy reload output/errors (`/v3/services/haproxy/reloads`) without SSH access.
- **Versions, Visual Diff, Cross-Server Drift & Audit Trail**: Automatic and manual `haproxy.cfg` revision snapshots (retained per node), line-numbered visual diff (Revision vs Live / Revision, plus Live Server A vs Server B drift comparison), 1-click syntax-validated rollback, and full operator audit trail.
- **Raw `haproxy.cfg` Editor & Multi-Server Sync**: View/edit raw `haproxy.cfg` (`text/plain` with automatic syntax validation by Data Plane API) and push configurations across multiple HAProxy servers in one batch.
- **SSL Certificates, Maps & Storage**: Upload, replace, delete, and batch-sync `.pem` SSL bundles (`/v3/services/haproxy/storage/ssl_certificates`), managed `.map` files, and general files (`503.http`, Lua scripts) on remote HAProxy disks over HTTP(S).

## ACL Snippets

- `pm.plugin-haproxy-dataplane.access`: Display HAProxy Data Plane in Plugin Settings.
- `pm.plugin-haproxy-dataplane.read`: View Fleet Overview, Live Stats, Configuration, Reloads, Raw Config (read-only), and Storage metadata.
- `pm.plugin-haproxy-dataplane.runtime`: Execute runtime server/map operations (`ready`, `drain`, `maint`, `weight`, runtime maps).
- `pm.plugin-haproxy-dataplane.config`: Modify structured configuration (Frontends, Binds, ACLs, Routing, Backends, Servers) and Transactions.
- `pm.plugin-haproxy-dataplane.raw-config` *(High privilege)*: Push raw `haproxy.cfg` to single or multiple servers.
- `pm.plugin-haproxy-dataplane.storage` *(High privilege)*: Upload, replace, sync, and delete SSL `.pem` certificates, map files, and general storage files.
- `pm.plugin-haproxy-dataplane.connections` *(High privilege)*: Manage Data Plane API v3 server connections.
- `pm.plugin-haproxy-dataplane`: Full administrative access across all HAProxy Data Plane actions.
