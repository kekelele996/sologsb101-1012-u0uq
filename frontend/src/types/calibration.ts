import type { RangeGear } from '@/types/measure';
import { GEAR_GAIN_FACTOR } from '@/types/measure';

export type ResponseVerdict = '合格' | '不合格' | '待判定';

export const RESPONSE_VERDICTS: ResponseVerdict[] = ['合格', '不合格', '待判定'];

/** 标定：同一仪器可叠加多次标定记录 */
export interface Calibration {
  id: string;
  /** 被标定仪器 */
  instrumentId: string;
  /**
   * 对账通道 id（台网中心 ↔ 计量站按通道号对账后回填）。
   * 对不上通道时为空，记录挂起，不强行归并。
   */
  channelId: string;
  /** 通道号（冗余，对账主键，便于两侧直接比对） */
  channelCode: string;
  /**
   * 本次标定时生效的量程档（计量站通道调整记录解析得到）。
   * 旧数据升级时按通道补默认档；补不出为空串 ''，在对账页单列。
   */
  gear: RangeGear | '';
  /** 标定日期 */
  date: string;
  /** 灵敏度（V·s/m） */
  sensitivity: number;
  /** 自噪（m/s² 或 counts，按台网口径记录） */
  selfNoise: number;
  /** 脉冲响应结论 */
  responseVerdict: ResponseVerdict;
  /** 标定人 */
  operator: string;
  /** 标定机构 */
  agency: string;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 自动初判：灵敏度落在合理区间且自噪不高于阈值判合格。
 * 阈值按台网常规口径给出，最终以标定报告为准。
 *
 * 灵敏度合格区间按「标准档」给出；其它档位先除以该档相对标准档的增益因子
 * 换算回标准档再判，避免高/低增益档被固定区间误判（注意：这只用于合格区间判定，
 * 同档灵敏度变化与合格率不做跨档归一，见 utils/rangeCaliber.ts）。
 */
export const SENSITIVITY_RANGE: Record<string, { min: number; max: number }> = {
  宽频带: { min: 800, max: 3000 },
  短周期: { min: 100, max: 800 },
  强震: { min: 0.1, max: 5 }
};

export const SELF_NOISE_LIMIT = 3.5;

export function judgeCalibration(
  type: string,
  sensitivity: number,
  selfNoise: number,
  gear: RangeGear | '' = '标准档'
): ResponseVerdict {
  if (!Number.isFinite(sensitivity) || !Number.isFinite(selfNoise)) return '待判定';
  const factor = gear && gear in GEAR_GAIN_FACTOR ? GEAR_GAIN_FACTOR[gear] : 1;
  const normalizedSensitivity = factor > 0 ? sensitivity / factor : sensitivity;
  const range = SENSITIVITY_RANGE[type] ?? { min: 0, max: Number.MAX_SAFE_INTEGER };
  if (normalizedSensitivity < range.min || normalizedSensitivity > range.max) return '不合格';
  if (selfNoise > SELF_NOISE_LIMIT) return '不合格';
  return '合格';
}

/** 灵敏度变化量（相对上一次标定），返回绝对值与百分比 */
export interface SensitivityDelta {
  /** 本次 - 上次 */
  absolute: number;
  /** 变化百分比（%） */
  percent: number;
  /** 是否有上一次标定可比 */
  comparable: boolean;
}

export function sensitivityDelta(current: number, previous: number | null): SensitivityDelta {
  if (previous === null || !Number.isFinite(previous) || previous === 0) {
    return { absolute: 0, percent: 0, comparable: false };
  }
  const absolute = Number((current - previous).toFixed(2));
  return { absolute, percent: Number(((absolute / previous) * 100).toFixed(2)), comparable: true };
}

/** 标定页筛选条件（存于 calibrationSlice） */
export interface CalibrationFilterState {
  keyword: string;
  verdicts: ResponseVerdict[];
  instrumentTypes: string[];
  /** 是否只看超期未标定仪器 */
  onlyOverdue: boolean;
}

export function createEmptyCalibrationFilter(): CalibrationFilterState {
  return {
    keyword: '',
    verdicts: [],
    instrumentTypes: [],
    onlyOverdue: false
  };
}

/** 待标定天数文案：正数为剩余天数、负数为超期天数、0 为今日到期 */
export function calibrateDueText(dueInDays: number): string {
  if (!Number.isFinite(dueInDays)) return '标定日期缺失';
  if (dueInDays === 0) return '今日到期';
  if (dueInDays > 0) return `距下次标定 ${dueInDays} 天`;
  return `已超期 ${Math.abs(dueInDays)} 天`;
}
