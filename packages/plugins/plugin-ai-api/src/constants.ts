/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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

/**
 * Child snippet for the per-user LLM permission surface, deliberately separate from
 * AI_API_ACL_SNIPPET so granting someone the gateway settings does not also let them
 * hand out model access. Same `plugin-ai-api` prefix constraint as above applies.
 */
export const AI_API_USER_PERMISSIONS_SNIPPET = 'pm.plugin-ai-api.user-permissions';
