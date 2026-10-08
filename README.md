# 旋律｜Material 3 Expressive 本地音乐播放器

这是一个本地音乐播放器原型：Android 原生工程是主实现；项目根目录另有一个可从 HTTPS 打开的 PWA 预览，用来快速体验界面。

## Android 原生工程

`android/` 使用 Jetpack Compose 与 Material 3 风格，Android 12+ 支持动态壁纸色。原生播放器已正式加入 AndroidX Media3：`media3-exoplayer:1.11.1` 负责音频播放，`media3-session:1.11.1` 负责 `MediaSessionService`、后台播放及系统媒体控制。服务结构遵循 [Media3 ExoPlayer 官方入门](https://developer.android.com/media/media3/exoplayer/hello-world) 与 [后台播放指导](https://developer.android.com/media/media3/session/background-playback)。

应用通过 Android 系统文件选择器导入多首本地音频，读取歌曲标题、歌手、专辑和内嵌封面；收藏项保存在本地。原生层提供播放队列、上一首/下一首、随机与循环控制，并通过媒体会话接入锁屏与系统通知。

构建需要 JDK 17+ 与 Android SDK Platform 36。Gradle Wrapper 固定为 8.13：

```bash
cd android
./gradlew assembleDebug
```

Gradle 项目配置检查已通过，但本次没有生成 APK：当前执行环境未安装 Android SDK，APK 构建停在 `SDK location not found`。在安装 SDK Platform 36 的 Android Studio 环境中打开 `android/` 并同步后即可继续构建；成功后的 APK 预期位于 `android/app/build/outputs/apk/debug/`。

### GitHub Actions 自动编译与发布

仓库的 **Android Build and Release** 工作流会在推送到 `main`、向 `main` 提交 Pull Request，以及推送 `v*` 版本标签时运行。每次运行都会生成可下载的 `app-debug.apk` 构建产物，可在对应的 GitHub Actions 运行记录页面获取，保留 14 天。

也可以在仓库的 **Actions → Android Build and Release → Run workflow** 中手动编译。`release_tag` 留空时只生成构建产物；填写如 `v1.0.0` 的版本标签时，会在编译完成后创建或更新对应的 GitHub Release，并附上 APK。推送 `v1.0.0` 这类标签也会自动发布 Release。

当前工作流产出的是 Android `debug` 变体 APK，使用 Actions 运行器生成的临时调试签名，适合测试安装；不同运行生成的签名可能不同，不适合作为长期升级或正式商店发布的签名。正式分发前应配置并保护稳定的发布签名密钥。

## 浏览器预览

根目录的 `index.html` 是便于快速体验的 PWA 预览，使用浏览器原生音频 API 与 IndexedDB，**不加载 Media3**；Media3 仅用于上述 Android 原生工程。通过 HTTPS 打开后可添加到主屏幕。页面静态资源支持离线缓存，导入音频与曲库保存在当前浏览器本地，不会上传。

预览包含多文件/文件夹导入、MP3 标签与封面读取、歌曲/专辑/歌手整理、搜索、收藏、队列、随机/循环播放、睡眠定时、键盘快捷键和浏览器支持的锁屏媒体信息。浏览器与 Android 原生版分别保存各自的本地曲库。
