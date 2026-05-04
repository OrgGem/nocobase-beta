import { Application } from '@nocobase/server';
import { db } from '@nocobase/test';

async function main() {
  const app = new Application({
    database: {
      dialect: 'sqlite',
      storage: ':memory:'
    }
  });
  // Just testing the logic, no need to boot the whole NocoBase
}
main();
