// SPDX-License-Identifier: Apache-2.0

import { Migration } from '@nocobase/server';
import { vpbankDark, vpbankLight } from '../builtinThemes';

const STUDIO_THEMES = [vpbankLight, vpbankDark];

export default class SeedNocoBaseStudioThemes extends Migration {
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
    for (const item of STUDIO_THEMES) {
      const existing = await themeRepo.findOne({ filter: { uid: item.uid } });
      if (existing) {
        continue;
      }

      const shouldBeDefault = !hasDefault && Boolean(item.default);
      if (shouldBeDefault) {
        hasDefault = true;
      }

      try {
        await themeRepo.create({
          values: {
            ...item,
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
