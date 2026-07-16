import type { TimerDpItem, TimerScriptConfig, TimerScriptResponse } from "../timer/types";

export type TriggerMatchMode = "any" | "equals" | "one_of" | "range";
export type TriggerExecutionMode = "once" | "sequence";
export type SequenceAction = "replace" | "ignore" | "queue" | "cancel";

export type TriggerRule = {
  id: string;
  name: string;
  groupName: string;
  enabled: boolean;
  triggerCode: string;
  matchMode: TriggerMatchMode;
  matchValue?: unknown;
  matchValues: unknown[];
  matchMin?: number;
  matchMax?: number;
  executionMode: TriggerExecutionMode;
  delayMode: "fixed" | "random";
  delaySeconds: number;
  delayMinSeconds: number;
  delayMaxSeconds: number;
  sequenceGroup: string;
  sequenceAction: SequenceAction;
  intervalMode: "fixed" | "random";
  intervalSeconds: number;
  intervalMinSeconds: number;
  intervalMaxSeconds: number;
  maxRuns: number | null;
  maxDurationSeconds: number | null;
  reportMode: "batch" | "sequential";
  generationMode: "items" | "script";
  items: TimerDpItem[];
  script?: TimerScriptConfig;
  triggerCount: number;
  lastError?: string;
};

export type TriggerSequenceState = {
  id: string;
  ruleId: string;
  ruleName: string;
  group: string;
  runIndex: number;
  startedAtMs: number;
  nextRunAtMs: number;
  status: string;
};

export type TriggerRuntimeState = {
  masterEnabled: boolean;
  revision: number;
  rules: TriggerRule[];
  ruleErrors: Record<string, string>;
  pendingCount: number;
  activeSequences: TriggerSequenceState[];
};

export type TriggerPreview = TimerScriptResponse;
