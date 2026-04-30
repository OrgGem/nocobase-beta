# plugin-sftp-private-storage

## Overview
Provides SFTP connection management and file operations for external storage integration.

## Features
- **SFTP Integration**: Connects NocoBase to any standard SFTP server.
- **Secure File Transfer**: Encrypts file transfers in transit.
- **File Manager Provider**: Acts as a storage provider backend for the `plugin-external-storage-manager`.

## Usage
1. Enable the plugin.
2. Go to File Manager -> Storage providers.
3. Add a new "SFTP Storage" provider.
4. Input your SFTP host, port, username, and password/private key.
5. Use the external storage manager to browse and upload files directly to your SFTP server.
