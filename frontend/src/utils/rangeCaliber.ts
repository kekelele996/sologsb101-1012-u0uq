/**
 * 同档口径（台网中心侧）：灵敏度变化、趋势分段、合格率共用这一个比较器。
 *
 * 规则（唯一口径，趋势图与合格率必须一致）：
 * - 每条标定记录当时生效的量程档 gear（由计量站通道调整记录解析得到）；
 * - 同一通道内，每条标定只与「同档、时间上最近的前一条」比（同档链式比较）；
 * - 换档后在新档的第一条没有同档前驱 → 记为「新档首次」，不参与变化量、也不参与合格率评定；
 * - gear 为空（旧数据补不出默认档）→ 不可比，同样挂起，不猜档位硬比。
 *
 * 不做「跨档归一再相减」：换档是数采增益阶跃而非仪器漂移，归一依赖各档增益系数，
 * 系数缺失或不准会再次污染趋势。故跨档处趋势断段、变化量与合格率都不比。
 */
import type { Calibration } from '@/types/calibration';
import type { RangeGear } from '@/types/measure';
import { DEFAULT_RANGE_GEAR } from '@/types/measure';
import { sensitivityDelta, type SensitivityDelta } from '@/types/calibration';

/** 带上档位与可比信息的标定点 */
export interface CaliberPoint {
  calibration: Calibration;
  /** 当时生效档位；'' 表示旧数据补不出默认档（待单列挂账） */
  gear: RangeGear | '';
  /** 同档前驱标定（无则 null） */
  previous: Calibration | null;
  /** 灵敏度变化（相对同档前驱；不可比时 comparable=false） */
  delta: SensitivityDelta;
  /**
   * 是否参与台网中心合格率统计：
   * 新档首次（换档后第一条）与档位缺失的记录不参与，避免把换档阶跃误判成仪器坏了。
   */
  eligible: boolean;
  /** 不可比/不计的原因说明 */
  reason: string;
}

/** 趋势段：同一档位内连续的点；跨档处断开 */
export interface CaliberSegment {
  gear: RangeGear | '';
  points: CaliberPoint[];
}

/** 标定之间无法比较（首条 / 换档首条 / 缺档）时返回的变化量 */
const INCOMPARABLE: SensitivityDelta = { absolute: 0, percent: 0, comparable: false };

/**
 * 取标定当时生效档位。
 * @param gearOf 由调用方（对账层）给出的「标定 id → 档位」映射；查不到返回 ''
 */
export function gearOfCalibration(
  calibration: Calibration,
  gearMap: ReadonlyMap<string, RangeGear | ''>
): RangeGear | '' {
  return gearMap.get(calibration.id) ?? '';
}

/**
 * 把同一通道（或同一仪器，二者在对账后等价）的标定按同档口径构建为有序点序列。
 * 输入无需预排序，输出按日期升序（同日按 createdAt 升序）。
 */
export function buildCaliberPoints(
  calibrations: Calibration[],
  gearMap: ReadonlyMap<string, RangeGear | ''>
): CaliberPoint[] {
  const sorted = [...calibrations].sort(
    (a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt
  );
  // 各档最近一条前驱
  const lastByGear = new Map<RangeGear | '', Calibration>();
  return sorted.map((calibration) => {
    const gear = gearOfCalibration(calibration, gearMap);
    if (gear === '') {
      return {
        calibration,
        gear,
        previous: null,
        delta: INCOMPARABLE,
        eligible: false,
        reason: '量程档缺失（旧数据补不出默认档），待计量站补档后单列核定',
      };
    }
    const previous = lastByGear.get(gear) ?? null;
    lastByGear.set(gear, calibration);
    if (!previous) {
      return {
        calibration,
        gear,
        previous: null,
        delta: INCOMPARABLE,
        eligible: false,
        reason: '该档位首次标定（或刚换入此档），无同档前值可比',
      };
    }
    return {
      calibration,
      gear,
      previous,
      delta: sensitivityDelta(calibration.sensitivity, previous.sensitivity),
      eligible: true,
      reason: '',
    };
  });
}

/**
 * 由点序列切成趋势段：档位发生变化即另起一段，跨档两段之间不连线。
 */
export function buildCaliberSegments(points: CaliberPoint[]): CaliberSegment[] {
  const segments: CaliberSegment[] = [];
  points.forEach((point) => {
    const last = segments[segments.length - 1];
    if (last && last.gear === point.gear) {
      last.points.push(point);
    } else {
      segments.push({ gear: point.gear, points: [point] });
    }
  });
  return segments;
}

/** 合格率统计结果（只用 eligible 的记录，与趋势同一条口径） */
export interface QualifyStat {
  /** 参与评定的记录数（同档有前值的） */
  eligibleCount: number;
  /** 其中合格数 */
  qualifiedCount: number;
  /** 挂起不计的记录数（新档首次 / 缺档） */
  suspendedCount: number;
  /** 合格率（0-100），无参与记录时为 null（不显示 0%，避免误导） */
  qualifyRate: number | null;
}

/**
 * 合格率：只统计 eligible 且结论明确（合格/不合格）的记录；
 * 待判定不计入分母（结论未定），换档首条与缺档记录挂起不计。
 */
export function qualifyStatOf(points: Pick<CaliberPoint, 'eligible' | 'calibration'>[]): QualifyStat {
  const judged = points.filter(
    (point) => point.eligible && point.calibration.responseVerdict !== '待判定'
  );
  const qualified = judged.filter(
    (point) => point.calibration.responseVerdict === '合格'
  ).length;
  const eligibleCount = judged.length;
  const suspendedCount = points.filter((point) => !point.eligible).length;
  return {
    eligibleCount,
    qualifiedCount: qualified,
    suspendedCount,
    qualifyRate:
      eligibleCount === 0 ? null : Number(((qualified / eligibleCount) * 100).toFixed(1)),
  };
}

/**
 * 旧数据升级兜底：标定没有档位时是否可按通道补默认档。
 * 只要该标定能对应到通道（channelCode 可解析）就补 DEFAULT_RANGE_GEAR；否则返回 ''（单列）。
 */
export function resolveLegacyGear(hasChannel: boolean): RangeGear | '' {
  return hasChannel ? DEFAULT_RANGE_GEAR : '';
}
