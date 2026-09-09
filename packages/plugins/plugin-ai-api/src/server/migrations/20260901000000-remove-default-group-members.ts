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
 * The default usage group is a pure fallback: users with no aiApiGroupMembers row
 * resolve to it automatically at runtime. Earlier migrations (legacy quota-policy
 * backfill and group-delete reassignment) wrote explicit member rows pointing at
 * the default group. Those rows are redundant, hide users from the "unassigned"
 * filter, and can no longer be created through the guarded create path. Drop them
 * so the default group holds no explicit members.
 */
export default class RemoveDefaultGroupMembers extends Migration {
  // afterSync: aiApiGroupMembers / aiApiUsageGroups must be registered and synced.
  on = 'afterSync' as const;

  async up() {
    const groupCollection = this.db.getCollection('aiApiUsageGroups');
    const memberCollection = this.db.getCollection('aiApiGroupMembers');
    if (!groupCollection || !memberCollection) return;
    if (!(await groupCollection.existsInDb()) || !(await memberCollection.existsInDb())) return;

    const defaultGroup = await this.db.getRepository('aiApiUsageGroups').findOne({
      filter: { isDefault: true },
    });
    if (!defaultGroup) return;

    const groupId = defaultGroup.get('id');
    // Destroy one by one so per-row destroy events fire; member counts here are small.
    const members = await this.db.getRepository('aiApiGroupMembers').find({
      filter: { groupId },
    });
    for (const member of members) {
      await this.db.getRepository('aiApiGroupMembers').destroy({ filterByTk: member.get('id') });
    }

    if (members.length) {
      this.app.logger.info(
        `[ai-api] Removed ${members.length} explicit member row(s) from the default usage group; those users now fall back to it implicitly.`,
      );
    }
  }

  async down() {
    // Irreversible: the dropped rows carried no extra data, and re-adding them would
    // re-introduce the inconsistency this migration removes. Users still resolve to
    // the default group implicitly, so behaviour is unchanged.
  }
}
