/**
 * 两侧对账（计量站 channels/adjustments ↔ 台网中心 calibrations）。
 * 对账主键：通道号 channelCode。对不上先挂账，不在任一侧强行兜底改写。
 *
 * 挂账类别：
 * - orphanChannels   计量站有通道、台网中心没有任何标定（含仪器未装的先行建档通道）
 * - unmatchedCalibs  台网中心有标定、计量站查无此通道（旧数据补不出默认档也在此单列）
 * - failedAdjustments 量程调整记录同步失败（计量站写不进台网中心，只补跑本侧）
 * - gearConflicts    标定记录登记档位与计量站调整记录在该日应生效档位不一致，待人工核
 */
import type { Calibration } from '@/types/calibration';
import type { MeasureChannel, RangeAdjustment, RangeGear } from '@/types/measure';

/** 解析某通道在指定日期生效的档位：取 effectiveDate <= date 的最近一条调整；无则用通道当前档 */
export function effectiveGearAt(
  adjustments: RangeAdjustment[],
  date: string,
  fallback: RangeGear
): RangeGear {
  const effective = adjustments
    .filter((adj) => adj.effectiveDate <= date)
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || b.createdAt - a.createdAt);
  return effective[0]?.toGear ?? fallback;
}

export interface ReconcileInput {
  channels: MeasureChannel[];
  adjustments: RangeAdjustment[];
  calibrations: Calibration[];
}

export interface GearConflict {
  calibration: Calibration;
  recordedGear: RangeGear | '';
  resolvedGear: RangeGear;
}

export interface ReconcileResult {
  /** 标定 id → 当时应生效档位（'' 表示对不上通道） */
  gearMap: Map<string, RangeGear | ''>;
  /** 计量站有、台网中心无标定的通道 */
  orphanChannels: MeasureChannel[];
  /** 台网中心有、计量站无通道（或档位补不出）的标定 */
  unmatchedCalibs: Calibration[];
  /** 同步失败的调整记录 */
  failedAdjustments: RangeAdjustment[];
  /** 登记档位与计量站调整记录推算档位不一致 */
  gearConflicts: GearConflict[];
  /** 已成功对账（通道两边都在）的标定数 */
  matchedCalibrationCount: number;
  /** 是否存在任何挂账 */
  hasPending: boolean;
}

/** 执行对账并解析每条标定的生效档位 */
export function reconcileSides({
  channels,
  adjustments,
  calibrations,
}: ReconcileInput): ReconcileResult {
  const channelByCode = new Map(channels.map((channel) => [channel.channelCode, channel]));
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const adjustmentsByChannel = new Map<string, RangeAdjustment[]>();
  adjustments.forEach((adj) => {
    const list = adjustmentsByChannel.get(adj.channelId) ?? [];
    list.push(adj);
    adjustmentsByChannel.set(adj.channelId, list);
  });

  const gearMap = new Map<string, RangeGear | ''>();
  const unmatchedCalibs: Calibration[] = [];
  const gearConflicts: GearConflict[] = [];
  const matchedChannelCodes = new Set<string>();

  calibrations.forEach((calibration) => {
    const channel =
      (calibration.channelId ? channelById.get(calibration.channelId) : undefined) ??
      (calibration.channelCode ? channelByCode.get(calibration.channelCode) : undefined);
    if (!channel) {
      gearMap.set(calibration.id, '');
      unmatchedCalibs.push(calibration);
      return;
    }
    matchedChannelCodes.add(channel.channelCode);
    const resolved = effectiveGearAt(
      adjustmentsByChannel.get(channel.id) ?? [],
      calibration.date,
      channel.currentGear
    );
    gearMap.set(calibration.id, resolved);
    if (calibration.gear && calibration.gear !== resolved) {
      gearConflicts.push({ calibration, recordedGear: calibration.gear, resolvedGear: resolved });
    }
  });

  const orphanChannels = channels.filter(
    (channel) => !matchedChannelCodes.has(channel.channelCode)
  );
  const failedAdjustments = adjustments.filter((adj) => adj.syncState === '同步失败');

  return {
    gearMap,
    orphanChannels,
    unmatchedCalibs,
    failedAdjustments,
    gearConflicts,
    matchedCalibrationCount: calibrations.length - unmatchedCalibs.length,
    hasPending:
      orphanChannels.length > 0 ||
      unmatchedCalibs.length > 0 ||
      failedAdjustments.length > 0 ||
      gearConflicts.length > 0,
  };
}
