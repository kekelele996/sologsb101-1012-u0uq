/**
 * 量程档与调整记录（计量站侧档案）。
 * 职责切分：计量站管各通道量程档与调整记录；台网中心管标定记录、灵敏度变化与合格率。
 * 两侧按通道号（仪器序列号）对账，对不上的记录先挂起，互不回退。
 */

/** 量程档：数采某一通道在一段时间内生效的增益档位 */
export interface GainRange {
  id: string;
  /** 通道号（对账键，取仪器序列号） */
  channelCode: string;
  /** 档位名，如 低增益档 / 标准档 / 高增益档 */
  label: string;
  /** 生效日期（含当日） */
  effectiveFrom: string;
  /** 失效日期（不含当日），null 表示当前生效 */
  effectiveTo: string | null;
  /** 是否为升级迁移或录标定时自动补建的默认档 */
  isDefault: boolean;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 调整记录：每次建档 / 换档在计量站侧留痕 */
export interface RangeAdjustment {
  id: string;
  /** 通道号 */
  channelCode: string;
  /** 调整前档位（首次建档为 null） */
  fromRangeId: string | null;
  /** 调整后生效档位 */
  toRangeId: string;
  /** 调整日期 */
  date: string;
  /** 调整原因 */
  reason: string;
  /** 操作人 */
  operator: string;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 常用档位名（换档表单联想用） */
export const RANGE_LABELS = ['低增益档', '标准档', '高增益档'] as const;

/** 默认档档位名：升级迁移与录标定自动补建时使用 */
export const DEFAULT_RANGE_LABEL = '标准档';

/** 对账挂起类别 */
export type ReconcileIssueKind = '档位无仪器' | '标定无档位' | '迁移未补档';

/** 对账挂起项：两侧按通道号对账时对不上的记录，先挂着不处理 */
export interface ReconcileIssue {
  kind: ReconcileIssueKind;
  /** 对账通道号（迁移补不出时填仪器 id 或「未登记」） */
  channelCode: string;
  /** 挂起原因说明 */
  detail: string;
}

/** 找到某通道在指定日期生效的量程档（同日出多条时取最新生效的一条） */
export function activeRangeOf(ranges: GainRange[], channelCode: string, date: string): GainRange | null {
  const hit = ranges
    .filter((row) => row.channelCode === channelCode)
    .filter((row) => row.effectiveFrom <= date && (row.effectiveTo === null || row.effectiveTo > date))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return hit[0] ?? null;
}

/** 通道当前生效档（effectiveTo 为空的最新一条） */
export function currentRangeOf(ranges: GainRange[], channelCode: string): GainRange | null {
  const open = ranges
    .filter((row) => row.channelCode === channelCode && row.effectiveTo === null)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return open[0] ?? null;
}
