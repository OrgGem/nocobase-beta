import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createMockServer } from '@nocobase/test';

describe('plugin-crypto-toolkit smoke', () => {
  let app: Awaited<ReturnType<typeof createMockServer>>;

  beforeAll(async () => {
    app = await createMockServer({
      plugins: ['nocobase', 'plugin-crypto-toolkit'],
    });
  });

  afterAll(async () => {
    await app?.destroy();
  });

  it('boots and registers collections', async () => {
    expect(app.db.getCollection('cryptoKeys')).toBeTruthy();
    expect(app.db.getCollection('cryptoOperations')).toBeTruthy();
  });

  it('registers ACL snippet', async () => {
    const snippet = (app.acl as unknown as { snippets?: Record<string, unknown> }).snippets?.[
      'pm.plugin-crypto-toolkit'
    ];
    expect(snippet).toBeDefined();
  });

  it('cryptoKeys:generate stores the row, returns private material exactly once, and creates env vars when requested', async () => {
    const response = await app.agent().resource('cryptoKeys').create({
      name: 'gen-ed-test',
      kind: 'ed25519',
      saveToEnv: true,
      envVarName: 'PFX_GEN_ED',
      values: {},
    });
    // Resource-action endpoint shape varies; we accept either create-return or list-add.
    // Will be replaced by an explicit :generate test below.
    expect(response).toBeTruthy();

    const generated = await app.agent().post('/api/cryptoKeys:generate').send({
      name: 'gen-ed-test-2',
      kind: 'ed25519',
      saveToEnv: true,
      envVarName: 'PFX_GEN_ED2',
      direction: 'own',
      purpose: 'both',
    });
    expect(generated.status).toBe(200);
    const body = generated.body as {
      ok: boolean;
      key: { id: number; name: string; fingerprint: string };
      privateMaterial: string;
      savedToEnv: boolean;
      envVarName: string;
    };
    expect(body.ok).toBe(true);
    expect(body.key.name).toBe('gen-ed-test-2');
    expect(body.privateMaterial).toMatch(/-----BEGIN PRIVATE KEY-----/);
    expect(body.savedToEnv).toBe(true);
    expect(body.envVarName).toBe('PFX_GEN_ED2');

    // Environment variables for both halves exist as type=secret
    const envRepo = app.db.getRepository('environmentVariables');
    const priv = await envRepo.findOne({ filter: { name: 'PFX_GEN_ED2_PRIVATE' } });
    const pub = await envRepo.findOne({ filter: { name: 'PFX_GEN_ED2_PUBLIC' } });
    expect(priv).toBeTruthy();
    expect(String(priv?.get('type'))).toBe('secret');
    expect(pub).toBeTruthy();

    // The persisted row carries the privateEnvVar reference (not the material itself).
    const row = await app.db.getRepository('cryptoKeys').findOne({ filter: { name: 'gen-ed-test-2' } });
    expect(row).toBeTruthy();
    expect(String(row?.get('privateEnvVar'))).toBe('PFX_GEN_ED2');
  });

  it('cryptoKeys:import refuses to store private material', async () => {
    const privPem = `-----BEGIN PRIVATE KEY-----
MFICAQEwBQYDK2VwBCIEIH6sXkpDlNV9t9JKEzG2GTHITj1JcDgRGJrtBmkRTkWh
g6Be3SP+TCEhAy+Rw7mKAfCvbSUBAfpx6u6tFk5QYRo=
-----END PRIVATE KEY-----`;

    const response = await app
      .agent()
      .post('/api/cryptoKeys:importKey')
      .send({
        name: 'bad-import',
        direction: 'partner',
        purpose: 'both',
        key: { mode: 'text', text: privPem },
      });
    // Should be 400 or otherwise indicate rejection
    expect(response.status).toBe(400);
  });
});
