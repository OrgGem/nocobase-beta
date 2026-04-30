# plugin-s3-private-storage

## Overview
Extends file-manager to stream files from private S3 buckets via server proxy with ACL support.

## Features
- **Secure Proxied Streaming**: Files are streamed through the NocoBase server, never exposing the raw S3 bucket URL to the client.
- **Private Buckets**: Works with fully locked-down AWS S3, MinIO, or Cloudflare R2 buckets.
- **ACL Enforcement**: Ensures users only download files they have permission to access.

## Usage
1. Enable the plugin.
2. Navigate to File Manager -> Storage providers.
3. Add a new "S3 (Private Proxy)" storage.
4. Enter your S3 credentials, Bucket name, and Region.
5. All files uploaded to this storage will be secured and proxied automatically.
