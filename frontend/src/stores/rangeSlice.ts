/**
 * 量程档 slice（计量站侧）：维护各通道量程档与调整记录。
 * 职责切分：本 slice 只管计量站侧档案；标定记录、灵敏度变化与合格率归 calibrationSlice（台网中心侧）。
 * 两侧按通道号（仪器序列号）对账；本侧写失败只补跑本侧，台网中心认下的标定记录不回退。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  db,
  createId,
  watchTable,
  createDefaultRangeForChannel,
  readMetrologyPending,
  writeMetrologyPending,
  readRangeMigrationSkipped,
  type MetrologyPendingItem,
  type RangeMigrationSkipped,
} from '@/utils/db';
import type { GainRange, RangeAdjustment, ReconcileIssue } from '@/types/range';
import { currentRangeOf } from '@/types/range';
import type { RootState } from '@/stores/store';

/** 选择器入参统一用 RootState */
type WithRange = RootState;

export interface RangeSliceState {
  ranges: GainRange[];
  adjustments: RangeAdjustment[];
  ready: boolean;
  error: string | null;
  /** 计量站侧待补跑队列（本侧写失败时入队） */
  pendingRetry: MetrologyPendingItem[];
  /** 升级迁移时补不出默认档的清单（单列展示） */
  migrationSkipped: RangeMigrationSkipped[];
  /** 最近一次操作回执 */
  lastReceipt: string;
}

const initialState: RangeSliceState = {
  ranges: [],
  adjustments: [],
  ready: false,
  error: null,
  pendingRetry: [],
  migrationSkipped: [],
  lastReceipt: '',
};

/** 换档入参 */
export interface SwitchRangePayload {
  channelCode: string;
  label: string;
  date: string;
  reason: string;
  operator: string;
  remark: string;
}

/**
 * 计量站侧换档：关闭当前生效档、开新档、写调整记录（本侧一个事务）。
 * 只动计量站侧档案，不触碰台网中心侧的标定记录。
 */
export const switchRange = createAsyncThunk(
  'range/switchRange',
  async (payload: SwitchRangePayload, { rejectWithValue }) => {
    const channelCode = payload.channelCode.trim();
    if (!channelCode) return rejectWithValue('通道号为空，无法换档');
    const rows = await db.ranges.where('channelCode').equals(channelCode).toArray();
    const current = currentRangeOf(rows, channelCode);
    if (current && payload.date < current.effectiveFrom) {
      return rejectWithValue(`换档日期不能早于当前档「${current.label}」的生效日期 ${current.effectiveFrom}`);
    }
    const now = Date.now();
    const newRangeId = createId('rng');
    await db.transaction('rw', [db.ranges, db.rangeAdjustments], async () => {
      if (current) {
        await db.ranges.update(current.id, { effectiveTo: payload.date, updatedAt: now } as never);
      }
      await db.ranges.put({
        id: newRangeId,
        channelCode,
        label: payload.label,
        effectiveFrom: payload.date,
        effectiveTo: null,
        isDefault: false,
        remark: payload.remark,
        createdAt: now,
        updatedAt: now,
      });
      await db.rangeAdjustments.put({
        id: createId('adj'),
        channelCode,
        fromRangeId: current?.id ?? null,
        toRangeId: newRangeId,
        date: payload.date,
        reason: payload.reason,
        operator: payload.operator,
        remark: payload.remark,
        createdAt: now,
        updatedAt: now,
      });
    });
    return { channelCode, rangeId: newRangeId, fromLabel: current?.label ?? null };
  }
);

/**
 * 补跑计量站侧：逐条重试待补跑队列。
 * 补建默认档成功后把档位 id 补登到台网中心侧已认下的标定记录上（补登不是回退）。
 */
export const retryMetrologySide = createAsyncThunk('range/retryMetrologySide', async () => {
  const queue = readMetrologyPending();
  const remaining: MetrologyPendingItem[] = [];
  let done = 0;
  for (const item of queue) {
    try {
      const rangeId = await createDefaultRangeForChannel(item.channelCode, item.date);
      await db.calibrations.update(item.calibrationId, {
        rangeId,
        channelCode: item.channelCode,
        updatedAt: Date.now(),
      } as never);
      done += 1;
    } catch {
      remaining.push(item);
    }
  }
  writeMetrologyPending(remaining);
  return { done, remaining };
});

const rangeSlice = createSlice({
  name: 'range',
  initialState,
  reducers: {
    setRanges(state, action: PayloadAction<GainRange[]>) {
      state.ranges = action.payload;
      state.ready = true;
      state.error = null;
    },
    setRangeAdjustments(state, action: PayloadAction<RangeAdjustment[]>) {
      state.adjustments = action.payload;
    },
    setPendingRetry(state, action: PayloadAction<MetrologyPendingItem[]>) {
      state.pendingRetry = action.payload;
    },
    setMigrationSkipped(state, action: PayloadAction<RangeMigrationSkipped[]>) {
      state.migrationSkipped = action.payload;
    },
    setRangeError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(switchRange.fulfilled, (state, action) => {
        state.lastReceipt = action.payload.fromLabel
          ? `通道 ${action.payload.channelCode} 已由「${action.payload.fromLabel}」换档，调整记录已留痕`
          : `通道 ${action.payload.channelCode} 已建档，调整记录已留痕`;
        state.error = null;
      })
      .addCase(switchRange.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '换档失败';
      })
      .addCase(retryMetrologySide.fulfilled, (state, action) => {
        state.pendingRetry = action.payload.remaining;
        state.lastReceipt =
          action.payload.done > 0
            ? `计量站侧补跑完成 ${action.payload.done} 条，标定记录已补登档位` +
              (action.payload.remaining.length > 0 ? `，仍余 ${action.payload.remaining.length} 条待补跑` : '')
            : '计量站侧没有可补跑的记录';
      });
  },
});

export const { setRanges, setRangeAdjustments, setPendingRetry, setMigrationSkipped, setRangeError } =
  rangeSlice.actions;

let started = false;

/** 启动量程档 / 调整记录表实时订阅，并载入待补跑队列与迁移清单（幂等） */
export function startRangeSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<GainRange>(() => db.ranges).subscribe((rows) => {
    dispatch(setRanges(rows));
  });
  watchTable<RangeAdjustment>(() => db.rangeAdjustments).subscribe((rows) => {
    dispatch(setRangeAdjustments(rows));
  });
  dispatch(setPendingRetry(readMetrologyPending()));
  dispatch(setMigrationSkipped(readRangeMigrationSkipped()));
}

/* ------------------------------ Selector ------------------------------ */

export const selectRanges = (state: WithRange): GainRange[] => state.range.ranges;
export const selectRangeAdjustments = (state: WithRange): RangeAdjustment[] => state.range.adjustments;
export const selectRangeReady = (state: WithRange): boolean => state.range.ready;
export const selectRangeError = (state: WithRange): string | null => state.range.error;
export const selectMetrologyPending = (state: WithRange): MetrologyPendingItem[] =>
  state.range.pendingRetry;
export const selectMigrationSkipped = (state: WithRange): RangeMigrationSkipped[] =>
  state.range.migrationSkipped;
export const selectRangeReceipt = (state: WithRange): string => state.range.lastReceipt;

/** 档位 id → 档位（标定记录台按 rangeId 回显档位名） */
export const selectRangeById = (state: WithRange): Map<string, GainRange> =>
  new Map(state.range.ranges.map((row) => [row.id, row]));

/**
 * 两侧对账：按通道号核对计量站侧档位与台网中心侧仪器 / 标定。
 * 对不上的先挂着：档位找不到仪器、标定没有生效档位、迁移补不出默认档。
 */
export const selectReconcileIssues = (state: WithRange): ReconcileIssue[] => {
  const serials = new Set(state.instrument.instruments.map((row) => row.serialNo));
  const rangeIds = new Set(state.range.ranges.map((row) => row.id));
  const issues: ReconcileIssue[] = [];
  state.range.ranges.forEach((range) => {
    if (!serials.has(range.channelCode)) {
      issues.push({
        kind: '档位无仪器',
        channelCode: range.channelCode,
        detail: `档位「${range.label}」（${range.effectiveFrom} 起）的通道号在仪器档案中查不到，先挂起`,
      });
    }
  });
  state.calibration.calibrations.forEach((calibration) => {
    if (!calibration.rangeId || !rangeIds.has(calibration.rangeId)) {
      issues.push({
        kind: '标定无档位',
        channelCode: calibration.channelCode || '未登记',
        detail: `${calibration.date} 的标定记录没有生效档位，待计量站侧补档后对账`,
      });
    }
  });
  state.range.migrationSkipped.forEach((item) => {
    issues.push({ kind: '迁移未补档', channelCode: item.sourceId, detail: item.reason });
  });
  return issues;
};

export default rangeSlice.reducer;
