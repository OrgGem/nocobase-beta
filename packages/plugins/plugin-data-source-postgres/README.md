# External PostgreSQL data source

Version 2.0.1 targets NocoBase 2.2.x and provides configuration for both the v1 and v2 clients. Enable the Data Source Manager and this plugin, then add an external PostgreSQL connection in Data Source Manager.

The connection form accepts a PostgreSQL schema and can load all collections or selected tables and views. Loading a table or view registers its schema for use in NocoBase without changing the PostgreSQL object. Existing datasource configurations keep the `postgres-external` type.

When SSL is enabled, the connection verifies the PostgreSQL server certificate. Supply a CA certificate in PEM format when the server certificate uses a private CA.

Deleting a collection through the plugin deletes the corresponding PostgreSQL table or view. The cascade option defaults to off, so PostgreSQL rejects deletion when dependent objects exist. Selecting cascade also drops dependent objects. SQL collections and imported views are read-only for record operations.
