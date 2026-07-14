import type { DpPoint } from "../../types";

export function enumDisplayValue(value: unknown, range: string[]) {
  if (typeof value === "number" && range[value]) return range[value];
  if (typeof value === "string" && range.includes(value)) return value;
  return range[0] ?? "";
}

export function groupPoints(points: DpPoint[], filter: string): Array<[string, DpPoint[]]> {
  const q = filter.trim().toLowerCase();
  const selected = q
    ? points.filter((point) => `${point.id} ${point.code} ${point.name}`.toLowerCase().includes(q))
    : points;
  const buckets = new Map<string, DpPoint[]>();
  for (const point of selected) {
    const group = groupName(point.id);
    buckets.set(group, [...(buckets.get(group) ?? []), point]);
  }
  return Array.from(buckets.entries());
}

export function groupName(id: number) {
  // Debugfile 的 DP ID 不携带统一业务语义，按固定数字区间分组，避免把某类产品结构套到其他设备上。
  const normalizedId = Math.max(1, Math.trunc(id));
  const start = Math.floor((normalizedId - 1) / 50) * 50 + 1;
  return `DP ${start}-${start + 49}`;
}

export function normalizeInput(point: DpPoint, value: unknown) {
  if (point.kind === "value" || point.kind === "bitmap") return Number(value);
  if (point.kind === "bool") return Boolean(value);
  return String(value ?? "");
}
