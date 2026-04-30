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
