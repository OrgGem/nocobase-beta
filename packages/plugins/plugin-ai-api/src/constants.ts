// SPDX-License-Identifier: Apache-2.0

/**
 * The single admin snippet the server registers as `pm.${this.name}.configuration`.
 *
 * `this.name` is the plugin's package name with only `@nocobase/plugin-` or
 * `@nocobase/preset-` stripped (see utils/plugin-package `getPluginNameFromPackageName`),
 * so for this unscoped package it stays `plugin-ai-api` — verified against the running
 * app, which reports `name: "plugin-ai-api"`. Spelling it `pm.ai-api.configuration` on the
 * client names a snippet no role can ever hold.
 *
 * Shared by both client runtimes so a rename cannot silently desynchronise them.
 */
export const AI_API_ACL_SNIPPET = 'pm.plugin-ai-api.configuration';
