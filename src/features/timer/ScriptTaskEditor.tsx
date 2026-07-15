import { lazy, Suspense, useState } from "react";
import { FlaskConical, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TimerScriptConfig, TimerScriptResponse } from "./types";

const MonacoEditor = lazy(() =>
  import("./LocalMonacoEditor").then((module) => ({ default: module.LocalMonacoEditor })),
);

export function ScriptTaskEditor({
  script,
  preview,
  onChange,
  onPreview,
  onReset,
}: {
  script: TimerScriptConfig;
  preview?: { loading: boolean; result?: TimerScriptResponse; error?: string };
  onChange: (patch: Partial<TimerScriptConfig>) => void;
  onPreview: () => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const [initialStateText, setInitialStateText] = useState(() =>
    JSON.stringify(script.initialState, null, 2),
  );
  const [stateError, setStateError] = useState("");

  function updateInitialState(text: string) {
    setInitialStateText(text);
    try {
      const value = JSON.parse(text) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
      setStateError("");
      onChange({ initialState: value as Record<string, unknown> });
    } catch {
      setStateError(t("timer.scriptStateInvalid"));
    }
  }

  return (
    <div className="script-editor">
      <div className="script-editor-head">
        <div>
          <b>{t("timer.scriptEditor")}</b>
          <span>{t("timer.scriptSandboxHint")}</span>
        </div>
        <button onClick={onPreview} disabled={preview?.loading || Boolean(stateError)}>
          <FlaskConical size={16} /> {preview?.loading ? t("timer.scriptTesting") : t("timer.scriptTest")}
        </button>
        <button onClick={onReset}>
          <RotateCcw size={16} /> {t("timer.scriptReset")}
        </button>
      </div>
      <Suspense fallback={<div className="script-editor-loading">{t("common.loading")}</div>}>
        <MonacoEditor value={script.source} onChange={(value) => onChange({ source: value })} />
      </Suspense>
      <div className="script-state-grid">
        <label className={stateError ? "field-invalid" : ""}>
          <span>{t("timer.scriptInitialState")}</span>
          <textarea
            value={initialStateText}
            rows={5}
            onChange={(event) => updateInitialState(event.target.value)}
          />
          {stateError ? <span className="field-error">{stateError}</span> : null}
        </label>
        <label>
          <span>{t("timer.scriptCurrentState")}</span>
          <textarea value={JSON.stringify(script.state, null, 2)} rows={5} readOnly />
        </label>
      </div>
      {preview?.result ? (
        <div className="script-preview">
          <b>{t("timer.scriptPreview")}</b>
          <pre>{JSON.stringify(preview.result, null, 2)}</pre>
        </div>
      ) : null}
      {preview?.error ? <p className="timer-error">{preview.error}</p> : null}
    </div>
  );
}
