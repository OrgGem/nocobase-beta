import React from 'react';
import { useApp } from '@nocobase/client-v2';
import OidcClientsPageView from '../shared/OidcClientsPage';
import { useT } from './locale';

export default function OidcClientsPage() {
  return <OidcClientsPageView api={useApp().apiClient} t={useT()} />;
}
