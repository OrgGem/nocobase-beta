# plugin-package-registry

## Overview
Provides a package registry functionality for managing plugin and artifact distributions.

## Features
- **Local NPM Registry**: Host and manage private NocoBase plugins without a third-party registry.
- **Version Control**: Track versions, dependencies, and tarball artifacts for custom plugins.
- **One-Click Install**: Enables downloading and installing plugins directly from this registry into other NocoBase instances.

## Usage
1. Enable the plugin on your "hub" NocoBase instance.
2. Go to Package Registry settings to view hosted packages.
3. Use the API or CLI to publish new `.tgz` plugin builds to this registry.
4. On client NocoBase instances, configure this URL as the source to install plugins.
