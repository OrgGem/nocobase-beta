/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useAPIClient } from '@nocobase/client';
import { useState, useCallback, useEffect, useRef } from 'react';

export interface DirectoryInfo {
  id: number;
  name: string;
  slug: string;
  storageType: string;
  storageConfigName: string;
  rootPath: string;
  description?: string;
  enabled: boolean;
  sort: number;
  allowedActions: string[];
}

export interface FileItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: number;
  mimetype?: string;
}

function normalizeVirtualPath(path: string) {
  const normalized = (path || '/').replace(/\\/g, '/').replace(/\/+/g, '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

export function useFileBrowser() {
  const api = useAPIClient();
  const [directories, setDirectories] = useState<DirectoryInfo[]>([]);
  const [currentDir, setCurrentDir] = useState<DirectoryInfo | null>(null);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [currentPath, setCurrentPath] = useState<string>('/');
  const [loading, setLoading] = useState(false);
  const [dirLoading, setDirLoading] = useState(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load accessible directories
  const loadDirectories = useCallback(async () => {
    try {
      setDirLoading(true);
      const res = await api.request({
        url: 'extStorage:directories',
        method: 'get',
      });
      const dirs = Array.isArray(res?.data?.data?.data) ? res.data.data.data : Array.isArray(res?.data?.data) ? res.data.data : Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      if (mountedRef.current) {
        setDirectories(dirs);
        // Auto-select first directory if none selected
        if (dirs.length > 0 && !currentDir) {
          setCurrentDir(dirs[0]);
        }
      }
    } catch (error) {
      console.error('[ext-storage] Failed to load directories:', error);
    } finally {
      if (mountedRef.current) {
        setDirLoading(false);
      }
    }
  }, [api]);

  // Load files in current directory + path
  const loadFiles = useCallback(
    async (directoryId?: number, path?: string) => {
      const dirId = directoryId || currentDir?.id;
      const filePath = path ?? currentPath;
      if (!dirId) return;

      try {
        setLoading(true);
        const res = await api.request({
          url: 'extStorage:list',
          method: 'get',
          params: {
            directoryId: dirId,
            path: filePath,
          },
        });
        if (mountedRef.current) {
          const rawData = Array.isArray(res?.data?.data?.data) ? res.data.data.data : Array.isArray(res?.data?.data) ? res.data.data : Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
          const files = rawData.map((file: any) => {
            if (file.type === 'file') {
              const params = new URLSearchParams({
                directoryId: String(dirId),
                path: file.path,
                mode: 'inline',
              });
              return {
                ...file,
                url: `/api/extStorage:download?${params.toString()}`
              };
            }
            return file;
          });
          setFiles(files);
        }
      } catch (error) {
        console.error('[ext-storage] Failed to load files:', error);
        if (mountedRef.current) {
          setFiles([]);
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false);
        }
      }
    },
    [api, currentDir, currentPath],
  );

  // Navigate to a directory or file
  const navigateTo = useCallback(
    (item: FileItem | DirectoryInfo | string) => {
      if (typeof item === 'string') {
        // Navigate to a path string
        setCurrentPath(item);
        loadFiles(currentDir?.id, item);
      } else if ('allowedActions' in item) {
        // It's a DirectoryInfo - select directory
        setCurrentDir(item as DirectoryInfo);
        setCurrentPath('/');
        loadFiles((item as DirectoryInfo).id, '/');
      } else {
        // It's a FileItem
        const fileItem = item as FileItem;
        if (fileItem.type === 'directory') {
          const newPath = normalizeVirtualPath(fileItem.path);
          setCurrentPath(newPath);
          loadFiles(currentDir?.id, newPath);
        }
      }
    },
    [currentDir, loadFiles],
  );

  // Navigate up one level
  const navigateUp = useCallback(() => {
    if (currentPath === '/' || currentPath === '') return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    const newPath = '/' + parts.join('/');
    setCurrentPath(newPath);
    loadFiles(currentDir?.id, newPath);
  }, [currentPath, currentDir, loadFiles]);

  // Download a file
  const downloadFile = useCallback(
    (filePath: string) => {
      if (!currentDir) return;
      const token = (api as any).auth?.token || '';
      const params = new URLSearchParams({
        directoryId: String(currentDir.id),
        path: filePath,
        mode: 'attachment',
        token,
      });
      window.open(`/api/extStorage:download?${params.toString()}`, '_blank');
    },
    [currentDir, api],
  );

  const statItem = useCallback(
    async (filePath: string) => {
      if (!currentDir) return null;

      try {
        const res = await api.request({
          url: 'extStorage:stat',
          method: 'get',
          params: {
            directoryId: currentDir.id,
            path: filePath,
          },
        });

        const d1 = res?.data;
        const d2 = d1?.data;
        const d3 = d2?.data;

        if (d3 && typeof d3.name === 'string') return d3;
        if (d2 && typeof d2.name === 'string') return d2;
        if (d1 && typeof d1.name === 'string') return d1;

        return null;
      } catch (e) {
        return null;
      }
    },
    [api, currentDir],
  );

  // Upload files
  const uploadFiles = useCallback(
    async (fileList: File[]) => {
      if (!currentDir) return [];

      const formData = new FormData();
      fileList.forEach((file) => {
        formData.append('file', file);
      });

      const res = await api.request({
        url: 'extStorage:upload',
        method: 'post',
        params: {
          directoryId: currentDir.id,
          path: currentPath,
        },
        data: formData,
      });

      // Reload files after upload
      await loadFiles();

      return res?.data?.data || [];
    },
    [api, currentDir, currentPath, loadFiles],
  );

  // Create folder
  const createFolder = useCallback(
    async (folderName: string) => {
      if (!currentDir) return;

      await api.request({
        url: 'extStorage:mkdir',
        method: 'post',
        params: {
          directoryId: currentDir.id,
          path: currentPath,
        },
        data: {
          values: { folderName },
        },
      });

      await loadFiles();
    },
    [api, currentDir, currentPath, loadFiles],
  );

  // Delete file or folder
  const deleteItem = useCallback(
    async (filePath: string, type: 'file' | 'directory') => {
      if (!currentDir) return;

      await api.request({
        url: 'extStorage:delete',
        method: 'post',
        params: {
          directoryId: currentDir.id,
          path: filePath,
        },
        data: {
          values: { type },
        },
      });

      await loadFiles();
    },
    [api, currentDir, currentPath, loadFiles],
  );

  // Refresh current view
  const refresh = useCallback(() => {
    loadFiles();
  }, [loadFiles]);

  // Initial load
  useEffect(() => {
    loadDirectories();
  }, [loadDirectories]);

  // Reload files when directory changes
  useEffect(() => {
    if (currentDir) {
      loadFiles(currentDir.id, currentPath);
    }
  }, [currentDir?.id]);

  return {
    directories,
    currentDir,
    files,
    currentPath,
    loading,
    dirLoading,
    navigateTo,
    navigateUp,
    downloadFile,
    statItem,
    uploadFiles,
    createFolder,
    deleteItem,
    refresh,
    setCurrentDir,
    loadDirectories,
  };
}
