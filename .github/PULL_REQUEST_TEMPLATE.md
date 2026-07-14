## Summary

Describe the change and its user-visible effect.

## Validation

- [ ] `npm run check`
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`

## Protocol impact

List any changed command, payload, timing, or DP behavior. Write `None` for UI-only changes.
