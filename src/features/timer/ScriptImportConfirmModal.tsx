import { FileCode2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PendingTimerImport } from "./types";

export function ScriptImportConfirmModal({
  pending,
  onConfirm,
  onCancel,
}: {
  pending: PendingTimerImport | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  if (!pending) return null;
  return (
    <div className="modal-backdrop">
      <section className="modal script-import-modal">
        <div className="modal-head">
          <div>
            <h2>{t("timer.scriptImportTitle")}</h2>
            <p>{t("timer.scriptImportHint")}</p>
          </div>
          <button className="icon" title={t("common.close")} onClick={onCancel}>
            <X size={18} />
          </button>
        </div>
        <div className="script-import-summary">
          <code>{pending.sourcePath}</code>
          {pending.scriptTasks.map((task) => (
            <div key={task.name}>
              <FileCode2 size={16} />
              <b>{task.name}</b>
              <span>{t("timer.scriptBytes", { count: task.sourceBytes })}</span>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button onClick={onCancel}>{t("common.cancel")}</button>
          <button className="primary" onClick={onConfirm}>
            {t("timer.scriptImportConfirm")}
          </button>
        </div>
      </section>
    </div>
  );
}
