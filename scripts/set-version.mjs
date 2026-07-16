import fs from "node:fs";
import prettier from "prettier";

async function writeFormattedJson(path, value) {
  // 版本脚本必须输出与 CI 相同的 Prettier 格式，避免数组换行等细节导致发布提交检查失败。
  const projectOptions = (await prettier.resolveConfig(path)) ?? {};
  const content = await prettier.format(JSON.stringify(value), { ...projectOptions, filepath: path });
  fs.writeFileSync(path, content);
}

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
  throw new Error("用法：npm run version:set -- 0.2.0");

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
packageJson.version = version;
await writeFormattedJson("package.json", packageJson);

const tauriConfig = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
tauriConfig.version = version;
await writeFormattedJson("src-tauri/tauri.conf.json", tauriConfig);

const cargoPath = "src-tauri/Cargo.toml";
const cargo = fs
  .readFileSync(cargoPath, "utf8")
  .replace(/(^\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m, `$1"${version}"`);
fs.writeFileSync(cargoPath, cargo);
console.log(`版本已同步为 ${version}；发布前请运行 cargo check 更新 Cargo.lock。`);
