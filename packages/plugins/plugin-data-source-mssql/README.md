# plugin-data-source-mssql

## Overview
External MSSQL data source support for NocoBase.

## Features
- **Native Integration**: Connects NocoBase to existing SQL Server / MSSQL databases.
- **Schema Synchronization**: Imports tables and views as NocoBase collections.
- **Full Relationship Support**: Handles foreign keys and relational mappings automatically.

## Usage
1. Enable the plugin.
2. Navigate to `Data Sources` -> `Add Data Source` -> `MSSQL`.
3. Provide host, port, database name, username, and password.
4. Sync the schema. NocoBase will automatically generate interfaces for your legacy MSSQL data.
