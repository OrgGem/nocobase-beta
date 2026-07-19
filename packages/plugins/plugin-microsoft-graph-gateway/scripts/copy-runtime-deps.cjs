const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist', 'node_modules');
const names = new Set();
function collect(name) {
    if (name.startsWith('@nocobase/')) return;
    if (names.has(name)) return;
    names.add(name);
    let packageJson;
    try { packageJson = require.resolve(`${name}/package.json`, { paths: [root] }); } catch { return; }
    const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    for (const dependency of Object.keys(pkg.dependencies ?? {})) collect(dependency);
}
for (const dependency of Object.keys(require(path.join(root, 'package.json')).dependencies ?? {})) collect(dependency);
fs.mkdirSync(output, { recursive: true });
for (const name of names) {
  let packageJson;
  try {
    packageJson = require.resolve(`${name}/package.json`, { paths: [root] });
  } catch {
    continue;
  }
  const source = path.dirname(packageJson);
  const destination = path.join(output, name);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}
console.log(`Copied ${names.size} runtime packages into ${output}`);
