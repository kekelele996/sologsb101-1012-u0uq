/**
 * 模块 3：/calibrations 标定记录台（台网中心侧）
 * 录入灵敏度 / 自噪 / 脉冲响应结论并批量改结论，叠加多次标定并绘出灵敏度趋势。
 * 灵敏度变化与稳定率按同档口径：只与同一量程档内的前一次标定比较，跨档不直接相减；
 * 量程档与调整记录归计量站侧（下方 <RangeBoard>），两侧按通道号对账（<ReconcilePanel>）。
 * 复用 <FilterBar>、<QualifyTag>、<EmptyPanel>。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import FilterBar from '@/components/common/FilterBar';
import type { FilterModel } from '@/types/filter';
import StatBadge from '@/components/common/StatBadge';
import QualifyTag from '@/components/common/QualifyTag';
import EmptyPanel from '@/components/common/EmptyPanel';
import RangeBoard from '@/components/common/RangeBoard';
import ReconcilePanel from '@/components/common/ReconcilePanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import { selectRangeById, selectReconcileIssues } from '@/stores/rangeSlice';
import {
  bulkSetVerdict,
  createCalibration,
  patchFilter,
  removeCalibration,
  resetFilter,
  selectCalibrationFilter,
  selectCalibrations,
  updateCalibration,
} from '@/stores/calibrationSlice';
import {
  RESPONSE_VERDICTS,
  SELF_NOISE_LIMIT,
  SENSITIVITY_DRIFT_LIMIT,
  SENSITIVITY_RANGE,
  createEmptyCalibrationFilter,
  judgeCalibration,
  sensitivityDeltaSameRange,
  type Calibration,
  type ResponseVerdict,
  type SensitivityDelta,
} from '@/types/calibration';
import { INSTRUMENT_TYPES, type InstrumentType } from '@/types/instrument';
import { round } from '@/utils/geo';
import { initDatabase } from '@/utils/db';

interface CalibrationFormValues {
  instrumentId: string;
  date: dayjs.Dayjs | null;
  sensitivity: number;
  selfNoise: number;
  responseVerdict: ResponseVerdict;
  operator: string;
  agency: string;
  remark: string;
}

/** 标定行：附带仪器、台站、台阵信息、量程档与灵敏度变化 */
interface CalibrationRow {
  row: Calibration;
  instrumentModel: string;
  instrumentType: string;
  serialNo: string;
  stationCode: string;
  arrayName: string;
  arrayId: string;
  /** 当时生效档位名（无档位为 null，对账挂起） */
  rangeLabel: string | null;
  delta: SensitivityDelta;
}

export default function CalibrationBoard() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();
  const [searchParams, setSearchParams] = useSearchParams();

  const calibrations = useAppSelector(selectCalibrations);
  const instruments = useAppSelector(selectInstruments);
  const stations = useAppSelector(selectStations);
  const arrays = useAppSelector(selectArrays);
  const filter = useAppSelector(selectCalibrationFilter);
  const rangeById = useAppSelector(selectRangeById);
  const reconcileIssues = useAppSelector(selectReconcileIssues);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [trendInstrumentId, setTrendInstrumentId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<CalibrationFormValues>();

  useEffect(() => {
    dispatch(
      patchFilter({
        keyword: searchParams.get('kw') ?? '',
        verdicts: (searchParams.get('verdict')?.split(',').filter(Boolean) ?? []) as ResponseVerdict[],
        instrumentTypes: searchParams.get('type')?.split(',').filter(Boolean) ?? [],
        onlyOverdue: searchParams.get('overdue') === '1',
      })
    );
    if (arrays.length === 0) void initDatabase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const instrumentIndex = useMemo(() => {
    const map = new Map<
      string,
      { model: string; type: string; serialNo: string; stationCode: string; arrayName: string; arrayId: string }
    >();
    instruments.forEach((instrument) => {
      const station = stations.find((row) => row.id === instrument.stationId);
      const array = station ? arrays.find((row) => row.id === station.arrayId) : undefined;
      map.set(instrument.id, {
        model: instrument.model,
        type: instrument.type,
        serialNo: instrument.serialNo,
        stationCode: station?.code ?? '未知台站',
        arrayName: array?.name ?? '未知台阵',
        arrayId: array?.id ?? '',
      });
    });
    return map;
  }, [arrays, instruments, stations]);

  /** 逐仪器排序后的标定序列，按同档口径计算灵敏度变化（跨档两条不直接相减） */
  const deltaIndex = useMemo(() => {
    const grouped = new Map<string, Calibration[]>();
    calibrations.forEach((row) => {
      const list = grouped.get(row.instrumentId) ?? [];
      list.push(row);
      grouped.set(row.instrumentId, list);
    });
    const result = new Map<string, SensitivityDelta>();
    grouped.forEach((list) => {
      const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
      sorted.forEach((row, index) => {
        const previousSameRange =
          sorted
            .slice(0, index)
            .reverse()
            .find((item) => (item.rangeId ?? null) === (row.rangeId ?? null)) ?? null;
        if (previousSameRange) {
          result.set(row.id, sensitivityDeltaSameRange(row, previousSameRange));
        } else {
          result.set(row.id, { absolute: 0, percent: 0, comparable: false, crossRange: index > 0 });
        }
      });
    });
    return result;
  }, [calibrations]);

  const rows = useMemo<CalibrationRow[]>(() => {
    return calibrations
      .map((row) => {
        const info = instrumentIndex.get(row.instrumentId);
        return {
          row,
          instrumentModel: info?.model ?? '仪器已删除',
          instrumentType: info?.type ?? '未知',
          serialNo: info?.serialNo ?? '—',
          stationCode: info?.stationCode ?? '—',
          arrayName: info?.arrayName ?? '—',
          arrayId: info?.arrayId ?? '',
          rangeLabel: row.rangeId ? rangeById.get(row.rangeId)?.label ?? '档位已删除' : null,
          delta: deltaIndex.get(row.id) ?? { absolute: 0, percent: 0, comparable: false, crossRange: false },
        };
      })
      .filter((item) => {
        const keyword = filter.keyword.trim();
        if (keyword.length > 0) {
          const haystack = `${item.instrumentModel}${item.serialNo}${item.stationCode}${item.arrayName}${item.row.operator}${item.row.agency}`;
          if (!haystack.includes(keyword)) return false;
        }
        if (filter.verdicts.length > 0 && !filter.verdicts.includes(item.row.responseVerdict)) return false;
        if (filter.instrumentTypes.length > 0 && !filter.instrumentTypes.includes(item.instrumentType)) return false;
        if (filter.onlyOverdue && item.row.responseVerdict !== '不合格') return false;
        return true;
      })
      .sort((a, b) => b.row.date.localeCompare(a.row.date));
  }, [calibrations, deltaIndex, filter, instrumentIndex, rangeById]);

  const totals = useMemo(() => {
    const unqualified = rows.filter((item) => item.row.responseVerdict === '不合格').length;
    const meanSensitivity =
      rows.length === 0
        ? 0
        : round(rows.reduce((sum, item) => sum + item.row.sensitivity, 0) / rows.length, 1);
    const meanNoise =
      rows.length === 0 ? 0 : round(rows.reduce((sum, item) => sum + item.row.selfNoise, 0) / rows.length, 2);
    // 灵敏度稳定率：与趋势图同一口径——只统计同档可比的记录，跨档换档不计入
    const comparable = rows.filter((item) => item.delta.comparable);
    const stable = comparable.filter((item) => Math.abs(item.delta.percent) <= SENSITIVITY_DRIFT_LIMIT);
    return {
      count: rows.length,
      unqualified,
      qualifyRate: rows.length === 0 ? 0 : round(((rows.length - unqualified) / rows.length) * 100, 1),
      meanSensitivity,
      meanNoise,
      operatorCount: new Set(rows.map((item) => item.row.operator)).size,
      comparableCount: comparable.length,
      stableRate: comparable.length === 0 ? 0 : round((stable.length / comparable.length) * 100, 1),
    };
  }, [rows]);

  const filterModel: FilterModel = {
    keyword: filter.keyword,
    verdicts: filter.verdicts,
    instrumentTypes: filter.instrumentTypes,
  };

  const trendRows = useMemo(() => {
    const targetId = trendInstrumentId ?? rows[0]?.row.instrumentId ?? null;
    if (!targetId) return { targetId: null as string | null, points: [] as Calibration[] };
    return {
      targetId,
      points: calibrations
        .filter((row) => row.instrumentId === targetId)
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  }, [calibrations, rows, trendInstrumentId]);

  const openCreate = () => {
    setEditingId(null);
    const firstInstrument = instruments[0];
    const type = (firstInstrument?.type ?? '宽频带') as InstrumentType;
    const range = SENSITIVITY_RANGE[type];
    form.setFieldsValue({
      instrumentId: firstInstrument?.id ?? '',
      date: dayjs(),
      sensitivity: round((range.min + range.max) / 2, 2),
      selfNoise: 1.5,
      responseVerdict: '合格',
      operator: '陈立群',
      agency: '省地震局计量站',
      remark: '',
    });
    setModalOpen(true);
  };

  const openEdit = (row: Calibration) => {
    setEditingId(row.id);
    form.setFieldsValue({
      instrumentId: row.instrumentId,
      date: dayjs(row.date),
      sensitivity: row.sensitivity,
      selfNoise: row.selfNoise,
      responseVerdict: row.responseVerdict,
      operator: row.operator,
      agency: row.agency,
      remark: row.remark,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      const payload = {
        instrumentId: values.instrumentId,
        date: values.date ? values.date.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
        sensitivity: Number(values.sensitivity),
        selfNoise: Number(values.selfNoise),
        responseVerdict: values.responseVerdict,
        operator: values.operator.trim(),
        agency: values.agency?.trim() ?? '',
        remark: values.remark?.trim() ?? '',
      };
      if (editingId) {
        await dispatch(updateCalibration({ id: editingId, patch: payload })).unwrap();
        message.success('标定记录已更新，结论已按灵敏度与自噪重新核定');
      } else {
        await dispatch(createCalibration(payload)).unwrap();
        const instrument = instruments.find((row) => row.id === payload.instrumentId);
        const verdict = judgeCalibration(instrument?.type ?? '宽频带', payload.sensitivity, payload.selfNoise);
        message.success(`标定记录已保存，自动初判为「${verdict}」`);
      }
      setModalOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleBulkVerdict = async (verdict: ResponseVerdict) => {
    if (selectedKeys.length === 0) {
      message.warning('请先勾选要批量改结论的记录');
      return;
    }
    await dispatch(bulkSetVerdict({ ids: selectedKeys, verdict })).unwrap();
    message.success(`已将 ${selectedKeys.length} 条标定记录的响应结论改为「${verdict}」`);
    setSelectedKeys([]);
  };

  const handleFilterChange = (next: FilterModel, switchValue: boolean) => {
    dispatch(
      patchFilter({
        keyword: next.keyword,
        verdicts: ((next.verdicts as string[]) ?? []) as ResponseVerdict[],
        instrumentTypes: (next.instrumentTypes as string[]) ?? [],
        onlyOverdue: switchValue,
      })
    );
    const params = new URLSearchParams();
    if (next.keyword.trim()) params.set('kw', next.keyword.trim());
    if (((next.verdicts as string[]) ?? []).length > 0) params.set('verdict', ((next.verdicts as string[]) ?? []).join(','));
    if (((next.instrumentTypes as string[]) ?? []).length > 0)
      params.set('type', ((next.instrumentTypes as string[]) ?? []).join(','));
    if (switchValue) params.set('overdue', '1');
    setSearchParams(params, { replace: true });
  };

  const handleReset = () => {
    dispatch(resetFilter());
    setSearchParams(new URLSearchParams(), { replace: true });
  };

  /** 灵敏度趋势图坐标：按量程档分段，跨档断开（与灵敏度稳定率同一口径） */
  const trendChart = useMemo(() => {
    const points = trendRows.points;
    if (points.length === 0) {
      return {
        segments: [] as Array<{ key: string; line: string }>,
        dots: [] as Array<{ id: string; cx: number; cy: number; date: string; sensitivity: number }>,
        switches: [] as Array<{ key: string; x: number; label: string }>,
        min: 0,
        max: 0,
      };
    }
    const sensitivities = points.map((row) => row.sensitivity);
    const min = Math.min(...sensitivities) * 0.98;
    const max = Math.max(...sensitivities) * 1.02;
    const left = 58;
    const right = 340;
    const top = 20;
    const bottom = 190;
    const toX = (index: number): number =>
      points.length === 1 ? (left + right) / 2 : left + (index * (right - left)) / (points.length - 1);
    const toY = (value: number): number =>
      max - min < 1e-6 ? (top + bottom) / 2 : bottom - ((value - min) / (max - min)) * (bottom - top);
    const dots = points.map((row, index) => ({
      id: row.id,
      cx: Number(toX(index).toFixed(1)),
      cy: Number(toY(row.sensitivity).toFixed(1)),
      date: row.date,
      sensitivity: row.sensitivity,
      rangeId: row.rangeId ?? null,
    }));
    // 连续同档位为一段；跨档处断开并标注新生效档位
    const segments: Array<{ key: string; line: string }> = [];
    const switches: Array<{ key: string; x: number; label: string }> = [];
    let current: typeof dots = [];
    dots.forEach((dot, index) => {
      if (index > 0 && (dot.rangeId ?? null) !== (dots[index - 1].rangeId ?? null)) {
        segments.push({ key: `seg-${segments.length}`, line: current.map((d) => `${d.cx},${d.cy}`).join(' ') });
        const label = dot.rangeId ? rangeById.get(dot.rangeId)?.label ?? '新档位' : '缺档';
        switches.push({ key: `sw-${dot.id}`, x: dot.cx, label: `换档→${label}` });
        current = [];
      }
      current.push(dot);
    });
    if (current.length > 0) {
      segments.push({ key: `seg-${segments.length}`, line: current.map((d) => `${d.cx},${d.cy}`).join(' ') });
    }
    return { segments, dots, switches, min, max };
  }, [trendRows, rangeById]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            标定记录台
          </Typography.Title>
          <p className="gb-hint">
            录入灵敏度、自噪与脉冲响应结论，系统按类型灵敏度区间（宽频带 {SENSITIVITY_RANGE.宽频带.min} ~{' '}
            {SENSITIVITY_RANGE.宽频带.max}）与自噪限值（{SELF_NOISE_LIMIT}）自动初判；可勾选批量改结论。
            灵敏度变化与稳定率按同档口径：只与同一量程档内的前一次标定比较，跨档换档不直接相减。
          </p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void initDatabase()}>
            补齐演示数据
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增标定记录
          </Button>
        </Space>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="标定记录" value={totals.count} suffix="次" tone="primary" />
        <StatBadge
          label="不合格"
          value={totals.unqualified}
          suffix="次"
          tone={totals.unqualified > 0 ? 'danger' : 'success'}
        />
        <StatBadge label="合格率" value={totals.qualifyRate} percent={totals.qualifyRate} tone="success" />
        <StatBadge
          label="灵敏度稳定率"
          value={totals.stableRate}
          percent={totals.stableRate}
          tone={totals.stableRate < 100 ? 'warning' : 'info'}
        />
        <StatBadge label="平均灵敏度" value={totals.meanSensitivity} suffix="V·s/m" tone="info" />
        <StatBadge label="平均自噪" value={totals.meanNoise} suffix="" tone="warning" />
        <StatBadge label="标定人" value={totals.operatorCount} suffix="人" tone="default" />
      </div>

      {reconcileIssues.length > 0 ? (
        <p className="gb-hint">
          两侧对账有 {reconcileIssues.length} 条挂起，详见页面底部「两侧对账与补跑」。
        </p>
      ) : null}

      <FilterBar
        modelValue={filterModel}
        selects={[
          {
            key: 'verdicts',
            label: '响应结论',
            options: RESPONSE_VERDICTS.map((verdict) => ({ label: verdict, value: verdict })),
          },
          {
            key: 'instrumentTypes',
            label: '仪器类型',
            options: INSTRUMENT_TYPES.map((type) => ({ label: type, value: type })),
          },
        ]}
        hasSwitch
        switchLabel="仅看不合格记录"
        switchValue={filter.onlyOverdue}
        keywordPlaceholder="搜索型号 / 序列号 / 台站 / 标定人"
        onChange={handleFilterChange}
        onReset={handleReset}
        extra={
          <Space size={6}>
            <span className="gb-hint">批量改结论：</span>
            {RESPONSE_VERDICTS.map((verdict) => (
              <Button key={verdict} size="small" onClick={() => void handleBulkVerdict(verdict)}>
                {verdict}
              </Button>
            ))}
          </Space>
        }
      />

      {rows.length === 0 ? (
        <EmptyPanel
          title={calibrations.length === 0 ? '还没有标定记录' : '没有符合条件的标定记录'}
          description="先到「台站仪器」页登记仪器，再按次录入灵敏度与自噪，即可形成可追溯的标定台账。"
          actionText="新增标定记录"
          secondaryText="重置筛选"
          onAction={openCreate}
          onSecondary={handleReset}
        />
      ) : (
        <Table
          rowKey={(item) => item.row.id}
          className="gb-table-compact"
          dataSource={rows}
          pagination={{ pageSize: 12, showSizeChanger: false }}
          rowSelection={{
            selectedRowKeys: selectedKeys,
            onChange: (keys) => setSelectedKeys(keys as string[]),
          }}
          columns={[
            {
              title: '仪器',
              width: 200,
              render: (_: unknown, item: CalibrationRow) => (
                <div>
                  <div>
                    {item.instrumentModel} <Tag>{item.instrumentType}</Tag>
                  </div>
                  <div className="gb-hint gb-mono">{item.serialNo}</div>
                </div>
              ),
            },
            {
              title: '台站 / 台阵',
              width: 180,
              render: (_: unknown, item: CalibrationRow) => (
                <div>
                  <div className="gb-mono">{item.stationCode}</div>
                  <div className="gb-hint">{item.arrayName}</div>
                </div>
              ),
            },
            { title: '标定日期', dataIndex: ['row', 'date'], width: 120, className: 'gb-mono' },
            {
              title: '量程档',
              width: 110,
              render: (_: unknown, item: CalibrationRow) =>
                item.rangeLabel ? (
                  <Tag>{item.rangeLabel}</Tag>
                ) : (
                  <Tag color="orange">缺档挂起</Tag>
                ),
            },
            {
              title: '灵敏度 (V·s/m)',
              width: 150,
              align: 'right',
              render: (_: unknown, item: CalibrationRow) => (
                <div>
                  <span className="gb-mono">{item.row.sensitivity}</span>
                  {item.delta.comparable ? (
                    <div className={Math.abs(item.delta.percent) > SENSITIVITY_DRIFT_LIMIT ? 'gb-danger gb-hint' : 'gb-hint'}>
                      变化 {item.delta.absolute > 0 ? '+' : ''}
                      {item.delta.absolute}（{item.delta.percent}%）
                    </div>
                  ) : item.delta.crossRange ? (
                    <div className="gb-hint" style={{ color: '#d68910' }}>
                      换档不比（跨量程档）
                    </div>
                  ) : (
                    <div className="gb-hint">首次标定</div>
                  )}
                </div>
              ),
            },
            {
              title: '自噪',
              width: 100,
              align: 'right',
              render: (_: unknown, item: CalibrationRow) => (
                <span className={item.row.selfNoise > SELF_NOISE_LIMIT ? 'gb-danger gb-mono' : 'gb-mono'}>
                  {item.row.selfNoise}
                </span>
              ),
            },
            {
              title: '响应结论',
              width: 190,
              render: (_: unknown, item: CalibrationRow) => (
                <QualifyTag
                  verdict={item.row.responseVerdict}
                  sensitivity={item.row.sensitivity}
                  selfNoise={item.row.selfNoise}
                  size="small"
                />
              ),
            },
            {
              title: '标定人 / 机构',
              width: 170,
              render: (_: unknown, item: CalibrationRow) => (
                <div>
                  <div>{item.row.operator || '未署名'}</div>
                  <div className="gb-hint">{item.row.agency || '未填写机构'}</div>
                </div>
              ),
            },
            { title: '备注', dataIndex: ['row', 'remark'], ellipsis: true },
            {
              title: '操作',
              width: 190,
              render: (_: unknown, item: CalibrationRow) => (
                <Space size={6}>
                  <Button size="small" onClick={() => setTrendInstrumentId(item.row.instrumentId)}>
                    趋势
                  </Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(item.row)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除标定记录"
                    description={`确认删除 ${item.row.date} 的标定记录？`}
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() =>
                      void dispatch(removeCalibration(item.row.id))
                        .unwrap()
                        .then(() => message.success('标定记录已删除'))
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
      )}

      <Card
        className="gb-panel"
        size="small"
        title="灵敏度趋势"
        extra={
          <Select
            style={{ width: 260 }}
            placeholder="选择仪器"
            value={trendRows.targetId ?? undefined}
            onChange={(value) => setTrendInstrumentId(value)}
            options={instruments.map((instrument) => ({
              label: `${instrument.model}（${instrument.serialNo}）`,
              value: instrument.id,
            }))}
          />
        }
      >
        {trendChart.dots.length === 0 ? (
          <EmptyPanel title="暂无可绘制的趋势" description="该仪器还没有标定记录。" compact />
        ) : (
          <>
            <svg viewBox="0 0 380 220" className="gb-chart">
              <line x1="58" y1="190" x2="352" y2="190" stroke="#b9c6d4" />
              <line x1="58" y1="20" x2="58" y2="190" stroke="#b9c6d4" />
              <text x="8" y="24" className="gb-chart-axis">
                {round(trendChart.max, 0)}
              </text>
              <text x="8" y="194" className="gb-chart-axis">
                {round(trendChart.min, 0)}
              </text>
              {trendChart.switches.map((sw) => (
                <g key={sw.key}>
                  <line x1={sw.x} y1="20" x2={sw.x} y2="190" stroke="#d68910" strokeDasharray="4 3" />
                  <text x={Math.min(sw.x + 4, 250)} y="32" className="gb-chart-axis" fill="#d68910">
                    {sw.label}
                  </text>
                </g>
              ))}
              {trendChart.segments.map((segment) =>
                segment.line ? (
                  <polyline key={segment.key} points={segment.line} fill="none" stroke="#1e3a5f" strokeWidth="2" />
                ) : null
              )}
              {trendChart.dots.map((dot) => (
                <g key={dot.id}>
                  <circle cx={dot.cx} cy={dot.cy} r="4.5" fill="#7fd1e8" stroke="#1e3a5f" />
                  <text x={dot.cx - 22} y={220 - 4} className="gb-chart-axis">
                    {dot.date.slice(2)}
                  </text>
                </g>
              ))}
            </svg>
            <p className="gb-hint">
              纵轴为灵敏度（V·s/m），横轴为标定日期；共 {trendChart.dots.length} 次标定。
              趋势按量程档分段：跨档处断开并以虚线标注新档位，跨档两条不直接相减；
              同档变化超过 {SENSITIVITY_DRIFT_LIMIT}% 会以红色提示，与灵敏度稳定率同一口径。
            </p>
          </>
        )}
      </Card>

      <RangeBoard />

      <ReconcilePanel />

      <p className="gb-hint">
        需要处理超期或不合格仪器？前往
        <Button type="link" size="small" onClick={() => navigate('/replacements')}>
          合格评定与更换
        </Button>
        登记更换并跟踪到复核闭环。
      </p>

      <Modal
        open={modalOpen}
        title={editingId ? '编辑标定记录' : '新增标定记录'}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        confirmLoading={submitting}
        okText={editingId ? '保存修改' : '保存并初判'}
        width={640}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="instrumentId" label="被标定仪器" rules={[{ required: true, message: '请选择仪器' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={instruments.map((instrument) => {
                const info = instrumentIndex.get(instrument.id);
                return {
                  label: `${info?.arrayName ?? ''} / ${info?.stationCode ?? ''} · ${instrument.model}（${instrument.serialNo}）`,
                  value: instrument.id,
                };
              })}
              onChange={(value: string) => {
                const instrument = instruments.find((row) => row.id === value);
                const range = SENSITIVITY_RANGE[instrument?.type ?? '宽频带'];
                form.setFieldValue('sensitivity', round((range.min + range.max) / 2, 2));
              }}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="date" label="标定日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="responseVerdict" label="脉冲响应结论" rules={[{ required: true }]}>
                <Select options={RESPONSE_VERDICTS.map((verdict) => ({ label: verdict, value: verdict }))} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="sensitivity" label="灵敏度 (V·s/m)" rules={[{ required: true }]}>
                <InputNumber min={0} max={100000} step={0.01} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="selfNoise" label={`自噪（限值 ${SELF_NOISE_LIMIT}）`} rules={[{ required: true }]}>
                <InputNumber min={0} max={100} step={0.01} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="operator" label="标定人" rules={[{ required: true, message: '请填写标定人' }]}>
                <Input maxLength={20} placeholder="如：陈立群" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="agency" label="标定机构">
                <Input maxLength={40} placeholder="如：省地震局计量站" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} placeholder="如：响应曲线平滑 / 自噪接近上限" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
