/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbseisarray，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（台阵 → 台站 → 仪器 → 通道 / 标定 / 更换）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 *
 * 两侧职责（按通道号 channelCode 对账）：
 * - 计量站：channels（通道量程档）+ adjustments（量程调整记录，含同步状态）
 * - 台网中心：calibrations（标定记录、当时生效档位、灵敏度变化与合格率）
 */
import Dexie, { liveQuery, type Table } from 'dexie';
import type { SeisArray } from '@/types/array';
import type { SeisStation } from '@/types/station';
import type { Instrument } from '@/types/instrument';
import { judgeCalibration } from '@/types/calibration';
import type { Calibration } from '@/types/calibration';
import type { Replace } from '@/types/replace';
import {
  DEFAULT_RANGE_GEAR,
  buildChannelCode,
  type MeasureChannel,
  type RangeAdjustment,
} from '@/types/measure';

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3;

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbseisarray';

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbseisarray:db-version',
  lastBackupAt: 'gbseisarray:last-backup-at',
  lastArrayId: 'gbseisarray:last-array-id',
} as const;

/** 备份文件结构，供 utils/export.ts 与几何页使用 */
export interface BackupPayload {
  app: 'gbseisarray';
  dbVersion: number;
  exportedAt: string;
  arrays: SeisArray[];
  stations: SeisStation[];
  instruments: Instrument[];
  channels: MeasureChannel[];
  calibrations: Calibration[];
  adjustments: RangeAdjustment[];
  replaces: Replace[];
}

export class SeisArrayDatabase extends Dexie {
  arrays!: Table<SeisArray, string>;
  stations!: Table<SeisStation, string>;
  instruments!: Table<Instrument, string>;
  channels!: Table<MeasureChannel, string>;
  calibrations!: Table<Calibration, string>;
  adjustments!: Table<RangeAdjustment, string>;
  replaces!: Table<Replace, string>;

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
    this.version(2).stores({
      arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
      stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
      instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
      calibrations: 'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, updatedAt',
      replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
    });

    // v3：拆分两侧 —— 计量站 channels/adjustments；台网中心 calibrations 增加通道对账字段与生效档位
    this.version(DB_VERSION)
      .stores({
        arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
        stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
        instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
        channels: 'id, channelCode, instrumentId, stationId, currentGear, updatedAt',
        calibrations:
          'id, instrumentId, channelId, channelCode, date, gear, sensitivity, selfNoise, responseVerdict, updatedAt',
        adjustments: 'id, channelId, channelCode, effectiveDate, syncState, updatedAt',
        replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
      })
      .upgrade(async (tx) => {
        // v2 迁移：历史数据补齐时间戳与必填字段，避免列表排序与筛选拿到 undefined
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

        // v3 迁移：旧标定没有量程档。按「仪器→台站→通道号」补一条默认档通道；
        // 能对应到通道的标定回填 channelId/channelCode/gear=默认档，补不出的三个字段留空（''）单列挂账。
        const instruments = await tx.table<Instrument, string>('instruments').toArray();
        const stations = await tx.table<SeisStation, string>('stations').toArray();
        const stationById = new Map(stations.map((station) => [station.id, station]));
        const now = Date.now();

        const channelByCode = new Map<string, MeasureChannel>();
        const channelRows: MeasureChannel[] = [];
        const ensureChannel = (instrument: Instrument): MeasureChannel | null => {
          const station = stationById.get(instrument.stationId);
          if (!station) return null; // 补不出通道 → 标定留空单列
          const code = buildChannelCode(station.code, instrument.type);
          const existing = channelByCode.get(code);
          if (existing) return existing;
          const channel: MeasureChannel = {
            id: `ch_up_${channelRows.length + 1}`,
            channelCode: code,
            instrumentId: instrument.id,
            stationId: station.id,
            currentGear: DEFAULT_RANGE_GEAR,
            component: '升级补默认档',
            remark: '旧数据升级，按通道补默认量程档',
            createdAt: now,
            updatedAt: now,
          };
          channelByCode.set(code, channel);
          channelRows.push(channel);
          return channel;
        };

        // 每台仪器先确保有一条默认档通道
        instruments.forEach((instrument) => ensureChannel(instrument));

        await tx
          .table<Calibration, string>('calibrations')
          .toCollection()
          .modify((row: Calibration) => {
            if (typeof row.channelCode !== 'string') row.channelCode = '';
            if (typeof row.channelId !== 'string') row.channelId = '';
            if (typeof row.gear !== 'string') row.gear = '';
            if (row.channelCode === '' || row.gear === '') {
              const instrument = instruments.find((item) => item.id === row.instrumentId);
              const station = instrument ? stationById.get(instrument.stationId) : undefined;
              if (instrument && station) {
                const code = buildChannelCode(station.code, instrument.type);
                const channel = channelByCode.get(code) ?? ensureChannel(instrument);
                if (channel) {
                  row.channelCode = code;
                  row.channelId = channel.id;
                  row.gear = DEFAULT_RANGE_GEAR;
                }
              }
              // 仍补不出：channelId/channelCode/gear 维持 ''，由对账页单列
            }
          });

        if (channelRows.length > 0) {
          await tx.table<MeasureChannel, string>('channels').bulkPut(channelRows);
        }
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

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedCalibration {
  id: string;
  instrumentId: string;
  date: string;
  /** 本次标定时生效的量程档 */
  gear: Calibration['gear'];
  sensitivity: number;
  selfNoise: number;
  operator: string;
  agency: string;
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
  /** 通道分量说明 */
  component: string;
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
 * 播种演示数据：2 个台阵 → 5 个台站 → 8 台仪器 → 8 条通道、
 * 16 条标定（含 1 次中途换量程档）+ 3 条量程调整（1 条同步失败）+ 3 条更换。
 * LTX01-BB 通道在 2025-03 由标准档换入高增益档：换档前后灵敏度整体抬升约 4 倍，
 * 同档口径下跨档两条不直接相减，避免把换档阶跃看成仪器损坏。
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
              remark: '主用宽频带，配 24 位采集器',
              component: '宽频带垂直向',
              calibrations: [
                {
                  id: 'cal_ltx01_bb_1',
                  instrumentId: 'ins_ltx01_bb',
                  date: '2023-04-20',
                  gear: '标准档',
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
                  gear: '标准档',
                  sensitivity: 1468.9,
                  selfNoise: 1.95,
                  operator: '陈立群',
                  agency: '省地震局计量站',
                  remark: '灵敏度略降 2.2%，仍在限内',
                },
                {
                  id: 'cal_ltx01_bb_3',
                  instrumentId: 'ins_ltx01_bb',
                  date: '2025-03-24',
                  gear: '高增益档',
                  sensitivity: 5998.6,
                  selfNoise: 1.91,
                  operator: '陈立群',
                  agency: '省地震局计量站',
                  remark: '3/20 换高增益档后首次标定，读数整体抬升，跨档不作差',
                },
                {
                  id: 'cal_ltx01_bb_4',
                  instrumentId: 'ins_ltx01_bb',
                  date: '2025-09-26',
                  gear: '高增益档',
                  sensitivity: 5968.1,
                  selfNoise: 2.02,
                  operator: '陈立群',
                  agency: '省地震局计量站',
                  remark: '同档相对上次变化 -0.5%，稳定',
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
              component: '短周期三分量',
              calibrations: [
                {
                  id: 'cal_ltx01_st_1',
                  instrumentId: 'ins_ltx01_st',
                  date: '2022-05-06',
                  gear: '标准档',
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
              component: '宽频带三分量',
              calibrations: [
                {
                  id: 'cal_ltx02_bb_1',
                  instrumentId: 'ins_ltx02_bb',
                  date: '2024-03-18',
                  gear: '标准档',
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
              component: '短周期垂直向',
              calibrations: [
                {
                  id: 'cal_ltx02_st_1',
                  instrumentId: 'ins_ltx02_st',
                  date: '2023-03-10',
                  gear: '标准档',
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
              component: '宽频带垂直向',
              calibrations: [
                {
                  id: 'cal_ltx03_bb_1',
                  instrumentId: 'ins_ltx03_bb',
                  date: '2024-09-05',
                  gear: '标准档',
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
              component: '宽频带三分量',
              calibrations: [
                {
                  id: 'cal_hx01_bb_1',
                  instrumentId: 'ins_hx01_bb',
                  date: '2023-09-28',
                  gear: '标准档',
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
                  gear: '标准档',
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
              component: '强震三分量',
              calibrations: [
                {
                  id: 'cal_hx01_sm_1',
                  instrumentId: 'ins_hx01_sm',
                  date: '2024-09-30',
                  gear: '标准档',
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
              component: '宽频带垂直向',
              calibrations: [
                {
                  id: 'cal_hx02_bb_1',
                  instrumentId: 'ins_hx02_bb',
                  date: '2023-06-11',
                  gear: '标准档',
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
    [
      db.arrays,
      db.stations,
      db.instruments,
      db.channels,
      db.calibrations,
      db.adjustments,
      db.replaces,
    ],
    async () => {
      const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + offset,
        updatedAt: now + offset,
      });

      const arrayRows: SeisArray[] = [];
      const stationRows: SeisStation[] = [];
      const instrumentRows: Instrument[] = [];
      const channelRows: MeasureChannel[] = [];
      const calibrationRows: Calibration[] = [];
      /** instrumentId → 通道（用于把通道号回填到标定） */
      const channelByInstrument = new Map<string, MeasureChannel>();

      arrays.forEach((seed, arrayIndex) => {
        const { stations, ...arrayRest } = seed;
        arrayRows.push({ ...arrayRest, stationCount: stations.length, ...stamp(arrayIndex) });
        stations.forEach((stationSeed, stationIndex) => {
          const { instruments, ...stationRest } = stationSeed;
          stationRows.push({ ...stationRest, ...stamp(100 + arrayIndex * 100 + stationIndex) });
          instruments.forEach((instrumentSeed, instrumentIndex) => {
            const { calibrations, component, ...instrumentRest } = instrumentSeed;
            instrumentRows.push({
              ...instrumentRest,
              ...stamp(200 + arrayIndex * 200 + stationIndex * 50 + instrumentIndex),
            });

            // 每台仪器一条计量站通道，通道号 = 台站码-类型后缀
            const code = buildChannelCode(stationSeed.code, instrumentSeed.type);
            const lastGear = calibrations.length > 0 ? calibrations[calibrations.length - 1].gear : '标准档';
            const channel: MeasureChannel = {
              id: `ch_${instrumentSeed.id.slice(4)}`,
              channelCode: code,
              instrumentId: instrumentSeed.id,
              stationId: stationSeed.id,
              currentGear: lastGear || DEFAULT_RANGE_GEAR,
              component,
              remark: '',
              ...stamp(250 + arrayIndex * 200 + stationIndex * 50 + instrumentIndex),
            };
            channelRows.push(channel);
            channelByInstrument.set(instrumentSeed.id, channel);

            calibrations.forEach((calibrationSeed, calibrationIndex) => {
              const verdict = judgeCalibration(
                instrumentRest.type,
                calibrationSeed.sensitivity,
                calibrationSeed.selfNoise,
                calibrationSeed.gear
              );
              calibrationRows.push({
                id: calibrationSeed.id,
                instrumentId: calibrationSeed.instrumentId,
                channelId: channel.id,
                channelCode: code,
                gear: calibrationSeed.gear,
                date: calibrationSeed.date,
                sensitivity: calibrationSeed.sensitivity,
                selfNoise: calibrationSeed.selfNoise,
                responseVerdict: verdict,
                operator: calibrationSeed.operator,
                agency: calibrationSeed.agency,
                remark: calibrationSeed.remark,
                ...stamp(
                  400 + arrayIndex * 400 + stationIndex * 100 + instrumentIndex * 20 + calibrationIndex
                ),
              });
            });
          });
        });
      });

      // 一条「计量站已建、台站仪器未装」的挂账通道（对不上，先挂着）
      const orphanChannel: MeasureChannel = {
        id: 'ch_ltx99_bb',
        channelCode: 'LTX99-BB',
        instrumentId: '',
        stationId: '',
        currentGear: '标准档',
        component: '宽频带垂直向',
        remark: '计量站先行建档，台网中心暂无对应仪器/标定，对账挂起',
        createdAt: now,
        updatedAt: now,
      };
      channelRows.push(orphanChannel);

      // 量程调整记录（计量站侧）
      const ltx01Channel = channelByInstrument.get('ins_ltx01_bb');
      const adjustmentRows: RangeAdjustment[] = [];
      if (ltx01Channel) {
        adjustmentRows.push(
          {
            id: 'adj_ltx01_bb_init',
            channelId: ltx01Channel.id,
            channelCode: ltx01Channel.channelCode,
            date: '2021-04-18',
            effectiveDate: '2021-04-18',
            fromGear: null,
            toGear: '标准档',
            reason: '建台初始量程档',
            operator: '陈立群',
            syncState: '已同步',
            syncedAt: now,
            syncError: '',
            remark: '',
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'adj_ltx01_bb_high',
            channelId: ltx01Channel.id,
            channelCode: ltx01Channel.channelCode,
            date: '2025-03-20',
            effectiveDate: '2025-03-20',
            fromGear: '标准档',
            toGear: '高增益档',
            reason: '弱震监视需要，提高数采增益',
            operator: '陈立群',
            syncState: '已同步',
            syncedAt: now,
            syncError: '',
            remark: '换档后灵敏度读数整体抬升约 4 倍，属增益阶跃',
            createdAt: now,
            updatedAt: now,
          }
        );
      }
      // 一条同步失败的调整（计量站写不进台网中心）：只在计量站侧，可补跑，不回退台网已认标定
      adjustmentRows.push({
        id: 'adj_ltx99_bb_fail',
        channelId: orphanChannel.id,
        channelCode: orphanChannel.channelCode,
        date: daysAgo(8),
        effectiveDate: daysAgo(8),
        fromGear: '标准档',
        toGear: '高增益档',
        reason: '近震频发，计划提高增益',
        operator: '周渝',
        syncState: '同步失败',
        syncedAt: now - 8 * 86400000,
        syncError: '台网中心接口超时（模拟），调整已在计量站生效，待补跑同步',
        remark: '',
        createdAt: now - 8 * 86400000,
        updatedAt: now - 8 * 86400000,
      });

      await db.arrays.bulkPut(arrayRows);
      await db.stations.bulkPut(stationRows);
      await db.instruments.bulkPut(instrumentRows);
      await db.channels.bulkPut(channelRows);
      await db.calibrations.bulkPut(calibrationRows);
      await db.adjustments.bulkPut(adjustmentRows);
      await db.replaces.bulkPut(replaces);
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
    [
      db.arrays,
      db.stations,
      db.instruments,
      db.channels,
      db.calibrations,
      db.adjustments,
      db.replaces,
    ],
    async () => {
      await Promise.all([
        db.arrays.clear(),
        db.stations.clear(),
        db.instruments.clear(),
        db.channels.clear(),
        db.calibrations.clear(),
        db.adjustments.clear(),
        db.replaces.clear(),
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
  const [arrays, stations, instruments, channels, calibrations, adjustments, replaces] =
    await Promise.all([
      db.arrays.count(),
      db.stations.count(),
      db.instruments.count(),
      db.channels.count(),
      db.calibrations.count(),
      db.adjustments.count(),
      db.replaces.count(),
    ]);
  return { arrays, stations, instruments, channels, calibrations, adjustments, replaces };
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
