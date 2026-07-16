import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
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
import { DpSelect } from "../dp/DpSelect";
import type { NetworkGate, ReportMode, TimerDpItem, TimerTask, ValueMode } from "./types";
import {
  summarizeTimerGroup,
  timerItemError,
  timerStatusText,
  timerTaskRequiredHint,
  timingEditorError,
  validateTimerTaskConfig,
} from "./timer-utils";
import { ScriptTaskEditor } from "./ScriptTaskEditor";

type Props = {
  open: boolean;
  schema: DpSchema | null;
  serialOpen: boolean;
  tasks: TimerTask[];
  groupedTasks: Array<[string, TimerTask[]]>;
  collapsedGroups: Record<string, boolean>;
  collapsedTasks: Record<string, boolean>;
  onClose: () => void;
  onImport: () => void;
  onExport: () => void;
  onClear: () => void;
  onAddTask: () => void;
  onToggleGroup: (name: string) => void;
  isGroupCollapsed: (name: string) => boolean;
  onExpandAllGroups: () => void;
  onCollapseAllGroups: () => void;
  onToggleTask: (taskId: string) => void;
  isTaskCollapsed: (taskId: string) => boolean;
  onExpandAllTasks: () => void;
  onCollapseAllTasks: () => void;
  onStartGroup: (name: string) => void;
  onPauseGroup: (name: string) => void;
  onPatchTask: (taskId: string, patch: Partial<TimerTask>) => void;
  onStart: (taskId: string) => void;
  onPause: (taskId: string) => void;
  onRunNow: (taskId: string) => void;
  onDuplicate: (taskId: string) => void;
  onRemoveTask: (taskId: string) => void;
  onAddItem: (taskId: string) => void;
  onUpdateItem: (taskId: string, itemId: string, patch: Partial<TimerDpItem>) => void;
  onRemoveItem: (taskId: string, itemId: string) => void;
  scriptPreviews: Record<
    string,
    { loading: boolean; result?: import("./types").TimerScriptResponse; error?: string }
  >;
  onGenerationModeChange: (taskId: string, mode: TimerTask["generationMode"]) => void;
  onScriptChange: (taskId: string, patch: Partial<NonNullable<TimerTask["script"]>>) => void;
  onScriptPreview: (taskId: string) => void;
  onScriptReset: (taskId: string) => void;
};

export function TimerReportModal(props: Props) {
  const { t, i18n } = useTranslation();
  const allGroupsExpanded =
    props.groupedTasks.length > 0 &&
    props.groupedTasks.every(([groupName]) => !props.isGroupCollapsed(groupName));
  const allTasksExpanded =
    props.tasks.length > 0 && props.tasks.every((task) => !props.isTaskCollapsed(task.id));
  const everythingExpanded = allGroupsExpanded && allTasksExpanded;
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
          <button
            onClick={() => {
              if (everythingExpanded) {
                props.onCollapseAllTasks();
                props.onCollapseAllGroups();
              } else {
                props.onExpandAllGroups();
                props.onExpandAllTasks();
              }
            }}
            disabled={!props.groupedTasks.length}
          >
            {everythingExpanded ? <ChevronsDownUp size={16} /> : <ChevronsUpDown size={16} />}
            {t(everythingExpanded ? "timer.collapseAll" : "timer.expandAll")}
          </button>
        </div>
        <div className="timer-list">
          {!props.tasks.length ? (
            <div className="empty-state">{t("timer.empty")}</div>
          ) : (
            props.groupedTasks.map(([groupName, groupTasks]) => {
              const collapsed = props.isGroupCollapsed(groupName);
              const summary = summarizeTimerGroup(groupTasks, i18n.language);
              const activeCount = groupTasks.filter(isActiveTask).length;
              return (
                <section className="timer-group" key={groupName}>
                  <div className="timer-group-head">
                    <button
                      className="timer-group-toggle"
                      onClick={() => props.onToggleGroup(groupName)}
                      title={summary.full}
                    >
                      {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                      <b>{groupName}</b>
                      <span className="timer-group-count">
                        {t("timer.taskCount", { count: groupTasks.length })}
                      </span>
                      <span className="timer-group-summary" title={summary.full}>
                        {summary.visible}
                      </span>
                    </button>
                    <div className="timer-group-actions">
                      {activeCount ? <span>{t("timer.activeCount", { count: activeCount })}</span> : null}
                      <button
                        className="primary"
                        onClick={() => props.onStartGroup(groupName)}
                        disabled={activeCount === groupTasks.length}
                      >
                        <Play size={15} /> {t("timer.startAll")}
                      </button>
                      <button onClick={() => props.onPauseGroup(groupName)} disabled={activeCount === 0}>
                        <Pause size={15} /> {t("timer.pauseAll")}
                      </button>
                    </div>
                  </div>
                  {collapsed
                    ? null
                    : groupTasks.map((task) => <TimerTaskCard key={task.id} task={task} {...props} />)}
                </section>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

function isActiveTask(task: TimerTask) {
  return task.enabled || ["waiting", "network_wait", "running"].includes(task.status);
}

function TimerTaskCard({ task, ...props }: Props & { task: TimerTask }) {
  const { t } = useTranslation();
  const collapsed = props.isTaskCollapsed(task.id);
  // 紧凑头部只标记配置或真实运行错误；串口暂未打开、正常暂停不应让所有任务都显示红色。
  const taskError =
    validateTimerTaskConfig(task, props.schema)?.message ||
    (task.status === "error"
      ? task.lastError || timerTaskRequiredHint(task, props.schema, props.serialOpen)
      : "");
  return (
    <article className={`timer-card ${collapsed ? "collapsed" : ""}`}>
      <div className="timer-card-head">
        <button
          className="icon timer-task-toggle"
          title={t(collapsed ? "timer.expandTask" : "timer.collapseTask")}
          aria-label={t(collapsed ? "timer.expandTask" : "timer.collapseTask")}
          aria-expanded={!collapsed}
          onClick={() => props.onToggleTask(task.id)}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </button>
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
        {taskError ? (
          <span className="timer-task-error" title={taskError} aria-label={taskError}>
            <CircleAlert size={17} />
          </span>
        ) : null}
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
      {collapsed ? null : (
        <>
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
          <div className="generation-mode" role="group" aria-label={t("timer.generationMode")}>
            <button
              className={task.generationMode === "items" ? "active" : ""}
              onClick={() => props.onGenerationModeChange(task.id, "items")}
            >
              {t("timer.normalGeneration")}
            </button>
            <button
              className={task.generationMode === "script" ? "active" : ""}
              onClick={() => props.onGenerationModeChange(task.id, "script")}
            >
              {t("timer.scriptGeneration")}
            </button>
          </div>
          {task.generationMode === "script" && task.script ? (
            <ScriptTaskEditor
              script={task.script}
              preview={props.scriptPreviews[task.id]}
              onChange={(patch) => props.onScriptChange(task.id, patch)}
              onPreview={() => props.onScriptPreview(task.id)}
              onReset={() => props.onScriptReset(task.id)}
            />
          ) : (
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
          )}
          {timerTaskRequiredHint(task, props.schema, props.serialOpen) ? (
            <p className="timer-error">{timerTaskRequiredHint(task, props.schema, props.serialOpen)}</p>
          ) : null}
          {task.lastError ? <p className="timer-error">{task.lastError}</p> : null}
        </>
      )}
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
      <DpSelect
        points={schema?.points ?? []}
        value={item.dpCode}
        invalid={!point}
        compact
        onChange={(code) => onUpdate(taskId, item.id, { dpCode: code, manualIndex: 0 })}
      />
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
