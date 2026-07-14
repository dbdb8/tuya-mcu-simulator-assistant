import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AppLocale } from "../../i18n";

export function LanguageSettingsModal({
  open,
  language,
  onChange,
  onClose,
}: {
  open: boolean;
  language: AppLocale;
  onChange: (language: AppLocale) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={(event) => event.currentTarget === event.target && onClose()}>
      <section className="modal language-modal">
        <div className="modal-head">
          <div>
            <h2>{t("settings.languageTitle")}</h2>
            <p>{t("settings.languageHint")}</p>
          </div>
          <button className="icon" title={t("common.close")} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="language-segments" role="group" aria-label={t("settings.languageTitle")}>
          <button className={language === "zh-CN" ? "active" : ""} onClick={() => onChange("zh-CN")}>
            {t("settings.chinese")}
          </button>
          <button className={language === "en-US" ? "active" : ""} onClick={() => onChange("en-US")}>
            {t("settings.english")}
          </button>
        </div>
      </section>
    </div>
  );
}
