/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Custom DeleteCollection component for Elasticsearch data source plugin.
 * This component handles the delete action properly for external data sources
 * by using the correct API endpoint with the data source key.
 */

import { DeleteOutlined, ExclamationCircleFilled } from '@ant-design/icons';
import { css } from '@emotion/css';
import { useForm } from '@formily/react';
import { Button, Modal, message } from 'antd';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import {
  ActionContextProvider,
  RecordProvider,
  SchemaComponent,
  useAPIClient,
  useRecord,
  useResourceActionContext,
} from '@nocobase/client';
import { useCancelAction, useCollectionManager_deprecated } from '@nocobase/client';

export const ElasticsearchDeleteCollection = (props: any) => {
  const record = useRecord();
  return <ElasticsearchDeleteCollectionAction item={record} {...props} />;
};

const useDestroyActionForExternalDS = () => {
  const { refresh } = useResourceActionContext();
  const { name: dataSourceKey } = useParams<{ name: string }>();
  const record = useRecord();
  const api = useAPIClient();
  const form = useForm();
  const { cascade } = form?.values || {};
  const collectionName = record?.name;

  return {
    async run() {
      if (!collectionName) {
        message.error('Collection name is missing');
        return;
      }

      try {
        await api.request({
          url: `dataSources/${dataSourceKey}/collections:destroy`,
          method: 'post',
          params: {
            filterByTk: collectionName,
            cascade,
          },
        });
        message.success('Collection deleted successfully');
        refresh();
      } catch (error: any) {
        message.error(error?.response?.data?.errors?.[0]?.message || 'Failed to delete collection');
        throw error;
      }
    },
  };
};

const useDestroyActionAndRefreshCMForExternalDS = () => {
  const { run } = useDestroyActionForExternalDS();
  const { refreshCM } = useCollectionManager_deprecated();
  return {
    async run() {
      await run();
      await refreshCM();
    },
  };
};

export const ElasticsearchDeleteCollectionAction = (props: any) => {
  const { scope, getContainer, item: record, children, isBulk, useAction, ...otherProps } = props;
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  const getDestroyCollectionAction = () => {
    if (useAction) {
      return useAction;
    }
    return useDestroyActionAndRefreshCMForExternalDS;
  };

  const Title = () => {
    return (
      <span>
        <ExclamationCircleFilled style={{ color: '#faad14', marginRight: '12px', fontSize: '22px' }} />
        <span style={{ fontSize: '19px' }}>{t('Delete collection')}</span>
      </span>
    );
  };

  return (
    // @ts-ignore - RecordProvider's type definition doesn't include children but supports them
    <RecordProvider record={record} isNew={false}>
      <ActionContextProvider value={{ visible, setVisible }}>
        {isBulk ? (
          <Button icon={<DeleteOutlined />} onClick={() => setVisible(true)}>
            {children || t('Delete')}
          </Button>
        ) : (
          <a onClick={() => setVisible(true)} {...otherProps}>
            {children || t('Delete')}
          </a>
        )}
        <SchemaComponent
          schema={{
            type: 'object',
            properties: {
              deleteCollection: {
                type: 'void',
                'x-decorator': 'Form',
                'x-component': 'Action.Modal',
                title: <Title />,
                'x-component-props': {
                  width: 520,
                  getContainer: '{{ getContainer }}',
                  className: css`
                    .ant-modal-body {
                      margin-left: 35px;
                      margin-bottom: 35px;
                      .ant-checkbox-wrapper {
                        height: 25px;
                      }
                    }
                  `,
                },
                properties: {
                  info: {
                    type: 'string',
                    'x-component': 'div',
                    'x-content': "{{t('Are you sure you want to delete it?')}}",
                  },
                  footer: {
                    type: 'void',
                    'x-component': 'Action.Modal.Footer',
                    properties: {
                      action1: {
                        title: '{{ t("Cancel") }}',
                        'x-component': 'Action',
                        'x-component-props': {
                          useAction: '{{ useCancelAction }}',
                        },
                      },
                      action2: {
                        title: '{{ t("Ok") }}',
                        'x-component': 'Action',
                        'x-component-props': {
                          type: 'primary',
                          useAction: '{{ useDestroyCollectionAction }}',
                          style: {
                            marginLeft: '8px',
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          }}
          scope={{
            getContainer,
            useDestroyCollectionAction: getDestroyCollectionAction(),
            useCancelAction,
            ...scope,
          }}
        />
      </ActionContextProvider>
    </RecordProvider>
  );
};

ElasticsearchDeleteCollectionAction.displayName = 'ElasticsearchDeleteCollectionAction';
