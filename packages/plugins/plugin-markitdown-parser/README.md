# plugin-markitdown-parser

## Overview
Convert attachments to Markdown with Microsoft MarkItDown and register as a Document Parser internal handler.

## Features
- **Microsoft MarkItDown**: Utilizes the powerful MarkItDown engine for highly accurate document conversions.
- **Format Support**: Excellent handling of `.docx`, `.xlsx`, `.pptx`, and `.pdf` files.
- **Pipeline Integration**: Acts as a parsing engine for `plugin-document-parser`.

## Usage
*This is a background processing plugin.*
1. Enable the plugin.
2. Navigate to Document Parser settings.
3. Select "MarkItDown" as the preferred engine for Office documents.
4. When files are uploaded to the Knowledge Base or AI chat, they will be efficiently converted to clean Markdown.
