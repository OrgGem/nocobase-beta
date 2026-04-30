# plugin-document-understanding

## Overview
Provides advanced document understanding and structured data extraction capabilities.

## Features
- **Schema-Based Extraction**: Define a NocoBase collection, and the AI will extract data from documents to fill the fields.
- **Batch Processing**: Process multiple documents in an automated workflow.
- **Human-in-the-loop**: UI to review and approve extracted fields before committing to the database.

## Usage
1. Enable the plugin.
2. Create a collection (e.g., "Invoices" with fields: Total, Date, Vendor).
3. Set up a Document Understanding task linked to this collection.
4. Upload documents.
5. The system will extract the data. Review the pending records in the UI and click "Approve" to save them.
