# Carbone Template Manager

Manage document templates rendered by an **external Carbone.io service**.

## Features

- **Template management** — upload `.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp`; CRUD metadata; per-role ACL.
- **Auto placeholder extraction** — parse `{d.xxx}` Carbone tags to a JSON schema (loops, formatters, complement scope).
- **Versioning + rollback** — every upload creates a new version; one-click rollback; schema diff between versions.
- **Test playground** — JSON editor + sample-data generator; preview rendered file inline.
- **Render API** — `POST /api/carboneTemplates:renderById` and `:renderDirect`; output to PDF / DOCX / XLSX / HTML / ODT / TXT / CSV / JPG / PNG.
- **MD5 cache** — keyed on `templateId | versionId | input | format`; output stored via `plugin-file-manager` (any registered storage: local, S3, SFTP, OSS …).
- **Monitoring dashboard** — call count, latency p95, cache hit ratio, error rate, replay logs.
- **Workflow integration** — `carbone-render` instruction for `plugin-workflow`.

## Architecture

```
NocoBase ◄──HTTP──► Carbone.io container (Docker / k8s)
   │                    │
   ├ stores templateId  │ stores actual template files (SHA-256 keyed)
   ├ versions metadata  │ renders documents
   └ render logs/cache  │ converts to PDF via LibreOffice
```

The actual binary template lives **inside Carbone**; NocoBase stores only the
SHA-256 `carboneTemplateId` plus a backup copy of the original file via
`plugin-file-manager` (so rollback works even if Carbone evicts the template).

## Carbone deployment

A ready-to-use service block has been added to:

- `docker/production-ha/docker-compose.yml` — service name **`carbone`**, port `4000`.
- `k8s/production-ha/nocobase-ha.yaml` — Deployment + Service + PVC + Secret keys.

Image: [`carbone/carbone-ee`](https://hub.docker.com/r/carbone/carbone-ee) (free tier when no license is provided).

After the container is up, open *Plugin Settings → Carbone Template Manager*
and set:

| Field | Default |
| --- | --- |
| Endpoint | `http://carbone:4000` (Docker) / `http://carbone.nocobase.svc.cluster.local:4000` (k8s) |
| API Token | from `CARBONE_EE_STUDIO_TOKEN` env var |
| Carbone version | `4` |
| Output / Cache / Backup storage | choose any registered storage from `plugin-file-manager` |

Click **Test connection** to verify.

## ACL snippets

| Snippet | Grants |
| --- | --- |
| `pm.plugin-carbone-template-manager.templates` | template CRUD + upload + parse + download |
| `pm.plugin-carbone-template-manager.render`    | `renderById`, `renderDirect`, `test` |
| `pm.plugin-carbone-template-manager.versions`  | list / rollback / diff schema |
| `pm.plugin-carbone-template-manager.monitoring`| logs / cache management |
| `pm.plugin-carbone-template-manager.settings`  | endpoint, token, storage selectors |

Granular per-template permission is achieved through standard NocoBase
collection-level data scopes on `carboneTemplates`.

## License

Apache-2.0.
