# 开发环境检查

检查日期：2026-10-20。此记录来自当前 Windows 进程的只读探测；未安装软件、修改系统配置、读取项目 `.env`、读取登录会话或调用 AI 服务。凭证检查只记录变量名与是否设置，不读取或保存值。

## Node 与安装工具

| 项目 | 实测结果 |
|---|---|
| Node.js | `node --version` → `v24.11.1`；命令路径 `D:\node.exe` |
| npm | `npm --version` → `11.6.2`；命令路径 `D:\npm.ps1` |
| Corepack | `corepack --version` → `0.34.2` |
| Chocolatey | `choco --version` → `2.5.1` |
| winget | 找到 `C:\Users\15788\AppData\Local\Microsoft\WindowsApps\winget.exe`，但启动失败，系统提示“系统无法访问此文件” |
| Scoop | 命令不可用 |

可使用 npm/Corepack 管理 Node 项目依赖，Chocolatey 命令可运行。没有执行安装，也没有验证网络访问或包下载。

`npm cache ls` 退出码为 `0`，没有输出条目；`npm config get cache` 被环境策略拦截（`The cache option is protected`），因此缓存目录和缓存内容无法进一步确认。空输出不代表已确认缓存目录为空。

## Java 与 Android

| 项目 | 实测结果 |
|---|---|
| Java | `java -version` → `13.0.2`；路径 `C:\Users\15788\Desktop\jdk-13.0.2\bin\java.exe` |
| Javac | `javac -version` → `13.0.2` |
| `JAVA_HOME` | `C:\Users\15788\Desktop\jdk-13.0.2` |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | 当前进程均未设置 |
| Android SDK | 常见 `%LOCALAPPDATA%\Android\Sdk`、`C:\Android\Sdk`、`D:\Android\Sdk` 均未找到 |
| Android Studio | `C:\Program Files\Android\Android Studio`、`%LOCALAPPDATA%\Programs\Android Studio`、`C:\Program Files (x86)\Android\android-studio` 均未找到 |
| adb / sdkmanager | PATH 和已检查的常见 SDK 位置均不可用 |
| 设备 | 因 adb 不可用，未能执行 `adb devices -l`；当前设备连接状态未知，不能据此确认没有设备 |

Java 13 已安装，但尚未确认它符合本项目最终 Android Gradle Plugin 的要求。Android 构建链未就绪。

后续需要安装 Android Studio 及 Android SDK（至少 Platform Tools、目标 SDK Platform 和 Build Tools；如使用模拟器还需 Emulator），再按最终 Gradle/Android 插件版本确定 JDK。安装完成后设置 SDK 路径，并运行 `adb devices -l`；连接真机时需在设备上启用 USB 调试并授权，或启动模拟器。

## AI 凭证环境变量

以下变量在当前进程中均未设置：

`OPENAI_API_KEY`、`AI_API_KEY`、`OPENROUTER_API_KEY`、`DEEPSEEK_API_KEY`、`DASHSCOPE_API_KEY`、`ARK_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`、`GOOGLE_API_KEY`、`QWEN_API_KEY`、`ZHIPUAI_API_KEY`、`MOONSHOT_API_KEY`、`SILICONFLOW_API_KEY`、`MINIMAX_API_KEY`、`HUNYUAN_API_KEY`、`BAIDU_API_KEY`。

产品 AI 供应商尚未确认；开展真实模型评测前，需要先选定供应商，并通过运行环境的密钥管理方式提供对应凭证，不要提交到仓库。此次没有读取任何凭证值，也没有进行真实 AI 调用。
