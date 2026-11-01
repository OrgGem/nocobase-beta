/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'desktopRoutePathAliases',
  dataCategory: 'system',
  dumpRules: 'required',
  migrationRules: ['overwrite', 'schema-only'],
  indexes: [
    {
      name: 'desktop_route_path_aliases_route_id',
      fields: ['desktopRouteId'],
      unique: true,
    },
    {
      name: 'desktop_route_path_aliases_alias',
      fields: ['pathAlias'],
      unique: true,
    },
  ],
  fields: [
    {
      type: 'bigInt',
      name: 'id',
      primaryKey: true,
      autoIncrement: true,
    },
    {
      name: 'desktopRoute',
      type: 'belongsTo',
      target: 'desktopRoutes',
      targetKey: 'id',
      foreignKey: 'desktopRouteId',
      onDelete: 'CASCADE',
    },
    {
      name: 'pathAlias',
      type: 'string',
      length: 100,
      allowNull: false,
    },
  ],
});
