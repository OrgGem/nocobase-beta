// SPDX-License-Identifier: Apache-2.0

import { Migration } from '@nocobase/server';
import { vpbankDark, vpbankLight } from '../builtinThemes';

const MIGRATION_ENTRIES = [
  { legacyUid: 'nocobase_studio', seed: vpbankLight },
  { legacyUid: 'nocobase_studio_dark', seed: vpbankDark },
];

export default class RenameStudioToVPBankThemes extends Migration {
  on = 'afterLoad' as const;

  async up() {
    const collection = this.db.getCollection('antdStyleThemeConfig');
    if (!collection || !(await collection.existsInDb())) {
      return;
    }

    const themeRepo = this.db.getRepository('antdStyleThemeConfig');
    if (!themeRepo) {
      return;
    }

    let hasDefault = (await themeRepo.count({ filter: { default: true } })) > 0;

    for (const { legacyUid, seed } of MIGRATION_ENTRIES) {
      const target = await themeRepo.findOne({ filter: { uid: seed.uid } });
      const legacy = await themeRepo.findOne({ filter: { uid: legacyUid } });

      if (legacy && !target) {
        await legacy.update({
          uid: seed.uid,
          config: seed.config,
          isBuiltIn: true,
        });
        continue;
      }

      if (legacy && target) {
        if (legacy.get('default') && !target.get('default')) {
          await target.update({ default: true });
        }
        await legacy.destroy();
        continue;
      }

      if (!target) {
        const shouldBeDefault = !hasDefault && Boolean(seed.default);
        if (shouldBeDefault) {
          hasDefault = true;
        }

        try {
          await themeRepo.create({
            values: {
              ...seed,
              default: shouldBeDefault,
            },
          });
        } catch (err) {
          if (err instanceof Error && err.name === 'SequelizeUniqueConstraintError') {
            continue;
          }
          throw err;
        }
      }
    }
  }
}
