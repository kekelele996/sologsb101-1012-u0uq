# sologsb101-1012 地震台阵仪器标定与布设台账

面向地震台阵建设与运维班组的纯前端单页应用：把台站布设、仪器安装与逐次标定结果写成可追溯的台账。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22812**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22812）。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18.3（函数组件 + Hooks） | 页面全部 `lazy` 懒加载并 `Suspense` 兜底 |
| 语言 | TypeScript 5.6（strict） | 构建脚本执行 `tsc --noEmit` 类型检查 |
| UI 组件 | Ant Design 5.22 + @ant-design/icons | 中文语言包，表格 / 表单 / Modal / 徽标 |
| 构建 | Vite 5 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Redux Toolkit 2 + react-redux 9 | `arraySlice` / `instrumentSlice` / `calibrationSlice` |
| 路由 | React Router 6（`createBrowserRouter`） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbseisarray`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/arrays` | 台阵与台站台账 | Array、Station、Instrument | 新建/编辑/删除台阵，按布设日期、运行状态与孔径分档筛选；卡片回显台站数、仪器数与同档口径标定合格率，可一键按经纬度重算孔径 |
| `/stations/:id/instruments` | 台站仪器登记与安装位置维护 | Station、Instrument、MeasureChannel | 新增/编辑/删除台站（经纬度范围校验 + 度分秒显示、基岩类型、高程），登记仪器（型号/序列号**唯一性校验**/安装日期/状态），登记后自动生成下一次标定待办并在计量站侧补一条默认档通道 |
| `/measure` | 计量站：通道量程档与调整记录 | MeasureChannel、RangeAdjustment | 维护各通道当前量程档、登记量程调整（含生效日期与同步状态）；计量站写不进去只「补跑本侧」，台网中心已认标定不回退；按通道号与台网中心对账，对不上先挂账 |
| `/calibrations` | 标定记录台（台网中心） | Calibration、Instrument、MeasureChannel、RangeAdjustment | 录入每条标定时**当时生效档位**、灵敏度、自噪与结论（按档自动初判）；灵敏度变化按**同档链式口径**只与同档前一次比，跨档趋势分段断线；合格率与趋势同口径，换档首条/缺档挂起不计 |
| `/replacements` | 合格评定与更换提醒 | Replace、Calibration、Instrument | 按 365 天标定周期评定，超期未标定与不合格仪器高亮；登记更换并推进状态机（待更换→已更换→已复核），流转到「已更换」时回写仪器序列号 |
| `/geometry` | 台阵几何视图与结构版本 | 全部模型 | 实算孔径与台站间距、SVG 几何平面图与辐射距离、按台阵汇总标定结论、结构版本查看、全量 JSON 导入导出（七张表） |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该台阵，页面渲染 `<RouteMissingPanel>` 友好空态（含「返回台阵台账」与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1012/
├── README.md
├── docker-compose.yml          # name: gbseisarray，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx            # Provider + ConfigProvider + RouterProvider
        ├── App.tsx             # 侧边导航 + 顶部上下文条 + 页脚，并启动各表订阅
        ├── types/              # array / station / instrument / measure / calibration / replace / filter
        ├── stores/             # arraySlice / instrumentSlice / measureSlice / calibrationSlice / store.ts
        ├── components/common/  # QualifyTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel / ReconcilePanel
        ├── hooks/              # useIdbTable / useCalibHistory / useReconcile
        ├── pages/              # ArrayList / StationInstruments / MeasureBoard / CalibrationBoard / ReplaceBoard / GeometryView
        ├── router/index.tsx    # 路由表（路径与提示词逐字一致）
        ├── styles/main.css
        └── utils/              # geo.ts / db.ts / rangeCaliber.ts（同档口径）/ reconcile.ts（两侧对账）/ export.ts
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22812
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbseisarray`，当前结构版本 `v3`。读写统一经 `frontend/src/utils/db.ts` 封装，页面组件不直接触碰 Dexie 实例。
- **数据表（七张，两侧分工）**：
  - 计量站侧：`channels`（通道量程档，通道号 `channelCode` 为对账主键）、`adjustments`（量程调整记录，含生效日期与「已同步/待同步/同步失败」状态）。
  - 台网中心侧：`calibrations`（标定记录，含 `channelId/channelCode` 与当时生效档 `gear`）；另有 `arrays`、`stations`、`instruments`、`replaces`。
- **两侧对账**：`utils/reconcile.ts` 按通道号比对两侧，并按调整记录的生效日期解析每条标定「当时生效档位」。对不上先挂账（计量站有通道无标定、台网有标定无通道、档位登记冲突、调整同步失败），不强行兜底。
- **同档口径（趋势与合格率共用）**：`utils/rangeCaliber.ts` 规定——每条标定只与**同一通道、同一生效档**内时间最近的前一条比（同档链式比较）；换档后新档首条与档位缺失记录「挂起不计」，趋势图在跨档处分段断线。合格率只统计同档可比且结论明确的记录，与趋势图同一比较器，换量程档造成的灵敏度整体阶跃不会被当成仪器故障。合格区间按标准档（高/低增益先按增益因子换算回标准档）判定。
- **同步失败只补跑本侧**：计量站调整记录同步失败时，`measureSlice.retryAdjustmentSync` 只更新计量站侧状态，不删除/回退台网中心已认下的标定。
- **升级迁移**：v1 为初版结构；v2 补齐索引与必填字段；`db.version(3)` 新增 `channels/adjustments` 两表并给 `calibrations` 增加通道与档位字段，升级时按「仪器→台站→通道号」给旧标定补一条默认档通道并回填 `gear=标准档`，补不出通道的留空（`gear=''`）由对账页单列；调整字段结构时递增 `DB_VERSION` 并补迁移。
- **首屏播种**：`initDatabase()` 在 `arrays` 表为空时执行幂等播种，演示数据为 2 个台阵 / 5 个台站 / 8 台仪器 / 9 条通道 / 16 条标定 / 3 条量程调整（含 1 条同步失败）/ 3 条更换；其中 LTX01-BB 通道在 2025-03 中途由标准档换入高增益档（灵敏度整体抬升约 4 倍），用于验证跨档不同档相减、趋势断段与挂起不计的口径；另含 1 条计量站先行建档、台网暂无标定的挂账通道。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，`App.tsx` 挂载时启动订阅并把数据 dispatch 到 Redux slice，页面只读 selector。
- **业务规则**：标定周期 365 天（超期即在更换提醒页高亮）；标准档合格区间为宽频带 800~3000、短周期 100~800、强震 0.1~5，且自噪 ≤ 3.5，最终以标定报告为准；仪器序列号全局唯一；更换状态机为 待更换 → 已更换 → 已复核，流转到「已更换」时把新序列号回写到仪器档案并置为在用。
- **备份与恢复**：`/geometry` 页可导出包含七张表的 JSON 快照，支持「覆盖导入」与「追加导入（重新分配 id）」；旧版备份（无 channels/adjustments）导入时按空表兼容并提示补档；备份时间写入 `localStorage`，页脚与几何页均展示结构版本号。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。
