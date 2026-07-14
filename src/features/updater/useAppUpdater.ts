import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import type { UpdateEnvironment, UpdateError, UpdateProgress, UpdateState } from "./types";
import i18n from "../../i18n";

const RELEASE_URL = "https://github.com/dbdb8/tuya-mcu-simulator-assistant/releases/latest";

export function useAppUpdater({
  serialOpen,
  beforeInstall,
}: {
  serialOpen: boolean;
  beforeInstall: () => Promise<void>;
}) {
  const [state, setState] = useState<UpdateState>("idle");
  const [modalOpen, setModalOpen] = useState(false);
  const [currentVersion, setCurrentVersion] = useState("-");
  const [availableVersion, setAvailableVersion] = useState<string>();
  const [notes, setNotes] = useState("");
  const [publishedAt, setPublishedAt] = useState<string>();
  const [progress, setProgress] = useState<UpdateProgress>({ downloaded: 0 });
  const [error, setError] = useState<UpdateError>();
  const [environment, setEnvironment] = useState<UpdateEnvironment>();
  const updateRef = useRef<Update | null>(null);

  useEffect(() => {
    void getVersion()
      .then(setCurrentVersion)
      .catch(() => setCurrentVersion("-"));
    void invoke<UpdateEnvironment>("get_update_environment")
      .then(setEnvironment)
      .catch(() => undefined);
    // StrictMode 会先执行一次 effect 清理再重新挂载；清理旧 timer 后由第二次 effect 安排唯一一次检查即可。
    const timer = window.setTimeout(() => void checkForUpdates(true), 2000);
    return () => window.clearTimeout(timer);
  }, []);

  async function checkForUpdates(silent = false) {
    setState("checking");
    setError(undefined);
    try {
      if (updateRef.current) await updateRef.current.close();
      const update = await check({ timeout: 15000, allowDowngrades: false });
      updateRef.current = update;
      if (!update) {
        setState("upToDate");
        if (!silent) setModalOpen(true);
        return;
      }
      setAvailableVersion(update.version);
      setNotes(update.body ?? i18n.t("updater.noNotes"));
      setPublishedAt(update.date);
      setProgress({ downloaded: 0 });
      setState("available");
      setModalOpen(true);
    } catch (cause) {
      const nextError = normalizeUpdateError(cause);
      setError(nextError);
      setState("error");
      // 启动静默检查不能打断串口调试；手动检查才主动打开错误详情。
      if (!silent) setModalOpen(true);
    }
  }

  async function downloadAndInstall() {
    const update = updateRef.current;
    if (!update) {
      await checkForUpdates(false);
      return;
    }
    if (environment && !environment.canInstallInApp) {
      await openReleasePage();
      return;
    }
    try {
      if (serialOpen) await beforeInstall();
      let downloaded = 0;
      setProgress({ downloaded: 0 });
      setState("downloading");
      await update.downloadAndInstall(
        (event) => {
          if (event.event === "Started") {
            setProgress({
              downloaded: 0,
              total: event.data.contentLength,
              percent: event.data.contentLength ? 0 : undefined,
            });
          } else if (event.event === "Progress") {
            downloaded += event.data.chunkLength;
            setProgress((current) => ({
              ...current,
              downloaded,
              percent: current.total
                ? Math.min(100, Math.round((downloaded * 100) / current.total))
                : undefined,
            }));
          } else {
            setState("installing");
          }
        },
        { timeout: 120000 },
      );
      // 安装完成后立即重启，让用户明确进入新版本；串口已在下载前安全关闭。
      await relaunch();
    } catch (cause) {
      setError(normalizeUpdateError(cause));
      setState("error");
      setModalOpen(true);
    }
  }

  async function openReleasePage() {
    try {
      await openUrl(RELEASE_URL);
    } catch (cause) {
      setError(normalizeUpdateError(cause));
      setState("error");
      setModalOpen(true);
    }
  }

  function dismiss() {
    // “稍后”只关闭本次弹窗，不持久化忽略版本，因此下次启动仍会提醒同一版本。
    setModalOpen(false);
  }

  return {
    state,
    modalOpen,
    currentVersion,
    availableVersion,
    notes,
    publishedAt,
    progress,
    error,
    environment,
    hasUpdate: state === "available" || state === "downloading" || state === "installing",
    openModal: () => setModalOpen(true),
    checkForUpdates,
    downloadAndInstall,
    openReleasePage,
    dismiss,
  };
}

function normalizeUpdateError(cause: unknown): UpdateError {
  const detail = cause instanceof Error ? cause.stack || cause.message : String(cause);
  return {
    title: i18n.t("updater.failed"),
    message: cause instanceof Error ? cause.message : i18n.t("updater.unknownError"),
    detail,
    suggestion: i18n.t("updater.suggestion"),
  };
}
