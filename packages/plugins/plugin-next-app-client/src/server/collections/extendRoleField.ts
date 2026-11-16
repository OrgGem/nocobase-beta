// SPDX-License-Identifier: Apache-2.0

import { extendCollection } from '@nocobase/database';

export default extendCollection({
  name: 'roles',
  fields: [
    {
      type: 'belongsToMany',
      name: 'nextAppRoutes',
      target: 'nextAppRoutes',
      through: 'rolesNextAppRoutes',
      onDelete: 'CASCADE',
    },
    {
      type: 'boolean',
      name: 'allowNewNextAppMenu',
    },
  ],
});
