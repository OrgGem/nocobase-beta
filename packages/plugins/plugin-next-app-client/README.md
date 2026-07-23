# plugin-next-app-client

## Overview
Provides a full desktop-like NocoBase experience under `/hub/:appPath` with its own route collection, ACL permissions, and menu management.

## Features
- **Independent Routing**: A separate frontend shell running on `/hub`; legacy `/next-app/*` URLs redirect to Hub.
- **Desktop UI UX**: Optimized layout for desktop applications, distinct from the standard NocoBase mobile/web hybrid view.
- **Isolated ACL**: Define different roles and menu structures specifically for the Next App interface.

## Usage
1. Enable the plugin.
2. Create an app path in the plugin settings, then navigate to `/hub/<appPath>`.
3. Use the specific Next App UI editor to customize menus, routes, and blocks.
4. Assign permissions for users to access this specific application interface.
