# AI 海龟汤

本项目包含 React/Vite 客户端和 Node/Express API。API 在服务端加载 `content/puzzles/*.json`，临时会话只保存在内存中；重启服务会清空当前会话。

当前是单题工程基线：Web与Android调试构建通过，真实Qwen qa-v2问答回归为23/29，尚未达到语义验收门槛。第二题仅有草案，五题MVP与真机验收仍在推进。原始结果、失败与后续改进记录见[AI评测](docs/AI_EVALUATION.md)，整体进度见[项目状态](docs/PROJECT_STATUS.md)。

## 开发

使用 Node.js 24 或更新版本，安装锁定依赖：

```powershell
npm ci
```

服务端 AI 配置放在被 Git 忽略的根目录 `.env`。新克隆时可从 `.env.example` 创建；如果 `.env` 已存在，不要覆盖它。当前产品 profile 使用百炼北京专属兼容端点，模型 ID 为 `qwen3.8-flash`，默认 `AI_THINKING=disabled`。示例 URL 中的 `ws-your-workspace` 只是占位符，应在本机 `.env` 替换为自己的 workspace URL，并在本机填入 API key；不要把真实 URL 或密钥提交到仓库，也不要设置为 `VITE_` 变量。需要推理时可显式设为 `AI_THINKING=enabled`。GLM 可作为替代模型，但该 workspace 需先开通产品；配置模型 `ZHIPU/GLM-5.3-Flash` 时需使用 `AI_THINKING=enabled`。DeepSeek 仍可作为替代服务，配置 `AI_BASE_URL=https://api.deepseek.com`、`AI_MODEL=deepseek-flash`、`AI_THINKING=disabled`。修改 `.env` 后重启开发进程以加载配置。

启动全部开发服务：

```powershell
npm run dev
```

只启动后端 API 时运行：

```powershell
npm run dev:server
```

开发时 Web 客户端运行在 `5173`，并把 `/api` 代理到后端 `127.0.0.1:8787`。

验证评测用例结构和状态一致性（不调用模型）：

```powershell
npm run eval:validate
```

真实调用已配置的 AI 服务：

```powershell
npm run eval:live -- --puzzle beyond-the-dome
```

`eval:live` 会发起真实模型请求；`eval:validate` 只校验本地数据，不能作为模型准确率结果。

## 构建和同源启动

构建 Web 客户端与类型检查：

```powershell
npm run build
```

构建后使用单个 Node 服务同时提供 API 和 `web/dist` 静态客户端：

```powershell
npm start
```

`npm start` 不会替你构建；部署前先运行 `npm run build`。生产入口只挂载 `web/dist`，不会把项目根目录、`content`、`eval` 或 `server` 目录作为静态文件目录。

生产服务由 `npm start` 提供 API 和 `web/dist`；`PORT` 默认 `8787`，监听地址由 `HOST` 控制。配置了 `AI_BASE_URL`、`AI_MODEL`、`AI_API_KEY` 时，后端通过 OpenAI 兼容 Chat Completions 接口调用模型；缺少任一配置时，健康接口会报告 `configured: false`，提问和提示返回 `AI_NOT_CONFIGURED`，不会启用模拟判题。AI 密钥只配置在后端 `.env`，不要放入客户端环境变量。

Android 构建需要 JDK 21、Android SDK，并为原生前端构建设置可从设备访问的 HTTPS `VITE_API_BASE_URL`。详见 [Android 开发与构建](docs/ANDROID_SETUP.md)。

更多 API、AI 适配器和评测集成接口见 [docs/BACKEND_IMPLEMENTATION.md](docs/BACKEND_IMPLEMENTATION.md)。
