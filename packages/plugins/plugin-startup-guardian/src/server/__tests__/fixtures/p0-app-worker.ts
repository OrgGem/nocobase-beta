/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mockServer } from '@nocobase/test';
import PluginStartupGuardianServer from '../../plugin';

const appId = process.env.STARTUP_GUARDIAN_APP_ID || 'main';
const stateDirectory = process.env.STARTUP_GUARDIAN_STATE_DIR || '';
const bootId = process.env.STARTUP_GUARDIAN_BOOT_ID || 'unknown-boot';
const stopSignal = new Promise<void>((resolve) => process.once('SIGTERM', resolve));

async function main(): Promise<void> {
  const app = mockServer({
    name: appId,
    database: {
      dialect: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_DATABASE,
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      schema: process.env.DB_SCHEMA,
      tablePrefix: process.env.DB_TABLE_PREFIX,
      logging: false,
    },
    resourcer: { prefix: '/api' },
    plugins: [[PluginStartupGuardianServer, { name: 'plugin-startup-guardian', enabled: true, isPreset: true }]],
  });
  try {
    await app.load();
    await app.start();
    app.log.info('P0 second process loaded plugins', {
      plugins: [...app.pm.getPlugins().values()].map((plugin) => ({
        name: plugin.name,
        packageName: plugin.options?.packageName,
        enabled: plugin.enabled,
      })),
    });
    const missingPlugin = !app.pm.get('p0-fault');
    const pmResourceDefined = app.resourcer.isDefined('pm');
    const pluginRows = await app.pm.repository.find({ filter: { name: 'p0-fault' } });
    const agent = app.agent();
    const v1Response = await agent.resource('pm').listEnabled();
    const v2Response = await agent.resource('pm').listEnabledV2();
    const v1Data: unknown = v1Response.body?.data;
    const v2Data: unknown = v2Response.body?.data;
    const proof = {
      appLoaded: true,
      appStarted: true,
      pid: process.pid,
      pmResourceDefined,
      appHasFaultInstance: !missingPlugin,
      faultRowEnabled: pluginRows[0]?.get('enabled') ?? null,
      v1Status: v1Response.status,
      v1DataIsArray: Array.isArray(v1Data),
      v1ContainsFault: JSON.stringify(v1Data).includes('plugin-p0-fault'),
      v2Status: v2Response.status,
      v2DataIsArray: Array.isArray(v2Data),
      v2ContainsFault: JSON.stringify(v2Data).includes('plugin-p0-fault'),
    };
    const serializedProof = `${JSON.stringify(proof, null, 2)}\n`;
    await writeFile(join(stateDirectory, 'p0-second-app-proof.json'), serializedProof, 'utf8');
    await writeFile(join(stateDirectory, `p0-second-app-proof-${bootId}.json`), serializedProof, 'utf8');
    await writeFile(
      join(stateDirectory, `p0-second-app-proof-${bootId}.json`),
      `${JSON.stringify(proof, null, 2)}\n`,
      'utf8',
    );
    await waitForStopSignal();
  } catch (error) {
    if (process.send) {
      await new Promise<void>((resolve, reject) => {
        process.send?.(
          { type: 'p0-app-load-rejected', message: error instanceof Error ? error.message : 'unknown' },
          (sendError) => (sendError ? reject(sendError) : resolve()),
        );
      });
    }
    await waitForStopSignal();
  } finally {
    await app.destroy();
  }
}

function waitForStopSignal(): Promise<void> {
  return stopSignal;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
