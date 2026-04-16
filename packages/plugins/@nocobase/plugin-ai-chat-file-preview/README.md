# plugin-ai-chat-file-preview

Enhances the NocoBase AI Employee chat interface by providing a seamless, in-browser popup preview for uploaded file attachments.

## Features

- **Instant File Preview**: Click on any document, image, or spreadsheet attachment in the AI chat window to open a rich modal preview instantly, without navigating away or opening a new tab.
- **Smart Client-side Caching**: Leverages IndexedDB to cache files locally as soon as they are fetched or uploaded, dramatically improving load times and reducing server bandwidth for subsequent previews.
- **Multi-format Support**: 
  - **PDF**: Native browser iframe rendering
  - **Images**: PNG, JPG, GIF, WebP, SVG, BMP
  - **Text**: TXT, CSV, HTML, JSON, XML, YAML, MD
  - **Documents**: Word (.docx) via `docx-preview`
  - **Spreadsheets**: Excel (.xlsx, .xls) via `xlsx`
- **Zero Configuration**: 100% plug-and-play. Hooks directly into the existing NocoBase AI chat system using non-intrusive DOM event interception and global React Providers.
- **Graceful Fallback**: Automatically provides a secure download link containing the proper Bearer Token for un-previewable formats.

## Installation

You can install this plugin in your NocoBase project via the Plugin Manager:

```bash
yarn pm add plugin-ai-chat-file-preview
yarn pm enable plugin-ai-chat-file-preview
```

*(If utilizing the `.tgz` package directly offline, place it in the application or upload it via UI)*

## Technical Details

- **No Core Modifications**: This plugin relies on catching global DOM click events targeted at `.ant-attachments-file-card` components rendered by `@ant-design/x`, avoiding any necessity to modify the core `@nocobase/plugin-ai`.
- **Session Continuity**: Hooks into the Axios instance to track NocoBase's `sessionId`, ensuring that files are grouped naturally and their Blob caches are completely cleared when a conversation is destroyed.

## Usage

Simply enable the plugin. Once activated:
1. Open the **AI Chat** panel on any page.
2. Drag and drop, or select a file to upload.
3. Once the file appears as a chip in the chat, click it!
4. The file will pop up in a gorgeous, centered overlay window.

## License

Apache-2.0
