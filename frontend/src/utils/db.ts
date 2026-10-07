/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbseisarray，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（台阵 → 台站 → 仪器 → 标定 / 更换）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie';
import type { SeisArray } from '@/types/array';
import type { SeisStation } from '@/types/station';
import type { Instrument } from '@/types/instrument';
import { judgeCalibration } from '@/types/calibration';
import type { Calibration } from '@/types/calibration';
import type { Replace } from '@/types/replace';
import type { GainRange, RangeAdjustment } from '@/types/range';
import { DEFAULT_RANGE_LABEL } from '@/types/range';

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3;

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbseisarray';

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbseisarray:db-version',
  lastBackupAt: 'gbseisarray:last-backup-at',
  lastArrayId: 'gbseisarray:last-array-id',
  /** 计量站侧待补跑队列（本侧写失败时入队，台网中心侧不回退） */
  metrologyPending: 'gbseisarray:metrology-pending',
  /** 升级迁移时补不出默认档的清单（单列展示） */
  rangeMigrationSkipped: 'gbseisarray:range-migration-skipped',
} as const;

/** 备份文件结构，供 utils/export.ts 与几何页使用 */
export interface BackupPayload {
  app: 'gbseisarray';
  dbVersion: number;
  exportedAt: string;
  arrays: SeisArray[];
  stations: SeisStation[];
  instruments: Instrument[];
  calibrations: Calibration[];
  replaces: Replace[];
  /** 计量站侧：量程档（旧备份可能缺失，导入时按空表处理） */
  ranges: GainRange[];
  /** 计量站侧：调整记录（旧备份可能缺失，导入时按空表处理） */
  rangeAdjustments: RangeAdjustment[];
}

/** 计量站侧待补跑项：录标定时本侧写失败入队，只补跑本侧 */
export interface MetrologyPendingItem {
  channelCode: string;
  /** 录标定日期（补建默认档的生效日期） */
  date: string;
  /** 已在台网中心侧认下的标定记录（补跑成功后回写档位，不回退） */
  calibrationId: string;
  enqueuedAt: string;
}

/** 升级迁移补不出默认档的记录（仪器档案缺失或通道号为空），单列展示 */
export interface RangeMigrationSkipped {
  source: 'calibration' | 'instrument';
  sourceId: string;
  reason: string;
}

export class SeisArrayDatabase extends Dexie {
  arrays!: Table<SeisArray, string>;
  stations!: Table<SeisStation, string>;
  instruments!: Table<Instrument, string>;
  calibrations!: Table<Calibration, string>;
  replaces!: Table<Replace, string>;
  ranges!: Table<GainRange, string>;
  rangeAdjustments!: Table<RangeAdjustment, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      arrays: 'id, name, state',
      stations: 'id, arrayId, code',
      instruments: 'id, stationId, serialNo, state',
      calibrations: 'id, instrumentId, date',
      replaces: 'id, instrumentId, state',
    });

    // v2：补齐筛选与统计需要的索引（孔径/布设日期、经纬度/基岩、类型/序列号、灵敏度/结论、原因）
    this.version(2)
      .stores({
        arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
        stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
        instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
        calibrations: 'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, updatedAt',
        replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
      })
      .upgrade(async (tx) => {
        // 迁移：历史数据补齐时间戳与必填字段，避免列表排序与筛选拿到 undefined
        const defaults: Array<[string, () => Record<string, unknown>]> = [
          ['arrays', () => ({ apertureKm: 0, stationCount: 0, department: '' })],
          ['stations', () => ({ lat: 0, lng: 0, elevM: 0, bedrock: '花岗岩', siteNote: '' })],
          ['instruments', () => ({ type: '宽频带', model: '', state: '在用', remark: '' })],
          ['calibrations', () => ({ sensitivity: 0, selfNoise: 0, responseVerdict: '待判定', agency: '' })],
          ['replaces', () => ({ state: '待更换', newSerialNo: '', operator: '' })],
        ];
        for (const [tableName, factory] of defaults) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now();
              if (typeof row.createdAt !== 'number') row.createdAt = now;
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt;
              Object.assign(row, factory());
            });
        }
      });

    // v3：职责切分——计量站侧新增量程档与调整记录两表；标定记录补当时生效档位与通道号。
    // 旧数据没有量程档：升级时按通道（仪器）补一条默认档并回填历史标定；
    // 补不出的（仪器档案缺失或通道号为空）不强行补，单列清单挂起。
    this.version(DB_VERSION)
      .stores({
        arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
        stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
        instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
        calibrations:
          'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, rangeId, channelCode, updatedAt',
        replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
        ranges: 'id, channelCode, effectiveFrom, updatedAt',
        rangeAdjustments: 'id, channelCode, toRangeId, date, updatedAt',
      })
      .upgrade(async (tx) => {
        const now = Date.now();
        const instruments = (await tx.table('instruments').toArray()) as Instrument[];
        const calibrations = (await tx.table('calibrations').toArray()) as Calibration[];
        const skipped: RangeMigrationSkipped[] = [];
        const defaultRangeByInstrument = new Map<string, GainRange>();

        // 按通道补一条默认档：生效日期取安装日期与最早标定日期中较早者，保证覆盖全部历史标定
        for (const instrument of instruments) {
          const channelCode = (instrument.serialNo ?? '').trim();
          if (!channelCode) {
            skipped.push({
              source: 'instrument',
              sourceId: instrument.id,
              reason: `仪器 ${instrument.model || instrument.id} 未登记序列号，无法确定通道号，默认档补不出`,
            });
            continue;
          }
          const ownDates = calibrations
            .filter((row) => row.instrumentId === instrument.id)
            .map((row) => row.date)
            .sort();
          const earliest = ownDates[0] ?? null;
          const effectiveFrom =
            earliest && (!instrument.installDate || earliest < instrument.installDate)
              ? earliest
              : instrument.installDate || earliest || new Date(now).toISOString().slice(0, 10);
          const range: GainRange = {
            id: createId('rng'),
            channelCode,
            label: DEFAULT_RANGE_LABEL,
            effectiveFrom,
            effectiveTo: null,
            isDefault: true,
            remark: '结构升级迁移补录的默认量程档',
            createdAt: now,
            updatedAt: now,
          };
          defaultRangeByInstrument.set(instrument.id, range);
        }
        await tx.table('ranges').bulkPut([...defaultRangeByInstrument.values()]);

        // 历史标定回填当时生效档位与通道号；仪器档案缺失的补不出，单列挂起
        for (const row of calibrations) {
          const range = defaultRangeByInstrument.get(row.instrumentId);
          if (!range) {
            skipped.push({
              source: 'calibration',
              sourceId: row.id,
              reason: `${row.date} 的标定记录找不到仪器档案（${row.instrumentId}），默认档补不出`,
            });
            continue;
          }
          await tx.table('calibrations').update(row.id, {
            rangeId: range.id,
            channelCode: range.channelCode,
          });
        }
        writeRangeMigrationSkipped(skipped);
      });
  }
}

export const db = new SeisArrayDatabase();

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 订阅单表变化（Dexie liveQuery），返回取消订阅函数 */
export function watchTable<T>(
  table: () => Table<T, string>
): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray());
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([]),
      });
      return () => subscription.unsubscribe();
    },
  };
}

/* ------------------------------ 计量站侧：量程档写入 ------------------------------ */

/**
 * 计量站侧：为通道补建默认量程档（含建档调整记录），返回新档 id。
 * 只写本侧两张表；调用方（台网中心侧）已认下的标定记录不因本侧失败而回退。
 */
export async function createDefaultRangeForChannel(
  channelCode: string,
  date: string,
  operator = '系统补录'
): Promise<string> {
  const now = Date.now();
  const rangeId = createId('rng');
  await db.transaction('rw', [db.ranges, db.rangeAdjustments], async () => {
    await db.ranges.put({
      id: rangeId,
      channelCode,
      label: DEFAULT_RANGE_LABEL,
      effectiveFrom: date,
      effectiveTo: null,
      isDefault: true,
      remark: '录标定时计量站侧自动补建的默认量程档',
      createdAt: now,
      updatedAt: now,
    });
    await db.rangeAdjustments.put({
      id: createId('adj'),
      channelCode,
      fromRangeId: null,
      toRangeId: rangeId,
      date,
      reason: '通道建档，补建默认量程档',
      operator,
      remark: '',
      createdAt: now,
      updatedAt: now,
    });
  });
  return rangeId;
}

/* ------------------------------ 计量站侧待补跑队列（localStorage） ------------------------------ */

export function readMetrologyPending(): MetrologyPendingItem[] {
  try {
    const raw = localStorage.getItem(LS_KEYS.metrologyPending);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as MetrologyPendingItem[]) : [];
  } catch {
    return [];
  }
}

export function writeMetrologyPending(items: MetrologyPendingItem[]): void {
  try {
    localStorage.setItem(LS_KEYS.metrologyPending, JSON.stringify(items));
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

/** 计量站侧写入失败时入队，等「补跑本侧」重试 */
export function enqueueMetrologyPending(item: MetrologyPendingItem): void {
  const queue = readMetrologyPending();
  queue.push(item);
  writeMetrologyPending(queue);
}

/* ------------------------------ 迁移补不出清单（localStorage） ------------------------------ */

export function readRangeMigrationSkipped(): RangeMigrationSkipped[] {
  try {
    const raw = localStorage.getItem(LS_KEYS.rangeMigrationSkipped);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as RangeMigrationSkipped[]) : [];
  } catch {
    return [];
  }
}

export function writeRangeMigrationSkipped(items: RangeMigrationSkipped[]): void {
  try {
    localStorage.setItem(LS_KEYS.rangeMigrationSkipped, JSON.stringify(items));
  } catch {
    // 忽略
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedCalibration {
  id: string;
  instrumentId: string;
  date: string;
  sensitivity: number;
  selfNoise: number;
  operator: string;
  agency: string;
  remark: string;
}

interface SeedRange {
  id: string;
  label: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isDefault: boolean;
  remark: string;
}

interface SeedAdjustment {
  id: string;
  fromRangeId: string | null;
  toRangeId: string;
  date: string;
  reason: string;
  operator: string;
  remark: string;
}

interface SeedInstrument {
  id: string;
  stationId: string;
  type: Instrument['type'];
  model: string;
  serialNo: string;
  installDate: string;
  state: Instrument['state'];
  remark: string;
  /** 量程档（缺省时自动生成一条默认档） */
  ranges?: SeedRange[];
  /** 调整记录（缺省为空） */
  adjustments?: SeedAdjustment[];
  calibrations: SeedCalibration[];
}

interface SeedStation {
  id: string;
  arrayId: string;
  code: string;
  lat: number;
  lng: number;
  elevM: number;
  bedrock: SeisStation['bedrock'];
  siteNote: string;
  instruments: SeedInstrument[];
}

interface SeedArray {
  id: string;
  name: string;
  apertureKm: number;
  deployDate: string;
  state: SeisArray['state'];
  department: string;
  stations: SeedStation[];
}

/**
 * 播种演示数据：2 个台阵 → 5 个台站 → 8 台仪器 → 11 条标定 + 3 条更换，
 * 每台仪器配量程档；其中 LTX01 宽频带含一次「低增益档 → 高增益档」换档与跨档标定，
 * 覆盖「在用 / 待标定 / 已停用」与「合格 / 不合格」以及超期未标定样本。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const daysAgo = (days: number): string => new Date(now - days * 86400000).toISOString().slice(0, 10);

  const arrays: SeedArray[] = [
    {
      id: 'arr_ltx',
      name: '龙门峡流动台阵',
      apertureKm: 24.6,
      deployDate: '2021-04-18',
      state: '运行中',
      department: '省地震局监测中心',
      stations: [
        {
          id: 'stn_ltx_01',
          arrayId: 'arr_ltx',
          code: 'LTX01',
          lat: 30.8421,
          lng: 103.5624,
          elevM: 1180,
          bedrock: '花岗岩',
          siteNote: '基岩出露，噪声本底低',
          instruments: [
            {
              id: 'ins_ltx01_bb',
              stationId: 'stn_ltx_01',
              type: '宽频带',
              model: 'CMG-3ESPC',
              serialNo: 'CMG-3E-20210418-01',
              installDate: '2021-04-18',
              state: '在用',
              remark: '主用宽频带，配 24 位采集器；2025-03 数采由低增益档调整为高增益档',
              ranges: [
                {
                  id: 'rng_ltx01_bb_low',
                  label: '低增益档',
                  effectiveFrom: '2021-04-18',
                  effectiveTo: '2025-03-10',
                  isDefault: false,
                  remark: '数采出厂量程档',
                },
                {
                  id: 'rng_ltx01_bb_high',
                  label: '高增益档',
                  effectiveFrom: '2025-03-10',
                  effectiveTo: null,
                  isDefault: false,
                  remark: '2025-03 数采量程档调整后生效',
                },
              ],
              adjustments: [
                {
                  id: 'adj_ltx01_bb_1',
                  fromRangeId: 'rng_ltx01_bb_low',
                  toRangeId: 'rng_ltx01_bb_high',
                  date: '2025-03-10',
                  reason: '远震观测需要，数采量程档由低增益调整为高增益',
                  operator: '周渝',
                  remark: '换档后读数整体跳变属档位切换，标定比对按同档口径',
                },
              ],
              calibrations: [
                {
                  id: 'cal_ltx01_bb_1',
                  instrumentId: 'ins_ltx01_bb',
                  date: '2023-04-20',
                  sensitivity: 1502.4,
                  selfNoise: 1.82,
                  operator: '陈立群',
                  agency: '省地震局计量站',
                  remark: '响应曲线平滑',
                },
                {
                  id: 'cal_ltx01_bb_2',
                  instrumentId: 'ins_ltx01_bb',
                  date: '2024-04-12',
                  sensitivity: 1468.9,
                  selfNoise: 1.95,
                  operator: '陈立群',
                  agency: '省地震局计量站',
                  remark: '灵敏度略降 2.2%，仍在限内',
                },
                {
                  id: 'cal_ltx01_bb_3',
                  instrumentId: 'ins_ltx01_bb',
                  date: '2025-04-18',
                  sensitivity: 2968.5,
                  selfNoise: 1.88,
                  operator: '陈立群',
                  agency: '省地震局计量站',
                  remark: '换档后首次标定，读数跳变为量程档切换所致，非同档不比',
                },
              ],
            },
            {
              id: 'ins_ltx01_st',
              stationId: 'stn_ltx_01',
              type: '短周期',
              model: 'FSS-3B',
              serialNo: 'FSS3B-20210418-02',
              installDate: '2021-04-18',
              state: '待标定',
              remark: '备份仪器，已逾标定周期',
              calibrations: [
                {
                  id: 'cal_ltx01_st_1',
                  instrumentId: 'ins_ltx01_st',
                  date: '2022-05-06',
                  sensitivity: 412.6,
                  selfNoise: 2.4,
                  operator: '周渝',
                  agency: '省地震局计量站',
                  remark: '首次标定',
                },
              ],
            },
          ],
        },
        {
          id: 'stn_ltx_02',
          arrayId: 'arr_ltx',
          code: 'LTX02',
          lat: 30.9187,
          lng: 103.6412,
          elevM: 1425,
          bedrock: '玄武岩',
          siteNote: '半山台基，交通便利',
          instruments: [
            {
              id: 'ins_ltx02_bb',
              stationId: 'stn_ltx_02',
              type: '宽频带',
              model: 'Trillium-120',
              serialNo: 'T120-20220315-07',
              installDate: '2022-03-15',
              state: '在用',
              remark: '井下安装，深度 42 m',
              calibrations: [
                {
                  id: 'cal_ltx02_bb_1',
                  instrumentId: 'ins_ltx02_bb',
                  date: '2024-03-18',
                  sensitivity: 1204.8,
                  selfNoise: 1.42,
                  operator: '林之遥',
                  agency: '省地震局计量站',
                  remark: '响应一致性良好',
                },
              ],
            },
            {
              id: 'ins_ltx02_st',
              stationId: 'stn_ltx_02',
              type: '短周期',
              model: 'L-4C-3D',
              serialNo: 'L4C-20220315-08',
              installDate: '2022-03-15',
              state: '已停用',
              remark: '2024 年雷击损坏，已提交更换',
              calibrations: [
                {
                  id: 'cal_ltx02_st_1',
                  instrumentId: 'ins_ltx02_st',
                  date: '2023-03-10',
                  sensitivity: 265.2,
                  selfNoise: 4.8,
                  operator: '周渝',
                  agency: '省地震局计量站',
                  remark: '自噪超标，判定不合格',
                },
              ],
            },
          ],
        },
        {
          id: 'stn_ltx_03',
          arrayId: 'arr_ltx',
          code: 'LTX03',
          lat: 30.7802,
          lng: 103.4987,
          elevM: 986,
          bedrock: '石灰岩',
          siteNote: '河谷阶地，需注意汛期供电',
          instruments: [
            {
              id: 'ins_ltx03_bb',
              stationId: 'stn_ltx_03',
              type: '宽频带',
              model: 'STS-2.5',
              serialNo: 'STS25-20230902-11',
              installDate: '2023-09-02',
              state: '在用',
              remark: '新建站首台仪器',
              calibrations: [
                {
                  id: 'cal_ltx03_bb_1',
                  instrumentId: 'ins_ltx03_bb',
                  date: '2024-09-05',
                  sensitivity: 2251.3,
                  selfNoise: 2.05,
                  operator: '林之遥',
                  agency: '省地震局计量站',
                  remark: '脉冲响应合格',
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'arr_hx',
      name: '海西宽频带台阵',
      apertureKm: 46.2,
      deployDate: '2019-09-25',
      state: '运行中',
      department: '国家测震台网中心',
      stations: [
        {
          id: 'stn_hx_01',
          arrayId: 'arr_hx',
          code: 'HX01',
          lat: 25.4321,
          lng: 119.3421,
          elevM: 62,
          bedrock: '花岗岩',
          siteNote: '海岛台，防盐雾处理',
          instruments: [
            {
              id: 'ins_hx01_bb',
              stationId: 'stn_hx_01',
              type: '宽频带',
              model: 'Trillium-Compact',
              serialNo: 'TC-20190925-03',
              installDate: '2019-09-25',
              state: '在用',
              remark: '海岛主用观测设备',
              calibrations: [
                {
                  id: 'cal_hx01_bb_1',
                  instrumentId: 'ins_hx01_bb',
                  date: '2023-09-28',
                  sensitivity: 1498.2,
                  selfNoise: 2.25,
                  operator: '陈立群',
                  agency: '国家测震台网计量中心',
                  remark: '响应合格',
                },
                {
                  id: 'cal_hx01_bb_2',
                  instrumentId: 'ins_hx01_bb',
                  date: '2024-09-30',
                  sensitivity: 1483.6,
                  selfNoise: 2.42,
                  operator: '陈立群',
                  agency: '国家测震台网计量中心',
                  remark: '变化 0.97%，合格',
                },
              ],
            },
            {
              id: 'ins_hx01_sm',
              stationId: 'stn_hx_01',
              type: '强震',
              model: 'ES-T',
              serialNo: 'EST-20190925-04',
              installDate: '2019-09-25',
              state: '在用',
              remark: '结构台阵强震观测',
              calibrations: [
                {
                  id: 'cal_hx01_sm_1',
                  instrumentId: 'ins_hx01_sm',
                  date: '2024-09-30',
                  sensitivity: 1.24,
                  selfNoise: 1.05,
                  operator: '周渝',
                  agency: '国家测震台网计量中心',
                  remark: '强震通道合格',
                },
              ],
            },
          ],
        },
        {
          id: 'stn_hx_02',
          arrayId: 'arr_hx',
          code: 'HX02',
          lat: 25.2894,
          lng: 119.5112,
          elevM: 128,
          bedrock: '砂岩',
          siteNote: '覆盖层较厚，需做场地响应校正',
          instruments: [
            {
              id: 'ins_hx02_bb',
              stationId: 'stn_hx_02',
              type: '宽频带',
              model: 'CMG-3ESPC',
              serialNo: 'CMG-3E-20190926-05',
              installDate: '2019-09-26',
              state: '待标定',
              remark: '夜间自噪抬升，待复标',
              calibrations: [
                {
                  id: 'cal_hx02_bb_1',
                  instrumentId: 'ins_hx02_bb',
                  date: '2023-06-11',
                  sensitivity: 1388.4,
                  selfNoise: 3.9,
                  operator: '林之遥',
                  agency: '国家测震台网计量中心',
                  remark: '自噪接近上限，判定不合格',
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  const replaces: Replace[] = [
    {
      id: 'rpl_ltx02_st',
      instrumentId: 'ins_ltx02_st',
      reason: '雷击导致仪器损坏，标定不合格',
      newSerialNo: 'L4C-20250301-21',
      date: today,
      state: '待更换',
      operator: '周渝',
      remark: '新仪器已到货，待停电窗口安装',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'rpl_hx02_bb',
      instrumentId: 'ins_hx02_bb',
      reason: '自噪持续超标，按台网要求整机更换',
      newSerialNo: 'CMG-3E-20250410-33',
      date: daysAgo(20),
      state: '已更换',
      operator: '林之遥',
      remark: '已完成安装，待复核标定',
      createdAt: now - 20 * 86400000,
      updatedAt: now - 18 * 86400000,
    },
    {
      id: 'rpl_ltx01_st',
      instrumentId: 'ins_ltx01_st',
      reason: '超期未标定，更换为新型号',
      newSerialNo: 'FSS3B-20250506-24',
      date: daysAgo(60),
      state: '已复核',
      operator: '陈立群',
      remark: '复核标定合格，序列号已回写',
      createdAt: now - 60 * 86400000,
      updatedAt: now - 30 * 86400000,
    },
  ];

  await db.transaction(
    'rw',
    [db.arrays, db.stations, db.instruments, db.calibrations, db.replaces, db.ranges, db.rangeAdjustments],
    async () => {
      const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + offset,
        updatedAt: now + offset,
      });

      const arrayRows: SeisArray[] = [];
      const stationRows: SeisStation[] = [];
      const instrumentRows: Instrument[] = [];
      const calibrationRows: Calibration[] = [];
      const rangeRows: GainRange[] = [];
      const adjustmentRows: RangeAdjustment[] = [];

      arrays.forEach((seed, arrayIndex) => {
        const { stations, ...arrayRest } = seed;
        arrayRows.push({ ...arrayRest, stationCount: stations.length, ...stamp(arrayIndex) });
        stations.forEach((stationSeed, stationIndex) => {
          const { instruments, ...stationRest } = stationSeed;
          stationRows.push({ ...stationRest, ...stamp(100 + arrayIndex * 100 + stationIndex) });
          instruments.forEach((instrumentSeed, instrumentIndex) => {
            const { calibrations, ranges, adjustments, ...instrumentRest } = instrumentSeed;
            instrumentRows.push({
              ...instrumentRest,
              ...stamp(200 + arrayIndex * 200 + stationIndex * 50 + instrumentIndex),
            });
            // 计量站侧：缺省时为通道自动生成一条默认档
            const seedRanges: SeedRange[] = ranges ?? [
              {
                id: createId('rng'),
                label: DEFAULT_RANGE_LABEL,
                effectiveFrom: instrumentRest.installDate,
                effectiveTo: null,
                isDefault: true,
                remark: '通道建档默认量程档',
              },
            ];
            seedRanges.forEach((rangeSeed, rangeIndex) => {
              rangeRows.push({
                ...rangeSeed,
                channelCode: instrumentRest.serialNo,
                ...stamp(300 + arrayIndex * 300 + stationIndex * 60 + instrumentIndex * 10 + rangeIndex),
              });
            });
            (adjustments ?? []).forEach((adjustmentSeed, adjustmentIndex) => {
              adjustmentRows.push({
                ...adjustmentSeed,
                channelCode: instrumentRest.serialNo,
                ...stamp(350 + arrayIndex * 350 + stationIndex * 60 + instrumentIndex * 10 + adjustmentIndex),
              });
            });
            calibrations.forEach((calibrationSeed, calibrationIndex) => {
              const verdict = judgeCalibration(
                instrumentRest.type,
                calibrationSeed.sensitivity,
                calibrationSeed.selfNoise
              );
              // 每条标定记下当时生效档位（台网中心侧只存档位 id，不回写计量站档案）
              const active =
                seedRanges
                  .filter(
                    (range) =>
                      range.effectiveFrom <= calibrationSeed.date &&
                      (range.effectiveTo === null || range.effectiveTo > calibrationSeed.date)
                  )
                  .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null;
              calibrationRows.push({
                ...calibrationSeed,
                responseVerdict: verdict,
                rangeId: active?.id ?? null,
                channelCode: instrumentRest.serialNo,
                ...stamp(
                  400 + arrayIndex * 400 + stationIndex * 100 + instrumentIndex * 20 + calibrationIndex
                ),
              });
            });
          });
        });
      });

      await db.arrays.bulkPut(arrayRows);
      await db.stations.bulkPut(stationRows);
      await db.instruments.bulkPut(instrumentRows);
      await db.calibrations.bulkPut(calibrationRows);
      await db.replaces.bulkPut(replaces);
      await db.ranges.bulkPut(rangeRows);
      await db.rangeAdjustments.bulkPut(adjustmentRows);
    }
  );
}

/** 打开数据库并幂等播种：仅当台阵表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open();
  const count = await db.arrays.count();
  if (count === 0) {
    await seedDemoData();
  }
  stampDbVersion();
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.arrays, db.stations, db.instruments, db.calibrations, db.replaces, db.ranges, db.rangeAdjustments],
    async () => {
      await Promise.all([
        db.arrays.clear(),
        db.stations.clear(),
        db.instruments.clear(),
        db.calibrations.clear(),
        db.replaces.clear(),
        db.ranges.clear(),
        db.rangeAdjustments.clear(),
      ]);
    }
  );
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDemoData();
}

/** 统计各表行数，供页脚概览与几何页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [arrays, stations, instruments, calibrations, replaces, ranges, rangeAdjustments] =
    await Promise.all([
      db.arrays.count(),
      db.stations.count(),
      db.instruments.count(),
      db.calibrations.count(),
      db.replaces.count(),
      db.ranges.count(),
      db.rangeAdjustments.count(),
    ]);
  return { arrays, stations, instruments, calibrations, replaces, ranges, rangeAdjustments };
}

/** 写入结构版本号到 localStorage，便于几何页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION));
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso);
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function readLastArrayId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastArrayId);
  } catch {
    return null;
  }
}

export function writeLastArrayId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastArrayId);
    else localStorage.setItem(LS_KEYS.lastArrayId, id);
  } catch {
    // 忽略
  }
}
