# GitHub 仓库接入记录

更新时间：2026-10-21。

## 目标仓库与远端基线

- 目标仓库：[1578898867j-art/jev-](https://github.com/1578898867j-art/jev-)，公开仓库，默认分支为 `main`。
- GitHub connector 已核对仓库所有者与目标账号一致，并具备 push/admin 权限。
- 已从官方 GitHub HTTPS 地址只读 fetch `main`。远端初始提交为 `99de7935d303a82e8ad87658fd388560d4785795`（`Initial commit`），提交树只有 `.gitignore` 和 `README.md`。
- 远端初始 README 内容是 `# jev-` 和 `111`。该提交及内容仍保留在 `main` 历史中；本地项目 README 已更新为项目说明，纳入本次冻结候选。

此前创建的私有空仓库 [1578898867j-art/ai-turtle-soup](https://github.com/1578898867j-art/ai-turtle-soup) 保持原样，没有上传项目文件，也没有删除。

## 本地基线与工作树

本地 `origin` 指向 `https://github.com/1578898867j-art/jev-.git`。当前本地 `main` 跟踪 `origin/main`，HEAD 为上述初始提交。接基线前确认 index 为空，再用 `git reset --mixed origin/main` 更新 HEAD 与 index；没有覆盖工作树，也没有暂存或创建新提交。项目文件仍保留在本地，README、`.gitignore` 及其他工程文件继续作为未提交修改或未跟踪文件。

本地 `.gitignore` 保留项目已有的 `.env`、`node_modules`、`web/dist` 等保护，并合并远端 Android/Gradle、IDE、签名文件、Google Services 配置和日志等忽略规则；同时忽略 `.omx/` 与 Android `local.properties`。不要提交 API 凭证、机器路径或设备可访问地址。

## 上传与 CI 状态

本次 qa-v2 基线已冻结，候选文件已暂存，正等待主控对 index 中的确切内容执行凭证与主机地址扫描；当前尚未 commit 或 push。扫描通过并获主控确认后，再提交到 `main` 并推送；保留现有初始提交，不 force push、不删除或重写远端文件。

首次上传时须使用只指向官方 GitHub host 的认证流程：在进程内通过 Git Credential Manager 获取指定账号凭证，使用临时隔离的空全局/系统 Git 配置直连 GitHub；不要把 token 放进 remote URL、命令参数、文件或日志，也不要让凭证经过全局 URL rewrite 代理。推送后再检查 GitHub Actions 的 Web 验证结果。
