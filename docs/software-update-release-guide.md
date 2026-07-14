# 软件更新发布指南

## 首次配置 updater 密钥

Tauri updater 使用独立签名密钥验证更新包，和 Windows/Apple 系统代码签名不是同一套证书。私钥一旦用于正式发布必须长期保管，旧版本应用依赖对应公钥，不能随意更换。

在安全目录执行，目录不要位于 Git 仓库内：

```powershell
npm run tauri -- signer generate --write-keys D:\secure\tuya-mcu-simulator-updater.key
```

生成后：

1. 将 `.key.pub` 文件的完整内容替换到 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。
2. 在 GitHub 仓库 `Settings > Secrets and variables > Actions` 新增：
   - `TAURI_SIGNING_PRIVATE_KEY`：私钥文件完整内容。
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：生成密钥时设置的密码。
3. 把私钥和密码保存到公司密码库或离线备份，不要通过聊天、邮件或 Git 传递。

配置完成前，tag 发布会被 `npm run version:check` 主动阻止，避免生成无法验证的更新包。

## 发布新版本

```powershell
npm run version:set -- 0.2.0
cargo check --manifest-path src-tauri/Cargo.toml
npm run version:check
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
git commit -m "release: v0.2.0"
git tag v0.2.0
git push origin main
git push origin v0.2.0
```

GitHub Actions 会并行构建 Windows、macOS universal 和 Ubuntu 安装包，生成对应 updater 产物及 `.sig`，最后汇总生成 `latest.json` 并上传到同一个 Release。当前 Tauri v2 的 Windows updater 使用 `setup.exe + setup.exe.sig`，脚本也兼容旧版压缩格式。

本地 `npm run tauri:build` 只生成普通安装包，不要求发布私钥；`npm run tauri:build:updater` 专用于配置好签名环境的发布构建。

## 发布后检查

确认以下地址可以匿名访问：

```text
https://github.com/dbdb8/tuya-mcu-simulator-assistant/releases/latest/download/latest.json
```

`latest.json` 应包含 `windows-x86_64`、`darwin-x86_64`、`darwin-aarch64`、`linux-x86_64`。Windows/macOS 和 AppImage 用户可以应用内安装；Ubuntu deb 用户会跳转 Release 手动下载。

## 系统代码签名预留

当前 updater 签名可以防止更新包被篡改，但不会消除 Windows SmartScreen 或 macOS Gatekeeper 提示。后续可以在现有工作流中增加 Windows 代码签名证书、Apple Developer ID 和 notarization Secrets，不需要更改应用内更新交互。
