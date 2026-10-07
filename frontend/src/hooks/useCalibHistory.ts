/**
 * useCalibHistory：按仪器聚合历次标定、算灵敏度变化量与待标定天数。
 * 灵敏度变化按同档口径：只与同一量程档内的前一次标定比较，跨档不直接相减。
 * 被标定记录台（/calibrations）与更换提醒页（/replacements）消费。
 */
import { useCallback, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import { selectCalibrations } from '@/stores/calibrationSlice';
import { calibrateDueText, sensitivityDeltaSameRange, type SensitivityDelta } from '@/types/calibration';
import { CALIBRATION_CYCLE_DAYS, daysUntilDue } from '@/types/instrument';
import type { Calibration, ResponseVerdict } from '@/types/calibration';
import type { Instrument } from '@/types/instrument';

/** 趋势点（由旧到新），带档位 id 供趋势图按档分段 */
export interface TrendPoint {
  date: string;
  sensitivity: number;
  selfNoise: number;
  rangeId: string | null;
}

/** 单台仪器的标定历史聚合 */
export interface InstrumentCalibHistory {
  instrument: Instrument;
  stationCode: string;
  arrayId: string;
  arrayName: string;
  /** 历次标定（按日期降序） */
  calibrations: Calibration[];
  /** 最近一次标定 */
  latest: Calibration | null;
  /** 最近一次灵敏度相对同档上一次的变化（跨档不直接相减） */
  delta: SensitivityDelta;
  /** 标定次数 */
  count: number;
  /** 距下次标定天数（负数为已超期） */
  dueInDays: number;
  /** 是否超期未标定 */
  overdue: boolean;
  /** 是否处于待标定状态 */
  pending: boolean;
  /** 历次结论中最差的一次 */
  worstVerdict: ResponseVerdict;
  /** 灵敏度序列（由旧到新），供趋势展示 */
  trend: TrendPoint[];
}

export interface UseCalibHistoryResult {
  histories: InstrumentCalibHistory[];
  historyOf: (instrumentId: string) => InstrumentCalibHistory | null;
  overdueHistories: InstrumentCalibHistory[];
  /** 灵敏度趋势：返回指定仪器的序列 */
  trendOf: (instrumentId: string) => TrendPoint[];
}

const VERDICT_ORDER: Record<ResponseVerdict, number> = { 合格: 0, 待判定: 1, 不合格: 2 };

/** 同档口径的灵敏度变化：找同档位的前一次标定；只有跨档前次时标记 crossRange */
export function sameRangeDelta(latest: Calibration | null, rowsDesc: Calibration[]): SensitivityDelta {
  if (!latest || rowsDesc.length === 0) {
    return { absolute: 0, percent: 0, comparable: false, crossRange: false };
  }
  const previousSameRange = rowsDesc.find((row) => (row.rangeId ?? null) === (latest.rangeId ?? null)) ?? null;
  if (previousSameRange) return sensitivityDeltaSameRange(latest, previousSameRange);
  return { absolute: 0, percent: 0, comparable: false, crossRange: rowsDesc.length > 0 };
}

/**
 * 组合式 Hook：基于 Redux 中的台阵 / 台站 / 仪器 / 标定数据派生标定历史与超期提醒。
 */
export function useCalibHistory(): UseCalibHistoryResult {
  const arrays = useSelector(selectArrays);
  const stations = useSelector(selectStations);
  const instruments = useSelector(selectInstruments);
  const calibrations = useSelector(selectCalibrations);

  const histories = useMemo<InstrumentCalibHistory[]>(() => {
    return instruments
      .map((instrument) => {
        const station = stations.find((item) => item.id === instrument.stationId);
        const array = station ? arrays.find((item) => item.id === station.arrayId) : undefined;
        const rows = calibrations
          .filter((calibration) => calibration.instrumentId === instrument.id)
          .sort((a, b) => b.date.localeCompare(a.date));
        const latest = rows.length > 0 ? rows[0] : null;
        const delta = sameRangeDelta(latest, rows.slice(1));
        const dueInDays = daysUntilDue(latest ? latest.date : null, instrument.installDate);
        const worstVerdict = rows.reduce<ResponseVerdict>((worst, row) => {
          return VERDICT_ORDER[row.responseVerdict] > VERDICT_ORDER[worst] ? row.responseVerdict : worst;
        }, '合格');
        return {
          instrument,
          stationCode: station?.code ?? '未知台站',
          arrayId: array?.id ?? station?.arrayId ?? '',
          arrayName: array?.name ?? '未知台阵',
          calibrations: rows,
          latest,
          delta,
          count: rows.length,
          dueInDays,
          overdue: dueInDays < 0,
          pending: instrument.state === '待标定' || dueInDays < 0,
          worstVerdict,
          trend: [...rows].reverse().map((row) => ({
            date: row.date,
            sensitivity: row.sensitivity,
            selfNoise: row.selfNoise,
            rangeId: row.rangeId ?? null,
          })),
        };
      })
      .sort((a, b) => a.dueInDays - b.dueInDays);
  }, [arrays, calibrations, instruments, stations]);

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
    (instrumentId: string): TrendPoint[] =>
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
