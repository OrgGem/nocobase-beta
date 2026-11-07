#!/usr/bin/env node
'use strict';

const { generateAppDir, initEnv } = require('@nocobase/cli-v1');

initEnv();
generateAppDir();

const appEntry = require.resolve('@nocobase/app');
const appArgs = process.argv.slice(2);
if (appArgs[0] && appArgs[0] !== 'start' && !appArgs[0].startsWith('-')) {
  throw new Error('The Startup Guardian child bootstrap only accepts the NocoBase start command');
}
if (appArgs[0] !== 'start') appArgs.unshift('start');
process.argv.splice(0, process.argv.length, process.execPath, appEntry, ...appArgs);
require(appEntry);
