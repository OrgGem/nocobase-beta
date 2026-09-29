import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

const SERVER_ROOT = resolve(__dirname, '..');

function readOwnPackage() {
  const file = resolve(__dirname, '../../../package.json');
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

/** Collect every server-side .ts file (excluding tests) so the import scan matches what ships. */
function collectServerSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...collectServerSources(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every `@nocobase/*` package the server code imports at runtime. */
function importedNocobasePackages(): Set<string> {
  const pattern = /from\s+['"](@nocobase\/[^'"/]+)(?:\/[^'"]*)?['"]/g;
  const found = new Set<string>();
  for (const file of collectServerSources(SERVER_ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(pattern)) {
      found.add(match[1]);
    }
  }
  return found;
}

describe('HA scheduler dependency contract', () => {
  it('declares every @nocobase package it imports as a peer dependency', () => {
    // Derive the expectation from real imports rather than restating package.json,
    // so an undeclared runtime dependency fails the build instead of surfacing at load.
    const pkg = readOwnPackage();
    const declared = Object.keys(pkg.peerDependencies || {});
    const imported = importedNocobasePackages();

    expect(imported.size).toBeGreaterThan(0);
    for (const name of imported) {
      expect(declared).toContain(name);
    }
  });

  it('does not force a plugin load-order edge on plugin-cluster-manager', () => {
    // PluginManager.sort() turns every peerDependency into an "after" edge. The
    // scheduler relies on the Redis lock adapter, but core's Application registers
    // that adapter in its constructor (before any plugin loads), so there is no
    // real ordering dependency on plugin-cluster-manager. Declaring one here would
    // be an unsatisfiable peer requirement whenever the cluster manager is absent.
    const pkg = readOwnPackage();
    const deps = {
      ...(pkg.peerDependencies || {}),
      ...(pkg.dependencies || {}),
    };
    expect(deps['plugin-cluster-manager']).toBeUndefined();
  });
});
