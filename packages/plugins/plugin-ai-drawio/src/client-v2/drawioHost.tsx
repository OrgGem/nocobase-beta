/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Drawer } from 'antd';
import { DrawioBlock } from './DrawioBlock';
import { getDiagram, getDiagramState, setDrawerOpen, subscribeDiagramState } from './diagramStore';

/**
 * Shared draw.io drawer, rendered via a React portal.
 * Single global diagram - no session management needed.
 */

const hosts = new Set<symbol>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of Array.from(listeners)) {
    listener();
  }
}

export function useDrawioHost(): boolean {
  const host = useRef(Symbol('drawio-host')).current;
  const leader = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => hosts.values().next().value === host,
    () => false,
  );
  useEffect(() => {
    hosts.add(host);
    emit();
    return () => {
      hosts.delete(host);
      emit();
    };
  }, [host]);
  return leader;
}

/** The actual drawer content, portaled to document.body. */
export const DrawioHostPortal: React.FC = () => {
  const [state, setState] = useState(() => getDiagramState());

  useEffect(() => {
    return subscribeDiagramState((s) => {
      setState(s);
    });
  }, []);

  const title = state.diagram?.title || 'Drawio Diagram';

  return createPortal(
    <Drawer
      open={state.drawerOpen}
      onClose={() => setDrawerOpen(false)}
      width="100%"
      title={title}
      destroyOnClose
      zIndex={1000}
      styles={{ body: { padding: 0 } }}
    >
      {state.drawerOpen && state.diagram ? <DrawioBlock /> : null}
    </Drawer>,
    document.body,
  );
};
