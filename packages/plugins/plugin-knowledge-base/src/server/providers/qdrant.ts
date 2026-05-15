import type { VectorDatabaseProvider, VectorDatabaseProviderInfo } from '../features/vector-database-provider-impl';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { QdrantClient } from '@qdrant/js-client-rest';
import { QdrantVectorStore } from '@langchain/qdrant';

export type QdrantConnectParams = {
  url: string;
  apiKey?: string;
  collectionName: string;
};

export class QdrantDatabaseProvider implements VectorDatabaseProvider<QdrantConnectParams, any> {
  validateConnectParams(connectParams: QdrantConnectParams): void {
    if (!connectParams?.url) {
      throw new Error('Qdrant URL is required');
    }
    if (!connectParams?.collectionName) {
      throw new Error('Collection name is required');
    }
  }

  async testConnection(connectParams: QdrantConnectParams): Promise<{ success: boolean; error?: string }> {
    this.validateConnectParams(connectParams);

    try {
      const client = new QdrantClient({
        url: connectParams.url,
        apiKey: connectParams.apiKey,
      });

      // Simple call to check if the server is responsive
      await client.getCollections();

      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: error.message ?? 'Failed to connect to Qdrant',
      };
    }
  }

  async createVectorStore(embeddings: EmbeddingsInterface, connectParams: QdrantConnectParams): Promise<any> {
    this.validateConnectParams(connectParams);

    // We use fromExistingCollection to either connect to an existing or create a new one if it doesn't exist
    // QdrantVectorStore handles collection creation internally if needed.
    const vectorStore = await QdrantVectorStore.fromExistingCollection(embeddings, {
      url: connectParams.url,
      apiKey: connectParams.apiKey,
      collectionName: connectParams.collectionName,
    });

    return vectorStore;
  }
}

export const qdrantProviderInfo: VectorDatabaseProviderInfo<QdrantConnectParams, any> = {
  name: 'qdrant',
  spec: 'Qdrant',
  provider: new QdrantDatabaseProvider(),
};
