# Android 开发与构建

项目已由 Capacitor 生成 `android/` 工程。执行 `npm run android:sync` 会先构建 `web/dist`，再同步到 Android 工程；同步成功只表示 Web 资源已复制，不代表 APK 或真机验证通过。

## 构建要求

当前工程使用 Android Gradle Plugin 8.13.0、Gradle 8.14.3、compile/target SDK 36、min SDK 24。App module 与 Capacitor Android module 都配置为 Java 21，因此构建需要 JDK 21。SDK 需要 Platform 36、Build Tools 35.0.0 和 Platform Tools（adb）。AGP 8.13 自身最低支持 JDK 17，但本项目源码目标为 Java 21。[AGP 8.13 兼容信息](https://developer.android.com/build/releases/agp-8-13-0-release-notes)

## 已准备的隔离工具链（2026-10-20）

工具安装在仓库旁的 `D:\下载\ai-turtle-soup-tools`，只通过本次 PowerShell 进程的环境变量使用；没有安装 Android Studio，也没有修改系统 PATH 或系统环境变量。

| 工具 | 实测版本/组件 | 官方下载地址与 SHA-256 |
|---|---|---|
| Eclipse Temurin JDK | 21.0.12.1+1，`java` 和 `javac` 均为 21.0.12.1 | [Temurin release](https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.12.1%2B1)；ZIP SHA-256 `f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e` |
| Android Command-line Tools | package 15859902，sdkmanager 22.0 | [Google command-line tools](https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip)；ZIP SHA-256 `90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a` |
| Android SDK | `platforms;android-36`、`build-tools;35.0.0`、`platform-tools`（adb 37.0.1） | 由官方 SDK Manager 安装 |
| Gradle Wrapper distribution | Gradle 8.14.3（all） | [Gradle distribution](https://services.gradle.org/distributions/gradle-8.14.3-all.zip)；ZIP SHA-256 `ed1a8d686605fd7c23bdf62c7fc7add1c5b23b2bbc3721e661934ef4a4911d7c` |

已按用户确认，在 SDK Manager 交互界面接受 `android-sdk-license`。其余 7 项可选许可未接受，也未安装预览版、模拟器、系统镜像或其他供应商组件。

仓库路径包含中文目录名，AGP 首次构建因此拒绝继续。依据 AGP 错误提示，`android/gradle.properties` 增加了项目级 `android.overridePathCheck=true`，仅让此项目在当前中文路径下继续构建；没有修改全局 Gradle 属性。

## 构建调试 APK

从仓库根目录运行。以下变量只设置在当前 PowerShell 进程中：

```powershell
$env:JAVA_HOME = 'D:\下载\ai-turtle-soup-tools\jdk21\jdk-21.0.12.1+1'
$env:ANDROID_HOME = 'D:\下载\ai-turtle-soup-tools\android-sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:GRADLE_USER_HOME = 'D:\下载\ai-turtle-soup-tools\gradle-home'
npm run android:sync
.\android\gradlew.bat -p android assembleDebug --no-daemon
```

已在上述隔离环境中实际运行构建：`BUILD SUCCESSFUL`，93 项 Gradle action 均完成，用时约 4 分钟。APK 生成于 `android\app\build\outputs\apk\debug\app-debug.apk`，大小 5,060,612 字节，SHA-256 为 `207B369B4E106283F04A4D2E300C85BFCE220F765616273279461F6D4986FA05`。

本次构建没有设置 `VITE_API_BASE_URL`。检查 APK 内的 Web 资源未发现 `.env` 文件、`AI_API_KEY` 标记、DeepSeek API 地址或类似 `sk-` 的密钥串；前端代码中的 `VITE_API_BASE_URL` 变量名仍存在，但没有嵌入其值。应用需要设备可访问的后端地址才能联网使用。

构建日志有 AGP 实验性选项、Gradle `flatDir`、SDK XML 版本和 javac unchecked operations 提示；本次均未阻断构建。

## 真机或模拟器验证

本次没有安装 APK、连接或启动设备、运行模拟器，也没有调用后端或 AI。需要验证设备时，先确认设备可访问后端，再检查 adb 连接：

```powershell
adb devices -l
adb install -r android\app\build\outputs\apk\debug\app-debug.apk
```

原生应用的 `VITE_API_BASE_URL` 是公开的构建时地址，不能放密钥。Vite 配置使用 `envDir: false`，所以构建命令不会从根目录 `.env` 加载该变量；需要在进程中单独设置设备可访问的 HTTPS API 地址后重新同步并构建：

```powershell
$env:VITE_API_BASE_URL = 'https://你的设备可访问的后端地址'
npm run android:sync
.\android\gradlew.bat -p android assembleDebug --no-daemon
```

API 密钥只留在服务端 `.env`，不得放入 `VITE_` 变量或客户端资源。设备上的 `localhost` 指向设备自身；模拟器和真机都要配置它们能访问的后端主机地址。服务端监听地址、防火墙和 CORS 也需相应配置。Android 当前没有为明文 HTTP 添加例外，建议使用 HTTPS。

官方参考：[Android Studio 与 Command-line Tools](https://developer.android.com/studio)、[sdkmanager](https://developer.android.com/tools/sdkmanager)、[Gradle 校验值](https://gradle.org/release-checksums/)。

