import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

export type CloseBehavior = "ask" | "tray" | "exit";

export function CloseBehaviorModal({
  open,
  behavior,
  firstClose = false,
  onChange,
  onClose,
}: {
  open: boolean;
  behavior: CloseBehavior;
  firstClose?: boolean;
  onChange: (behavior: CloseBehavior) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={(event) => event.currentTarget === event.target && onClose()}>
      <section className="modal close-behavior-modal">
        <div className="modal-head">
          <div>
            <h2>{t(firstClose ? "closeBehavior.firstTitle" : "closeBehavior.settingsTitle")}</h2>
            <p>{t(firstClose ? "closeBehavior.firstHint" : "closeBehavior.settingsHint")}</p>
          </div>
          <button className="icon" title={t("common.close")} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="close-behavior-options">
          {!firstClose ? (
            <button className={behavior === "ask" ? "active" : ""} onClick={() => onChange("ask")}>
              <b>{t("closeBehavior.ask")}</b>
              <span>{t("closeBehavior.askDesc")}</span>
            </button>
          ) : null}
          <button className={behavior === "tray" ? "active" : ""} onClick={() => onChange("tray")}>
            <b>{t("closeBehavior.tray")}</b>
            <span>{t("closeBehavior.trayDesc")}</span>
          </button>
          <button
            className={behavior === "exit" ? "active danger" : "danger"}
            onClick={() => onChange("exit")}
          >
            <b>{t("closeBehavior.exit")}</b>
            <span>{t("closeBehavior.exitDesc")}</span>
          </button>
        </div>
      </section>
    </div>
  );
}
