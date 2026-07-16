export type McuOtaFaultConfig = {
  rejectStart: boolean;
  dropAckPacket?: number | null;
  dropAckPersistent: boolean;
  writeFailPacket?: number | null;
  offsetErrorPacket?: number | null;
  powerLossPacket?: number | null;
  forceHeaderCrcFailure: boolean;
  forcePayloadHashFailure: boolean;
};

export type McuOtaConfig = {
  enabled: boolean;
  maxFirmwareSize: number;
  allowNonUpgrade: boolean;
  fault: McuOtaFaultConfig;
  batteryDpCode?: string | null;
  batteryMinimum?: number | null;
};

export type McuOtaState = {
  enabled: boolean;
  status: string;
  debugfileVersion: string;
  currentVersion: string;
  versionSource: "debugfile" | "ota" | "manual" | string;
  versionUpdatedAt?: string | null;
  targetVersion?: string | null;
  firmwareSize: number;
  receivedBytes: number;
  progress: number;
  packetCount: number;
  nextOffset: number;
  bytesPerSecond: number;
  startedAtMs?: number | null;
  lastPacketAtMs?: number | null;
  tempPath?: string | null;
  receivedPath?: string | null;
  packageSha256?: string | null;
  payloadSha256?: string | null;
  expectedPayloadSha256?: string | null;
  headerValid?: boolean | null;
  payloadValid?: boolean | null;
  error?: string | null;
  injectedFault?: string | null;
  config: McuOtaConfig;
};

export type FirmwarePackageInfo = {
  path: string;
  manifestPath?: string | null;
  targetVersion: string;
  packageSize: number;
  payloadSize: number;
  payloadSource: string;
  payloadSha256: string;
  packageSha256: string;
  headerCrc32: string;
  valid: boolean;
  error?: string | null;
};
