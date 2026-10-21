# GLM 接入与 Web 验证配置独立审查

日期：2026-10-20。审查代理：gpt-6.1-sol / max。仅写本报告，未修改实现，未读取 `.env`、真实工作空间 ID 或密钥，未发送真实 AI 请求。

## 结论

本轮窄范围代码审查通过，未发现新增、需要修复后才能冻结代码的 P0/P1/P2 问题。北京 GLM 参数选择、既有兼容路径、超时与错误处理、CI 配置符合已定最小方案。

**真实 GLM 集成与首题语义门槛仍未通过：账户产品未激活。** 主控实际执行的三条 smoke 与一次最小 JSON 诊断均返回 HTTP 400；诊断为 `invalid_parameter_error` / `invalid_request_error`，提示产品尚未激活。它们没有返回 content 或 usage。此结果不能证明聊天参数已被服务接受，也不能当作模型语义错误、超时或参数不兼容的证据。停止继续请求，待用户在北京工作空间开通后再复测；本轮不换供应商、地域、模型，不改用例预期。

## 代码与测试核对

| 核对项 | 证据与判断 |
|---|---|
| GLM profile 边界 | `server/src/ai/openai-compatible.ts:20-36` 同时检查 HTTPS、北京专属域后缀、非空主机前缀、`/compatible-mode/v1` 路径和精确模型 `ZHIPU/GLM-5.3-Flash`；兼容已带 `/chat/completions` 的配置。域后缀前导点阻止相似域尾缀匹配。该函数选择请求参数，实际目的地仍由本地 `AI_BASE_URL` 决定；不存在自动发现或跨域回退。 |
| thinking 与预算 | `:59-67` 明确拒绝非法 thinking 值及该 profile 的 disabled；默认 8192。`:101-111` 仅该 profile 发送 `enable_thinking:true`、`reasoning_effort:'low'`，保持 JSON object 模式，不同时发送第二种 thinking 写法。8192/low 是待实测基线，不能宣称已验证最优预算或总费用硬上限。 |
| 既有路径 | `:67`、`:80`、`:109-111` 保留普通兼容接口的 2048 默认，仅 DeepSeek 主机发送其 thinking 对象，其他主机不获得 GLM 私有参数。`:75` 保持已有 `/v1` 及完整 chat 路径的拼接行为。 |
| 有界与严格失败 | `:66`、`:82-90` 保留后端 30 秒且 AbortSignal 覆盖响应体读取；`:115-145` 区分超时、主动取消和无效输出，清理定时器/监听器。非 2xx 仅映射 `AI_UNAVAILABLE`，不会把供应商原文或配置公开给客户端。仅解析 `message.content`，空内容、截断、非法 JSON 仍失败，再经现有业务结构与证据校验。客户端 40 秒边界未在此补丁中更改。 |
| HTTP 原子性回归 | `tests/server/app.test.ts:534-562` 用受控 GLM 响应体阻塞触发超时，断言 HTTP 504/AI_TIMEOUT，随后读取会话仍为 revision 0、无消息、无线索。既有错误不结算、幂等、并发与放弃/离开后迟到结果回归保留。 |
| profile 回归 | `tests/server/app.test.ts:566-629` 核对精确请求体、disabled 本地拒绝、错误模型及其他主机不应用 profile；`:631-653` 断言 DeepSeek 路径、2048 与原 thinking 行为；`:656-709` 保留空内容、响应体超时、截断失败检查。未通过放宽 expected 或解析 reasoning_content 取得测试通过。 |

本代理另做了 6 项仅使用注入 fetch 的本地边界探针：北京精确配置、完整 chat 路径命中 GLM profile；HTTP、其他地域、错误路径、伪造域后缀均不注入 GLM 参数。这些检查未发网络请求。源文件中的自动化回归覆盖核心分支，本次新增路径边界由该独立探针补充观察；不扩大本轮测试框架。

主控报告补丁后的完整 `npm test` 为 40/40。本代理按分工未重复完整测试，该数字归属主控执行记录，不冒充本代理独立重跑结果。

## Web CI 与配置

`.github/workflows/verify.yml:3-41` 在 push/pull_request 上使用 Ubuntu、Node 24、`npm ci`，依次运行测试、类型检查与 Web 构建、本地评测结构校验，然后只上传 `web/dist`。权限为 `contents:read`，没有真实评测、密钥注入、发布或部署步骤。`package.json:14-25` 区分 `eval:validate` 与显式 `--live`，CI 不会因执行本地校验而调用模型。

锁文件包含 Linux 原生依赖变体，检查范围内的命令未依赖 PowerShell 或绝对 Windows 路径。所用官方引用均存在：[checkout v7](https://github.com/actions/checkout/tree/v7)、[setup-node v7](https://github.com/actions/setup-node/tree/v7)、[upload-artifact v7](https://github.com/actions/upload-artifact/tree/v7)。这是 Linux CI 配置审查；仓库尚未 push，不能记录为远端 CI 已运行通过。

`.env.example:1-15` 仅保留空 key 与工作空间 URL 占位符；`README.md:13` 要求真实配置仅放本机 `.env`，禁止进入 `VITE_` 变量。`.gitignore:3,8-12` 排除 `.omx`、本地 env 和 Android local.properties。本轮审查文件没有新增真实凭证或真实工作空间标识；这不替代主控冻结上传前对实际提交清单的核对。

## 官方资料与真实证据边界

北京模型路由及请求字段与[百炼 GLM-ZHIPU 官方指南](https://help.aliyun.com/en/model-studio/glm-zhipu)、[Flash 模型说明](https://help.aliyun.com/en/model-studio/glm-5-3-flash-by-zhipu)相符。GLM 不能关闭推理的限制亦见 [Z.AI 模型说明](https://docs.z.ai/guides/vlm/glm-5.3-flash)。官方描述用于选择候选参数，不能代替本账户的成功聊天响应。

主控报告 GET `/models` 为 200 且精确模型可见；三条 smoke 分别在 868/275/489 ms 收到 HTTP 400，随后同一用户授权 Host 的最小诊断确认产品未激活。快速错误响应不构成有效推理耗时样本。适配器公开返回 AI_UNAVAILABLE 符合错误收敛要求，不能因此把账户阻点列为已证实的参数代码缺陷。健康接口 `configured` 只表示配置字段齐备，不代表产品开通、聊天可用或语义达标。

开通后仍需依次取得有效聊天内容、验证本地结构与证据约束、运行首题固定语义/状态用例；在此之前第二题迁移门槛不变。

## Android 与交付边界

主控报告 JDK 21/SDK 36 已准备；首次 Gradle 因 `D:/下载` 非 ASCII 路径检查受阻，正在仅对单次命令加 `-Pandroid.overridePathCheck=true`。该参数属于路径兼容探测，不是 assemble 成功、APK 已生成、安装、原生联网或真机验证的证明。本轮没有审查 Android 构建结果，也未把 Web/CI 配置通过当作原生结果。

可以在完成主控清理、最终验证及提交清单核对后冻结并上传已授权的私有仓库；上传工程不消除上述账户、真实 AI 语义、远端 CI 与 Android 分层验证门槛。
