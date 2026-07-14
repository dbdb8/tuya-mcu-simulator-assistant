import type { DpPoint } from "../../types";
import i18n from "../../i18n";

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
  if (id === 1 || id < 110) return i18n.t("dp.groups.basic");
  if (id < 122) return i18n.t("dp.groups.lumbar");
  if (id < 130) return i18n.t("dp.groups.massage");
  if (id < 138) return i18n.t("dp.groups.sensor");
  if (id < 145) return i18n.t("dp.groups.reminder");
  return i18n.t("dp.groups.offline");
}

export function normalizeInput(point: DpPoint, value: unknown) {
  if (point.kind === "value" || point.kind === "bitmap") return Number(value);
  if (point.kind === "bool") return Boolean(value);
  return String(value ?? "");
}
