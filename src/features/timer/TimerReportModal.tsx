import {
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Download,
  Pause,
  Play,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DpSchema } from "../../types";
import { ManualValueEditor, RandomValueEditor, TimingEditor } from "../dp/DpEditors";
import type { NetworkGate, ReportMode, TimerDpItem, TimerTask, ValueMode } from "./types";
import { timerItemError, timerStatusText, timerTaskRequiredHint, timingEditorError } from "./timer-utils";

type Props = {
  open: boolean;
  schema: DpSchema | null;
  serialOpen: boolean;
  tasks: TimerTask[];
  groupedTasks: Array<[string, TimerTask[]]>;
  collapsedGroups: Record<string, boolean>;
  onClose: () => void;
  onImport: () => void;
  onExport: () => void;
  onClear: () => void;
  onAddTask: () => void;
  onToggleGroup: (name: string) => void;
  onPatchTask: (taskId: string, patch: Partial<TimerTask>) => void;
  onStart: (taskId: string) => void;
  onPause: (taskId: string) => void;
  onRunNow: (taskId: string) => void;
  onDuplicate: (taskId: string) => void;
  onRemoveTask: (taskId: string) => void;
  onAddItem: (taskId: string) => void;
  onUpdateItem: (taskId: string, itemId: string, patch: Partial<TimerDpItem>) => void;
  onRemoveItem: (taskId: string, itemId: string) => void;
};

export function TimerReportModal(props: Props) {
  const { t } = useTranslation();
  if (!props.open) return null;
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => event.currentTarget === event.target && props.onClose()}
    >
      <section className="modal modal-wide">
        <div className="modal-head">
          <div>
            <h2>{t("timer.title")}</h2>
            <p>{t(props.schema && props.serialOpen ? "timer.ready" : "timer.blocked")}</p>
          </div>
          <button className="icon" title={t("common.close")} onClick={props.onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-status">
          <span>
            Debugfile:{" "}
            {props.schema ? t("timer.dpCount", { count: props.schema.points.length }) : t("common.notLoaded")}
          </span>
          <span>
            {t("toolbar.port")}: {t(props.serialOpen ? "common.opened" : "common.notOpened")}
          </span>
          <button onClick={props.onImport}>
            <Upload size={16} /> {t("timer.import")}
          </button>
          <button onClick={props.onExport} disabled={!props.tasks.length}>
            <Download size={16} /> {t("timer.export")}
          </button>
          <button className="danger" onClick={props.onClear} disabled={!props.tasks.length}>
            <Trash2 size={16} /> {t("timer.clear")}
          </button>
          <button onClick={props.onAddTask} disabled={!props.schema}>
            <Plus size={16} /> {t("timer.addTask")}
          </button>
        </div>
        <div className="timer-list">
          {!props.tasks.length ? (
            <div className="empty-state">{t("timer.empty")}</div>
          ) : (
            props.groupedTasks.map(([groupName, groupTasks]) => (
              <section className="timer-group" key={groupName}>
                <button className="timer-group-head" onClick={() => props.onToggleGroup(groupName)}>
                  {props.collapsedGroups[groupName] ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  <b>{groupName}</b>
                  <span>{t("timer.taskCount", { count: groupTasks.length })}</span>
                </button>
                {props.collapsedGroups[groupName]
                  ? null
                  : groupTasks.map((task) => <TimerTaskCard key={task.id} task={task} {...props} />)}
              </section>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function TimerTaskCard({ task, ...props }: Props & { task: TimerTask }) {
  const { t } = useTranslation();
  return (
    <article className="timer-card">
      <div className="timer-card-head">
        <input
          value={task.name}
          onChange={(event) =>
            props.onPatchTask(task.id, {
              name: event.target.value,
              enabled: false,
              status: "idle",
              nextRunAt: null,
            })
          }
          placeholder={t("timer.taskName")}
        />
        <span className={`timer-status ${task.status}`}>{timerStatusText(task)}</span>
        <span className="timer-runs">
          {t("timer.runs", { count: task.runCount })}
          {task.maxRuns ? ` / ${task.maxRuns}` : ` / ${t("common.unlimited")}`}
        </span>
        {task.enabled ? (
          <button onClick={() => props.onPause(task.id)}>
            <Pause size={16} /> {t("timer.pause")}
          </button>
        ) : (
          <button
            className="primary"
            onClick={() => props.onStart(task.id)}
            disabled={task.status === "running"}
          >
            <Play size={16} /> {t("timer.start")}
          </button>
        )}
        <button onClick={() => props.onRunNow(task.id)} disabled={task.status === "running"}>
          <Clock size={16} /> {t("timer.runNow")}
        </button>
        <button className="icon" title={t("timer.duplicate")} onClick={() => props.onDuplicate(task.id)}>
          <Copy size={16} />
        </button>
        <button className="icon" title={t("timer.remove")} onClick={() => props.onRemoveTask(task.id)}>
          <Trash2 size={16} />
        </button>
      </div>
      <div className="timer-options">
        <label>
          <span>{t("timer.group")}</span>
          <input
            list="timer-group-options"
            value={task.groupName}
            onChange={(event) =>
              props.onPatchTask(task.id, {
                groupName: event.target.value || t("timer.defaultGroup"),
                enabled: false,
                status: "idle",
                nextRunAt: null,
              })
            }
          />
        </label>
        <label
          className={
            task.maxRuns !== null && (!Number.isFinite(task.maxRuns) || task.maxRuns < 1)
              ? "field-invalid"
              : ""
          }
        >
          <span>{t("timer.maxRuns")}</span>
          <input
            type="number"
            min={1}
            value={task.maxRuns ?? ""}
            placeholder={t("common.unlimited")}
            onChange={(event) =>
              props.onPatchTask(task.id, {
                maxRuns: event.target.value ? Math.max(1, Number(event.target.value)) : null,
              })
            }
          />
        </label>
        <label>
          <span>{t("timer.reportMode")}</span>
          <select
            value={task.reportMode}
            onChange={(event) =>
              props.onPatchTask(task.id, {
                reportMode: event.target.value as ReportMode,
                enabled: false,
                status: "idle",
                nextRunAt: null,
              })
            }
          >
            <option value="batch">{t("timer.batch")}</option>
            <option value="sequential">{t("timer.sequential")}</option>
          </select>
        </label>
        <label>
          <span>{t("timer.network")}</span>
          <select
            value={task.networkGate}
            onChange={(event) =>
              props.onPatchTask(task.id, {
                networkGate: event.target.value as NetworkGate,
                enabled: false,
                status: "idle",
                nextRunAt: null,
              })
            }
          >
            <option value="none">{t("timer.none")}</option>
            <option value="cloud">{t("timer.cloud")}</option>
            <option value="router_or_above">{t("timer.router")}</option>
            <option value="specific">{t("timer.specific")}</option>
          </select>
        </label>
        {task.networkGate === "specific" ? (
          <label
            className={
              !Number.isFinite(task.networkSpecificCode) ||
              (task.networkSpecificCode ?? 0) < 0 ||
              (task.networkSpecificCode ?? 0) > 255
                ? "field-invalid"
                : ""
            }
          >
            <span>{t("timer.stateCode")}</span>
            <input
              type="number"
              min={0}
              max={255}
              value={task.networkSpecificCode ?? 4}
              onChange={(event) =>
                props.onPatchTask(task.id, { networkSpecificCode: Number(event.target.value) })
              }
            />
          </label>
        ) : null}
      </div>
      <datalist id="timer-group-options">
        {["defaultGroup", "stateGroup", "scenarioGroup", "eventGroup"].map((name) => (
          <option key={name} value={t(`timer.${name}`)} />
        ))}
      </datalist>
      <div className="timer-grid">
        <TimingEditor
          title={t("timer.delay")}
          mode={task.delayMode}
          fixed={task.delaySeconds}
          min={task.delayMinSeconds}
          max={task.delayMaxSeconds}
          invalidMessage={timingEditorError(task, "delay")}
          onChange={(patch) =>
            props.onPatchTask(task.id, { ...patch, enabled: false, status: "idle", nextRunAt: null })
          }
          fieldPrefix="delay"
        />
        <TimingEditor
          title={t("timer.interval")}
          mode={task.intervalMode}
          fixed={task.intervalSeconds}
          min={task.intervalMinSeconds}
          max={task.intervalMaxSeconds}
          invalidMessage={timingEditorError(task, "interval")}
          onChange={(patch) =>
            props.onPatchTask(task.id, { ...patch, enabled: false, status: "idle", nextRunAt: null })
          }
          fieldPrefix="interval"
        />
      </div>
      <div className="timer-items">
        <div className="timer-items-head">
          <b>{t("timer.items")}</b>
          <button onClick={() => props.onAddItem(task.id)} disabled={!props.schema}>
            <Plus size={16} /> {t("timer.addDp")}
          </button>
        </div>
        {task.items.map((item) => (
          <TimerDpItemEditor
            key={item.id}
            taskId={task.id}
            item={item}
            schema={props.schema}
            onUpdate={props.onUpdateItem}
            onRemove={props.onRemoveItem}
          />
        ))}
      </div>
      {timerTaskRequiredHint(task, props.schema, props.serialOpen) ? (
        <p className="timer-error">{timerTaskRequiredHint(task, props.schema, props.serialOpen)}</p>
      ) : null}
      {task.lastError ? <p className="timer-error">{task.lastError}</p> : null}
    </article>
  );
}

function TimerDpItemEditor({
  taskId,
  item,
  schema,
  onUpdate,
  onRemove,
}: {
  taskId: string;
  item: TimerDpItem;
  schema: DpSchema | null;
  onUpdate: Props["onUpdateItem"];
  onRemove: Props["onRemoveItem"];
}) {
  const { t } = useTranslation();
  const point = schema?.points.find((dp) => dp.code === item.dpCode) ?? schema?.points[0];
  const itemError = timerItemError(item, schema);
  return (
    <div className={`timer-item ${itemError ? "invalid" : ""}`}>
      <select
        className={!point ? "invalid-control" : ""}
        value={item.dpCode}
        onChange={(event) => onUpdate(taskId, item.id, { dpCode: event.target.value, manualIndex: 0 })}
      >
        {(schema?.points ?? []).map((dp) => (
          <option key={dp.code} value={dp.code}>
            {dp.id} {dp.code} {dp.name}
          </option>
        ))}
      </select>
      <select
        value={item.valueMode}
        onChange={(event) =>
          onUpdate(taskId, item.id, { valueMode: event.target.value as ValueMode, manualIndex: 0 })
        }
      >
        <option value="manual">{t("timer.manual")}</option>
        <option value="random">{t("timer.random")}</option>
      </select>
      {item.valueMode === "manual" ? (
        <ManualValueEditor
          point={point}
          item={item}
          invalidMessage={itemError}
          onChange={(patch) => onUpdate(taskId, item.id, patch)}
        />
      ) : (
        <RandomValueEditor
          point={point}
          item={item}
          invalidMessage={itemError}
          onChange={(patch) => onUpdate(taskId, item.id, patch)}
        />
      )}
      <button className="icon" title={t("timer.removeDp")} onClick={() => onRemove(taskId, item.id)}>
        <Trash2 size={16} />
      </button>
    </div>
  );
}
