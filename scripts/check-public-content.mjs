import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ignored = new Set([".git", "dist", "node_modules", "target"]);
const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".rs",
  ".toml",
  ".ts",
  ".tsx",
  ".yml",
  ".yaml",
]);
const forbidden = [
  { label: "legacy brand", pattern: /BestQI/gi },
  { label: "legacy corporate email", pattern: /[\w.+-]+@bestqi\.com/gi },
  { label: "local workspace path", pattern: /D:\\bestqi\\/gi },
  { label: "legacy repository", pattern: /dbdb8\/tuya-mcu-simulator(?!-assistant)/gi },
  { label: "private key", pattern: /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/g },
];

const failures = [];
await scan(process.cwd());
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Public content scan passed.");

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(fullPath);
      continue;
    }
    if (!textExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    // 扫描规则文件本身包含禁止关键词正则，跳过自身以避免稳定的自报误报。
    if (entry.name === "check-public-content.mjs") continue;
    const content = await readFile(fullPath, "utf8");
    for (const rule of forbidden) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(content))
        failures.push(`${path.relative(process.cwd(), fullPath)}: ${rule.label}`);
    }
  }
}
