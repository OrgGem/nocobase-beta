/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { defineCollection } from '@nocobase/database';

/**
 * Virtual model aliases (e.g. "auto") that the gateway resolves to a concrete
 * LLM model based on the request shape and the caller's access scope.
 *
 * The per-capability lists are ordered: the resolver walks them top-down and
 * picks the FIRST model the current user is permitted to use. A list left empty
 * is derived from aiApiModelMetadata (capability flags + sortOrder). When no
 * candidate is usable, `fallbackModel` is used when it is also permitted for
 * the caller. An alias never widens the caller's model access.
 */
export default defineCollection({
  name: 'aiApiVirtualModels',
  autoGenId: true,
  fields: [
    {
      name: 'name',
      type: 'string',
      unique: true,
      allowNull: false,
      comment: 'Alias the client passes as the model id, e.g. "auto".',
    },
    {
      name: 'mode',
      type: 'string',
      defaultValue: 'chat',
      comment: 'Endpoint family this alias serves: chat | embedding.',
    },
    {
      name: 'fallbackModel',
      type: 'string',
      allowNull: false,
      comment:
        'Concrete "service/modelId" used when no capability bucket candidate is usable and fallback is permitted.',
    },
    {
      name: 'visionModels',
      type: 'json',
      defaultValue: [],
      comment: 'Ordered "service/modelId" list for vision requests.',
    },
    { name: 'toolModels', type: 'json', defaultValue: [], comment: 'Ordered list for tool-calling requests.' },
    { name: 'reasoningModels', type: 'json', defaultValue: [], comment: 'Ordered list for reasoning-tier requests.' },
    { name: 'cheapModels', type: 'json', defaultValue: [], comment: 'Ordered list for cheap-tier requests.' },
    { name: 'generalModels', type: 'json', defaultValue: [], comment: 'Ordered list for general requests.' },
    { name: 'enabled', type: 'boolean', defaultValue: true, index: true },
  ],
});
