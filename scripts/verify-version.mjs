import fs from "node:fs";

const packageVersion = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const tauriVersion = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
const cargoVersion = fs.readFileSync("src-tauri/Cargo.toml", "utf8").match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (new Set([packageVersion, tauriVersion, cargoVersion]).size !== 1)
  throw new Error(`版本不一致：package=${packageVersion}, tauri=${tauriVersion}, cargo=${cargoVersion}`);

const tag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
if (tag?.startsWith("v") && tag.slice(1) !== packageVersion)
  throw new Error(`Release tag ${tag} 与应用版本 ${packageVersion} 不一致`);
if (tag?.startsWith("v")) {
  const publicKey = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8")).plugins?.updater?.pubkey;
  if (!publicKey || publicKey.includes("REPLACE_WITH"))
    throw new Error("发布已阻止：请先生成 updater 密钥，并把公钥写入 tauri.conf.json");
}
console.log(`版本校验通过：${packageVersion}`);
