import React from 'react';
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

export default function RegistryManagerPage({ permissions }: DockerRegistryPageProps) {
  const location = useLocation();
  const view = resolveRegistryManagerView(location.search);

  if (view.page === 'image') {
    return <ImageDetailsPage permissions={permissions} />;
  }
  if (view.page === 'repository') {
    return <RepositoryPage permissions={permissions} />;
  }
  return <RegistryBrowserPage permissions={permissions} />;
}
