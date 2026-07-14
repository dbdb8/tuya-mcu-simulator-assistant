import { invoke } from "@tauri-apps/api/core";
import { downloadDir, join } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import type { AppError, NetworkStatus, SerialLog } from "../types";
import i18n from "../i18n";

export async function saveLogs(logs: SerialLog[]) {
  const orderedLogs = [...logs].reverse();
  const content = formatLogsForExport(orderedLogs);
  const defaultPath = await defaultLogSavePath(orderedLogs);
  const selected = await save({
    defaultPath,
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (!selected) return;
  await invoke("save_log_file", { path: selected, content });
}

export function mergeIncomingLog(next: SerialLog, current: SerialLog[]) {
  if (!next.raw) {
    return [next, ...current].slice(0, 600);
  }

  const [head, ...rest] = current;
  if (head?.raw && head.direction === next.direction && head.title === next.title) {
    // Raw 日志是串口 read 的底层分片，连续分片聚合展示，避免用户把 1 字节 read 误判为协议接收截断。
    const merged: SerialLog = {
      ...head,
      hex: trimMergedRaw(`${head.hex} ${next.hex}`),
    };
    return [merged, ...rest].slice(0, 600);
  }

  return [next, ...current].slice(0, 600);
}

export function formatLogTime(timestampMs: number) {
  if (!timestampMs) return "";
  const date = new Date(Number(timestampMs));
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function formatLogTimeForFilename(timestampMs: number) {
  const date = new Date(Number(timestampMs || Date.now()));
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function formatLogsForExport(logs: SerialLog[]) {
  if (logs.length === 0) {
    return i18n.t("logs.empty");
  }
  return logs
    .map((log) => {
      const command =
        typeof log.command === "number"
          ? ` CMD 0x${log.command.toString(16).padStart(2, "0").toUpperCase()}`
          : "";
      return `[${formatLogTime(log.timestamp_ms)}][${log.raw ? "raw" : "frame"}][${log.direction}] ${log.title}${command}\n${log.hex}`;
    })
    .join("\n\n");
}

export async function defaultLogSavePath(logs: SerialLog[]) {
  const start = logs[0]?.timestamp_ms || Date.now();
  const end = logs[logs.length - 1]?.timestamp_ms || start;
  const filename = `${formatLogTimeForFilename(start)}-${formatLogTimeForFilename(end)}.txt`;
  try {
    // 原生保存对话框默认打开下载目录，文件名使用日志开始/结束时间，便于和现场调试过程对应。
    return await join(await downloadDir(), filename);
  } catch {
    return filename;
  }
}

export function trimMergedRaw(hexText: string) {
  const parts = hexText.trim().split(/\s+/);
  const maxBytes = 160;
  if (parts.length <= maxBytes) return parts.join(" ");
  return `... ${parts.slice(parts.length - maxBytes).join(" ")}`;
}

export function normalizeError(err: unknown): AppError {
  if (typeof err === "object" && err && "code" in err && "title" in err) {
    return err as AppError;
  }
  if (typeof err === "string") {
    try {
      const parsed = JSON.parse(err);
      if (parsed && typeof parsed === "object" && "code" in parsed && "title" in parsed) {
        return parsed as AppError;
      }
    } catch {
      // 兼容 Tauri/系统直接返回字符串错误的情况，保留原文作为 detail 便于排查。
    }
    return {
      code: "unknown_error",
      title: i18n.t("errors.operation"),
      message: err,
      detail: err,
      suggestion: i18n.t("errors.inspect"),
    };
  }
  return {
    code: "unknown_error",
    title: i18n.t("errors.operation"),
    message: i18n.t("errors.unknown"),
    detail: JSON.stringify(err),
    suggestion: i18n.t("errors.retry"),
  };
}

export function copyError(error: AppError) {
  const text = `[${error.code}] ${error.title}\n${error.message}\n${i18n.t("logs.suggestion")}: ${error.suggestion}\n${i18n.t("logs.detail")}: ${error.detail}`;
  void navigator.clipboard?.writeText(text);
}

export function networkTime(network: NetworkStatus) {
  if (!network.updated_at_ms) return i18n.t("logs.networkPending");
  return i18n.t("logs.updatedAt", { time: new Date(network.updated_at_ms).toLocaleString(i18n.language) });
}

export function readStoredString(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

export function readStoredNumber(key: string, fallback: number) {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}
