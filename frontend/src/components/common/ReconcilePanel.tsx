/**
 * <ReconcilePanel> 两侧对账与补跑。
 * 计量站侧（量程档 / 调整记录）与台网中心侧（标定记录）按通道号对账：
 * 对不上的先挂着；计量站侧写失败的只补跑本侧，台网中心认下的标定记录不回退。
 * 被标定记录台（/calibrations）消费。
 */
import { useMemo, useState } from 'react';
import { App as AntdApp, Alert, Button, Card, Space, Table, Tag } from 'antd';
import { CheckCircleFilled, SyncOutlined } from '@ant-design/icons';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import {
  retryMetrologySide,
  selectMetrologyPending,
  selectMigrationSkipped,
  selectReconcileIssues,
} from '@/stores/rangeSlice';
import type { ReconcileIssueKind } from '@/types/range';

const KIND_COLOR: Record<ReconcileIssueKind, string> = {
  档位无仪器: 'orange',
  标定无档位: 'volcano',
  迁移未补档: 'default',
};

export default function ReconcilePanel() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const issues = useAppSelector(selectReconcileIssues);
  const pendingRetry = useAppSelector(selectMetrologyPending);
  const migrationSkipped = useAppSelector(selectMigrationSkipped);

  const [retrying, setRetrying] = useState(false);

  /** 迁移补不出的单列展示（不并入普通挂起列表） */
  const pendingIssues = useMemo(() => issues.filter((issue) => issue.kind !== '迁移未补档'), [issues]);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      const result = await dispatch(retryMetrologySide()).unwrap();
      if (result.done > 0) {
        message.success(`计量站侧补跑完成 ${result.done} 条，标定记录已补登档位`);
      } else {
        message.info('计量站侧没有可补跑的记录');
      }
      if (result.remaining.length > 0) {
        message.warning(`仍余 ${result.remaining.length} 条补跑失败，请检查计量站侧后重试`);
      }
    } finally {
      setRetrying(false);
    }
  };

  const allClear = pendingIssues.length === 0 && pendingRetry.length === 0 && migrationSkipped.length === 0;

  return (
    <Card
      className="gb-panel"
      size="small"
      title="两侧对账与补跑"
      extra={
        <Space size={6}>
          <Tag color={pendingRetry.length > 0 ? 'orange' : 'green'}>待补跑 {pendingRetry.length}</Tag>
          <Tag color={pendingIssues.length > 0 ? 'orange' : 'green'}>挂起 {pendingIssues.length}</Tag>
        </Space>
      }
    >
      <p className="gb-hint">
        计量站侧与台网中心侧按通道号（仪器序列号）对账，对不上的先挂着；
        计量站侧写不进去只补跑本侧，台网中心已认下的标定记录不回退。
      </p>

      {allClear ? (
        <Alert type="success" showIcon icon={<CheckCircleFilled />} message="两侧账目一致，没有挂起项" />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {pendingRetry.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              message={`计量站侧有 ${pendingRetry.length} 条写入失败待补跑（台网中心侧标定已认下，不回退）`}
              action={
                <Button size="small" icon={<SyncOutlined />} loading={retrying} onClick={() => void handleRetry()}>
                  补跑本侧
                </Button>
              }
            />
          ) : null}

          {pendingIssues.length > 0 ? (
            <Table
              rowKey={(issue) => `${issue.kind}-${issue.channelCode}-${issue.detail}`}
              size="small"
              className="gb-table-compact"
              dataSource={pendingIssues}
              pagination={false}
              columns={[
                {
                  title: '挂起类别',
                  width: 110,
                  render: (_: unknown, issue) => <Tag color={KIND_COLOR[issue.kind]}>{issue.kind}</Tag>,
                },
                { title: '通道号', dataIndex: 'channelCode', width: 200, className: 'gb-mono' },
                { title: '说明', dataIndex: 'detail', ellipsis: true },
              ]}
            />
          ) : null}

          {migrationSkipped.length > 0 ? (
            <div>
              <p className="gb-hint" style={{ marginBottom: 6 }}>
                升级迁移补不出默认档的清单（单列，需人工核对后补建）：
              </p>
              <Table
                rowKey={(item) => `${item.source}-${item.sourceId}`}
                size="small"
                className="gb-table-compact"
                dataSource={migrationSkipped}
                pagination={false}
                columns={[
                  {
                    title: '来源',
                    width: 90,
                    render: (_: unknown, item) => (
                      <Tag>{item.source === 'calibration' ? '标定' : '仪器'}</Tag>
                    ),
                  },
                  { title: '记录 id', dataIndex: 'sourceId', width: 220, className: 'gb-mono' },
                  { title: '补不出的原因', dataIndex: 'reason', ellipsis: true },
                ]}
              />
            </div>
          ) : null}
        </Space>
      )}
    </Card>
  );
}
