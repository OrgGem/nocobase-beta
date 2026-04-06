/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { DataTypes } from '@nocobase/database';
import { Migration } from '@nocobase/server';

/**
 * Adds embedModelId and embedMode columns to ai_knowledge_bases.
 * These support per-KB model selection and client vs server embedding mode.
 */
export default class AddKbEmbedFieldsMigration extends Migration {
  on = 'afterLoad' as const;

  async up() {
    const collection = this.db.getCollection('aiKnowledgeBases');
    if (!collection) return;

    const tableNameWithSchema = collection.getTableNameWithSchema();
    const qi = this.db.sequelize.getQueryInterface();

    // embedModelId — stores the model ID string (e.g. "Xenova/all-MiniLM-L6-v2")
    const embedModelCol = collection.getField('embedModelId');
    if (embedModelCol && !(await embedModelCol.existsInDb())) {
      await qi.addColumn(tableNameWithSchema, embedModelCol.columnName(), {
        type: DataTypes.STRING,
        allowNull: true,
      });
    }

    // embedMode — 'client' (browser ONNX) or 'server' (NocoBase ONNX)
    const embedModeCol = collection.getField('embedMode');
    if (embedModeCol && !(await embedModeCol.existsInDb())) {
      await qi.addColumn(tableNameWithSchema, embedModeCol.columnName(), {
        type: DataTypes.STRING,
        defaultValue: 'client',
        allowNull: false,
      });
    }
  }

  async down() {}
}
