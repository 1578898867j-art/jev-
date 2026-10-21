# 最终清理范围与计划

独立最终代码审查已通过；主控已分配按本计划执行有限 cleanup。本轮只修改确认的测试类型弱化，不改运行时逻辑。

## 范围

- `server/src/`：`app.ts`、`content.ts`、`errors.ts`、`game.ts`、`index.ts`、`paths.ts`、`ai/openai-compatible.ts`、`ai/prompts.ts`、`ai/types.ts`、`ai/validation.ts`。
- `web/src/`：`App.tsx`、`api.ts`、`app.css`、`main.tsx`、`retry-policy.ts`。
- `eval/run.ts`。
- `packages/shared/`：`package.json`、`src/contracts.ts`。
- `tests/`：`eval/run.test.ts`、`server/app.test.ts`、`web/api-request.test.ts`、`web/retry-policy.test.ts`、`web/session-snapshot.test.ts`。
- 根工程配置：`package.json`、`package-lock.json`、`tsconfig.json`、`.gitignore`、`.env.example`、`capacitor.config.ts`、`web/vite.config.ts`、`web/index.html`。

不纳入清理：本地 `.env`；`content/**`、`eval/cases/**`、`eval/results/**`；`node_modules/`、`.npm-cache/`、自动生成的 `android/**` 源码、`web/dist/`、截图及其他构建/测试产物。不得改动共享契约字段或暴露汤底、隐藏线索、服务端密钥。

## 行为锁与检查基线

现有回归覆盖 API 与状态迁移、幂等和失败回滚、AI 配置缺失、提示次数、前端请求超时/重试和迟到快照、评测输入校验及结果记账。清理前完整 `npm test` 在默认沙盒中有 22 项通过、13 项因 loopback `EACCES` 失败；获准 loopback 后为 35/35 通过。`npm run build` 基线通过；类型清理后 `npm run typecheck` 与 server API 定向测试 17/17 通过。主控负责清理后的完整测试、构建与 Android 同步；主控另已实测隐藏文件路径被 Vite 拒绝、普通 API 路径正常。

## 清理顺序

1. 清理前先确认前端验收完成，并运行现有测试、`npm run typecheck` 与 `npm run build`，记录基线；测试失败时先定位，避免把既有问题混入清理。
2. 先删除经引用搜索和测试确认的死代码、调试残留；再检查 `server/src/app.ts` 的动作处理与 `game.ts` 状态职责、`web/src/api.ts` 请求错误/超时与 `retry-policy.ts` 的边界、`eval/run.ts` 中校验和记账逻辑是否存在真实重复。只有重复确实造成维护成本时才合并。
3. 检查 `web/src/App.tsx`（当前约 938 行）的状态与页面分支；只简化重复逻辑、命名和错误路径，不为拆文件而增加包装层，也不改变页面行为。
4. 每次只处理一种明确问题，先补足对应窄回归，再运行相关测试；最后运行完整测试、typecheck、build，并复验 Vite 隐藏路径拒绝行为。

项目当前没有 lint 脚本；除非主控另行安排，不新增依赖或引入新的架构层。清理结果须逐项报告变更、验证命令和未解决风险。

## 第二轮：GLM profile、配置说明与 CI 收尾（2026-10-20）

### 范围

只审查本轮改动文件：`server/src/ai/openai-compatible.ts`、`tests/server/app.test.ts`、根 `.env.example`、根 `README.md` 的产品 AI 默认说明、`.github/workflows/verify.yml`。本轮报告追加至 `docs/CLEANUP_REPORT.md`；本节追加，不替换前一轮计划。禁止读取或修改本地 `.env`，不覆盖 model-evaluation agent 的 artifact 脚本或 environment agent 的 Android 路径改动。保留 README 已有 Web/Android 内容。

### 行为锁与基线

主控报告当前完整回归 40/40、类型检查通过；独立审查 `docs/GLM_WEB_REVIEW.md` 未发现 P0/P1/P2。该报告也记录 GLM workspace 产品未激活导致受控实测 HTTP 400；这属于账户开通阻点，不是适配器缺陷，本轮不发请求、不换参数或供应商、不加 fallback。需保护的行为包括：北京 GLM profile 的严格识别及 `enable_thinking:true`、`reasoning_effort:'low'`、默认 `max_tokens:8192`；DeepSeek 与通用兼容端点参数隔离；JSON/结构校验、30 秒后端 deadline、超时失败不结算；配置示例只含占位符，CI 不调用 live AI。

### 有界检查顺序

1. 搜查适配器和测试中可证实的死代码、重复 provider 分支、过度抽象、边界遗漏及未锁定的 profile 行为；只以当前受控测试和独立 review 结论为依据。
2. 核对 `.env.example` 与 README 默认模型/参数一致，无真实 workspace、密钥或陈旧 DeepSeek 默认说明；确认 README 其他 Web/Android 内容完整。
3. 核对 CI 只做安装、离线测试/类型检查/构建/本地评测校验，不读取 secret、不触发 live AI、不上传服务端敏感目录。
4. 若没有确证 smell，代码、测试、README 和工作流均 no-op，只追加本轮计划/报告；如发现需要改代码的问题，先向主控报告，不在此轮自行扩展行为或协议。

本轮不重复主控刚完成的完整测试与类型检查；若没有代码改动，沿用上述主控验证结果，明确记录其执行归属。

## 第三轮：Qwen profile 与 QA v2 prompt 收尾（2026-10-20）

### 范围

本轮检查 `server/src/ai/openai-compatible.ts`、`server/src/ai/prompts.ts`、`tests/server/app.test.ts`、`artifacts/qa/model-smoke.mjs`、`.github/workflows/verify.yml`。只追加本节与 `docs/CLEANUP_REPORT.md` 第三轮记录；无确证问题时不修改源代码或测试。不得改动 provider profile、prompt 版本或语义、评测预期、Web、README、状态或 GitHub 文档；不读取 `.env`、不发真实模型请求、不接触密钥。

### 行为锁与基线

保持 Qwen 北京 workspace 精确 host/path/model gate、默认非推理 `enable_thinking:false` 与 `max_completion_tokens:2048`、显式启用时 `reasoning_effort:'low'`，并保持 GLM、DeepSeek 与通用端点参数隔离；保留 qa-v2 `clueId` / 玩家证据格式、validator 结构与证据检查、空输出/截断失败、30 秒 deadline 和失败不结算。前一实现回合 `npm run typecheck` 通过，`npx vitest run tests/server/app.test.ts` 为 29/29；本轮不改代码，主控负责完整验证。

### 检查顺序

1. 对照 adapter 与受控 fetch 测试检查 dead code、重复 provider 条件、过度抽象以及 timeout / JSON 输出边界。
2. 核对 qa-v2 prompt 示例、证据指令与现有业务规则；不增加镜像字符串测试，不改校验器。
3. 检查 smoke 脚本的调用上限、目标配置约束、报告元数据边界和退出状态；只读代码，不运行脚本。
4. 检查 CI 是否保持无 secrets、无 live AI 调用，且验证步骤有界。
5. 仅当发现可复现的确证问题才提出源代码改动；若无问题，追加 no-op 报告并交由主控跑全量验证。
