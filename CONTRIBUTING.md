# Contributing

Thank you for contributing. Please open an issue before large protocol or UI changes.

1. Do not commit product Debugfiles, cloud credentials, signing keys, device identifiers, or private serial logs.
2. Keep protocol behavior generic unless a device-specific extension is clearly isolated.
3. Add Chinese comments for important business reasons, protocol boundaries, defaults, and compatibility behavior.
4. Run `npm run check` and `cargo test --manifest-path src-tauri/Cargo.toml` before opening a pull request.
5. Describe the hardware/module setup used for manual verification without publishing credentials or private product data.

By submitting a contribution, you agree that it is licensed under the MIT License.
