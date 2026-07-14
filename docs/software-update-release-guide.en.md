# Software Update and Release Guide

[中文](./software-update-release-guide.md)

## Updater Signing Key

Tauri updater signatures are separate from Windows or Apple code-signing certificates. Store the private key outside the repository and commit only the public key in `src-tauri/tauri.conf.json`.

Configure these GitHub Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Do not rotate the updater key after public releases unless a deliberate migration strategy is prepared, because installed clients trust the existing public key.

## Publish a Version

```powershell
npm run version:set -- 0.2.0
npm run version:check
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
git add .
git commit -m "release: v0.2.0"
git tag v0.2.0
git push origin main
git push origin v0.2.0
```

The tag, `package.json`, `src-tauri/Cargo.toml`, and Tauri configuration versions must match. GitHub Actions builds native installers, updater artifacts, signatures, and `latest.json`.

Verify the public endpoint after release:

```text
https://github.com/dbdb8/tuya-mcu-simulator-assistant/releases/latest/download/latest.json
```

Windows, macOS, and Linux AppImage installations can update in-app. Debian package installations open the GitHub Release page for manual installation. Updater signing protects artifact integrity but does not replace Windows Authenticode signing or Apple notarization.
