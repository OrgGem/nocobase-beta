# plugin-external-storage-manager

## Overview
Unified file browser for external storage backends (S3, SFTP) with virtual directory mapping, per-directory ACL, and streaming data transfer.

## Features
- **Virtual Directory Tree**: Map S3 prefixes or SFTP paths to a logical folder structure within NocoBase.
- **Role-Based Access**: Define granular read/write/delete permissions per directory for different user roles.
- **Stream Upload/Download**: Safely transfer large files without overloading server memory.

## Usage
1. Enable the plugin.
2. In the "File Manager" module, configure your External Storage provider.
3. Define the directory structure you want to expose.
4. Assign permissions to these directories in the Role Management settings.
5. Users can now browse, upload, and download files through the UI as if they were local.

## Permissions and safety

- The External Storage role tab manages simple directory ID lists in the main data source's role permissions. A complex or unrestricted scope, or access inherited from a role strategy, is read-only in this tab. Manage those permissions using the standard role data permissions UI.
- Existing records found only in the legacy `rolesResources` tables are also read-only here. Review the role's current effective permissions and configure the intended permissions for `externalStorageDirectories` in the main data source's standard role data permissions UI; this plugin does not automatically import or delete legacy ACL records.
- File write and delete permissions do not authorize creating, changing, or deleting directory mappings. Mapping management requires the External Storage directory settings permission.
- The mapped directory root cannot be deleted through the file browser. Deletion also checks that the requested type matches the stored entry.
- Inline responses are limited to common raster images, audio, and video. Other formats, including HTML, SVG, and PDF, are downloaded as attachments; responses also use `nosniff` and a sandbox content security policy.
