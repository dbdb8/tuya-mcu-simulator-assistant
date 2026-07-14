export type DpKind = "bool" | "enum" | "value" | "bitmap" | "string" | "raw";

export type DpPoint = {
  id: number;
  code: string;
  name: string;
  mode: string;
  kind: DpKind;
  property: Record<string, unknown>;
};

export type DpSchema = {
  product_key: string;
  profile_name: string;
  mcu_version: string;
  config_mode: number;
  config_mode_label: string;
  points: DpPoint[];
};

export type NetworkStatus = {
  code: number;
  label: string;
  updated_at_ms: number;
};

export type BootstrapState = {
  schema: DpSchema | null;
  values: Record<string, unknown>;
  network: NetworkStatus;
  dp_file_path?: string | null;
};

export type SerialLog = {
  direction: "rx" | "tx" | "error";
  title: string;
  command?: number;
  hex: string;
  raw: boolean;
  timestamp_ms: number;
};

export type AppError = {
  code: string;
  title: string;
  message: string;
  detail: string;
  suggestion: string;
};
