# Changelog

## [2.0.0]

- Targets NocoBase 2.2.x with both legacy client (v1) and FlowEngine client (v2) data source settings and collection management.
- Introspects external PostgreSQL tables, views, and materialized views with schema selection, batched identity/relkind metadata queries, and partial table selection (`selectedCollections` / `loadTables`).
- Manages physical PostgreSQL tables, columns, unique indexes, and foreign keys within transactions using advisory locks, synchronized across HA instances via `syncMessageManager`.
- Provides read-only SQL collections validated by PostgreSQL-aware lexical checking and executed inside `READ ONLY` transactions, plus transactional adjacency-list tree collections with recursive CTE cycle detection and tree queries.
