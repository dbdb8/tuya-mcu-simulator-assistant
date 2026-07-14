export type UpdateState =
  "idle" | "checking" | "available" | "downloading" | "installing" | "upToDate" | "error";

export type UpdateEnvironment = {
  platform: "windows" | "macos" | "linux" | string;
  arch: string;
  installMode: "native" | "appimage" | "deb" | "unknown";
  canInstallInApp: boolean;
};

export type UpdateProgress = {
  downloaded: number;
  total?: number;
  percent?: number;
};

export type UpdateError = {
  title: string;
  message: string;
  detail: string;
  suggestion: string;
};
