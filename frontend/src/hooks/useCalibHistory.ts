/**
 * useCalibHistory：按仪器聚合历次标定、算「同档」灵敏度变化量与待标定天数。
 * 被标定记录台（/calibrations）与更换提醒页（/replacements）消费。
 *
 * 灵敏度变化与趋势一律走 utils/rangeCaliber.ts 的同档链式口径：
 * 换档后新档首条不与旧档相减，趋势在跨档处断段。
 */
import { useCallback, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import { calibrateDueText, type SensitivityDelta } from '@/types/calibration';
import { CALIBRATION_CYCLE_DAYS, daysUntilDue } from '@/types/instrument';
import type { Calibration, ResponseVerdict } from '@/types/calibration';
import type { Instrument } from '@/types/instrument';
import type { RangeGear } from '@/types/measure';
import type { CaliberPoint, CaliberSegment } from '@/utils/rangeCaliber';
import { useReconcile } from '@/hooks/useReconcile';

/** 单台仪器的标定历史聚合 */
export interface InstrumentCalibHistory {
  instrument: Instrument;
  stationCode: string;
  arrayId: string;
  arrayName: string;
  /** 历次标定（按日期降序） */
  calibrations: Calibration[];
  /** 同档口径点（按日期升序） */
  points: CaliberPoint[];
  /** 趋势分段（跨档断段） */
  segments: CaliberSegment[];
  /** 最近一次标定 */
  latest: Calibration | null;
  /** 最近一次灵敏度变化（仅当最近一条在其档内有同档前驱时可比） */
  delta: SensitivityDelta;
  /** 标定次数 */
  count: number;
  /** 换档首条 / 缺档而挂起不计的条数 */
  suspendedCount: number;
  /** 距下次标定天数（负数为已超期） */
  dueInDays: number;
  /** 是否超期未标定 */
  overdue: boolean;
  /** 是否处于待标定状态 */
  pending: boolean;
  /** 历次结论中最差的一次 */
  worstVerdict: ResponseVerdict;
  /** 灵敏度序列（由旧到新，带档位），供趋势展示 */
  trend: Array<{ date: string; sensitivity: number; selfNoise: number; gear: RangeGear | '' }>;
}

export interface UseCalibHistoryResult {
  histories: InstrumentCalibHistory[];
  historyOf: (instrumentId: string) => InstrumentCalibHistory | null;
  overdueHistories: InstrumentCalibHistory[];
  /** 灵敏度趋势：返回指定仪器的序列 */
  trendOf: (
    instrumentId: string
  ) => Array<{ date: string; sensitivity: number; selfNoise: number; gear: RangeGear | '' }>;
}

const VERDICT_ORDER: Record<ResponseVerdict, number> = { 合格: 0, 待判定: 1, 不合格: 2 };

const NO_DELTA: SensitivityDelta = { absolute: 0, percent: 0, comparable: false };

/**
 * 组合式 Hook：基于 Redux 中的台阵 / 台站 / 仪器 / 标定数据派生标定历史与超期提醒。
 */
export function useCalibHistory(): UseCalibHistoryResult {
  const arrays = useSelector(selectArrays);
  const stations = useSelector(selectStations);
  const instruments = useSelector(selectInstruments);
  const reconcile = useReconcile();

  const histories = useMemo<InstrumentCalibHistory[]>(() => {
    return instruments
      .map((instrument) => {
        const station = stations.find((item) => item.id === instrument.stationId);
        const array = station ? arrays.find((item) => item.id === station.arrayId) : undefined;
        const points = reconcile.pointsOfInstrument(instrument.id);
        const segments = reconcile.segmentsOfInstrument(instrument.id);
        const rows = [...points]
          .map((point) => point.calibration)
          .sort((a, b) => b.date.localeCompare(a.date));
        const latest = rows.length > 0 ? rows[0] : null;
        const latestPoint = latest
          ? points.find((point) => point.calibration.id === latest.id) ?? null
          : null;
        const delta = latestPoint?.delta ?? NO_DELTA;
        const dueInDays = daysUntilDue(latest ? latest.date : null, instrument.installDate);
        const worstVerdict = rows.reduce<ResponseVerdict>((worst, row) => {
          return VERDICT_ORDER[row.responseVerdict] > VERDICT_ORDER[worst] ? row.responseVerdict : worst;
        }, '合格');
        const suspendedCount = points.filter((point) => !point.eligible).length;
        return {
          instrument,
          stationCode: station?.code ?? '未知台站',
          arrayId: array?.id ?? station?.arrayId ?? '',
          arrayName: array?.name ?? '未知台阵',
          calibrations: rows,
          points,
          segments,
          latest,
          delta,
          count: rows.length,
          suspendedCount,
          dueInDays,
          overdue: dueInDays < 0,
          pending: instrument.state === '待标定' || dueInDays < 0,
          worstVerdict,
          trend: points.map((point) => ({
            date: point.calibration.date,
            sensitivity: point.calibration.sensitivity,
            selfNoise: point.calibration.selfNoise,
            gear: point.gear,
          })),
        };
      })
      .sort((a, b) => a.dueInDays - b.dueInDays);
  }, [arrays, instruments, reconcile, stations]);

  const historyOf = useCallback(
    (instrumentId: string): InstrumentCalibHistory | null =>
      histories.find((history) => history.instrument.id === instrumentId) ?? null,
    [histories]
  );

  const overdueHistories = useMemo(
    () => histories.filter((history) => history.overdue || history.pending),
    [histories]
  );

  const trendOf = useCallback(
    (
      instrumentId: string
    ): Array<{ date: string; sensitivity: number; selfNoise: number; gear: RangeGear | '' }> =>
      histories.find((history) => history.instrument.id === instrumentId)?.trend ?? [],
    [histories]
  );

  return { histories, historyOf, overdueHistories, trendOf };
}

/** 标定周期说明文案，供页面提示 */
export const CALIBRATION_CYCLE_TEXT = `标定周期 ${CALIBRATION_CYCLE_DAYS} 天（约 1 年），超期仪器在更换提醒页高亮`;

/** 待标定天数文案 */
export function dueText(history: InstrumentCalibHistory): string {
  return calibrateDueText(history.dueInDays);
}
