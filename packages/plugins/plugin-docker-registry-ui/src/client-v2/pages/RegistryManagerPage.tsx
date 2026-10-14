import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { DockerRegistryPageProps } from '../permissions';
import ImageDetailsPage from './ImageDetailsPage';
import RegistryBrowserPage from './RegistryBrowserPage';
import RepositoryPage from './RepositoryPage';

export type RegistryManagerView =
  | { page: 'images' }
  | { page: 'repository'; repository: string }
  | { page: 'image'; repository: string; tag: string };

export function resolveRegistryManagerView(search: string): RegistryManagerView {
  const params = new URLSearchParams(search);
  const repository = params.get('name');
  const tag = params.get('tag');

  if (repository && tag) return { page: 'image', repository, tag };
  if (repository) return { page: 'repository', repository };
  return { page: 'images' };
}

export default function RegistryManagerPage({ permissions, embedded }: DockerRegistryPageProps) {
  const location = useLocation();
  const [embeddedSearch, setEmbeddedSearch] = useState('');
  const search = embedded ? embeddedSearch : location.search;
  const view = resolveRegistryManagerView(search);
  const pageProps: DockerRegistryPageProps = {
    permissions,
    embedded,
    search,
    onNavigate: embedded ? (path) => setEmbeddedSearch(new URL(path, window.location.origin).search) : undefined,
  };

  if (view.page === 'image') {
    return <ImageDetailsPage {...pageProps} />;
  }
  if (view.page === 'repository') {
    return <RepositoryPage {...pageProps} />;
  }
  return <RegistryBrowserPage {...pageProps} />;
}
