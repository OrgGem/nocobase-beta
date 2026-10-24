import type { APIClient, Application } from '@nocobase/client-v2';

const wrappedClients = new WeakSet<APIClient>();

export function clearClientCache() {
  const keysToRemove: string[] = [];
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith('nb_cache:')) {
        keysToRemove.push(key);
      }
    }
  } catch {
    return;
  }
  keysToRemove.forEach((key) => {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // Ignore sessionStorage block/quota errors
    }
  });
}

export function setupClientSafeCache(apiClient: APIClient, eventBus: Application['eventBus']) {
  if (!apiClient?.auth || wrappedClients.has(apiClient)) return;
  wrappedClients.add(apiClient);

  // Clear cache on role changes
  const originalSetRole = apiClient.auth.setRole.bind(apiClient.auth);
  apiClient.auth.setRole = (role: string) => {
    clearClientCache();
    return originalSetRole(role);
  };

  // Clear cache on token changes
  const originalSetToken = apiClient.auth.setToken.bind(apiClient.auth);
  apiClient.auth.setToken = (token: string) => {
    clearClientCache();
    return originalSetToken(token);
  };

  // Listen to application auth:tokenChanged event
  eventBus.addEventListener('auth:tokenChanged', () => {
    clearClientCache();
  });
}
