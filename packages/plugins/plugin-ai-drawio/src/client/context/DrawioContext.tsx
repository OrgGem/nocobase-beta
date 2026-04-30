import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { DrawioBridge } from '../lib/drawioBridge';

type DiagramHandle = {
  blockUid: string;
  diagramId: string;
  bridge: DrawioBridge;
  getXml: () => string;
};

type DrawioContextValue = {
  registerHandle: (handle: DiagramHandle) => () => void;
  setActiveBlock: (blockUid: string | null) => void;
  getActiveHandle: () => DiagramHandle | null;
  getHandle: (blockUid: string) => DiagramHandle | null;
  activeBlockUid: string | null;
  baseUrl: string;
  setBaseUrl: (url: string) => void;
};

const Ctx = createContext<DrawioContextValue | null>(null);

export const DrawioContextProvider: React.FC<{ children: React.ReactNode; defaultBaseUrl?: string }> = ({
  children,
  defaultBaseUrl,
}) => {
  const handlesRef = useRef<Map<string, DiagramHandle>>(new Map());
  const [activeBlockUid, setActiveBlockUid] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState<string>(defaultBaseUrl || '');

  const registerHandle = useCallback((handle: DiagramHandle) => {
    handlesRef.current.set(handle.blockUid, handle);
    setActiveBlockUid((prev) => prev || handle.blockUid);
    return () => {
      handlesRef.current.delete(handle.blockUid);
      setActiveBlockUid((prev) => (prev === handle.blockUid ? null : prev));
    };
  }, []);

  const setActiveBlock = useCallback((blockUid: string | null) => {
    setActiveBlockUid(blockUid);
  }, []);

  const getActiveHandle = useCallback(() => {
    if (!activeBlockUid) {
      const first = handlesRef.current.values().next().value;
      return first || null;
    }
    return handlesRef.current.get(activeBlockUid) || null;
  }, [activeBlockUid]);

  const getHandle = useCallback((blockUid: string) => handlesRef.current.get(blockUid) || null, []);

  const value = useMemo<DrawioContextValue>(
    () => ({
      registerHandle,
      setActiveBlock,
      getActiveHandle,
      getHandle,
      activeBlockUid,
      baseUrl,
      setBaseUrl,
    }),
    [registerHandle, setActiveBlock, getActiveHandle, getHandle, activeBlockUid, baseUrl],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export function useDrawioContext() {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error('useDrawioContext must be used within DrawioContextProvider');
  }
  return v;
}

export function useOptionalDrawioContext() {
  return useContext(Ctx);
}
