import { Application } from '@nocobase/server';
import fs from 'fs';
import path from 'path';
import { detectFormat } from '../importer/parser';
import { importFromContent } from '../importer';

export function registerVietnamRegionImportCommand(app: Application) {
  const command = (app.findCommand('vietnam-region') || app.command('vietnam-region')) as ReturnType<
    Application['command']
  >;

  command
    .command('import [file]')
    .description('Import Vietnam administrative divisions from a CSV / Excel / JSON file')
    .option('--format <format>', 'force input format: json | csv | xlsx (auto-detected from file extension by default)')
    .option('--sheet <name>', 'worksheet name for xlsx input')
    .option('--clear', 'truncate existing vietnamRegions before importing')
    .option('--dry-run', 'parse and report only, do not write to the database')
    .action(async (file: string | undefined, options: Record<string, string | boolean | undefined>) => {
      if (!file) {
        console.error('Please provide a file path, e.g. yarn nocobase vietnam-region import ./regions.csv');
        process.exitCode = 1;
        return;
      }

      const abs = path.resolve(process.cwd(), file);
      if (!fs.existsSync(abs)) {
        console.error(`File not found: ${abs}`);
        process.exitCode = 1;
        return;
      }

      const content = fs.readFileSync(abs);
      const format = (typeof options.format === 'string' ? options.format : detectFormat(abs)) as
        | 'json'
        | 'csv'
        | 'xlsx'
        | undefined;
      if (!format) {
        console.error(`Cannot detect import format from "${abs}". Use --format json|csv|xlsx.`);
        process.exitCode = 1;
        return;
      }

      const result = await importFromContent(app.db, content, abs, {
        format,
        table: typeof options.sheet === 'string' ? options.sheet : undefined,
        clearExisting: !!options.clear,
        dryRun: !!options.dryRun,
      });

      console.log(
        JSON.stringify(
          {
            file: abs,
            format,
            dryRun: !!options.dryRun,
            parsed: result.parsed,
            inserted: result.inserted,
            updated: result.updated,
            unchanged: result.unchanged,
            levels: result.levels,
            errors: result.errors,
          },
          null,
          2,
        ),
      );

      if (result.errors.length) {
        process.exitCode = 1;
      }
    });
}
