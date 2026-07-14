import { X } from "lucide-react";
import type { DpSchema } from "../../types";
import { useTranslation } from "react-i18next";

export type RelatedCommand = { key: string; command: string; labelKey: string };

export function RelatedCommandsModal(props: {
  open: boolean;
  schema: DpSchema | null;
  serialOpen: boolean;
  busyAction: string | null;
  commands: RelatedCommand[];
  onClose: () => void;
  onSend: (command: RelatedCommand) => void;
}) {
  const { t } = useTranslation();
  if (!props.open) return null;
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => event.currentTarget === event.target && props.onClose()}
    >
      <section className="modal">
        <div className="modal-head">
          <div>
            <h2>{t("commands.title")}</h2>
            <p>{t(props.schema && props.serialOpen ? "commands.ready" : "commands.blocked")}</p>
          </div>
          <button className="icon" title={t("common.close")} onClick={props.onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-status">
          <span>
            {t("commands.debugfile", { state: t(props.schema ? "common.loaded" : "common.notLoaded") })}
          </span>
          <span>
            {t("commands.serial", { state: t(props.serialOpen ? "common.opened" : "common.notOpened") })}
          </span>
        </div>
        <div className="command-grid">
          {props.commands.map((item) => (
            <button
              key={item.key}
              onClick={() => props.onSend(item)}
              disabled={!props.schema || !props.serialOpen || props.busyAction === item.key}
              title={t(item.labelKey)}
            >
              {props.busyAction === item.key ? t("commands.sending") : t(item.labelKey)}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
