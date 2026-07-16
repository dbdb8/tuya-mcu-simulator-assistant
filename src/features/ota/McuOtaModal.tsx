import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Download, FileSearch, FolderOutput, Power, RotateCcw, X, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DpSchema } from "../../types";
import type { useMcuOta } from "./useMcuOta";

type OtaController = ReturnType<typeof useMcuOta>;

export function McuOtaModal(props: {
  open: boolean;
  schema: DpSchema | null;
  serialOpen: boolean;
  ota: OtaController;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<"generate" | "receive">("generate");
  const [targetVersion, setTargetVersion] = useState("1.0.1");
  const [payloadMode, setPayloadMode] = useState("increment");
  const [payloadSize, setPayloadSize] = useState(256 * 1024);
  const [seed, setSeed] = useState(1);
  const [sourcePath, setSourcePath] = useState("");
  const [manualVersion, setManualVersion] = useState("");
  if (!props.open) return null;
  const state = props.ota.state;
  const config = props.ota.config;
  const canEnable = Boolean(props.schema && props.serialOpen);
  const versionBusy = ["receiving", "verifying", "rebooting"].includes(state?.status ?? "");

  async function generate() {
    if (!props.schema) return;
    const outputPath = await save({
      defaultPath: `tuya-mcu-sim-firmware-${props.schema.product_key}-v${targetVersion}.bin`,
      filters: [{ name: "TMSF firmware", extensions: ["bin"] }],
    });
    if (!outputPath) return;
    await props.ota.generate({
      outputPath,
      productKey: props.schema.product_key,
      targetVersion,
      payloadMode,
      payloadSize,
      seed,
      sourcePath: sourcePath || null,
      allowNonUpgrade: config.allowNonUpgrade,
      currentVersion: state?.currentVersion || props.schema.mcu_version,
    });
  }

  return (
    <div
      className="modal-backdrop"
      onClick={(event) => event.currentTarget === event.target && props.onClose()}
    >
      <section className="modal modal-wide mcu-ota-modal">
        <div className="modal-head">
          <div>
            <h2>{t("mcuOta.title")}</h2>
            <p>{t("mcuOta.hint")}</p>
          </div>
          <button className="icon" title={t("common.close")} onClick={props.onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="ota-tabs">
          <button className={tab === "generate" ? "active" : ""} onClick={() => setTab("generate")}>
            {t("mcuOta.generateTab")}
          </button>
          <button className={tab === "receive" ? "active" : ""} onClick={() => setTab("receive")}>
            {t("mcuOta.receiveTab")}
          </button>
        </div>
        {tab === "generate" ? (
          <div className="ota-body">
            <div className="ota-grid">
              <label>
                <span>{t("mcuOta.pid")}</span>
                <input value={props.schema?.product_key ?? ""} readOnly />
              </label>
              <label>
                <span>{t("mcuOta.currentVersion")}</span>
                <input value={state?.currentVersion || props.schema?.mcu_version || ""} readOnly />
              </label>
              <label>
                <span>{t("mcuOta.targetVersion")}</span>
                <input value={targetVersion} onChange={(e) => setTargetVersion(e.target.value)} />
              </label>
              <label>
                <span>{t("mcuOta.payloadMode")}</span>
                <select value={payloadMode} onChange={(e) => setPayloadMode(e.target.value)}>
                  <option value="zero">0x00</option>
                  <option value="ff">0xFF</option>
                  <option value="increment">00-FF</option>
                  <option value="random">{t("mcuOta.random")}</option>
                  <option value="import">{t("mcuOta.importBin")}</option>
                </select>
              </label>
              {payloadMode !== "import" ? (
                <label>
                  <span>{t("mcuOta.payloadSize")}</span>
                  <input
                    type="number"
                    min={1024}
                    max={64 * 1024 * 1024}
                    value={payloadSize}
                    onChange={(e) => setPayloadSize(Number(e.target.value))}
                  />
                </label>
              ) : null}
              {payloadMode === "random" ? (
                <label>
                  <span>Seed</span>
                  <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} />
                </label>
              ) : null}
            </div>
            {payloadMode === "import" ? (
              <div className="ota-file-row">
                <input value={sourcePath} readOnly placeholder={t("mcuOta.selectBin")} />
                <button
                  onClick={async () => {
                    const path = await open({
                      multiple: false,
                      filters: [{ name: "Binary", extensions: ["bin"] }],
                    });
                    if (typeof path === "string") setSourcePath(path);
                  }}
                >
                  <FileSearch size={16} />
                  {t("common.browse")}
                </button>
              </div>
            ) : null}
            <label className="ota-check">
              <input
                type="checkbox"
                checked={config.allowNonUpgrade}
                onChange={(e) => void props.ota.configure({ ...config, allowNonUpgrade: e.target.checked })}
              />
              {t("mcuOta.allowNonUpgrade")}
            </label>
            {props.ota.packageInfo ? (
              <div className={`ota-result ${props.ota.packageInfo.valid ? "success" : "error"}`}>
                <b>{props.ota.packageInfo.targetVersion}</b>
                <span>{formatBytes(props.ota.packageInfo.packageSize)}</span>
                <code>{props.ota.packageInfo.path}</code>
                <small>SHA-256: {props.ota.packageInfo.payloadSha256}</small>
              </div>
            ) : null}
            <div className="modal-actions">
              <button
                disabled={props.ota.busy}
                onClick={async () => {
                  const path = await open({
                    multiple: false,
                    filters: [{ name: "TMSF firmware", extensions: ["bin"] }],
                  });
                  if (typeof path === "string") await props.ota.inspect(path);
                }}
              >
                <FileSearch size={16} />
                {t("mcuOta.inspect")}
              </button>
              <button
                className="primary"
                disabled={!props.schema || props.ota.busy}
                onClick={() => void generate()}
              >
                <FolderOutput size={16} />
                {t("mcuOta.generate")}
              </button>
            </div>
          </div>
        ) : (
          <div className="ota-body">
            <div className="modal-status">
              <span>
                {t("mcuOta.debugVersion")}: <b>{state?.debugfileVersion || "-"}</b>
              </span>
              <span>
                {t("mcuOta.currentVersion")}: <b>{state?.currentVersion || "-"}</b>
              </span>
              <span>
                {t("mcuOta.targetVersion")}: <b>{state?.targetVersion || "-"}</b>
              </span>
            </div>
            <section className="ota-version-manager">
              <div className="ota-version-summary">
                <div>
                  <span>{t("mcuOta.currentVersion")}</span>
                  <b>{state?.currentVersion || "-"}</b>
                </div>
                <div>
                  <span>{t("mcuOta.versionSource")}</span>
                  <b>{t(`mcuOta.versionSources.${state?.versionSource ?? "debugfile"}`)}</b>
                </div>
                <div>
                  <span>{t("mcuOta.versionUpdatedAt")}</span>
                  <b>
                    {state?.versionUpdatedAt
                      ? new Date(state.versionUpdatedAt).toLocaleString(i18n.language)
                      : t("mcuOta.notPersisted")}
                  </b>
                </div>
              </div>
              <div className="ota-version-editor">
                <label>
                  <span>{t("mcuOta.manualVersion")}</span>
                  <input
                    value={manualVersion}
                    placeholder={state?.currentVersion || "1.0.0"}
                    disabled={!props.schema || versionBusy}
                    onChange={(event) => setManualVersion(event.target.value)}
                  />
                </label>
                <button
                  className="primary"
                  disabled={!props.schema || !manualVersion.trim() || versionBusy || props.ota.busy}
                  onClick={() => void props.ota.setVersion(manualVersion.trim())}
                >
                  <Power size={16} />
                  {t("mcuOta.setAndReboot")}
                </button>
              </div>
              <small>{t("mcuOta.manualVersionHint")}</small>
            </section>
            <div className="ota-master">
              <div>
                <b>{t("mcuOta.receiver")}</b>
                <small>{canEnable ? t("mcuOta.receiverHint") : t("mcuOta.receiverBlocked")}</small>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={config.enabled}
                  disabled={!canEnable}
                  onChange={(e) => void props.ota.configure({ ...config, enabled: e.target.checked })}
                />
                <span />
              </label>
            </div>
            <div className="ota-progress">
              <div>
                <b>{t(`mcuOta.status.${state?.status ?? "disabled"}`)}</b>
                <span>{(state?.progress ?? 0).toFixed(1)}%</span>
              </div>
              <progress max={100} value={state?.progress ?? 0} />
              <small>
                {formatBytes(state?.receivedBytes ?? 0)} / {formatBytes(state?.firmwareSize ?? 0)} ·{" "}
                {state?.packetCount ?? 0} {t("mcuOta.packets")} · {formatBytes(state?.bytesPerSecond ?? 0)}/s
              </small>
            </div>
            <div className="ota-grid">
              <label>
                <span>{t("mcuOta.maxSize")}</span>
                <input
                  type="number"
                  min={1}
                  value={Math.round(config.maxFirmwareSize / 1024 / 1024)}
                  onChange={(e) =>
                    void props.ota.configure({
                      ...config,
                      maxFirmwareSize: Number(e.target.value) * 1024 * 1024,
                    })
                  }
                />
              </label>
              <label>
                <span>{t("mcuOta.dropAckPacket")}</span>
                <input
                  type="number"
                  min={1}
                  value={config.fault.dropAckPacket ?? ""}
                  onChange={(e) =>
                    void props.ota.configure({
                      ...config,
                      fault: {
                        ...config.fault,
                        dropAckPacket: e.target.value ? Number(e.target.value) : null,
                      },
                    })
                  }
                />
              </label>
              <label>
                <span>{t("mcuOta.writeFailPacket")}</span>
                <input
                  type="number"
                  min={1}
                  value={config.fault.writeFailPacket ?? ""}
                  onChange={(e) =>
                    void props.ota.configure({
                      ...config,
                      fault: {
                        ...config.fault,
                        writeFailPacket: e.target.value ? Number(e.target.value) : null,
                      },
                    })
                  }
                />
              </label>
              <label>
                <span>{t("mcuOta.powerLossPacket")}</span>
                <input
                  type="number"
                  min={1}
                  value={config.fault.powerLossPacket ?? ""}
                  onChange={(e) =>
                    void props.ota.configure({
                      ...config,
                      fault: {
                        ...config.fault,
                        powerLossPacket: e.target.value ? Number(e.target.value) : null,
                      },
                    })
                  }
                />
              </label>
              <label>
                <span>{t("mcuOta.offsetErrorPacket")}</span>
                <input
                  type="number"
                  min={1}
                  value={config.fault.offsetErrorPacket ?? ""}
                  onChange={(e) =>
                    void props.ota.configure({
                      ...config,
                      fault: {
                        ...config.fault,
                        offsetErrorPacket: e.target.value ? Number(e.target.value) : null,
                      },
                    })
                  }
                />
              </label>
              <label>
                <span>{t("mcuOta.batteryGate")}</span>
                <select
                  value={config.batteryDpCode ?? ""}
                  onChange={(e) =>
                    void props.ota.configure({
                      ...config,
                      batteryDpCode: e.target.value || null,
                      batteryMinimum: e.target.value ? (config.batteryMinimum ?? 30) : null,
                    })
                  }
                >
                  <option value="">{t("mcuOta.noGate")}</option>
                  {(props.schema?.points ?? [])
                    .filter((point) => point.kind === "value")
                    .map((point) => (
                      <option key={point.code} value={point.code}>
                        DP{point.id} {point.code}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                <span>{t("mcuOta.batteryMinimum")}</span>
                <input
                  type="number"
                  value={config.batteryMinimum ?? 30}
                  disabled={!config.batteryDpCode}
                  onChange={(e) =>
                    void props.ota.configure({ ...config, batteryMinimum: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <div className="ota-checks">
              <label>
                <input
                  type="checkbox"
                  checked={config.fault.rejectStart}
                  onChange={(e) =>
                    void props.ota.configure({
                      ...config,
                      fault: { ...config.fault, rejectStart: e.target.checked },
                    })
                  }
                />
                {t("mcuOta.rejectStart")}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={config.fault.forceHeaderCrcFailure}
                  onChange={(e) =>
                    void props.ota.configure({
                      ...config,
                      fault: { ...config.fault, forceHeaderCrcFailure: e.target.checked },
                    })
                  }
                />
                {t("mcuOta.headerFailure")}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={config.fault.forcePayloadHashFailure}
                  onChange={(e) =>
                    void props.ota.configure({
                      ...config,
                      fault: { ...config.fault, forcePayloadHashFailure: e.target.checked },
                    })
                  }
                />
                {t("mcuOta.hashFailure")}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={config.fault.dropAckPersistent}
                  onChange={(e) =>
                    void props.ota.configure({
                      ...config,
                      fault: { ...config.fault, dropAckPersistent: e.target.checked },
                    })
                  }
                />
                {t("mcuOta.dropAckPersistent")}
              </label>
            </div>
            {state?.error ? (
              <div className="ota-error">
                <b>{t("common.error")}</b>
                <code>{state.error}</code>
              </div>
            ) : null}
            {state?.tempPath || state?.receivedPath ? (
              <div className="ota-path">
                <code>{state.receivedPath || state.tempPath}</code>
              </div>
            ) : null}
            <div className="modal-actions">
              <button onClick={() => void props.ota.cancel()} disabled={props.ota.busy}>
                <X size={16} />
                {t("mcuOta.cancel")}
              </button>
              <button onClick={() => void props.ota.powerLoss()} disabled={props.ota.busy}>
                <Zap size={16} />
                {t("mcuOta.powerLoss")}
              </button>
              <button
                disabled={!props.schema || versionBusy || props.ota.busy}
                onClick={() => void props.ota.restoreVersion()}
              >
                <RotateCcw size={16} />
                {t("mcuOta.restore")}
              </button>
              <button onClick={() => void props.ota.clear()}>
                <Power size={16} />
                {t("mcuOta.clear")}
              </button>
              {state?.receivedPath ? (
                <button
                  className="primary"
                  onClick={async () => {
                    const path = await save({
                      defaultPath: `received-v${state.targetVersion}.bin`,
                      filters: [{ name: "Firmware", extensions: ["bin"] }],
                    });
                    if (path) await props.ota.exportReceived(path);
                  }}
                >
                  <Download size={16} />
                  {t("mcuOta.export")}
                </button>
              ) : null}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
