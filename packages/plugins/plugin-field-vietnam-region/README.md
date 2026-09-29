# plugin-field-vietnam-region

Custom NocoBase plugin providing the **`vietnamRegion`** collection field type: a cascader for selecting Vietnamese administrative divisions, backed by a `vietnamRegions` collection stored locally. The data model follows Vietnam's post-2025 two-level structure: **Province/TP -> Commune/Ward**.

> Modeled after `@nocobase/plugin-field-china-region`. The collection, field interface, ACL guard, cascader client (v1 and v2), filter and display models all follow that plugin's architecture.

## Features

- **Field type `vietnamRegion`** — a cascader that lazy-loads provinces at level 1, then communes under the selected province.
- **`vietnamRegions` collection** — self-referencing tree (`code` PK, `name`, `level`, `parentCode`). Read-only for end users: the server blocks every action other than `list`.
- **Dual-stack client** — supports both legacy v1 (`@nocobase/client`) and v2 (`@nocobase/client-v2` + FlowEngine), registered via `EditableItemModel` / `FilterableItemModel` / `DisplayItemModel`.
- **Data import via CLI** — `yarn nocobase vietnam-region import <file>` accepts **CSV, XLSX or JSON**.
- **i18n** — `en-US`, `vi-VN`, `zh-CN` bundled.

## How the data works

The `VietnamRegionInterface` (server) supports:

- `toString(value)` — joins selected node names by `/` for the persisted string form.
- `toValue(str, ctx)` — resolves a `/`-joined name string back to an ordered array of `code` for filter use; throws if any name does not exist.

The client cascader always loads level-1 rows first and lazy-loads children by `parentCode`.

## Import command

```bash
# Parse and report only — does not write to DB
yarn nocobase vietnam-region import ./data.csv --dry-run

# Apply changes (upsert by code, keeps existing data not present in the file)
yarn nocobase vietnam-region import ./data.csv

# Wipe existing regions before importing
yarn nocobase vietnam-region import ./data.csv --clear

# Use a specific xlsx sheet / force format
yarn nocobase vietnam-region import ./regions.xlsx --sheet Sheet1 --format xlsx
```

Supported formats are auto-detected from the file extension. Override with `--format json|csv|xlsx`.

## Data templates (under `src/server/data-templates/`)

Three sample shapes are provided; pick whichever fits your workflow. All resolve into the same internal `province -> commune` tree before being upserted.

### 1. Flat 3-column CSV / Excel (`vietnam-template.csv`)

| Column             | Required | Notes                                       |
| ------------------ | -------- | ------------------------------------------- |
| `province`         | yes      | Province/city name                          |
| `province_code`    | optional | If missing, a sequential code is generated  |
| `commune`          | yes      | Commune/ward name                           |
| `commune_code`     | optional |                                             |

Header names are matched case-insensitively and accept common Vietnamese synonyms (`tinh`, `tp`, `xaphuong`, `phuong`, `xa`, ...).

### 2. Flat JSON array (`vietnam-seed.json` shape)

```json
[
  { "code": "79", "name": "TP. Hồ Chí Minh", "level": 1 },
  { "code": "27031", "name": "Phường Bến Nghé", "level": 2, "parentCode": "79" }
]
```

### 3. Nested JSON map

```json
{
  "Hà Nội": ["Phường A", "Xã B"],
  "Đà Nẵng": ["Phường Hải Châu"]
}
```

A province is identified by its top-level key, its children by the array of commune names. No codes are stored in this shape — the importer will generate sequential codes prefixed with `VN` / `C`.

## Seeding on install

`PluginFieldVietnamRegionServer.install()` reads `data-templates/vietnam-seed.json` and runs it through the importer. Replace that file with a full dataset and reinstall (or run the CLI command above) to refresh the database.

The seed file currently holds a small sample (HCMC, Hà Nội, Đà Nẵng with a handful of communes). For a complete post-2025 list (~3,321 communes across 34 provinces/cities), replace the JSON or feed a CSV from the official government source and run the import command.

## Plugin structure

```
src/
├── index.ts                  # server barrel
├── server/
│   ├── plugin.ts             # PluginFieldVietnamRegionServer
│   ├── collections/
│   │   └── vietnamRegions.ts
│   ├── interfaces/
│   │   └── vietnam-region-interface.ts
│   ├── importer/             # csv / json / xlsx parser + upsert
│   ├── commands/
│   │   └── import-regions.ts # `yarn nocobase vietnam-region import`
│   └── data-templates/       # sample data files
├── client/                   # v1 SchemaComponent runtime
├── client-v2/                # FlowEngine runtime
└── locale/                   # en-US / vi-VN / zh-CN
```

## Build & pack (Windows note)

Per team rules, prefer PowerShell for plugin build on Windows:

```powershell
yarn nocobase build plugin-field-vietnam-region --no-dts
Set-Location packages/plugins/plugin-field-vietnam-region
npm pack
```
