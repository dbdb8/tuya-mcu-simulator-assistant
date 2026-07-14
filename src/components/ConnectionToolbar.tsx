import { Play, Radio, RefreshCw, RotateCcw, Square, Wifi } from "lucide-react";
import type { DpSchema } from "../types";
import { useTranslation } from "react-i18next";

export function ConnectionToolbar(props: {
  ports: string[];
  portName: string;
  baudRate: number;
  dpPath: string;
  schema: DpSchema | null;
  serialOpen: boolean;
  busyAction: string | null;
  onPortChange: (value: string) => void;
  onBaudChange: (value: number) => void;
  onRefresh: () => void;
  onChooseFile: () => void;
  onStart: () => void;
  onStop: () => void;
  onWifiReset: () => void;
  onWifiMode: (mode: 0 | 1) => void;
}) {
  const { t } = useTranslation();
  const portOptions =
    props.portName && !props.ports.includes(props.portName) ? [props.portName, ...props.ports] : props.ports;
  return (
    <section className="toolbar">
      <label>
        <span>{t("toolbar.port")}</span>
        <select value={props.portName} onChange={(event) => props.onPortChange(event.target.value)}>
          {portOptions.map((port) => (
            <option key={port}>{port}</option>
          ))}
        </select>
      </label>
      <button
        className="icon"
        onClick={props.onRefresh}
        title={t("toolbar.refresh")}
        disabled={props.busyAction === "refreshPorts"}
      >
        <RefreshCw size={18} />
      </button>
      <label>
        <span>{t("toolbar.baudRate")}</span>
        <select value={props.baudRate} onChange={(event) => props.onBaudChange(Number(event.target.value))}>
          {[9600, 19200, 38400, 57600, 115200].map((rate) => (
            <option key={rate} value={rate}>
              {rate}
            </option>
          ))}
        </select>
      </label>
      <label className="file">
        <span>Debugfile</span>
        <input
          value={props.dpPath}
          readOnly
          placeholder={t("toolbar.chooseDebugfile")}
          title={props.dpPath || t("toolbar.noDebugfile")}
        />
      </label>
      <button onClick={props.onChooseFile} disabled={props.busyAction === "chooseDpFile"}>
        {t("toolbar.browse")}
      </button>
      {props.serialOpen ? (
        <button className="danger" onClick={props.onStop} disabled={props.busyAction === "stopSerial"}>
          <Square size={17} /> {t("toolbar.stop")}
        </button>
      ) : (
        <button
          className="primary"
          onClick={props.onStart}
          disabled={!props.portName || !props.schema || props.busyAction === "startSerial"}
        >
          <Play size={17} /> {t(props.busyAction === "startSerial" ? "toolbar.opening" : "toolbar.start")}
        </button>
      )}
      <button
        onClick={props.onWifiReset}
        disabled={!props.schema || !props.serialOpen || props.busyAction === "wifiReset"}
      >
        <RotateCcw size={17} /> {t("toolbar.wifiReset")}
      </button>
      <button
        onClick={() => props.onWifiMode(0)}
        disabled={!props.schema || !props.serialOpen || props.busyAction === "wifiEz"}
      >
        <Radio size={17} /> EZ
      </button>
      <button
        onClick={() => props.onWifiMode(1)}
        disabled={!props.schema || !props.serialOpen || props.busyAction === "wifiAp"}
      >
        <Wifi size={17} /> AP
      </button>
    </section>
  );
}
