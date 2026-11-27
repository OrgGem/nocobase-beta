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
  name: 'doc_understanding_operations',
  title: 'Document Understanding Operations',
  fields: [
    { type: 'string', name: 'operationId', unique: true, length: 64 },
    { type: 'string', name: 'tenantId', length: 100, defaultValue: 'default' },
    { type: 'string', name: 'businessId', length: 100 },
    { type: 'string', name: 'businessVersion', length: 32 },
    { type: 'string', name: 'action', length: 100 },
    { type: 'string', name: 'variant', length: 100 },
    { type: 'string', name: 'state', length: 32, defaultValue: 'ACCEPTED' },
    { type: 'integer', name: 'stateVersion', defaultValue: 1 },
    { type: 'string', name: 'correlationId', length: 128 },
    { type: 'string', name: 'clientReference', length: 255 },
    { type: 'string', name: 'idempotencyKey', length: 200 },
    { type: 'string', name: 'requestFingerprint', length: 64 },
    { type: 'json', name: 'submission' },
    { type: 'json', name: 'progress' },
    { type: 'json', name: 'waitState' },
    { type: 'json', name: 'documentInputPlan' },
    { type: 'json', name: 'documentInputCoverage' },
    { type: 'json', name: 'resultEnvelope' },
    { type: 'json', name: 'outputPayload' },
    { type: 'json', name: 'usage' },
    { type: 'json', name: 'warnings' },
    { type: 'json', name: 'errorProblem' },
    { type: 'string', name: 'externalOperationId', length: 128 },
    { type: 'date', name: 'deadlineAt' },
    { type: 'date', name: 'completedAt' },
    { type: 'string', name: 'ownedBy', length: 255 },
    { type: 'date', name: 'leaseExpiresAt' },
    {
      type: 'belongsTo',
      name: 'createdBy',
      target: 'users',
      foreignKey: 'createdById',
    },
  ],
  indexes: [
    { fields: ['tenantId', 'state'] },
    { fields: ['tenantId', 'businessId', 'action'] },
    { fields: ['tenantId', 'idempotencyKey'] },
    { fields: ['leaseExpiresAt'] },
  ],
} as CollectionOptions;
