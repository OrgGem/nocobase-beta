/**
 * copy-tedious.js
 *
 * Copies the tedious package AND all its transitive dependencies into dist/tedious/
 * so the plugin .tgz is self-contained and works without separate npm install.
 *
 * Structure created:
 *   dist/tedious/           → tedious package
 *   dist/tedious/node_modules/  → all transitive dependencies
 */

const fs = require('fs');
const path = require('path');

function getPackageDir(packageName, searchPaths) {
  for (const searchPath of searchPaths) {
    try {
      const resolved = require.resolve(`${packageName}/package.json`, { paths: [searchPath] });
      return path.dirname(resolved);
    } catch {
      // continue
    }
  }
  // Fallback: global resolve
  try {
    return path.dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    return null;
  }
}

function getProductionDeps(packageDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    return Object.keys(pkg.dependencies || {});
  } catch {
    return [];
  }
}

function collectAllDeps(packageName, searchPaths, visited = new Set()) {
  if (visited.has(packageName)) return [];
  visited.add(packageName);

  const pkgDir = getPackageDir(packageName, searchPaths);
  if (!pkgDir) {
    console.warn(`[copy-tedious] Could not find package: ${packageName}`);
    return [];
  }

  const result = [{ name: packageName, dir: pkgDir }];
  const deps = getProductionDeps(pkgDir);

  // Also search inside the package's own node_modules
  const innerNodeModules = path.join(pkgDir, 'node_modules');
  const extendedPaths = fs.existsSync(innerNodeModules) ? [innerNodeModules, ...searchPaths] : searchPaths;

  for (const dep of deps) {
    result.push(...collectAllDeps(dep, extendedPaths, visited));
  }

  return result;
}

function copyTedious() {
  const destBase = path.join(__dirname, '../dist/tedious');

  // Clean old copy
  fs.rmSync(destBase, { recursive: true, force: true });
  fs.mkdirSync(destBase, { recursive: true });

  const searchPaths = [process.cwd(), __dirname, path.join(__dirname, '..', 'node_modules')];

  // Find tedious source
  const tediousSrc = getPackageDir('tedious', searchPaths);
  if (!tediousSrc) {
    console.error('[copy-tedious] FATAL: Could not find tedious package!');
    process.exit(1);
  }

  console.log(`[copy-tedious] Found tedious at: ${tediousSrc}`);

  // Copy tedious itself to dist/tedious/
  fs.cpSync(tediousSrc, destBase, { recursive: true });
  console.log(`[copy-tedious] Copied tedious → dist/tedious/`);

  // Collect and copy all transitive dependencies
  const allDeps = collectAllDeps('tedious', searchPaths);
  const nodeModulesDir = path.join(destBase, 'node_modules');
  let copiedCount = 0;

  for (const dep of allDeps) {
    if (dep.name === 'tedious') continue; // Already copied above

    const depDest = path.join(nodeModulesDir, dep.name);

    // Handle scoped packages (@scope/name)
    if (dep.name.startsWith('@')) {
      fs.mkdirSync(path.dirname(depDest), { recursive: true });
    }

    if (!fs.existsSync(depDest)) {
      fs.mkdirSync(depDest, { recursive: true });
      fs.cpSync(dep.dir, depDest, { recursive: true });
      copiedCount++;
    }
  }

  console.log(`[copy-tedious] Copied ${copiedCount} transitive dependencies → dist/tedious/node_modules/`);

  // Final summary
  const totalSize = getDirSize(destBase);
  console.log(`[copy-tedious] Total dist/tedious/ size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
}

function getDirSize(dir) {
  let size = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        size += getDirSize(fullPath);
      } else {
        size += fs.statSync(fullPath).size;
      }
    }
  } catch {
    // ignore
  }
  return size;
}

copyTedious();
