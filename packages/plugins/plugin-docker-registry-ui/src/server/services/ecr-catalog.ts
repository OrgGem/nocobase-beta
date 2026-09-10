import { RegistryRequestError } from './registry-client';
import { resolveEcrCredentialsProvider, type EcrClientConfigOptions, type EcrCredentialsProvider } from './ecr-client';
import type { RegistryListResult } from '../../shared/types';

/**
 * Minimal structural type for an ECR client instance. Production builds a real
 * `ECRClient` from `@aws-sdk/client-ecr`; tests inject a mock with the same
 * shape so no AWS SDK call is ever made in unit tests.
 */
export interface EcrCatalogClientLike {
  send(
    command: unknown,
  ): Promise<
    | { repositories?: Array<{ repositoryName?: string }>; nextToken?: string }
    | { imageDetails?: Array<{ imageTags?: Array<string | undefined> }>; nextToken?: string }
  >;
}

export type EcrCatalogClientFactory = (config: {
  region: string;
  credentials?: EcrCredentialsProvider;
}) => EcrCatalogClientLike;

export interface EcrCatalogOptions extends EcrClientConfigOptions {
  region: string;
  createClient?: EcrCatalogClientFactory;
}

interface EcrCatalogSdkModule {
  ECRClient: new (config: { region: string; credentials?: EcrCredentialsProvider }) => EcrCatalogClientLike;
  DescribeRepositoriesCommand: new (input: object) => unknown;
  ListImagesCommand: new (input: object) => unknown;
}

function defaultCreateClient(config: { region: string; credentials?: EcrCredentialsProvider }): EcrCatalogClientLike {
  let ecrModule: EcrCatalogSdkModule;
  try {
    ecrModule = require('@aws-sdk/client-ecr') as EcrCatalogSdkModule;
  } catch (error) {
    throw new Error(
      '[docker-registry-ui] @aws-sdk/client-ecr is required for ECR credential mode. Please run `npm install @aws-sdk/client-ecr`.',
    );
  }
  return new ecrModule.ECRClient(config);
}

function requireEcrCommands(): {
  DescribeRepositoriesCommand: new (input: object) => unknown;
  ListImagesCommand: new (input: object) => unknown;
} {
  let ecrModule: EcrCatalogSdkModule;
  try {
    ecrModule = require('@aws-sdk/client-ecr') as EcrCatalogSdkModule;
  } catch (error) {
    throw new Error(
      '[docker-registry-ui] @aws-sdk/client-ecr is required for ECR credential mode. Please run `npm install @aws-sdk/client-ecr`.',
    );
  }
  return ecrModule;
}

/**
 * Lists ECR repositories and tags through the ECR Control Plane API because
 * ECR does not support the Docker Distribution `GET /v2/_catalog` endpoint.
 */
export class EcrCatalogProvider {
  constructor(private readonly options: EcrCatalogOptions) {}

  async listRepositoriesPage(nextToken?: string): Promise<RegistryListResult> {
    const credentials = resolveEcrCredentialsProvider(this.options);
    const createClient = this.options.createClient ?? defaultCreateClient;
    const client = createClient({ region: this.options.region, credentials });
    const { DescribeRepositoriesCommand } = requireEcrCommands();

    let response: { repositories?: Array<{ repositoryName?: string }>; nextToken?: string };
    try {
      response = (await client.send(new DescribeRepositoriesCommand({ ...(nextToken ? { nextToken } : {}) }))) as {
        repositories?: Array<{ repositoryName?: string }>;
        nextToken?: string;
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RegistryRequestError(`ECR DescribeRepositories failed: ${message}`, 502, 'ECR_CATALOG_FAILED');
    }

    const items = (response.repositories ?? [])
      .map((repository) => repository.repositoryName)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
    return { items, nextCursor: response.nextToken || undefined };
  }

  async listTagsPage(repository: string, nextToken?: string): Promise<RegistryListResult> {
    const credentials = resolveEcrCredentialsProvider(this.options);
    const createClient = this.options.createClient ?? defaultCreateClient;
    const client = createClient({ region: this.options.region, credentials });
    const { ListImagesCommand } = requireEcrCommands();

    let response: { imageDetails?: Array<{ imageTags?: Array<string | undefined> }>; nextToken?: string };
    try {
      response = (await client.send(
        new ListImagesCommand({ repositoryName: repository, ...(nextToken ? { nextToken } : {}) }),
      )) as { imageDetails?: Array<{ imageTags?: Array<string | undefined> }>; nextToken?: string };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RegistryRequestError(`ECR ListImages failed: ${message}`, 502, 'ECR_CATALOG_FAILED');
    }

    const items: string[] = [];
    for (const detail of response.imageDetails ?? []) {
      for (const tag of detail.imageTags ?? []) {
        if (typeof tag === 'string' && tag.length > 0) items.push(tag);
      }
    }
    return { items, nextCursor: response.nextToken || undefined };
  }
}
