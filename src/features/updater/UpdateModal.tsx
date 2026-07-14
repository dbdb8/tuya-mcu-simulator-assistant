import { AlertTriangle, CheckCircle2, Download, ExternalLink, RefreshCw, X } from "lucide-react";
import type { UpdateEnvironment, UpdateError, UpdateProgress, UpdateState } from "./types";
import { useTranslation } from "react-i18next";

export function UpdateModal(props: {
  open: boolean;
  state: UpdateState;
  currentVersion: string;
  availableVersion?: string;
  notes: string;
  publishedAt?: string;
  progress: UpdateProgress;
  error?: UpdateError;
  environment?: UpdateEnvironment;
  serialOpen: boolean;
  onClose: () => void;
  onCheck: () => void;
  onInstall: () => void;
  onOpenRelease: () => void;
}) {
  const { t, i18n } = useTranslation();
  if (!props.open) return null;
  const busy = props.state === "checking" || props.state === "downloading" || props.state === "installing";
  const manualInstall = props.environment && !props.environment.canInstallInApp;
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => event.currentTarget === event.target && !busy && props.onClose()}
    >
      <section className="modal update-modal">
        <div className="modal-head">
          <div>
            <h2>{t("updater.title")}</h2>
            <p>{t("updater.current", { version: props.currentVersion })}</p>
          </div>
          <button className="icon" title={t("common.close")} onClick={props.onClose} disabled={busy}>
            <X size={18} />
          </button>
        </div>
        {props.state === "checking" ? (
          <div className="update-state">
            <RefreshCw className="spin" size={24} />
            <b>{t("updater.checking")}</b>
          </div>
        ) : null}
        {props.state === "upToDate" ? (
          <div className="update-state success">
            <CheckCircle2 size={24} />
            <b>{t("updater.latest")}</b>
          </div>
        ) : null}
        {props.error ? (
          <div className="update-error">
            <AlertTriangle size={20} />
            <div>
              <b>{props.error.title}</b>
              <p>{props.error.message}</p>
              <small>{props.error.suggestion}</small>
              <code>{props.error.detail}</code>
              <button onClick={() => copyUpdateError(props.error!, t("logs.suggestion"), t("logs.detail"))}>
                {t("updater.copyError")}
              </button>
            </div>
          </div>
        ) : null}
        {props.availableVersion ? (
          <div className="update-details">
            <div className="version-line">
              <span>{t("updater.available")}</span>
              <b>v{props.availableVersion}</b>
              {props.publishedAt ? (
                <time>{new Date(props.publishedAt).toLocaleString(i18n.language)}</time>
              ) : null}
            </div>
            <h3>{t("updater.notes")}</h3>
            <pre>{props.notes}</pre>
            {manualInstall ? (
              <p className="update-hint">{t("updater.manual", { mode: props.environment?.installMode })}</p>
            ) : null}
          </div>
        ) : null}
        {props.state === "downloading" || props.state === "installing" ? (
          <div className="update-progress">
            <div>
              <span>{t(props.state === "installing" ? "updater.installing" : "updater.downloading")}</span>
              <b>{progressText(props.progress)}</b>
            </div>
            <progress value={props.progress.percent ?? (props.state === "installing" ? 100 : 0)} max={100} />
          </div>
        ) : null}
        <div className="modal-actions">
          <button onClick={props.onCheck} disabled={busy}>
            <RefreshCw size={16} /> {t("updater.check")}
          </button>
          <button onClick={props.onClose} disabled={busy}>
            {t("updater.later")}
          </button>
          {manualInstall || props.error ? (
            <button className="primary" onClick={props.onOpenRelease}>
              <ExternalLink size={16} /> {t("updater.release")}
            </button>
          ) : props.availableVersion ? (
            <button className="primary" onClick={props.onInstall} disabled={busy}>
              <Download size={16} /> {t(props.serialOpen ? "updater.stopAndUpdate" : "updater.install")}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function copyUpdateError(error: UpdateError, suggestionLabel: string, detailLabel: string) {
  const text = `${error.title}\n${error.message}\n${suggestionLabel}: ${error.suggestion}\n${detailLabel}: ${error.detail}`;
  void navigator.clipboard?.writeText(text);
}

function progressText(progress: UpdateProgress) {
  const downloaded = formatBytes(progress.downloaded);
  if (!progress.total) return downloaded;
  return `${progress.percent ?? 0}% · ${downloaded} / ${formatBytes(progress.total)}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
