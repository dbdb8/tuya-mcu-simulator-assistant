import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { AppError, DpSchema, NetworkStatus } from "../../types";
import type { PendingTimerImport, TimerDpItem, TimerScriptResponse, TimerTask } from "./types";
import {
  buildTimerPatches,
  canRunByNetwork,
  defaultTimerExportPath,
  defaultTimerItem,
  defaultTimerScript,
  groupTimerTasks,
  loadTimerTasks,
  makeId,
  networkGateText,
  normalizeTimerTask,
  parseTimerImport,
  pickTimingMs,
  saveTimerTasks,
  sendTimerPatches,
  validateTimerTask,
  validateTimerTaskConfig,
} from "./timer-utils";
import { normalizeError } from "../../utils/log-utils";
import i18n from "../../i18n";

type Options = {
  schema: DpSchema | null;
  serialOpen: boolean;
  network: NetworkStatus;
  showError: (error: AppError) => void;
  setStatus: (status: string) => void;
};

export function useTimerTasks({ schema, serialOpen, network, showError, setStatus }: Options) {
  const [timerTasks, setTimerTasks] = useState<TimerTask[]>(() => loadTimerTasks());
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [collapsedTasks, setCollapsedTasks] = useState<Record<string, boolean>>({});
  const [pendingTimerImport, setPendingTimerImport] = useState<PendingTimerImport | null>(null);
  const [scriptPreviews, setScriptPreviews] = useState<
    Record<string, { loading: boolean; result?: TimerScriptResponse; error?: string }>
  >({});
  const [, setTimerNow] = useState(Date.now());
  const tasksRef = useRef<TimerTask[]>(timerTasks);
  const schemaRef = useRef<DpSchema | null>(schema);
  const serialOpenRef = useRef(serialOpen);
  const networkRef = useRef<NetworkStatus>(network);
  const pausedTaskIdsRef = useRef(new Set<string>());

  useEffect(() => {
    tasksRef.current = timerTasks;
    saveTimerTasks(timerTasks);
  }, [timerTasks]);
  useEffect(() => {
    schemaRef.current = schema;
  }, [schema]);
  useEffect(() => {
    serialOpenRef.current = serialOpen;
  }, [serialOpen]);
  useEffect(() => {
    networkRef.current = network;
  }, [network]);

  useEffect(() => {
    const ticker = window.setInterval(() => {
      const now = Date.now();
      // 倒计时刷新不修改任务配置；到期后才进入真正的上报流程。
      setTimerNow(now);
      for (const task of tasksRef.current) {
        if (task.enabled && task.status === "waiting" && task.nextRunAt && task.nextRunAt <= now) {
          void runTimerTaskNow(task.id, true);
        }
      }
    }, 500);
    return () => window.clearInterval(ticker);
    // 调度器通过 ref 读取最新任务和环境，避免每次状态变化都重建 interval。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addTimerTask() {
    const firstPoint = schema?.points[0];
    const task: TimerTask = {
      id: makeId("task"),
      name: i18n.t("timer.defaultTask", { number: timerTasks.length + 1 }),
      groupName: i18n.t("timer.defaultGroup"),
      enabled: false,
      status: "idle",
      maxRuns: null,
      runCount: 0,
      reportMode: "batch",
      generationMode: "items",
      networkGate: "none",
      delayMode: "fixed",
      delaySeconds: 0,
      delayMinSeconds: 0,
      delayMaxSeconds: 10,
      intervalMode: "fixed",
      intervalSeconds: 10,
      intervalMinSeconds: 5,
      intervalMaxSeconds: 30,
      nextRunAt: null,
      items: firstPoint ? [defaultTimerItem(firstPoint)] : [],
    };
    setTimerTasks((current) => [...current, task]);
  }

  function patchTimerTask(taskId: string, patch: Partial<TimerTask>) {
    setTimerTasks((current) => current.map((task) => (task.id === taskId ? { ...task, ...patch } : task)));
  }

  function duplicateTimerTask(taskId: string) {
    const task = tasksRef.current.find((item) => item.id === taskId);
    if (!task) return;
    // 复制任务只复制配置，不复制运行态，防止用户复制后立刻误发 DP。
    const copy = normalizeTimerTask({
      ...task,
      id: makeId("task"),
      name: `${task.name} ${i18n.t("timer.copySuffix")}`,
      enabled: false,
      status: "idle",
      nextRunAt: null,
      runCount: 0,
      lastError: undefined,
      items: task.items.map((item) => ({ ...item, id: makeId("dp") })),
      script: task.script
        ? {
            ...task.script,
            initialState: structuredClone(task.script.initialState),
            state: structuredClone(task.script.initialState),
          }
        : undefined,
    });
    setTimerTasks((current) => [...current, copy]);
    setCollapsedTasks((current) => ({ ...current, [copy.id]: true }));
  }

  function toggleTimerGroup(groupName: string) {
    setCollapsedGroups((current) => ({ ...current, [groupName]: !(current[groupName] ?? true) }));
  }

  function isTimerGroupCollapsed(groupName: string) {
    return collapsedGroups[groupName] ?? true;
  }

  function expandAllTimerGroups() {
    setCollapsedGroups(Object.fromEntries(groupedTimerTasks.map(([groupName]) => [groupName, false])));
  }

  function collapseAllTimerGroups() {
    setCollapsedGroups(Object.fromEntries(groupedTimerTasks.map(([groupName]) => [groupName, true])));
  }

  function toggleTimerTask(taskId: string) {
    setCollapsedTasks((current) => ({ ...current, [taskId]: !(current[taskId] ?? true) }));
  }

  function isTimerTaskCollapsed(taskId: string) {
    return collapsedTasks[taskId] ?? true;
  }

  function expandAllTimerTasks() {
    setCollapsedTasks(Object.fromEntries(tasksRef.current.map((task) => [task.id, false])));
  }

  function collapseAllTimerTasks() {
    setCollapsedTasks(Object.fromEntries(tasksRef.current.map((task) => [task.id, true])));
  }

  async function exportTimerTasks() {
    const selected = await save({
      defaultPath: await defaultTimerExportPath(),
      filters: [{ name: "Timer Tasks", extensions: ["json"] }],
    });
    if (!selected) return;
    const payload = {
      version: 3,
      exported_at: new Date().toISOString(),
      product_key: schema?.product_key ?? null,
      tasks: timerTasks.map((task) => normalizeTimerTask(task)),
    };
    await invoke("save_log_file", { path: selected, content: JSON.stringify(payload, null, 2) });
    setStatus(i18n.t("timer.exported", { count: timerTasks.length }));
  }

  async function importTimerTasks() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Timer Tasks", extensions: ["json"] }],
    });
    if (typeof selected !== "string") return;
    const content = await invoke<string>("load_text_file", { path: selected });
    const imported = parseTimerImport(content, schema);
    const scriptTasks = imported
      .filter((task) => task.generationMode === "script" && task.script)
      .map((task) => ({
        name: task.name,
        sourceBytes: new TextEncoder().encode(task.script!.source).length,
      }));
    if (scriptTasks.length) {
      // 导入脚本任务前必须展示摘要；QuickJS 虽然无外部权限，用户仍应知道任务包含可执行逻辑。
      setPendingTimerImport({ tasks: imported, sourcePath: selected, scriptTasks });
      return;
    }
    applyImportedTasks(imported);
  }

  function applyImportedTasks(tasks: TimerTask[]) {
    setTimerTasks(tasks);
    // 导入后默认收起分组和任务，避免大批配置及脚本编辑器一次渲染造成操作区过长。
    setCollapsedGroups({});
    setCollapsedTasks({});
    setPendingTimerImport(null);
    setStatus(i18n.t("timer.imported", { count: tasks.length }));
  }

  function confirmTimerImport() {
    if (pendingTimerImport) applyImportedTasks(pendingTimerImport.tasks);
  }

  function cancelTimerImport() {
    setPendingTimerImport(null);
  }

  function removeTimerTask(taskId: string) {
    setTimerTasks((current) => current.filter((task) => task.id !== taskId));
    setCollapsedTasks((current) => {
      const next = { ...current };
      delete next[taskId];
      return next;
    });
  }

  function clearTimerTasks() {
    // 一键清理用于现场重新配置场景，直接清空内存和 localStorage 中的任务列表，不影响串口连接与 DP 当前状态。
    setTimerTasks([]);
    setCollapsedGroups({});
    setCollapsedTasks({});
    setStatus(i18n.t("timer.cleared"));
  }

  function addTimerItem(taskId: string) {
    const firstPoint = schema?.points[0];
    if (!firstPoint) return;
    setTimerTasks((current) =>
      current.map((task) =>
        task.id === taskId
          ? {
              ...task,
              enabled: false,
              status: "idle",
              nextRunAt: null,
              items: [...task.items, defaultTimerItem(firstPoint)],
            }
          : task,
      ),
    );
  }

  function setGenerationMode(taskId: string, mode: TimerTask["generationMode"]) {
    setTimerTasks((current) =>
      current.map((task) =>
        task.id === taskId
          ? {
              ...task,
              generationMode: mode,
              script: mode === "script" ? (task.script ?? defaultTimerScript()) : task.script,
              enabled: false,
              status: "idle",
              nextRunAt: null,
            }
          : task,
      ),
    );
  }

  function updateTimerScript(taskId: string, patch: Partial<NonNullable<TimerTask["script"]>>) {
    setTimerTasks((current) =>
      current.map((task) =>
        task.id === taskId
          ? {
              ...task,
              script: { ...(task.script ?? defaultTimerScript()), ...patch },
              enabled: false,
              status: "idle",
              nextRunAt: null,
            }
          : task,
      ),
    );
  }

  function resetTimerScriptState(taskId: string) {
    const task = tasksRef.current.find((item) => item.id === taskId);
    if (!task?.script) return;
    updateTimerScript(taskId, { state: structuredClone(task.script.initialState) });
    setScriptPreviews((current) => ({ ...current, [taskId]: { loading: false } }));
  }

  async function previewTimerScript(taskId: string) {
    const task = tasksRef.current.find((item) => item.id === taskId);
    if (!task?.script || !schemaRef.current) return;
    setScriptPreviews((current) => ({ ...current, [taskId]: { loading: true } }));
    try {
      const result = await executeTimerScript(task, true);
      setScriptPreviews((current) => ({ ...current, [taskId]: { loading: false, result } }));
    } catch (err) {
      const nextError = normalizeError(err);
      setScriptPreviews((current) => ({
        ...current,
        [taskId]: { loading: false, error: `${nextError.title}: ${nextError.detail}` },
      }));
      showError(nextError);
    }
  }

  function updateTimerItem(taskId: string, itemId: string, patch: Partial<TimerDpItem>) {
    setTimerTasks((current) =>
      current.map((task) =>
        task.id === taskId
          ? {
              ...task,
              enabled: false,
              status: task.enabled ? "paused" : task.status,
              nextRunAt: null,
              items: task.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
            }
          : task,
      ),
    );
  }

  function removeTimerItem(taskId: string, itemId: string) {
    setTimerTasks((current) =>
      current.map((task) =>
        task.id === taskId
          ? {
              ...task,
              enabled: false,
              status: "idle",
              nextRunAt: null,
              items: task.items.filter((item) => item.id !== itemId),
            }
          : task,
      ),
    );
  }

  function startTimerTask(taskId: string) {
    const task = tasksRef.current.find((item) => item.id === taskId);
    if (!task) return;
    pausedTaskIdsRef.current.delete(taskId);
    const validation = validateTimerTask(task, schema, serialOpen) ?? validateTimerTaskConfig(task, schema);
    if (validation) {
      // 用户主动启动时直接展开错误任务，让必填项和具体错误无需再次寻找。
      setCollapsedTasks((current) => ({ ...current, [taskId]: false }));
      showError(validation);
      patchTimerTask(taskId, {
        enabled: false,
        status: "error",
        lastError: validation.message,
        nextRunAt: null,
      });
      return;
    }
    if (!canRunByNetwork(task, network)) {
      patchTimerTask(taskId, {
        enabled: true,
        status: "network_wait",
        nextRunAt: null,
        lastError: i18n.t("timer.waitingNetwork", { condition: networkGateText(task) }),
      });
      return;
    }
    const delayMs = pickTimingMs(
      task.delayMode,
      task.delaySeconds,
      task.delayMinSeconds,
      task.delayMaxSeconds,
    );
    patchTimerTask(taskId, {
      enabled: true,
      status: "waiting",
      nextRunAt: Date.now() + delayMs,
      lastError: undefined,
    });
  }

  function pauseTimerTask(taskId: string, reason = i18n.t("timer.paused")) {
    pausedTaskIdsRef.current.add(taskId);
    patchTimerTask(taskId, { enabled: false, status: "paused", nextRunAt: null, lastError: reason });
  }

  function pauseAllTimerTasks(reason: string) {
    for (const task of tasksRef.current) {
      if (isActiveTimerTask(task)) pausedTaskIdsRef.current.add(task.id);
    }
    setTimerTasks((current) =>
      current.map((task) =>
        isActiveTimerTask(task)
          ? { ...task, enabled: false, status: "paused", nextRunAt: null, lastError: reason }
          : task,
      ),
    );
  }

  function startTimerGroup(groupName: string) {
    const groupTasks = tasksRef.current.filter((task) => task.groupName === groupName);
    const invalid = groupTasks
      .map((task) => ({
        task,
        error:
          validateTimerTask(task, schemaRef.current, serialOpenRef.current) ??
          validateTimerTaskConfig(task, schemaRef.current),
      }))
      .filter((item): item is { task: TimerTask; error: AppError } => Boolean(item.error));
    if (invalid.length) {
      // 分组启动采用整组原子校验，避免同一业务场景只启动部分任务。
      setCollapsedGroups((current) => ({ ...current, [groupName]: false }));
      setCollapsedTasks((current) => ({
        ...current,
        ...Object.fromEntries(invalid.map((item) => [item.task.id, false])),
      }));
      setTimerTasks((current) =>
        current.map((task) => {
          const matched = invalid.find((item) => item.task.id === task.id);
          return matched
            ? {
                ...task,
                enabled: false,
                status: "error",
                nextRunAt: null,
                lastError: matched.error.message,
              }
            : task;
        }),
      );
      const first = invalid[0]!.error;
      showError({
        ...first,
        message: i18n.t("timer.groupStartInvalid", {
          group: groupName,
          count: invalid.length,
          message: first.message,
        }),
        detail: invalid.map((item) => `${item.task.name}: ${item.error.message}`).join(" | "),
      });
      return;
    }

    const now = Date.now();
    for (const task of groupTasks) pausedTaskIdsRef.current.delete(task.id);
    setTimerTasks((current) =>
      current.map((task) => {
        if (task.groupName !== groupName || isActiveTimerTask(task)) return task;
        if (!canRunByNetwork(task, networkRef.current)) {
          return {
            ...task,
            enabled: true,
            status: "network_wait",
            nextRunAt: null,
            lastError: i18n.t("timer.waitingNetwork", { condition: networkGateText(task) }),
          };
        }
        const delayMs = pickTimingMs(
          task.delayMode,
          task.delaySeconds,
          task.delayMinSeconds,
          task.delayMaxSeconds,
        );
        return {
          ...task,
          enabled: true,
          status: "waiting",
          nextRunAt: now + delayMs,
          lastError: undefined,
        };
      }),
    );
    setStatus(i18n.t("timer.groupStarted", { group: groupName }));
  }

  function pauseTimerGroup(groupName: string) {
    for (const task of tasksRef.current) {
      if (task.groupName === groupName && isActiveTimerTask(task)) {
        pausedTaskIdsRef.current.add(task.id);
      }
    }
    setTimerTasks((current) =>
      current.map((task) =>
        task.groupName === groupName && isActiveTimerTask(task)
          ? {
              ...task,
              enabled: false,
              status: "paused",
              nextRunAt: null,
              lastError: i18n.t("timer.groupPaused", { group: groupName }),
            }
          : task,
      ),
    );
    setStatus(i18n.t("timer.groupPaused", { group: groupName }));
  }

  function isActiveTimerTask(task: TimerTask) {
    return task.enabled || ["waiting", "network_wait", "running"].includes(task.status);
  }

  function resumeNetworkWaitingTasks(nextNetwork: NetworkStatus) {
    setTimerTasks((current) =>
      current.map((task) => {
        if (task.enabled && task.status === "network_wait" && canRunByNetwork(task, nextNetwork)) {
          const delayMs = pickTimingMs(
            task.delayMode,
            task.delaySeconds,
            task.delayMinSeconds,
            task.delayMaxSeconds,
          );
          return { ...task, status: "waiting", nextRunAt: Date.now() + delayMs, lastError: undefined };
        }
        return task;
      }),
    );
  }

  async function runTimerTaskNow(taskId: string, keepSchedule: boolean) {
    const task = tasksRef.current.find((item) => item.id === taskId);
    const activeSchema = schemaRef.current;
    if (!task || task.status === "running") return;
    const originalNextRunAt = task.nextRunAt;
    const originalStatus = task.status;
    const validation =
      validateTimerTask(task, activeSchema, serialOpenRef.current) ??
      validateTimerTaskConfig(task, activeSchema);
    if (validation) {
      showError(validation);
      patchTimerTask(taskId, {
        enabled: false,
        status: "error",
        nextRunAt: null,
        lastError: validation.message,
      });
      return;
    }
    if (!canRunByNetwork(task, networkRef.current)) {
      patchTimerTask(taskId, {
        enabled: true,
        status: "network_wait",
        nextRunAt: null,
        lastError: i18n.t("timer.waitingNetwork", { condition: networkGateText(task) }),
      });
      return;
    }
    try {
      patchTimerTask(taskId, { status: "running", nextRunAt: null, lastError: undefined });
      const generated =
        task.generationMode === "script"
          ? await executeTimerScript(task, false)
          : { ...buildTimerPatches(task, activeSchema!), state: undefined, summary: undefined, skip: false };
      const items = "items" in generated ? generated.items : task.items;
      if (generated.skip) {
        // skip 用于脚本内部等待业务条件：保存脚本状态，但不计入成功上报次数。
        settleSkippedScript(task, generated.state ?? {}, keepSchedule, originalStatus, originalNextRunAt);
        return;
      }
      await sendTimerPatches(task, generated.patches, generated.summary);
      const nextRunCount = task.runCount + 1;
      const reachedLimit = typeof task.maxRuns === "number" && nextRunCount >= task.maxRuns;
      const pausedAfterSend = pausedTaskIdsRef.current.has(taskId);
      if (keepSchedule) {
        if (pausedAfterSend) {
          setTimerTasks((current) =>
            current.map((item) =>
              item.id === taskId
                ? {
                    ...item,
                    items,
                    script: nextScriptState(item, generated.state),
                    runCount: nextRunCount,
                    status: "paused",
                    enabled: false,
                    nextRunAt: null,
                    lastError: i18n.t("timer.paused"),
                  }
                : item,
            ),
          );
        } else if (reachedLimit) {
          setTimerTasks((current) =>
            current.map((item) =>
              item.id === taskId
                ? {
                    ...item,
                    items,
                    script: nextScriptState(item, generated.state),
                    runCount: nextRunCount,
                    status: "completed",
                    enabled: false,
                    nextRunAt: null,
                    lastError: i18n.t("timer.reachedLimit"),
                  }
                : item,
            ),
          );
        } else {
          const nextMs = pickTimingMs(
            task.intervalMode,
            task.intervalSeconds,
            task.intervalMinSeconds,
            task.intervalMaxSeconds,
          );
          setTimerTasks((current) =>
            current.map((item) =>
              item.id === taskId
                ? {
                    ...item,
                    items,
                    script: nextScriptState(item, generated.state),
                    runCount: nextRunCount,
                    status: "waiting",
                    enabled: true,
                    nextRunAt: Date.now() + nextMs,
                  }
                : item,
            ),
          );
        }
      } else {
        // “立即上报”用于验证配置：未启动任务不上周期，已启动任务保持原来的下次触发时间。
        setTimerTasks((current) =>
          current.map((item) =>
            item.id === taskId
              ? {
                  ...item,
                  items,
                  script: nextScriptState(item, generated.state),
                  runCount: nextRunCount,
                  status: pausedAfterSend
                    ? "paused"
                    : reachedLimit
                      ? "completed"
                      : task.enabled
                        ? originalStatus
                        : "idle",
                  enabled: pausedAfterSend || reachedLimit ? false : task.enabled,
                  nextRunAt: pausedAfterSend || reachedLimit ? null : task.enabled ? originalNextRunAt : null,
                  lastError: pausedAfterSend
                    ? i18n.t("timer.paused")
                    : reachedLimit
                      ? i18n.t("timer.reachedLimit")
                      : undefined,
                }
              : item,
          ),
        );
      }
      setStatus(i18n.t("timer.reported", { name: task.name }));
    } catch (err) {
      const nextError = normalizeError(err);
      showError(nextError);
      patchTimerTask(taskId, {
        enabled: false,
        status: "error",
        nextRunAt: null,
        lastError: nextError.message,
      });
    }
  }

  async function executeTimerScript(task: TimerTask, preview: boolean) {
    return invoke<TimerScriptResponse>("execute_timer_script", {
      request: {
        source: task.script?.source ?? "",
        state: task.script?.state ?? {},
        context: {
          taskId: task.id,
          taskName: task.name,
          runIndex: task.runCount + 1,
          nowMs: Date.now(),
        },
        preview,
      },
    });
  }

  function nextScriptState(task: TimerTask, state?: Record<string, unknown>) {
    return task.script && state ? { ...task.script, state } : task.script;
  }

  function settleSkippedScript(
    task: TimerTask,
    state: Record<string, unknown>,
    keepSchedule: boolean,
    originalStatus: TimerTask["status"],
    originalNextRunAt: number | null,
  ) {
    const paused = pausedTaskIdsRef.current.has(task.id);
    const nextRunAt = paused
      ? null
      : keepSchedule
        ? Date.now() +
          pickTimingMs(
            task.intervalMode,
            task.intervalSeconds,
            task.intervalMinSeconds,
            task.intervalMaxSeconds,
          )
        : task.enabled
          ? originalNextRunAt
          : null;
    setTimerTasks((current) =>
      current.map((item) =>
        item.id === task.id
          ? {
              ...item,
              script: nextScriptState(item, state),
              status: paused ? "paused" : keepSchedule ? "waiting" : task.enabled ? originalStatus : "idle",
              enabled: paused ? false : keepSchedule || task.enabled,
              nextRunAt,
              lastError: paused ? i18n.t("timer.paused") : undefined,
            }
          : item,
      ),
    );
    setStatus(i18n.t("timer.scriptSkipped", { name: task.name }));
  }

  // 设置菜单后续还会扩展定时上报、日志设置等入口，因此这里保留为数据驱动结构。

  const groupedTimerTasks = useMemo(() => groupTimerTasks(timerTasks), [timerTasks]);

  return {
    timerTasks,
    collapsedGroups,
    collapsedTasks,
    groupedTimerTasks,
    addTimerTask,
    patchTimerTask,
    duplicateTimerTask,
    toggleTimerGroup,
    isTimerGroupCollapsed,
    expandAllTimerGroups,
    collapseAllTimerGroups,
    toggleTimerTask,
    isTimerTaskCollapsed,
    expandAllTimerTasks,
    collapseAllTimerTasks,
    startTimerGroup,
    pauseTimerGroup,
    exportTimerTasks,
    importTimerTasks,
    removeTimerTask,
    clearTimerTasks,
    addTimerItem,
    updateTimerItem,
    removeTimerItem,
    startTimerTask,
    pauseTimerTask,
    pauseAllTimerTasks,
    resumeNetworkWaitingTasks,
    runTimerTaskNow,
    pendingTimerImport,
    confirmTimerImport,
    cancelTimerImport,
    scriptPreviews,
    setGenerationMode,
    updateTimerScript,
    resetTimerScriptState,
    previewTimerScript,
  };
}
