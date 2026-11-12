# plugin-knowledge-base

## Overview
Provides Knowledge Base management, Vector Store, Vector Database (PGVector), and RAG retrieval capabilities for AI Employees.

## Features
- **Vector Database**: Native integration with PGVector for storing embeddings.
- **Document Ingestion**: Upload documents, which are automatically chunked and embedded.
- **RAG Engine**: Retrieves semantically relevant context for AI prompts.
- **Chunk Management**: View, edit, or delete specific vector chunks in the UI.

## Usage
1. Enable the plugin.
2. Create a new "Knowledge Base" (e.g., "Company Policies").
3. Upload documents or sync collections.
4. Go to AI Employee settings, assign the Knowledge Base to the agent.
5. The agent will now query this base before answering questions.

## Vector index lifecycle and existing data

Run `yarn nocobase upgrade` before enabling this version so the index lifecycle columns are available. Existing chunks without an `indexRevision` remain searchable only when their document still exists, belongs to that knowledge base, is not deleted, and has no active index revision. Documents with missing or mismatched ownership metadata are excluded. Nothing automatically removes all legacy vectors. Reprocess documents in batches to create a current revision; check the new results before continuing. A file whose source was previously deleted must be uploaded again before it can be reprocessed. Once a replacement is complete, its former legacy chunks are retired for incremental cleanup.

A reprocess stages a separate revision and retains the previously active revision until the replacement is complete. A failed or superseded worker cannot activate its revision. A deleted document is excluded from search immediately, including cached results, while a tombstone retains its non-secret cleanup route. Deleting a knowledge base detaches those tombstones before deleting the knowledge base. The existing retry job revisits retired revisions in bounded batches and deletes only the matching knowledge base, document and revision. Cleanup depends on the vector database being available; the SQL state and external vector database do not share an atomic transaction.

Retired revision identifiers and tombstones are retained for repeated cleanup because a delayed worker can write after an earlier cleanup pass. `indexCleanupPending` remains true while a full pass has not succeeded. Once cleanup has been confirmed, an administrator can remove or reconfigure the vector database; if an old worker later writes and crashes after that configuration is removed, physical orphan vectors may require manual cleanup, but they remain excluded from plugin search. Administrators should monitor pending cleanup and investigate unavailable or changed vector database endpoints before removing their configuration. Do not manually remove tombstones while old workers may still write.

Deleting a document or knowledge base also succeeds when no vector store is configured. New documents that have never started vectorization require no cleanup. For older documents whose original vector database can no longer be identified, a tombstone remains pending manual investigation; the plugin will not guess a database to delete from. Inspect deleted records with `indexCleanupPending` set and a missing `indexCleanupRoute`, then use the original backend's own tools to verify or remove matching vectors. Do not clear this state until the original destination and scope are established.

Documents wait in the pending state until their knowledge base has a vector store and database; background recovery resumes them after configuration. PostgreSQL cleanup resolves the configured table using PostgreSQL's identifier rules, including unquoted case folding and schema-qualified or quoted names. A confirmed absent table or collection needs no deletion; permission, network and other errors leave cleanup pending for investigation.

The vector database's provider, endpoint and table or collection cannot be changed while it is used by live documents or has pending cleanup. To move data, create a separate vector database and reindex documents into it; connection credentials and display details can still be updated without changing the physical destination. Automatic source-file deletion uses the file manager's storage adapter only after verifying the uploader owns the file, the revision is still current, and no other live knowledge-base document references the file; otherwise the file is retained.
