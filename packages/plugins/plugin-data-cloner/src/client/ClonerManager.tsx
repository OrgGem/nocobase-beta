import React, { useEffect, useState } from 'react';
import { Card, Button, Table, Tag, Modal, Form, Input, Select, message, Space, InputNumber } from 'antd';
import { useApp } from '@nocobase/client-v2';
import { ProgressMonitor } from './ProgressMonitor';

export const ClonerManager = () => {
  const api = useApp().apiClient;
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [dataSources, setDataSources] = useState([]);
  const [form] = Form.useForm();
  
  // States cho tiến trình
  const [selectedTaskId, setSelectedTaskId] = useState(null);

  const fetchTasks = async () => {
    setLoading(true);
    try {
      const res = await api.request({ url: 'clone_tasks:list', params: { sort: ['-createdAt'] } });
      setTasks(res?.data?.data || []);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  const fetchDataSources = async () => {
    try {
      const res = await api.request({ url: 'dataSources:list' });
      setDataSources(res?.data?.data || []);
    } catch (err) {}
  };

  useEffect(() => {
    fetchTasks();
    fetchDataSources();
  }, []);

  const handleCreateAndValidate = async (values) => {
    try {
      // 1. Validate Schema
      message.loading({ content: 'Đang kiểm tra Schema...', key: 'validate' });
      const validateRes = await api.request({
        url: 'dataCloner:validate',
        method: 'post',
        data: { source: values.source, target: values.target }
      });
      
      const { isValid, errors } = validateRes.data;
      if (!isValid) {
        message.destroy('validate');
        Modal.error({ title: 'Schema không đồng nhất', content: errors.join('\n') });
        return;
      }
      
      message.success({ content: 'Schema hợp lệ, đang tạo Task...', key: 'validate' });

      // 2. Tạo Task
      await api.request({
        url: 'clone_tasks:create',
        method: 'post',
        data: {
          source_datasource_key: values.source,
          target_datasource_key: values.target,
          status: 'ready'
        }
      });
      message.success('Đã tạo tiến trình clone thành công');
      setIsModalOpen(false);
      fetchTasks();
    } catch (error) {
      message.error(error.message || 'Lỗi khi tạo Task');
    }
  };

  const handleStart = async (record) => {
    try {
      await api.request({
        url: 'dataCloner:start',
        method: 'post',
        data: { taskId: record.id, chunkSize: record.chunkSize || 1000 }
      });
      message.success('Tiến trình đang khởi chạy nền...');
      fetchTasks();
    } catch (error) {
      message.error(error.message);
    }
  };

  const handlePause = async (record) => {
    try {
      await api.request({
        url: 'dataCloner:pause',
        method: 'post',
        data: { taskId: record.id }
      });
      message.success('Đã gửi yêu cầu tạm dừng...');
      fetchTasks();
    } catch (error) {
      message.error(error.message);
    }
  };

  const columns = [
    { title: 'ID', dataIndex: 'id', key: 'id' },
    { title: 'Nguồn', dataIndex: 'source_datasource_key', key: 'source' },
    { title: 'Đích', dataIndex: 'target_datasource_key', key: 'target' },
    { title: 'Trạng thái', dataIndex: 'status', key: 'status', render: (status) => <Tag color={status === 'running' ? 'blue' : status === 'completed' ? 'green' : 'default'}>{status}</Tag> },
    { title: 'Hành động', key: 'action', render: (_, record) => (
      <Space>
        {record.status !== 'running' && record.status !== 'completed' && <Button size="small" type="primary" onClick={() => handleStart(record)}>Bắt đầu (Resume)</Button>}
        {record.status === 'running' && <Button size="small" danger onClick={() => handlePause(record)}>Dừng</Button>}
        <Button size="small" onClick={() => setSelectedTaskId(record.id)}>Mở Giám sát</Button>
      </Space>
    )}
  ];

  if (selectedTaskId) {
    return <ProgressMonitor taskId={selectedTaskId} onBack={() => setSelectedTaskId(null)} />;
  }

  return (
    <Card title="Quản lý đồng bộ Data (Data Cloner)" extra={<Button type="primary" onClick={() => setIsModalOpen(true)}>Tạo đồng bộ mới</Button>}>
      <Table 
        dataSource={tasks} 
        columns={columns} 
        rowKey="id" 
        loading={loading}
      />

      <Modal 
        title="Thiết lập tiến trình đồng bộ" 
        visible={isModalOpen} 
        onCancel={() => setIsModalOpen(false)}
        onOk={() => form.submit()}
      >
        <Form form={form} layout="vertical" onFinish={handleCreateAndValidate}>
          <Form.Item label="DataSource Nguồn" name="source" rules={[{ required: true }]}>
            <Select>
              {dataSources.map(ds => <Select.Option key={ds.key} value={ds.key}>{ds.key}</Select.Option>)}
            </Select>
          </Form.Item>
          <Form.Item label="DataSource Đích" name="target" rules={[{ required: true }]}>
            <Select>
              {dataSources.map(ds => <Select.Option key={ds.key} value={ds.key}>{ds.key}</Select.Option>)}
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
};
