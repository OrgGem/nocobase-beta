import { useEffect } from 'react';
import { useApp } from '@nocobase/client-v2';

const SETTINGS_KEY = 'sftpgo-integration';
const DEPENDENT_TABS = ['users', 'folders', 'apikeys'] as const;
const CONNECTIONS_CHANGED_EVENT = 'sftpgoConnections:changed';

async function fetchEnabledConnectionCount(api: any): Promise<number> {
  const res = await api.request({
    url: 'sftpgoConnections:list',
    params: { filter: { enabled: true }, pageSize: 1 },
  });
  const data = (res?.data?.data as unknown[]) || [];
  return data.length;
}

export function notifySftpgoConnectionsChanged(app: { eventBus: EventTarget }) {
  app.eventBus.dispatchEvent(new CustomEvent(CONNECTIONS_CHANGED_EVENT));
}

export function useSftpgoTabVisibility() {
  const app = useApp();

  useEffect(() => {
    let cancelled = false;
    const apply = async () => {
      try {
        const count = await fetchEnabledConnectionCount(app.apiClient);
        if (cancelled) return;
        for (const key of DEPENDENT_TABS) {
          app.pluginSettingsManager.addPageTabItem({
            menuKey: SETTINGS_KEY,
            key,
            hidden: count === 0,
          });
        }
      } catch {
        if (cancelled) return;
        for (const key of DEPENDENT_TABS) {
          app.pluginSettingsManager.addPageTabItem({
            menuKey: SETTINGS_KEY,
            key,
            hidden: true,
          });
        }
      }
    };

    apply();

    const listener = () => {
      apply();
    };
    app.eventBus.addEventListener(CONNECTIONS_CHANGED_EVENT, listener);

    return () => {
      cancelled = true;
      app.eventBus.removeEventListener(CONNECTIONS_CHANGED_EVENT, listener);
    };
  }, [app]);
}
