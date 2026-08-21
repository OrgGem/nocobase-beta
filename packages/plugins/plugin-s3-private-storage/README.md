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

## Credential Modes

The plugin supports three ways to authenticate with S3:

1. **Static credentials** — set `AccessKey ID` and `AccessKey Secret` in the storage options.
2. **IAM role / default credential chain** — leave both `AccessKey ID` and `AccessKey Secret`
   blank. The AWS SDK resolves credentials from the environment, shared config files, ECS
   container metadata, or the EC2 instance profile. This works when the NocoBase server runs
   on an EC2 instance whose IAM role already grants S3 access (e.g. the bucket is in the same
   account).
3. **Assume role (STS)** — set `Role ARN` (optionally with `Role Session Name` and `External ID`)
   in the storage options. The plugin calls `sts:AssumeRole` using either the static credentials
   or the default credential chain as the base. Use this for cross-account access or when the
   instance role must be exchanged for a more specific role.

## Rate Limiting

The private stream endpoint (`/api/attachments:stream`) is protected by an in-memory
sliding-window rate limiter (120 requests per user per minute by default). Root role is exempt.

Configure via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `S3_PRIVATE_STREAM_RATE_LIMIT_ENABLED` | `true` | Set to `false`/`0` to disable |
| `S3_PRIVATE_STREAM_RATE_LIMIT_MAX` | `120` | Max requests per window |
| `S3_PRIVATE_STREAM_RATE_LIMIT_WINDOW_MS` | `60000` | Window length in milliseconds |

When the limit is hit the server responds `429 Too Many Requests` with a `Retry-After` header.

> Note: the limiter is in-memory and per-process. For multi-instance deployments, replace it
> with a shared store such as Redis.
