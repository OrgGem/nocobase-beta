import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Drawer } from 'antd';
import { DrawioBlock } from './DrawioBlock';
import { getDiagram, getDiagramState, setDrawerOpen, subscribeDiagramState } from './diagramStore';

/**
 * Shared draw.io drawer, rendered via a React portal.
 * Single global diagram - no session management needed.
 */

let mounted = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of Array.from(listeners)) {
    listener();
  }
}

export function useDrawioHost(): boolean {
  const [isMounted, setIsMounted] = useState(() => mounted);

  useEffect(() => {
    if (!mounted) {
      mounted = true;
      setIsMounted(true);
      emit();
    }

    return () => {
      mounted = false;
      setIsMounted(false);
      emit();
    };
  }, []);

  return isMounted;
}

/** The actual drawer content, portaled to document.body. */
export const DrawioHostPortal: React.FC = () => {
  const [state, setState] = useState(() => getDiagramState());

  useEffect(() => {
    return subscribeDiagramState((s) => {
      setState(s);
    });
  }, []);

  const current = state.diagram;
  const title = current?.title || 'Drawio Diagram';

  return createPortal(
    <Drawer
      open={state.drawerOpen}
      onClose={() => setDrawerOpen(false)}
      width="100%"
      title={title}
      destroyOnClose
      styles={{ body: { padding: 0 } }}
    >
      {state.drawerOpen && current ? <DrawioBlock /> : null}
    </Drawer>,
    document.body,
  );
};
