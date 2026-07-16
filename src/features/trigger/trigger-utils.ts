import type { DpPoint, DpSchema } from "../../types";
import { STORAGE_KEYS } from "../../constants";
import { defaultTimerItem, defaultTimerScript, makeId, timerItemError } from "../timer/timer-utils";
import type { TriggerRule } from "./types";
import i18n from "../../i18n";

export function defaultTriggerValue(point?: DpPoint): unknown {
  if (!point) return null;
  if (point.kind === "bool") return true;
  if (point.kind === "enum") {
    const range = Array.isArray(point.property.range) ? point.property.range : [];
    return range[0] ?? 0;
  }
  if (point.kind === "string" || point.kind === "raw") return "";
  return Number(point.property.min ?? 0);
}

export function defaultTriggerRule(schema: DpSchema | null, number: number): TriggerRule {
  const point = schema?.points[0];
  return {
    id: makeId("trigger"),
    name: i18n.t("trigger.defaultRule", { number }),
    groupName: i18n.t("trigger.defaultGroup"),
    enabled: false,
    triggerCode: point?.code ?? "",
    matchMode: "any",
    matchValue: defaultTriggerValue(point),
    matchValues: [],
    executionMode: "once",
    delayMode: "fixed",
    delaySeconds: 0,
    delayMinSeconds: 0,
    delayMaxSeconds: 5,
    sequenceGroup: "default-sequence",
    sequenceAction: "replace",
    intervalMode: "fixed",
    intervalSeconds: 1,
    intervalMinSeconds: 1,
    intervalMaxSeconds: 3,
    maxRuns: null,
    maxDurationSeconds: null,
    reportMode: "batch",
    generationMode: "items",
    items: point ? [defaultTimerItem(point)] : [],
    triggerCount: 0,
  };
}

export function normalizeTriggerRule(raw: Partial<TriggerRule>, schema?: DpSchema | null): TriggerRule {
  const fallback = defaultTriggerRule(schema ?? null, 1);
  return {
    ...fallback,
    ...raw,
    id: raw.id || makeId("trigger"),
    enabled: Boolean(raw.enabled),
    matchValues: Array.isArray(raw.matchValues) ? raw.matchValues : [],
    maxRuns: typeof raw.maxRuns === "number" && raw.maxRuns > 0 ? raw.maxRuns : null,
    maxDurationSeconds:
      typeof raw.maxDurationSeconds === "number" && raw.maxDurationSeconds > 0
        ? raw.maxDurationSeconds
        : null,
    items: Array.isArray(raw.items) ? raw.items : [],
    script: raw.script
      ? {
          apiVersion: 1,
          source: raw.script.source || defaultTimerScript().source,
          initialState: raw.script.initialState ?? {},
          state: raw.script.state ?? raw.script.initialState ?? {},
        }
      : undefined,
    triggerCount: Number(raw.triggerCount ?? 0),
  };
}

export function loadTriggerRules(): TriggerRule[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.triggerRules) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.map((rule) => normalizeTriggerRule(rule as TriggerRule)) : [];
  } catch {
    return [];
  }
}

export function saveTriggerRules(rules: TriggerRule[]) {
  localStorage.setItem(STORAGE_KEYS.triggerRules, JSON.stringify(rules));
}

export function parseTriggerInput(point: DpPoint | undefined, text: string): unknown {
  if (!point) return text;
  if (point.kind === "bool") return ["true", "1", "on", "开"].includes(text.trim().toLowerCase());
  if (point.kind === "value" || point.kind === "bitmap") return Number(text);
  if (point.kind === "enum") return text.trim();
  if (point.kind === "raw") return text.replace(/\s+/g, "").toLowerCase();
  return text;
}

export function triggerRuleError(rule: TriggerRule, schema: DpSchema | null): string {
  const trigger = schema?.points.find((point) => point.code === rule.triggerCode);
  if (!trigger) return i18n.t("triggerValidation.triggerMissing");
  if (rule.matchMode === "equals" && rule.matchValue === undefined)
    return i18n.t("triggerValidation.matchValue");
  if (rule.matchMode === "one_of" && rule.matchValues.length === 0)
    return i18n.t("triggerValidation.matchValues");
  if (rule.matchMode === "range" && (!(rule.matchMin! <= rule.matchMax!) || !Number.isFinite(rule.matchMin)))
    return i18n.t("triggerValidation.matchRange");
  if (rule.delayMode === "fixed" && rule.delaySeconds < 0) return i18n.t("triggerValidation.delay");
  if (rule.delayMode === "random" && rule.delayMinSeconds > rule.delayMaxSeconds)
    return i18n.t("triggerValidation.delayRange");
  if (rule.executionMode === "sequence" && !rule.sequenceGroup.trim())
    return i18n.t("triggerValidation.sequenceGroup");
  if (
    rule.executionMode === "sequence" &&
    rule.sequenceAction !== "cancel" &&
    rule.generationMode === "items" &&
    rule.maxRuns === null &&
    rule.maxDurationSeconds === null
  )
    return i18n.t("triggerValidation.sequenceLimit");
  if (rule.generationMode === "script" && !rule.script?.source.trim())
    return i18n.t("triggerValidation.script");
  if (rule.generationMode === "items" && rule.sequenceAction !== "cancel" && rule.items.length === 0)
    return i18n.t("triggerValidation.items");
  if (rule.generationMode === "items") {
    for (const item of rule.items) {
      const error = timerItemError(item, schema);
      if (error) return error;
    }
  }
  return "";
}
