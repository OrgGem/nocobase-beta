/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'doc_understanding_config',
  title: 'Document Understanding Config',
  fields: [
    { type: 'string', name: 'baseUrl', length: 500 },
    { type: 'string', name: 'authType', length: 20 },
    { type: 'string', name: 'authKey', length: 500 },
    { type: 'string', name: 'authHeaderName', length: 100 },
    { type: 'integer', name: 'defaultTimeout', defaultValue: 30000 },
    { type: 'integer', name: 'defaultRetries', defaultValue: 2 },
    { type: 'integer', name: 'pollInterval', defaultValue: 5000 },
    { type: 'integer', name: 'pollTimeout', defaultValue: 300000 },
    { type: 'string', name: 'webhookSecret', length: 500 },
    { type: 'string', name: 'engineMode', length: 30, defaultValue: 'builtin' },
    { type: 'string', name: 'llmService', length: 120 },
    { type: 'string', name: 'llmModel', length: 120 },
    { type: 'string', name: 'visionLlmService', length: 120 },
    { type: 'string', name: 'visionLlmModel', length: 120 },
    { type: 'integer', name: 'maxFileSizeBytes', defaultValue: 10485760 },
    { type: 'integer', name: 'maxFilesPerRequest', defaultValue: 20 },
    { type: 'boolean', name: 'publicGatewayEnabled', defaultValue: true },
  ],
} as CollectionOptions;
