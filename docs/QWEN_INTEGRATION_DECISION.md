# Qwen3.8-Flash 最小接入决策

日期：2026-10-20。决策代理：gpt-6.1-sol / max。仅核官方资料并写本文档，未修改实现、读取 `.env` 或发送真实请求。实际工作空间 ID 与密钥不记录在此。

## 结论与当前证据

按用户新指令，在同一已授权的百炼北京工作空间试用精确模型 `qwen3.8-flash`。不套用 GLM profile，也不删除 GLM 支持。主控已采纳的最小产品基线：**顶层 `enable_thinking:false`、`max_completion_tokens:2048`、同步 JSON object，保持后端 30 秒/客户端 40 秒。**

主控报告：同 Host 的 GET `/models` 为 200，精确模型可见；一次最小 JSON 聊天诊断实际返回 200、`finish_reason=stop`、有效内容 `{"ok":true}`，usage 为输入 69、输出 51、合计 120 tokens。该请求只发送 model/messages、`max_tokens:2048` 与 JSON object，尚未发送本决策的新 profile 参数。因此它证明本账户可调用该模型，不能证明新参数组合、首题判题、证据提取或提示效果通过。之后先做三条真实回归 smoke，再按固定用例评测；本代理不重复诊断。

## 官方 OpenAI 兼容接口核查

当前官方资料与“3.8 Flash 只能推理”的先前印象不同：深度思考支持列表明确将 `qwen3.8-flash` 列为混合模型，默认启用推理，可关闭；商业 Qwen-Flash 支持完整同步响应。不要把其他模型的 only-thinking 限制或 DashScope 示例结构移植到本接口。[深度思考支持列表与同步调用 FAQ](https://www.alibabacloud.com/help/en/model-studio/deep-thinking)。

| 项目 | 当前 OpenAI Chat 定义 |
|---|---|
| 地址与消息 | 北京工作空间 `/compatible-mode/v1/chat/completions`，model 为 `qwen3.8-flash`；继续 system/user 字符串消息。 |
| 推理开关 | HTTP JSON 顶层 `enable_thinking` 可为 true/false；直接 HTTP 不包 `extra_body`。SDK 示例的 extra_body 是 SDK 参数承载方式。 |
| 推理档位 | `low`、`medium`、`xhigh`，默认 xhigh；兼容映射为 minimal→low、high/max→xhigh、none→关闭。 |
| 预算冲突 | reasoning_effort 与 thinking_budget 不能同时发送。low/medium/xhigh 对应的思考预算分别为 4096/16384/262144；它们不表示必须消耗这么多 tokens。 |
| 旧上限 | 对本 Qwen 模型，max_tokens 只限最终答案，不含推理，且官方标记将废弃。现有 generic 的 2048 因此不能描述为总输出上限。 |
| 新上限 | max_completion_tokens 限推理与答案合计，Qwen Flash 3.5 及后续受支持；文档允许实际计数存在最多约 10 tokens 的差异，不应称为精确费用硬上限。 |

以上使用当前 [OpenAI 兼容 Chat 参数文档](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)，不是 DashScope `/api/v1` 请求协议。

Qwen3.8-Flash 官方支持 JSON object 和 JSON Schema。最小接入继续 `response_format:{type:'json_object'}`，提示中明确要求 JSON；不在本轮改用供应商 JSON Schema。JSON object 不保证字段、类型或语义，现有本地严格校验仍是必要条件。[结构化输出支持列表与模式说明](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output)。

## 最小实现差异

现有 generic 分支只发送 `max_tokens:2048`，没有 Qwen 开关；单换 model 会保留供应商默认推理档位。后端写入者按主控分工做以下小改动即可，不增加 SDK 或模型框架：

1. 只对已确认的 HTTPS 北京工作空间主机后缀、兼容 API 路径和精确 `qwen3.8-flash` 选择此 profile。目的地仍取用户配置，禁止自动跨 Host、地域或供应商回退。
2. 此 profile 默认将 `AI_THINKING` 解释为 disabled，发送 `enable_thinking:false` 与 `max_completion_tokens:2048`，不同时发送 max_tokens、thinking 对象、reasoning_effort 或 thinking_budget。
3. 若显式配置 enabled，发送 `enable_thinking:true` 与 `reasoning_effort:'low'`，不发送 thinking_budget。该可选分支需独立评测；2048 的总预算在推理启用后可能截断，不能靠解析推理内容或自动放大预算补救。它不改变本轮 disabled 的验收基线。
4. 同步请求可显式 `stream:false`，不发送 stream_options。维持现有 content 读取、JSON 与业务结构验证、玩家证据约束。reasoning_content 不保存为玩家证据，不拼接入最终答案；当前请求只有 system/user 封装的游戏上下文，不引入供应商助手思考历史回放。
5. GLM 的 enabled-only 与既有预算、DeepSeek 的 thinking 写法、其他 generic 默认行为保持独立。只在 Qwen profile 切换 token 字段，避免把它推广到不支持 max_completion_tokens 的第三方直供线路。

## 验证与交付边界

先用注入 fetch 核对 Qwen 默认关闭/显式 enabled 的请求体、总预算字段排他、错误主机或模型不误用参数，以及 GLM/DeepSeek 回归。继续保留空 content、length、非法 JSON、超时与主动取消失败不结算、不扣提示、同 ID 重试约束。

主控再通过用户已授权 Host 做三条真实回归 smoke；报告记录实际 mode、预算、finish_reason、usage 与耗时，随后才判断是否进入完整首题评测。30 秒超时是产品可用性边界，不是模型语义错误；官方支持某参数也不代替本线路实际成功响应。

GLM 未激活的阻点保留在其自身记录。Qwen 模型验证与已授权工程交付可独立推进：主控报告 Android assembleDebug 已成功，Web 构建与用户最新指定的公开仓库冻结上传按各自验证清单继续；公开上传前由主控完成实际提交清单与密钥扫描。它们不代表首题真实 AI 语义、APK 安装或真机联网已经通过。

## 实现后的独立窄审

2026-10-20，gpt-6.1-sol / max 只读核对适配器、新增测试、示例配置及 README。**代码审查通过，无新增 P0/P1/P2 问题，可进入有界清理与主控最终验证。** 本次未读取本地 `.env`、修改实现、重复真实探针或重跑完整测试。

- `server/src/ai/openai-compatible.ts:20-44` 复用北京 HTTPS 主机与路径识别，再以精确模型分别选择 Qwen/GLM，未把 Qwen 配置泛化到其他模型或地域。
- `:65-77,117-126` 对 Qwen 使用互斥的 max_completion_tokens；未配置或 disabled 时明确关闭推理且不发送 effort；enabled 时只发送 low。两个分支均不发送 thinking_budget 或 thinking 对象，options.maxTokens 覆盖映射到正确预算字段。30 秒与错误处理没有更改。
- GLM 仍为 8192/启用推理/low、禁用时本地拒绝；DeepSeek 与 generic 仍使用原有 max_tokens 和各自参数。同步调用沿用官方 stream 默认 false，符合本决策“可显式”的约定，无需为此另改代码。
- `tests/server/app.test.ts:565-650` 新增 7 个测试实例，覆盖默认关闭、显式关闭、启用 low、预算覆盖，以及其他地域、错误路径、近似模型名、HTTP 四种不命中条件；明确断言 token 字段与供应商参数的排他性。`:652-795` 保留 GLM、DeepSeek、空内容、响应体超时与截断回归。新增测试覆盖所改分支，未发现通过削弱既有断言取得通过的情况。
- `.env.example:2-19` 与 `README.md:13` 已同步 Qwen 默认 disabled，并保留 GLM/DeepSeek 的显式配置说明与安全占位符。

后端作者报告 server 总计 29/29 与 typecheck 通过；本代理没有把它写成独立重跑证据。主控计划全量 47 项并正在执行三条真实 Qwen 回归 smoke，这些后续结果按主控执行记录落盘，不在本次代码放行中预先宣称通过。显式 enabled 的预算/质量仍需单独实测；本轮验收基线继续 disabled + 总输出 2048。

## qa-v2 契约补全与 smoke 留痕复审

2026-10-20，在后端宣布文件稳定后完成只读窄审，**本次修复放行，无新增 P0/P1/P2**。本代理未外联、修改实现或重复完整测试。

主控对旧 P01 的真实诊断为：模型返回候选字段 id，现有 Zod 因缺少 clueId 且出现未知 id 字段拒绝。这是此前提示没有完整写出候选外层结构的契约缺口，不作为修改题目、expected 或放宽验证器的理由。

`server/src/ai/prompts.ts:3,17-22` 将问答版本升为 qa-v2，补充完整的 `clueCandidates:[{clueId,evidence:[{messageId,quote}]}]` 示例，明确真实 clueId 来源、至少一条 currentMessage.id 证据及连续原文 quote。示例使用通用占位值并要求替换，没有首题故事内容、正确命题或固定答案。否定问句、unknown、rephrase、因果不得自动推导等原有规则继续保留；hint-v1 未变。新说明与 `server/src/ai/validation.ts:8-17,33-77` 的严格字段、非空证据、玩家来源和当前消息要求一致，没有把 id 当作别名自动接收，也没有更改程序结算或公开视图。隐藏故事仍只用于后端模型输入，新增提示不要求将其输出给玩家。

`artifacts/qa/model-smoke.mjs:52-79` 先用时间戳路径与 `flag:'wx'` 写不可覆盖的历史报告，重名时递增后缀，成功后才更新 Qwen latest 快照；`:209-229,246-263` 保存每例 prompt/content 版本、结果与脱敏观测，只有三条全部 matched 才 passed，否则退出码 1。外层异常同样退出 1。配置、模型与三次请求限制没有增加自动重试、端点探测或跨供应商回退。

本代理只读检查了已落盘报告：

- `artifacts/qa/qwen-smoke-20261020T074700345Z.json` 保留旧失败：2 matched、1 error。该旧格式没有 prompt/content 版本字段，不追溯伪造；它仍作为旧失败原始记录保留。
- `artifacts/qa/qwen-smoke-20261020T101307083Z.json` 记录本次 3 matched、0 mismatch、0 error；P01/P03 为 qa-v2，H01 为 hint-v1，三例 contentVersion 均为 1.0.0。

后者是主控真实执行后由本代理核对报告得到的三条 regression smoke 证据，不是本代理重跑模型，也不是完整首题语义、稳定性、提示剧透人工检查或第二题迁移通过。全量 47 项工程验证、最终清理与实际提交密钥扫描由主控继续完成，按既有用户授权上传，不增加新审批要求。
