import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { AppError, DpSchema, NetworkStatus } from "../../types";
import type { TimerDpItem, TimerTask } from "./types";
import {
  buildTimerPatches,
  canRunByNetwork,
  defaultTimerExportPath,
  defaultTimerItem,
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
  const [, setTimerNow] = useState(Date.now());
  const tasksRef = useRef<TimerTask[]>(timerTasks);
  const schemaRef = useRef<DpSchema | null>(schema);
  const serialOpenRef = useRef(serialOpen);
  const networkRef = useRef<NetworkStatus>(network);

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
    });
    setTimerTasks((current) => [...current, copy]);
  }

  function toggleTimerGroup(groupName: string) {
    setCollapsedGroups((current) => ({ ...current, [groupName]: !current[groupName] }));
  }

  async function exportTimerTasks() {
    const selected = await save({
      defaultPath: await defaultTimerExportPath(),
      filters: [{ name: "Timer Tasks", extensions: ["json"] }],
    });
    if (!selected) return;
    const payload = {
      version: 2,
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
    setTimerTasks(imported);
    setStatus(i18n.t("timer.imported", { count: imported.length }));
  }

  function removeTimerTask(taskId: string) {
    setTimerTasks((current) => current.filter((task) => task.id !== taskId));
  }

  function clearTimerTasks() {
    // 一键清理用于现场重新配置场景，直接清空内存和 localStorage 中的任务列表，不影响串口连接与 DP 当前状态。
    setTimerTasks([]);
    setCollapsedGroups({});
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
    const validation = validateTimerTask(task, schema, serialOpen) ?? validateTimerTaskConfig(task, schema);
    if (validation) {
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
    patchTimerTask(taskId, { enabled: false, status: "paused", nextRunAt: null, lastError: reason });
  }

  function pauseAllTimerTasks(reason: string) {
    setTimerTasks((current) =>
      current.map((task) =>
        task.enabled
          ? { ...task, enabled: false, status: "paused", nextRunAt: null, lastError: reason }
          : task,
      ),
    );
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
      const { patches, items } = buildTimerPatches(task, activeSchema!);
      await sendTimerPatches(task, patches);
      const nextRunCount = task.runCount + 1;
      const reachedLimit = typeof task.maxRuns === "number" && nextRunCount >= task.maxRuns;
      if (keepSchedule) {
        if (reachedLimit) {
          setTimerTasks((current) =>
            current.map((item) =>
              item.id === taskId
                ? {
                    ...item,
                    items,
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
                  runCount: nextRunCount,
                  status: reachedLimit ? "completed" : task.enabled ? originalStatus : "idle",
                  enabled: reachedLimit ? false : task.enabled,
                  nextRunAt: reachedLimit ? null : task.enabled ? originalNextRunAt : null,
                  lastError: reachedLimit ? i18n.t("timer.reachedLimit") : undefined,
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

  // 设置菜单后续还会扩展定时上报、日志设置等入口，因此这里保留为数据驱动结构。

  const groupedTimerTasks = useMemo(() => groupTimerTasks(timerTasks), [timerTasks]);

  return {
    timerTasks,
    collapsedGroups,
    groupedTimerTasks,
    addTimerTask,
    patchTimerTask,
    duplicateTimerTask,
    toggleTimerGroup,
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
  };
}
