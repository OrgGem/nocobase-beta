// Dynamic-import interop: in the built server bundle `await import('...')` of a
// CJS package resolves to `{ default: moduleExports }`, while under vite-node the
// named exports sit at the top level. Unwrap defensively in one place so callers
// work in both environments (a bare `await import('openpgp')` in the bundle
// throws "openpgp.readKey is not a function").

export async function loadOpenpgp(): Promise<typeof import('openpgp')> {
  const mod = await import('openpgp');
  return (mod.default ?? mod) as typeof import('openpgp');
}

export async function loadSshpk(): Promise<typeof import('sshpk')> {
  const mod = await import('sshpk');
  return (mod.default ?? mod) as typeof import('sshpk');
}
