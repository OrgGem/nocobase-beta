import { Plugin } from '@nocobase/server';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { VietnamRegionInterface } from './interfaces/vietnam-region-interface';
import { importVietnamRegions } from './importer';
import { registerVietnamRegionImportCommand } from './commands/import-regions';

export class PluginFieldVietnamRegionServer extends Plugin {
  async load() {
    // Framework loadCollections() mis-resolves basePath under VITEST (symlink-prefix check), so register from __dirname (src or dist).
    const collectionsDirectory = resolve(__dirname, 'collections');
    if (!this.db.hasCollection('vietnamRegions') && existsSync(collectionsDirectory)) {
      await this.db.import({ directory: collectionsDirectory, from: this.options.packageName });
    }

    this.app.acl.allow('vietnamRegions', 'list', 'loggedIn');
    this.app.acl.appendStrategyResource('vietnamRegions');

    this.app.resourceManager.use(async function restrictVietnamRegionToReadOnly(ctx, next) {
      const { resourceName, actionName } = ctx.action.params;
      if (resourceName === 'vietnamRegions' && actionName !== 'list') {
        ctx.throw(404, 'Not Found');
      } else {
        await next();
      }
    });

    this.app.db.interfaceManager.registerInterfaceType('vietnamRegion', VietnamRegionInterface);

    registerVietnamRegionImportCommand(this.app);
  }

  async install() {
    await this.importSeedData();
  }

  private async importSeedData() {
    const seedPath = resolve(__dirname, 'data-templates/vietnam-seed.json');
    try {
      if (!existsSync(seedPath)) {
        return;
      }
      const content = readFileSync(seedPath, 'utf-8');
      const result = await importVietnamRegions({
        db: this.db,
        content,
        format: 'json',
      });
      this.log.info(
        `Vietnam regions seeded: inserted=${result.inserted} updated=${result.updated} unchanged=${result.unchanged}`,
      );
    } catch (err) {
      this.log.warn(`Vietnam regions seed skipped: ${(err as Error).message}`);
    }
  }
}

export default PluginFieldVietnamRegionServer;
