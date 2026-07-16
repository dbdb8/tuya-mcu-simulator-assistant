import { useMemo, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FlaskConical,
  Plus,
  Power,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DpPoint, DpSchema } from "../../types";
import { ManualValueEditor, RandomValueEditor, TimingEditor } from "../dp/DpEditors";
import { DpSelect } from "../dp/DpSelect";
import { ScriptTaskEditor } from "../timer/ScriptTaskEditor";
import { timerItemError } from "../timer/timer-utils";
import type { TimerDpItem } from "../timer/types";
import { defaultTriggerValue, parseTriggerInput, triggerRuleError } from "./trigger-utils";
import type { TriggerPreview, TriggerRule, TriggerRuntimeState } from "./types";

type Props = {
  open: boolean;
  schema: DpSchema | null;
  serialOpen: boolean;
  rules: TriggerRule[];
  masterEnabled: boolean;
  runtime: TriggerRuntimeState | null;
  previews: Record<string, { loading: boolean; result?: TriggerPreview; error?: string }>;
  onClose: () => void;
  onMasterChange: (enabled: boolean) => void;
  onImport: () => void;
  onExport: () => void;
  onClear: () => void;
  onAdd: () => void;
  onPatch: (id: string, patch: Partial<TriggerRule>) => void;
  onRuleEnabled: (id: string, enabled: boolean) => void;
  onGroupEnabled: (ids: string[], enabled: boolean) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  onAddItem: (id: string) => void;
  onUpdateItem: (ruleId: string, itemId: string, patch: Partial<TimerDpItem>) => void;
  onRemoveItem: (ruleId: string, itemId: string) => void;
  onGenerationModeChange: (id: string, mode: TriggerRule["generationMode"]) => void;
  onScriptChange: (id: string, patch: Partial<NonNullable<TriggerRule["script"]>>) => void;
  onScriptReset: (id: string) => void;
  onPreview: (id: string, value?: unknown) => void;
};

export function TriggerReportModal(props: Props) {
  const { t } = useTranslation();
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [collapsedRules, setCollapsedRules] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => {
    const grouped = new Map<string, TriggerRule[]>();
    for (const rule of props.rules) {
      const group = rule.groupName || t("trigger.defaultGroup");
      grouped.set(group, [...(grouped.get(group) ?? []), rule]);
    }
    return Array.from(grouped.entries());
  }, [props.rules, t]);
  const runnableCount = props.rules.filter(
    (rule) => rule.enabled && !props.runtime?.ruleErrors[rule.id],
  ).length;
  if (!props.open) return null;
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => event.currentTarget === event.target && props.onClose()}
    >
      <section className="modal modal-wide trigger-modal">
        <div className="modal-head">
          <div>
            <h2>{t("trigger.title")}</h2>
            <p>
              {t(
                props.schema && props.serialOpen
                  ? props.masterEnabled && runnableCount === 0
                    ? "trigger.noRunnable"
                    : "trigger.ready"
                  : "trigger.blocked",
              )}
            </p>
          </div>
          <button className="icon" title={t("common.close")} onClick={props.onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-status trigger-toolbar">
          <label className="trigger-master">
            <input
              type="checkbox"
              checked={props.masterEnabled}
              disabled={!props.schema || !props.serialOpen}
              onChange={(event) => props.onMasterChange(event.target.checked)}
            />
            <Power size={16} /> {t("trigger.master")}
          </label>
          <span>{t("trigger.pending", { count: props.runtime?.pendingCount ?? 0 })}</span>
          <span>{t("trigger.activeSequences", { count: props.runtime?.activeSequences.length ?? 0 })}</span>
          <button onClick={props.onImport}>
            <Upload size={16} /> {t("trigger.import")}
          </button>
          <button onClick={props.onExport} disabled={!props.rules.length}>
            <Download size={16} /> {t("trigger.export")}
          </button>
          <button className="danger" onClick={props.onClear} disabled={!props.rules.length}>
            <Trash2 size={16} /> {t("trigger.clear")}
          </button>
          <button onClick={props.onAdd} disabled={!props.schema}>
            <Plus size={16} /> {t("trigger.add")}
          </button>
        </div>
        <div className="timer-list">
          {!props.rules.length ? <div className="empty-state">{t("trigger.empty")}</div> : null}
          {groups.map(([groupName, rules]) => {
            const collapsed = collapsedGroups[groupName] ?? true;
            const enabledCount = rules.filter((rule) => rule.enabled).length;
            const pausedCount = rules.filter(
              (rule) => rule.enabled && props.runtime?.ruleErrors[rule.id],
            ).length;
            const activeCount =
              props.runtime?.activeSequences.filter((sequence) =>
                rules.some((rule) => rule.id === sequence.ruleId),
              ).length ?? 0;
            return (
              <section className="timer-group" key={groupName}>
                <div className="timer-group-head">
                  <button
                    className="timer-group-toggle"
                    onClick={() => setCollapsedGroups((current) => ({ ...current, [groupName]: !collapsed }))}
                  >
                    {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                    <b>{groupName}</b>
                    <span className="timer-group-count">
                      {t("trigger.ruleCount", { count: rules.length })}
                    </span>
                    <span className="timer-group-summary">
                      {t("trigger.groupSummary", {
                        enabled: enabledCount,
                        paused: pausedCount,
                        active: activeCount,
                      })}
                    </span>
                  </button>
                  <div className="timer-group-actions">
                    <button
                      disabled={enabledCount === rules.length}
                      onClick={() =>
                        props.onGroupEnabled(
                          rules.map((rule) => rule.id),
                          true,
                        )
                      }
                    >
                      {t("trigger.enableAll")}
                    </button>
                    <button
                      disabled={enabledCount === 0}
                      onClick={() =>
                        props.onGroupEnabled(
                          rules.map((rule) => rule.id),
                          false,
                        )
                      }
                    >
                      {t("trigger.disableAll")}
                    </button>
                  </div>
                </div>
                {collapsed
                  ? null
                  : rules.map((rule) => (
                      <TriggerRuleCard
                        key={rule.id}
                        rule={rule}
                        collapsed={collapsedRules[rule.id] ?? true}
                        onToggle={() =>
                          setCollapsedRules((current) => ({
                            ...current,
                            [rule.id]: !(current[rule.id] ?? true),
                          }))
                        }
                        {...props}
                      />
                    ))}
              </section>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function TriggerRuleCard({
  rule,
  collapsed,
  onToggle,
  ...props
}: Props & { rule: TriggerRule; collapsed: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const error = triggerRuleError(rule, props.schema);
  const runtimeError = props.runtime?.ruleErrors[rule.id];
  const point = props.schema?.points.find((item) => item.code === rule.triggerCode);
  const previewValue = rule.matchValue ?? defaultTriggerValue(point);
  return (
    <article className={`timer-card ${collapsed ? "collapsed" : ""}`}>
      <div className="timer-card-head">
        <button
          className="icon"
          title={t(collapsed ? "timer.expandTask" : "timer.collapseTask")}
          onClick={onToggle}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </button>
        <input
          value={rule.name}
          placeholder={t("trigger.ruleName")}
          onChange={(event) => props.onPatch(rule.id, { name: event.target.value })}
        />
        <label className="inline-check">
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={(event) => props.onRuleEnabled(rule.id, event.target.checked)}
          />
          {t("trigger.enabled")}
        </label>
        <span className="timer-runs">{t("trigger.triggered", { count: rule.triggerCount })}</span>
        {runtimeError ? (
          <span className="timer-task-error" title={runtimeError}>
            <AlertCircle size={17} /> {t("trigger.configPaused")}
          </span>
        ) : error || rule.lastError ? (
          <span className="timer-task-error" title={error || rule.lastError}>
            <AlertCircle size={17} />
          </span>
        ) : null}
        <button
          onClick={() => props.onPreview(rule.id, previewValue)}
          disabled={props.previews[rule.id]?.loading}
        >
          <FlaskConical size={16} /> {t("trigger.preview")}
        </button>
        <button className="icon" title={t("timer.duplicate")} onClick={() => props.onDuplicate(rule.id)}>
          <Copy size={16} />
        </button>
        <button className="icon" title={t("timer.remove")} onClick={() => props.onRemove(rule.id)}>
          <Trash2 size={16} />
        </button>
      </div>
      {collapsed ? null : (
        <>
          <section className="trigger-section">
            <div className="trigger-section-title">{t("trigger.conditionSection")}</div>
            <div className="trigger-options">
              <label>
                <span>{t("timer.group")}</span>
                <input
                  value={rule.groupName}
                  onChange={(event) => props.onPatch(rule.id, { groupName: event.target.value })}
                />
              </label>
              <label>
                <span>{t("trigger.triggerDp")}</span>
                <DpSelect
                  points={props.schema?.points ?? []}
                  value={rule.triggerCode}
                  onChange={(code) => {
                    const next = props.schema?.points.find((item) => item.code === code);
                    props.onPatch(rule.id, {
                      triggerCode: code,
                      matchValue: defaultTriggerValue(next),
                      matchValues: [],
                    });
                  }}
                />
              </label>
              <label>
                <span>{t("trigger.matchMode")}</span>
                <select
                  value={rule.matchMode}
                  onChange={(event) =>
                    props.onPatch(rule.id, { matchMode: event.target.value as TriggerRule["matchMode"] })
                  }
                >
                  <option value="any">{t("trigger.matchAny")}</option>
                  <option value="equals">{t("trigger.matchEquals")}</option>
                  <option value="one_of">{t("trigger.matchOneOf")}</option>
                  {point?.kind === "value" || point?.kind === "bitmap" ? (
                    <option value="range">{t("trigger.matchRange")}</option>
                  ) : null}
                </select>
              </label>
              <div className="trigger-field">
                <span>{t("trigger.matchValueLabel")}</span>
                <MatchEditor rule={rule} point={point} onPatch={(patch) => props.onPatch(rule.id, patch)} />
              </div>
              <label>
                <span>{t("trigger.executionMode")}</span>
                <select
                  value={rule.executionMode}
                  onChange={(event) =>
                    props.onPatch(rule.id, {
                      executionMode: event.target.value as TriggerRule["executionMode"],
                    })
                  }
                >
                  <option value="once">{t("trigger.once")}</option>
                  <option value="sequence">{t("trigger.sequence")}</option>
                </select>
              </label>
              <label>
                <span>{t("timer.reportMode")}</span>
                <select
                  value={rule.reportMode}
                  onChange={(event) =>
                    props.onPatch(rule.id, { reportMode: event.target.value as TriggerRule["reportMode"] })
                  }
                >
                  <option value="batch">{t("timer.batch")}</option>
                  <option value="sequential">{t("timer.sequential")}</option>
                </select>
              </label>
            </div>
          </section>
          <section className="trigger-section">
            <div className="trigger-section-title">{t("trigger.scheduleSection")}</div>
            <div className="timer-grid trigger-timing-grid">
              <TimingEditor
                title={t("trigger.firstDelay")}
                mode={rule.delayMode}
                fixed={rule.delaySeconds}
                min={rule.delayMinSeconds}
                max={rule.delayMaxSeconds}
                fieldPrefix="delay"
                onChange={(patch) => props.onPatch(rule.id, patch as Partial<TriggerRule>)}
              />
              {rule.executionMode === "sequence" ? (
                <TimingEditor
                  title={t("timer.interval")}
                  mode={rule.intervalMode}
                  fixed={rule.intervalSeconds}
                  min={rule.intervalMinSeconds}
                  max={rule.intervalMaxSeconds}
                  fieldPrefix="interval"
                  onChange={(patch) => props.onPatch(rule.id, patch as Partial<TriggerRule>)}
                />
              ) : null}
            </div>
            {rule.executionMode === "sequence" ? (
              <SequenceEditor rule={rule} onPatch={(patch) => props.onPatch(rule.id, patch)} />
            ) : null}
          </section>
          <section className="trigger-section response-section">
            <div className="trigger-section-title">{t("trigger.responseSection")}</div>
            <div className="generation-mode" role="group" aria-label={t("timer.generationMode")}>
              <button
                className={rule.generationMode === "items" ? "active" : ""}
                onClick={() => props.onGenerationModeChange(rule.id, "items")}
              >
                {t("timer.normalGeneration")}
              </button>
              <button
                className={rule.generationMode === "script" ? "active" : ""}
                onClick={() => props.onGenerationModeChange(rule.id, "script")}
              >
                {t("timer.scriptGeneration")}
              </button>
            </div>
            {rule.generationMode === "script" && rule.script ? (
              <ScriptTaskEditor
                script={rule.script}
                preview={props.previews[rule.id]}
                onChange={(patch) => props.onScriptChange(rule.id, patch)}
                onPreview={() => props.onPreview(rule.id, previewValue)}
                onReset={() => props.onScriptReset(rule.id)}
              />
            ) : (
              <div className="timer-items">
                <div className="timer-items-head">
                  <b>{t("trigger.outputItems")}</b>
                  <button onClick={() => props.onAddItem(rule.id)}>
                    <Plus size={16} /> {t("timer.addDp")}
                  </button>
                </div>
                {rule.items.map((item) => (
                  <TriggerItem
                    key={item.id}
                    ruleId={rule.id}
                    item={item}
                    schema={props.schema}
                    onUpdate={props.onUpdateItem}
                    onRemove={props.onRemoveItem}
                  />
                ))}
              </div>
            )}
          </section>
          {runtimeError ? (
            <p className="timer-error">{runtimeError}</p>
          ) : error ? (
            <p className="timer-error">{error}</p>
          ) : null}
          {rule.lastError ? <p className="timer-error">{rule.lastError}</p> : null}
          {props.previews[rule.id]?.result ? (
            <div className="script-preview">
              <b>{t("trigger.previewResult")}</b>
              <pre>{JSON.stringify(props.previews[rule.id].result, null, 2)}</pre>
            </div>
          ) : null}
          {props.previews[rule.id]?.error ? (
            <p className="timer-error">{props.previews[rule.id].error}</p>
          ) : null}
        </>
      )}
    </article>
  );
}

function MatchEditor({
  rule,
  point,
  onPatch,
}: {
  rule: TriggerRule;
  point?: DpPoint;
  onPatch: (patch: Partial<TriggerRule>) => void;
}) {
  const { t } = useTranslation();
  if (rule.matchMode === "any")
    return <span className="trigger-match-hint">{t("trigger.anyValueHint")}</span>;
  if (rule.matchMode === "range")
    return (
      <div className="range-inputs compact">
        <input
          type="number"
          value={rule.matchMin ?? 0}
          onChange={(event) => onPatch({ matchMin: Number(event.target.value) })}
        />
        <input
          type="number"
          value={rule.matchMax ?? 100}
          onChange={(event) => onPatch({ matchMax: Number(event.target.value) })}
        />
      </div>
    );
  if (rule.matchMode === "one_of")
    return (
      <textarea
        rows={2}
        value={rule.matchValues.map(String).join("\n")}
        placeholder={t("trigger.matchValuesPlaceholder")}
        onChange={(event) =>
          onPatch({
            matchValues: event.target.value
              .split(/\r?\n/)
              .map((value) => value.trim())
              .filter(Boolean)
              .map((value) => parseTriggerInput(point, value)),
          })
        }
      />
    );
  if (point?.kind === "bool") {
    return (
      <select
        value={String(rule.matchValue ?? true)}
        onChange={(event) => onPatch({ matchValue: event.target.value === "true" })}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (point?.kind === "enum" && Array.isArray(point.property.range)) {
    return (
      <select
        value={String(rule.matchValue ?? "")}
        onChange={(event) => onPatch({ matchValue: event.target.value })}
      >
        {(point.property.range as string[]).map((value) => (
          <option key={value}>{value}</option>
        ))}
      </select>
    );
  }
  return (
    <input
      value={String(rule.matchValue ?? "")}
      onChange={(event) => onPatch({ matchValue: parseTriggerInput(point, event.target.value) })}
    />
  );
}

function SequenceEditor({
  rule,
  onPatch,
}: {
  rule: TriggerRule;
  onPatch: (patch: Partial<TriggerRule>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="trigger-options sequence-options">
      <label>
        <span>{t("trigger.sequenceGroup")}</span>
        <input
          value={rule.sequenceGroup}
          onChange={(event) => onPatch({ sequenceGroup: event.target.value })}
        />
      </label>
      <label>
        <span>{t("trigger.sequenceAction")}</span>
        <select
          value={rule.sequenceAction}
          onChange={(event) =>
            onPatch({ sequenceAction: event.target.value as TriggerRule["sequenceAction"] })
          }
        >
          <option value="replace">{t("trigger.replace")}</option>
          <option value="ignore">{t("trigger.ignore")}</option>
          <option value="queue">{t("trigger.queue")}</option>
          <option value="cancel">{t("trigger.cancel")}</option>
        </select>
      </label>
      <label>
        <span>{t("trigger.maxRuns")}</span>
        <input
          type="number"
          min={1}
          value={rule.maxRuns ?? ""}
          placeholder={t("common.unlimited")}
          onChange={(event) => onPatch({ maxRuns: event.target.value ? Number(event.target.value) : null })}
        />
      </label>
      <label>
        <span>{t("trigger.maxDuration")}</span>
        <input
          type="number"
          min={0}
          value={rule.maxDurationSeconds ?? ""}
          placeholder={t("common.unlimited")}
          onChange={(event) =>
            onPatch({ maxDurationSeconds: event.target.value ? Number(event.target.value) : null })
          }
        />
      </label>
    </div>
  );
}

function TriggerItem({
  ruleId,
  item,
  schema,
  onUpdate,
  onRemove,
}: {
  ruleId: string;
  item: TimerDpItem;
  schema: DpSchema | null;
  onUpdate: Props["onUpdateItem"];
  onRemove: Props["onRemoveItem"];
}) {
  const { t } = useTranslation();
  const point = schema?.points.find((dp) => dp.code === item.dpCode) ?? schema?.points[0];
  const error = timerItemError(item, schema);
  return (
    <div className={`timer-item ${error ? "invalid" : ""}`}>
      <DpSelect
        points={schema?.points ?? []}
        value={item.dpCode}
        invalid={!point}
        // 触发 DP 与响应 DP 使用相同的完整标签，避免配置关联关系时只看到 code 而误选。
        onChange={(code) => onUpdate(ruleId, item.id, { dpCode: code, manualIndex: 0 })}
      />
      <select
        value={item.valueMode}
        onChange={(event) =>
          onUpdate(ruleId, item.id, {
            valueMode: event.target.value as TimerDpItem["valueMode"],
            manualIndex: 0,
          })
        }
      >
        <option value="manual">{t("timer.manual")}</option>
        <option value="random">{t("timer.random")}</option>
      </select>
      {item.valueMode === "manual" ? (
        <ManualValueEditor
          point={point}
          item={item}
          invalidMessage={error}
          onChange={(patch) => onUpdate(ruleId, item.id, patch)}
        />
      ) : (
        <RandomValueEditor
          point={point}
          item={item}
          invalidMessage={error}
          onChange={(patch) => onUpdate(ruleId, item.id, patch)}
        />
      )}
      <button className="icon" title={t("timer.removeDp")} onClick={() => onRemove(ruleId, item.id)}>
        <Trash2 size={16} />
      </button>
    </div>
  );
}
