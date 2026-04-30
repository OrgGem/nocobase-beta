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
