# 后端实现与集成接口

后端入口是 `server/src/index.ts`。`server/src/app.ts` 提供可注入 AI 的 Express 应用，`server/src/content.ts` 校验并加载全部服务端题库，`server/src/game.ts` 管理内存会话、revision、幂等记录和提示进度。API 不向客户端返回隐藏线索定义或内部候选证据。构建后 `index.ts` 仅将 `web/dist` 传给 `createApp` 的 `staticWebDir`；API 路由先于静态文件路由注册。

## 启动与配置

在项目根目录执行 `npm run dev:server`；`npm run dev` 会同时启动 API 与 Vite 客户端，Vite 将 `/api` 代理到 `8787`。生产流程先 `npm run build`，再 `npm start`；生产 Node 服务在同一端口提供 API 与 `web/dist`。后端默认监听 `0.0.0.0:8787`，可通过 `HOST` 和 `PORT` 配置。

服务端 AI 环境变量：

| 变量 | 用途 |
|---|---|
| `AI_BASE_URL` | OpenAI 兼容 API base URL；当前百炼北京示例为 workspace 占位 URL，DeepSeek 可替换为 `https://api.deepseek.com` |
| `AI_MODEL` | 当前百炼 profile 使用精确 ID `qwen3.8-flash`；GLM 替代 profile 使用精确 ID `ZHIPU/GLM-5.3-Flash` |
| `AI_API_KEY` | 服务端密钥；不要放入 Web 环境变量或客户端构建 |
| `AI_THINKING` | 可选 `enabled` 或 `disabled`；Qwen 未设置或 `disabled` 时关闭推理，`enabled` 时发送 `reasoning_effort: "low"`；GLM profile 不支持 `disabled`，未设置或 `enabled` 均启用推理；DeepSeek profile 使用其 `thinking` 参数；通用兼容端点不发送 provider 专属字段 |
| `CLIENT_ORIGINS` | 可选逗号分隔的精确来源白名单，不支持 `*` 或 cookie 凭证 |

全部三项 AI 必需配置齐全时，`GET /api/health` 返回 `ai.configured: true`。这只代表配置齐全，不探测供应商，也不代表判题质量通过。当前百炼 profile 要求 HTTPS 北京 workspace 域名、`/compatible-mode/v1` 路径和精确模型 ID `qwen3.8-flash` 同时匹配。未设置 `AI_THINKING` 或设为 `disabled` 时发送 `enable_thinking: false` 和默认 `max_completion_tokens: 2048`，不发送 `max_tokens`、`reasoning_effort` 或 `thinking_budget`；只有显式设为 `enabled` 才发送 `enable_thinking: true` 与 `reasoning_effort: "low"`。适配器选项 `maxTokens` 对此 profile 映射为 `max_completion_tokens`。GLM profile 使用精确模型 ID `ZHIPU/GLM-5.3-Flash`，发送 `enable_thinking: true`、`reasoning_effort: "low"` 与 `max_tokens: 8192`；`AI_THINKING=disabled` 会在本地拒绝。DeepSeek hostname 精确为 `api.deepseek.com` 时使用 `thinking: { type: "disabled" }` 默认值，`AI_THINKING` 可覆盖；GLM 与 Qwen 参数不会发送到 DeepSeek。其他兼容端点继续使用 `max_tokens: 2048`，不接收上述 provider 专属参数。所有 profile 都要求 `response_format: { type: "json_object" }`，没有跨供应商回退。Qwen 推理档位与 token 预算、GLM low 与 8192 是工程配置候选，不代表已验证的最优设置或模型质量。无 key 时保留硬状态，不会调用 mock、关键词规则或内置正例。后端请求 deadline 保持 30 秒；客户端等待边界为 40 秒。

未设置 `CLIENT_ORIGINS` 时只允许本机 Vite `localhost:5173` / `127.0.0.1:5173` 和 Capacitor 的 `capacitor://localhost`、`http://localhost`、`https://localhost`。Web 开发代理走同源 `/api`；Android/原生 WebView 可按部署地址显式配置来源。CORS 仅允许 GET/POST、OPTIONS、Authorization 与 Content-Type，不启用 cookie。

## 问答提示词契约

当前问答提示词版本为 `qa-v2`，提示版本仍为 `hint-v1`。问答模型只返回 JSON；`clueCandidates` 每项使用 `clueId` 和非空 `evidence` 数组，证据项使用 `messageId`、`quote`。`clueId` 必须逐字取自输入中的 `trustedStory.clues[].id`，不能改成 `id` 或别名；每项至少包含当前玩家消息的证据，`messageId` 原样复制 `currentMessage.id`。可按需引用已提交历史中的玩家消息。`quote` 必须是对应玩家正文中逐字复制的连续子串。提示词里的示例值仅说明结构，模型必须以实际输入值替换。非 `yes` 判断仍须返回空候选数组；运行时结构及证据校验保持独立执行。

## HTTP 路由

| 路由 | 行为 |
|---|---|
| `GET /api/health` | 返回进程状态与 AI 配置是否齐全 |
| `GET /api/puzzles` | 返回公开题目投影与必需线索总数 |
| `POST /api/sessions` | 创建新的临时局并一次性返回 bearer token |
| `GET /api/sessions/:id` | 使用 bearer token 获取本局公开快照 |
| `POST /api/sessions/:id/questions` | 调用问答适配器，校验玩家证据后原子提交 |
| `POST /api/sessions/:id/hints` | 生成最多三次的递进提示，不更新已发现线索 |
| `POST /api/sessions/:id/reveal` | 仅在 `unlocked` 时查看汤底并变为 `completed` |
| `POST /api/sessions/:id/give-up` | 放弃当前 `playing` 局并返回汤底 |
| `POST /api/sessions/:id/leave` | 结束本局、移除汤底并取消等待中的模型操作 |

局内 POST 使用 UUID `requestId` 和安全非负整数 `expectedRevision`。成功响应缓存支持同意图重放；失败不改 revision、消息、线索或提示次数。问题最多 500 个 Unicode 字符；请求体限制为 8 KB。会话 token 以 SHA-256 摘要保存，默认空闲 60 分钟后清除。`index.ts` 每分钟触发一次清理。

## TypeScript 集成接口

评测执行器可以直接复用题库、适配器与验证器，不需要增加产品 HTTP 状态注入接口。

```ts
import { createApp } from '../server/src/app.js';
import { loadPuzzles } from '../server/src/content.js';
import { createOpenAiCompatibleAdapterFromEnv } from '../server/src/ai/openai-compatible.js';
import type { AiAdapter, HintModelInput, QuestionModelInput } from '../server/src/ai/types.js';
import {
  validateHintModelResult,
  validateQuestionModelResult,
} from '../server/src/ai/validation.js';

const puzzles = await loadPuzzles();
const ai: AiAdapter = createOpenAiCompatibleAdapterFromEnv();
const app = createApp({ puzzles, ai });
```

导出接口：

| 导出 | 路径 | 说明 |
|---|---|---|
| `createApp(options): Express` | `server/src/app.ts` | 依赖注入式 HTTP app；不监听端口 |
| `CreateAppOptions` | `server/src/app.ts` | `puzzles`、`ai`，及可选会话 TTL、限流、CORS 来源、`staticWebDir` 和时钟 |
| `loadPuzzles(directory?)` | `server/src/content.ts` | 校验并读取目录下所有 JSON 题库 |
| `parsePuzzleDefinition(value)` | `server/src/content.ts` | 严格结构、唯一 ID、事实/因果引用和提示角度校验 |
| `AiAdapter` | `server/src/ai/types.ts` | `configured`、`answerQuestion(input,{signal})`、`createHint(input,{signal})` |
| `QuestionModelInput` | `server/src/ai/types.ts` | 隐藏题目、提交历史、已发现 ID 和暂存当前玩家消息 |
| `HintModelInput` | `server/src/ai/types.ts` | 隐藏题目、历史、未发现线索、可用方向及既有提示 |
| `createOpenAiCompatibleAdapter(config, options?)` | `server/src/ai/openai-compatible.ts` | 构造可配置的真实兼容 API 适配器；缺配置时仍可启动，调用返回 `AI_NOT_CONFIGURED` |
| `createOpenAiCompatibleAdapterFromEnv(env?, options?)` | `server/src/ai/openai-compatible.ts` | 从 `AI_BASE_URL`、`AI_MODEL`、`AI_API_KEY`、`AI_THINKING` 创建适配器；按精确北京 Qwen/GLM profile 或 DeepSeek origin 添加各自参数 |
| `validateQuestionModelResult(value,puzzle,current,history)` | `server/src/ai/validation.ts` | 严格校验结构、已知候选 ID、候选唯一性与玩家原文证据 |
| `validateHintModelResult(value,availableAngles,discoveredClueIds)` | `server/src/ai/validation.ts` | 校验未发现线索、可用提示角度和 1–120 字符文本 |

`AiAdapter` 是后端问答/提示的唯一模型边界。测试可以显式注入明确标记的替身来检验程序状态行为；替身不证明真实模型语义质量。问答结构验证不能证明候选线索的自然语言语义正确，提示校验也不能完全判定自然语言剧透，真实首题评测仍需记录真实模型、内容版本和提示词版本。

## 验证

服务端 API 与适配器用例：

```powershell
npx vitest run tests/server/app.test.ts
```

用例覆盖隐藏字段投影、未齐线索不得解锁、完整线索先解锁再 reveal、放弃与离开、重复命中、玩家证据来源、非法候选整体回滚、失败重试、同请求重放与冲突、提示上限、并发、取消后的迟到响应、未配置硬状态、CORS 白名单、静态目录边界、DeepSeek/GLM/Qwen/通用兼容端点参数隔离、GLM 禁用推理时本地拒绝、Qwen 推理开关与 `max_completion_tokens` 映射、profile host/path/model 边界、JSON 输出与响应体读取超时，以及超时后状态不结算。测试中的 adapter 使用受控 fetch，不用于证明 AI 质量。
