import type { SettingsItem } from "../../components/AppHeader";
import type { RelatedCommand } from "./RelatedCommandsModal";
import i18n from "../../i18n";

export const RELATED_COMMANDS: RelatedCommand[] = [
  { key: "queryMemory", command: "query_memory", labelKey: "commands.queryMemory" },
  { key: "querySignal", command: "query_signal_strength", labelKey: "commands.querySignal" },
  { key: "greenTime", command: "get_green_time", labelKey: "commands.greenTime" },
  { key: "localTime", command: "get_local_time", labelKey: "commands.localTime" },
  { key: "stopHeartbeat", command: "stop_heartbeat", labelKey: "commands.stopHeartbeat" },
  { key: "wifiStatus", command: "get_wifi_status", labelKey: "commands.wifiStatus" },
  { key: "mac", command: "get_mac", labelKey: "commands.mac" },
  { key: "newFunction", command: "send_new_function_notice", labelKey: "commands.newFunction" },
];

export function createSettingsItems(
  onRelatedCommands: () => void,
  onTimedReports: () => void,
  onLanguage: () => void,
  closeBehavior: { visible: boolean; onOpen: () => void },
  updater: { onOpen: () => void; hasUpdate: boolean; version?: string; checking: boolean; failed: boolean },
): SettingsItem[] {
  // 设置入口采用数据配置，后续增加日志设置等功能时无需修改 Header 结构。
  return [
    {
      key: "relatedCommands",
      label: i18n.t("settings.related"),
      description: i18n.t("settings.relatedDesc"),
      onClick: onRelatedCommands,
    },
    {
      key: "timedReports",
      label: i18n.t("settings.timer"),
      description: i18n.t("settings.timerDesc"),
      onClick: onTimedReports,
    },
    {
      key: "language",
      label: i18n.t("settings.language"),
      description: i18n.t("settings.languageDesc"),
      onClick: onLanguage,
    },
    ...(closeBehavior.visible
      ? [
          {
            key: "closeBehavior",
            label: i18n.t("settings.closeBehavior"),
            description: i18n.t("settings.closeBehaviorDesc"),
            onClick: closeBehavior.onOpen,
          },
        ]
      : []),
    {
      key: "softwareUpdate",
      label: i18n.t("settings.update"),
      description: updater.checking
        ? i18n.t("settings.updateChecking")
        : updater.hasUpdate
          ? i18n.t("settings.updateFound")
          : updater.failed
            ? i18n.t("settings.updateFailed")
            : i18n.t("settings.updateDesc"),
      badge: updater.hasUpdate && updater.version ? `v${updater.version}` : undefined,
      attention: updater.hasUpdate,
      onClick: updater.onOpen,
    },
  ];
}
