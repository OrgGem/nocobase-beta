# plugin-block-cross-join

## Overview
Create a block that joins and displays data from multiple collections across different datasources in a single unified table.

## Features
- **Cross-Datasource Joins**: Combine data from PostgreSQL, MSSQL, MySQL, etc., into one view.
- **Unified Table Block**: Displays joined records as a standard NocoBase table with sorting and filtering.
- **Virtual Relationships**: Define join conditions directly in the block configuration without altering database schemas.

## Usage
1. Activate the plugin in the Plugin Manager.
2. On any page, click "Add Block" -> "Cross-Join Table".
3. Select the primary collection.
4. Click "Add Join" to select secondary collections (even from other datasources).
5. Map the foreign keys / relationship fields.
6. Configure the visible columns from both collections.
