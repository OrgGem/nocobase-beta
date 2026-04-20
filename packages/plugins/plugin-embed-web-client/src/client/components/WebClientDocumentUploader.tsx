/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useState, useCallback, useRef } from 'react';
import { useAPIClient, useTranslation } from '@nocobase/client';
import { Button, Upload, Progress, Space, Typography, Alert, List, Tag, Tooltip } from 'antd';
import {
  InboxOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { EmbeddingWorkerProvider, useEmbeddingWorker } from './EmbeddingWorkerProvider';

const { Text } = Typography;
const { Dragger } = Upload;

type StageLabel = 'queued' | 'reading' | 'chunking' | 'embedding' | 'saving' | 'done' | 'error';

interface FileEntry {
  uid: string;
  name: string;
  stage: StageLabel;
  progress: number; // 0–100
  error?: string;
  chunkCount?: number;
}

export interface WebClientDocumentUploaderProps {
  knowledgeBaseId: string;
  onComplete?: () => void;
}

/**
 * Inner component that uses the worker context.
 * Wrapped by EmbeddingWorkerProvider externally.
 */
const WebClientDocumentUploaderInner: React.FC<WebClientDocumentUploaderProps> = ({ knowledgeBaseId, onComplete }) => {
  const api = useAPIClient();
  const { t } = useTranslation('plugin-embed-web-client');
  const { state: workerState, modelProgress, config, ensureReady, processDocument } = useEmbeddingWorker();
  const [queue, setQueue] = useState<FileEntry[]>([]);
  const [processing, setProcessing] = useState(false);

  // Mutex to serialize processQueue calls (M-3 fix)
  const processingLockRef = useRef<Promise<void>>(Promise.resolve());

  const STAGE_LABELS: Record<StageLabel, string> = {
    queued: t('Queued'),
    reading: t('Reading file…'),
    chunking: t('Chunking…'),
    embedding: t('Embedding…'),
    saving: t('Saving vectors…'),
    done: t('Done'),
    error: t('Error'),
  };

  const updateEntry = useCallback((uid: string, patch: Partial<FileEntry>) => {
    setQueue((prev) => prev.map((e) => (e.uid === uid ? { ...e, ...patch } : e)));
  }, []);

  const processQueueInternal = useCallback(
    async (entries: FileEntry[], files: Map<string, File>) => {
      setProcessing(true);

      // Ensure the worker model is loaded before processing
      await ensureReady();

      for (const entry of entries) {
        const file = files.get(entry.uid);
        if (!file) continue;

        try {
          // 1. Read file content
          updateEntry(entry.uid, { stage: 'reading', progress: 5 });
          const text = await file.text();

          // 2. Create document record on server (status: pending_client)
          const docRes = await api.request({
            url: 'aiKnowledgeBaseDoc:create',
            method: 'post',
            data: {
              values: {
                knowledgeBaseId,
                filename: file.name,
                textContent: text,
                status: 'pending_client',
              },
            },
          });
          const documentId = docRes?.data?.data?.id;
          if (!documentId) throw new Error(t('Failed to create document record'));

          // 3. Chunk + embed in browser worker
          updateEntry(entry.uid, { stage: 'embedding', progress: 10 });
          const { chunks } = await processDocument({
            documentId,
            text,
            metadata: { filename: file.name, knowledgeBaseId },
            onProgress: (embedded, total) => {
              const pct = total > 0 ? Math.round(10 + (embedded / total) * 75) : 10;
              updateEntry(entry.uid, { stage: 'embedding', progress: pct });
            },
          });

          // 4. Send vectors to server
          updateEntry(entry.uid, { stage: 'saving', progress: 88 });
          await api.request({
            url: 'embedWebClient:storeVectors',
            method: 'post',
            data: { documentId, chunks },
          });

          updateEntry(entry.uid, { stage: 'done', progress: 100, chunkCount: chunks.length });
        } catch (err: any) {
          updateEntry(entry.uid, { stage: 'error', progress: 0, error: err?.message ?? t('Unknown error') });
        }
      }

      setProcessing(false);
      onComplete?.();
    },
    [api, knowledgeBaseId, processDocument, updateEntry, onComplete, ensureReady, t],
  );

  // Serialize concurrent processQueue calls (M-3 fix)
  const processQueue = useCallback(
    (entries: FileEntry[], files: Map<string, File>) => {
      processingLockRef.current = processingLockRef.current.then(() => processQueueInternal(entries, files));
    },
    [processQueueInternal],
  );

  const handleDrop = useCallback(
    (acceptedFiles: File[]) => {
      const newEntries: FileEntry[] = acceptedFiles.map((f) => ({
        uid: `${Date.now()}-${f.name}`,
        name: f.name,
        stage: 'queued' as const,
        progress: 0,
      }));
      const fileMap = new Map(acceptedFiles.map((f, i) => [newEntries[i].uid, f]));

      setQueue((prev) => [...prev, ...newEntries]);
      processQueue(newEntries, fileMap);
    },
    [processQueue],
  );

  // ── Model status banner ────────────────────────────────────────────────────

  const renderModelStatus = () => {
    if (workerState === 'loading_model') {
      return (
        <Alert
          type="info"
          showIcon
          icon={<LoadingOutlined />}
          message={`${t('Model downloading…')} ${modelProgress}%`}
          description={<Progress percent={modelProgress} size="small" status="active" />}
          style={{ marginBottom: 16 }}
        />
      );
    }
    if (workerState === 'ready' || workerState === 'processing') {
      return (
        <Alert
          type="success"
          showIcon
          icon={<ThunderboltOutlined />}
          message={`${t('Model ready')}: ${config?.modelId ?? ''} (${config?.dimensions ?? 384}-dim)`}
          style={{ marginBottom: 16 }}
        />
      );
    }
    if (workerState === 'error') {
      return (
        <Alert
          type="error"
          showIcon
          message={t('Embedding worker error — reload the page to retry')}
          style={{ marginBottom: 16 }}
        />
      );
    }
    return null;
  };

  // ── Upload dragger ─────────────────────────────────────────────────────────

  const isReady = workerState === 'idle' || workerState === 'ready' || workerState === 'processing';

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {renderModelStatus()}

      <Dragger
        name="file"
        multiple
        accept=".txt,.md,.csv,.json"
        showUploadList={false}
        disabled={workerState === 'loading_model' || workerState === 'error' || processing}
        beforeUpload={(file, fileList) => {
          if (file === fileList[fileList.length - 1]) {
            handleDrop(fileList as unknown as File[]);
          }
          return false; // prevent ant Upload's own network upload
        }}
      >
        <p className="ant-upload-drag-icon" style={{ marginBottom: 8 }}>
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">{t('Drop text files here or click to upload')}</p>
        <p className="ant-upload-hint" style={{ opacity: 0.6 }}>
          {t('Supports: .txt, .md, .csv, .json')} —{' '}
          {t(
            "Documents will be embedded in the user's browser using a lightweight AI model. No API cost for embedding.",
          )}
        </p>
      </Dragger>

      {queue.length > 0 && (
        <List
          size="small"
          header={<Text strong>{t('Processing queue')}</Text>}
          bordered
          dataSource={queue}
          renderItem={(entry) => {
            const isDone = entry.stage === 'done';
            const isError = entry.stage === 'error';
            const isActive = !isDone && !isError;

            return (
              <List.Item
                extra={
                  isDone ? (
                    <Tooltip title={`${entry.chunkCount} ${t('chunks stored')}`}>
                      <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 18 }} />
                    </Tooltip>
                  ) : isError ? (
                    <Tooltip title={entry.error}>
                      <CloseCircleOutlined style={{ color: '#ff4d4f', fontSize: 18 }} />
                    </Tooltip>
                  ) : (
                    <LoadingOutlined style={{ color: '#1890ff', fontSize: 18 }} />
                  )
                }
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <Text ellipsis style={{ maxWidth: 300 }}>
                        {entry.name}
                      </Text>
                      <Tag color={isDone ? 'success' : isError ? 'error' : 'processing'}>
                        {STAGE_LABELS[entry.stage]}
                      </Tag>
                    </Space>
                  }
                  description={
                    isActive ? (
                      <Progress percent={entry.progress} size="small" status="active" style={{ marginBottom: 0 }} />
                    ) : isError ? (
                      <Text type="danger" style={{ fontSize: 12 }}>
                        {entry.error}
                      </Text>
                    ) : (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {entry.chunkCount} {t('chunks embedded & stored')}
                      </Text>
                    )
                  }
                />
              </List.Item>
            );
          }}
        />
      )}
    </Space>
  );
};

/**
 * Public wrapper: wraps the uploader with EmbeddingWorkerProvider
 * so the worker is only loaded when this component mounts (not globally).
 */
export const WebClientDocumentUploader: React.FC<WebClientDocumentUploaderProps> = (props) => {
  return (
    <EmbeddingWorkerProvider>
      <WebClientDocumentUploaderInner {...props} />
    </EmbeddingWorkerProvider>
  );
};
