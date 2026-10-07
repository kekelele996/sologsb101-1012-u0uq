/**
 * 计量站侧：台站通道量程档与调整记录。
 *
 * 职责边界：
 * - 计量站只管「通道（通道号）当前生效档位」与「历次量程调整记录」；
 * - 灵敏度数值、灵敏度变化、合格率归台网中心（见 calibration.ts / rangeCaliber.ts）。
 * 两侧按通道号（channelCode）对账，对不上的先挂账，不在本侧强行兜底。
 */

/** 数采量程档（增益档）：标准 / 高增益 / 低增益 */
export type RangeGear = '标准档' | '高增益档' | '低增益档';

export const RANGE_GEARS: RangeGear[] = ['标准档', '高增益档', '低增益档'];

/**
 * 旧数据没有量程档，升级时按通道补的默认档。
 * 标定记录的档位为空串时表示「补不出默认档」，需在对账页单列处理。
 */
export const DEFAULT_RANGE_GEAR: RangeGear = '标准档';

/**
 * 各档相对标准档的增益因子（标准档 = 1）。
 * 仅用于跨档展示时的参考换算与录入初判，**同档比较口径不依赖它**：
 * 台网中心的灵敏度变化与合格率一律只在同档内链式比较，不做跨档归一相减。
 */
export const GEAR_GAIN_FACTOR: Record<RangeGear, number> = {
  标准档: 1,
  高增益档: 4,
  低增益档: 0.25,
};

/** 计量站调整记录的同步状态（计量站→台网中心） */
export type AdjustSyncState = '已同步' | '待同步' | '同步失败';

export const ADJUST_SYNC_STATES: AdjustSyncState[] = ['已同步', '待同步', '同步失败'];

/**
 * 通道：计量站维护的通道台账。通道号全局唯一，是两侧对账的主键。
 * 一个仪器至少对应一个观测通道；channelCode 一般为「台站码-分量/类型」。
 */
export interface MeasureChannel {
  id: string;
  /** 通道号（对账主键，全局唯一），如 LTX01-BB */
  channelCode: string;
  /** 关联仪器（可空：先建通道、后装仪器时允许为空） */
  instrumentId: string;
  /** 所属台站（冗余，便于按台站筛选；instrumentId 为空时仍可填） */
  stationId: string;
  /** 当前生效量程档 */
  currentGear: RangeGear;
  /** 通道分量/类型说明，如 宽频带垂直向 */
  component: string;
  /** 计量站备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 量程调整记录：每次在计量站切换量程档记一条。
 * 生效日期 effectiveDate 起，到下一条调整之前，该通道处于 fromGear → gear 档。
 */
export interface RangeAdjustment {
  id: string;
  /** 所属通道 id */
  channelId: string;
  /** 通道号（冗余，便于两侧按通道号直接对账） */
  channelCode: string;
  /** 调整日期 */
  date: string;
  /** 生效日期（该日起标定按新档计） */
  effectiveDate: string;
  /** 调整前档位（首次建档为 null） */
  fromGear: RangeGear | null;
  /** 调整后档位 */
  toGear: RangeGear;
  /** 调整原因 */
  reason: string;
  /** 计量站操作人 */
  operator: string;
  /**
   * 计量站→台网中心同步状态：
   * 计量站写不进去时只补跑本侧（重试），台网中心已认下的标定不回退。
   */
  syncState: AdjustSyncState;
  /** 最近一次同步尝试时间（无则 null） */
  syncedAt: number | null;
  /** 同步失败原因（syncState 为同步失败时填写） */
  syncError: string;
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 仪器类型 → 通道号后缀（用于建档/升级时按通道补默认档） */
export const INSTRUMENT_CHANNEL_SUFFIX: Record<string, string> = {
  宽频带: 'BB',
  短周期: 'SP',
  强震: 'SM',
};

/** 组装通道号：台站码 + 类型后缀 */
export function buildChannelCode(stationCode: string, instrumentType: string): string {
  const suffix = INSTRUMENT_CHANNEL_SUFFIX[instrumentType] ?? 'CH';
  return `${stationCode}-${suffix}`;
}

export function createEmptyChannelDraft(): Omit<MeasureChannel, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    channelCode: '',
    instrumentId: '',
    stationId: '',
    currentGear: DEFAULT_RANGE_GEAR,
    component: '',
    remark: '',
  };
}
