#!/usr/bin/env node
'use strict';

const { startupGuardianCli } = require('../dist/server/cli.js');

async function main() {
  process.exitCode = await startupGuardianCli(process.argv.slice(2));
}

if (typeof startupGuardianCli !== 'function') {
  process.stderr.write('Startup Guardian CLI is missing from the built server bundle. Rebuild the plugin package.\n');
  process.exitCode = 2;
} else {
  main().catch(() => {
    process.stderr.write('Startup Guardian CLI failed unexpectedly.\n');
    process.exitCode = 2;
  });
}
