# plugin-document-understanding

## Overview

`plugin-document-understanding` (`v2.0.0`) provides an asynchronous **Document Understanding Service, Public API Gateway, and Pipeline Orchestrator** directly inside NocoBase, compatible with the `du-rework` specification.

It runs document parsing, OCR/Vision, structured extraction, compliance/risk analysis, comparison, and domain workflows natively using NocoBase's isolated document loader (`@nocobase/ai`) and LLM services (`@nocobase/plugin-ai`), while also supporting optional API delegation to an external `du-rework` orchestrator or custom HTTP endpoints.

## Key Capabilities

- **Public `du-rework` API Gateway (`/api/du/v1/*` & `/api/v1/*`)**:
  - 2-step Upload Gateway (`POST /uploads` -> `PUT /uploads/{artifactId}/content` with `x-content-sha256` verification & `Idempotency-Key` replay).
  - Canonical action execution (`POST /businesses/{businessId}/actions/{action}`) with `Idempotency-Key` conflict detection (`409`), `documentSelection` page-range planning & `documentInputCoverage` (DI-06), and `application/problem+json` error envelopes.
  - 12-state Operation lifecycle (`GET /operations`, `GET /operations/{id}?wait=`, `POST .../cancel`, `POST .../resume` with CAS `expectedStateVersion`, `GET .../result` `ResultEnvelope`, `GET /artifacts/{id}/download`, `GET /usage/summary` & `/usage/events`).
  - Legacy compatibility facade (`POST /docs/{action}` & `POST /docs/workflows`).
  - Multi-tenant SHA-256 `x-api-key` issuance & revocation with fail-closed `404` tenant isolation and outbound HMAC `x-du-signature` webhooks.
- **Built-in Business Engine (36 Profiles)**:
  - **`document-core@2.0.0`**: 6 core actions / 31 variants (`ingest`, `extract`, `analyze`, `transform`, `generate`, `compare`) + 3 workflows (`disbursement`, `doc-compare`, `schema-workflow`).
  - **`lc-checker@1.2.0`**: 5-step Trade Finance L/C examination against versioned UCP 600 / ISBP 821 rules (`ucp600-isbp821-v1`) with mandatory rule citations and `humanSignOffRequired`.
  - **`example-review@1.0.0`**: Multi-document compliance review with optional HITL approval.
- **Ecosystem Integrations**:
  - **NocoBase Workflow Node (`document-understanding`)** for both modern (`client-v2`) and legacy (`client`) workflow canvases.
  - **Dynamic AI Tools (`@nocobase/plugin-ai`)** exposing enabled pipelines with typed JSON Schemas and page selection.
