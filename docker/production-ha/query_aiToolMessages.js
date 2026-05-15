const fs = require('fs');
const pg = require('pg');

const client = new pg.Client({
  connectionString: 'postgresql://nocobase:nocobase@localhost:5432/nocobase'
});

async function run() {
  await client.connect();
  const res = await client.query('SELECT * FROM "aiToolMessages" ORDER BY "createdAt" DESC LIMIT 5;');
  console.log(JSON.stringify(res.rows, null, 2));
  await client.end();
}

run().catch(console.error);
