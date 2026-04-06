/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { VectorDatabaseFeature, VectorDatabaseInfo } from '@nocobase/plugin-ai/server';
import type PluginKnowledgeBaseServer from '../plugin';

export class VectorDatabaseFeatureImpl implements VectorDatabaseFeature {
  constructor(private plugin: PluginKnowledgeBaseServer) {}

  async getVectorDatabaseInfo(id: string): Promise<VectorDatabaseInfo> {
    const repo = this.plugin.db.getRepository('aiVectorDatabases');
    const record = await repo.findOne({
      filter: { id },
    });

    if (!record) {
      throw new Error(`Vector database with id "${id}" not found`);
    }

    const data = record.toJSON();
    return {
      id: data.id,
      name: data.name,
      databaseSpec: data.provider,
      provider: data.provider,
      connectProps: data.connectParams,
      enabled: data.enabled,
    };
  }

  async listVectorDatabasesInfo(): Promise<VectorDatabaseInfo[]> {
    const repo = this.plugin.db.getRepository('aiVectorDatabases');
    const records = await repo.find({
      filter: { enabled: true },
    });

    return records.map((record: any) => {
      const data = record.toJSON();
      return {
        id: data.id,
        name: data.name,
        databaseSpec: data.provider,
        provider: data.provider,
        connectProps: data.connectParams,
        enabled: data.enabled,
      };
    });
  }
}
