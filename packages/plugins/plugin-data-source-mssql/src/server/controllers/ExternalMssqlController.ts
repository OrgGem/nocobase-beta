/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import { MssqlExternalDataSource } from '../data-source/MssqlExternalDataSource';

export class ExternalMssqlController {
  async testConnection(ctx: Context) {
    const payload = ctx.action?.params?.values || ctx.request.body || {};
    const options = payload.options || payload;

    try {
      await MssqlExternalDataSource.testConnection(options);
      ctx.body = { status: 'success' };
    } catch (error) {
      ctx.status = 400;
      ctx.body = { status: 'error', message: error.message };
    }
  }
}

export default ExternalMssqlController;
