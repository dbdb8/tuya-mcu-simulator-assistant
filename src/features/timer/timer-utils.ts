import { invoke } from "@tauri-apps/api/core";
import { downloadDir, join } from "@tauri-apps/api/path";
import { STORAGE_KEYS } from "../../constants";
import type { AppError, DpPoint, DpSchema, NetworkStatus } from "../../types";
import type { NetworkGate, TimerDpItem, TimerStatus, TimerTask, TimingMode } from "./types";
import { formatLogTimeForFilename } from "../../utils/log-utils";
import i18n from "../../i18n";

export function defaultTimerItem(point: DpPoint): TimerDpItem {
  const defaults = valueRange(point);
  return {
    id: makeId("dp"),
    dpCode: point.code,
    valueMode: "manual",
    manualValues: defaultManualValue(point),
    manualIndex: 0,
    randomMin: defaults.min,
    randomMax: defaults.max,
    randomCandidates: "",
  };
}

export function defaultManualValue(point: DpPoint) {
  if (point.kind === "bool") return "true,false";
  if (point.kind === "enum") {
    const range = enumRange(point);
    return range.length ? range.join(",") : "0";
  }
  if (point.kind === "raw") return "";
  return String(point.property?.defaultValue ?? 0);
}

export function validateTimerTask(
  task: TimerTask,
  schema: DpSchema | null,
  serialOpen: boolean,
): AppError | null {
  if (!schema) {
    return {
      code: "dp_file_required",
      title: i18n.t("timerValidation.loadDpTitle"),
      message: i18n.t("timerValidation.loadDpMessage"),
      detail: "schema is empty",
      suggestion: i18n.t("timerValidation.loadDpSuggestion"),
    };
  }
  if (!serialOpen) {
    return {
      code: "command_requires_serial",
      title: i18n.t("timerValidation.openSerialTitle"),
      message: i18n.t("timerValidation.openSerialMessage"),
      detail: "serial is closed",
      suggestion: i18n.t("timerValidation.openSerialSuggestion"),
    };
  }
  if (task.items.length === 0) {
    return {
      code: "timer_task_empty",
      title: i18n.t("timerValidation.emptyTitle"),
      message: i18n.t("timerValidation.emptyMessage"),
      detail: `task=${task.name}`,
      suggestion: i18n.t("timerValidation.emptySuggestion"),
    };
  }
  return null;
}

export function validateTimerTaskConfig(task: TimerTask, schema: DpSchema | null): AppError | null {
  if (!schema) return null;
  const timingError = validateTiming(task);
  if (timingError) return timerConfigError(task, timingError);
  if (task.maxRuns !== null && (!Number.isFinite(task.maxRuns) || task.maxRuns < 1))
    return timerConfigError(task, i18n.t("timerValidation.maxRuns"));
  if (
    task.networkGate === "specific" &&
    (!Number.isFinite(task.networkSpecificCode) ||
      (task.networkSpecificCode ?? 0) < 0 ||
      (task.networkSpecificCode ?? 0) > 255)
  ) {
    return timerConfigError(task, i18n.t("timerValidation.networkCode"));
  }
  for (const item of task.items) {
    const point = schema.points.find((dp) => dp.code === item.dpCode);
    if (!point) return timerConfigError(task, i18n.t("timerValidation.missingDp", { code: item.dpCode }));
    if (item.valueMode === "manual") {
      const values = splitValues(item.manualValues);
      if (values.length === 0)
        return timerConfigError(task, i18n.t("timerValidation.emptyManual", { id: point.id }));
      for (const token of values) {
        const error = validateDpToken(point, token);
        if (error) return timerConfigError(task, `DP${point.id} ${error}`);
      }
    } else {
      const error = validateRandomConfig(point, item);
      if (error) return timerConfigError(task, `DP${point.id} ${error}`);
    }
  }
  return null;
}

export function timerTaskRequiredHint(task: TimerTask, schema: DpSchema | null, serialOpen: boolean) {
  const required = validateTimerTask(task, schema, serialOpen);
  if (required) return required.message;
  const config = validateTimerTaskConfig(task, schema);
  return config?.message ?? "";
}

export function timingEditorError(task: TimerTask, field: "delay" | "interval") {
  if (field === "delay") {
    if (task.delayMode === "fixed" && task.delaySeconds < 0) return i18n.t("timerValidation.delayNegative");
    if (task.delayMode === "random" && task.delayMinSeconds > task.delayMaxSeconds)
      return i18n.t("timerValidation.minMax");
  }
  if (task.intervalMode === "fixed" && task.intervalSeconds < 0)
    return i18n.t("timerValidation.intervalNegative");
  if (task.intervalMode === "random" && task.intervalMinSeconds > task.intervalMaxSeconds)
    return i18n.t("timerValidation.minMax");
  return "";
}

export function timerItemError(item: TimerDpItem, schema: DpSchema | null) {
  if (!schema) return "";
  const point = schema.points.find((dp) => dp.code === item.dpCode);
  if (!point) return i18n.t("timerValidation.missingDp", { code: item.dpCode });
  if (item.valueMode === "manual") {
    const values = splitValues(item.manualValues);
    if (values.length === 0) return i18n.t("timerValidation.emptyManual", { id: point.id });
    for (const token of values) {
      const error = validateDpToken(point, token);
      if (error) return error;
    }
    return "";
  }
  return validateRandomConfig(point, item);
}

export function validateTiming(task: TimerTask) {
  if (task.delayMode === "fixed" && task.delaySeconds < 0) return i18n.t("timerValidation.delayNegative");
  if (task.intervalMode === "fixed" && task.intervalSeconds < 0)
    return i18n.t("timerValidation.intervalNegative");
  if (task.delayMode === "random" && task.delayMinSeconds > task.delayMaxSeconds)
    return i18n.t("timerValidation.delayMinMax");
  if (task.intervalMode === "random" && task.intervalMinSeconds > task.intervalMaxSeconds)
    return i18n.t("timerValidation.intervalMinMax");
  return "";
}

export function timerConfigError(task: TimerTask, message: string): AppError {
  return {
    code: "timer_config_invalid",
    title: i18n.t("timerValidation.configTitle"),
    message,
    detail: `task=${task.name}`,
    suggestion: i18n.t("timerValidation.configSuggestion"),
  };
}

export function validateDpToken(point: DpPoint, token: string) {
  const text = token.trim();
  if (point.kind === "bool" && !["true", "false", "1", "0", "开", "关"].includes(text)) {
    return i18n.t("timerValidation.invalidBool", { value: text });
  }
  if ((point.kind === "value" || point.kind === "bitmap") && !Number.isFinite(Number(text))) {
    return i18n.t("timerValidation.invalidNumber", { value: text });
  }
  if (point.kind === "enum") {
    const range = enumRange(point);
    const index = Number(text);
    if (!range.includes(text) && !(Number.isInteger(index) && index >= 0 && index < range.length)) {
      return i18n.t("timerValidation.invalidEnum", { value: text });
    }
  }
  if (point.kind === "raw" && !isValidHex(text)) {
    return i18n.t("timerValidation.invalidRaw", { value: text });
  }
  return "";
}

export function validateRandomConfig(point: DpPoint, item: TimerDpItem) {
  if (point.kind === "value" || point.kind === "bitmap") {
    const defaults = valueRange(point);
    const min = Number(item.randomMin ?? defaults.min);
    const max = Number(item.randomMax ?? defaults.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return i18n.t("timerValidation.randomNumber");
    if (min > max) return i18n.t("timerValidation.randomMinMax");
    if (defaults.step <= 0) return i18n.t("timerValidation.invalidStep");
  }
  if (point.kind === "raw") {
    const candidates = splitValues(item.randomCandidates ?? "");
    if (candidates.length === 0) return i18n.t("timerValidation.rawCandidates");
    const bad = candidates.find((candidate) => !isValidHex(candidate));
    if (bad) return i18n.t("timerValidation.invalidRawCandidate", { value: bad });
  }
  return "";
}

export function buildTimerPatches(task: TimerTask, schema: DpSchema) {
  const nextItems = task.items.map((item) => ({ ...item }));
  const patches = nextItems.map((item) => {
    const point = schema.points.find((dp) => dp.code === item.dpCode);
    if (!point) return { code: item.dpCode, value: "" };
    const value = item.valueMode === "manual" ? nextManualValue(item, point) : randomDpValue(item, point);
    return { code: point.code, value };
  });
  return { patches, items: nextItems };
}

export function nextManualValue(item: TimerDpItem, point: DpPoint) {
  const tokens = splitValues(item.manualValues);
  const values = tokens.length ? tokens : [defaultManualValue(point)];
  const token = values[item.manualIndex % values.length] ?? values[0] ?? "";
  // 手动轮询的索引保存在任务配置里，下一轮继续取下一个候选值。
  item.manualIndex = (item.manualIndex + 1) % Math.max(values.length, 1);
  return parseDpToken(point, token);
}

export function randomDpValue(item: TimerDpItem, point: DpPoint) {
  if (point.kind === "bool") return Math.random() >= 0.5;
  if (point.kind === "enum") {
    const range = enumRange(point);
    return range.length ? range[randomInt(0, range.length - 1)] : 0;
  }
  if (point.kind === "value" || point.kind === "bitmap") {
    const defaults = valueRange(point);
    return randomSteppedInt(
      Number(item.randomMin ?? defaults.min),
      Number(item.randomMax ?? defaults.max),
      defaults.step,
    );
  }
  const candidates = splitValues(item.randomCandidates ?? "");
  if (point.kind === "raw") return candidates.length ? candidates[randomInt(0, candidates.length - 1)] : "";
  return candidates.length
    ? candidates[randomInt(0, candidates.length - 1)]
    : `auto-${randomInt(1000, 9999)}`;
}

export function parseDpToken(point: DpPoint, token: string) {
  const text = token.trim();
  if (point.kind === "bool") return text === "true" || text === "1" || text === "开";
  if (point.kind === "value" || point.kind === "bitmap") return Number(text || 0);
  if (point.kind === "enum") {
    const range = enumRange(point);
    if (range.includes(text)) return text;
    const index = Number(text);
    return Number.isFinite(index) && range[index] ? range[index] : text;
  }
  return text;
}

export function splitValues(text: string) {
  return text
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function enumRange(point: DpPoint) {
  return Array.isArray(point.property?.range) ? (point.property.range as string[]) : [];
}

export function valueRange(point: DpPoint) {
  const min = Number(point.property?.min ?? 0);
  const max = Number(point.property?.max ?? 100);
  const step = Number(point.property?.step ?? 1);
  const scale = Number(point.property?.scale ?? 0);
  return {
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 100,
    step: Number.isFinite(step) && step > 0 ? step : 1,
    scale: Number.isFinite(scale) ? scale : 0,
  };
}

export function pickTimingMs(mode: TimingMode, fixed: number, min: number, max: number) {
  const seconds =
    mode === "fixed"
      ? Math.max(0, fixed)
      : randomInt(Math.max(0, Math.min(min, max)), Math.max(0, Math.max(min, max)));
  return seconds * 1000;
}

export function randomInt(min: number, max: number) {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return low + Math.floor(Math.random() * (high - low + 1));
}

export function randomSteppedInt(min: number, max: number, step: number) {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  const safeStep = Math.max(1, Math.floor(step));
  const slots = Math.max(0, Math.floor((high - low) / safeStep));
  // value/bitmap 协议当前按整数上报；scale 仅展示提示，随机值按 step 对齐避免生成非法档位。
  return low + randomInt(0, slots) * safeStep;
}

export function summarizeTimerPatches(taskName: string, patches: Array<{ code: string; value: unknown }>) {
  const details = patches.map((patch) => `${patch.code}=${String(patch.value)}`).join("，");
  const text = `${i18n.t("timer.title")}: ${taskName}, ${details}`;
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

export async function sendTimerPatches(task: TimerTask, patches: Array<{ code: string; value: unknown }>) {
  if (task.reportMode === "sequential") {
    for (const patch of patches) {
      await invoke("report_dp_batch", {
        patches: [patch],
        title: summarizeTimerPatches(`${task.name}[${i18n.t("timer.sequential")}]`, [patch]),
      });
    }
    return;
  }
  await invoke("report_dp_batch", {
    patches,
    title: summarizeTimerPatches(`${task.name}[${i18n.t("timer.batch")}]`, patches),
  });
}

export function canRunByNetwork(task: TimerTask, network: NetworkStatus) {
  if (task.networkGate === "none") return true;
  if (task.networkGate === "cloud") return network.code === 0x04;
  if (task.networkGate === "router_or_above") return network.code === 0x03 || network.code === 0x04;
  return network.code === (task.networkSpecificCode ?? 0x04);
}

export function networkGateText(task: TimerTask) {
  if (task.networkGate === "cloud") return i18n.t("timer.cloud");
  if (task.networkGate === "router_or_above") return i18n.t("timer.router");
  if (task.networkGate === "specific")
    return `${i18n.t("timer.stateCode")} 0x${(task.networkSpecificCode ?? 0x04).toString(16).padStart(2, "0").toUpperCase()}`;
  return i18n.t("timer.none");
}

export function isValidHex(text: string) {
  const clean = text.replace(/\s+/g, "");
  return clean.length > 0 && clean.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(clean);
}

export function timerStatusText(task: TimerTask) {
  if (task.status === "waiting" && task.nextRunAt) {
    const seconds = Math.max(0, Math.ceil((task.nextRunAt - Date.now()) / 1000));
    return i18n.t("timer.waitingSeconds", { seconds });
  }
  const labels: Record<TimerStatus, string> = {
    idle: i18n.t("timer.statuses.idle"),
    waiting: i18n.t("timer.statuses.waiting"),
    network_wait: i18n.t("timer.statuses.network"),
    running: i18n.t("timer.statuses.running"),
    paused: i18n.t("timer.statuses.paused"),
    completed: i18n.t("timer.statuses.completed"),
    error: i18n.t("timer.statuses.error"),
  };
  return labels[task.status];
}

export function loadTimerTasks(): TimerTask[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.timerTasks);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    // 重启后恢复任务配置但不自动启动，避免打开应用后误发 DP。
    return parsed.map((task) =>
      normalizeTimerTask({ ...task, enabled: false, status: "idle", nextRunAt: null }),
    );
  } catch {
    return [];
  }
}

export function saveTimerTasks(tasks: TimerTask[]) {
  try {
    const persisted = tasks.map((task) =>
      normalizeTimerTask({ ...task, enabled: false, status: "idle", nextRunAt: null, lastError: undefined }),
    );
    localStorage.setItem(STORAGE_KEYS.timerTasks, JSON.stringify(persisted));
  } catch {
    // localStorage 不可用时不影响串口调试主流程。
  }
}

export function normalizeTimerTask(raw: Partial<TimerTask> & { items?: TimerDpItem[] }): TimerTask {
  // 新版任务字段集中在这里补齐，保证旧 localStorage 和导入文件不需要迁移即可继续使用。
  return {
    id: raw.id || makeId("task"),
    name: raw.name || i18n.t("timer.title"),
    groupName: raw.groupName || i18n.t("timer.defaultGroup"),
    enabled: false,
    status: "idle",
    maxRuns: typeof raw.maxRuns === "number" && raw.maxRuns > 0 ? raw.maxRuns : null,
    runCount: Number.isFinite(raw.runCount) ? Number(raw.runCount) : 0,
    reportMode: raw.reportMode === "sequential" ? "sequential" : "batch",
    networkGate: ["cloud", "router_or_above", "specific"].includes(String(raw.networkGate))
      ? (raw.networkGate as NetworkGate)
      : "none",
    networkSpecificCode: typeof raw.networkSpecificCode === "number" ? raw.networkSpecificCode : 0x04,
    delayMode: raw.delayMode === "random" ? "random" : "fixed",
    delaySeconds: Number(raw.delaySeconds ?? 0),
    delayMinSeconds: Number(raw.delayMinSeconds ?? 0),
    delayMaxSeconds: Number(raw.delayMaxSeconds ?? 10),
    intervalMode: raw.intervalMode === "random" ? "random" : "fixed",
    intervalSeconds: Number(raw.intervalSeconds ?? 10),
    intervalMinSeconds: Number(raw.intervalMinSeconds ?? 5),
    intervalMaxSeconds: Number(raw.intervalMaxSeconds ?? 30),
    nextRunAt: null,
    lastError: raw.lastError,
    items: Array.isArray(raw.items)
      ? raw.items.map((item) => ({
          ...item,
          id: item.id || makeId("dp"),
          manualIndex: Number(item.manualIndex ?? 0),
        }))
      : [],
  };
}

export function parseTimerImport(content: string, schema: DpSchema | null) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw {
      code: "timer_import_invalid_json",
      title: i18n.t("timerValidation.importTitle"),
      message: i18n.t("timerValidation.invalidJson"),
      detail: String(err),
      suggestion: i18n.t("timerValidation.invalidJsonSuggestion"),
    } satisfies AppError;
  }
  const parsedObject = parsed && typeof parsed === "object" ? (parsed as { tasks?: unknown }) : {};
  const rawTasks = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsedObject.tasks)
      ? parsedObject.tasks
      : [];
  if (rawTasks.length === 0) {
    throw {
      code: "timer_import_empty",
      title: i18n.t("timerValidation.importTitle"),
      message: i18n.t("timerValidation.emptyImport"),
      detail: content.slice(0, 200),
      suggestion: i18n.t("timerValidation.emptyImportSuggestion"),
    } satisfies AppError;
  }
  return rawTasks.map((task) => {
    const normalized = normalizeTimerTask(task as Partial<TimerTask>);
    const missing = schema
      ? normalized.items.find((item) => !schema.points.some((point) => point.code === item.dpCode))
      : undefined;
    return missing
      ? {
          ...normalized,
          status: "error" as TimerStatus,
          lastError: i18n.t("timerValidation.importedMissingDp", { code: missing.dpCode }),
        }
      : normalized;
  });
}

export function groupTimerTasks(tasks: TimerTask[]): Array<[string, TimerTask[]]> {
  const groups = new Map<string, TimerTask[]>();
  for (const task of tasks) {
    const group = task.groupName || i18n.t("timer.defaultGroup");
    groups.set(group, [...(groups.get(group) ?? []), task]);
  }
  return Array.from(groups.entries());
}

export async function defaultTimerExportPath() {
  const filename = `tuya-timer-tasks-${formatLogTimeForFilename(Date.now())}.json`;
  try {
    return await join(await downloadDir(), filename);
  } catch {
    return filename;
  }
}

export function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
