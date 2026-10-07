/**
 * <ReconcilePanel> 两侧按通道号对账的挂账清单。
 * 计量站页与标定记录台共用：对不上先挂着（不强行兜底），
 * 计量站侧的同步失败可在此「补跑本侧」，台网中心已认标定不回退。
 */
import { Button, Card, Empty, Space, Table, Tag, Typography } from 'antd';
import { CloudSyncOutlined } from '@ant-design/icons';
import type { ReconcileResult } from '@/utils/reconcile';

export interface ReconcilePanelProps {
  result: ReconcileResult;
  /** 是否展示「补跑同步」按钮（仅计量站侧需要） */
  canRetry?: boolean;
  onRetry?: (adjustmentId: string) => void;
  retryingId?: string | null;
}

const SYNC_TAG: Record<string, { color: string; text: string }> = {
  同步失败: { color: 'red', text: '同步失败' },
};

export function ReconcilePanel({ result, canRetry = false, onRetry, retryingId }: ReconcilePanelProps) {
  if (!result.hasPending) {
    return (
      <Card className="gb-panel" size="small" title="通道对账（计量站 ↔ 台网中心）">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="两侧按通道号全部对上，无挂账；灵敏度变化与合格率按同档口径统计。"
        />
      </Card>
    );
  }

  return (
    <Card
      className="gb-panel"
      size="small"
      title={
        <Space>
          <span>通道对账挂账</span>
          <Tag color="orange">先挂着，待处理</Tag>
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {result.failedAdjustments.length > 0 && (
          <div>
            <Typography.Text strong>计量站调整同步失败（只补跑本侧，台网已认标定不回退）</Typography.Text>
            <Table
              rowKey="id"
              size="small"
              className="gb-table-compact"
              pagination={false}
              style={{ marginTop: 6 }}
              dataSource={result.failedAdjustments}
              columns={[
                { title: '通道号', dataIndex: 'channelCode', width: 130, className: 'gb-mono' },
                { title: '生效日期', dataIndex: 'effectiveDate', width: 120, className: 'gb-mono' },
                {
                  title: '档位调整',
                  width: 150,
                  render: (_: unknown, row) => (
                    <Space size={4}>
                      <Tag>{row.fromGear ?? '—'}</Tag>
                      <span>→</span>
                      <Tag color="blue">{row.toGear}</Tag>
                    </Space>
                  ),
                },
                { title: '失败原因', dataIndex: 'syncError', ellipsis: true },
                canRetry
                  ? {
                      title: '操作',
                      width: 110,
                      render: (_: unknown, row) => (
                        <Button
                          size="small"
                          type="primary"
                          icon={<CloudSyncOutlined />}
                          loading={retryingId === row.id}
                          onClick={() => onRetry?.(row.id)}
                        >
                          补跑同步
                        </Button>
                      ),
                    }
                  : { title: '状态', width: 100, render: () => <Tag color="red">待补跑</Tag> },
              ]}
            />
          </div>
        )}

        {result.orphanChannels.length > 0 && (
          <div>
            <Typography.Text strong>计量站有通道、台网中心暂无标定（含仪器未装的先行建档）</Typography.Text>
            <Table
              rowKey="id"
              size="small"
              className="gb-table-compact"
              pagination={false}
              style={{ marginTop: 6 }}
              dataSource={result.orphanChannels}
              columns={[
                { title: '通道号', dataIndex: 'channelCode', width: 150, className: 'gb-mono' },
                { title: '当前档位', dataIndex: 'currentGear', width: 110, render: (v: string) => <Tag>{v}</Tag> },
                { title: '分量', dataIndex: 'component', width: 160 },
                { title: '说明', dataIndex: 'remark', ellipsis: true },
              ]}
            />
          </div>
        )}

        {result.unmatchedCalibs.length > 0 && (
          <div>
            <Typography.Text strong>台网中心有标定、计量站查无此通道（含旧数据补不出默认档，单列）</Typography.Text>
            <Table
              rowKey="id"
              size="small"
              className="gb-table-compact"
              pagination={false}
              style={{ marginTop: 6 }}
              dataSource={result.unmatchedCalibs}
              columns={[
                {
                  title: '通道号',
                  width: 150,
                  className: 'gb-mono',
                  render: (_: unknown, row) => row.channelCode || '（空）',
                },
                { title: '标定日期', dataIndex: 'date', width: 120, className: 'gb-mono' },
                {
                  title: '档位',
                  dataIndex: 'gear',
                  width: 120,
                  render: (v: string) =>
                    v ? <Tag>{v}</Tag> : <Tag color="red">档位缺失，待补</Tag>,
                },
                { title: '灵敏度', dataIndex: 'sensitivity', width: 110, align: 'right', className: 'gb-mono' },
              ]}
            />
          </div>
        )}

        {result.gearConflicts.length > 0 && (
          <div>
            <Typography.Text strong>标定登记档位与计量站调整记录推算档位不一致（待人工核）</Typography.Text>
            <Table
              rowKey={(row) => row.calibration.id}
              size="small"
              className="gb-table-compact"
              pagination={false}
              style={{ marginTop: 6 }}
              dataSource={result.gearConflicts}
              columns={[
                {
                  title: '通道号',
                  width: 150,
                  className: 'gb-mono',
                  render: (_: unknown, row) => row.calibration.channelCode || '（空）',
                },
                { title: '标定日期', width: 120, className: 'gb-mono', render: (_: unknown, row) => row.calibration.date },
                {
                  title: '登记 / 应生效',
                  width: 180,
                  render: (_: unknown, row) => (
                    <Space size={4}>
                      <Tag color="red">{row.recordedGear || '缺失'}</Tag>
                      <span>/</span>
                      <Tag color="blue">{row.resolvedGear}</Tag>
                    </Space>
                  ),
                },
              ]}
            />
          </div>
        )}
      </Space>
    </Card>
  );
}

export default ReconcilePanel;
