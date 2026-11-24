// SPDX-License-Identifier: Apache-2.0

import {
  ColumnWidthOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  FileOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  SwapRightOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Breadcrumb,
  Button,
  Card,
  Checkbox,
  Col,
  Flex,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RcloneDiskInfo, RcloneListItem, RcloneRemoteSummary, RcloneTransferOperation } from '../../shared/types';
import { useRcloneApi } from '../api';
import { useRcloneSession } from '../hooks/useRcloneSession';
import { useT } from '../locale';
import { formatBytes, getErrorMessage } from '../utils/format';
import { ConnectionHeader } from './ConnectionHeader';

interface PaneSourceOption {
  value: string;
  label: string;
  isLocal: boolean;
  bucketBased?: boolean;
}

interface ExplorerPaneProps {
  paneTitle: string;
  connectionId: number;
  sources: PaneSourceOption[];
  fs: string;
  onChangeFs: (nextFs: string) => void;
  currentPath: string;
  onChangePath: (nextPath: string) => void;
  canTransfer: boolean;
  selectedItem: RcloneListItem | null;
  onSelectItem: (item: RcloneListItem | null) => void;
}

const ExplorerPane: React.FC<ExplorerPaneProps> = ({
  paneTitle,
  connectionId,
  sources,
  fs,
  onChangeFs,
  currentPath,
  onChangePath,
  canTransfer,
  selectedItem,
  onSelectItem,
}) => {
  const t = useT();
  const api = useRcloneApi();
  const [items, setItems] = useState<RcloneListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [filterText, setFilterText] = useState('');

  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [newDirName, setNewDirName] = useState('');
  const [renameTarget, setRenameTarget] = useState<RcloneListItem | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const requestSeqRef = useRef(0);

  const loadFiles = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    onSelectItem(null);
    if (!fs) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await api.listFiles(connectionId, fs, currentPath);
      if (requestSeqRef.current !== seq) return;
      const sorted = [...list].sort((a, b) => {
        if (a.IsDir !== b.IsDir) return a.IsDir ? -1 : 1;
        return a.Name.localeCompare(b.Name);
      });
      setItems(sorted);
    } catch (err) {
      if (requestSeqRef.current !== seq) return;
      setItems([]);
      message.error(getErrorMessage(err, t('Failed to list directory')));
    } finally {
      if (requestSeqRef.current === seq) {
        setLoading(false);
      }
    }
  }, [api, connectionId, currentPath, fs, onSelectItem, t]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  useEffect(
    () => () => {
      requestSeqRef.current += 1;
    },
    [],
  );

  const pathSegments = useMemo(() => currentPath.split('/').filter(Boolean), [currentPath]);

  const visibleItems = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.Name.toLowerCase().includes(q));
  }, [filterText, items]);

  const handleMkdir = async () => {
    const trimmed = newDirName.trim().replace(/^\/+|\/+$/g, '');
    if (!trimmed) return;
    const targetRemote = currentPath ? `${currentPath}/${trimmed}` : trimmed;
    try {
      await api.mkdir(connectionId, fs, targetRemote);
      message.success(t('Folder created'));
      setMkdirOpen(false);
      setNewDirName('');
      await loadFiles();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to create folder')));
    }
  };

  const handleRename = async () => {
    if (!renameTarget) return;
    const nextName = renameValue.trim();
    if (!nextName || nextName.includes('/') || nextName.includes('\\')) {
      message.warning(t('Enter a valid single item name without slashes'));
      return;
    }
    const srcRemote = currentPath ? `${currentPath}/${renameTarget.Name}` : renameTarget.Name;
    const dstRemote = currentPath ? `${currentPath}/${nextName}` : nextName;
    try {
      await api.renameItem(connectionId, fs, srcRemote, dstRemote, renameTarget.IsDir);
      message.success(t('Renamed successfully'));
      setRenameTarget(null);
      await loadFiles();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to rename item')));
    }
  };

  const handleDelete = async (record: RcloneListItem) => {
    const targetRemote = currentPath ? `${currentPath}/${record.Name}` : record.Name;
    try {
      await api.deleteItem(connectionId, fs, targetRemote, record.IsDir);
      message.success(t('Deleted successfully'));
      await loadFiles();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to delete item')));
    }
  };

  const handleDownload = async (record: RcloneListItem) => {
    const targetRemote = currentPath ? `${currentPath}/${record.Name}` : record.Name;
    try {
      const signedUrl = await api.signDownload(connectionId, fs, targetRemote, record.IsDir, 'attachment');
      const link = document.createElement('a');
      link.href = signedUrl;
      link.download = record.IsDir ? `${record.Name}.zip` : record.Name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to prepare download stream')));
    }
  };

  const activeSource = useMemo(() => sources.find((s) => s.value === fs), [fs, sources]);
  const isBucketRoot = Boolean(activeSource?.bucketBased && !currentPath);

  const handleUpload = async (file: File) => {
    if (isBucketRoot) {
      message.warning(t('Open a bucket folder first before uploading files to S3 / bucket storage'));
      return false;
    }
    const targetRemote = currentPath;
    setUploading(true);
    try {
      await api.uploadFile(connectionId, fs, targetRemote, file);
      message.success(`${t('Uploaded')}: ${file.name}`);
      await loadFiles();
    } catch (err) {
      message.error(getErrorMessage(err, t('Upload failed')));
    } finally {
      setUploading(false);
    }
    return false;
  };

  const columns: ColumnsType<RcloneListItem> = [
    {
      title: t('Name'),
      dataIndex: 'Name',
      key: 'Name',
      render: (name: string, record: RcloneListItem) => (
        <Space>
          {record.IsDir ? <FolderOpenOutlined style={{ color: '#1677ff' }} /> : <FileOutlined />}
          {record.IsDir ? (
            <Button
              type="link"
              style={{ padding: 0, height: 'auto' }}
              onClick={() => onChangePath(currentPath ? `${currentPath}/${record.Name}` : record.Name)}
            >
              {name}
            </Button>
          ) : (
            <Typography.Text>{name}</Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: t('Size'),
      dataIndex: 'Size',
      key: 'Size',
      width: 100,
      render: (size: number, record: RcloneListItem) => (record.IsDir ? '—' : formatBytes(size)),
    },
    ...(canTransfer
      ? [
          {
            title: t('Actions'),
            key: 'actions',
            width: 150,
            render: (_v: unknown, record: RcloneListItem) => (
              <Space size={4}>
                <Button
                  size="small"
                  icon={<DownloadOutlined />}
                  title={record.IsDir ? t('Download as ZIP') : t('Download')}
                  aria-label={`${t('Download')} ${record.Name}`}
                  onClick={() => handleDownload(record)}
                />
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  aria-label={`${t('Rename')} ${record.Name}`}
                  onClick={() => {
                    setRenameTarget(record);
                    setRenameValue(record.Name);
                  }}
                />
                <Popconfirm
                  title={record.IsDir ? t('Purge entire directory?') : t('Delete file?')}
                  onConfirm={() => handleDelete(record)}
                >
                  <Button size="small" danger icon={<DeleteOutlined />} aria-label={`${t('Delete')} ${record.Name}`} />
                </Popconfirm>
              </Space>
            ),
          },
        ]
      : []),
  ];

  return (
    <Card
      size="small"
      title={
        <Flex justify="space-between" align="center" gap={8} wrap="wrap">
          <Space>
            <Typography.Text strong>{paneTitle}</Typography.Text>
            <Select
              aria-label={`${paneTitle} ${t('Source')}`}
              popupMatchSelectWidth
              style={{ minWidth: 220, maxWidth: 320 }}
              value={fs || undefined}
              placeholder={t('Select remote...')}
              onChange={(val) => {
                onChangeFs(val);
                onChangePath('');
                onSelectItem(null);
              }}
              options={sources.map((s) => ({
                value: s.value,
                label: s.label,
              }))}
            />
          </Space>
          <Space size={6}>
            {canTransfer && fs && (
              <>
                <Button size="small" icon={<FolderAddOutlined />} onClick={() => setMkdirOpen(true)}>
                  {isBucketRoot ? t('New Bucket') : t('New Folder')}
                </Button>
                <Upload showUploadList={false} beforeUpload={handleUpload}>
                  <Button size="small" icon={<UploadOutlined />} loading={uploading}>
                    {t('Upload')}
                  </Button>
                </Upload>
              </>
            )}
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={loadFiles}
              loading={loading}
              aria-label={t('Refresh')}
            />
          </Space>
        </Flex>
      }
    >
      <Flex justify="space-between" align="center" gap={8} style={{ marginBottom: 8 }} wrap="wrap">
        <Breadcrumb
          items={[
            {
              title: (
                <Button
                  type="link"
                  size="small"
                  style={{ padding: 0, height: 'auto' }}
                  onClick={() => onChangePath('')}
                >
                  {fs || t('Root')}
                </Button>
              ),
            },
            ...pathSegments.map((seg, idx) => {
              const target = pathSegments.slice(0, idx + 1).join('/');
              return {
                title: (
                  <Button
                    type="link"
                    size="small"
                    style={{ padding: 0, height: 'auto' }}
                    onClick={() => onChangePath(target)}
                  >
                    {seg}
                  </Button>
                ),
              };
            }),
          ]}
        />
        <Input.Search
          size="small"
          allowClear
          placeholder={t('Filter files...')}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          style={{ width: 180 }}
        />
      </Flex>

      <Table
        rowKey="Name"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={visibleItems}
        rowSelection={{
          type: 'radio',
          selectedRowKeys: selectedItem ? [selectedItem.Name] : [],
          onChange: (_keys, rows) => onSelectItem(rows[0] ?? null),
        }}
        pagination={{ pageSize: 12, hideOnSinglePage: true }}
      />

      <Modal
        title={t('Create Folder')}
        open={mkdirOpen}
        onOk={handleMkdir}
        onCancel={() => setMkdirOpen(false)}
        destroyOnClose
      >
        <Input
          placeholder={t('Folder name')}
          value={newDirName}
          onChange={(e) => setNewDirName(e.target.value)}
          onPressEnter={handleMkdir}
        />
      </Modal>

      <Modal
        title={t('Rename Item')}
        open={Boolean(renameTarget)}
        onOk={handleRename}
        onCancel={() => setRenameTarget(null)}
        destroyOnClose
      >
        <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} onPressEnter={handleRename} />
      </Modal>
    </Card>
  );
};

function extractDiskPaths(disks: readonly RcloneDiskInfo[]): string[] {
  const paths: string[] = [];
  for (const entry of disks) {
    const p = String(entry.path ?? entry.fs ?? '').trim();
    if (p) paths.push(p);
  }
  return paths;
}

export const RcloneExplorer: React.FC = () => {
  const t = useT();
  const api = useRcloneApi();
  const { enabledConnections, selectedConnectionId, setSelectedConnectionId, permissions } = useRcloneSession();

  const [dualPane, setDualPane] = useState(true);
  const [remotes, setRemotes] = useState<RcloneRemoteSummary[]>([]);
  const [disks, setDisks] = useState<RcloneDiskInfo[]>([]);
  const [loadedConnectionId, setLoadedConnectionId] = useState<number | null>(null);
  const loadedConnRef = useRef<number | null>(null);
  const activeConnRef = useRef<number | null>(selectedConnectionId);
  activeConnRef.current = selectedConnectionId;

  const [leftFs, setLeftFs] = useState('');
  const [leftPath, setLeftPath] = useState('');
  const [leftSelected, setLeftSelected] = useState<RcloneListItem | null>(null);

  const [rightFs, setRightFs] = useState('');
  const [rightPath, setRightPath] = useState('');
  const [rightSelected, setRightSelected] = useState<RcloneListItem | null>(null);
  const leftFsRef = useRef(leftFs);
  leftFsRef.current = leftFs;
  const rightFsRef = useRef(rightFs);
  rightFsRef.current = rightFs;

  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [submittingWorkflow, setSubmittingWorkflow] = useState(false);
  const [transferForm] = Form.useForm();
  const watchedOp = Form.useWatch('operation', transferForm) as RcloneTransferOperation | undefined;
  const watchedDstFs = Form.useWatch('dstFs', transferForm) as string | undefined;
  const watchedDstRemote = Form.useWatch('dstRemote', transferForm) as string | undefined;

  const loadSources = useCallback(async () => {
    const connId = selectedConnectionId;
    if (!connId) {
      setRemotes([]);
      setDisks([]);
      loadedConnRef.current = null;
      setLoadedConnectionId(null);
      setLeftFs('');
      setLeftPath('');
      setLeftSelected(null);
      setRightFs('');
      setRightPath('');
      setRightSelected(null);
      return;
    }
    try {
      const [remoteList, diskList] = await Promise.all([
        api.listRemotes(connId),
        permissions.canLocalFs ? api.listDisks(connId).catch(() => []) : Promise.resolve([]),
      ]);
      if (activeConnRef.current !== connId) {
        return;
      }
      setRemotes(remoteList);
      setDisks(diskList);

      const diskPaths = permissions.canLocalFs ? extractDiskPaths(diskList) : [];
      const validFsValues = new Set<string>([...remoteList.map((r) => `${r.name}:`), ...diskPaths]);
      const firstDefault = remoteList[0] ? `${remoteList[0].name}:` : diskPaths[0] ?? '';
      const secondDefault = remoteList[1] ? `${remoteList[1].name}:` : firstDefault;
      const switchedConnection = loadedConnRef.current !== connId;

      const prevLeft = leftFsRef.current;
      const prevRight = rightFsRef.current;
      const nextLeft = !switchedConnection && prevLeft && validFsValues.has(prevLeft) ? prevLeft : firstDefault;
      const nextRight = !switchedConnection && prevRight && validFsValues.has(prevRight) ? prevRight : secondDefault;

      setLeftFs(nextLeft);
      setRightFs(nextRight);
      if (switchedConnection || nextLeft !== prevLeft) {
        setLeftPath('');
        setLeftSelected(null);
      }
      if (switchedConnection || nextRight !== prevRight) {
        setRightPath('');
        setRightSelected(null);
      }
      loadedConnRef.current = connId;
      setLoadedConnectionId(connId);
    } catch (err) {
      if (activeConnRef.current !== connId) {
        return;
      }
      message.error(getErrorMessage(err, t('Failed to load storage sources')));
    }
  }, [api, permissions.canLocalFs, selectedConnectionId, t]);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  const sourceOptions: PaneSourceOption[] = useMemo(() => {
    const cloudOpts: PaneSourceOption[] = remotes.map((r) => ({
      value: `${r.name}:`,
      label: `☁️ ${r.name}: (${r.type})`,
      isLocal: r.type.toLowerCase() === 'local',
      bucketBased: Boolean(r.bucketBased),
    }));
    const localOpts: PaneSourceOption[] = permissions.canLocalFs
      ? extractDiskPaths(disks).map((fsVal) => ({
          value: fsVal,
          label: `💽 Local: ${fsVal}`,
          isLocal: true,
        }))
      : [];
    return [...cloudOpts, ...localOpts];
  }, [disks, permissions.canLocalFs, remotes]);

  const isUnrootedBucketTarget = useCallback(
    (fsVal?: string): boolean => sourceOptions.some((s) => s.value === (fsVal ?? '').trim() && s.bucketBased),
    [sourceOptions],
  );

  const missingDestBucket =
    Boolean(watchedDstFs) &&
    isUnrootedBucketTarget(watchedDstFs) &&
    (watchedOp === 'operations/copyfile' || watchedOp === 'operations/movefile') &&
    !String(watchedDstRemote ?? '')
      .trim()
      .replace(/^\/+|\/+$/g, '')
      .includes('/');

  const openWorkflowModal = (direction: 'leftToRight' | 'rightToLeft', defaultOp: RcloneTransferOperation) => {
    const fromFs = direction === 'leftToRight' ? leftFs : rightFs;
    const fromDir = direction === 'leftToRight' ? leftPath : rightPath;
    const fromItem = direction === 'leftToRight' ? leftSelected : rightSelected;
    const toFs = direction === 'leftToRight' ? rightFs : leftFs;
    const toDir = direction === 'leftToRight' ? rightPath : leftPath;
    const toItem = direction === 'leftToRight' ? rightSelected : leftSelected;
    const effectiveToDir = toItem?.IsDir ? (toDir ? `${toDir}/${toItem.Name}` : toItem.Name) : toDir;

    let resolvedOp = defaultOp;
    let srcRemote = fromDir;
    let dstRemote = effectiveToDir;

    if (fromItem && !fromItem.IsDir && (defaultOp === 'sync/copy' || defaultOp === 'sync/move')) {
      resolvedOp = defaultOp === 'sync/move' ? 'operations/movefile' : 'operations/copyfile';
      srcRemote = fromDir ? `${fromDir}/${fromItem.Name}` : fromItem.Name;
      dstRemote = effectiveToDir ? `${effectiveToDir}/${fromItem.Name}` : fromItem.Name;
    } else if (fromItem && fromItem.IsDir) {
      srcRemote = fromDir ? `${fromDir}/${fromItem.Name}` : fromItem.Name;
      dstRemote = effectiveToDir ? `${effectiveToDir}/${fromItem.Name}` : fromItem.Name;
    }

    transferForm.setFieldsValue({
      operation: resolvedOp,
      srcFs: fromFs,
      srcRemote,
      dstFs: toFs,
      dstRemote,
      dryRun: false,
      createEmptySrcDirs: false,
    });
    setTransferModalOpen(true);
  };

  const submitTransferWorkflow = async () => {
    if (!selectedConnectionId) return;
    if (missingDestBucket) {
      message.warning(
        t(
          'Bucket-based storage requires a bucket folder in Destination Sub-path (e.g. my-bucket/file.txt). Open or select a bucket in the destination pane first.',
        ),
      );
      return;
    }
    try {
      const vals = (await transferForm.validateFields()) as {
        operation: RcloneTransferOperation;
        srcFs: string;
        srcRemote?: string;
        dstFs: string;
        dstRemote?: string;
        dryRun?: boolean;
        createEmptySrcDirs?: boolean;
      };
      setSubmittingWorkflow(true);
      const task = await api.triggerTransferWorkflow({
        connectionId: selectedConnectionId,
        ...vals,
      });
      message.success(`${t('Dispatched to NocoBase Workflow')} (#${task.id})`);
      setTransferModalOpen(false);
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error(getErrorMessage(err, t('Failed to trigger transfer workflow')));
    } finally {
      setSubmittingWorkflow(false);
    }
  };

  return (
    <div role="region" aria-label={t('Rclone File Explorer')}>
      <ConnectionHeader
        title={t('File Explorer')}
        connections={enabledConnections}
        selectedConnectionId={selectedConnectionId}
        onSelectConnection={setSelectedConnectionId}
        onRefresh={loadSources}
        extra={
          <Space>
            <ColumnWidthOutlined />
            <Typography.Text>{t('Dual-Pane')}</Typography.Text>
            <Switch checked={dualPane} onChange={setDualPane} aria-label={t('Toggle Dual-Pane')} />
          </Space>
        }
      />

      {selectedConnectionId &&
        loadedConnectionId === selectedConnectionId &&
        dualPane &&
        permissions.canTransfer &&
        leftFs &&
        rightFs && (
          <Card size="small" style={{ marginBottom: 12 }}>
            <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
              <Space wrap>
                <Tag color="purple">{t('Workflow Engine')}</Tag>
                <Typography.Text type="secondary">
                  {t(
                    'Copy, Move, and Sync actions dispatch through NocoBase Workflow for audit, approval, and background tracking.',
                  )}
                </Typography.Text>
              </Space>
              <Space wrap>
                <Button
                  type="primary"
                  size="small"
                  icon={<SwapRightOutlined />}
                  onClick={() => openWorkflowModal('leftToRight', 'sync/copy')}
                >
                  {t('Copy Left -> Right')}
                </Button>
                <Button size="small" onClick={() => openWorkflowModal('leftToRight', 'sync/move')}>
                  {t('Move Left -> Right')}
                </Button>
                <Button size="small" danger onClick={() => openWorkflowModal('leftToRight', 'sync/sync')}>
                  {t('Mirror Sync Left -> Right')}
                </Button>
                <Button size="small" onClick={() => openWorkflowModal('rightToLeft', 'sync/copy')}>
                  {t('Copy Right -> Left')}
                </Button>
              </Space>
            </Flex>
          </Card>
        )}

      {selectedConnectionId && (
        <Row gutter={[12, 12]}>
          <Col xs={24} lg={dualPane ? 12 : 24}>
            <ExplorerPane
              paneTitle={dualPane ? t('Left Pane') : t('Browser')}
              connectionId={selectedConnectionId}
              sources={loadedConnectionId === selectedConnectionId ? sourceOptions : []}
              fs={loadedConnectionId === selectedConnectionId ? leftFs : ''}
              onChangeFs={setLeftFs}
              currentPath={loadedConnectionId === selectedConnectionId ? leftPath : ''}
              onChangePath={setLeftPath}
              canTransfer={permissions.canTransfer}
              selectedItem={loadedConnectionId === selectedConnectionId ? leftSelected : null}
              onSelectItem={setLeftSelected}
            />
          </Col>
          {dualPane && (
            <Col xs={24} lg={12}>
              <ExplorerPane
                paneTitle={t('Right Pane')}
                connectionId={selectedConnectionId}
                sources={loadedConnectionId === selectedConnectionId ? sourceOptions : []}
                fs={loadedConnectionId === selectedConnectionId ? rightFs : ''}
                onChangeFs={setRightFs}
                currentPath={loadedConnectionId === selectedConnectionId ? rightPath : ''}
                onChangePath={setRightPath}
                canTransfer={permissions.canTransfer}
                selectedItem={loadedConnectionId === selectedConnectionId ? rightSelected : null}
                onSelectItem={setRightSelected}
              />
            </Col>
          )}
        </Row>
      )}

      <Modal
        title={t('Dispatch Rclone Workflow Transfer')}
        open={transferModalOpen}
        onOk={submitTransferWorkflow}
        confirmLoading={submittingWorkflow}
        onCancel={() => setTransferModalOpen(false)}
        destroyOnClose
      >
        <Form form={transferForm} layout="vertical">
          {missingDestBucket && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message={t(
                'Bucket-based storage requires a bucket folder in Destination Sub-path (e.g. my-bucket/file.txt). Open or select a bucket in the destination pane first.',
              )}
            />
          )}
          <Form.Item name="operation" label={t('Workflow Operation')} rules={[{ required: true }]}>
            <Select
              popupMatchSelectWidth
              options={[
                { value: 'sync/copy', label: t('sync/copy — Copy directory / files (non-destructive)') },
                { value: 'sync/move', label: t('sync/move — Move directory / files') },
                { value: 'sync/sync', label: t('sync/sync — Mirror destination to match source (deletes extras)') },
                { value: 'sync/bisync', label: t('sync/bisync — Bidirectional sync') },
                { value: 'operations/copyfile', label: t('operations/copyfile — Copy single file') },
                { value: 'operations/movefile', label: t('operations/movefile — Move single file') },
              ]}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="srcFs" label={t('Source Fs')} rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="srcRemote" label={t('Source Sub-path')}>
                <Input placeholder="(root)" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="dstFs" label={t('Destination Fs')} rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="dstRemote" label={t('Destination Sub-path')}>
                <Input placeholder="(root)" />
              </Form.Item>
            </Col>
          </Row>
          <Space size="large">
            <Form.Item name="dryRun" valuePropName="checked" noStyle>
              <Checkbox>{t('Dry Run (simulate without writing)')}</Checkbox>
            </Form.Item>
            <Form.Item name="createEmptySrcDirs" valuePropName="checked" noStyle>
              <Checkbox>{t('Create empty source directories')}</Checkbox>
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
};

export default RcloneExplorer;
