# 独立工程初审

日期：2026-10-20。依据 `CONTRACTS.md`。只读审查了 server、Web 源码、Vite 配置、首题、修订后的 35 条用例、评测运行器与现有测试；本代理只写此报告，没有修改实现。作者同时继续修订，以下行号对应本次读到的快照，符号名可用于后续定位。

结论：没有发现 P0。发现两项 P1，其中 Vite 隐藏内容访问已修复并独立复验；评测禁词结算与四项 P2 已通知总控和相应作者修正，初审暂不作全通过结论。本轮不需要真实 AI 即可确认这些工程问题；真实语义质量、性能和 Android 仍是分别记录的未验证项。

## P1

### R01：开发服务器可直接返回隐藏题库和服务端文件——已修复并复验

初始 `web/vite.config.ts` 未设置文件访问边界且监听所有地址。实际 GET 下列路径均返回 200：

- `/@fs/D:/下载/ai-turtle-soup/content/puzzles/beyond-the-dome.json`，响应包含 solution。
- `/@fs/D:/下载/ai-turtle-soup/server/src/ai/prompts.ts?raw`，响应包含服务端提示源。
- `/@fs/D:/下载/ai-turtle-soup/eval/cases/beyond-the-dome.json`，响应包含 expected 标注。

环境作者已在 [web/vite.config.ts](/D:/下载/ai-turtle-soup/web/vite.config.ts:27) 设置回环监听、strict fs、Web/依赖白名单及私有目录拒绝列表。本代理再次实际请求，题库、题库 `?raw`、服务端 `?raw`、评测用例均 403 且未含隐藏内容；`/`、`/src/main.tsx`、`/api/puzzles` 仍为 200。该项已闭合。后续回归应同时覆盖普通和 `?raw` 路径，不能仅检查 API 返回体。

### R02：明确命中禁词仍被评测标为 matched——待修复

位置：[eval/run.ts](/D:/下载/ai-turtle-soup/eval/run.ts:333)，`executeCase` 返回的 outcome。

代码已算出 forbiddenTextFindings，但 outcome 只依赖 judgment、线索、状态和提示次数匹配。纯替身实测返回：`outcome='matched'`，同时 forbiddenTextFindings 非空。主程序只检查 outcome，因此这种已明确检测到的泄露可得到成功退出码。

修复：只有 expected 匹配且 forbiddenTextFindings 为空才 matched；命中禁词应 mismatch，并保留具体命中记录。增加一个结构完全合法、计数和状态均匹配但 hint 文本命中禁词的测试。人工泄露检查仍保留，不能被字符串检查替代。

## P2

### R03：失败后同一 requestId 可以换 payload 再提交——待修复

位置：[server/src/app.ts](/D:/下载/ai-turtle-soup/server/src/app.ts:95) 的 `idempotencyLookup`，以及 [server/src/game.ts](/D:/下载/ai-turtle-soup/server/src/game.ts:155) 的 `settlePending`。

当前只保留 success 和 pending 的指纹；失败释放 pending 后，requestId 的原指纹随之消失。临时本机 HTTP 服务配合测试替身实际复现：第一次同 ID 问题 A 返回 503 AI_UNAVAILABLE，第二次保持该 ID/revision 却换成问题 B，返回 200、revision=1，并再次调用适配器。契约要求相同 ID 的不同 payload 返回 REQUEST_ID_REUSED。

修复：独立保存已接受动作的 requestId → fingerprint，失败释放占用但保留指纹；同 payload 可以重新执行，不缓存失败为成功。测试同时覆盖失败后同 payload 可重试、不同 payload 被拒绝、成功重放不重复调用。

### R04：收到响应头后读取 body 超时被归为非法输出——待修复

位置：[server/src/ai/openai-compatible.ts](/D:/下载/ai-turtle-soup/server/src/ai/openai-compatible.ts:98) 的 `response.json()` catch。

超时分类只在 fetch 等待响应头的 catch 中处理。响应头先到、body 仍在读取时，deadline 触发 abort 被 JSON catch 统一映射为 INVALID_MODEL_OUTPUT。使用 timeoutMs=10 且 body 等待 abort 的替身已实际复现，输出 code 为 INVALID_MODEL_OUTPUT。

修复：body 读取 catch 同样先检查 timedOut；deadline 应 AI_TIMEOUT，普通无效 JSON 才 INVALID_MODEL_OUTPUT。保持终结取消的会话屏障，不能因分类变化提交旧结果。补响应头前超时、响应头后超时、非超时非法 JSON 三项测试。

### R05：浏览器 API 没有自己的网络 deadline——待修复

位置：[web/src/api.ts](/D:/下载/ai-turtle-soup/web/src/api.ts:83) 的各 fetch 方法；界面等待在 [web/src/App.tsx](/D:/下载/ai-turtle-soup/web/src/App.tsx:330)。

调用只接受页面主动取消 signal，没有网络 deadline。请求到不了后端，或健康、题库、校准连接长时间不完成时，后端的 30 秒模型 timeout 无法结束浏览器等待；开始按钮或问答区可能持续处于 busy，无法进入既有重试路径。

修复：统一给客户端请求加有界 deadline，例如 40 秒，并与调用方主动取消合并。客户端超时代表结果未知，应进入现有网络失败的校准/同 ID 重放分支，不能伪造服务端 AI_TIMEOUT 并断言“未扣次”。离开引发的主动 abort 仍静默丢弃。用受控永不完成请求验证 busy 清理、输入保留、requestId 保留及迟到响应隔离。

### R06：Retry-After 只显示文字，没有限制立即重试——待修复

位置：[web/src/App.tsx](/D:/下载/ai-turtle-soup/web/src/App.tsx:89) 解析限流文案，以及同文件约 839 行的重试按钮；[web/src/api.ts](/D:/下载/ai-turtle-soup/web/src/api.ts:26) 已解析秒数。

当前显示“等待 N 秒”，但重试按钮仅由 pending/endingBusy 控制，可立即再次提交，未落实契约中尊重 Retry-After 的要求。

修复：记录本次重试可用时刻，在到期前禁用重试并显示剩余时间；新局或离开清理旧局 cooldown。补计时测试验证到期前不发请求、到期后保持原 ID 重试。

## 当前实现中未发现阻断的边界

- 普通 API 使用显式公开投影；viewSession 仅在 completed/given_up 返回 solution，bearer 使用随机 token 和摘要校验。
- 问答与提示在完整校验之前不写消息、线索、次数或 revision；提交阶段没有 await。成功响应缓存先于 revision/status 检查，能重放丢失的已成功结果。
- give-up/leave 同步终结并取消等待。提交前检查会话对象、操作对象、playing 状态和 revision；旧结果不能覆盖结束状态或重新创建已清理会话。
- 模型结构校验拒绝未知字段、未知/重复线索、非 yes 的候选以及非玩家原文证据；至少要求当前玩家证据，host/hint 不能充当证据。
- 客户端有 session ID、页面 generation、局内 epoch 和 revision 检查；结束后禁止 playing 快照回退，本地离开先清空旧局再尽力通知后端。
- 真实适配器设置 max_tokens=2048、30 秒调用边界、JSON 输出和 DeepSeek 域名限定 thinking 配置；空内容、截断和非法结构不产生模拟答案，普通错误不回显供应商内容或凭证。
- 首题已落实上一轮的最小标注修订，增加提示角色负例；本次读取到 35 条用例。内容一致性不等于真实模型已经命中这些预期。

## 验证证据与补测范围

总控提供的基线是后端 14 条 HTTP/适配器测试、前端 3 条快照测试及 Web 构建通过；本代理未把这些结果说成自己重新全量运行。独立执行的是开发服务器公开 URL 初始/修复复验、禁词 matched 反例、失败 ID 换 payload 反例、响应头后超时反例，均未使用真实 AI 或凭证。

现有测试已覆盖主要状态、非法证据回滚、三次提示、in-flight 合并与终结迟到。但三个 Web 测试只测试快照比较函数，没有实际驱动 App 的断网校准、同 ID 重试、结束响应丢失、Retry-After 或主动离开竞态。应针对 R02–R06 补最小回归；另补每次只缺一条必要线索仍不解锁、过期后迟到结果不提交，避免只由一条顺序通关路径推断全部集合情况。

本报告为初审，作者修复后需要重跑对应反例与受影响测试，再由总控记录闭合状态；不要求为这些工程修复先取得真实 AI 凭证。
