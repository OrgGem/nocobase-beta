/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export const PLUGIN_NAMESPACE = 'plugin-workflow-portainer';
export const PORTAINER_INSTANCES_COLLECTION = 'portainerInstances';
export const PORTAINER_RESOURCE = 'portainerWorkflow';
export const PORTAINER_ACL_SNIPPET = 'pm.plugin-workflow-portainer';

export const INSTRUCTION_GROUP_KEY = 'portainer';

export const INSTRUCTION_TYPES = {
  redeploy: 'portainer-stack-redeploy',
  control: 'portainer-stack-control',
} as const;

export const SECRET_MASK = '••••••••';
export const DEFAULT_TIMEOUT_MS = 600_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 3_600_000;
