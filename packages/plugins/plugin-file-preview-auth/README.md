# plugin-file-preview-auth

## Overview
Preview PDF, image, and text files with Bearer token authentication via blob URLs.

## Features
- **Secure Previews**: Prevents unauthorized access to sensitive attachments.
- **Blob URL Generation**: Creates short-lived, authenticated URLs for rendering documents in the browser.
- **Cross-Component Support**: Works seamlessly with tables, forms, and the AI chat interface.

## Usage
1. Enable the plugin.
2. Ensure your NocoBase roles are correctly configured for the `attachments` collection.
3. When users click on a file thumbnail in any NocoBase interface, the system securely fetches the file using their current session token and opens it in the secure previewer.
