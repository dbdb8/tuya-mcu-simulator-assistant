import type { DpPoint } from "../../types";
import type { TimerDpItem, TimerTask, TimingMode } from "../timer/types";
import { enumDisplayValue } from "./dp-utils";
import { splitValues, valueRange } from "../timer/timer-utils";
import { useTranslation } from "react-i18next";

export function DpRow({
  point,
  value,
  onChange,
}: {
  point: DpPoint;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation();
  const modeLabel = dpModeLabel(point.mode, t);
  const range = Array.isArray(point.property?.range) ? (point.property.range as string[]) : [];
  const enumValue = point.kind === "enum" ? enumDisplayValue(value, range) : "";
  return (
    <div className="dp-row">
      <div className="dp-meta">
        <b>{point.id}</b>
        <span>
          {point.code}
          <i title={modeLabel.title}>{point.mode || "--"}</i>
        </span>
        <em>{point.name}</em>
      </div>
      <div className="dp-control">
        {point.kind === "bool" ? (
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(event) => onChange(event.target.checked)}
            title={t("dp.reportHint")}
          />
        ) : point.kind === "enum" && range.length > 0 ? (
          <select
            value={enumValue}
            onChange={(event) => onChange(event.target.value)}
            title={t("dp.reportHint")}
          >
            {range.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        ) : point.kind === "value" || point.kind === "bitmap" ? (
          <input
            type="number"
            value={Number(value ?? 0)}
            onChange={(event) => onChange(Number(event.target.value))}
            title={t("dp.reportHint")}
          />
        ) : (
          <input
            value={String(value ?? "")}
            onChange={(event) => onChange(event.target.value)}
            title={t("dp.reportHint")}
          />
        )}
        <button onClick={() => onChange(value)} title={`${modeLabel.title}; ${t("dp.reportModeHint")}`}>
          {t("dp.report")}
        </button>
      </div>
    </div>
  );
}

function dpModeLabel(mode: string, t: (key: string) => string) {
  // Debugfile 的 mode 表示云/App 对 DP 的读写方向；MCU 模拟器作为设备侧，ro 状态 DP 仍然应该能主动上报。
  if (mode === "ro") return { title: `ro: ${t("dp.reportHint")}` };
  if (mode === "rw" || mode === "wr") return { title: `${mode}: App download / MCU report` };
  if (mode === "w") return { title: "w: App download / MCU state report" };
  return { title: `${mode || "--"}: Debugfile DP mode` };
}

export function TimingEditor({
  title,
  mode,
  fixed,
  min,
  max,
  invalidMessage,
  fieldPrefix,
  onChange,
}: {
  title: string;
  mode: TimingMode;
  fixed: number;
  min: number;
  max: number;
  invalidMessage?: string;
  fieldPrefix: "delay" | "interval";
  onChange: (patch: Partial<TimerTask>) => void;
}) {
  const { t } = useTranslation();
  const patch = (key: "Mode" | "Seconds" | "MinSeconds" | "MaxSeconds", value: number | TimingMode) => {
    onChange({ [`${fieldPrefix}${key}`]: value } as Partial<TimerTask>);
  };
  return (
    <div className={`timing-editor ${invalidMessage ? "invalid" : ""}`}>
      <b>{title}</b>
      <select value={mode} onChange={(event) => patch("Mode", event.target.value as TimingMode)}>
        <option value="fixed">{t("timer.fixed")}</option>
        <option value="random">{t("timer.programRandom")}</option>
      </select>
      {mode === "fixed" ? (
        <label>
          <span>{t("timer.seconds")}</span>
          <input
            type="number"
            min={0}
            value={fixed}
            onChange={(event) => patch("Seconds", Number(event.target.value))}
          />
        </label>
      ) : (
        <div className="range-inputs">
          <label>
            <span>{t("timer.min")}</span>
            <input
              type="number"
              min={0}
              value={min}
              onChange={(event) => patch("MinSeconds", Number(event.target.value))}
            />
          </label>
          <label>
            <span>{t("timer.max")}</span>
            <input
              type="number"
              min={0}
              value={max}
              onChange={(event) => patch("MaxSeconds", Number(event.target.value))}
            />
          </label>
        </div>
      )}
      {invalidMessage ? <span className="field-error">{invalidMessage}</span> : null}
    </div>
  );
}

export function ManualValueEditor({
  point,
  item,
  invalidMessage,
  onChange,
}: {
  point?: DpPoint;
  item: TimerDpItem;
  invalidMessage?: string;
  onChange: (patch: Partial<TimerDpItem>) => void;
}) {
  const { t } = useTranslation();
  const values = splitValues(item.manualValues);
  const current = values.length ? (item.manualIndex % values.length) + 1 : 0;
  const preview = values.slice(0, 5).join(" -> ");
  return (
    <div className="manual-editor">
      <textarea
        className="timer-value-input"
        value={item.manualValues}
        placeholder={t("timer.manualPlaceholder")}
        rows={3}
        onChange={(event) => onChange({ manualValues: event.target.value, manualIndex: 0 })}
      />
      <div className="manual-meta">
        <span>
          {values.length ? t("timer.currentValue", { current, total: values.length }) : t("timer.noValues")}
        </span>
        <span title={point ? `${point.id} ${point.code}` : ""}>
          {preview
            ? `${preview}${values.length > 5 ? " -> ..." : ""} -> ${t("timer.loop")}`
            : t("timer.previewEmpty")}
        </span>
        {invalidMessage ? <span className="field-error">{invalidMessage}</span> : null}
      </div>
    </div>
  );
}

export function RandomValueEditor({
  point,
  item,
  invalidMessage,
  onChange,
}: {
  point?: DpPoint;
  item: TimerDpItem;
  invalidMessage?: string;
  onChange: (patch: Partial<TimerDpItem>) => void;
}) {
  const { t } = useTranslation();
  if (!point) {
    return <input className="timer-value-input" disabled value={t("timer.loadFirst")} />;
  }
  if (point.kind === "value" || point.kind === "bitmap") {
    const defaults = valueRange(point);
    return (
      <div className={`range-inputs compact ${invalidMessage ? "invalid" : ""}`}>
        <input
          type="number"
          value={item.randomMin ?? defaults.min}
          title={t("timer.randomMin")}
          onChange={(event) => onChange({ randomMin: Number(event.target.value) })}
        />
        <input
          type="number"
          value={item.randomMax ?? defaults.max}
          title={t("timer.randomMax")}
          onChange={(event) => onChange({ randomMax: Number(event.target.value) })}
        />
        <span className="random-hint">
          step {defaults.step} / scale {defaults.scale}
        </span>
        {invalidMessage ? <span className="field-error">{invalidMessage}</span> : null}
      </div>
    );
  }
  if (point.kind === "string" || point.kind === "raw") {
    return (
      <div className="manual-editor">
        <input
          className="timer-value-input"
          value={item.randomCandidates ?? ""}
          placeholder={t(point.kind === "raw" ? "timer.rawCandidates" : "timer.stringCandidates")}
          onChange={(event) => onChange({ randomCandidates: event.target.value })}
        />
        {invalidMessage ? <span className="field-error">{invalidMessage}</span> : null}
      </div>
    );
  }
  return (
    <span className="random-hint">
      {t(point.kind === "bool" ? "timer.randomBool" : "timer.randomEnum")}
      {invalidMessage ? `: ${invalidMessage}` : ""}
    </span>
  );
}
