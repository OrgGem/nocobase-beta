import { defineConfig } from '@nocobase/build';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

export default defineConfig({
  modifyTsupConfig: (config) => {
    config.external = [...(config.external || []), 'playwright-core'];
    return config;
  },
  afterBuild: async (log) => {
    log('Copying playwright-core into dist to avoid ncc bundling issues...');
    log('Copying playwright-core into dist to avoid ncc bundling issues...');
    const srcDir = path.join(__dirname, 'node_modules', 'playwright-core');
    const rootSrcDir = path.join(__dirname, '..', '..', '..', 'node_modules', 'playwright-core');
    const destDir = path.join(__dirname, 'dist', 'node_modules', 'playwright-core');
    
    // Always remove whatever ncc generated and overwrite with the clean directory
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }

    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, destDir, { recursive: true });
      log('Copied from local node_modules');
    } else if (fs.existsSync(rootSrcDir)) {
      fs.cpSync(rootSrcDir, destDir, { recursive: true });
      log('Copied from root node_modules');
    } else {
      log('WARNING: Could not find playwright-core to copy!');
    }
  }
});
