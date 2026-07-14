# 涂鸦 MCU 模拟调试助手

[中文](README.md) | [English](README.en.md)

一个基于 Tauri、React 和 Rust 的跨平台桌面工具。电脑通过 USB-TTL 连接真实模组并模拟设备 MCU，可用于调试涂鸦通用 MCU 串口协议、DP 下发与主动上报。

> 本项目是独立的非官方开源工具，与 Tuya Inc.（涂鸦智能）不存在隶属、授权或背书关系。“Tuya”和“涂鸦”及相关商标归其权利人所有。

## 功能

- 手动加载 Tuya Debugfile JSON，不内置设备或产品 Profile。
- `55 AA` 协议帧解析、心跳、产品信息、工作模式、配网状态和 DP 查询。
- 保存 App/模组下发的最新 DP，并主动回报当前状态。
- DP 手动上报、批量/逐个定时上报、随机值和多值轮询。
- Wi-Fi reset、EZ/AP 配网和常用扩展指令。
- 完整帧与 Raw 串口日志、协议语义解释和日志导出。
- 中文和英文界面切换。
- Windows、macOS 和 Ubuntu 构建及签名软件更新。

## 界面预览

### 主工作台

加载 Debugfile 并打开串口后，可以查看完整协议日志、网络状态和当前 DP，同时手动触发 DP 上报及 Wi-Fi 配网操作。

![中文主工作台](docs/images/zh-CN/main-workbench.png)

### 定时上报

定时任务支持多个 DP、固定或随机周期、手动值轮询、随机值、执行次数和网络状态触发。

![中文定时上报](docs/images/zh-CN/scheduled-reports.png)

### 设置菜单

设置菜单集中提供相关指令、定时上报、界面语言和软件更新入口。

![中文设置菜单](docs/images/zh-CN/settings-menu.png)

## 开发

要求 Node.js 20+、Rust stable 和对应平台的 Tauri 构建依赖。

```bash
npm install
npm run tauri:dev
```

常用检查：

```bash
npm run lint
npm run format:check
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

## 使用

1. 使用 USB-TTL 连接模组协议串口并共地。
2. 打开应用，手动选择 Debugfile JSON。
3. 选择串口和波特率，默认波特率为 `9600`。
4. 点击“开始调试”，观察初始化、配网和 DP 交互日志。

详细实现见[开发指南](docs/tuya-mcu-simulator-development-guide.md)，发布与自动更新见[发布指南](docs/software-update-release-guide.md)。

## 贡献与安全

提交代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要在 Issue 中公开密钥或设备凭据。

## 许可证

本项目使用 [MIT License](LICENSE)。第三方依赖声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
