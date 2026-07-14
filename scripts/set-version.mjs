import fs from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
  throw new Error("用法：npm run version:set -- 0.2.0");

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
packageJson.version = version;
fs.writeFileSync("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);

const tauriConfig = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
tauriConfig.version = version;
fs.writeFileSync("src-tauri/tauri.conf.json", `${JSON.stringify(tauriConfig, null, 2)}\n`);

const cargoPath = "src-tauri/Cargo.toml";
const cargo = fs
  .readFileSync(cargoPath, "utf8")
  .replace(/(^\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m, `$1"${version}"`);
fs.writeFileSync(cargoPath, cargo);
console.log(`版本已同步为 ${version}；发布前请运行 cargo check 更新 Cargo.lock。`);
