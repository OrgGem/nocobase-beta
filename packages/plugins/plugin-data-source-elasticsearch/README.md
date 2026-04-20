# Data Source: Elasticsearch

Connect NocoBase to Elasticsearch servers and browse indices as collections with full CRUD support.

## Features

- **Index as Collection** — Each Elasticsearch index is automatically mapped to a NocoBase collection
- **Field Type Mapping** — ES field types (text, keyword, integer, date, boolean, etc.) are mapped to NocoBase field types
- **Full CRUD** — Browse, create, update, and delete documents directly from NocoBase UI
- **Flexible Authentication** — Supports Basic auth (username/password) and API Key authentication
- **TLS Support** — Works with self-signed certificates
- **Index Filtering** — Use glob patterns (e.g. `logs-*`) to load only specific indices

## Configuration

| Field | Description | Required |
|---|---|---|
| **Elasticsearch Nodes** | Comma-separated node URLs (e.g. `http://localhost:9200`) | ✅ |
| **Username** | Basic auth username | ❌ |
| **Password** | Basic auth password | ❌ |
| **API Key** | Alternative to username/password | ❌ |
| **Verify TLS Certificate** | Uncheck for self-signed certs | ❌ |
| **Index Pattern** | Filter indices by glob (e.g. `logs-*`, `my-data-*`) | ❌ |

## Installation

```bash
yarn pm add plugin-data-source-elasticsearch
yarn pm enable plugin-data-source-elasticsearch
```

## Usage

1. Go to **Settings → Data sources**
2. Click **Add new** and select **Elasticsearch**
3. Enter your Elasticsearch node URL and authentication details
4. Click **Test connection** to verify
5. Save — all matching indices will be loaded as collections
6. Browse index data through the standard NocoBase collection interface
