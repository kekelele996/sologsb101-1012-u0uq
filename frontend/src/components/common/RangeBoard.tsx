/**
 * <RangeBoard> 量程档与调整记录（计量站侧）。
 * 按通道展示当前生效档、档位历史与调整留痕，支持换档；
 * 只写计量站侧档案，不触碰台网中心侧的标定记录。
 * 被标定记录台（/calibrations）消费。
 */
import { useMemo, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import { SwapOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectInstruments } from '@/stores/instrumentSlice';
import {
  selectRangeAdjustments,
  selectRangeError,
  selectRanges,
  switchRange,
} from '@/stores/rangeSlice';
import { RANGE_LABELS, currentRangeOf, type GainRange } from '@/types/range';

interface SwitchFormValues {
  channelCode: string;
  label: string;
  date: dayjs.Dayjs | null;
  reason: string;
  operator: string;
  remark: string;
}

/** 通道行：一台仪器（通道）的档位汇总 */
interface ChannelRow {
  channelCode: string;
  model: string;
  /** 仪器档案是否还在（不在则对账挂起） */
  instrumentAlive: boolean;
  current: GainRange | null;
  rangeCount: number;
  adjustmentCount: number;
  ranges: GainRange[];
}

export default function RangeBoard() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const instruments = useAppSelector(selectInstruments);
  const ranges = useAppSelector(selectRanges);
  const adjustments = useAppSelector(selectRangeAdjustments);
  const rangeError = useAppSelector(selectRangeError);

  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<SwitchFormValues>();

  /** 按通道聚合档位：仪器档案有的按档案列示，只有档位没有仪器的也列出（对账挂起） */
  const channelRows = useMemo<ChannelRow[]>(() => {
    const rows: ChannelRow[] = instruments.map((instrument) => {
      const own = ranges
        .filter((row) => row.channelCode === instrument.serialNo)
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      return {
        channelCode: instrument.serialNo,
        model: instrument.model,
        instrumentAlive: true,
        current: currentRangeOf(own, instrument.serialNo),
        rangeCount: own.length,
        adjustmentCount: adjustments.filter((row) => row.channelCode === instrument.serialNo).length,
        ranges: own,
      };
    });
    const known = new Set(instruments.map((instrument) => instrument.serialNo));
    const orphanChannels = [...new Set(ranges.map((row) => row.channelCode))].filter((code) => !known.has(code));
    orphanChannels.forEach((code) => {
      const own = ranges
        .filter((row) => row.channelCode === code)
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      rows.push({
        channelCode: code,
        model: '仪器档案缺失',
        instrumentAlive: false,
        current: currentRangeOf(own, code),
        rangeCount: own.length,
        adjustmentCount: adjustments.filter((row) => row.channelCode === code).length,
        ranges: own,
      });
    });
    return rows.sort((a, b) => a.channelCode.localeCompare(b.channelCode));
  }, [adjustments, instruments, ranges]);

  const openSwitch = (channelCode?: string) => {
    form.setFieldsValue({
      channelCode: channelCode ?? instruments[0]?.serialNo ?? '',
      label: RANGE_LABELS[0],
      date: dayjs(),
      reason: '',
      operator: '周渝',
      remark: '',
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await dispatch(
        switchRange({
          channelCode: values.channelCode,
          label: values.label,
          date: values.date ? values.date.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
          reason: values.reason.trim(),
          operator: values.operator.trim(),
          remark: values.remark?.trim() ?? '',
        })
      ).unwrap();
      message.success('换档完成：调整记录已留痕，后续标定将记下新档位');
      setModalOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '换档失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card
      className="gb-panel"
      size="small"
      title="量程档与调整记录（计量站侧）"
      extra={
        <Button size="small" type="primary" icon={<SwapOutlined />} onClick={() => openSwitch()}>
          登记换档
        </Button>
      }
    >
      <p className="gb-hint">
        计量站管各通道量程档与调整记录；换档后新标定自动记下当时生效档位，历史标定不回改。
        通道号即仪器序列号，与台网中心侧按此对账。
      </p>
      {rangeError ? <p className="gb-danger">{rangeError}</p> : null}
      {channelRows.length === 0 ? (
        <EmptyPanel
          title="还没有量程档"
          description="登记仪器后会自动建默认档；也可在录标定时由计量站侧补建。"
          compact
        />
      ) : (
        <Table
          rowKey={(row) => row.channelCode}
          size="small"
          className="gb-table-compact"
          dataSource={channelRows}
          pagination={false}
          expandable={{
            expandedRowRender: (row) => {
              const ownAdjustments = adjustments
                .filter((item) => item.channelCode === row.channelCode)
                .sort((a, b) => b.date.localeCompare(a.date));
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {row.ranges.length === 0 ? (
                    <span className="gb-hint">该通道还没有量程档，录入标定时会自动补建默认档。</span>
                  ) : (
                    row.ranges.map((range) => (
                      <div key={range.id} className="gb-hint">
                        <Tag color={range.effectiveTo === null ? 'green' : 'default'}>{range.label}</Tag>
                        <span className="gb-mono">
                          {range.effectiveFrom} ~ {range.effectiveTo ?? '今'}
                        </span>
                        {range.isDefault ? <Tag>默认档</Tag> : null}
                        {range.remark ? ` · ${range.remark}` : ''}
                      </div>
                    ))
                  )}
                  {ownAdjustments.length > 0 ? (
                    <div className="gb-hint">
                      调整留痕：
                      {ownAdjustments.map((item) => (
                        <div key={item.id}>
                          <span className="gb-mono">{item.date}</span> · {item.reason}（{item.operator}）
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            },
          }}
          columns={[
            {
              title: '通道号',
              width: 220,
              render: (_: unknown, row: ChannelRow) => (
                <div>
                  <div className="gb-mono">{row.channelCode}</div>
                  <div className="gb-hint">{row.model}</div>
                </div>
              ),
            },
            {
              title: '当前生效档',
              width: 140,
              render: (_: unknown, row: ChannelRow) =>
                row.current ? (
                  <Tag color="green">{row.current.label}</Tag>
                ) : (
                  <Tag color="orange">缺档</Tag>
                ),
            },
            {
              title: '生效日期',
              width: 120,
              render: (_: unknown, row: ChannelRow) => (
                <span className="gb-mono">{row.current?.effectiveFrom ?? '—'}</span>
              ),
            },
            {
              title: '档位 / 调整',
              width: 110,
              align: 'right',
              render: (_: unknown, row: ChannelRow) => (
                <span className="gb-mono">
                  {row.rangeCount} 档 / {row.adjustmentCount} 次
                </span>
              ),
            },
            {
              title: '对账',
              width: 100,
              render: (_: unknown, row: ChannelRow) =>
                row.instrumentAlive ? <Tag color="green">一致</Tag> : <Tag color="orange">挂起</Tag>,
            },
            {
              title: '操作',
              width: 110,
              render: (_: unknown, row: ChannelRow) => (
                <Button size="small" disabled={!row.instrumentAlive} onClick={() => openSwitch(row.channelCode)}>
                  换档
                </Button>
              ),
            },
          ]}
        />
      )}

      <Modal
        open={modalOpen}
        title="登记换档（计量站侧）"
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        confirmLoading={submitting}
        okText="确认换档"
        width={560}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="channelCode" label="通道（仪器序列号）" rules={[{ required: true, message: '请选择通道' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={instruments.map((instrument) => ({
                label: `${instrument.model}（${instrument.serialNo}）`,
                value: instrument.serialNo,
              }))}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="label" label="新档位" rules={[{ required: true, message: '请选择档位' }]}>
                <Select options={RANGE_LABELS.map((label) => ({ label, value: label }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="date" label="生效日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="reason" label="调整原因" rules={[{ required: true, message: '请填写调整原因' }]}>
            <Input maxLength={60} placeholder="如：远震观测需要，低增益调整为高增益" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="operator" label="操作人" rules={[{ required: true, message: '请填写操作人' }]}>
                <Input maxLength={20} placeholder="如：周渝" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="remark" label="备注">
                <Input maxLength={60} placeholder="选填" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </Card>
  );
}
