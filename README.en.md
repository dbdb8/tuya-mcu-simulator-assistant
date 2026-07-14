# Tuya MCU Simulator Assistant

[中文](README.md) | [English](README.en.md)

A cross-platform desktop tool built with Tauri, React, and Rust. It connects a computer to a physical module through USB-TTL and simulates the device MCU for Tuya-compatible serial protocol and DP testing.

> This is an independent, unofficial open-source project. It is not affiliated with, authorized by, or endorsed by Tuya Inc. “Tuya”, “涂鸦”, and related marks belong to their respective owners.

## Features

- Loads a Tuya Debugfile JSON manually; no device profile is bundled.
- Handles `55 AA` frames, heartbeat, product info, work mode, network state, and DP queries.
- Stores DP downloads and actively reports the resulting state.
- Supports manual, scheduled, batch, and sequential DP reports.
- Provides Wi-Fi reset, EZ/AP provisioning, and common extension commands.
- Shows complete-frame and raw serial logs with protocol explanations.
- Switches between Simplified Chinese and English.
- Builds for Windows, macOS, and Ubuntu with signed application updates.

## Development

Node.js 20+, Rust stable, and the platform-specific Tauri build dependencies are required.

```bash
npm install
npm run tauri:dev
```

Run the project checks before submitting changes:

```bash
npm run lint
npm run format:check
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

See the [development guide](docs/tuya-mcu-simulator-development-guide.en.md) and [release guide](docs/software-update-release-guide.en.md) for details.

## License

Licensed under the [MIT License](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party notices.
