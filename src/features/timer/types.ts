export type TimingMode = "fixed" | "random";
export type TimerStatus = "idle" | "waiting" | "network_wait" | "running" | "paused" | "completed" | "error";
export type ValueMode = "manual" | "random";
export type ReportMode = "batch" | "sequential";
export type NetworkGate = "none" | "cloud" | "router_or_above" | "specific";

export type TimerTask = {
  id: string;
  name: string;
  groupName: string;
  enabled: boolean;
  status: TimerStatus;
  maxRuns: number | null;
  runCount: number;
  reportMode: ReportMode;
  networkGate: NetworkGate;
  networkSpecificCode?: number;
  delayMode: TimingMode;
  delaySeconds: number;
  delayMinSeconds: number;
  delayMaxSeconds: number;
  intervalMode: TimingMode;
  intervalSeconds: number;
  intervalMinSeconds: number;
  intervalMaxSeconds: number;
  nextRunAt: number | null;
  lastError?: string;
  items: TimerDpItem[];
};

export type TimerDpItem = {
  id: string;
  dpCode: string;
  valueMode: ValueMode;
  manualValues: string;
  manualIndex: number;
  randomMin?: number;
  randomMax?: number;
  randomCandidates?: string;
};
