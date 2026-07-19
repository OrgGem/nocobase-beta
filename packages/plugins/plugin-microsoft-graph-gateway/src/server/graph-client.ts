import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials';

export type GraphSettings = { tenantId: string; clientId: string; clientSecret: string };

export function createGraphClient(settings: GraphSettings): Client {
  const credential = new ClientSecretCredential(settings.tenantId, settings.clientId, settings.clientSecret);
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ['https://graph.microsoft.com/.default'],
  });
  return Client.initWithMiddleware({ authProvider });
}
