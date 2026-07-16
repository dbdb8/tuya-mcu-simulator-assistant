import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { downloadDir, join } from "@tauri-apps/api/path";
import type { AppError, DpSchema } from "../../types";
import { normalizeError } from "../../utils/log-utils";
import { defaultTimerItem, defaultTimerScript, makeId } from "../timer/timer-utils";
import type { TimerDpItem, TimerScriptConfig } from "../timer/types";
import type { TriggerPreview, TriggerRule, TriggerRuntimeState } from "./types";
import {
  defaultTriggerRule,
  defaultTriggerValue,
  loadTriggerRules,
  normalizeTriggerRule,
  saveTriggerRules,
} from "./trigger-utils";
import i18n from "../../i18n";

type Options = {
  schema: DpSchema | null;
  serialOpen: boolean;
  showError: (error: AppError) => void;
  setStatus: (status: string) => void;
};

export function useTriggerRules({ schema, serialOpen, showError, setStatus }: Options) {
  const [rules, setRules] = useState<TriggerRule[]>(() => loadTriggerRules());
  const [masterEnabled, setMasterEnabledState] = useState(false);
  const [runtime, setRuntime] = useState<TriggerRuntimeState | null>(null);
  const [previews, setPreviews] = useState<
    Record<string, { loading: boolean; result?: TriggerPreview; error?: string }>
  >({});
  const rulesRef = useRef(rules);
  const syncingRef = useRef(false);
  const pendingSyncRef = useRef<{
    rules: TriggerRule[];
    changedRuleIds: Set<string>;
    fullReplace: boolean;
  } | null>(null);

  useEffect(() => {
    rulesRef.current = rules;
    saveTriggerRules(rules);
  }, [rules]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<TriggerRuntimeState>("trigger-rule-state", (event) => {
      applyRuntimeState(event.payload);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [schema]);

  useEffect(() => {
    if (!serialOpen && masterEnabled) void setMasterEnabled(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialOpen]);

  const productKey = schema?.product_key;
  useEffect(() => {
    // Debugfile 改变后由后端关闭总开关并清空队列；事件回调再同步界面，避免 Effect 内级联 setState。
    if (productKey) void invoke("set_trigger_master", { enabled: false });
  }, [productKey]);

  function applyRuntimeState(next: TriggerRuntimeState) {
    setRuntime(next);
    setMasterEnabledState(next.masterEnabled);
    // 后端事件只回填运行数据；用户正在输入的规则结构必须保留，避免较早的异步响应覆盖新草稿。
    setRules((current) => {
      const merged = current.map((rule) => {
        const backend = next.rules.find((item) => item.id === rule.id);
        if (!backend) return rule;
        return {
          ...rule,
          triggerCount: backend.triggerCount,
          lastError: backend.lastError,
          items: rule.items.map((item) => {
            const backendItem = backend.items.find((candidate) => candidate.id === item.id);
            return backendItem ? { ...item, manualIndex: backendItem.manualIndex } : item;
          }),
          script:
            rule.script && backend.script ? { ...rule.script, state: backend.script.state } : rule.script,
        };
      });
      rulesRef.current = merged;
      return merged;
    });
  }

  function syncTriggerRules(nextRules: TriggerRule[], changedRuleIds: string[], fullReplace = false) {
    if (!schema) return;
    const pending = pendingSyncRef.current;
    pendingSyncRef.current = {
      rules: nextRules,
      changedRuleIds: new Set([...(pending?.changedRuleIds ?? []), ...changedRuleIds]),
      fullReplace: Boolean(pending?.fullReplace || fullReplace),
    };
    if (!syncingRef.current) void flushTriggerRuleSync();
  }

  async function flushTriggerRuleSync() {
    if (syncingRef.current) return;
    syncingRef.current = true;
    try {
      while (pendingSyncRef.current) {
        const pending = pendingSyncRef.current;
        pendingSyncRef.current = null;
        const next = pending.fullReplace
          ? await invoke<TriggerRuntimeState>("set_trigger_rules", { rules: pending.rules })
          : await invoke<TriggerRuntimeState>("update_trigger_rules", {
              rules: pending.rules,
              changedRuleIds: Array.from(pending.changedRuleIds),
            });
        applyRuntimeState(next);
      }
    } catch (error) {
      showError(normalizeError(error));
    } finally {
      syncingRef.current = false;
      // 请求失败期间可能又产生了新草稿，结束当前请求后继续提交最新快照。
      if (pendingSyncRef.current) void flushTriggerRuleSync();
    }
  }

  function applyRules(nextRules: TriggerRule[], changedRuleIds: string[], fullReplace = false) {
    rulesRef.current = nextRules;
    setRules(nextRules);
    syncTriggerRules(nextRules, changedRuleIds, fullReplace);
  }

  function addRule() {
    const added = defaultTriggerRule(schema, rulesRef.current.length + 1);
    applyRules([...rulesRef.current, added], [added.id]);
  }

  function patchRule(ruleId: string, patch: Partial<TriggerRule>) {
    applyRules(
      rulesRef.current.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule)),
      [ruleId],
    );
  }

  function setRuleEnabled(ruleId: string, enabled: boolean) {
    patchRule(ruleId, { enabled });
  }

  function setGroupRulesEnabled(ruleIds: string[], enabled: boolean) {
    const ids = new Set(ruleIds);
    applyRules(
      rulesRef.current.map((rule) => (ids.has(rule.id) ? { ...rule, enabled } : rule)),
      ruleIds,
    );
  }

  function duplicateRule(ruleId: string) {
    const source = rulesRef.current.find((rule) => rule.id === ruleId);
    if (!source) return;
    const copy = normalizeTriggerRule(
      {
        ...structuredClone(source),
        id: makeId("trigger"),
        name: `${source.name} ${i18n.t("timer.copySuffix")}`,
        enabled: false,
        triggerCount: 0,
        lastError: undefined,
        items: source.items.map((item) => ({ ...item, id: makeId("dp"), manualIndex: 0 })),
        script: source.script
          ? { ...source.script, state: structuredClone(source.script.initialState) }
          : undefined,
      },
      schema,
    );
    applyRules([...rulesRef.current, copy], [copy.id]);
  }

  function removeRule(ruleId: string) {
    applyRules(
      rulesRef.current.filter((rule) => rule.id !== ruleId),
      [ruleId],
    );
  }

  function clearRules() {
    applyRules(
      [],
      rulesRef.current.map((rule) => rule.id),
      true,
    );
    setStatus(i18n.t("trigger.cleared"));
  }

  function addItem(ruleId: string) {
    const point = schema?.points[0];
    if (!point) return;
    const rule = rulesRef.current.find((item) => item.id === ruleId);
    if (rule) patchRule(ruleId, { items: [...rule.items, defaultTimerItem(point)] });
  }

  function updateItem(ruleId: string, itemId: string, patch: Partial<TimerDpItem>) {
    const rule = rulesRef.current.find((item) => item.id === ruleId);
    if (rule)
      patchRule(ruleId, {
        items: rule.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
      });
  }

  function removeItem(ruleId: string, itemId: string) {
    const rule = rulesRef.current.find((item) => item.id === ruleId);
    if (rule) patchRule(ruleId, { items: rule.items.filter((item) => item.id !== itemId) });
  }

  function setGenerationMode(ruleId: string, mode: TriggerRule["generationMode"]) {
    const rule = rulesRef.current.find((item) => item.id === ruleId);
    if (!rule) return;
    patchRule(ruleId, {
      generationMode: mode,
      script: mode === "script" ? (rule.script ?? defaultTimerScript()) : rule.script,
    });
  }

  function updateScript(ruleId: string, patch: Partial<TimerScriptConfig>) {
    const rule = rulesRef.current.find((item) => item.id === ruleId);
    if (rule) patchRule(ruleId, { script: { ...(rule.script ?? defaultTimerScript()), ...patch } });
  }

  function resetScript(ruleId: string) {
    const rule = rulesRef.current.find((item) => item.id === ruleId);
    if (rule?.script) updateScript(ruleId, { state: structuredClone(rule.script.initialState) });
  }

  async function setMasterEnabled(enabled: boolean) {
    try {
      if (enabled) {
        if (!schema || !serialOpen) throw new Error(i18n.t("trigger.blocked"));
        const synced = await invoke<TriggerRuntimeState>("set_trigger_rules", { rules: rulesRef.current });
        applyRuntimeState(synced);
      }
      const next = await invoke<TriggerRuntimeState>("set_trigger_master", { enabled });
      setRuntime(next);
      setMasterEnabledState(next.masterEnabled);
      setStatus(i18n.t(enabled ? "trigger.masterStarted" : "trigger.masterStopped"));
    } catch (error) {
      const normalized = normalizeError(error);
      showError(normalized);
      setMasterEnabledState(false);
    }
  }

  async function previewRule(ruleId: string, triggerValue?: unknown) {
    const rule = rulesRef.current.find((item) => item.id === ruleId);
    const point = schema?.points.find((item) => item.code === rule?.triggerCode);
    if (!rule || !point) return;
    setPreviews((current) => ({ ...current, [ruleId]: { loading: true } }));
    try {
      const raw = await invoke<{
        patches: Array<{ code: string; value: unknown }>;
        nextState?: Record<string, unknown>;
        summary?: string;
        skip: boolean;
        complete: boolean;
      }>("preview_trigger_rule", {
        rule,
        triggerValue: triggerValue ?? rule.matchValue ?? defaultTriggerValue(point),
      });
      setPreviews((current) => ({
        ...current,
        [ruleId]: {
          loading: false,
          result: {
            patches: raw.patches,
            state: raw.nextState ?? rule.script?.state ?? {},
            summary: raw.summary,
            skip: raw.skip,
            complete: raw.complete,
          },
        },
      }));
    } catch (error) {
      const normalized = normalizeError(error);
      setPreviews((current) => ({ ...current, [ruleId]: { loading: false, error: normalized.message } }));
      showError(normalized);
    }
  }

  async function exportRules() {
    const filename = `tuya-trigger-rules-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.json`;
    let defaultPath = filename;
    try {
      defaultPath = await join(await downloadDir(), filename);
    } catch {
      // 无下载目录权限时让系统保存对话框选择可用位置。
    }
    const selected = await save({ defaultPath, filters: [{ name: "Trigger Rules", extensions: ["json"] }] });
    if (!selected) return;
    await invoke("save_log_file", {
      path: selected,
      content: JSON.stringify(
        { version: 1, exported_at: new Date().toISOString(), product_key: schema?.product_key, rules },
        null,
        2,
      ),
    });
  }

  async function importRules() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Trigger Rules", extensions: ["json"] }],
    });
    if (typeof selected !== "string") return;
    const content = await invoke<string>("load_text_file", { path: selected });
    const parsed = JSON.parse(content) as { rules?: unknown[] } | unknown[];
    const rawRules = Array.isArray(parsed) ? parsed : parsed.rules;
    if (!Array.isArray(rawRules) || rawRules.length === 0) throw new Error(i18n.t("trigger.importEmpty"));
    const imported = rawRules.map((rule) => normalizeTriggerRule(rule as TriggerRule, schema));
    if (
      imported.some((rule) => rule.generationMode === "script") &&
      !window.confirm(i18n.t("trigger.importScriptConfirm"))
    )
      return;
    applyRules(
      imported,
      [...rulesRef.current.map((rule) => rule.id), ...imported.map((rule) => rule.id)],
      true,
    );
    setStatus(i18n.t("trigger.imported", { count: imported.length }));
  }

  return {
    rules,
    masterEnabled,
    runtime,
    previews,
    addRule,
    patchRule,
    setRuleEnabled,
    setGroupRulesEnabled,
    duplicateRule,
    removeRule,
    clearRules,
    addItem,
    updateItem,
    removeItem,
    setGenerationMode,
    updateScript,
    resetScript,
    setMasterEnabled,
    previewRule,
    exportRules,
    importRules,
  };
}
