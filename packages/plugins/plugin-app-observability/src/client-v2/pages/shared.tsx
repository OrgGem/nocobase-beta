import { Alert, Button, Empty, Skeleton, Tag } from 'antd';
import React from 'react';
import { useT } from '../locale';

export const bytes = (value?: number | null) => (value == null ? '—' : `${(value / 1024 / 1024).toFixed(1)} MB`);
export const percent = (value?: number | null) => (value == null ? '—' : `${value.toFixed(1)}%`);
export function DataState({
  loading,
  error,
  empty,
  retry,
  children,
}: {
  loading: boolean;
  error: unknown;
  empty: boolean;
  retry: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  if (loading) return <Skeleton active aria-label={t('Loading')} />;
  if (error)
    return (
      <Alert
        type="error"
        showIcon
        message={t('Unable to load data')}
        action={<Button onClick={retry}>{t('Retry')}</Button>}
      />
    );
  if (empty) return <Empty description={t('No observability data yet')} />;
  return <>{children}</>;
}
export function CapacityTag({ state }: { state?: string }) {
  const t = useT();
  const color = state === 'critical' ? 'red' : state === 'scale-soon' ? 'orange' : state === 'watch' ? 'gold' : 'green';
  return <Tag color={color}>{t(state ?? 'unknown')}</Tag>;
}
