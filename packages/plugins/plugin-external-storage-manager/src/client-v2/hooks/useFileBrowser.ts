/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useApp } from '@nocobase/client-v2';
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
  url?: string;
  downloadUrl?: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: number;
  mimetype?: string;
}

export interface PaginationMeta {
  total: number | null;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
  nextContinuationToken?: string;
}

type LoadFiles = (directoryId?: number, path?: string, page?: number, size?: number, search?: string) => Promise<void>;

function normalizeVirtualPath(path: string) {
  const normalized = (path || '/').replace(/\\/g, '/').replace(/\/+/g, '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

export function useFileBrowser() {
  const api = useApp().apiClient;
  const [directories, setDirectories] = useState<DirectoryInfo[]>([]);
  const [currentDir, setCurrentDir] = useState<DirectoryInfo | null>(null);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [currentPath, setCurrentPath] = useState<string>('/');
  const [loading, setLoading] = useState(false);
  const [dirLoading, setDirLoading] = useState(true);
  const mountedRef = useRef(true);

  // Pagination state â€” server-driven
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [totalItems, setTotalItems] = useState(0);
  const [paginationMeta, setPaginationMeta] = useState<PaginationMeta | null>(null);

  // Search state â€” sent to server
  const [searchText, setSearchText] = useState('');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentDirRef = useRef<DirectoryInfo | null>(currentDir);
  const currentPathRef = useRef(currentPath);
  const pageSizeRef = useRef(pageSize);
  const loadFilesRef = useRef<LoadFiles | null>(null);
  const previousSearchTextRef = useRef(searchText);
  const previousDirectoryIdRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    currentDirRef.current = currentDir;
  }, [currentDir]);

  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  useEffect(() => {
    pageSizeRef.current = pageSize;
  }, [pageSize]);

  // Load accessible directories
  const loadDirectories = useCallback(async () => {
    try {
      setDirLoading(true);
      const res = await api.request({
        url: 'extStorage:directories',
        method: 'get',
      });
      const dirs = Array.isArray(res?.data?.data?.data)
        ? res.data.data.data
        : Array.isArray(res?.data?.data)
          ? res.data.data
          : Array.isArray(res?.data)
            ? res.data
            : Array.isArray(res)
              ? res
              : [];
      if (mountedRef.current) {
        setDirectories(dirs);
        // Auto-select first directory if none selected
        if (dirs.length > 0 && !currentDirRef.current) {
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

  /**
   * Load files in current directory + path with server-side pagination.
   * @param directoryId â€” optional override directory ID
   * @param path â€” optional override path
   * @param page â€” page number (1-based), defaults to currentPage
   * @param size â€” page size, defaults to current pageSize
   * @param search â€” optional search/filter text sent to the server
   */
  const loadFiles = useCallback<LoadFiles>(
    async (directoryId?: number, path?: string, page?: number, size?: number, search?: string) => {
      const dirId = directoryId || currentDir?.id;
      const filePath = path ?? currentPath;
      if (!dirId) return;

      const pg = page ?? currentPage;
      const ps = size ?? pageSize;
      const offset = (pg - 1) * ps;

      try {
        setLoading(true);
        const params: Record<string, any> = {
          directoryId: dirId,
          path: filePath,
          limit: ps,
          offset,
        };
        const searchTerm = search !== undefined ? search : searchText;
        if (searchTerm) {
          params.search = searchTerm;
        }
        const res = await api.request({
          url: 'extStorage:list',
          method: 'get',
          params,
        });
        if (mountedRef.current) {
          const rawData = Array.isArray(res?.data?.data?.data)
            ? res.data.data.data
            : Array.isArray(res?.data?.data)
              ? res.data.data
              : Array.isArray(res?.data)
                ? res.data
                : Array.isArray(res)
                  ? res
                  : [];
          const files = rawData.map((file: any) => {
            if (file.type === 'file') {
              // Preview/download requests carry the user's session token so
              // the auth middleware accepts them (same pattern as the S3/SFTP
              // private storage players). The download endpoint then re-checks
              // the directory data-scope for the current user.
              const inlineUrl = new URLSearchParams({
                directoryId: String(dirId),
                path: file.path,
                mode: 'inline',
              });
              const attachmentUrl = new URLSearchParams({
                directoryId: String(dirId),
                path: file.path,
                mode: 'attachment',
              });
              const token = (api as any).auth?.token || '';
              if (token) {
                inlineUrl.set('token', token);
                attachmentUrl.set('token', token);
              }
              return {
                ...file,
                url: `/api/extStorage:download?${inlineUrl.toString()}`,
                downloadUrl: `/api/extStorage:download?${attachmentUrl.toString()}`,
              };
            }
            return file;
          });
          setFiles(files);

          // Parse pagination metadata from response
          const meta = res?.data?.meta;
          if (meta) {
            setPaginationMeta(meta);
            if (typeof meta.total === 'number') {
              setTotalItems(meta.total);
            } else if (meta.hasMore !== undefined) {
              // If no total, estimate based on hasMore
              setTotalItems(meta.hasMore ? offset + files.length + 1 : offset + files.length);
            }
          }
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
    [api, currentDir, currentPath, currentPage, pageSize, searchText],
  );

  useEffect(() => {
    loadFilesRef.current = loadFiles;
  }, [loadFiles]);

  // Navigate to a directory or file â€” resets page to 1
  const navigateTo = useCallback(
    (item: FileItem | DirectoryInfo | string) => {
      setCurrentPage(1);
      if (typeof item === 'string') {
        // Navigate to a path string
        setCurrentPath(item);
        loadFiles(currentDir?.id, item, 1);
      } else if ('allowedActions' in item) {
        // It's a DirectoryInfo - select directory
        setCurrentDir(item as DirectoryInfo);
        setCurrentPath('/');
        loadFiles((item as DirectoryInfo).id, '/', 1);
      } else {
        // It's a FileItem
        const fileItem = item as FileItem;
        if (fileItem.type === 'directory') {
          const newPath = normalizeVirtualPath(fileItem.path);
          setCurrentPath(newPath);
          loadFiles(currentDir?.id, newPath, 1);
        }
      }
    },
    [currentDir, loadFiles],
  );

  // Navigate up one level â€” resets page to 1
  const navigateUp = useCallback(() => {
    if (currentPath === '/' || currentPath === '') return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    const newPath = '/' + parts.join('/');
    setCurrentPage(1);
    setCurrentPath(newPath);
    loadFiles(currentDir?.id, newPath, 1);
  }, [currentPath, currentDir, loadFiles]);

  // Change page â€” triggers new API request
  const changePage = useCallback(
    (page: number, size?: number) => {
      const ps = size ?? pageSize;
      setCurrentPage(page);
      if (size) setPageSize(size);
      loadFiles(currentDir?.id, currentPath, page, ps);
    },
    [currentDir, currentPath, pageSize, loadFiles],
  );

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
    [api, currentDir, loadFiles],
  );

  // Refresh current view
  const refresh = useCallback(() => {
    loadFiles();
  }, [loadFiles]);

  // Debounced search: reload files when search text changes
  useEffect(() => {
    if (previousSearchTextRef.current === searchText) {
      return;
    }
    previousSearchTextRef.current = searchText;
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }
    searchTimerRef.current = setTimeout(() => {
      const directory = currentDirRef.current;
      if (mountedRef.current && directory) {
        setCurrentPage(1);
        loadFilesRef.current?.(directory.id, currentPathRef.current, 1, pageSizeRef.current, searchText);
      }
    }, 300);
    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };
  }, [searchText]);

  // Initial load
  useEffect(() => {
    loadDirectories();
  }, [loadDirectories]);

  // Reload files when directory changes
  useEffect(() => {
    const directory = currentDirRef.current;
    if (directory && previousDirectoryIdRef.current !== directory.id) {
      previousDirectoryIdRef.current = directory.id;
      setCurrentPage(1);
      loadFilesRef.current?.(directory.id, currentPathRef.current, 1);
    }
  }, [currentDir?.id]);

  return {
    directories,
    currentDir,
    files,
    currentPath,
    loading,
    dirLoading,
    // Pagination
    currentPage,
    pageSize,
    totalItems,
    paginationMeta,
    changePage,
    setPageSize,
    // Search
    searchText,
    setSearchText,
    // Actions
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
