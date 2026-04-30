/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';
import { resolve } from 'path';
import PluginAIServer from '@nocobase/plugin-ai';
import type { VectorStoreProvider } from '@nocobase/plugin-ai/server';
import { KnowledgeBaseFeatureImpl } from './features/knowledge-base-impl';
import { VectorDatabaseFeatureImpl } from './features/vector-database-impl';
import { VectorDatabaseProviderImpl } from './features/vector-database-provider-impl';
import { VectorStoreProviderImpl } from './features/vector-store-provider-impl';
import { pgVectorProviderInfo } from './providers/pgvector';
import { externalHttpRagStrategy, EXTERNAL_HTTP_RAG_PROVIDER } from './providers/external-rag';
import type { RagSearchStrategy } from './providers/external-rag';
import { VectorizationPipeline } from './pipeline/vectorization';
import { DocPixieExtractor } from './services/docpixie-extractor';
import { KnowledgeSearchService } from './services/knowledge-search';
import type { KnowledgeSearchOptions } from './services/knowledge-search';
import aiKnowledgeBase from './resources/ai-knowledge-base';
import aiKnowledgeBaseDocuments from './resources/ai-knowledge-base-documents';
import aiVectorStores from './resources/ai-vector-stores';
import aiVectorDatabases from './resources/ai-vector-databases';
import { addDocumentAction } from './actions/add-document';
import requestContext from './request-context';

export class PluginKnowledgeBaseServer extends Plugin {
  vectorizationPipeline: VectorizationPipeline;
  docpixieExtractor: DocPixieExtractor;
  knowledgeBaseFeature: KnowledgeBaseFeatureImpl;
  knowledgeSearchService: KnowledgeSearchService;
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * The VectorStore provider registry exposed publicly so that other plugins can
   * register additional vector store backends (e.g., a custom embedding plugin).
   *
   * Usage from another plugin:
   *   const kb = this.pm.get(PluginKnowledgeBaseServer) as PluginKnowledgeBaseServer;
   *   kb.registerVectorStoreProvider(myProvider);
   */
  vectorStoreProvider: VectorStoreProviderImpl;

  /**
   * Registry for external / custom RAG search strategies.
   *
   * A strategy is invoked for Knowledge Bases of type 'EXTERNAL_RAG' whose
   * options.ragProvider matches the registered name.
   *
   * Usage from another plugin:
   *   kb.registerRagSearchStrategy('my-rag', async (query, kbRecord, opts) => {
   *     // call your custom RAG backend and return results
   *     return [{ content: '...', score: 0.9 }];
   *   });
   */
  private ragSearchStrategies = new Map<string, RagSearchStrategy>();

  private _aiPlugin: PluginAIServer;

  get aiPlugin(): PluginAIServer {
    if (!this._aiPlugin) {
      this._aiPlugin = this.pm.get(PluginAIServer) as PluginAIServer;
    }
    return this._aiPlugin;
  }

  // ── Public extension API ────────────────────────────────────────────────────

  /**
   * Register a custom VectorStoreProvider so it can be selected as a provider
   * when creating Vector Stores in the admin UI.
   *
   * Example (from another plugin's load()):
   *   const kb = this.pm.get(PluginKnowledgeBaseServer) as PluginKnowledgeBaseServer;
   *   kb.registerVectorStoreProvider({
   *     providerName: 'my-vector-store',
   *     async createVectorStoreService(props) { ... },
   *   });
   */
  registerVectorStoreProvider(provider: VectorStoreProvider): void {
    if (!this.vectorStoreProvider) {
      throw new Error('registerVectorStoreProvider() must be called after plugin-knowledge-base has loaded');
    }
    this.vectorStoreProvider.register(provider);
  }

  /**
   * Register a RAG search strategy for Knowledge Bases of type 'EXTERNAL_RAG'.
   *
   * The strategy name must match the value stored in kb.options.ragProvider.
   * The built-in 'external-http' strategy is always pre-registered and handles
   * generic HTTP-based RAG services.
   *
   * Example:
   *   kb.registerRagSearchStrategy('pinecone', async (query, kbRecord, opts) => {
   *     const { ragApiKey, ragNamespace } = kbRecord.options;
   *     const results = await pineconeQuery(ragApiKey, ragNamespace, query, opts.topK);
   *     return results.map(r => ({ content: r.text, score: r.score }));
   *   });
   */
  registerRagSearchStrategy(name: string, strategy: RagSearchStrategy): void {
    this.ragSearchStrategies.set(name, strategy);
  }

  getRagSearchStrategy(name: string): RagSearchStrategy | undefined {
    return this.ragSearchStrategies.get(name);
  }

  searchKnowledgeBases(ctx: any, query: string, options?: KnowledgeSearchOptions) {
    if (!this.knowledgeSearchService) {
      this.knowledgeSearchService = new KnowledgeSearchService(this);
    }
    return this.knowledgeSearchService.search(ctx, query, options);
  }

  // ─────────────────────────────────────────────────────────────────────────

  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    // 1. Create feature implementations
    const vdbProvider = new VectorDatabaseProviderImpl();
    vdbProvider.register(pgVectorProviderInfo);

    this.vectorStoreProvider = new VectorStoreProviderImpl(this, this.aiPlugin);
    const vectorStoreProvider = this.vectorStoreProvider;

    // Register built-in external-http RAG strategy
    this.ragSearchStrategies.set(EXTERNAL_HTTP_RAG_PROVIDER, externalHttpRagStrategy);
    const vectorDatabase = new VectorDatabaseFeatureImpl(this);
    const knowledgeBase = new KnowledgeBaseFeatureImpl(this);
    this.knowledgeBaseFeature = knowledgeBase;
    this.knowledgeSearchService = new KnowledgeSearchService(this);

    // 2. Register features with plugin-ai
    this.aiPlugin.features.enableFeatures({
      vectorDatabase,
      vectorDatabaseProvider: vdbProvider,
      vectorStoreProvider,
      knowledgeBase,
    });

    // 3. Initialize vectorization pipeline (with optional DocPixie extractor)
    this.docpixieExtractor = new DocPixieExtractor(this.db, () => this.getDocpixiePlugin());
    this.vectorizationPipeline = new VectorizationPipeline(this, this.docpixieExtractor);

    // 4. Define resources
    this.defineResources();

    // 5. Middleware: propagate current userId + roles via AsyncLocalStorage
    this.app.resourceManager.use(async (ctx, next) => {
      const userId = ctx.auth?.user?.id ?? ctx.state?.currentUser?.id;
      if (userId) {
        // Get user roles from context
        const userRoles: string[] = ctx.state?.currentUser?.roles?.map((r: any) => r.name || r) ?? [];
        // Fallback: check ctx.state.currentRole
        if (userRoles.length === 0 && ctx.state?.currentRole) {
          userRoles.push(ctx.state.currentRole);
        }
        return requestContext.run({ userId, userRoles }, () => next());
      }
      await next();
    });

    // 6. Set ACL permissions
    this.setPermissions();
    // 7. Set file storage for KB uploads (before file-manager's createMiddleware).
    //    file-manager's createMiddleware reads `collection.options.storage` to determine
    //    which storage backend to use. We set it here per-request from the `storageRule`
    //    query param, then restore the previous value to limit global-state pollution.
    //    Note: this is not fully race-safe (collection is a global singleton); a complete
    //    fix would require file-manager to read storage from request-scoped ctx.state.
    this.app.resourceManager.use(
      async (ctx, next) => {
        const { resourceName, actionName } = ctx.action;
        if (resourceName === 'aiFiles' && actionName === 'create') {
          const storageName = ctx.action.params?.storageRule;
          if (storageName) {
            const collection = ctx.db.getCollection('aiFiles');
            if (collection) {
              const prevStorage = collection.options.storage;
              collection.options.storage = storageName;
              try {
                await next();
              } finally {
                collection.options.storage = prevStorage;
              }
              return;
            }
          }
        }
        await next();
      },
      { before: 'createMiddleware' },
    );

    // 8. Register work context strategy for per-chat KB selection
    this.registerKnowledgeBaseWorkContext();

    // 9. Start background retry job for failed documents (every 5 minutes)
    this.startRetryJob();
  }

  async disable() {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private startRetryJob() {
    const RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    const MAX_RETRY_COUNT = 3;

    this.retryTimer = setInterval(async () => {
      try {
        const docRepo = this.db.getRepository('aiKnowledgeBaseDocuments');
        const failedDocs = await docRepo.find({
          filter: {
            status: 'failed',
            retryCount: { $lt: MAX_RETRY_COUNT },
          },
          appends: ['knowledgeBase'],
          limit: 10,
        });

        for (const doc of failedDocs) {
          if (!doc.knowledgeBase) continue;
          const kbType = doc.knowledgeBase.type;

          try {
            if (kbType === 'WEB_CLIENT_EMBED' && doc.knowledgeBase.embedMode === 'server') {
              // Retry via embed-web-client server pipeline
              const embedPlugin = this.pm.get('@nocobase/plugin-embed-web-client') as any;
              if (embedPlugin?.serverEmbeddingPipeline) {
                await docRepo.update({ filter: { id: doc.id }, values: { status: 'pending' } });
                embedPlugin.serverEmbeddingPipeline.processDocument(doc.id).catch((err: any) => {
                  this.app.logger.warn(`[KBRetry] Server embedding retry failed for doc ${doc.id}: ${err.message}`);
                });
              }
            } else if (kbType !== 'WEB_CLIENT_EMBED') {
              // Retry via vectorization pipeline (LOCAL and other types)
              await docRepo.update({ filter: { id: doc.id }, values: { status: 'pending' } });
              this.vectorizationPipeline.processDocument(doc.id).catch((err: any) => {
                this.app.logger.warn(`[KBRetry] Vectorization retry failed for doc ${doc.id}: ${err.message}`);
              });
            }
            // WEB_CLIENT_EMBED with client mode: skip auto-retry (needs browser)
          } catch (err: any) {
            this.app.logger.warn(`[KBRetry] Failed to trigger retry for doc ${doc.id}: ${err.message}`);
          }
        }
      } catch (err: any) {
        this.app.logger.warn(`[KBRetry] Retry job error: ${err.message}`);
      }
    }, RETRY_INTERVAL_MS);
  }

  /** Returns the plugin-docpixie instance if it is loaded and has an active service, else null */
  private getDocpixiePlugin(): any | null {
    try {
      const p = this.pm.get('@nocobase/plugin-docpixie') as any;
      return p?.service ? p : null;
    } catch {
      return null;
    }
  }

  private defineResources() {
    this.app.resourceManager.define(aiKnowledgeBase);
    this.app.resourceManager.define(aiKnowledgeBaseDocuments);
    this.app.resourceManager.define(aiVectorStores);
    this.app.resourceManager.define(aiVectorDatabases);

    // Register addDocument action for workflow integration
    this.app.resourceManager.registerActionHandler('aiKnowledgeBase:addDocument', addDocumentAction);
  }

  /**
   * Register a work context resolve strategy so that when users select
   * Knowledge Bases via the AddContext button in AI chat, the background
   * strategy performs a RAG search and injects results into the system prompt.
   */
  private registerKnowledgeBaseWorkContext() {
    const plugin = this;
    this.aiPlugin.workContextHandler.registerStrategy('knowledge-base', {
      resolve: async (_ctx, contextItem) => {
        return `[Knowledge Base: ${contextItem.title || contextItem.uid}]`;
      },
      background: async (ctx, aiMessages, workContextItems) => {
        // 1. Collect unique KB IDs from work context items
        const kbIds = [...new Set(workContextItems.map((item) => item.uid).filter(Boolean))];
        if (!kbIds.length) return '';

        // 2. Extract the last user message content as the search query
        const lastUserMsg = [...aiMessages].reverse().find((m) => m.role === 'user');

        // Handle multiple content structures from plugin-ai:
        // 1. content is a string directly: "hello"
        // 2. content is { content: "hello" }
        // 3. content is { content: { content: "hello" } }
        let queryString = '';
        if (lastUserMsg) {
          const c: any = lastUserMsg.content;
          if (typeof c === 'string') {
            queryString = c;
          } else if (c && typeof c === 'object') {
            if (typeof c.content === 'string') {
              queryString = c.content;
            } else if (c.content && typeof c.content === 'object' && typeof c.content.content === 'string') {
              queryString = c.content.content;
            } else if (typeof c.text === 'string') {
              queryString = c.text;
            }
          }
        }

        plugin.app.logger.info(
          `[KB WorkContext] lastUserMsg content type: ${typeof lastUserMsg?.content}, queryString length: ${
            queryString.length
          }, queryString: "${queryString.substring(0, 100)}"`,
        );

        if (!queryString) return '';

        // 3. Search and rerank relevant documents. The service also rechecks
        // access permissions so selected work-context IDs cannot bypass ACL.
        const allDocs = await plugin.searchKnowledgeBases(ctx, queryString, {
          knowledgeBaseIds: kbIds.map(String),
          topK: 5,
          candidateK: 20,
          scoreThreshold: 0.3,
          rerank: true,
        });

        plugin.app.logger.info(`[KB WorkContext] Search returned ${allDocs.length} reranked result(s)`);

        if (!allDocs.length) return '';

        // 6. Stage 2 — DocPixie deep retrieval
        //    If any result chunks have a docpixieDocumentId, fetch full page texts from
        //    DocPixie for those documents and prepend as richer context.
        let deepContext = '';
        const docpixiePlugin = plugin.getDocpixiePlugin();
        if (docpixiePlugin?.service?.isReady()) {
          const docpixieIds: number[] = [
            ...new Set(
              allDocs
                .map((d: any) => d.metadata?.docpixieDocumentId as number | undefined)
                .filter((id): id is number => typeof id === 'number'),
            ),
          ].slice(0, 3); // cap at 3 docs to limit token budget

          if (docpixieIds.length > 0) {
            try {
              // Reuse the existing docpixieExtractor instance created during load() —
              // avoids creating a new object + require() on every RAG call.
              deepContext = await plugin.docpixieExtractor.buildDeepContext(docpixieIds);
              plugin.app.logger.info(
                `[KB WorkContext] Stage 2 DocPixie deep retrieval: ${docpixieIds.length} doc(s), context length=${deepContext.length}`,
              );
            } catch (err) {
              plugin.app.logger.warn('[KB WorkContext] Stage 2 DocPixie retrieval failed:', err);
            }
          }
        }

        // 7. Format search results as background context
        //    Deep context (full DocPixie pages) comes first, chunk summaries second.
        const chunkData = allDocs.map((doc: any) => doc.content).join('\n');
        const kbData = deepContext ? `${deepContext}\n\n<kb_chunks>\n${chunkData}\n</kb_chunks>` : chunkData;
        return `<knowledgeBase>From knowledge base:\n${kbData}\nanswer user's question using this information.</knowledgeBase>`;
      },
    });
  }

  private setPermissions() {
    // Admin snippet for managing knowledge base, vector stores, and vector databases
    this.app.acl.registerSnippet({
      name: `pm.${this.name}.knowledge-base`,
      actions: ['aiKnowledgeBase:*', 'aiKnowledgeBaseDoc:*', 'aiVectorStore:*', 'aiVectorDatabase:*'],
    });

    // Allow logged-in users to list/get knowledge bases (needed by AI Employee KB selector)
    this.app.acl.allow('aiKnowledgeBase', 'list', 'loggedIn');
    this.app.acl.allow('aiKnowledgeBase', 'get', 'loggedIn');
    this.app.acl.allow('aiKnowledgeBase', 'search', 'loggedIn');
    this.app.acl.allow('aiKnowledgeBase', 'addDocument', 'loggedIn');

    // Allow logged-in users to manage their own documents.
    // Per-request authorization inside the resource handlers enforces actual ownership;
    // these allow() calls only open the ACL gate so requests reach the handler.
    this.app.acl.allow('aiKnowledgeBaseDoc', 'list', 'loggedIn');
    this.app.acl.allow('aiKnowledgeBaseDoc', 'create', 'loggedIn');
    this.app.acl.allow('aiKnowledgeBaseDoc', 'destroy', 'loggedIn');
    this.app.acl.allow('aiKnowledgeBaseDoc', 'reprocess', 'loggedIn');
  }

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginKnowledgeBaseServer;
