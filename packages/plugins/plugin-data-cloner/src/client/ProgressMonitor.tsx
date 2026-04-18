import React, { useEffect, useState } from 'react';
import { Card, Table, Tag, Button, Progress, Space } from 'antd';
import { useAPIClient } from '@nocobase/client';

export const ProgressMonitor = ({ taskId, onBack }) => {
  const api = useAPIClient();
  const [tables, setTables] = useState([]);
  const [loading, setLoading] = useState(false);

  const fetchTaskDetails = async () => {
    setLoading(true);
    try {
      const res = await api.request({ 
        url: 'clone_task_tables:list', 
        params: { 
          filter: { task_id: taskId },
          sort: ['id'] // Order by creation/table ID
        } 
      });
      setTables(res?.data?.data || []);
    } catch (error) {
      console.error(error);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchTaskDetails();
    
    // Auto refresh every 3 seconds to monitor progress
    const interval = setInterval(fetchTaskDetails, 3000);
    return () => clearInterval(interval);
  }, [taskId]);

  const columns = [
    { title: 'Tên Table', dataIndex: 'table_name', key: 'table' },
    { title: 'Trạng thái', dataIndex: 'status', key: 'status', render: (status) => <Tag>{status}</Tag> },
    { title: 'Đã sync (Records)', dataIndex: 'cloned_records', key: 'records' },
    { title: 'Checkpoint gần nhất', dataIndex: 'last_sync_value', key: 'checkpoint', render: (val) => val || 'N/A' },
    { title: 'Lỗi', dataIndex: 'error_message', key: 'error' }
  ];

  return (
    <Card 
      title={`Chi tiết tiến trình Task #${taskId}`} 
      extra={<Button onClick={onBack}>Quay lại</Button>}
    >
      <Table 
        dataSource={tables} 
        columns={columns} 
        rowKey="id" 
        pagination={false}
        loading={loading && tables.length === 0}
      />
    </Card>
  );
};
