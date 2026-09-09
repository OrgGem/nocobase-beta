/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Migration } from '@nocobase/server';

/**
 * The AI API gateway no longer bypasses permission checks for any role, root and admin
 * included: every role needs an enabled aiApiRolePermissions row. Existing deployments
 * rely on root's and admin's implicit access, so seed both rows here — otherwise every
 * root/admin API key would start failing with 403 right after the upgrade.
 * Rows an admin already created are left untouched.
 */
export default class SeedDefaultRolePermissions extends Migration {
  // afterSync: aiApiRolePermissions must be registered and synced before we write to it.
  on = 'afterSync' as const;

  async up() {
    const collection = this.db.getCollection('aiApiRolePermissions');
    if (!collection || !(await collection.existsInDb())) return;

    const repository = this.db.getRepository('aiApiRolePermissions');
    const rolesToSeed = [
      { roleName: 'root', enabled: true, allowAllEmployees: true, allowedEmployees: [] },
      { roleName: 'admin', enabled: true, allowAllEmployees: true, allowedEmployees: [] },
    ];
    for (const values of rolesToSeed) {
      const existing = await repository.findOne({ filter: { roleName: values.roleName } });
      if (existing) continue;
      await repository.create({ values });
      this.app.logger.info(
        `[ai-api] Seeded aiApiRolePermissions for role ${values.roleName} (the built-in bypass was removed).`,
      );
    }
  }

  async down() {
    // Keep the rows on rollback: deleting them would lock root/admin out of the gateway,
    // and the rows are harmless for older code paths that bypass the check anyway.
  }
}
