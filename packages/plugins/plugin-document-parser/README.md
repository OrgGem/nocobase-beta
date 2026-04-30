# plugin-document-parser

## Overview
Intercept and route AI chat file attachments through configurable internal or external OCR/parse providers.

## Features
- **Pluggable Parsers**: Route documents to MarkItDown, Unstructured.io, DocPixie, or custom OCR engines.
- **Format Normalization**: Standardizes diverse file types into clean Markdown for LLM consumption.
- **Pipeline Management**: Handle caching, error recovery, and parsing statuses.

## Usage
1. Enable the plugin.
2. Go to Document Parser Settings.
3. Configure your preferred parsing engine for specific file types (e.g., use MarkItDown for Office files, DocPixie for PDFs).
4. Whenever a user uploads a file in the AI chat, it will automatically pass through this pipeline.
