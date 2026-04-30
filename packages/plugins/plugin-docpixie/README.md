# plugin-docpixie

## Overview
Adaptive RAG agent for document analysis - OCR + LLM Vision + structured extraction.

## Features
- **Advanced Document Processing**: Uses visual LLMs to understand complex document layouts (tables, images, charts).
- **Adaptive Chunking**: Intelligently chunks documents based on semantic structure rather than just token count.
- **Structured Extraction**: Can pull specific JSON schemas directly from scanned PDFs or images.

## Usage
1. Enable the plugin.
2. When creating an AI Employee or Knowledge Base ingestion pipeline, select DocPixie as the extraction engine.
3. Upload complex documents (PDFs, images).
4. The agent will process them, maintaining spatial and structural context for better RAG answers.
