import React from 'react';
import { useAPIClient } from '@nocobase/client';
import OidcClientsPageView from '../shared/OidcClientsPage';
import { useT } from './locale';

export default function OidcClientsPage() {
  return <OidcClientsPageView api={useAPIClient()} t={useT()} />;
}
