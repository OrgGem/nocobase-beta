// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import type { HaproxyConnectionPublic, HaproxyUserPermissions } from '../../shared/types';
import { useHaproxyApi } from '../api';
import { getErrorMessage } from '../utils/format';

const SESSION_KEY = 'nb_haproxy_selected_connection_id';

function readStoredConnectionId(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    const num = raw ? Number(raw) : NaN;
    return Number.isInteger(num) && num > 0 ? num : null;
  } catch {
    return null;
  }
}

function writeStoredConnectionId(id: number | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id) {
      window.sessionStorage.setItem(SESSION_KEY, String(id));
    } else {
      window.sessionStorage.removeItem(SESSION_KEY);
    }
  } catch {
    // Ignore storage quota / privacy mode errors.
  }
}

export function useHaproxySession(fixedConnectionId?: number) {
  const api = useHaproxyApi();
  const [permissions, setPermissions] = useState<HaproxyUserPermissions | null>(null);
  const [connections, setConnections] = useState<HaproxyConnectionPublic[]>([]);
  const [selectedConnectionId, setSelectedState] = useState<number | null>(
    fixedConnectionId ?? readStoredConnectionId(),
  );
  const [bootstrapping, setBootstrapping] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  const setSelectedConnectionId = useCallback(
    (nextId: number | null) => {
      setSelectedState(nextId);
      if (!fixedConnectionId) {
        writeStoredConnectionId(nextId);
      }
    },
    [fixedConnectionId],
  );

  useEffect(() => {
    if (fixedConnectionId) {
      setSelectedState(fixedConnectionId);
    }
  }, [fixedConnectionId]);

  const reloadSession = useCallback(async () => {
    setBootstrapping(true);
    setBootstrapError(null);
    try {
      const perms = await api.myPermissions();
      setPermissions(perms);
      if (!perms.canAccess) {
        setConnections([]);
        return;
      }
      const rows = await api.listConnections();
      const enabled = rows.filter((c) => c.enabled);
      setConnections(enabled);
      setSelectedState((prev) => {
        if (fixedConnectionId && enabled.some((c) => c.id === fixedConnectionId)) {
          return fixedConnectionId;
        }
        if (prev && enabled.some((c) => c.id === prev)) {
          return prev;
        }
        const stored = readStoredConnectionId();
        if (stored && enabled.some((c) => c.id === stored)) {
          return stored;
        }
        const first = enabled[0]?.id ?? null;
        if (!fixedConnectionId && first) {
          writeStoredConnectionId(first);
        }
        return first;
      });
    } catch (err) {
      setBootstrapError(getErrorMessage(err));
    } finally {
      setBootstrapping(false);
    }
  }, [api, fixedConnectionId]);

  useEffect(() => {
    reloadSession();
  }, [reloadSession]);

  return {
    permissions,
    connections,
    selectedConnectionId,
    setSelectedConnectionId,
    bootstrapping,
    bootstrapError,
    reloadSession,
  };
}
