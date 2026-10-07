/**
 * useReconcile：合并计量站（channels/adjustments）与台网中心（calibrations）两侧数据，
 * 产出按通道号的对账结果，并对每条标定应用「同档链式比较」唯一口径。
 * 被标定记录台、计量站对账面板、更换提醒页共用，保证趋势图与合格率口径一致。
 */
import { useMemo } from 'react';
import { useAppSelector } from '@/stores/store';
import { selectChannels, selectAdjustments } from '@/stores/measureSlice';
import { selectCalibrations } from '@/stores/calibrationSlice';
import { reconcileSides, type ReconcileResult } from '@/utils/reconcile';
import {
  buildCaliberPoints,
  buildCaliberSegments,
  qualifyStatOf,
  type CaliberPoint,
  type CaliberSegment,
} from '@/utils/rangeCaliber';

export interface UseReconcileResult extends ReconcileResult {
  /** 全部标定的同档口径点（按仪器分组） */
  pointsByInstrument: Map<string, CaliberPoint[]>;
  pointsOfInstrument: (instrumentId: string) => CaliberPoint[];
  segmentsOfInstrument: (instrumentId: string) => CaliberSegment[];
  /** 标定 id → 同档口径点 */
  pointById: Map<string, CaliberPoint>;
  /** 全局合格率（与趋势同口径，只计同档可比记录） */
  qualify: ReturnType<typeof qualifyStatOf>;
}

export function useReconcile(): UseReconcileResult {
  const channels = useAppSelector(selectChannels);
  const adjustments = useAppSelector(selectAdjustments);
  const calibrations = useAppSelector(selectCalibrations);

  return useMemo<UseReconcileResult>(() => {
    const result = reconcileSides({ channels, adjustments, calibrations });

    const pointsByInstrument = new Map<string, CaliberPoint[]>();
    const pointById = new Map<string, CaliberPoint>();
    const grouped = new Map<string, typeof calibrations>();
    calibrations.forEach((calibration) => {
      const list = grouped.get(calibration.instrumentId) ?? [];
      list.push(calibration);
      grouped.set(calibration.instrumentId, list);
    });
    grouped.forEach((list, instrumentId) => {
      const points = buildCaliberPoints(list, result.gearMap);
      pointsByInstrument.set(instrumentId, points);
      points.forEach((point) => pointById.set(point.calibration.id, point));
    });

    const allPoints = [...pointById.values()];

    return {
      ...result,
      pointsByInstrument,
      pointById,
      pointsOfInstrument: (instrumentId) => pointsByInstrument.get(instrumentId) ?? [],
      segmentsOfInstrument: (instrumentId) =>
        buildCaliberSegments(pointsByInstrument.get(instrumentId) ?? []),
      qualify: qualifyStatOf(allPoints),
    };
  }, [adjustments, calibrations, channels]);
}
