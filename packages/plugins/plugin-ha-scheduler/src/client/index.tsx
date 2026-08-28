/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/client';

// Server-only plugin — no client-side functionality needed.
// Empty plugin class exported to satisfy PluginManager's constructor check.
export class PluginHaSchedulerClient extends Plugin {
  async load() {}
}

export default PluginHaSchedulerClient;
