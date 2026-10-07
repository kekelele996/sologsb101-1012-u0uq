/**
 * 计量站 slice：维护通道量程档与量程调整记录。
 * 计量站只写本侧 channels / adjustments；与台网中心 calibrations 按通道号对账。
 * 同步失败时只补跑本侧调整记录（retryAdjustmentSync），不回退台网中心已认下的标定。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import {
  type MeasureChannel,
  type RangeAdjustment,
  type RangeGear,
} from '@/types/measure';
import type { RootState } from '@/stores/store';

type WithMeasure = RootState;

export interface MeasureSliceState {
  channels: MeasureChannel[];
  adjustments: RangeAdjustment[];
  ready: boolean;
  error: string | null;
  lastReceipt: string;
}

const initialState: MeasureSliceState = {
  channels: [],
  adjustments: [],
  ready: false,
  error: null,
  lastReceipt: '',
};

/* ------------------------------ 通道 ------------------------------ */

export const createChannel = createAsyncThunk(
  'measure/createChannel',
  async (payload: Omit<MeasureChannel, 'id' | 'createdAt' | 'updatedAt'>) => {
    const now = Date.now();
    const row: MeasureChannel = { ...payload, id: createId('ch'), createdAt: now, updatedAt: now };
    await db.channels.put(row);
    return row;
  }
);

export const updateChannel = createAsyncThunk(
  'measure/updateChannel',
  async (payload: { id: string; patch: Partial<MeasureChannel> }) => {
    await db.channels.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

export const removeChannel = createAsyncThunk('measure/removeChannel', async (channelId: string) => {
  await db.transaction('rw', [db.channels, db.adjustments], async () => {
    await db.adjustments.where('channelId').equals(channelId).delete();
    await db.channels.delete(channelId);
  });
  return channelId;
});

/* ------------------------------ 量程调整记录 ------------------------------ */

export const createAdjustment = createAsyncThunk(
  'measure/createAdjustment',
  async (
    payload: Omit<RangeAdjustment, 'id' | 'createdAt' | 'updatedAt' | 'syncState' | 'syncedAt' | 'syncError'>
  ) => {
    const now = Date.now();
    const row: RangeAdjustment = {
      ...payload,
      id: createId('adj'),
      // 计量站侧先落库为待同步，再由补跑同步动作推到台网中心
      syncState: '待同步',
      syncedAt: null,
      syncError: '',
      createdAt: now,
      updatedAt: now,
    };
    await db.adjustments.put(row);
    // 通道当前生效档位随调整更新
    await db.channels.update(payload.channelId, { currentGear: payload.toGear, updatedAt: now } as never);
    return row;
  }
);

export const removeAdjustment = createAsyncThunk(
  'measure/removeAdjustment',
  async (id: string) => {
    await db.adjustments.delete(id);
    return id;
  }
);

/**
 * 补跑同步：计量站把调整记录推给台网中心。
 * 纯前端无真实接口，这里幂等地只更新计量站本侧调整记录的同步状态；
 * 绝不会删除/回退台网中心已认下的标定记录。
 */
export const retryAdjustmentSync = createAsyncThunk(
  'measure/retryAdjustmentSync',
  async (payload: { id: string; simulateFailure?: boolean }, { rejectWithValue }) => {
    const adjustment = await db.adjustments.get(payload.id);
    if (!adjustment) return rejectWithValue('调整记录不存在');
    const now = Date.now();
    if (payload.simulateFailure) {
      await db.adjustments.update(payload.id, {
        syncState: '同步失败',
        syncedAt: now,
        syncError: '台网中心接口超时（模拟），仅计量站侧保留，台网已认标定不回退',
        updatedAt: now,
      } as never);
      return rejectWithValue('补跑同步失败（模拟），已保留计量站本侧记录');
    }
    await db.adjustments.update(payload.id, {
      syncState: '已同步',
      syncedAt: now,
      syncError: '',
      updatedAt: now,
    } as never);
    return { id: payload.id, syncedAt: now };
  }
);

const measureSlice = createSlice({
  name: 'measure',
  initialState,
  reducers: {
    setChannels(state, action: PayloadAction<MeasureChannel[]>) {
      state.channels = action.payload;
      state.ready = true;
      state.error = null;
    },
    setAdjustments(state, action: PayloadAction<RangeAdjustment[]>) {
      state.adjustments = action.payload;
    },
    setMeasureError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setMeasureReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createAdjustment.fulfilled, (state, action) => {
        state.lastReceipt = `通道 ${action.payload.channelCode} 量程已调整为「${action.payload.toGear}」，待同步台网中心`;
      })
      .addCase(retryAdjustmentSync.fulfilled, (state, action) => {
        state.lastReceipt = `调整记录 ${action.payload.id} 已补跑同步成功`;
      })
      .addCase(retryAdjustmentSync.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '补跑同步失败';
      });
  },
});

export const { setChannels, setAdjustments, setMeasureError, setMeasureReceipt } =
  measureSlice.actions;

let started = false;

/** 启动计量站两张表实时订阅（幂等） */
export function startMeasureSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<MeasureChannel>(() => db.channels).subscribe((rows) => {
    dispatch(setChannels(rows));
  });
  watchTable<RangeAdjustment>(() => db.adjustments).subscribe((rows) => {
    dispatch(setAdjustments(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectChannels = (state: WithMeasure): MeasureChannel[] => state.measure.channels;
export const selectAdjustments = (state: WithMeasure): RangeAdjustment[] => state.measure.adjustments;
export const selectMeasureReady = (state: WithMeasure): boolean => state.measure.ready;
export const selectChannelById = (
  state: WithMeasure,
  id: string | null | undefined
): MeasureChannel | null => (id ? state.measure.channels.find((row) => row.id === id) ?? null : null);
/** 仪器 id → 通道（一台仪器一条主通道） */
export const selectChannelByInstrument = (
  instruments: MeasureChannel[],
  instrumentId: string
): MeasureChannel | undefined => instruments.find((row) => row.instrumentId === instrumentId);

export function gearColor(gear: RangeGear | ''): string {
  if (gear === '高增益档') return 'blue';
  if (gear === '低增益档') return 'purple';
  if (gear === '标准档') return 'default';
  return 'red';
}

export default measureSlice.reducer;
