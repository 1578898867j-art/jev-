# 人工语义用例评测

`eval/run.ts` 默认只校验题库与人工标注，不发起模型请求。评测用例只允许内部运行器注入前置对话和已发现线索；产品 API 没有设置会话进度的入口。结果文件位于 `eval/results/`，不参与 Web 构建，也不会被服务端题库加载器导入。

从项目根目录运行：

```powershell
node --import tsx eval/run.ts
```

可用参数：

```text
--puzzle <id|all>             选择题目，默认 all
--split <all|regression|holdout> 选择用例集，默认 all
--rounds <1-100>              每条用例重复次数，默认 1
--live                        显式启用真实模型调用；未提供时绝不构造 AI adapter
```

例如只校验第一题的 holdout：

```powershell
node --import tsx eval/run.ts --puzzle beyond-the-dome --split holdout
```

真实评测前，先在本机 `.env` 配置 `AI_BASE_URL`、`AI_MODEL` 和 `AI_API_KEY`，再显式传 `--live`：

```powershell
node --env-file-if-exists=.env --import tsx eval/run.ts --live --puzzle beyond-the-dome --split regression --rounds 1
```

真实调用顺序执行并通过 `loadPuzzles()`、`createOpenAiCompatibleAdapterFromEnv()`、模型输入类型及现有输出校验器。缺少任一配置时运行器写出带 `blocked` 原因的结果并以非零码退出；不会伪造回答、通过率或成本。记录包括每条用例的模型名、内容版本、问答/提示词版本、输入历史、预期与实际判定/新增线索/状态/提示变化及耗时。运行器只在兼容响应包含标准 `prompt_tokens`、`completion_tokens` 或 `total_tokens` 字段时记录用量，其余情况明确记为 `null`。如果 adapter 返回结构校验失败，记录错误码并继续其余用例。

`forbiddenTexts` 对可见题面、已发现及本次新增线索文案、先前主持人/提示消息和本次生成回复做辅助字符串检查。明确命中会将用例标记为 `mismatch` 并令 live 命令非零退出；没有命中仍不能证明没有语义泄露，`manualLeakageReviewRequired` 会保留人工复核标记。问答的主持人回复是程序固定文案，评测器拿不到模型的内部过程，也不会把它当作泄露证据。

用例格式遵循 `docs/CONTRACTS.md` 第 9 节，并额外检查题目版本、唯一 ID、线索引用、history 角色证据边界、初始/最终线索集合及状态一致性。当前契约没有保存历史提示选中的 clue/angle，因此带既有提示历史的 `hint` 动作用例会被拒绝，避免虚构可用角度或 `previousHints` 状态；普通问答可包含提示历史。若需评测连续提示，应先协调扩展契约。

自动化测试中的替身只验证运行器的输入构造、结构校验和状态记账，不代表模型质量或真实评测准确率。运行评测不会自动修改 `holdout` 标注；参与调参的 holdout 用例须人工移入 regression，并补充新的保留表达。
