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

In the v2 data source form, turn off **Load all collections** and select only the tables or views
you need. The selection is saved with the data source and only those collections are introspected
when it loads. Loading the table picker is deferred until it is opened and its results are reused
until connection settings change.

Discovery includes tables and views in the configured SQL Server schema (`dbo` when omitted).
Adding tables through `dataSources:loadTables` also saves them in an explicit selection.

Existing sources created before selected collections were persisted keep their previous load-all
behavior, even if **Load all collections** was turned off. Reopen the v2 data source settings,
choose the required collections, and save to activate selected loading. An explicitly saved empty
selection loads no collections. Enabled data sources still connect when the NocoBase server starts;
this setting does not defer the data source connection itself.

The legacy v1 settings form is not covered by this selection workflow: its existing Ant Design form
does not use the Formily form contract supplied by the v1 data source manager.
