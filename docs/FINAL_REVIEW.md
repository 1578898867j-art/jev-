# 独立修复复验

日期：2026-10-20。对照 `IMPLEMENTATION_REVIEW.md` 初审问题。仅修改本报告；未修改实现、题库或用例，未使用私密凭证，未调用真实 AI。

结论：本轮代码与受控回归范围内，工程审查通过，初审 R01–R06 均已闭合。R01 沿用前轮已完成的开发服务器 403 独立复验；R02–R06 已完成代码与回归复验，R06 补验发现的 App 清局遗漏也已修复。App 层受控浏览器故障 QA 由前端执行者与总控另外记录，本代理没有冒充亲自完成该交互。工程审查通过不代表首题真实语义、第二题迁移或 Android SDK/真机门槛通过。缺少真实 AI 不是此次工程审查失败。

## 已闭合问题

| 问题 | 实质修复 | 独立证据 |
|---|---|---|
| R02：禁词命中仍 matched | [eval/run.ts](/D:/下载/ai-turtle-soup/eval/run.ts:355) 同时要求预期结构匹配、禁词命中数为零；禁词命中变为 mismatch。[exitCodeForReport](/D:/下载/ai-turtle-soup/eval/run.ts:489) 对 mismatch 返回 1。扫描范围同时包含本次主持人/提示文案、题面及已公开线索，避免只检查固定主持人短回复。 | 已检查 hint 禁词反例与新增线索 publicText 反例；两者均直接断言 mismatch，hint 反例还断言非零退出。评测 6/6 通过。 |
| R03：失败后请求指纹丢失 | [server/src/game.ts](/D:/下载/ai-turtle-soup/server/src/game.ts:45) 独立保存 requestFingerprints；[idempotencyLookup](/D:/下载/ai-turtle-soup/server/src/app.ts:97) 先校验已记录指纹，失败释放 pending 时不删除原指纹。失败结果没有被缓存成成功。 | 新增 HTTP 回归实际执行失败 → 同 ID 换文本返回 409 REQUEST_ID_REUSED → 原 payload 重试成功，且检查适配器调用次数。[测试](/D:/下载/ai-turtle-soup/tests/server/app.test.ts:386) 通过。 |
| R04：body 超时误归非法输出 | [server/src/ai/openai-compatible.ts](/D:/下载/ai-turtle-soup/server/src/ai/openai-compatible.ts:98) 在 body 读取 catch 中先检查 timedOut，再检查调用方取消，普通非法 JSON 才返回 INVALID_MODEL_OUTPUT；fetch 等待阶段采用相同区分。 | [新增测试](/D:/下载/ai-turtle-soup/tests/server/app.test.ts:563) 使用已经返回响应头、body 等待 abort 的 ReadableStream，实际触发 25ms deadline，断言 AI_TIMEOUT，通过。 |
| R05：浏览器没有网络 deadline | [web/src/api.ts](/D:/下载/ai-turtle-soup/web/src/api.ts:90) 使用统一 requestJson，40 秒 deadline 覆盖等待响应头与读取 body；显式父 signal 取消与 deadline 使用独立结果，清理 timer/listener。全部 API 方法都经过该入口。App 将 ApiRequestTimeoutError 走结果未知的校准/原 ID 重试分支，不把它改成后端 AI_TIMEOUT。 | 独立读完整调用链并实际重跑 tests/web，12/12 通过，包含永不返回 headers、永不完成 body、主动 abort、Retry-After、快照隔离。每次 HTTP deadline 是 40 秒；后续校准是另一有界请求，不能把 40 秒说成整个交互的总耗时承诺。 |
| R06：没有落实 Retry-After gate | [web/src/retry-policy.ts](/D:/下载/ai-turtle-soup/web/src/retry-policy.ts:7) 解析秒数和 HTTP 日期；App 同步 ref/state，处理函数与按钮均检查 gate，到期清除并保留原 intent/requestId。最终两条清局路径均调用 clearRetryAfter，且依赖数组完整。 | 独立读处理函数、按钮、到期 effect、clearLocalSession 与 returnToLibrary 接线；清理遗漏修复后再次实际重跑 Web 12/12 通过。App 层 429 → 离开 → 新局交互由并行浏览器 QA 单独记录，不以 helper 测试冒充。 |

本代理实际执行：

```text
node node_modules/vitest/vitest.mjs run tests/server/app.test.ts tests/eval/run.test.ts
Test Files: 2 passed
Tests: 23 passed（17 server + 6 eval）
```

测试仅使用适配器替身与临时本机 HTTP。既有成功重放、失败不结算、in-flight 合并、give-up/leave 后迟到结果隔离和受限 Web 构建目录静态服务测试也在此次服务端文件重跑中通过。本轮未另行重跑完整构建；总控/作者报告的构建结果不冒充本代理实测。

本代理另实际执行：

```text
node node_modules/vitest/vitest.mjs run tests/web
Test Files: 3 passed
Tests: 12 passed
```

## 前端最终补验与证据边界

已读 `retry-policy.ts`、`api.ts` 与 App：Retry-After 支持秒数及 HTTP 日期；以 ref 和渲染状态同步的 blockedUntil 拦截处理函数及按钮；到期清除，重试仍取原 intent/requestId。这部分合理且相关 helper/请求单测已通过。

初次补验时发现两条清局路径遗漏调用 clearRetryAfter，已通知作者修复。最终实际读到 [clearLocalSession](/D:/下载/ai-turtle-soup/web/src/App.tsx:227) 在增加 generation/epoch 后清除 cooldown；[returnToLibrary](/D:/下载/ai-turtle-soup/web/src/App.tsx:586) 同样先清 cooldown 再清旧局。clearRetryAfter 同时重置 ref 和 React state，对应 effect 会移除旧 timer，两个 callback 的依赖数组也包含它。迟到请求在记录 Retry-After 前先校验旧局 generation/epoch，不能重新挂回旧局 gate。新局仍可能收到服务端真实全局限流产生的新 429；清除旧局 UI 状态不代表绕过服务端限流。R06 代码闭合。

本代理在最终接线修改后再次实际执行 `node node_modules/vitest/vitest.mjs run tests/web`，3 个文件、12 项全部通过。本次执行的是 API/策略/快照回归与 App 静态调用链检查，没有独立操作浏览器进行 App 交互。受控浏览器故障 QA 由前端执行者并行进行，总控另补实际证据；不能用这 12 个测试冒充完整 App 交互通过。没有与作者争写源文件。

## 第二题内容制作准入建议

已快速审阅 `content/second-puzzle-draft.md`《蓝灯熄灭以后》。日常、温和，信号约定触发家长响应，与首题的操作/观看目的结构有差异，可进入内容制作准备；这不是已证明的第二题迁移。原创为项目的创作声明，本审阅不作全网同题查重结论。

制作前落实两处最小调整：

1. 汤底明确“孩子们已到门厅待接后，工作人员才熄灭蓝灯”，让家长据此知道已就绪的推理有依据，避免仅凭排练结束便自动推出孩子已到门厅。
2. 不把汤面已公开的街对面位置、走向入口动作再分别列为隐藏必要线索。建议收束为四项：约定的灭灯信号；孩子实际在门厅待接；家长的接孩子目的；理解信号所以前来接孩子的触发因果。灯独立于照明的设定作为背景支持，不必单独增加必猜项。

事实与信号因果仍分开计分；cause 引用是故事关系索引，不能由已知事实集合自动补齐因果或其他线索。建议已通知主控和内容执行者。第一题真实 AI 门槛仍未通过时，第二题只进行内容与人工用例准备。

## 收尾清理窄复审

已核对 `CLEANUP_REPORT.md` 与服务端测试的类型清理：callJson 的默认/显式 any 被共享响应类型和窄类型替换，原状态、错误码、调用次数、公开边界、失败回滚及终结后不提交等断言仍保留；汤底和末条消息改为可选访问后，缺值仍会令相应断言失败，未发现削弱测试或扩大实现范围，README 补充属于交付说明；本轮按总控要求不重复跑测试/构建，清理后的完整验收由总控另记。
