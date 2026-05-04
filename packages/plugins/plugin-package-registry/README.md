# plugin-package-registry

## Overview
Provides a package registry functionality for managing plugin and artifact distributions.

## Features
- **Local NPM Registry**: Host and manage private NocoBase plugins without a third-party registry.
- **Proxy Cache Registry**: Configure a registry as `type=proxy` with an `upstreamUrl`; cache misses are fetched from the upstream registry and stored locally before being served.
- **Version Control**: Track versions, dependencies, and tarball artifacts for custom plugins.
- **One-Click Install**: Enables downloading and installing plugins directly from this registry into other NocoBase instances.

## Usage
1. Enable the plugin on your "hub" NocoBase instance.
2. Go to Package Registry settings to view hosted packages.
3. Use the API or CLI to publish new `.tgz` plugin builds to this registry.
4. On client NocoBase instances, configure this URL as the source to install plugins.

## Proxy cache
Create a `packageRegistries` record with:

- `name`: local registry name, for example `internal`
- `type`: `proxy`
- `format`: `npm`
- `upstreamUrl`: upstream npm registry URL, for example `https://registry.npmjs.org`

Use the local registry URL as the npm registry source:

```bash
yarn nocobase pm add <package-name> --registry=https://<host>/api/package-registry/npm/internal
```

On a cache miss, metadata and tarballs are fetched from `upstreamUrl`, saved under `storage/package-registry/npm/internal`, and then served from the local registry.
