import { Settings, Wifi } from "lucide-react";
import appLogo from "../assets/app-logo.png";
import type { DpSchema, NetworkStatus } from "../types";
import { networkTime } from "../utils/log-utils";
import { useTranslation } from "react-i18next";

export type SettingsItem = {
  key: string;
  label: string;
  description: string;
  onClick: () => void;
  badge?: string;
  attention?: boolean;
};

export function AppHeader({
  schema,
  status,
  network,
  settingsOpen,
  settingsItems,
  onToggleSettings,
}: {
  schema: DpSchema | null;
  status: string;
  network: NetworkStatus;
  settingsOpen: boolean;
  settingsItems: SettingsItem[];
  onToggleSettings: () => void;
}) {
  const { t } = useTranslation();
  return (
    <header className="topbar">
      <div className="brand">
        <img className="brand-logo" src={appLogo} alt="Application logo" />
        <div>
          <h1>{t("app.title")}</h1>
          <p>
            {schema
              ? `PID ${schema.product_key} / MCU ${schema.mcu_version} / m=${schema.config_mode} ${schema.config_mode_label} / DP ${schema.points.length}`
              : t("app.noProfile")}
          </p>
        </div>
      </div>
      <div className="status">{status}</div>
      <div className="network-pill" title={networkTime(network)}>
        <Wifi size={16} />
        <b>0x{network.code.toString(16).padStart(2, "0").toUpperCase()}</b>
        <span>{network.label}</span>
      </div>
      <div className="settings-wrap">
        <button
          className={`icon settings-button ${settingsItems.some((item) => item.attention) ? "has-update" : ""}`}
          title={t("app.settings")}
          onClick={onToggleSettings}
        >
          <Settings size={18} />
        </button>
        {settingsOpen ? (
          <div className="settings-menu">
            {settingsItems.map((item) => (
              <button key={item.key} onClick={item.onClick}>
                <b>
                  {item.label}
                  {item.badge ? <i>{item.badge}</i> : null}
                </b>
                <span>{item.description}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </header>
  );
}
