# plugin-ai-chat-file-preview

## Overview
NocoBase AI Assistant file preview plugin supporting Word, Excel, PDF, CSV, and S3 authentication.

## Features
- **Multi-format Support**: Preview formats provided by the enabled File Manager previewers.
- **Secure Access**: Install and enable `plugin-file-preview-auth` to use its authenticated previewers for private files, including private S3 files. It also provides Word and Excel previewers.
- **AI Chat Integration**: Allows users to preview attachments uploaded during AI conversations without downloading them.

## Usage
1. Ensure the plugin is activated in the NocoBase Plugin Manager.
2. In the AI Chat interface, upload a supported document.
3. Click on the document thumbnail or link within the chat.
4. A modal or inline viewer will render the document content securely.
