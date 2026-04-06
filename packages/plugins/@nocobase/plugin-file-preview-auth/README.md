# Authenticated File Previewer

NocoBase plugin for previewing files with **Bearer token authentication**. Solves the problem where default preview components fail to load files from storage that requires authentication.

## Features

### Supported File Types

| Type | Extensions | Preview Method |
|------|-----------|---------------|
| **PDF** | `.pdf` | Rendered in `<iframe>` via authenticated blob URL |
| **Images** | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` `.bmp` | Rendered in `<img>` via authenticated blob URL |
| **Text** | `.txt` `.csv` `.json` `.xml` `.yaml` `.yml` `.xaml` `.html` `.css` `.js` `.log` `.md` | Fetched as text, displayed in formatted `<pre>` block |
| **Word** | `.docx` | Rendered using [docx-preview](https://github.com/VolodymyrBayworker/docx-preview) (bundled) |
| **Excel** | `.xlsx` `.xls` | Rendered as HTML table using [SheetJS](https://sheetjs.com/) (bundled) with multi-sheet tabs |

All other file types show a download prompt with authenticated download.

### Authentication Flow

1. File URL is resolved from the attachment/file record
2. File is fetched from server with `Authorization: Bearer <token>` header
3. Response is converted to a Blob (binary) or text
4. Content is rendered client-side — no unauthenticated requests are made

### File Manager Integration

The plugin registers handlers in both NocoBase preview registries:

- **`attachmentFileTypes`** — Intercepts all file clicks in Upload/Attachment fields
- **`filePreviewTypes`** — Handles previews in File Manager plugin

### Additional Features

- **Authenticated download** — Download button in preview modal also uses Bearer token
- **Multi-sheet support** — Excel files with multiple sheets display tabs for navigation
- **Code-split bundles** — DOCX and XLSX libraries are lazy-loaded only when needed
- **i18n** — English, Vietnamese, Chinese translations included
- **Zero server-side processing** — All preview rendering happens in the browser

## Installation

```bash
# From .tgz file
yarn pm add /path/to/plugin-file-preview-auth-1.1.0.tgz
yarn pm enable plugin-file-preview-auth
```

## Compatibility

- NocoBase **2.x**
- Requires `plugin-file-manager` to be enabled

## Changelog

### v1.1.0
- Added DOCX preview (docx-preview, bundled)
- Added XLSX/XLS preview with multi-sheet tabs (SheetJS, bundled)
- Added YAML, YML, XAML to text preview
- Libraries are code-split and lazy-loaded

### v1.0.1
- Initial release
- PDF, Image, and Text preview with Bearer token auth
- Authenticated download for all file types
