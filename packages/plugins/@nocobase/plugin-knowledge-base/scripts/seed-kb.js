/**
 * Seed data script for NocoBase Knowledge Base plugin.
 *
 * Creates default Vector Database, Vector Store, and Knowledge Bases.
 * Uses separate pgvector container for vector storage.
 *
 * Run from /app/nocobase:
 *   node seed-kb.js
 */
const { Client } = require('pg');

// NocoBase main database (for inserting records into plugin tables)
const NOCOBASE_DB = {
  host: process.env.DB_HOST || 'postgres',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'nocobase',
  password: process.env.DB_PASSWORD || 'nocobase',
  database: process.env.DB_DATABASE || 'nocobase',
};

// Separate pgvector database for vector storage
const VECTOR_DB = {
  host: 'app-postgres-pgvector-1',
  port: 5432,
  username: 'vector',
  password: 'vector123',
  database: 'vectors',
  tableName: 'kb_vectors',
};

function genId() {
  return 'kb_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

async function seed() {
  // 1. Verify pgvector database is reachable and extension works
  const vecClient = new Client({
    host: VECTOR_DB.host,
    port: VECTOR_DB.port,
    user: VECTOR_DB.username,
    password: VECTOR_DB.password,
    database: VECTOR_DB.database,
  });

  try {
    await vecClient.connect();
    await vecClient.query('CREATE EXTENSION IF NOT EXISTS vector');
    console.log('✅ pgvector extension enabled on vector database');
    await vecClient.end();
  } catch (e) {
    console.error('❌ Cannot connect to pgvector database:', e.message);
    console.error('   Ensure pgvector container is running: docker compose up -d pgvector');
    process.exit(1);
  }

  // 2. Connect to NocoBase main DB to insert seed records
  const client = new Client(NOCOBASE_DB);
  await client.connect();
  console.log('✅ Connected to NocoBase database');

  // 3. Check if data already exists
  const existing = await client.query('SELECT COUNT(*) as cnt FROM "aiVectorDatabases"');
  if (parseInt(existing.rows[0].cnt) > 0) {
    console.log('⚠️  Seed data already exists. Clearing old data first...');
    await client.query('DELETE FROM "aiKnowledgeBaseDocuments"');
    await client.query('DELETE FROM "aiKnowledgeBases"');
    await client.query('DELETE FROM "aiVectorStores"');
    await client.query('DELETE FROM "aiVectorDatabases"');
    console.log('   Old data cleared.');
  }

  // 4. Create Vector Database record
  const vdbId = genId();
  await client.query(
    `INSERT INTO "aiVectorDatabases" (id, name, provider, "connectParams", enabled, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
    [vdbId, 'PGVector (Dedicated)', 'pgvector', JSON.stringify(VECTOR_DB), true],
  );
  console.log('✅ Vector Database created:', vdbId);

  // 5. Create Vector Store record
  const vsId = genId();
  await client.query(
    `INSERT INTO "aiVectorStores" (id, name, "vectorDatabaseId", "llmService", "embeddingModel", options, enabled, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
    [
      vsId,
      'Default Embedding Store',
      vdbId,
      null, // Set via UI: LLM service with embedding capability
      null, // Set via UI: e.g. text-embedding-3-small
      JSON.stringify({ dimensions: 1536 }),
      true,
    ],
  );
  console.log('✅ Vector Store created:', vsId);

  // 6. Create Knowledge Bases (3 access levels)
  const kbs = [
    {
      name: 'Public Knowledge Base',
      description:
        'System-wide knowledge base. All authenticated users can query this KB via AI employees. Admins can upload documents.',
      accessLevel: 'PUBLIC',
    },
    {
      name: 'Shared Team Knowledge',
      description:
        'Team knowledge base. Users with allowed roles can query, users with upload roles can add documents.',
      accessLevel: 'SHARED',
      allowedRoles: ['admin', 'member'],
      uploadRoles: ['admin'],
    },
    {
      name: 'Personal Notes',
      description: 'Personal knowledge base. Only the owner can view, query, and upload documents.',
      accessLevel: 'BASIC',
      ownerId: 1,
    },
  ];

  for (const kb of kbs) {
    const kbId = genId();
    await client.query(
      `INSERT INTO "aiKnowledgeBases" (id, name, description, type, "vectorStoreId", enabled, "accessLevel", "ownerId", "allowedRoles", "uploadRoles", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())`,
      [
        kbId,
        kb.name,
        kb.description,
        'LOCAL',
        vsId,
        true,
        kb.accessLevel,
        kb.ownerId || null,
        kb.allowedRoles ? JSON.stringify(kb.allowedRoles) : null,
        kb.uploadRoles ? JSON.stringify(kb.uploadRoles) : null,
      ],
    );
    console.log(`✅ Knowledge Base: "${kb.name}" [${kb.accessLevel}]`);
  }

  console.log('\n🎉 Seed data created successfully!');
  console.log('\n📋 Summary:');
  console.log('  • Vector DB:    PGVector @ pgvector:5432/vectors');
  console.log('  • Vector Store: Default Embedding Store (configure LLM embedding model in UI)');
  console.log('  • KBs:          Public, Shared (admin/member), Personal (admin)');
  console.log('\n🔧 Next steps:');
  console.log('  1. Configure an LLM service with embedding support in AI Settings');
  console.log('  2. Update Vector Store with LLM service + embedding model');
  console.log('  3. Upload documents to test RAG');

  await client.end();
}

seed().catch((e) => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
