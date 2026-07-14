import { Save, Trash2 } from "lucide-react";
import type { SerialLog } from "../../types";
import { formatLogTime } from "../../utils/log-utils";
import { useTranslation } from "react-i18next";

export type LogMode = "all" | "frame" | "raw";

export function LogPanel({
  logs,
  mode,
  busy,
  onModeChange,
  onSave,
  onClear,
}: {
  logs: SerialLog[];
  mode: LogMode;
  busy: boolean;
  onModeChange: (mode: LogMode) => void;
  onSave: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const visibleLogs = logs.filter((log) => {
    // Raw 是串口 read 的物理分片；常规视图只展示完整协议帧，避免把半包误判为接收截断。
    if (mode === "all" || mode === "frame") return !log.raw;
    return log.raw || log.direction === "tx" || log.direction === "error";
  });
  return (
    <aside className="panel logs">
      <div className="panel-head">
        <h2>{t("logs.title")}</h2>
        <div>
          <button
            className={`log-mode-button ${mode === "all" ? "active" : ""}`}
            title={t("logs.allTitle")}
            onClick={() => onModeChange("all")}
          >
            {t("logs.all")}
          </button>
          <button
            className={`log-mode-button ${mode === "frame" ? "active" : ""}`}
            title={t("logs.frameTitle")}
            onClick={() => onModeChange("frame")}
          >
            {t("logs.frames")}
          </button>
          <button
            className={`log-mode-button ${mode === "raw" ? "active" : ""}`}
            title={t("logs.rawTitle")}
            onClick={() => onModeChange("raw")}
          >
            {t("logs.raw")}
          </button>
          <button className="icon" title={t("logs.save")} onClick={onSave} disabled={busy}>
            <Save size={17} />
          </button>
          <button className="icon" title={t("logs.clear")} onClick={onClear}>
            <Trash2 size={17} />
          </button>
        </div>
      </div>
      {mode === "raw" ? <p className="log-hint">{t("logs.rawHint")}</p> : null}
      <div className="log-list">
        {visibleLogs.map((log, index) => (
          <div className={`log ${log.direction}`} key={`${log.hex}-${index}`}>
            <div className="log-title">
              <b>
                {t(
                  log.direction === "tx" ? "logs.tx" : log.direction === "error" ? "common.error" : "logs.rx",
                )}
              </b>
              <time>{formatLogTime(log.timestamp_ms)}</time>
            </div>
            <span>
              {log.title}
              {typeof log.command === "number"
                ? ` CMD 0x${log.command.toString(16).padStart(2, "0").toUpperCase()}`
                : ""}
            </span>
            <code>{log.hex}</code>
          </div>
        ))}
      </div>
    </aside>
  );
}
