# plugin-block-embed-settings

## Overview
Embed compatible plugin settings pages as blocks on regular pages.

## Features
- **Decentralized Admin UI**: Bring admin settings directly to user-facing pages or custom dashboards.
- **Settings compatibility**: Settings components are rendered with an `embedded` prop. A target plugin may need to support this prop or provide an embedded-specific component to remove page layout and avoid dependencies on the native settings route.
- **Role-Based Access**: A viewer must have access to the page, the target settings menu or tab under NocoBase's native ACL, and the plugin must be enabled in the embed allowlist. Target API actions continue to enforce their own permissions and data scopes.

## Usage
1. Activate the plugin.
2. In the plugin settings, add and enable the target plugin in the embed allowlist.
3. Navigate to the page where you want to embed settings.
4. Click "Add Block" -> "Plugin Settings Embed" and select the target plugin and tabs.

An explicitly empty tab selection displays no tabs. Saved tabs that are no longer available or permitted are not replaced with other tabs. The embed allowlist controls the block UI; it is not a substitute for the target plugin's server-side ACL.

The block refreshes its allowlist when this window regains focus and when the allowlist is edited in the same window. It refreshes the settings snapshot when NocoBase performs a role check. Changes made in another session are not pushed to an already open page; API permissions remain enforced by the target plugin.

## Upgrade compatibility

The viewer now reads the minimal enabled-plugin list from `embedSettings:enabled`. Full `embedAllowedPlugins` CRUD requires the plugin's settings permission. Deploy matching client and server builds together; older clients using the previously public `embedAllowedPlugins:list` action may no longer load the viewer list. Existing block schemas and allowlist records are retained.
