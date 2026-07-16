import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { AppHeader } from "./components/AppHeader";
import { ConnectionToolbar } from "./components/ConnectionToolbar";
import { ErrorBanner } from "./components/ErrorBanner";
import { DpPanel } from "./features/dp/DpPanel";
import { LogPanel, type LogMode } from "./features/logs/LogPanel";
import { RelatedCommandsModal } from "./features/settings/RelatedCommandsModal";
import { createSettingsItems, RELATED_COMMANDS } from "./features/settings/settings-config";
import { TimerReportModal } from "./features/timer/TimerReportModal";
import { ScriptImportConfirmModal } from "./features/timer/ScriptImportConfirmModal";
import { useTimerTasks } from "./features/timer/useTimerTasks";
import { TriggerReportModal } from "./features/trigger/TriggerReportModal";
import { useTriggerRules } from "./features/trigger/useTriggerRules";
import { UpdateModal } from "./features/updater/UpdateModal";
import { useAppUpdater } from "./features/updater/useAppUpdater";
import { useTranslation } from "react-i18next";
import i18n, { changeAppLanguage, type AppLocale } from "./i18n";
import { LanguageSettingsModal } from "./features/settings/LanguageSettingsModal";
import { CloseBehaviorModal, type CloseBehavior } from "./features/settings/CloseBehaviorModal";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DEFAULT_BAUD_RATE, DEFAULT_DP_PATH, STORAGE_KEYS } from "./constants";
import type { AppError, BootstrapState, DpPoint, DpSchema, NetworkStatus, SerialLog } from "./types";
import { groupPoints, normalizeInput } from "./features/dp/dp-utils";
import {
  mergeIncomingLog,
  normalizeError,
  readStoredNumber,
  readStoredString,
  saveLogs,
} from "./utils/log-utils";

export default function App() {
  const { t } = useTranslation();
  const isWindows = navigator.userAgent.includes("Windows");
  const [dpPath, setDpPath] = useState(() => readStoredString(STORAGE_KEYS.dpFilePath, DEFAULT_DP_PATH));
  const [schema, setSchema] = useState<DpSchema | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [ports, setPorts] = useState<string[]>([]);
  const [portName, setPortName] = useState(() => readStoredString(STORAGE_KEYS.portName, ""));
  const [baudRate, setBaudRate] = useState(() => readStoredNumber(STORAGE_KEYS.baudRate, DEFAULT_BAUD_RATE));
  const [serialOpen, setSerialOpen] = useState(false);
  const [logs, setLogs] = useState<SerialLog[]>([]);
  const [logMode, setLogMode] = useState<LogMode>("all");
  const [status, setStatus] = useState(() => i18n.t("status.disconnected"));
  const [error, setError] = useState<AppError | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [network, setNetwork] = useState<NetworkStatus>({
    code: 0xff,
    label: i18n.t("status.unknown"),
    updated_at_ms: 0,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [relatedModalOpen, setRelatedModalOpen] = useState(false);
  const [timerModalOpen, setTimerModalOpen] = useState(false);
  const [triggerModalOpen, setTriggerModalOpen] = useState(false);
  const [languageModalOpen, setLanguageModalOpen] = useState(false);
  const [closeBehaviorModalOpen, setCloseBehaviorModalOpen] = useState(false);
  const [closePromptOpen, setClosePromptOpen] = useState(false);
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>(() => {
    const stored = readStoredString(STORAGE_KEYS.closeBehavior, "ask");
    return stored === "tray" || stored === "exit" ? stored : "ask";
  });
  const [language, setLanguage] = useState<AppLocale>(() => (i18n.language === "en-US" ? "en-US" : "zh-CN"));
  const restoredOnce = useRef(false);
  const timer = useTimerTasks({ schema, serialOpen, network, showError, setStatus });
  const trigger = useTriggerRules({ schema, serialOpen, showError, setStatus });
  const updater = useAppUpdater({
    serialOpen,
    beforeInstall: async () => {
      // 安装前主动关闭串口，避免后台线程和 COM 口占用影响应用退出与替换文件。
      await invoke("stop_serial");
    },
  });
  const {
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
    runTimerTaskNow,
    pendingTimerImport,
    confirmTimerImport,
    cancelTimerImport,
    scriptPreviews,
    setGenerationMode,
    updateTimerScript,
    resetTimerScriptState,
    previewTimerScript,
  } = timer;

  useEffect(() => {
    void invoke("set_app_language", { language });
  }, [language]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        // 仅 Windows 使用托盘关闭策略；其他平台继续遵循系统原生关闭习惯。
        if (isWindows) {
          event.preventDefault();
          if (closeBehavior === "ask") {
            setClosePromptOpen(true);
          } else if (closeBehavior === "tray") {
            await invoke("hide_main_window");
          } else {
            await invoke("exit_application");
          }
        }
      })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [closeBehavior, isWindows]);

  useEffect(() => {
    if (!restoredOnce.current) {
      restoredOnce.current = true;
      runAction("refreshPorts", () => refreshPorts(), { clearError: false });
      const storedDpPath = readStoredString(STORAGE_KEYS.dpFilePath, "");
      if (storedDpPath) {
        // 关闭后再次打开时自动恢复上次 Debugfile；失败会进入统一错误面板，便于用户知道路径失效。
        runAction("restoreDpFile", () => loadDp(storedDpPath, true), { clearError: false });
      }
    }
    const unsubs: Array<() => void> = [];
    let disposed = false;
    const trackUnlisten = (registration: Promise<() => void>) => {
      void registration.then((unlisten) => {
        // Tauri listen 是异步注册的；StrictMode 可能先执行 cleanup，再返回 unlisten。
        // 注册完成时若组件已卸载，需要立即取消，避免一条后端事件被多个残留监听重复显示。
        if (disposed) unlisten();
        else unsubs.push(unlisten);
      });
    };
    trackUnlisten(
      listen<SerialLog>("serial-log", (event) => {
        setLogs((current) => mergeIncomingLog(event.payload, current));
      }),
    );
    trackUnlisten(
      listen<boolean>("serial-opened", (event) => {
        setSerialOpen(event.payload);
        setStatus(i18n.t(event.payload ? "status.serialConnected" : "status.serialClosed"));
        if (!event.payload) timer.pauseAllTimerTasks(i18n.t("status.serialClosed"));
      }),
    );
    trackUnlisten(
      listen<AppError>("serial-error", (event) => {
        showError(event.payload);
        setStatus(event.payload.title);
        setSerialOpen(false);
        timer.pauseAllTimerTasks(event.payload.title);
      }),
    );
    trackUnlisten(
      listen<NetworkStatus>("network-status", (event) => {
        setNetwork(event.payload);
        timer.resumeNetworkWaitingTasks(event.payload);
      }),
    );
    trackUnlisten(listen<string>("wifi-action", (event) => setStatus(event.payload)));
    trackUnlisten(listen<Record<string, unknown>>("sim-state", (event) => setValues(event.payload)));
    return () => {
      disposed = true;
      unsubs.forEach((unlisten) => unlisten());
    };
    // 监听在应用生命周期内只注册一次；动态语言文案通过 i18n 当前状态读取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 分组名称由 i18n 当前语言生成，因此语言也是必要的重算触发条件。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const groups = useMemo(() => groupPoints(schema?.points ?? [], filter), [schema, filter, language]);

  async function runAction(
    name: string,
    action: () => Promise<void>,
    options: { clearError?: boolean } = {},
  ) {
    setBusyAction(name);
    if (options.clearError !== false) {
      setError(null);
    }
    try {
      await action();
    } catch (err) {
      showError(normalizeError(err));
    } finally {
      setBusyAction((current) => (current === name ? null : current));
    }
  }

  function showError(nextError: AppError) {
    setError(nextError);
    setStatus(nextError.title);
    setLogs((current) =>
      [
        {
          direction: "error" as const,
          title: nextError.title,
          hex: `${nextError.message} | ${nextError.suggestion} | ${nextError.detail}`,
          raw: false,
          timestamp_ms: Date.now(),
        },
        ...current,
      ].slice(0, 600),
    );
  }

  async function refreshPorts() {
    const nextPorts = await invoke<string[]>("list_serial_ports");
    setPorts(nextPorts);
    setPortName((current) => current || nextPorts[0] || "");
    if (nextPorts.length === 0) {
      setStatus(i18n.t("status.noPorts"));
    }
  }

  function updatePortName(nextPort: string) {
    setPortName(nextPort);
    localStorage.setItem(STORAGE_KEYS.portName, nextPort);
  }

  function updateBaudRate(nextBaudRate: number) {
    setBaudRate(nextBaudRate);
    localStorage.setItem(STORAGE_KEYS.baudRate, String(nextBaudRate));
  }

  function persistSerialSettings(nextPort: string, nextBaudRate: number) {
    // 用户点击开始调试时再保存一次，覆盖下拉框未触发 change 的默认选择场景。
    if (nextPort) {
      localStorage.setItem(STORAGE_KEYS.portName, nextPort);
    }
    localStorage.setItem(STORAGE_KEYS.baudRate, String(nextBaudRate));
  }

  async function loadDp(path: string, restored = false) {
    const state = await invoke<BootstrapState>("load_dp_file", { path });
    setSchema(state.schema);
    setValues(state.values);
    setNetwork(state.network);
    setDpPath(state.dp_file_path ?? path);
    localStorage.setItem(STORAGE_KEYS.dpFilePath, state.dp_file_path ?? path);
    // 自动恢复和文件加载都是异步操作，完成时读取 i18n 当前语言，避免首次渲染闭包仍保留中文。
    setStatus(
      i18n.t(restored ? "status.restoredDp" : "status.loadedDp", {
        count: state.schema?.points.length ?? 0,
      }),
    );
    timer.pauseAllTimerTasks(i18n.t("status.loadedDp", { count: state.schema?.points.length ?? 0 }));
  }

  async function chooseDpFile() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Tuya Debugfile", extensions: ["json"] }],
    });
    if (typeof selected === "string") {
      await loadDp(selected);
    }
  }

  async function startSerial() {
    persistSerialSettings(portName, baudRate);
    await invoke("start_serial", {
      settings: {
        port_name: portName,
        baud_rate: baudRate,
      },
    });
  }

  async function stopSerial() {
    await invoke("stop_serial");
  }

  async function updateDp(point: DpPoint, rawValue: unknown) {
    const value = normalizeInput(point, rawValue);
    setValues((current) => ({ ...current, [point.code]: value }));
    await invoke("set_dp_value", { patch: { code: point.code, value } });
  }

  async function sendWifiReset() {
    await invoke("wifi_reset");
    setStatus(t("status.wifiReset"));
  }

  async function sendWifiMode(mode: 0 | 1) {
    await invoke("set_wifi_mode", { mode });
    setStatus(t(mode === 0 ? "status.wifiEz" : "status.wifiAp"));
  }

  async function sendRelatedCommand(command: string, labelKey: string) {
    await invoke(command);
    setStatus(t("status.sent", { label: t(labelKey) }));
  }

  const settingsItems = createSettingsItems(
    () => {
      setSettingsOpen(false);
      setRelatedModalOpen(true);
    },
    () => {
      setSettingsOpen(false);
      setTimerModalOpen(true);
    },
    () => {
      setSettingsOpen(false);
      setTriggerModalOpen(true);
    },
    () => {
      setSettingsOpen(false);
      setLanguageModalOpen(true);
    },
    {
      visible: isWindows,
      onOpen: () => {
        setSettingsOpen(false);
        setCloseBehaviorModalOpen(true);
      },
    },
    {
      onOpen: () => {
        setSettingsOpen(false);
        updater.openModal();
      },
      hasUpdate: updater.hasUpdate,
      version: updater.availableVersion,
      checking: updater.state === "checking",
      failed: updater.state === "error",
    },
  );

  return (
    <main>
      <AppHeader
        schema={schema}
        status={status}
        network={network}
        settingsOpen={settingsOpen}
        settingsItems={settingsItems}
        onToggleSettings={() => setSettingsOpen((open) => !open)}
      />
      <ConnectionToolbar
        ports={ports}
        portName={portName}
        baudRate={baudRate}
        dpPath={dpPath}
        schema={schema}
        serialOpen={serialOpen}
        busyAction={busyAction}
        onPortChange={updatePortName}
        onBaudChange={updateBaudRate}
        onRefresh={() => runAction("refreshPorts", refreshPorts)}
        onChooseFile={() => runAction("chooseDpFile", chooseDpFile)}
        onStart={() => runAction("startSerial", startSerial)}
        onStop={() => runAction("stopSerial", stopSerial)}
        onWifiReset={() => runAction("wifiReset", sendWifiReset)}
        onWifiMode={(mode) => runAction(mode === 0 ? "wifiEz" : "wifiAp", () => sendWifiMode(mode))}
      />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <RelatedCommandsModal
        open={relatedModalOpen}
        schema={schema}
        serialOpen={serialOpen}
        busyAction={busyAction}
        commands={RELATED_COMMANDS}
        onClose={() => setRelatedModalOpen(false)}
        onSend={(item) => runAction(item.key, () => sendRelatedCommand(item.command, item.labelKey))}
      />
      <TimerReportModal
        open={timerModalOpen}
        schema={schema}
        serialOpen={serialOpen}
        tasks={timerTasks}
        groupedTasks={groupedTimerTasks}
        collapsedGroups={collapsedGroups}
        collapsedTasks={collapsedTasks}
        onClose={() => setTimerModalOpen(false)}
        onImport={() => runAction("importTimers", importTimerTasks)}
        onExport={() => runAction("exportTimers", exportTimerTasks)}
        onClear={clearTimerTasks}
        onAddTask={addTimerTask}
        onToggleGroup={toggleTimerGroup}
        isGroupCollapsed={isTimerGroupCollapsed}
        onExpandAllGroups={expandAllTimerGroups}
        onCollapseAllGroups={collapseAllTimerGroups}
        onToggleTask={toggleTimerTask}
        isTaskCollapsed={isTimerTaskCollapsed}
        onExpandAllTasks={expandAllTimerTasks}
        onCollapseAllTasks={collapseAllTimerTasks}
        onStartGroup={startTimerGroup}
        onPauseGroup={pauseTimerGroup}
        onPatchTask={patchTimerTask}
        onStart={startTimerTask}
        onPause={pauseTimerTask}
        onRunNow={(taskId) => runTimerTaskNow(taskId, false)}
        onDuplicate={duplicateTimerTask}
        onRemoveTask={removeTimerTask}
        onAddItem={addTimerItem}
        onUpdateItem={updateTimerItem}
        onRemoveItem={removeTimerItem}
        scriptPreviews={scriptPreviews}
        onGenerationModeChange={setGenerationMode}
        onScriptChange={updateTimerScript}
        onScriptPreview={previewTimerScript}
        onScriptReset={resetTimerScriptState}
      />
      <TriggerReportModal
        open={triggerModalOpen}
        schema={schema}
        serialOpen={serialOpen}
        rules={trigger.rules}
        masterEnabled={trigger.masterEnabled}
        runtime={trigger.runtime}
        previews={trigger.previews}
        onClose={() => setTriggerModalOpen(false)}
        onMasterChange={(enabled) => void trigger.setMasterEnabled(enabled)}
        onImport={() => runAction("importTriggers", trigger.importRules)}
        onExport={() => runAction("exportTriggers", trigger.exportRules)}
        onClear={trigger.clearRules}
        onAdd={trigger.addRule}
        onPatch={trigger.patchRule}
        onRuleEnabled={trigger.setRuleEnabled}
        onGroupEnabled={trigger.setGroupRulesEnabled}
        onDuplicate={trigger.duplicateRule}
        onRemove={trigger.removeRule}
        onAddItem={trigger.addItem}
        onUpdateItem={trigger.updateItem}
        onRemoveItem={trigger.removeItem}
        onGenerationModeChange={trigger.setGenerationMode}
        onScriptChange={trigger.updateScript}
        onScriptReset={trigger.resetScript}
        onPreview={(id, value) => void trigger.previewRule(id, value)}
      />
      <ScriptImportConfirmModal
        pending={pendingTimerImport}
        onConfirm={confirmTimerImport}
        onCancel={cancelTimerImport}
      />
      <UpdateModal
        open={updater.modalOpen}
        state={updater.state}
        currentVersion={updater.currentVersion}
        availableVersion={updater.availableVersion}
        notes={updater.notes}
        publishedAt={updater.publishedAt}
        progress={updater.progress}
        error={updater.error}
        environment={updater.environment}
        serialOpen={serialOpen}
        onClose={updater.dismiss}
        onCheck={() => void updater.checkForUpdates(false)}
        onInstall={() => void updater.downloadAndInstall()}
        onOpenRelease={() => void updater.openReleasePage()}
      />
      <LanguageSettingsModal
        open={languageModalOpen}
        language={language}
        onClose={() => setLanguageModalOpen(false)}
        onChange={(nextLanguage) => {
          setLanguage(nextLanguage);
          void changeAppLanguage(nextLanguage);
        }}
      />
      <CloseBehaviorModal
        open={closeBehaviorModalOpen}
        behavior={closeBehavior}
        onClose={() => setCloseBehaviorModalOpen(false)}
        onChange={(nextBehavior) => {
          setCloseBehavior(nextBehavior);
          localStorage.setItem(STORAGE_KEYS.closeBehavior, nextBehavior);
          setCloseBehaviorModalOpen(false);
        }}
      />
      <CloseBehaviorModal
        open={closePromptOpen}
        behavior={closeBehavior}
        firstClose
        onClose={() => setClosePromptOpen(false)}
        onChange={(nextBehavior) => {
          // 首次选择立即记忆；后续可在“设置 > 关闭行为”中恢复为每次询问。
          setCloseBehavior(nextBehavior);
          localStorage.setItem(STORAGE_KEYS.closeBehavior, nextBehavior);
          setClosePromptOpen(false);
          void invoke(nextBehavior === "tray" ? "hide_main_window" : "exit_application");
        }}
      />
      <div className="workspace no-simulator">
        <LogPanel
          logs={logs}
          mode={logMode}
          busy={busyAction === "saveLogs"}
          onModeChange={setLogMode}
          onSave={() => runAction("saveLogs", () => saveLogs(logs))}
          onClear={() => setLogs([])}
        />
        <DpPanel
          schema={schema}
          groups={groups}
          values={values}
          filter={filter}
          onFilterChange={setFilter}
          onReport={(point, value) => runAction(`dp-${point.id}`, () => updateDp(point, value))}
        />
      </div>
    </main>
  );
}
