/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useMemo, useState } from 'react';
import {
  Layout,
  Menu,
  Table,
  Button,
  Breadcrumb,
  Space,
  Modal,
  Input,
  Popconfirm,
  Empty,
  Spin,
  Tag,
  Tooltip,
  message,
  Typography,
  Upload,
  Descriptions,
  Pagination,
  Image,
} from 'antd';
import {
  FolderOutlined,
  FileOutlined,
  UploadOutlined,
  FolderAddOutlined,
  ReloadOutlined,
  DownloadOutlined,
  DeleteOutlined,
  HomeOutlined,
  ArrowLeftOutlined,
  CloudServerOutlined,
  AppstoreOutlined,
  UnorderedListOutlined,
  InboxOutlined,
  EyeOutlined,
  FileImageOutlined,
  InfoCircleOutlined,
  SearchOutlined,
  FilePdfOutlined,
  FileWordOutlined,
  FileExcelOutlined,
  FilePptOutlined,
  FileZipOutlined,
  FileTextOutlined,
  VideoCameraOutlined,
  AudioOutlined,
  FileUnknownOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useApp } from '@nocobase/client-v2';
import { useFileBrowser, FileItem } from '../hooks/useFileBrowser';

const { Sider, Content } = Layout;
const { Text } = Typography;
const { Dragger } = Upload;

function formatSize(bytes: number): string {
  if (!bytes) return '-';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(ts: number): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString();
}

function getExtname(name: string) {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index) : '';
}

const getFileIcon = (mimetype?: string) => {
  if (!mimetype) return <FileUnknownOutlined style={{ fontSize: 18, color: '#8c8c8c' }} />;
  if (mimetype.startsWith('image/')) return <FileImageOutlined style={{ fontSize: 18, color: '#52c41a' }} />;
  if (mimetype.startsWith('video/')) return <VideoCameraOutlined style={{ fontSize: 18, color: '#eb2f96' }} />;
  if (mimetype.startsWith('audio/')) return <AudioOutlined style={{ fontSize: 18, color: '#13c2c2' }} />;
  if (mimetype.includes('pdf')) return <FilePdfOutlined style={{ fontSize: 18, color: '#f5222d' }} />;
  if (mimetype.includes('word')) return <FileWordOutlined style={{ fontSize: 18, color: '#1677ff' }} />;
  if (mimetype.includes('excel') || mimetype.includes('spreadsheet'))
    return <FileExcelOutlined style={{ fontSize: 18, color: '#52c41a' }} />;
  if (mimetype.includes('powerpoint') || mimetype.includes('presentation'))
    return <FilePptOutlined style={{ fontSize: 18, color: '#fa541c' }} />;
  if (mimetype.includes('zip') || mimetype.includes('compressed'))
    return <FileZipOutlined style={{ fontSize: 18, color: '#722ed1' }} />;
  if (mimetype.startsWith('text/')) return <FileTextOutlined style={{ fontSize: 18, color: '#8c8c8c' }} />;
  return <FileOutlined style={{ fontSize: 18, color: '#1677ff' }} />;
};

export const FileBrowser: React.FC = () => {
  const api = useApp().apiClient;
  const browser = useFileBrowser();
  const {
    directories,
    currentDir,
    files,
    currentPath,
    loading,
    dirLoading,
    navigateTo,
    navigateUp,
    downloadFile,
    uploadFiles,
    createFolder,
    deleteItem,
    statItem,
    refresh,
    currentPage,
    pageSize,
    totalItems,
    changePage,
    setPageSize,
    searchText,
    setSearchText,
  } = browser;

  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadFileList, setUploadFileList] = useState<any[]>([]);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [infoModalOpen, setInfoModalOpen] = useState(false);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoItem, setInfoItem] = useState<FileItem | null>(null);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);

  // Reset selected rows when path, directory, or search changes
  React.useEffect(() => {
    setSelectedRowKeys([]);
  }, [currentPath, currentDir, searchText]);

  const canView = currentDir?.allowedActions?.includes('view') ?? false;
  const canUpload = currentDir?.allowedActions?.includes('upload') ?? false;
  const canDownload = currentDir?.allowedActions?.includes('download') ?? false;
  const canDelete = currentDir?.allowedActions?.includes('delete') ?? false;
  const canMkdir = currentDir?.allowedActions?.includes('mkdir') ?? false;

  const filteredFiles = files; // Search is now server-side; files are already filtered

  const getFileUrl = React.useCallback(
    (path: string, inline = false) => {
      if (!currentDir) return '';
      const token = (api as any).auth?.token || '';
      const params = new URLSearchParams({
        directoryId: String(currentDir.id),
        path,
        mode: inline ? 'inline' : 'attachment',
      });
      if (token) {
        params.set('token', token);
      }
      return `/api/extStorage:download?${params.toString()}`;
    },
    [api, currentDir],
  );

  const previewFiles = useMemo(
    () =>
      filteredFiles
        .filter((file) => file.type === 'file')
        .map((file) => ({
          ...file,
          filename: file.name,
          title: file.name,
          extname: getExtname(file.name),
          url: getFileUrl(file.path, true),
          downloadUrl: getFileUrl(file.path, false),
        })),
    [filteredFiles, getFileUrl],
  );

  const openPreview = (file: FileItem) => {
    const index = previewFiles.findIndex((item) => item.path === file.path);
    if (index >= 0) {
      setPreviewIndex(index);
      setPreviewOpen(true);
    }
  };

  const openInfo = async (file: FileItem) => {
    setInfoModalOpen(true);
    setInfoItem(file);
    if (!canView) return;
    try {
      setInfoLoading(true);
      const stat = await statItem(file.path);
      if (stat) {
        setInfoItem(stat);
      }
    } catch (error: any) {
      message.error(error?.message || 'Failed to load file information');
    } finally {
      setInfoLoading(false);
    }
  };

  const breadcrumbItems = () => {
    const items: any[] = [
      {
        key: 'home',
        title: (
          <a onClick={() => navigateTo('/')}>
            <HomeOutlined /> {currentDir?.name || 'Home'}
          </a>
        ),
      },
    ];
    if (currentPath && currentPath !== '/') {
      const parts = currentPath.split('/').filter(Boolean);
      let acc = '';
      parts.forEach((part, i) => {
        acc += '/' + part;
        const p = acc;
        items.push({
          key: p,
          title: i === parts.length - 1 ? <span>{part}</span> : <a onClick={() => navigateTo(p)}>{part}</a>,
        });
      });
    }
    return items;
  };

  const columns: ColumnsType<FileItem> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      sorter: (a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      },
      render: (name, record) => (
        <Space>
          {record.type === 'directory' ? (
            <FolderOutlined style={{ fontSize: 18, color: '#faad14' }} />
          ) : (
            getFileIcon(record.mimetype)
          )}
          {record.type === 'directory' ? (
            <a onClick={() => navigateTo(record)} style={{ fontWeight: 500 }}>
              {name}
            </a>
          ) : (
            <a onClick={() => openPreview(record)}>{name}</a>
          )}
        </Space>
      ),
    },
    {
      title: 'Size',
      dataIndex: 'size',
      key: 'size',
      width: 120,
      sorter: (a, b) => a.size - b.size,
      render: (s, r) => (r.type === 'file' ? formatSize(s) : '-'),
    },
    {
      title: 'Type',
      dataIndex: 'mimetype',
      key: 'mimetype',
      width: 100,
      align: 'center',
      render: (m, r) =>
        r.type === 'directory' ? (
          <Tooltip title="Folder">
            <FolderOutlined style={{ fontSize: 20, color: '#faad14' }} />
          </Tooltip>
        ) : (
          <Tooltip title={m || 'Unknown'}>
            <span style={{ cursor: 'pointer' }}>{getFileIcon(m)}</span>
          </Tooltip>
        ),
    },
    {
      title: 'Modified',
      dataIndex: 'modifiedAt',
      key: 'modifiedAt',
      width: 180,
      sorter: (a, b) => a.modifiedAt - b.modifiedAt,
      render: (ts) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {formatDate(ts)}
        </Text>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 150,
      render: (_, record) => (
        <Space size="small">
          {record.type === 'file' && (
            <Tooltip title="Preview">
              <Button type="text" size="small" icon={<EyeOutlined />} onClick={() => openPreview(record)} />
            </Tooltip>
          )}
          <Tooltip title="Info">
            <Button type="text" size="small" icon={<InfoCircleOutlined />} onClick={() => openInfo(record)} />
          </Tooltip>
          {record.type === 'file' && canDownload && (
            <Tooltip title="Download">
              <Button type="text" size="small" icon={<DownloadOutlined />} onClick={() => downloadFile(record.path)} />
            </Tooltip>
          )}
          {canDelete && (
            <Popconfirm
              title={`Delete "${record.name}"?`}
              description={record.type === 'directory' ? 'This will delete all contents.' : undefined}
              onConfirm={async () => {
                try {
                  await deleteItem(record.path, record.type);
                  message.success('Deleted');
                  setSelectedRowKeys(selectedRowKeys.filter((key) => key !== record.path));
                } catch (e: any) {
                  message.error(e?.message || 'Failed');
                }
              }}
              okButtonProps={{ danger: true }}
            >
              <Tooltip title="Delete">
                <Button type="text" size="small" danger icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const handleUpload = async () => {
    const safeFileList = Array.isArray(uploadFileList) ? uploadFileList : [];
    const selectedFiles = safeFileList.map((file) => file.originFileObj).filter(Boolean) as File[];
    if (!selectedFiles.length) {
      message.warning('Select at least one file');
      return;
    }
    try {
      setUploading(true);
      await uploadFiles(selectedFiles);
      message.success('Upload successful');
      setUploadModalOpen(false);
      setUploadFileList([]);
    } catch (e: any) {
      message.error(e?.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleCreateFolder = async () => {
    if (!folderName.trim()) {
      message.warning('Enter a folder name');
      return;
    }
    try {
      await createFolder(folderName.trim());
      message.success('Folder created');
      setFolderModalOpen(false);
      setFolderName('');
    } catch (e: any) {
      message.error(e?.message || 'Failed');
    }
  };

  const handleBulkDelete = async () => {
    if (!selectedRowKeys.length) return;
    try {
      for (const key of selectedRowKeys) {
        const item = filteredFiles.find((file) => file.path === key);
        if (item) await deleteItem(item.path, item.type);
      }
      message.success(`Deleted ${selectedRowKeys.length} items`);
      setSelectedRowKeys([]);
    } catch (e: any) {
      message.error(e?.message || 'Bulk delete failed');
    }
  };

  const rowSelection = {
    selectedRowKeys,
    onChange: (newSelectedRowKeys: React.Key[]) => {
      setSelectedRowKeys(newSelectedRowKeys);
    },
  };

  if (dirLoading)
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 400 }}>
        <Spin size="large" />
      </div>
    );
  if (directories.length === 0)
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No directories configured or accessible"
        style={{ padding: 80 }}
      />
    );

  const previewFile = previewFiles[previewIndex];

  return (
    <Layout style={{ background: '#fff', borderRadius: 8, overflow: 'hidden', minHeight: 500 }}>
      <Sider width={240} style={{ background: '#fafafa', borderRight: '1px solid #f0f0f0' }}>
        <div style={{ padding: '16px 12px 8px', borderBottom: '1px solid #f0f0f0' }}>
          <Text strong style={{ fontSize: 13 }}>
            <CloudServerOutlined /> Directories
          </Text>
        </div>
        <Menu
          mode="inline"
          selectedKeys={currentDir ? [String(currentDir.id)] : []}
          style={{ border: 'none', background: 'transparent' }}
          items={(Array.isArray(directories) ? directories : []).map((dir) => ({
            key: String(dir.id),
            icon: <FolderOutlined />,
            label: (
              <Space size={4}>
                <span>{dir.name}</span>
                <Tag color={dir.storageType === 'sftp-private' ? 'green' : 'blue'} style={{ fontSize: 10 }}>
                  {dir.storageType === 'sftp-private' ? 'SFTP' : 'S3'}
                </Tag>
              </Space>
            ),
            onClick: () => {
              setSelectedRowKeys([]);
              navigateTo(dir);
            },
          }))}
        />
      </Sider>
      <Content>
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid #f0f0f0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <Space>
            <Tooltip title="Go back">
              <Button
                type="text"
                icon={<ArrowLeftOutlined />}
                disabled={currentPath === '/' || !currentPath}
                onClick={() => {
                  setSelectedRowKeys([]);
                  navigateUp();
                }}
              />
            </Tooltip>
            <Breadcrumb items={breadcrumbItems()} />
          </Space>
          <Space>
            <Input
              placeholder="Search files..."
              allowClear
              prefix={<SearchOutlined />}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              style={{ width: 200 }}
            />
            {selectedRowKeys.length > 0 && canDelete && (
              <Popconfirm
                title={`Delete ${selectedRowKeys.length} items?`}
                onConfirm={handleBulkDelete}
                okButtonProps={{ danger: true }}
              >
                <Button danger icon={<DeleteOutlined />}>
                  Delete Selected
                </Button>
              </Popconfirm>
            )}
            {canUpload && (
              <Button icon={<UploadOutlined />} onClick={() => setUploadModalOpen(true)}>
                Upload
              </Button>
            )}
            {canMkdir && (
              <Button
                icon={<FolderAddOutlined />}
                onClick={() => {
                  setFolderName('');
                  setFolderModalOpen(true);
                }}
              >
                New Folder
              </Button>
            )}
            <Tooltip title="Refresh">
              <Button
                type="text"
                icon={<ReloadOutlined />}
                onClick={() => {
                  refresh();
                  setSelectedRowKeys([]);
                }}
              />
            </Tooltip>
            <Button.Group>
              <Button
                type={viewMode === 'list' ? 'primary' : 'default'}
                icon={<UnorderedListOutlined />}
                onClick={() => setViewMode('list')}
                size="small"
              />
              <Button
                type={viewMode === 'grid' ? 'primary' : 'default'}
                icon={<AppstoreOutlined />}
                onClick={() => setViewMode('grid')}
                size="small"
              />
            </Button.Group>
          </Space>
        </div>
        <div style={{ padding: viewMode === 'grid' ? 16 : 0 }}>
          {viewMode === 'list' ? (
            <Table
              dataSource={filteredFiles}
              columns={columns}
              rowKey="path"
              loading={loading}
              pagination={{
                current: currentPage,
                pageSize: pageSize,
                total: totalItems,
                showSizeChanger: true,
                pageSizeOptions: ['10', '20', '50', '100'],
                showTotal: (total) => `Total ${total} items`,
                onChange: (page, size) => {
                  changePage(page, size);
                  setSelectedRowKeys([]);
                },
              }}
              size="middle"
              rowSelection={rowSelection}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No files found" /> }}
              onRow={(record) => ({
                onDoubleClick: () => {
                  if (record.type === 'directory') navigateTo(record);
                  else openPreview(record);
                },
                style: { cursor: record.type === 'directory' ? 'pointer' : 'default' },
              })}
            />
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
                {loading ? (
                  <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: 40 }}>
                    <Spin />
                  </div>
                ) : filteredFiles.length === 0 ? (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No files" />
                  </div>
                ) : (
                  (Array.isArray(filteredFiles) ? filteredFiles : []).map((file) => (
                    <div
                      key={file.path}
                      style={{
                        padding: 12,
                        borderRadius: 8,
                        border: selectedRowKeys.includes(file.path) ? '2px solid #1677ff' : '1px solid #f0f0f0',
                        textAlign: 'center',
                        cursor: 'pointer',
                        position: 'relative',
                      }}
                      onClick={(event) => {
                        if (event.ctrlKey || event.metaKey) {
                          setSelectedRowKeys((previous) =>
                            previous.includes(file.path)
                              ? previous.filter((key) => key !== file.path)
                              : [...previous, file.path],
                          );
                        } else if (file.type === 'directory') {
                          navigateTo(file);
                        } else {
                          openPreview(file);
                        }
                      }}
                      onDoubleClick={() => {
                        if (file.type === 'directory') navigateTo(file);
                        else openPreview(file);
                      }}
                    >
                      <div style={{ fontSize: 32, marginBottom: 8 }}>
                        {file.type === 'directory' ? (
                          <FolderOutlined style={{ color: '#faad14' }} />
                        ) : file.mimetype?.startsWith('image/') ? (
                          <FileImageOutlined style={{ color: '#52c41a' }} />
                        ) : (
                          <FileOutlined style={{ color: '#1677ff' }} />
                        )}
                      </div>
                      <Text
                        ellipsis={{ tooltip: file.name }}
                        style={{ display: 'block', fontSize: 12, fontWeight: 500 }}
                      >
                        {file.name}
                      </Text>
                      {file.type === 'file' && (
                        <Text type="secondary" style={{ fontSize: 10 }}>
                          {formatSize(file.size)}
                        </Text>
                      )}
                    </div>
                  ))
                )}
              </div>
              {filteredFiles.length > 0 && !loading && (
                <div style={{ textAlign: 'right', marginTop: 16 }}>
                  <Pagination
                    current={currentPage}
                    pageSize={pageSize}
                    total={totalItems}
                    showSizeChanger
                    pageSizeOptions={['10', '20', '50', '100']}
                    showTotal={(total) => `Total ${total} items`}
                    onChange={(page, size) => {
                      changePage(page, size);
                      setSelectedRowKeys([]);
                    }}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </Content>
      <Modal
        title="Upload Files"
        open={uploadModalOpen}
        onCancel={() => {
          setUploadModalOpen(false);
          setUploadFileList([]);
        }}
        onOk={handleUpload}
        okText="Upload"
        confirmLoading={uploading}
        width={500}
      >
        <Dragger
          multiple
          beforeUpload={() => false}
          disabled={uploading}
          fileList={uploadFileList}
          onChange={(info) => setUploadFileList(info.fileList)}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">Click or drag files to upload</p>
          <p className="ant-upload-hint">
            Upload to: {currentDir?.name}
            {currentPath}
          </p>
        </Dragger>
      </Modal>
      <Modal
        title="New Folder"
        open={folderModalOpen}
        onOk={handleCreateFolder}
        onCancel={() => setFolderModalOpen(false)}
        okText="Create"
      >
        <Input
          placeholder="Enter folder name"
          value={folderName}
          onChange={(e) => setFolderName(e.target.value)}
          onPressEnter={handleCreateFolder}
          autoFocus
        />
      </Modal>
      <Modal
        title={infoItem?.name || 'File information'}
        open={infoModalOpen}
        onCancel={() => setInfoModalOpen(false)}
        footer={null}
        width={520}
      >
        <Spin spinning={infoLoading}>
          {infoItem ? (
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="Name">{infoItem.name}</Descriptions.Item>
              <Descriptions.Item label="Path">
                <Text code>{infoItem.path}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="Type">{infoItem.type}</Descriptions.Item>
              <Descriptions.Item label="MIME type">{infoItem.mimetype || '-'}</Descriptions.Item>
              <Descriptions.Item label="Size">
                {infoItem.type === 'file' ? formatSize(infoItem.size) : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Modified">{formatDate(infoItem.modifiedAt)}</Descriptions.Item>
            </Descriptions>
          ) : null}
        </Spin>
      </Modal>
      {previewOpen && previewFile
        ? (() => {
            const ext = (previewFile.extname || '').toLowerCase().replace(/^\./, '');
            const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext);
            const isVideo = ['mp4', 'webm', 'ogg', 'mov', 'm4v'].includes(ext);
            const isAudio = ['mp3', 'wav', 'oga', 'm4a', 'flac', 'aac'].includes(ext);
            const isPdf = ext === 'pdf';
            const close = () => setPreviewOpen(false);
            if (isImage) {
              return (
                <Image
                  style={{ display: 'none' }}
                  src={previewFile.url}
                  preview={{
                    visible: previewOpen,
                    src: previewFile.url,
                    onVisibleChange: (v) => {
                      if (!v) close();
                    },
                  }}
                />
              );
            }
            return (
              <Modal
                open={previewOpen}
                title={previewFile.filename}
                footer={null}
                width={880}
                onCancel={close}
                destroyOnClose
              >
                {isVideo ? (
                  <video src={previewFile.url} controls style={{ width: '100%' }} />
                ) : isAudio ? (
                  <audio src={previewFile.url} controls style={{ width: '100%' }} />
                ) : isPdf ? (
                  <iframe
                    src={previewFile.url}
                    title={previewFile.filename}
                    style={{ width: '100%', height: '70vh', border: 'none' }}
                  />
                ) : (
                  <Empty description="Preview not available for this file type" image={Empty.PRESENTED_IMAGE_SIMPLE}>
                    <Button type="primary" href={previewFile.url} target="_blank" rel="noopener noreferrer">
                      Download
                    </Button>
                  </Empty>
                )}
              </Modal>
            );
          })()
        : null}
    </Layout>
  );
};

export default FileBrowser;
