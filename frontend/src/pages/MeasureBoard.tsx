/**
 * 模块：/measure 计量站通道量程档与调整记录
 * 计量站只负责各通道的量程档与调整记录；灵敏度数值 / 变化 / 合格率在台网中心（标定记录台）。
 * 两侧按通道号对账（ReconcilePanel），对不上先挂着；
 * 计量站写不进去时只补跑本侧调整记录（retryAdjustmentSync），台网中心已认标定不回退。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, SlidersOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import ReconcilePanel from '@/components/common/ReconcilePanel';
import { ROUTES } from '@/router';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectStations, selectArrays } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import {
  createChannel,
  createAdjustment,
  removeChannel,
  removeAdjustment,
  retryAdjustmentSync,
  selectChannels,
  selectAdjustments,
  updateChannel,
} from '@/stores/measureSlice';
import {
  DEFAULT_RANGE_GEAR,
  RANGE_GEARS,
  buildChannelCode,
  type MeasureChannel,
  type RangeAdjustment,
  type RangeGear,
} from '@/types/measure';
import { useReconcile } from '@/hooks/useReconcile';
import { initDatabase } from '@/utils/db';

interface ChannelFormValues {
  stationId: string;
  instrumentId: string;
  channelCode: string;
  currentGear: RangeGear;
  component: string;
  remark: string;
}

interface AdjustFormValues {
  channelId: string;
  date: dayjs.Dayjs | null;
  effectiveDate: dayjs.Dayjs | null;
  toGear: RangeGear;
  reason: string;
  operator: string;
  remark: string;
}

const SYNC_COLOR: Record<string, string> = {
  已同步: 'green',
  待同步: 'orange',
  同步失败: 'red',
};

export default function MeasureBoard() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const arrays = useAppSelector(selectArrays);
  const stations = useAppSelector(selectStations);
  const instruments = useAppSelector(selectInstruments);
  const channels = useAppSelector(selectChannels);
  const adjustments = useAppSelector(selectAdjustments);
  const reconcile = useReconcile();

  const [channelModalOpen, setChannelModalOpen] = useState(false);
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [adjustModalOpen, setAdjustModalOpen] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [channelForm] = Form.useForm<ChannelFormValues>();
  const [adjustForm] = Form.useForm<AdjustFormValues>();

  useEffect(() => {
    if (arrays.length === 0) void initDatabase();
  }, [arrays.length]);

  const instrumentById = useMemo(
    () => new Map(instruments.map((instrument) => [instrument.id, instrument])),
    [instruments]
  );
  const stationById = useMemo(
    () => new Map(stations.map((station) => [station.id, station])),
    [stations]
  );
  const arrayById = useMemo(() => new Map(arrays.map((array) => [array.id, array])), [arrays]);

  const calibCountByChannel = useMemo(() => {
    // 用对账结果里每条标定的通道号统计该通道在台网中心的标定条数
    const countByCode = new Map<string, number>();
    reconcile.pointById.forEach((point) => {
      const code = point.calibration.channelCode;
      if (code) countByCode.set(code, (countByCode.get(code) ?? 0) + 1);
    });
    const map = new Map<string, number>();
    channels.forEach((channel) => map.set(channel.id, countByCode.get(channel.channelCode) ?? 0));
    return map;
  }, [channels, reconcile]);

  const channelRows = useMemo(
    () =>
      channels
        .map((channel) => {
          const station = channel.stationId ? stationById.get(channel.stationId) : undefined;
          const instrument = channel.instrumentId ? instrumentById.get(channel.instrumentId) : undefined;
          const array = station ? arrayById.get(station.arrayId) : undefined;
          return { channel, station, instrument, array };
        })
        .sort((a, b) => a.channel.channelCode.localeCompare(b.channel.channelCode, 'zh-Hans-CN')),
    [arrayById, channels, instrumentById, stationById]
  );

  const adjustmentRows = useMemo(
    () =>
      [...adjustments].sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || b.createdAt - a.createdAt),
    [adjustments]
  );

  const failedCount = adjustments.filter((row) => row.syncState === '同步失败').length;
  const pendingCount = adjustments.filter((row) => row.syncState === '待同步').length;

  const openCreateChannel = () => {
    setEditingChannelId(null);
    const firstInstrument = instruments[0];
    const firstStation = firstInstrument ? stationById.get(firstInstrument.stationId) : stations[0];
    channelForm.setFieldsValue({
      stationId: firstStation?.id ?? '',
      instrumentId: firstInstrument?.id ?? '',
      channelCode:
        firstInstrument && firstStation
          ? buildChannelCode(firstStation.code, firstInstrument.type)
          : '',
      currentGear: DEFAULT_RANGE_GEAR,
      component: '',
      remark: '',
    });
    setChannelModalOpen(true);
  };

  const openEditChannel = (channel: MeasureChannel) => {
    setEditingChannelId(channel.id);
    channelForm.setFieldsValue({
      stationId: channel.stationId,
      instrumentId: channel.instrumentId,
      channelCode: channel.channelCode,
      currentGear: channel.currentGear,
      component: channel.component,
      remark: channel.remark,
    });
    setChannelModalOpen(true);
  };

  const submitChannel = async () => {
    const values = await channelForm.validateFields();
    const payload = {
      channelCode: values.channelCode.trim(),
      instrumentId: values.instrumentId ?? '',
      stationId: values.stationId ?? '',
      currentGear: values.currentGear,
      component: values.component?.trim() ?? '',
      remark: values.remark?.trim() ?? '',
    };
    if (editingChannelId) {
      await dispatch(updateChannel({ id: editingChannelId, patch: payload })).unwrap();
      message.success('通道已更新（计量站侧）');
    } else {
      await dispatch(createChannel(payload)).unwrap();
      message.success('通道已建档（计量站侧），等待台网中心标定按通道号对账');
    }
    setChannelModalOpen(false);
  };

  const openAdjust = (channelId?: string) => {
    const channel = channels.find((item) => item.id === channelId) ?? channels[0];
    adjustForm.setFieldsValue({
      channelId: channel?.id,
      date: dayjs(),
      effectiveDate: dayjs(),
      toGear: channel?.currentGear ?? DEFAULT_RANGE_GEAR,
      reason: '',
      operator: '陈立群',
      remark: '',
    });
    setAdjustModalOpen(true);
  };

  const submitAdjust = async () => {
    const values = await adjustForm.validateFields();
    const channel = channels.find((item) => item.id === values.channelId);
    if (!channel) {
      message.warning('请选择通道');
      return;
    }
    await dispatch(
      createAdjustment({
        channelId: channel.id,
        channelCode: channel.channelCode,
        date: values.date ? values.date.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
        effectiveDate: values.effectiveDate
          ? values.effectiveDate.format('YYYY-MM-DD')
          : dayjs().format('YYYY-MM-DD'),
        fromGear: channel.currentGear,
        toGear: values.toGear,
        reason: values.reason.trim(),
        operator: values.operator.trim(),
        remark: values.remark?.trim() ?? '',
      })
    ).unwrap();
    message.success('量程调整已记录（计量站侧），台网中心后续标定按新档生效；同步失败可补跑本侧。');
    setAdjustModalOpen(false);
  };

  const handleRetry = async (adjustmentId: string) => {
    setRetryingId(adjustmentId);
    try {
      await dispatch(retryAdjustmentSync({ id: adjustmentId })).unwrap();
      message.success('补跑同步成功（仅更新计量站侧状态，台网已认标定未改动）');
    } catch (error) {
      message.error(typeof error === 'string' ? error : '补跑同步失败');
    } finally {
      setRetryingId(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            计量站 · 通道量程档与调整记录
          </Typography.Title>
          <p className="gb-hint">
            计量站只管各通道的量程档与调整记录；灵敏度数值、灵敏度变化与合格率归台网中心。
            两侧按通道号对账，跨档标定先归同档口径再比（同档各自跟前一次比），换档阶跃不会被看成仪器故障。
          </p>
        </div>
        <Space wrap>
          <Button icon={<SlidersOutlined />} onClick={() => openAdjust()}>
            登记量程调整
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreateChannel}>
            新增通道
          </Button>
        </Space>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="通道数" value={channels.length} suffix="条" tone="primary" />
        <StatBadge label="调整记录" value={adjustments.length} suffix="条" tone="info" />
        <StatBadge
          label="待同步"
          value={pendingCount}
          suffix="条"
          tone={pendingCount > 0 ? 'warning' : 'success'}
        />
        <StatBadge
          label="同步失败"
          value={failedCount}
          suffix="条"
          tone={failedCount > 0 ? 'danger' : 'success'}
        />
        <StatBadge label="对账挂账" value={reconcile.hasPending ? 1 : 0} suffix="类" tone="warning" />
      </div>

      {channels.length === 0 ? (
        <EmptyPanel
          title="还没有通道台账"
          description="计量站先按通道建量程档（通道号全局唯一），台网中心标定再按通道号对账。"
          actionText="新增通道"
          onAction={openCreateChannel}
        />
      ) : (
        <Card className="gb-panel" size="small" title={`通道量程档（${channelRows.length}）`}>
          <Table
            rowKey={(item) => item.channel.id}
            size="small"
            className="gb-table-compact"
            dataSource={channelRows}
            pagination={false}
            columns={[
              {
                title: '通道号',
                width: 140,
                render: (_: unknown, item) => <span className="gb-mono">{item.channel.channelCode}</span>,
              },
              {
                title: '台站 / 台阵',
                width: 200,
                render: (_: unknown, item) => (
                  <div>
                    <div className="gb-mono">{item.station?.code ?? '（未装仪器）'}</div>
                    <div className="gb-hint">{item.array?.name ?? '—'}</div>
                  </div>
                ),
              },
              {
                title: '仪器',
                width: 210,
                render: (_: unknown, item) =>
                  item.instrument ? (
                    <div>
                      <div>{item.instrument.model}</div>
                      <div className="gb-hint gb-mono">{item.instrument.serialNo}</div>
                    </div>
                  ) : (
                    <Tag color="orange">先行建档，待装仪器</Tag>
                  ),
              },
              { title: '分量', dataIndex: ['channel', 'component'], width: 150 },
              {
                title: '当前量程档',
                width: 120,
                render: (_: unknown, item) => <Tag color="blue">{item.channel.currentGear}</Tag>,
              },
              {
                title: '台网标定',
                width: 100,
                align: 'right',
                render: (_: unknown, item) => (
                  <span className="gb-mono">{calibCountByChannel.get(item.channel.id) ?? 0} 次</span>
                ),
              },
              {
                title: '操作',
                width: 230,
                render: (_: unknown, item) => (
                  <Space size={6}>
                    <Button size="small" icon={<SlidersOutlined />} onClick={() => openAdjust(item.channel.id)}>
                      调档
                    </Button>
                    <Button size="small" icon={<EditOutlined />} onClick={() => openEditChannel(item.channel)}>
                      编辑
                    </Button>
                    <Popconfirm
                      title="删除通道"
                      description="将同时删除该通道的调整记录，确认删除？"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() =>
                        void dispatch(removeChannel(item.channel.id))
                          .unwrap()
                          .then(() => message.success('通道已删除（计量站侧）'))
                      }
                    >
                      <Button size="small" danger icon={<DeleteOutlined />}>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      )}

      <Card className="gb-panel" size="small" title={`量程调整记录（${adjustmentRows.length}）`}>
        <Table
          rowKey="id"
          size="small"
          className="gb-table-compact"
          dataSource={adjustmentRows}
          pagination={false}
          locale={{ emptyText: '暂无调整记录' }}
          columns={[
            { title: '通道号', dataIndex: 'channelCode', width: 130, className: 'gb-mono' },
            { title: '调整日期', dataIndex: 'date', width: 110, className: 'gb-mono' },
            { title: '生效日期', dataIndex: 'effectiveDate', width: 110, className: 'gb-mono' },
            {
              title: '档位变化',
              width: 170,
              render: (_: unknown, row: RangeAdjustment) => (
                <Space size={4}>
                  <Tag>{row.fromGear ?? '建档'}</Tag>
                  <span>→</span>
                  <Tag color="blue">{row.toGear}</Tag>
                </Space>
              ),
            },
            { title: '原因', dataIndex: 'reason', ellipsis: true },
            { title: '操作人', dataIndex: 'operator', width: 90 },
            {
              title: '同步状态',
              width: 110,
              render: (_: unknown, row: RangeAdjustment) => (
                <Tag color={SYNC_COLOR[row.syncState]}>{row.syncState}</Tag>
              ),
            },
            {
              title: '操作',
              width: 120,
              render: (_: unknown, row: RangeAdjustment) => (
                <Space size={6}>
                  {row.syncState !== '已同步' ? (
                    <Button
                      size="small"
                      type="primary"
                      loading={retryingId === row.id}
                      onClick={() => void handleRetry(row.id)}
                    >
                      补跑同步
                    </Button>
                  ) : null}
                  <Popconfirm
                    title="删除调整记录"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() =>
                      void dispatch(removeAdjustment(row.id))
                        .unwrap()
                        .then(() => message.success('调整记录已删除（计量站侧）'))
                    }
                  >
                    <Button size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <ReconcilePanel
        result={reconcile}
        canRetry
        onRetry={(id) => void handleRetry(id)}
        retryingId={retryingId}
      />

      <p className="gb-hint">
        灵敏度趋势、变化量与合格率在台网中心维护，前往
        <Button type="link" size="small" onClick={() => navigate(ROUTES.calibrations)}>
          标定记录台
        </Button>
        查看（跨档已按同档口径断段比较）。
      </p>

      {/* 通道建档/编辑 */}
      <Modal
        open={channelModalOpen}
        title={editingChannelId ? '编辑通道（计量站）' : '新增通道（计量站）'}
        onCancel={() => setChannelModalOpen(false)}
        onOk={() => void submitChannel()}
        okText="保存"
        width={600}
        destroyOnClose
      >
        <Form form={channelForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="stationId" label="所属台站">
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  placeholder="先行建档可不选"
                  options={stations.map((station) => {
                    const array = arrayById.get(station.arrayId);
                    return { label: `${station.code}（${array?.name ?? '未知台阵'}）`, value: station.id };
                  })}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="instrumentId" label="关联仪器">
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  placeholder="先建通道可留空"
                  options={instruments.map((instrument) => {
                    const station = stationById.get(instrument.stationId);
                    return {
                      label: `${station?.code ?? ''} · ${instrument.model}（${instrument.serialNo}）`,
                      value: instrument.id,
                    };
                  })}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="channelCode" label="通道号（对账主键）" rules={[{ required: true, message: '请填写通道号' }]}>
                <Input maxLength={40} placeholder="如 LTX01-BB" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="currentGear" label="当前量程档" rules={[{ required: true }]}>
                <Select options={RANGE_GEARS.map((gear) => ({ label: gear, value: gear }))} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="component" label="分量 / 类型说明">
            <Input maxLength={40} placeholder="如 宽频带垂直向" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 量程调整 */}
      <Modal
        open={adjustModalOpen}
        title="登记量程调整（计量站）"
        onCancel={() => setAdjustModalOpen(false)}
        onOk={() => void submitAdjust()}
        okText="保存调整"
        width={600}
        destroyOnClose
      >
        <Form form={adjustForm} layout="vertical" preserve={false}>
          <Form.Item name="channelId" label="通道" rules={[{ required: true, message: '请选择通道' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={channels.map((channel) => ({ label: `${channel.channelCode}（当前：${channel.currentGear}）`, value: channel.id }))}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="date" label="调整日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="effectiveDate" label="生效日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="toGear" label="调整后档位" rules={[{ required: true }]}>
                <Select options={RANGE_GEARS.map((gear) => ({ label: gear, value: gear }))} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="reason" label="调整原因" rules={[{ required: true, message: '请填写调整原因' }]}>
            <Input maxLength={100} placeholder="如 弱震监视需要，提高数采增益" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="operator" label="操作人" rules={[{ required: true, message: '请填写操作人' }]}>
                <Input maxLength={20} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
