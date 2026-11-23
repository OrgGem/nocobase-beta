// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RcloneConnectionPublic, RcloneUserPermissions } from '../../shared/types';
import { useRcloneApi } from '../api';

const STORAGE_KEY = 'nocobase:rclone-manager:selectedConnectionId';

const DEFAULT_PERMISSIONS: RcloneUserPermissions = {
  canAccess: false,
  canRead: false,
  canTransfer: false,
  canManageRemotes: false,
  canLocalFs: false,
  canMounts: false,
  canServes: false,
  canRawConfig: false,
  canManageConnections: false,
  canManage: false,
};

function readStoredConnectionId(): number | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const num = Number(raw);
    return Number.isFinite(num) && num > 0 ? num : null;
  } catch {
    return null;
  }
}

function writeStoredConnectionId(id: number | null): void {
  try {
    if (id) {
      window.sessionStorage.setItem(STORAGE_KEY, String(id));
    } else {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures in private browsing modes
  }
}

export function useRcloneSession() {
  const api = useRcloneApi();
  const [permissions, setPermissions] = useState<RcloneUserPermissions>(DEFAULT_PERMISSIONS);
  const [connections, setConnections] = useState<RcloneConnectionPublic[]>([]);
  const [selectedConnectionId, setSelectedConnectionIdState] = useState<number | null>(() => readStoredConnectionId());
  const [loading, setLoading] = useState<boolean>(true);

  const setSelectedConnectionId = useCallback((id: number | null) => {
    setSelectedConnectionIdState(id);
    writeStoredConnectionId(id);
  }, []);

  const refreshSession = useCallback(async () => {
    setLoading(true);
    try {
      const [perms, conns] = await Promise.all([
        api.myPermissions(),
        api.listConnections().catch(() => [] as RcloneConnectionPublic[]),
      ]);
      setPermissions(perms);
      const enabledConns = conns.filter((item) => item.enabled);
      setConnections(conns);

      setSelectedConnectionIdState((prev) => {
        if (prev && enabledConns.some((c) => c.id === prev)) {
          return prev;
        }
        const fallback = enabledConns[0]?.id ?? null;
        writeStoredConnectionId(fallback);
        return fallback;
      });
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  const activeConnection = useMemo(
    () => connections.find((c) => c.id === selectedConnectionId && c.enabled) ?? null,
    [connections, selectedConnectionId],
  );

  return {
    permissions,
    connections,
    enabledConnections: useMemo(() => connections.filter((c) => c.enabled), [connections]),
    selectedConnectionId: activeConnection?.id ?? null,
    activeConnection,
    setSelectedConnectionId,
    refreshSession,
    loading,
  };
}
