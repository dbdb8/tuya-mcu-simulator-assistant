import { AlertTriangle } from "lucide-react";
import type { AppError } from "../types";
import { copyError } from "../utils/log-utils";
import { useTranslation } from "react-i18next";

export function ErrorBanner({ error, onClose }: { error: AppError | null; onClose: () => void }) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <section className="error-banner">
      <AlertTriangle size={20} />
      <div>
        <b>{error.title}</b>
        <p>{error.message}</p>
        <p>{error.suggestion}</p>
        <code>{error.detail}</code>
      </div>
      <button onClick={() => copyError(error)}>{t("common.copyDetails")}</button>
      <button className="icon" onClick={onClose} title={t("common.close")}>
        ×
      </button>
    </section>
  );
}
