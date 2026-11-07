import { defineConfig } from '@nocobase/test/vitest.mjs';
const config = defineConfig();
config.test.include = ['packages/plugins/plugin-startup-guardian/src/server/__tests__/**/*.test.ts'];
export default config;
