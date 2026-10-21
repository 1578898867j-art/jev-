# GitHub 仓库接入记录

更新时间：2026-10-21。

## 目标仓库与远端基线

- 目标仓库：[1578898867j-art/jev-](https://github.com/1578898867j-art/jev-)，公开仓库，默认分支为 `main`。
- GitHub connector 已核对仓库所有者与目标账号一致，并具备 push/admin 权限。
- 已从官方 GitHub HTTPS 地址只读 fetch `main`。远端初始提交为 `99de7935d303a82e8ad87658fd388560d4785795`（`Initial commit`），提交树只有 `.gitignore` 和 `README.md`。
- 远端初始 README 内容是 `# jev-` 和 `111`。该提交及内容仍保留在 `main` 历史中；后续项目 README 已替换为项目说明。

此前创建的私有空仓库 [1578898867j-art/ai-turtle-soup](https://github.com/1578898867j-art/ai-turtle-soup) 保持原样，没有上传项目文件，也没有删除。

## 本地基线与工作树

本地 `origin` 指向 `https://github.com/1578898867j-art/jev-.git`。首个基线推送后，本地 `main` 跟踪 `origin/main`，两者当时均指向 `3f2c6901db7a25af7494bd0aa62af0850bd4b73b`。该 qa-v2 提交以远端初始提交 `99de7935d303a82e8ad87658fd388560d4785795` 为 parent，因此保留了仓库原有历史。

本地 `.gitignore` 保留项目已有的 `.env`、`node_modules`、`web/dist` 等保护，并合并远端 Android/Gradle、IDE、签名文件、Google Services 配置和日志等忽略规则；同时忽略 `.omx/` 与 Android `local.properties`。不要提交 API 凭证、机器路径或设备可访问地址。

## 上传与 CI 状态

冻结的 qa-v2 基线已作为提交 `3f2c6901db7a25af7494bd0aa62af0850bd4b73b` 快进推送到 `main`，推送后已核对远端分支 SHA 与提交一致。GitHub Actions Web 验证已成功：[查看本次运行](https://github.com/1578898867j-art/jev-/actions/runs/39530358770)。

上传使用 Git Credential Manager 与临时隔离的全局/系统 Git 配置直连官方 GitHub；没有把 token 写入 remote URL、命令参数或文件，也没有修改用户全局 Git 配置。原私有空仓库 `ai-turtle-soup` 仍保持未使用状态。
