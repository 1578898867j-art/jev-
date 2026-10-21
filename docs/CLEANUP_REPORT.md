# AI Slop Cleanup Report

## Scope

按 [cleanup 计划](CLEANUP_PLAN.md) 检查 `server/src/`、`web/src/`、`eval/run.ts`、`packages/shared/`、`tests/` 与根工程配置。除 `tests/server/app.test.ts` 外，未发现足以证明应删除代码或合并逻辑的重复、死代码、调试残留或错误命名；未拆分 `App.tsx`，也未添加抽象或依赖。未读取或修改 `.env`，未改题库、用例或 Android 生成源码。按任务要求运行的基线 `npm run build` 刷新了 `web/dist/`；没有手工编辑构建产物，主控将运行最终构建。

## Cleanup

- 将 `tests/server/app.test.ts` 的 `callJson` 改为必须提供响应类型，移除默认与显式 `any`，改用共享的 `ActionResponse`、`ApiError`、`CreateSessionResponse`、`SessionView`，并为健康响应声明窄类型。
- 对可选汤底与末条消息做类型安全访问。运行行为和测试断言含义不变。
- 独立补交付说明：更新根 `README.md`，说明 `npm ci`、已准备的本地 `.env`、DeepSeek 默认配置、两种评测命令、服务端口和 Android 文档入口；未读取 `.env` 内容。

## Verification

- 清理前 `npm run build`：通过，typecheck 与 Web build 均成功。
- 清理前沙盒内 `npm test`：22 项通过，13 项 server 测试因连接 `127.0.0.1` 返回 `EACCES`。获准 loopback 后完整 `npm test`：5 个测试文件、35/35 项通过。
- 清理后 `npm run typecheck`：通过。
- 清理后 `npm test -- tests/server/app.test.ts`（允许 loopback）：1 个测试文件、17/17 项通过。
- `rg` 检查 `tests/server/app.test.ts`：未发现 `<any>`、`as any` 或 `= any`。

## Deferred

没有对清理后的全部测试和构建再次执行；主控负责清理后的完整 `npm test`、`npm run build`、Android 同步和后续浏览器 QA。

## 第二轮：GLM profile、配置说明与 CI 收尾（2026-10-20）

### 范围与行为锁

按第二轮计划检查 `server/src/ai/openai-compatible.ts`、`tests/server/app.test.ts`、根 `.env.example`、根 `README.md` 和 `.github/workflows/verify.yml`。主控报告清理前完整回归 40/40 且类型检查通过；`docs/GLM_WEB_REVIEW.md` 独立审查未发现 P0/P1/P2。本轮保护既有 GLM/DeepSeek 参数隔离、JSON 与证据校验、30 秒服务端 deadline、失败不结算、CI 无 live AI 请求及配置中无真实 workspace/密钥。

### Cleanup

- 删除 `tests/server/app.test.ts` 中无读取者的 `Harness.ai` 属性及 `startHarness` 返回值。`ai` 仍传入 `createApp`，各用例继续保留本地替身引用以检查调用次数；断言与运行行为未变。
- 未发现适配器的死分支、需要合并的 provider 参数逻辑、调试残留或多余抽象。适配器请求组装边界与 GLM profile 条件保持原样。
- 两处受控延迟响应 fixture 分别覆盖 adapter 的 timeout 分类与 API 的失败原子性，故保留为两项窄测试，没有引入共享测试抽象。
- `.env.example` 只有 workspace 占位符和空 API key；README 使用精确 GLM 模型及 `AI_THINKING=enabled` 作为当前配置说明，DeepSeek 只列为替代项。README 原有 Web/Android 段落完整。CI 只安装依赖、执行测试/构建/本地用例验证并上传 `web/dist`，不注入 AI 密钥或触发真实调用；均无进一步修改。
- 未读取或修改本地 `.env`。没有扩展 provider、HTTP 协议、模型参数或失败语义。

### 验证

- 行为锁清理前：主控报告完整测试 40/40；该结果未冒充本代理本轮重跑。
- 本轮删除测试 harness 的无用字段后，`npx vitest run tests/server/app.test.ts`：1 个文件，22/22 通过（受控 fake adapter；本地 loopback）。
- `npm run typecheck -- --pretty false`：通过。
- `rg -n "console\\.|TODO|FIXME|debugger|as any|: any" server/src/ai/openai-compatible.ts tests/server/app.test.ts .env.example README.md .github/workflows/verify.yml`：无输出。
- 项目未提供 lint 脚本。本代理未重复完整 `npm test` 或 `npm run build`；主控随后执行最终 40 项全测与 build，远端 GitHub Actions 仍需 push 后确认。

### 剩余风险

GLM workspace 产品尚未激活；主控收到的受控实测为 HTTP 400 产品未激活提示，因此真实聊天可用性与首题语义门槛仍待开通后验证。本轮没有再发请求、切换模型或添加回退逻辑。

## 第三轮：Qwen profile 与 QA v2 prompt 收尾（2026-10-20）

### Scope 与行为锁

检查 `server/src/ai/openai-compatible.ts`、`server/src/ai/prompts.ts`、`tests/server/app.test.ts`、`artifacts/qa/model-smoke.mjs`、`.github/workflows/verify.yml`。保持精确 Qwen profile 和 token/推理参数映射、GLM/DeepSeek/通用端点隔离、qa-v2 JSON/玩家证据要求、结构验证、空/截断响应失败、30 秒 deadline 与失败不结算。本轮不改代码、不改测试，不读取 `.env` 或发送真实请求。

### Cleanup 与检查结果

- 未发现可证实的死代码、重复 provider 分支、过度抽象或错误边界，源文件与受控测试均 no-op。Qwen、GLM、DeepSeek 和通用兼容端点仍各由清晰条件隔离；没有为了抽象而抽象的 provider 层。
- QA prompt 的非空候选示例完整包含 `clueId`、`evidence`、`messageId`、`quote`；指令要求复制 trusted clue ID/current message ID 和连续玩家原文，禁止 `id` 别名，示例值不可照搬。既有 yes/non-yes、事实/因果和隐藏内容规则仍在；无需增加镜像提示词字符串测试。
- 服务端测试覆盖 Qwen 开/关参数和 token 字段、profile host/path/model 边界、其它供应商参数隔离、截断与响应体超时、失败不结算，以及证据不合法时整体回滚；未发现应合并的重复 fixture 抽象。
- Smoke 脚本限制模型白名单与三次请求，校验北京 workspace 地址，只记录允许的请求参数、状态、usage 和评测元数据，并在失败时设置非零退出码。本轮只读审阅，没有执行它。
- CI 只运行锁文件安装、测试、构建和本地 case 校验，再上传 Web 构建产物；未发现 secrets 注入或 live AI 步骤。
- `docs/CLEANUP_PLAN.md` 与本报告各追加了本轮范围；未改动 provider 配置、prompt 版本、评测预期、Web、README 或 GitHub 文件。

### Quality Gates

- 行为锁：QA v2 实现回合已运行 `npx vitest run tests/server/app.test.ts`，29/29 通过；本轮仅改 cleanup 文档，没有重复运行。
- Typecheck：QA v2 实现回合已运行 `npm run typecheck`，通过；本轮没有源代码改动。
- Lint：N/A，项目没有 lint 脚本。
- 本轮完整测试与 build：由主控执行，不将先前结果冒充为本轮重跑。
- Static/security：只读检查指定的 smoke/CI 范围；未访问 `.env`，未输出或使用密钥。

### Changed Files 与剩余风险

- `docs/CLEANUP_PLAN.md`：追加第三轮有界计划。
- `docs/CLEANUP_REPORT.md`：记录本轮 no-op 结论与已有验证证据。
- 源代码及测试无变更。未发现本轮新增风险；真实模型质量与服务可用性仍由主控安排的真实评测判断，本 cleanup pass 不对此作结论。

## Follow-up：评测测试跟随 QA prompt 版本常量（2026-10-20）

主控完整测试发现 `tests/eval/run.test.ts` 将结果元数据固定断言为 `qa-v1`，与当前生产版本 `qa-v2` 不一致。该测试现在从 `server/src/ai/prompts.ts` 导入 `QA_PROMPT_VERSION` 并断言执行结果传播此常量；原有 validator、线索记账和状态断言未改，也没有新增 prompt/body 字符串镜像测试。

验证：`npx vitest run tests/eval/run.test.ts` 通过，1 个文件、6/6 项通过。主控负责随后重跑完整 47 项回归。

变更：`tests/eval/run.test.ts`、`docs/CLEANUP_REPORT.md`。提示词版本、评测预期与运行时逻辑均未改。

## Follow-up：qa-v3 提示词窄清理复核（2026-10-21）

### Scope 与行为锁

本轮只检查 `server/src/ai/prompts.ts` 的 qa-v3 新增分类规则与版本元数据。保持已批准的闭合细节 `unknown` / 已知偏题 `irrelevant` 边界、`negativeExamples` 与句子真值分离、直接事实/逻辑蕴含但不补外部条件、A/B 单项充分性或必要性不从共同行动推出，以及多项事实均明确为真时可统一回答 `yes`。证据、JSON、非 `yes` 空候选、hidden-content、因果表达规则及 `hint-v1` 不在本轮变更范围。

### Cleanup 结果

- 复核 qa-v3 新增文字未发现确证歧义、重复规则或与保留边界冲突；`QA_PROMPT_VERSION` 为 `qa-v3`，系统提示词展示该版本，问答 user payload 继续通过同一常量携带版本元数据。
- 未修改提示词、测试或实现；只追加本报告。未增加镜像字符串测试、未访问 `.env`、未调用真实模型。

### Quality Gates

- 独立复审：主控报告 gpt-6.1/max 窄复审通过，未发现 P0/P1/P2。
- 完整测试：主控报告 `npm test` 47/47 通过；本代理未重复运行。
- Build：主控仍待运行，本报告不声明通过。
- 真实回归评测：主控报告 30 条 regression 运行仍在进行；本报告不将其记为通过，结果待后续记录。
- 本轮没有代码改动，因此未重复执行 typecheck 或测试。

### Changed Files

- `docs/CLEANUP_REPORT.md`：追加本轮 qa-v3 窄清理结论。
- 源代码和测试无变更。

## Follow-up：qa-v5 最终窄清理复核（2026-10-21）

### Scope 与行为锁

只复核 `server/src/ai/prompts.ts` 的 qa-v5 新增 few-shot、分类说明和 `QA_PROMPT_VERSION` 元数据。保留版本常量 `qa-v5`，系统提示词和问答 user payload 都继续引用该常量。保留 v5 的三个判定输出、示例与当前 `trustedStory` 隔离，以及主持人只消解唯一指代、事实仍以故事为依据且不作为玩家线索证据的规则。

### Cleanup 结果

- 没有发现需要改动 qa-v5 语义或元数据的其他确证问题；本轮不改提示词或测试，只追加本报告。
- 记录一个已知 P3 措辞项并延期：提示词称“以下是三个独立微故事”，实际是一个独立微故事提供事实、三条例子共用该事实。依主控要求保持 qa-v5 原文以保留当前评测追踪性，留待未来版本处理。
- 本轮未调用模型、未访问 `.env`，也未重复无关验证。

### Quality Gates 与评测证据

- 窄复审：主控报告 gpt-6.1/max 已审阅实际 qa-v5 diff 并批准。
- Regression：主控报告 qa-v5 真实 30 条回归为 30/30；该结果由主控报告，本代理未执行。
- Holdout：主控报告首轮为 4/5，C01 因上下文因果理解失败；仍有一条未匹配，不记为通过或已解决。
- 完整测试与 build：主控计划在本次文档追加后运行 `npm test` 与 build；本代理不声明本轮已通过，也未重跑。

### Changed Files

- `docs/CLEANUP_REPORT.md`：追加 qa-v5 最终窄清理记录。
- 源代码和测试无变更。
