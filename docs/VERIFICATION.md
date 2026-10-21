# 首题工程验证记录

日期：2026-10-20。范围为当前首题工程；以下结果不代表完整五题 Android MVP 已完成。

## 初始工程快照（配置真实AI与安装Android工具链之前）

本节保留初始35项回归的原始事实。后续新增profile测试、真实Qwen评测和APK结果见文末，不能用本节的旧环境状态描述当前工程。

### 清理后命令

| 命令 | 实际结果 | 证明范围 |
|---|---|---|
| `npm test` | exit 0；5文件、35/35通过 | 17项服务端/适配器、12项Web请求与状态、6项评测器回归；使用受控替身与临时本机HTTP |
| `npm run build` | exit 0 | TypeScript检查和Vite生产构建通过 |
| `npm run eval:validate` | exit 0；35条用例 | 人工用例结构/状态校验；没有调用模型或产生准确率 |
| `npx cap sync android` | exit 0 | 最新Web资源同步进Android工程；没有执行Gradle或生成APK |

本机HTTP回归需要允许loopback。沙盒内曾返回EACCES，获准后按原测试重跑通过；没有删减失败测试。

## 独立审查与边界

`docs/FINAL_REVIEW.md`记录6.1 Sol Max对R01–R06修复的独立复验以及清理后的窄复审。清理只把服务端API测试的any换成已有共享响应类型，未改运行逻辑，未减少断言。

`artifacts/qa/http-boundary.json`记录11项本机HTTP检查通过：正常页面与API可访问，开发服务拒绝隐藏题库/评测/服务端文件请求，生产服务仅发布Web构建目录。编码冒号的特殊路径返回公共HTML页面壳，不含隐藏JSON；不能仅把HTTP 200当作内容泄露或声称该变体返回403。

最终浏览器基础验收通过：Edge、320/390/768宽度，使用真实本机API验证未配置AI提示、控件禁用、放弃后的汤底、刷新清局、无横溢出及无pageerror；没有问答/提示请求。报告为`artifacts/qa/browser-smoke.json`，同目录保留7张截图和可复跑脚本。

故障及协议UI验收5项通过：40秒客户端deadline后的状态校准与同ID重试；Retry-After到期前禁用与到期后同ID重试；离局迟到响应隔离；429后离开重开清除旧局gate；解锁后仍无汤底、显式reveal后才展示。报告为`artifacts/qa/network-smoke.json`，同目录保留可复跑脚本。全部API由本地夹具拦截；只有40秒deadline使用浏览器时钟快进，Retry-After用真实2秒流逝验证。这些只证明客户端协议/UI。

Android内嵌JS与本次Web构建JS的SHA-256相同，确认同步的是最新产物。

### 当时尚待真实外部验证

- 游戏AI凭证未配置，`/api/health`实际返回`configured:false`。没有真实模型效果、首题语义通过率、费用或延迟结论。
- 第二题只有内容草案，尚未证明迁移成功；五题扩展尚未发布到运行题库。
- 本机只有JDK13，未发现项目所需JDK21或Android SDK/adb；没有APK、安装或真机交互结论。

下一步先在本地`.env`填写服务端密钥并重启，执行首题真实评测、复核误收/漏收与泄题，再依开发路径进入第二题迁移。Android工具链可并行补齐，其真机验收单独记录。

## 2026-10-20 当前工程基线（qa-v2）

- 上传前最终检查：`npm test`为47/47通过（5文件），`npm run build`通过，`npm run eval:validate`为35条通过。全量检查先发现评测器测试仍硬编码qa-v1；已改为验证生产`QA_PROMPT_VERSION`的传播，保留结构校验与状态断言，再重跑全47项通过。第三轮窄清理无运行代码变更。
- 用户授权的百炼配置仅在忽略的`.env`。GLM产品未激活错误保留；按用户后续指示切换`qwen3.8-flash`，关闭推理，生产适配器使用`max_completion_tokens:2048`。独立审查通过，未修改人工预期或放宽结构与证据校验。
- qa-v2真实smoke为3/3匹配；30条真实回归为24匹配、6分类偏差、0请求/结构错误。29条问答23条正确，未达到≥90%参考门槛。指定样本中新增线索无误收/漏收；5条holdout未运行。详情、局限与失败见[AI评测](AI_EVALUATION.md)，原始JSON完整保留。
- JDK21、Android SDK36及Build Tools35已在项目外隔离安装，Gradle `assembleDebug`成功。APK为5,060,612字节，SHA256 `207B369B4E106283F04A4D2E300C85BFCE220F765616273279461F6D4986FA05`；详见[Android记录](ANDROID_SETUP.md)。没有设备安装与原生联网验证，APK尚缺设备可达的产品API地址。
- Web本地同步构建已通过；GitHub Actions只运行程序测试、类型检查、Web构建和本地用例验证，不注入密钥、不运行付费模型。远端CI必须在实际推送后另行记录。

已安装工具与成功构建APK不替代首题语义门槛、第二题迁移、五题效果和真机验收。
