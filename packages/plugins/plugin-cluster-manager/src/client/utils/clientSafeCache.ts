import { APIClient } from '@nocobase/client';

export function clearClientCache() {
  const keysToRemove: string[] = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (key && key.startsWith('nb_cache:')) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((key) => {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // Ignore sessionStorage block/quota errors
    }
  });
}

export function setupClientSafeCache(apiClient: APIClient) {
  if (!apiClient?.auth) return;

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
  apiClient.app?.eventBus?.addEventListener('auth:tokenChanged', () => {
    clearClientCache();
  });
}
