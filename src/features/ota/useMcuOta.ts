import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FirmwarePackageInfo, McuOtaConfig, McuOtaState } from "./types";

const DEFAULT_CONFIG: McuOtaConfig = {
  enabled: false,
  maxFirmwareSize: 64 * 1024 * 1024,
  allowNonUpgrade: false,
  fault: {
    rejectStart: false,
    dropAckPersistent: false,
    forceHeaderCrcFailure: false,
    forcePayloadHashFailure: false,
  },
};

export function useMcuOta(onStarted: () => void) {
  const onStartedRef = useRef(onStarted);
  const [state, setState] = useState<McuOtaState | null>(null);
  const [packageInfo, setPackageInfo] = useState<FirmwarePackageInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    onStartedRef.current = onStarted;
  }, [onStarted]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void invoke<McuOtaState>("get_mcu_ota_state").then((next) => !disposed && setState(next));
    void listen<McuOtaState>("mcu-ota-state", (event) => {
      setState((current) => {
        if (
          (event.payload.status === "receiving" || event.payload.status === "rebooting") &&
          current?.status !== event.payload.status
        ) {
          onStartedRef.current();
        }
        return event.payload;
      });
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  async function configure(config: McuOtaConfig) {
    setState(await invoke<McuOtaState>("configure_mcu_ota", { config }));
  }

  async function action(command: string, args: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      setState(await invoke<McuOtaState>(command, args));
    } finally {
      setBusy(false);
    }
  }

  return {
    state,
    config: state?.config ?? DEFAULT_CONFIG,
    packageInfo,
    busy,
    refresh: async () => setState(await invoke<McuOtaState>("get_mcu_ota_state")),
    configure,
    generate: async (config: Record<string, unknown>) => {
      setBusy(true);
      try {
        const info = await invoke<FirmwarePackageInfo>("generate_mcu_firmware_package", { config });
        setPackageInfo(info);
        return info;
      } finally {
        setBusy(false);
      }
    },
    inspect: async (path: string) => {
      const info = await invoke<FirmwarePackageInfo>("inspect_mcu_firmware_package", { path });
      setPackageInfo(info);
      return info;
    },
    cancel: () => action("cancel_mcu_ota"),
    powerLoss: () => action("simulate_mcu_ota_power_loss"),
    clear: () => action("clear_mcu_ota_session"),
    restoreVersion: () => action("restore_debugfile_mcu_version"),
    setVersion: (version: string) => action("set_mcu_firmware_version", { version }),
    exportReceived: async (path: string) => invoke("export_received_firmware", { path }),
  };
}
