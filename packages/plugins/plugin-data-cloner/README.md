# plugin-data-cloner

## Overview
Gradually clone data from one MSSQL datasource to another.

## Features
- **Incremental Sync**: Clone large datasets in batches to avoid locking or overloading the database.
- **Datasource Mapping**: Map source collections from one MSSQL database to a target MSSQL database.
- **Job Tracking**: Monitor the progress, success rate, and errors of cloning operations.

## Usage
1. Activate the plugin.
2. Ensure you have at least two MSSQL datasources configured in NocoBase.
3. Navigate to the Data Cloner management page.
4. Create a new Clone Job: select source, target, and the collections to map.
5. Start the job and monitor its progress in the built-in UI.
