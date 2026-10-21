# GLM-5.3-Flash 最小接入决策

日期：2026-10-20。仅基于官方资料与现有适配器的只读审查。本代理没有读取密钥、没有发送真实模型请求、没有修改实现。文档不记录实际工作空间 ID。

## 结论

使用用户已明确给出的**百炼北京工作空间专属 OpenAI 兼容端点**，模型路由为 `ZHIPU/GLM-5.3-Flash`。这是官方目录和接口支持的正确候选组合；用户账户的开通、余额、权限及该线路实际可用性，仍须由主控向唯一已确认 Host 做有限探针确认。不能把同一把密钥拿去试 Z.AI、DeepSeek 或其他地域。

最小产品基线：GLM 专属配置使用 `enable_thinking:true`、`reasoning_effort:'low'`、`max_tokens:8192` 和现有 `response_format:{type:'json_object'}`；保持非流式完整 JSON 解析、后端 30 秒/客户端 40 秒的现有配对边界。8192 和 low 是待实测的工程候选，不是已验证的最优值，也不改变用户指定开发代理的 max。

## 官方支持与供应商差异

| 项目 | Z.AI 官方直连 | 本次百炼北京直供线路 |
|---|---|---|
| 模型 ID | `glm-5.3-flash` | `ZHIPU/GLM-5.3-Flash`，大小写与前缀按官方目录填写 |
| Base URL | `https://api.z.ai/api/paas/v4`，属于另一个供应商凭证域 | `https://{workspace}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`；仅为脱敏模板，实际值由主控保存本地 |
| thinking | 只允许 enabled，不能 disabled | 同样不能关闭；可用 `enable_thinking:true`，专门 GLM 文档亦接受 `thinking.type=enabled`。本项目只选前一种，避免同时发送两种写法 |
| 推理档位 | 支持 low/high/max，默认 max | 支持 low/high/max，默认 max |
| JSON | 模型支持结构化输出，通用 JSON 模式为 json_object | Flash 模型页列为支持结构化输出，兼容 API 提供 json_object |

Z.AI 的模型页、API 参考分别说明原生模型名、thinking 限制、推理档位及接口字段；通用端点使用 Z.AI 自己的 Bearer 凭证。[Z.AI 模型说明](https://docs.z.ai/guides/vlm/glm-5.3-flash)、[API 参考](https://docs.z.ai/api-reference/llm/chat-completion)、[端点说明](https://docs.z.ai/api-reference/introduction)。

百炼的专门 GLM-ZHIPU 指南直接使用北京工作空间专属域示例调用 Flash，注明其文本参数与 ZHIPU/GLM-5.3 相同；模型页列出了北京地区支持。该组合在文档层面适用，不能据此推定当前账户必然可调用。[GLM-ZHIPU 接入指南](https://help.aliyun.com/en/model-studio/glm-zhipu)、[Flash 模型页](https://help.aliyun.com/en/model-studio/glm-5-3-flash-by-zhipu)。

密钥格式只能提供发行方线索，不能确定地域、工作空间或模型权限；本次配置依据用户截图明确的端点。官方说明各地域的端点、密钥和模型列表不能跨地域通用。[百炼密钥与地域说明](https://www.alibabacloud.com/help/en/model-studio/get-api-key)。

## 现有适配器评估

已读 `server/src/ai/openai-compatible.ts`：

- Base URL 去尾斜线后拼接 `/chat/completions`，可保留工作空间域与 `/compatible-mode/v1` 路径；Bearer、system/user messages、同步 JSON 响应形状均可复用，无须引入 SDK 或先改写 SSE。
- 当前只对 `api.deepseek.com` 发送 thinking 对象，因此不会自动把 DeepSeek 的 disabled 发到百炼。但 `AI_THINKING` 在百炼线路会被忽略，且未发送 reasoning_effort，模型将保留其供应商默认推理档位；这不能冒充已关闭推理。
- 当前默认 maxTokens=2048、timeoutMs=30000，环境工厂尚未消费推理档位或 token 预算配置。不能只换 Base URL/model 后把原基线当作已验证的 GLM 基线。
- 已有空 content、finish_reason=length、非法 JSON、严格业务结构与玩家证据校验、超时/主动取消、失败不结算逻辑继续保留。只使用 message.content，不把 reasoning_content 当成答案或玩家证据。

JSON 模式只约束序列化，不保证字段正确或海龟汤判断正确。继续用现有本地 schema 验证；本轮不升级供应商侧 json_schema，以减少未经验证的参数组合。[Z.AI JSON 模式](https://docs.z.ai/guides/capabilities/struct-output)、[百炼兼容 API](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions)。

## 预算与时间边界

**2048 风险是推论，尚未实测。** 模型始终推理且默认档位为 max，小的输出上限可能在最终 JSON 完整生成前截断；不能将空 content 或 length 强行解析为有效游戏结果。候选改为 low + 8192，给推理与结构化结果留出余量，同时保持明确上限参数。

**不能把 8192 宣称为所有线路相同的总成本硬上限。** 百炼通用参数文档将 glm-5.3 的 max_tokens 描述为推理与答案合计，而其他模型的计数另有说明；它又将第三方直供模型排除在 max_completion_tokens 的通用支持列表之外。Flash 专门指南说明其文本参数沿用同系列，但精确线路的预算计数仍应记录 usage/finish_reason 核对。因此本次保守发送已有 max_tokens，不盲切 max_completion_tokens，不发送未确认的 thinking_budget；先测实际是否截断及用量，再固定预算语义。[百炼 token 参数](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions)。

30 秒是当前产品超时策略，不是供应商响应承诺。先保留它做有界可用性探针；超时记为 AI_TIMEOUT/可用性失败，不能记为模型语义错误、模型不支持或通过。若有效小样本反复超时，再依据耗时分布决定是否同时调整服务端与客户端边界；不单独延长后端到超过客户端等待，也不自动无限放大预算。供应商默认推理档位与平台允许的最长等待都不能替代本产品自己的边界。

## 最小实施清单

由主控另分配后端写入者实施，本代理不改代码：

1. 按已确认供应商/Host 与精确模型识别 GLM profile，不根据密钥内容猜路由，不增加跨供应商或跨地域自动回退。端点仍来自本地 AI_BASE_URL。
2. 百炼该 profile 显式发送 `enable_thinking:true` 与 `reasoning_effort:'low'`，不发送 DeepSeek 的 disabled，也不同时发两个 thinking 开关。为 GLM 配置 disabled 时本地明确拒绝，避免静默无效。
3. 可增加 `AI_REASONING_EFFORT`（GLM 仅 low/high/max）和 `AI_MAX_TOKENS` 的严格配置解析，默认分别为 low、8192；测试注入 options 的覆盖规则保持明确。其他供应商保持原有默认，不把 GLM 参数广泛注入所有兼容接口。
4. 保留 JSON 提示、结构与证据校验以及失败原子性。模型只返回 reasoning_content、最终 content 为空时仍失败；不能从推理文本找 JSON 补救。
5. 评测记录供应商、地域、精确模型、reasoning_effort、预算、timeout、prompt/content 版本、finish_reason 及可获取 usage；报告无需记录实际 workspace ID、完整 Host 或任何密钥。只凭模型自称支持、身份介绍或 HTTP 200 不算游戏能力通过。

先用注入 fetch 的测试验证北京 profile 请求体、不同供应商参数隔离、禁用推理的本地拒绝，以及空/截断/非法结构无结算；主控再向用户已确认的唯一端点执行有限真实连通性与模型可用性检查，通过后才运行固定语义用例。连接可用、JSON 可解析、语义达标是三个不同结论。
