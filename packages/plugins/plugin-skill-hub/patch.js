const fs = require('fs');
let c = fs.readFileSync('src/server/plugin.ts', 'utf8');
c = c.replace(/await this\.db\.import\(\{\s*directory:\s*resolve\(__dirname,\s*'collections'\),\s*\}\);/g, `await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });

    this.db.addMigrations({
      namespace: this.name,
      directory: resolve(__dirname, 'migrations'),
      context: { plugin: this },
    });`);
fs.writeFileSync('src/server/plugin.ts', c);
