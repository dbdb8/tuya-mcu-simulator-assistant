import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] || "release-assets";
const repository = process.env.GITHUB_REPOSITORY || "dbdb8/tuya-mcu-simulator-assistant";
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const tag = process.env.RELEASE_TAG || `v${version}`;
const notesPath = process.env.RELEASE_NOTES_FILE || "release-notes.txt";
const notes = fs.existsSync(notesPath)
  ? fs.readFileSync(notesPath, "utf8").trim()
  : `Tuya MCU Simulator ${tag}`;
const files = walk(root);
const platforms = {};

addPlatform("windows-x86_64", find([/-setup\.exe$/i, /\.msi$/i, /\.nsis\.zip$/i, /\.msi\.zip$/i]));
const macArtifact = find([/\.app\.tar\.gz$/i, /\.dmg$/i]);
// universal 包同时服务 Intel 和 Apple Silicon，但 updater 运行时仍按当前 CPU 请求对应平台键。
addPlatform("darwin-x86_64", macArtifact);
addPlatform("darwin-aarch64", macArtifact);
addPlatform("linux-x86_64", find([/\.AppImage$/i, /\.AppImage\.tar\.gz$/i]));
for (const required of ["windows-x86_64", "darwin-x86_64", "darwin-aarch64", "linux-x86_64"])
  if (!platforms[required]) throw new Error(`缺少 updater 平台产物：${required}`);

fs.writeFileSync(
  path.join(root, "latest.json"),
  `${JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms }, null, 2)}\n`,
);
console.log(`已生成 ${root}/latest.json`);

function addPlatform(key, artifact) {
  if (!artifact) return;
  const signaturePath = `${artifact}.sig`;
  if (!fs.existsSync(signaturePath)) throw new Error(`缺少签名文件：${signaturePath}`);
  const name = path.basename(artifact);
  // GitHub Release 会把资产文件名中的空白规范化为点号；元数据必须使用上传后的真实名称，否则下载返回 404。
  const releaseAssetName = githubReleaseAssetName(name);
  platforms[key] = {
    signature: fs.readFileSync(signaturePath, "utf8").trim(),
    url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(releaseAssetName)}`,
  };
}

function githubReleaseAssetName(name) {
  return name.trim().replace(/\s+/g, ".");
}
function find(patterns) {
  for (const pattern of patterns) {
    const match = files.find((file) => pattern.test(file) && !file.endsWith(".sig"));
    if (match) return match;
  }
}
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const item = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(item) : [item];
  });
}
