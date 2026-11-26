/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { DEFAULT_TIMEOUT_MS, PORTAINER_INSTANCES_COLLECTION } from './constants';

export const portainerInstancesCollection = {
  name: PORTAINER_INSTANCES_COLLECTION,
  title: 'Portainer Instances',
  hidden: true,
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    { name: 'name', type: 'string' },
    { name: 'baseUrl', type: 'string' },
    { name: 'apiKey', type: 'text' },
    { name: 'gitUsername', type: 'string' },
    { name: 'gitAccessToken', type: 'text' },
    { name: 'gitCredentialId', type: 'integer' },
    { name: 'allowInsecureTls', type: 'boolean', defaultValue: false },
    { name: 'defaultTimeoutMs', type: 'integer', defaultValue: DEFAULT_TIMEOUT_MS },
    { name: 'isDefault', type: 'boolean', defaultValue: false },
    { name: 'enabled', type: 'boolean', defaultValue: true },
    { name: 'lastHealthStatus', type: 'string' },
    { name: 'lastVersion', type: 'string' },
    { name: 'lastCheckedAt', type: 'date' },
  ],
};
