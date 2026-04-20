# plugin-data-source-mssql

External MSSQL (Microsoft SQL Server) data source plugin for NocoBase 2.x.

## Features

### 🔌 External Data Source Integration
- Connect to external Microsoft SQL Server databases as a NocoBase data source
- Extends `SequelizeDataSource` — fully integrated with the core persistence pipeline
- Collections are **persisted** across app restarts via `dataSourcesCollections` metadata table
- Support for multiple schemas and table prefix filtering

### 📊 Collection Management
- **Automatic Introspection**: Discover all tables from the external database via `readTables()`
- **Selective Loading**: Choose specific tables to import via `loadTables()`
- **Field Type Mapping**: MSSQL types automatically mapped to NocoBase field types
- **Primary Key Detection**: Auto-detects PKs via Sequelize + fallback `sys.indexes` query

### ⚡ Performance Optimizations
- **Query timeout**: `requestTimeout` set to 120s (tedious default was 15s)
- **Connection pool**: `max: 10`, `min: 2` warm connections, `acquire: 60s`
- **Simple pagination**: Skips expensive `COUNT(*)` on large tables — uses `LIMIT+1` instead
- **SET NOCOUNT ON**: Reduces per-statement overhead
- **Cursor-based pagination**: `MssqlSmartCursorBuilder` for efficient large dataset queries (avoids `OFFSET/FETCH` degradation)
- All timeouts and pool settings are user-overridable via data source configuration

### 🗄️ Data Type Mapping

| MSSQL Type | NocoBase Type | UI Component |
|------------|---------------|--------------|
| `int`, `bigint`, `smallint`, `tinyint` | integer / bigInt | InputNumber |
| `decimal`, `numeric`, `money` | decimal | InputNumber |
| `float`, `real` | float | InputNumber |
| `varchar`, `nvarchar`, `char`, `nchar` | string | Input |
| `text`, `ntext` | text | Input.TextArea |
| `bit` | boolean | Checkbox |
| `date` | dateOnly | DatePicker |
| `time` | time | TimePicker |
| `datetime`, `datetime2`, `smalldatetime` | datetimeNoTz | DatePicker |
| `datetimeoffset` | datetimeTz | DatePicker |
| `uniqueidentifier` | uuid | Input |

### 🕐 DateTime Handling
- Automatic conversion of JavaScript `Date` objects to MSSQL-compatible format
- `beforeFind`/`beforeCount` hooks transform date values in WHERE clauses
- Preserves Sequelize operator symbols (`Op.and`, `Op.like`, etc.) using `Reflect.ownKeys()`

### 🔒 Security
- Encrypted connection support (`encrypt` option)
- Configurable connection pooling
- Secure credential handling

## Architecture

```
plugin-data-source-mssql/
├── src/server/
│   ├── plugin.ts                    # Plugin registration + destroy middleware
│   ├── data-source/
│   │   ├── MssqlExternalDataSource.ts   # Main class (extends SequelizeDataSource)
│   │   ├── MssqlIntrospector.ts         # MSSQL-specific DatabaseIntrospector
│   │   ├── MssqlCollectionManager.ts    # Collection manager with MSSQL repo
│   │   ├── MssqlRepository.ts           # Repository with cursor pagination
│   │   └── MssqlSmartCursorBuilder.ts   # Cursor-based query builder
│   ├── controllers/
│   │   └── ExternalMssqlController.ts   # testConnection API
│   └── dialects/
│       └── mssql-dialect.ts             # MSSQL dialect registration
├── src/client/
│   └── ...                              # Configuration UI components
└── scripts/
    └── copy-tedious.js                  # Embeds tedious + deps into dist/
```

## Configuration

```typescript
interface MssqlDataSourceOptions {
  host: string;           // Server hostname
  port?: number;          // Port (default: 1433)
  database: string;       // Database name
  username: string;       // SQL Server username
  password: string;       // Password
  schema?: string;        // Default schema (default: 'dbo')
  encrypt?: boolean;      // Use encrypted connection
  tablePrefix?: string;   // Table name prefix filter
  dialectOptions?: {      // Additional Tedious driver options
    options?: {
      trustServerCertificate?: boolean;
      enableArithAbort?: boolean;
      requestTimeout?: number;    // Query timeout ms (default: 120000)
      connectTimeout?: number;    // Connection timeout ms (default: 30000)
    };
  };
  pool?: {                // Connection pool settings
    max?: number;         // Max connections (default: 10)
    min?: number;         // Min connections (default: 2)
    acquire?: number;     // Acquire timeout ms (default: 60000)
    idle?: number;        // Idle timeout ms (default: 10000)
  };
}
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /api/external-mssql:testConnection` | Test MSSQL connection |
| `GET /api/dataSources.collections:list` | List loaded collections |
| Standard CRUD via data source routing | `list`, `get`, `create`, `update`, `destroy` |

## Requirements

- NocoBase >= 2.0.0
- Microsoft SQL Server 2012 or later
- Node.js >= 18

## Installation

```bash
# From tgz file
yarn pm add ./plugin-data-source-mssql-2.0.1.tgz

# Enable the plugin
yarn pm enable plugin-data-source-mssql
```

## Changelog

### 2.0.1
- **Fix**: Filter not working on MSSQL collections (Sequelize Op symbols dropped by `Object.entries`)
- **Perf**: Increased `requestTimeout` to 120s (was 15s tedious default)
- **Perf**: Connection pool tuned (max: 10, min: 2)
- **Perf**: `simplePaginate` enabled by default — skips `COUNT(*)` on large tables
- **Perf**: `SET NOCOUNT ON` hook for reduced overhead

### 2.0.0
- Refactored to extend `SequelizeDataSource` for core persistence pipeline integration
- Added `MssqlIntrospector` for MSSQL-specific field type mapping
- Collections now persist across app restarts
- Updated peerDependencies to NocoBase 2.x
- License changed to MIT

## License

MIT
