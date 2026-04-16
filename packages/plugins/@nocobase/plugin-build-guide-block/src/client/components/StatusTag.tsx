import React from 'react';
import { Tag } from 'antd';
import { useField } from '@formily/react';

const colors = {
  draft: 'default',
  building: 'blue',
  completed: 'success',
  error: 'error',
};

export const StatusTag = (props: any) => {
  const field = useField();
  const value = props.value || (field as any).value;
  if (!value) return null;
  return <Tag color={colors[value] || 'default'}>{String(value).toUpperCase()}</Tag>;
};
