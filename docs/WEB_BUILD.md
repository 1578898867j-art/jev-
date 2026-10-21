# Web 构建与同源启动

项目只有一套 React/Vite 前端与 Node/Express 后端。浏览器 Web 和 Android 都使用根工程生成的 `web/dist`；Android 同步命令会复用这份 Web 构建，不维护另一套客户端工程。

## 本地构建

需要 Node.js 24 或更新版本。从仓库根目录安装锁定依赖、运行程序测试、构建并校验评测用例：

```sh
npm ci
npm test
npm run build
npm run eval:validate
```

`npm run build` 执行 TypeScript 类型检查并生成 `web/dist`。`npm run eval:validate` 只检查评测数据和状态一致性，不调用模型。真实模型评测使用另一条 `eval:live` 命令，不属于 CI。

## 同源 Web 服务

构建后，在仓库根目录启动 Express：

```sh
npm start
```

`npm start` 不会自动构建。成功启动后，同一个服务从 `web/dist` 提供页面，并在 `/api` 提供后端接口；Web 默认使用相对地址 `/api`，页面与接口同源。默认监听端口为 `8787`，`HOST` 默认是 `0.0.0.0`，`PORT` 可覆盖端口。浏览器开发模式则由 Vite 在 `5173` 提供页面，并将 `/api` 代理到 `127.0.0.1:8787`。

希望同一局域网内的手机浏览器访问时，让服务监听可被局域网访问的地址，并在手机上打开 `http://<开发机局域网地址>:8787`。手机浏览器会通过同源地址访问 API；同时需要允许防火墙上的对应端口。Android 原生壳使用独立的设备可访问 API 地址：设置公开的 `VITE_API_BASE_URL` 后重新运行 `npm run android:sync`。该变量会编译进前端资源，只能放地址，不能放 API 密钥；Android 发布环境建议使用 HTTPS。详细 Android 要求见 [Android 开发与构建](ANDROID_SETUP.md)。

## 构建产物与部署边界

CI 上传的 `web-dist` artifact 只包含 Vite 生成的静态前端文件，不包含 Express 服务、题库数据或后端运行环境。它不是可独立运行的完整游戏站点：游戏接口需要 Node/Express 后端运行，且会话当前保存在服务进程内存中。因此不要把该 artifact 当作 GitHub Pages 站点部署；生产部署需要同时运行后端，并由 Express 提供 `web/dist` 与 `/api`。

## GitHub Actions 验证

[`.github/workflows/verify.yml`](../.github/workflows/verify.yml) 在 push 和 pull request 上使用 Linux 与 Node.js 24，按顺序运行 `npm ci`、`npm test`、`npm run build` 和 `npm run eval:validate`，然后上传 `web/dist`。工作流仅申请 `contents: read` 权限，不配置模型密钥，也不会发出真实模型请求。

当前本地实现尚未产生 GitHub Actions 运行记录；工作流需在代码推送到 GitHub 后才会执行。该文档说明的是 CI 配置与本地验收范围，不代表远端 CI 已通过。
