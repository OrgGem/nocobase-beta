// SPDX-License-Identifier: Apache-2.0

import { EXECUTION_STATUS } from '@nocobase/plugin-workflow';
import { createMockServer, sleep, type MockServer } from '@nocobase/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLUGIN_NAME, RCLONE_SNIPPETS, RESOURCE_NAME, SECRET_MASK } from '../../shared/constants';
import PluginRcloneManagerServer from '../plugin';
import { RcloneRcClient } from '../services/rclone-rc-client';

const LIVE_RCD_URL = process.env.RCLONE_E2E_URL || 'http://127.0.0.1:5572';
const LIVE_RCD_USER = process.env.RCLONE_E2E_USER || 'rclone-admin';
const LIVE_RCD_PASS = process.env.RCLONE_E2E_PASS || 'rclone-rc-dev-pass-change-me';
const LIVE_MINIO_INTERNAL_URL = process.env.RCLONE_E2E_MINIO_URL || 'http://minio:9000';
const LIVE_MINIO_ACCESS_KEY = process.env.RCLONE_E2E_MINIO_USER || 'minioadmin';
const LIVE_MINIO_SECRET_KEY = process.env.RCLONE_E2E_MINIO_PASS || 'minio-local-dev-pass-change-me';
const LIVE_BUCKET = process.env.RCLONE_E2E_BUCKET || 'rpa-test-bucket';

async function isLiveRcloneAvailable(): Promise<boolean> {
  try {
    const auth = Buffer.from(`${LIVE_RCD_USER}:${LIVE_RCD_PASS}`).toString('base64');
    const res = await fetch(`${LIVE_RCD_URL}/rc/noopauth`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(2_500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

type MockAgent = ReturnType<MockServer['agent']>;

function getAction(agent: MockAgent, action: string, query?: Record<string, string | number>) {
  const req = agent.get(`/api/${RESOURCE_NAME}:${action}`);
  return query ? req.query(query) : req;
}

function postAction(agent: MockAgent, action: string, values: Record<string, unknown>) {
  return agent.post(`/api/${RESOURCE_NAME}:${action}`).send({ values });
}

describe('End-to-End Integration against Live Docker rclone-rcd + MinIO + NocoBase Workflow', async () => {
  const liveAvailable = await isLiveRcloneAvailable();

  describe.skipIf(!liveAvailable)('Full-stack E2E flow', () => {
    let app: MockServer | undefined;
    let rootAgent: MockAgent;
    let operatorAgent: MockAgent;
    let connectionId = 0;
    const runId = `nb-e2e-${Date.now()}`;
    const dynamicRemoteName = `nb-e2e-s3-${Date.now().toString(36)}`;
    const mountPoint = `/tmp/nb-e2e-mnt-${Date.now().toString(36)}`;
    let originalRawConfig: { content: string; configDisabled: boolean } | null = null;
    const cleanupClient = new RcloneRcClient({
      baseUrl: LIVE_RCD_URL,
      authType: 'basic',
      username: LIVE_RCD_USER,
      password: LIVE_RCD_PASS,
    });

    beforeAll(async () => {
      app = await createMockServer({
        name: 'main',
        acl: true,
        resourcer: { prefix: '/api' },
        database: { dialect: 'sqlite', storage: ':memory:' },
        plugins: [
          'field-sort',
          'system-settings',
          'users',
          'auth',
          'acl',
          'data-source-manager',
          'data-source-main',
          'error-handler',
          'workflow',
          [
            PluginRcloneManagerServer,
            {
              name: PLUGIN_NAME,
              packageName: PLUGIN_NAME,
              enabled: true,
              isPreset: true,
            },
          ],
        ],
      });

      await app.db.getRepository('roles').create({
        values: { name: 'rclone-operator', title: 'Rclone Cloud Operator' },
      });
      const operatorUser = await app.db.getRepository('users').create({
        values: { username: 'rclone-operator', roles: ['rclone-operator'] },
      });

      const operatorRole = app.acl.define({ role: 'rclone-operator' });
      operatorRole.snippets.add(RCLONE_SNIPPETS.access);
      operatorRole.snippets.add(RCLONE_SNIPPETS.read);
      operatorRole.snippets.add(RCLONE_SNIPPETS.transfer);
      operatorRole.snippets.add(RCLONE_SNIPPETS.remotes);

      operatorAgent = await app.agent().login(operatorUser, 'rclone-operator');
      const rootUser = await app.db.getRepository('users').findOne();
      if (!rootUser) {
        throw new Error('Root user not seeded in mock server');
      }
      rootAgent = await app.agent().login(rootUser);
    }, 120_000);

    afterAll(async () => {
      if (liveAvailable) {
        await cleanupClient.unmount(mountPoint).catch(() => {});
        await cleanupClient.purgeDir('/tmp', mountPoint.replace(/^\/tmp\//, '')).catch(() => {});
        await cleanupClient.purgeDir(`minio:${LIVE_BUCKET}`, runId).catch(() => {});
        await cleanupClient.deleteRemote(dynamicRemoteName).catch(() => {});
        await cleanupClient.setOptions({ main: { BwLimit: 'off' } }).catch(() => {});
        if (originalRawConfig && !originalRawConfig.configDisabled) {
          await cleanupClient.writeRawConfigFile(originalRawConfig.content).catch(() => {});
        }
      }
      await app?.destroy();
    }, 60_000);

    it('1. validates draft connection, saves encrypted rclone-rcd connection, and enforces secret redaction', async () => {
      const draftRes = await postAction(rootAgent, 'testConnectionDraft', {
        baseUrl: LIVE_RCD_URL,
        authType: 'basic',
        username: LIVE_RCD_USER,
        password: LIVE_RCD_PASS,
      });
      expect(draftRes.status).toBe(200);
      expect(draftRes.body.data.ok).toBe(true);
      expect(draftRes.body.data.version.version).toMatch(/^v1\./);

      const createRes = await postAction(rootAgent, 'createConnection', {
        name: 'local-docker-rcd',
        title: 'Local Docker Rclone RCD',
        baseUrl: LIVE_RCD_URL,
        authType: 'basic',
        username: LIVE_RCD_USER,
        password: LIVE_RCD_PASS,
        enabled: true,
        checkUsageOnLoad: true,
      });
      expect(createRes.status).toBe(200);
      connectionId = createRes.body.data.id;
      expect(connectionId).toBeGreaterThan(0);
      expect(createRes.body.data.password).toBe(SECRET_MASK);

      // Verify password ciphertext in DB is not plaintext
      if (!app) throw new Error('MockServer not initialized');
      const rawRow = await app.db.getRepository('rcloneConnections').findOne({ filterByTk: connectionId });
      expect(rawRow?.get('password')).not.toBe(LIVE_RCD_PASS);

      // Verify operator role sees connection without baseUrl or username, and cannot create connections
      const opList = await getAction(operatorAgent, 'listConnections');
      expect(opList.status).toBe(200);
      expect(opList.body.data).toHaveLength(1);
      expect(opList.body.data[0].baseUrl).toBe('');
      expect(opList.body.data[0].username).toBeNull();

      const deniedCreate = await postAction(operatorAgent, 'createConnection', {
        name: 'rogue',
        baseUrl: LIVE_RCD_URL,
      });
      expect(deniedCreate.status).toBe(403);
    });

    it('2. enforces local-fs ACL even against alias remotes (workspace: -> /workspace)', async () => {
      const opDash = await getAction(operatorAgent, 'dashboardSummary', { connectionId });
      expect(opDash.status).toBe(200);
      const opRemoteNames = opDash.body.data.remotes.map((r: { name: string }) => r.name);
      expect(opRemoteNames).toContain('minio');
      expect(opRemoteNames).not.toContain('workspace');

      const blockedAlias = await getAction(operatorAgent, 'listFiles', {
        connectionId,
        fs: 'workspace:',
        remote: '',
      });
      expect(blockedAlias.status).toBe(403);

      const blockedColonAlias = await getAction(operatorAgent, 'listFiles', {
        connectionId,
        fs: ':alias,remote=/tmp:',
        remote: '',
      });
      expect(blockedColonAlias.status).toBe(403);

      const blockedWorkspaceCfg = await getAction(operatorAgent, 'getRemoteConfig', {
        connectionId,
        name: 'workspace',
      });
      expect(blockedWorkspaceCfg.status).toBe(403);

      const blockedUpdateAlias = await postAction(operatorAgent, 'updateRemote', {
        connectionId,
        name: 'minio',
        parameters: { remote: '/tmp' },
      });
      expect(blockedUpdateAlias.status).toBe(403);

      const blockedRawLocal = await getAction(operatorAgent, 'listFiles', {
        connectionId,
        fs: '/tmp',
        remote: '',
      });
      expect(blockedRawLocal.status).toBe(403);

      const blockedDisks = await getAction(operatorAgent, 'listDisks', { connectionId });
      expect(blockedDisks.status).toBe(403);

      const adminRemotes = await getAction(rootAgent, 'listRemotes', { connectionId });
      expect(adminRemotes.status).toBe(200);
      const adminRemoteList = adminRemotes.body.data as Array<{ name: string; bucketBased?: boolean }>;
      const adminRemoteNames = adminRemoteList.map((r) => r.name);
      expect(adminRemoteNames).toEqual(expect.arrayContaining(['minio', 'workspace']));
      expect(adminRemoteList.find((r) => r.name === 'minio')?.bucketBased).toBe(true);

      const blockedBucketRootCopy = await postAction(rootAgent, 'triggerTransferWorkflow', {
        connectionId,
        operation: 'operations/copyfile',
        srcFs: 'workspace:',
        srcRemote: 'any.txt',
        dstFs: 'minio:',
        dstRemote: 'any.txt',
      });
      expect(blockedBucketRootCopy.status).toBe(400);
      expect(String(blockedBucketRootCopy.body?.errors?.[0]?.message ?? '')).toMatch(/bucket/i);

      const adminDisks = await getAction(rootAgent, 'listDisks', { connectionId });
      expect(adminDisks.status).toBe(200);
      expect(Array.isArray(adminDisks.body.data)).toBe(true);
      const diskPaths = (adminDisks.body.data as Array<{ path?: string }>).map((d) => d.path);
      expect(diskPaths.length).toBeGreaterThan(0);
      expect(diskPaths.every((p) => typeof p === 'string' && p.length > 0)).toBe(true);
      expect(new Set(diskPaths).size).toBe(diskPaths.length);
      expect(diskPaths).toContain('/');
      // Every returned local disk must actually exist and be listable (no phantom XDG folders)
      for (const diskPath of diskPaths) {
        const diskList = await getAction(rootAgent, 'listFiles', {
          connectionId,
          fs: diskPath,
          remote: '',
        });
        expect(diskList.status).toBe(200);
      }
    });

    it('3. creates, masks, updates (preserving masked secrets), tests, and deletes a live MinIO S3 remote', async () => {
      const providersRes = await getAction(operatorAgent, 'listProviders', { connectionId });
      expect(providersRes.status).toBe(200);
      expect(providersRes.body.data.some((p: { Name: string }) => p.Name === 's3')).toBe(true);

      const createRemoteRes = await postAction(operatorAgent, 'createRemote', {
        connectionId,
        name: dynamicRemoteName,
        type: 's3',
        parameters: {
          provider: 'Minio',
          env_auth: 'false',
          access_key_id: LIVE_MINIO_ACCESS_KEY,
          secret_access_key: LIVE_MINIO_SECRET_KEY,
          endpoint: LIVE_MINIO_INTERNAL_URL,
          region: 'us-east-1',
          force_path_style: 'true',
        },
      });
      expect(createRemoteRes.status).toBe(200);

      const getCfgRes = await getAction(operatorAgent, 'getRemoteConfig', {
        connectionId,
        name: dynamicRemoteName,
      });
      expect(getCfgRes.status).toBe(200);
      expect(getCfgRes.body.data.access_key_id).toBe(SECRET_MASK);
      expect(getCfgRes.body.data.secret_access_key).toBe(SECRET_MASK);

      const updateRes = await postAction(operatorAgent, 'updateRemote', {
        connectionId,
        name: dynamicRemoteName,
        parameters: {
          provider: 'Minio',
          endpoint: LIVE_MINIO_INTERNAL_URL,
          access_key_id: SECRET_MASK,
          secret_access_key: SECRET_MASK,
          region: 'us-east-1',
          force_path_style: 'true',
        },
      });
      expect(updateRes.status).toBe(200);

      const bucketsRes = await getAction(operatorAgent, 'listFiles', {
        connectionId,
        fs: `${dynamicRemoteName}:`,
        remote: '',
      });
      expect(bucketsRes.status).toBe(200);
      expect(bucketsRes.body.data.some((item: { Name: string }) => item.Name === LIVE_BUCKET)).toBe(true);

      const delRes = await postAction(operatorAgent, 'deleteRemote', {
        connectionId,
        name: dynamicRemoteName,
      });
      expect(delRes.status).toBe(200);
    });

    it('4. performs mkdir, streaming multipart upload, in-place rename, and signed chunked download + Range on MinIO', async () => {
      const targetFs = `minio:${LIVE_BUCKET}`;
      const srcDir = `${runId}/src`;

      const mkdirRes = await postAction(operatorAgent, 'mkdir', {
        connectionId,
        fs: targetFs,
        remote: srcDir,
      });
      expect(mkdirRes.status).toBe(200);

      const fileContent = 'Xin chào NocoBase Rclone E2E! Dữ liệu kiểm thử toàn trình trên MinIO S3.';
      const uploadRes = await operatorAgent
        .post(`/api/${RESOURCE_NAME}:uploadFile`)
        .query({ connectionId: String(connectionId), fs: targetFs, remote: srcDir })
        .attach('file', Buffer.from(fileContent, 'utf8'), {
          filename: 'bao-cao-goc.txt',
          contentType: 'text/plain',
        });
      expect(uploadRes.status).toBe(200);

      const renameRes = await postAction(operatorAgent, 'renameItem', {
        connectionId,
        fs: targetFs,
        srcRemote: `${srcDir}/bao-cao-goc.txt`,
        dstRemote: `${srcDir}/Báo cáo E2E 2026.txt`,
        isDir: false,
      });
      expect(renameRes.status).toBe(200);

      const listRes = await getAction(operatorAgent, 'listFiles', {
        connectionId,
        fs: targetFs,
        remote: srcDir,
      });
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.map((f: { Name: string }) => f.Name)).toContain('Báo cáo E2E 2026.txt');

      const signRes = await postAction(operatorAgent, 'signDownload', {
        connectionId,
        fs: targetFs,
        remote: `${srcDir}/Báo cáo E2E 2026.txt`,
        isDir: false,
        mode: 'attachment',
      });
      expect(signRes.status).toBe(200);
      const signedUrl: string = signRes.body.data.url;
      expect(signedUrl).toContain(`/api/${RESOURCE_NAME}:downloadStream?`);

      if (!app) throw new Error('MockServer not initialized');
      const publicAgent = app.agent();
      const fullDownload = await publicAgent.get(signedUrl).buffer(true);
      expect(fullDownload.status).toBe(200);
      expect(fullDownload.headers['content-disposition']).toContain('B%C3%A1o%20c%C3%A1o%20E2E%202026.txt');
      const downloadedBuffer = Buffer.isBuffer(fullDownload.body)
        ? fullDownload.body
        : Buffer.from(fullDownload.text ?? '', 'utf8');
      expect(downloadedBuffer.toString('utf8')).toBe(fileContent);

      // Partial Range request (`bytes=0-7`)
      const expectedSlice = Buffer.from(fileContent, 'utf8').subarray(0, 8);
      const rangeDownload = await publicAgent.get(signedUrl).set('Range', 'bytes=0-7').buffer(true);
      expect(rangeDownload.status).toBe(206);
      expect(rangeDownload.headers['content-range']).toMatch(/^bytes 0-7\/\d+$/);
      const rangeBuffer = Buffer.isBuffer(rangeDownload.body)
        ? rangeDownload.body
        : Buffer.from(rangeDownload.text ?? '', 'utf8');
      expect(rangeBuffer.equals(expectedSlice)).toBe(true);

      // Directory ZIP streaming download directly over port 5572 (zero extra Docker ports!)
      const signDirRes = await postAction(operatorAgent, 'signDownload', {
        connectionId,
        fs: targetFs,
        remote: srcDir,
        isDir: true,
        mode: 'attachment',
      });
      expect(signDirRes.status).toBe(200);
      const zipRes = await publicAgent
        .get(signDirRes.body.data.url)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        });
      expect(zipRes.status).toBe(200);
      expect(zipRes.headers['content-type']).toContain('application/zip');
      const zipBuf = zipRes.body as Buffer;
      // PKZIP Local File Header signature `PK\x03\x04` and End of Central Directory `PK\x05\x06`
      expect(zipBuf.subarray(0, 4).toString('hex')).toBe('504b0304');
      expect(zipBuf.includes(Buffer.from('504b0506', 'hex'))).toBe(true);
      expect(zipBuf.includes(Buffer.from('Báo cáo E2E 2026.txt', 'utf8'))).toBe(true);
      expect(zipBuf.includes(Buffer.from(fileContent, 'utf8'))).toBe(true);
    });

    it('5. dispatches sync/copy through NocoBase Workflow, reconciles async rclone job, resumes workflow, and syncs S3 files', async () => {
      const targetFs = `minio:${LIVE_BUCKET}`;
      const srcDir = `${runId}/src`;
      const dstDir = `${runId}/dst-workflow`;

      const blockedWf = await postAction(operatorAgent, 'triggerTransferWorkflow', {
        connectionId,
        operation: 'sync/copy',
        srcFs: 'workspace:',
        srcRemote: '',
        dstFs: targetFs,
        dstRemote: dstDir,
      });
      expect(blockedWf.status).toBe(403);

      const triggerRes = await postAction(operatorAgent, 'triggerTransferWorkflow', {
        connectionId,
        operation: 'sync/copy',
        srcFs: targetFs,
        srcRemote: srcDir,
        dstFs: targetFs,
        dstRemote: dstDir,
      });
      expect(triggerRes.status).toBe(200);
      const taskId: number = triggerRes.body.data.id;
      expect(taskId).toBeGreaterThan(0);

      let completedTask: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 25; attempt++) {
        await sleep(300);
        const jobsRes = await getAction(operatorAgent, 'listJobs', { connectionId });
        expect(jobsRes.status).toBe(200);
        const match = (jobsRes.body.data as Array<Record<string, unknown>>).find((row) => row.id === taskId);
        if (match && (match.status === 'completed' || match.status === 'failed')) {
          completedTask = match;
          break;
        }
      }

      expect(completedTask).toBeDefined();
      expect(completedTask?.status).toBe('completed');
      expect(completedTask?.progress).toBe(100);
      expect(Number(completedTask?.executionId)).toBeGreaterThan(0);
      expect(Number(completedTask?.rcloneJobId)).toBeGreaterThan(0);

      // Wait briefly for the workflow memory queue to process the resume poke and settle execution status
      if (!app) throw new Error('MockServer not initialized');
      let executionStatus: unknown = null;
      for (let i = 0; i < 20; i++) {
        const execution = await app.db.getRepository('executions').findOne({
          filterByTk: Number(completedTask?.executionId),
        });
        executionStatus = execution?.get('status');
        if (executionStatus === EXECUTION_STATUS.RESOLVED) {
          break;
        }
        await sleep(100);
      }
      expect(executionStatus).toBe(EXECUTION_STATUS.RESOLVED);

      const dstFilesRes = await getAction(operatorAgent, 'listFiles', {
        connectionId,
        fs: targetFs,
        remote: dstDir,
      });
      expect(dstFilesRes.status).toBe(200);
      expect(dstFilesRes.body.data.map((f: { Name: string }) => f.Name)).toContain('Báo cáo E2E 2026.txt');
    });

    it('6. enforces ACL and executes high-privilege runtime tuning, raw-config check, and live protocol serves', async () => {
      const opDeniedOpts = await postAction(operatorAgent, 'setRuntimeOptions', {
        connectionId,
        bwLimit: '10M',
      });
      expect(opDeniedOpts.status).toBe(403);

      const opDeniedServe = await postAction(operatorAgent, 'startServe', {
        connectionId,
        type: 'http',
        fs: `minio:${LIVE_BUCKET}`,
        addr: '127.0.0.1:0',
      });
      expect(opDeniedServe.status).toBe(403);

      const rawCfgRes = await getAction(rootAgent, 'getRawConfig', { connectionId });
      expect(rawCfgRes.status).toBe(200);
      originalRawConfig = {
        content: String(rawCfgRes.body.data.content ?? ''),
        configDisabled: Boolean(rawCfgRes.body.data.configDisabled),
      };

      // When writable RCLONE_CONFIG is active, test live round-trip write & restore of rclone.conf
      if (!originalRawConfig.configDisabled) {
        const marker = `# nocobase-e2e-marker-${runId}\n`;
        const saveRawRes = await postAction(rootAgent, 'saveRawConfig', {
          connectionId,
          content: `${originalRawConfig.content}${marker}`,
        });
        expect(saveRawRes.status).toBe(200);

        const verifyRawRes = await getAction(rootAgent, 'getRawConfig', { connectionId });
        expect(verifyRawRes.status).toBe(200);
        expect(verifyRawRes.body.data.content).toContain(marker.trim());

        const restoreRes = await postAction(rootAgent, 'saveRawConfig', {
          connectionId,
          content: originalRawConfig.content,
        });
        expect(restoreRes.status).toBe(200);
      }

      const setOptsRes = await postAction(rootAgent, 'setRuntimeOptions', {
        connectionId,
        bwLimit: '128M',
      });
      expect(setOptsRes.status).toBe(200);

      const getOptsRes = await getAction(rootAgent, 'getRuntimeOptions', { connectionId });
      expect(getOptsRes.status).toBe(200);
      expect(getOptsRes.body.data.options.bwLimit).toMatch(/^128Mi?$/);

      await postAction(rootAgent, 'setRuntimeOptions', {
        connectionId,
        bwLimit: '',
      });

      const startServeRes = await postAction(rootAgent, 'startServe', {
        connectionId,
        type: 'http',
        fs: `minio:${LIVE_BUCKET}`,
        addr: '127.0.0.1:0',
        readOnly: true,
      });
      expect(startServeRes.status).toBe(200);
      const serveId: string = startServeRes.body.data.id;
      expect(serveId).toBeTruthy();

      const listServesRes = await getAction(rootAgent, 'listServes', { connectionId });
      expect(listServesRes.status).toBe(200);
      expect(listServesRes.body.data.some((s: { id: string }) => s.id === serveId)).toBe(true);

      const stopServeRes = await postAction(rootAgent, 'stopServe', {
        connectionId,
        id: serveId,
      });
      expect(stopServeRes.status).toBe(200);
    });

    it('7. enforces ACL and executes live FUSE mount, reads mounted S3 files, and unmounts cleanly', async () => {
      // Operator lacks mounts snippet -> 403
      const opDeniedMounts = await getAction(operatorAgent, 'listMounts', { connectionId });
      expect(opDeniedMounts.status).toBe(403);

      const opDeniedCreateMount = await postAction(operatorAgent, 'createMount', {
        connectionId,
        fs: `minio:${LIVE_BUCKET}`,
        mountPoint,
      });
      expect(opDeniedCreateMount.status).toBe(403);

      // Prepare mount directory inside container /tmp via admin high-privilege local-fs
      const mkMntRes = await postAction(rootAgent, 'mkdir', {
        connectionId,
        fs: '/tmp',
        remote: mountPoint.replace(/^\/tmp\//, ''),
      });
      expect(mkMntRes.status).toBe(200);

      const mountTypesRes = await getAction(rootAgent, 'listMountTypes', { connectionId });
      expect(mountTypesRes.status).toBe(200);
      expect(mountTypesRes.body.data).toContain('mount');

      const createMntRes = await postAction(rootAgent, 'createMount', {
        connectionId,
        fs: `minio:${LIVE_BUCKET}`,
        mountPoint,
        vfsOpt: { CacheMode: 2 },
      });
      expect(createMntRes.status).toBe(200);

      const activeMountsRes = await getAction(rootAgent, 'listMounts', { connectionId });
      expect(activeMountsRes.status).toBe(200);
      expect(
        (activeMountsRes.body.data as Array<{ MountPoint: string }>).some((m) => m.MountPoint === mountPoint),
      ).toBe(true);

      // Verify files inside MinIO S3 bucket are actually visible through the live FUSE mount point!
      const mountedFilesRes = await getAction(rootAgent, 'listFiles', {
        connectionId,
        fs: mountPoint,
        remote: '',
      });
      expect(mountedFilesRes.status).toBe(200);
      expect(mountedFilesRes.body.data.map((f: { Name: string }) => f.Name)).toContain('seed');

      const unmountRes = await postAction(rootAgent, 'unmount', {
        connectionId,
        mountPoint,
      });
      expect(unmountRes.status).toBe(200);

      const afterUnmountRes = await getAction(rootAgent, 'listMounts', { connectionId });
      expect(afterUnmountRes.status).toBe(200);
      expect(
        (afterUnmountRes.body.data as Array<{ MountPoint: string }>).some((m) => m.MountPoint === mountPoint),
      ).toBe(false);
    });
  });
});
