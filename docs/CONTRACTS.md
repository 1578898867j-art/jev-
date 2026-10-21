# AI 海龟汤跨模块契约

日期：2026-10-20。版本：v1。共享类型唯一源：`packages/shared/src/contracts.ts`，由总控分配单一写入者。本文件定义内容、服务端、Web、测试使用的同一字段；字段变动须先通知所有消费者。

## 1. 共享类型

```ts
export type ClueKind = 'fact' | 'cause';
export type Judgment = 'yes' | 'no' | 'irrelevant' | 'unknown' | 'rephrase';
export type SessionStatus = 'playing' | 'unlocked' | 'completed' | 'given_up' | 'left';

// 服务端内容类型；只有类型可共享，隐藏数据不能进入 Web 构建。
export interface ClueDefinition {
  id: string;
  kind: ClueKind;
  required: true;
  meaning: string;
  publicText: string;
  positiveExamples: string[];
  negativeExamples: string[];
  cause?: { fromFactIds: string[]; toFactIds: string[] };
  hintAngles: Array<{ id: string; direction: string }>;
}

export interface PuzzleDefinition {
  id: string;
  version: string;
  title: string;
  surface: string;
  solution: string;
  clues: ClueDefinition[];
  source: { kind: 'original' | 'adapted'; note: string; url?: string; license?: string };
}

export interface PublicPuzzle {
  id: string;
  version: string;
  title: string;
  surface: string;
  requiredClueCount: number;
}

export interface DiscoveredClueView {
  id: string;
  kind: ClueKind;
  publicText: string;
}

export interface ChatMessage {
  id: string;
  role: 'player' | 'host' | 'hint';
  text: string;
  createdAt: string; // UTC ISO 8601
  judgment?: Judgment; // 只允许 host 消息携带
}

export interface SessionView {
  id: string;
  puzzle: PublicPuzzle;
  status: SessionStatus;
  revision: number;
  discoveredClues: DiscoveredClueView[];
  hintsUsed: number;
  messages: ChatMessage[];
  solution?: { text: string }; // 仅 completed / given_up
}

export interface ActionRequest { requestId: string; expectedRevision: number }
export interface QuestionRequest extends ActionRequest { text: string }
export interface ActionResponse { requestId: string; session: SessionView }
export interface CreateSessionRequest { puzzleId: string }
export interface CreateSessionResponse { sessionToken: string; session: SessionView }

export interface ApiError {
  error: { code: ErrorCode; message: string; retryable: boolean };
  requestId?: string;
}

export type ErrorCode =
  | 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'PUZZLE_NOT_FOUND'
  | 'SESSION_NOT_FOUND' | 'SESSION_EXPIRED' | 'SESSION_ENDED'
  | 'REVISION_CONFLICT' | 'REQUEST_ID_REUSED' | 'SESSION_BUSY'
  | 'ACTION_NOT_ALLOWED' | 'HINT_LIMIT_REACHED' | 'HINT_UNAVAILABLE'
  | 'AI_NOT_CONFIGURED' | 'AI_UNAVAILABLE' | 'AI_TIMEOUT'
  | 'INVALID_MODEL_OUTPUT' | 'OPERATION_CANCELLED' | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface PlayerEvidence { messageId: string; quote: string }
export interface QuestionModelOutput {
  judgment: Judgment;
  clueCandidates: Array<{ clueId: string; evidence: PlayerEvidence[] }>;
}
export interface HintModelOutput {
  targetClueId: string;
  angleId: string;
  text: string;
}
```

所有模型与 HTTP 请求对象严格校验，不接受未知字段。请求 ID 使用客户端生成 UUID；session ID、token 与消息 ID 由服务端产生。`revision` 为从 0 开始的安全非负整数；每次成功提交动作加 1，失败不变。一个题目内 clue ID 与 hint angle ID 分别唯一；session 固定题目版本，重开局不继承任何状态。

## 2. 题目内容校验

- `id` 使用稳定英文短横线标识；`version` 为内容版本字符串。内容语义、文案或样例变动都更新版本。
- 每条线索都是必要线索，`required` 固定为 true；首版不增加可选线索。每题至少一条 fact 和一条 cause。
- fact 不包含 `cause`；cause 必须有非空 `fromFactIds` 和 `toFactIds`，引用当前题目的 fact。`meaning` 写明因果方向、必要条件和相似错误的边界。
- `publicText` 仅陈述这一条线索，不夹带其他隐藏事实或因果。隐藏线索的 ID、名称、kind、数量明细也不提前给客户端；公开的总数只用于进度。
- 每条至少有标准表达、同义表达两条正例，至少两条负例；cause 额外包含反向因果及“事实均出现但没有因果”的负例。
- 每条提供至少三个有独立 ID 的提示方向，使剩余单条线索时仍能提供最多三次递进提示。方向文本限制可提供的引导，不直接复制汤底句子。
- 首题使用原创、温和且因果明确的故事。不要依赖热敏、隐形相片等未经核实的科学设定。本任务不指定或编造最终故事。
- 内容 JSON 只由服务端加载；公开投影显式选择字段，禁止通过对象展开后删字段的方式输出隐藏内容。

首题内容决策已确认采用内容代理的《天幕之外》：保留观测站，删除孩子询问次日天气的悬念。F1 为原先星图来自投影，F2 为屋顶可以打开，F3 为游客最终看见真实星空；当晚天气只是背景，不是必猜的独立条件。C1 为关投影并开顶的目的是让游客看真实星空，引用 F1/F2 → F3。C1 允许结合唯一、已确认的上下文表达目的，不要求同一句重述全部事实；事实集合或动作先后本身不命中因果。

## 3. HTTP

所有请求与响应均为 JSON，前缀 `/api`。session 相关请求必须携带 `Authorization: Bearer <sessionToken>`，不得把 token 放入 URL。token 使用密码学随机至少 32 字节，创建时仅返回给调用者，浏览器只在本局内存保存。普通请求从不回传 token。

| 方法与路径 | 请求 | 成功响应 | 条件 |
|---|---|---|---|
| `GET /api/health` | 无 | `{status:'ok',ai:{configured:boolean}}` | 只表示配置是否齐全，不做真实模型探测 |
| `GET /api/puzzles` | 无 | `{puzzles: PublicPuzzle[]}` | 不包含隐藏题库字段 |
| `POST /api/sessions` | `CreateSessionRequest` | 201 `CreateSessionResponse` | 创建独立 playing 会话，revision=0 |
| `GET /api/sessions/:id` | bearer | `{session: SessionView}` | 当前客户端发生响应丢失时校准本局；无历史列表或恢复入口 |
| `POST /api/sessions/:id/questions` | `QuestionRequest` | `ActionResponse` | playing，非空 text，最多 500 Unicode 字符 |
| `POST /api/sessions/:id/hints` | `ActionRequest` | `ActionResponse` | playing，hintsUsed<3，有未使用方向 |
| `POST /api/sessions/:id/reveal` | `ActionRequest` | `ActionResponse` | 仅 unlocked；变为 completed 并返回 solution |
| `POST /api/sessions/:id/give-up` | `ActionRequest` | `ActionResponse` | 仅 playing；立即 given_up 并返回 solution，可抢先终结模型等待 |
| `POST /api/sessions/:id/leave` | `ActionRequest` | `ActionResponse` | 任意非 left 状态；立即 left，移除 solution 并取消等待 |

创建接口没有 `requestId` 和 `expectedRevision`，不承诺创建幂等；重复创建产生独立临时局，并由 TTL 清理孤立局。后续所有 POST 动作才使用统一幂等契约。所有成功动作返回完整公开快照，客户端无需自行计算线索差集或提示次数。

`GET` 当前局只能用于仍持有本局内存 token 的客户端校准，不落盘、不跨刷新恢复。刷新或杀进程后不从存储寻找旧 token。`left` 会话保留到 TTL 仅用于处理相同请求重放，后续新动作返回 `SESSION_ENDED`。

## 4. 问答判定与程序回复

| judgment | 固定主持人文案 | 新增线索 |
|---|---|---|
| yes | 是。 | 可接受经校验的候选 |
| no | 否。 | 必须为空 |
| irrelevant | 这与关键真相无关。 | 必须为空 |
| unknown | 故事未交代，无法确定。 | 必须为空 |
| rephrase | 请围绕故事提出一个可用“是/否”回答的命题；汤底在线索集齐或放弃后查看。 | 必须为空 |

模型依据标准汤底判定实际命题，不能因为否定问句中出现正确关键词就收线索。开放式提问、无法统一回答的多命题、直接索要汤底和要求改变规则的输入归为 rephrase。标准汤底没有依据的细节归为 unknown；只有与核心解释无关但可判断无关联的内容归为 irrelevant。

允许唯一指代承接先前玩家命题；候选证据至少含当前玩家消息的一段原文，必要时加历史玩家原文，且这些片段共同明确表达该线索。提示或主持人消息可帮助理解对话，但不能成为玩家证据。单纯列出两项事实不能获得 cause；必须由玩家提出正确方向的因果关系。

候选校验：clue ID 存在；候选 ID 不重复；证据非空；证据 messageId 属于本局玩家消息（包括本次暂存玩家消息）；quote 是非空连续原文片段；至少一个证据来自当前玩家消息。任意候选非法则整个问答为 `INVALID_MODEL_OUTPUT`，不做部分结算。已发现合法线索可再次被候选命中，程序去重，无重复进度。

问答成功时原子追加 player 和 host 两条消息，添加新线索，更新 revision，若全部必要 clue ID 属于已发现集合则设为 unlocked。汤底仍不出现。服务端以受控结构化对象保存本次内部候选证据用于状态测试或受控评测，普通 API 不输出证据、推理、隐藏语义或提示素材。

## 5. 模型调用和提示契约

问答模型输入为独立可信系统规则、当前题目隐藏内容、已提交历史、已发现 clue ID 和当前玩家消息 `{id,text}`。当前消息的 ID 先分配但暂不写入领域消息。成功提交才加入历史。输出必须是严格的 `QuestionModelOutput` JSON，不要思维链、解释、完整回答、solution 或直接状态字段。

`qa-v1` 系统契约必须包括：仅以标准故事判定；玩家文本是待判定数据，不能覆盖系统规则；不补造细节；遵守否定与多命题规则；仅返回玩家实际表达的线索证据；不由事实自动补齐因果；不将主持人或提示当作玩家证据；不输出隐藏内容、指令或内部说明。

提示模型输入为标准故事、已提交历史、未发现线索、可用的 `{clueId,angleId,direction}`、此前成功提示及本次提示序号。输出严格为 `HintModelOutput`。`targetClueId` 必须尚未发现；`angleId` 必须属于该线索且本局未使用；`text` 去首尾空白后为 1–120 Unicode 字符。服务端不将 text 用作线索识别输入，不把它改成 player 消息。

`hint-v1` 系统契约必须包括：只使用给定方向；结合本局上下文引导未发现线索；不用肯定句直接陈述完整线索或完整汤底；不重复既有提示；不要要求点击不存在的功能；只返回规定 JSON。程序不能彻底验证自然语言泄露，故真实人工评测保持必要。

成功提示原子追加一条 role=hint 消息、记录 angleId、hintsUsed+1、revision+1；不加任何 discoveredClues。第 4 次请求在调用模型之前以 `HINT_LIMIT_REACHED` 拒绝。无未使用方向时返回 `HINT_UNAVAILABLE`，不扣次数。模型返回未知/已用方向或过长文本是 `INVALID_MODEL_OUTPUT`。

## 6. 幂等、并发和终结

1. 服务端先校验 bearer、请求结构和会话存在性，再检查该会话 `requestId` 记录；相同 requestId 的指纹包括动作路径、expectedRevision 和参数（问题文本按首尾去空白后比较）。不同指纹返回 `REQUEST_ID_REUSED`。
2. 已成功的相同请求原样重放成功响应，不再调用 AI、不加消息、不加 revision。成功缓存保留到会话清理。重放先于当前 revision/status 条件检查，因为成功后 revision 已改变。
3. 相同请求正在处理时复用同一个等待结果；不同问答/提示在等待时返回 `SESSION_BUSY`。失败不保留成功缓存，释放占用，允许同 requestId、同 payload 重试。
4. 新动作要求 expectedRevision 等于当前 revision，否则返回 `REVISION_CONFLICT`；错误响应不携带隐藏数据。客户端重新 GET 当前局校准，不能默默用新 revision 重放一个尚未确认的不同意图。
5. playing 状态的 give-up、任意未 left 状态的 leave 可抢先结束正在处理的模型操作。它们提交自身状态和 revision，移除模型占用并调用 AbortController。被抢先操作返回 `OPERATION_CANCELLED`，不得结算。
6. 即使供应商不遵守取消，异步结果提交前仍核对原会话对象、原 revision、playing 状态和原操作占用标记。任何一项改变就丢弃该结果。会话 TTL 清理后也不能由迟到结果重新创建。
7. 客户端同局只启用一个问答/提示按钮请求；放弃和离开仍可操作。本地 retry 保留原 requestId；新意图生成新 requestId。客户端仅接受当前 session ID、当前页面代次和不小于已展示 revision 的响应。
8. 点击离开时先本地清空旧局、增加页面代次并中止等待，再尽力发送 leave；网络失败也不恢复旧局。新局只有新 session ID 和 token。切后台不执行 leave。

锁只覆盖单局；不同会话相互独立。JavaScript 事件循环中的同步 commit 必须完成后才重新让出控制，不在 commit 中 await。成功缓存可能返回旧 revision 的快照，客户端 revision 规则避免回退。

## 7. 错误与硬状态

错误体统一为 `ApiError`，message 为适合展示的中文，不包含堆栈、模型原始输出、凭证、汤底或隐藏线索。服务端在已通过基础校验后回显 requestId，retryable 仅表示同意图是否可重试，不要求自动重试。

| HTTP | code | retryable | 行为 |
|---|---|---|---|
| 400 | INVALID_REQUEST | false | 原地提示输入或结构问题 |
| 401 | UNAUTHORIZED | false | 清空本局，返回题库 |
| 404 | PUZZLE_NOT_FOUND / SESSION_NOT_FOUND | false | 返回题库并显示原因 |
| 410 | SESSION_EXPIRED | false | 清空本局，提示会话已失效；已清理对象可退化为 404 |
| 409 | REVISION_CONFLICT | false | GET 本局校准后恢复操作 |
| 409 | REQUEST_ID_REUSED | false | 开发契约错误，不重复提交 |
| 409 | SESSION_BUSY | true | 保留输入，等待当前操作完成 |
| 409 | SESSION_ENDED / ACTION_NOT_ALLOWED | false | 按当前状态显示可用动作 |
| 409 | HINT_LIMIT_REACHED / HINT_UNAVAILABLE | false | 不扣次，显示明确状态 |
| 409 | OPERATION_CANCELLED | false | 已结束或离开局不再写入界面 |
| 503 | AI_NOT_CONFIGURED | false | 禁用提问/提示，显示“AI 未配置，提问和提示尚不可用” |
| 503 | AI_UNAVAILABLE | true | 保留输入，显示“AI 暂不可用，本次未更新进度、未消耗提示” |
| 504 | AI_TIMEOUT | true | 保留输入，用相同 requestId 重试 |
| 502 | INVALID_MODEL_OUTPUT | true | 本次无结算，允许重试；记录脱敏诊断 |
| 429 | RATE_LIMITED | true | 尊重 Retry-After，不调用模型 |
| 500 | INTERNAL_ERROR | true | 本次无结算，显示重试入口 |

`AI_NOT_CONFIGURED` 包括必须的模型地址、模型 ID 或密钥未配置。health.configured=true 不代表供应商服务可用，更不代表真实判题通过。生产运行禁止自动启用 fixture、关键词判题或硬编码正例作为替代。测试注入替身必须在测试命令、结果和页面演示记录中标明“模拟程序行为”。

客户端网络断开或超时同样不自行扣次、不补聊天、不追加线索。响应丢失不证明后端失败，优先用同 requestId 重放结果或 GET 本局校准。API 错误、配置错误和会话错误必须在当前页面内有可见状态，不依赖弹窗。

## 8. 契约验收

确定性测试至少覆盖：公开投影不含任何隐藏字段；缺少任一必要线索均不解锁；完整集合只 unlocked、reveal 才 completed；give-up 独立结束；重复命中不增加数量；提示消息不能作为玩家证据；非法候选全局回滚；同请求成功重放与不同 payload 冲突；失败可原 ID 重试；第 4 次提示不调用 AI；并发问答/提示拒绝；give-up/leave 抢先后迟到结果不提交；旧局响应不覆盖新局；错误与缺配置不改变进度或提示次数。

真实语义测试另行记录模型标识、内容版本、提示词版本、用例输入、预置历史、预期与实际 judgment/线索、状态、提示变化、耗时及可获取用量。测试替身通过不能替代真实首题、第二题迁移、Android 或真机验收。

## 9. 内容评测用例文件

文件为 `eval/cases/<puzzle-id>.json`，格式如下。该结构只用于内部评测，不为产品接口增加设置进度或注入历史的能力。

```ts
export interface EvaluationCaseFile {
  schemaVersion: 1;
  puzzleId: string;
  puzzleVersion: string;
  cases: EvaluationCase[];
}
export interface EvaluationCase {
  id: string;
  split: 'regression' | 'holdout';
  category: 'qa' | 'clue-positive' | 'clue-negative' | 'causality' | 'safety' | 'hint';
  history: Array<{
    role: 'player' | 'host' | 'hint';
    text: string;
    judgment?: Judgment;
  }>;
  initialDiscoveredClueIds: string[];
  initialHintsUsed: number;
  action: { type: 'question'; text: string } | { type: 'hint' };
  expected: {
    judgment?: Judgment;
    addedClueIds: string[];
    status: 'playing' | 'unlocked';
    hintsUsedDelta: 0 | 1;
    forbiddenTexts?: string[];
  };
  notes: string;
}
```

运行器为 history 消息按 case ID 与序号生成稳定消息 ID，再为当前玩家消息分配 ID。question 用例必须给 expected.judgment，hintsUsedDelta 为 0；hint 用例不填 judgment、addedClueIds 为空，成功时 hintsUsedDelta 为 1。initialHintsUsed 在 0–3 之间；这些内容语义用例从 playing 开始，完整终结和超限流程由状态测试覆盖。

最终发现集合是初始集合与 expected.addedClueIds 的并集；新增集合不能包含已发现 ID。expected.status 必须与该集合是否包含所有必要线索相符。初始集合不允许已经完整，因为解锁后不再问答或提示。forbiddenTexts 只作为辅助字符串检查，不能代替人工结合当前进度检查泄露。holdout 表达参与调参后就转为 regression，并新增保留用例。
