use crc32fast::Hasher as Crc32;
use fs2::available_space;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const TMSF_HEADER_SIZE: usize = 80;
pub const OTA_CHUNK_SIZE_CODE: u8 = 0x00;
pub const OTA_CHUNK_SIZE: usize = 256;
const TMSF_MAGIC: &[u8; 4] = b"TMSF";
const TMSF_FORMAT_VERSION: u8 = 1;
const DEFAULT_MAX_FIRMWARE_SIZE: u64 = 64 * 1024 * 1024;
const VERSION_FILE: &str = "mcu-firmware-versions.json";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct FirmwareVersion {
    pub major: u8,
    pub minor: u8,
    pub patch: u8,
}

impl FirmwareVersion {
    pub fn parse(text: &str) -> Result<Self, String> {
        let parts = text
            .split('.')
            .map(|part| {
                part.parse::<u8>()
                    .map_err(|_| format!("invalid version: {text}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if parts.len() != 3 {
            return Err(format!("version must be major.minor.patch: {text}"));
        }
        Ok(Self {
            major: parts[0],
            minor: parts[1],
            patch: parts[2],
        })
    }
}

impl std::fmt::Display for FirmwareVersion {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareGenerateConfig {
    pub output_path: String,
    pub product_key: String,
    pub target_version: String,
    pub payload_mode: String,
    pub payload_size: u64,
    pub seed: Option<u64>,
    pub source_path: Option<String>,
    #[serde(default)]
    pub allow_non_upgrade: bool,
    pub current_version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwarePackageInfo {
    pub path: String,
    pub manifest_path: Option<String>,
    pub product_key: Option<String>,
    pub target_version: String,
    pub package_size: u64,
    pub payload_size: u64,
    pub payload_source: String,
    pub created_at: u64,
    pub pid_hash: String,
    pub payload_sha256: String,
    pub package_sha256: String,
    pub header_crc32: String,
    pub valid: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McuOtaFaultConfig {
    #[serde(default)]
    pub reject_start: bool,
    pub drop_ack_packet: Option<u64>,
    #[serde(default)]
    pub drop_ack_persistent: bool,
    pub write_fail_packet: Option<u64>,
    pub offset_error_packet: Option<u64>,
    pub power_loss_packet: Option<u64>,
    #[serde(default)]
    pub force_header_crc_failure: bool,
    #[serde(default)]
    pub force_payload_hash_failure: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McuOtaConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_max_size")]
    pub max_firmware_size: u64,
    #[serde(default)]
    pub allow_non_upgrade: bool,
    #[serde(default)]
    pub fault: McuOtaFaultConfig,
    pub battery_dp_code: Option<String>,
    pub battery_minimum: Option<i64>,
}

fn default_max_size() -> u64 {
    DEFAULT_MAX_FIRMWARE_SIZE
}

impl Default for McuOtaConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            max_firmware_size: DEFAULT_MAX_FIRMWARE_SIZE,
            allow_non_upgrade: false,
            fault: McuOtaFaultConfig::default(),
            battery_dp_code: None,
            battery_minimum: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McuOtaState {
    pub enabled: bool,
    pub status: String,
    pub debugfile_version: String,
    pub current_version: String,
    pub version_source: String,
    pub version_updated_at: Option<String>,
    pub target_version: Option<String>,
    pub firmware_size: u64,
    pub received_bytes: u64,
    pub progress: f64,
    pub packet_count: u64,
    pub next_offset: u64,
    pub bytes_per_second: f64,
    pub started_at_ms: Option<u64>,
    pub last_packet_at_ms: Option<u64>,
    pub temp_path: Option<String>,
    pub received_path: Option<String>,
    pub package_sha256: Option<String>,
    pub payload_sha256: Option<String>,
    pub expected_payload_sha256: Option<String>,
    pub header_valid: Option<bool>,
    pub payload_valid: Option<bool>,
    pub error: Option<String>,
    pub injected_fault: Option<String>,
    pub config: McuOtaConfig,
}

impl Default for McuOtaState {
    fn default() -> Self {
        Self {
            enabled: false,
            status: "disabled".into(),
            debugfile_version: String::new(),
            current_version: String::new(),
            version_source: "debugfile".into(),
            version_updated_at: None,
            target_version: None,
            firmware_size: 0,
            received_bytes: 0,
            progress: 0.0,
            packet_count: 0,
            next_offset: 0,
            bytes_per_second: 0.0,
            started_at_ms: None,
            last_packet_at_ms: None,
            temp_path: None,
            received_path: None,
            package_sha256: None,
            payload_sha256: None,
            expected_payload_sha256: None,
            header_valid: None,
            payload_valid: None,
            error: None,
            injected_fault: None,
            config: McuOtaConfig::default(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredVersion {
    version: String,
    #[serde(default = "default_stored_version_source")]
    source: String,
    updated_at: String,
    package_sha256: String,
    payload_sha256: String,
}

fn default_stored_version_source() -> String {
    // 旧版本文件只可能由 OTA 成功流程写入，因此迁移时默认标记为 ota。
    "ota".into()
}

struct PendingVersionChange {
    product_key: String,
    target_version: String,
    source: String,
    package_sha256: String,
    payload_sha256: String,
    restore_debugfile: bool,
}

struct OtaSession {
    file: File,
    temp_path: PathBuf,
    product_key: String,
    expected_size: u64,
    packet_count: u64,
    next_offset: u64,
    header: Option<ParsedHeader>,
    started_at_ms: u64,
    dropped_ack_once: bool,
}

#[derive(Clone, Debug)]
struct ParsedHeader {
    version: FirmwareVersion,
    package_size: u64,
    payload_size: u64,
    payload_source: u8,
    created_at: u64,
    pid_hash: [u8; 8],
    payload_sha256: [u8; 32],
    header_crc32: u32,
}

#[derive(Default)]
pub struct McuOtaManager {
    config: McuOtaConfig,
    state: McuOtaState,
    app_data_dir: Option<PathBuf>,
    cache_dir: Option<PathBuf>,
    versions: HashMap<String, StoredVersion>,
    session: Option<OtaSession>,
    reboot_at_ms: Option<u64>,
    pending_version_change: Option<PendingVersionChange>,
    deferred_product_query: bool,
}

pub struct OtaTick {
    pub version_changed: Option<String>,
    pub reset_heartbeat: bool,
    pub reply_product_info: bool,
}

pub enum OtaFrameResult {
    Ack(Vec<u8>),
    NoAck,
}

impl McuOtaManager {
    pub fn initialize(&mut self, app_data_dir: PathBuf, cache_dir: PathBuf) -> Result<(), String> {
        fs::create_dir_all(&app_data_dir).map_err(|error| error.to_string())?;
        fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
        self.app_data_dir = Some(app_data_dir.clone());
        self.cache_dir = Some(cache_dir);
        let path = app_data_dir.join(VERSION_FILE);
        self.versions = if path.exists() {
            serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
                .unwrap_or_default()
        } else {
            HashMap::new()
        };
        Ok(())
    }

    pub fn configure(&mut self, config: McuOtaConfig) {
        self.config = config.clone();
        self.state.enabled = config.enabled;
        self.state.config = config;
        if self.state.status == "disabled" || self.state.status == "idle" {
            self.state.status = if self.state.enabled {
                "idle"
            } else {
                "disabled"
            }
            .into();
        }
        if !self.state.enabled && matches!(self.state.status.as_str(), "receiving" | "verifying") {
            self.interrupt("OTA receiver disabled", "disabled");
        }
    }

    pub fn snapshot(
        &self,
        product_key: Option<&str>,
        debugfile_version: Option<&str>,
    ) -> McuOtaState {
        let mut state = self.state.clone();
        state.debugfile_version = debugfile_version.unwrap_or_default().to_string();
        state.current_version = product_key
            .and_then(|key| self.versions.get(key).map(|item| item.version.clone()))
            .unwrap_or_else(|| debugfile_version.unwrap_or_default().to_string());
        if let Some(stored) = product_key.and_then(|key| self.versions.get(key)) {
            state.version_source = stored.source.clone();
            state.version_updated_at = Some(stored.updated_at.clone());
        } else {
            state.version_source = "debugfile".into();
            state.version_updated_at = None;
        }
        state
    }

    pub fn effective_version(&self, product_key: &str, debugfile_version: &str) -> String {
        self.versions
            .get(product_key)
            .map(|item| item.version.clone())
            .unwrap_or_else(|| debugfile_version.to_string())
    }

    pub fn is_busy(&self) -> bool {
        matches!(
            self.state.status.as_str(),
            "receiving" | "verifying" | "rebooting"
        )
    }

    pub fn battery_dp_code(&self) -> Option<String> {
        self.config.battery_dp_code.clone()
    }

    pub fn start(
        &mut self,
        firmware_size: u64,
        product_key: &str,
        current_version: &str,
        now_ms: u64,
        battery_value: Option<i64>,
    ) -> Result<OtaFrameResult, String> {
        if !self.config.enabled || self.config.fault.reject_start {
            self.fail("OTA start rejected", Some("reject_start"));
            return Ok(OtaFrameResult::NoAck);
        }
        if firmware_size < TMSF_HEADER_SIZE as u64
            || firmware_size > self.config.max_firmware_size.max(TMSF_HEADER_SIZE as u64)
        {
            self.fail("firmware size is outside the configured limit", None);
            return Ok(OtaFrameResult::NoAck);
        }
        if let (Some(minimum), Some(value)) = (self.config.battery_minimum, battery_value) {
            if value < minimum {
                self.fail(
                    &format!("battery {value} is below OTA minimum {minimum}"),
                    None,
                );
                return Ok(OtaFrameResult::NoAck);
            }
        }
        let cache_dir = self
            .cache_dir
            .clone()
            .ok_or_else(|| "OTA storage is not initialized".to_string())?;
        if available_space(&cache_dir).map_err(|error| error.to_string())? < firmware_size * 2 {
            self.fail("insufficient disk space for OTA package", None);
            return Ok(OtaFrameResult::NoAck);
        }
        let temp_path = cache_dir.join(format!("mcu-ota-{}-{now_ms}.part", sanitize(product_key)));
        let file = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&temp_path)
            .map_err(|error| error.to_string())?;
        self.session = Some(OtaSession {
            file,
            temp_path: temp_path.clone(),
            product_key: product_key.to_string(),
            expected_size: firmware_size,
            packet_count: 0,
            next_offset: 0,
            header: None,
            started_at_ms: now_ms,
            dropped_ack_once: false,
        });
        self.state = McuOtaState {
            enabled: true,
            status: "receiving".into(),
            debugfile_version: current_version.into(),
            current_version: current_version.into(),
            firmware_size,
            started_at_ms: Some(now_ms),
            temp_path: Some(temp_path.to_string_lossy().to_string()),
            config: self.config.clone(),
            ..McuOtaState::default()
        };
        Ok(OtaFrameResult::Ack(vec![OTA_CHUNK_SIZE_CODE]))
    }

    pub fn receive_packet(
        &mut self,
        payload: &[u8],
        current_version: &str,
        now_ms: u64,
    ) -> Result<OtaFrameResult, String> {
        if payload.len() < 4 {
            self.fail("OTA packet is shorter than the 4-byte offset", None);
            return Ok(OtaFrameResult::NoAck);
        }
        let offset = u32::from_be_bytes(payload[0..4].try_into().unwrap()) as u64;
        let data = &payload[4..];
        if data.is_empty() {
            return self.finish(offset, current_version, now_ms);
        }
        if data.len() > OTA_CHUNK_SIZE {
            self.fail(
                "OTA data packet exceeds negotiated 256-byte chunk size",
                None,
            );
            return Ok(OtaFrameResult::NoAck);
        }
        let packet_number = self
            .session
            .as_ref()
            .map(|session| session.packet_count + 1)
            .ok_or_else(|| "OTA packet received without an active session".to_string())?;
        if self.config.fault.power_loss_packet == Some(packet_number) {
            self.interrupt("simulated power loss", "power_loss");
            return Ok(OtaFrameResult::NoAck);
        }
        if self.config.fault.write_fail_packet == Some(packet_number) {
            self.fail("simulated firmware write failure", Some("write_failure"));
            return Ok(OtaFrameResult::NoAck);
        }
        if self.config.fault.offset_error_packet == Some(packet_number) {
            self.fail("simulated offset validation failure", Some("offset_error"));
            return Ok(OtaFrameResult::NoAck);
        }

        let (next_offset, expected_size) = self
            .session
            .as_ref()
            .map(|session| (session.next_offset, session.expected_size))
            .unwrap();
        if offset < next_offset {
            let duplicate_matches = {
                let session = self.session.as_mut().unwrap();
                let mut existing = vec![0u8; data.len()];
                session
                    .file
                    .seek(SeekFrom::Start(offset))
                    .and_then(|_| session.file.read_exact(&mut existing))
                    .map_err(|error| error.to_string())?;
                existing == data
            };
            if duplicate_matches {
                let stored_packet_number = offset / OTA_CHUNK_SIZE as u64 + 1;
                let should_keep_dropping = self.config.fault.drop_ack_packet
                    == Some(stored_packet_number)
                    && self.config.fault.drop_ack_persistent;
                if should_keep_dropping {
                    return Ok(OtaFrameResult::NoAck);
                }
                return Ok(OtaFrameResult::Ack(Vec::new()));
            }
            self.fail(
                "duplicate OTA packet content differs from stored data",
                None,
            );
            return Ok(OtaFrameResult::NoAck);
        }
        if offset != next_offset || offset + data.len() as u64 > expected_size {
            self.fail(
                &format!(
                    "invalid OTA offset: expected={next_offset}, actual={offset}, len={}",
                    data.len()
                ),
                None,
            );
            return Ok(OtaFrameResult::NoAck);
        }
        if offset == 0 {
            if data.len() < TMSF_HEADER_SIZE {
                self.fail(
                    "first OTA packet does not contain the complete TMSF header",
                    None,
                );
                return Ok(OtaFrameResult::NoAck);
            }
            let mut header = match parse_header(&data[..TMSF_HEADER_SIZE]) {
                Ok(header) => header,
                Err(detail) => {
                    self.fail(&detail, None);
                    return Ok(OtaFrameResult::NoAck);
                }
            };
            if self.config.fault.force_header_crc_failure {
                header.header_crc32 ^= 1;
            }
            let product_key = self.session.as_ref().unwrap().product_key.clone();
            if let Err(detail) = validate_header(
                &header,
                &data[..TMSF_HEADER_SIZE],
                &product_key,
                expected_size,
                current_version,
                self.config.allow_non_upgrade,
            ) {
                self.state.header_valid = Some(false);
                self.fail(&detail, None);
                return Ok(OtaFrameResult::NoAck);
            }
            self.state.target_version = Some(header.version.to_string());
            self.state.expected_payload_sha256 = Some(hex(&header.payload_sha256));
            self.state.header_valid = Some(true);
            self.session.as_mut().unwrap().header = Some(header);
        }
        let session = self.session.as_mut().unwrap();
        session
            .file
            .seek(SeekFrom::Start(offset))
            .and_then(|_| session.file.write_all(data))
            .and_then(|_| session.file.flush())
            .map_err(|error| error.to_string())?;
        session.next_offset += data.len() as u64;
        session.packet_count += 1;
        self.state.received_bytes = session.next_offset;
        self.state.next_offset = session.next_offset;
        self.state.packet_count = session.packet_count;
        self.state.last_packet_at_ms = Some(now_ms);
        self.state.progress = session.next_offset as f64 * 100.0 / session.expected_size as f64;
        let elapsed = now_ms.saturating_sub(session.started_at_ms).max(1);
        self.state.bytes_per_second = session.next_offset as f64 * 1000.0 / elapsed as f64;

        if self.config.fault.drop_ack_packet == Some(packet_number)
            && (self.config.fault.drop_ack_persistent || !session.dropped_ack_once)
        {
            session.dropped_ack_once = true;
            self.state.injected_fault = Some(format!("drop_ack_packet_{packet_number}"));
            return Ok(OtaFrameResult::NoAck);
        }
        Ok(OtaFrameResult::Ack(Vec::new()))
    }

    fn finish(
        &mut self,
        offset: u64,
        current_version: &str,
        now_ms: u64,
    ) -> Result<OtaFrameResult, String> {
        let (expected_size, next_offset) = self
            .session
            .as_ref()
            .map(|session| (session.expected_size, session.next_offset))
            .ok_or_else(|| "OTA finish packet received without a session".to_string())?;
        if offset != expected_size || next_offset != expected_size {
            self.fail(
                "OTA finish offset or received size does not match package size",
                None,
            );
            return Ok(OtaFrameResult::NoAck);
        }
        // Windows 不允许重命名仍被打开的文件，因此完成包先接管会话并显式关闭句柄。
        let mut session = self.session.take().unwrap();
        session.file.flush().map_err(|error| error.to_string())?;
        let temp_path = session.temp_path.clone();
        let product_key = session.product_key.clone();
        drop(session.file);
        self.state.status = "verifying".into();
        let mut info = inspect_package(&temp_path)?;
        if self.config.fault.force_payload_hash_failure {
            info.valid = false;
            info.error = Some("simulated payload SHA-256 failure".into());
        }
        if !info.valid {
            self.fail(
                info.error
                    .as_deref()
                    .unwrap_or("firmware verification failed"),
                Some("payload_hash_failure"),
            );
            return Ok(OtaFrameResult::NoAck);
        }
        let final_path = temp_path.with_extension("bin");
        fs::rename(&temp_path, &final_path).map_err(|error| error.to_string())?;
        self.state.status = "rebooting".into();
        self.state.current_version = current_version.into();
        self.state.target_version = Some(info.target_version.clone());
        self.state.received_path = Some(final_path.to_string_lossy().to_string());
        self.state.temp_path = None;
        self.state.package_sha256 = Some(info.package_sha256);
        self.state.payload_sha256 = Some(info.payload_sha256);
        self.state.payload_valid = Some(true);
        self.state.progress = 100.0;
        self.reboot_at_ms = Some(now_ms + 1000);
        self.pending_version_change = Some(PendingVersionChange {
            product_key,
            target_version: info.target_version,
            source: "ota".into(),
            package_sha256: self.state.package_sha256.clone().unwrap_or_default(),
            payload_sha256: self.state.payload_sha256.clone().unwrap_or_default(),
            restore_debugfile: false,
        });
        Ok(OtaFrameResult::Ack(Vec::new()))
    }

    pub fn tick(&mut self, now_ms: u64) -> Result<OtaTick, String> {
        let Some(reboot_at) = self.reboot_at_ms else {
            return Ok(OtaTick {
                version_changed: None,
                reset_heartbeat: false,
                reply_product_info: false,
            });
        };
        if now_ms < reboot_at {
            return Ok(OtaTick {
                version_changed: None,
                reset_heartbeat: false,
                reply_product_info: false,
            });
        }
        let pending = self
            .pending_version_change
            .take()
            .ok_or_else(|| "MCU reboot lost pending version change".to_string())?;
        let target = pending.target_version;
        if pending.restore_debugfile {
            self.versions.remove(&pending.product_key);
        } else {
            self.versions.insert(
                pending.product_key,
                StoredVersion {
                    version: target.clone(),
                    source: pending.source,
                    updated_at: chrono::Utc::now().to_rfc3339(),
                    package_sha256: pending.package_sha256,
                    payload_sha256: pending.payload_sha256,
                },
            );
        }
        self.persist_versions()?;
        self.state.status = "completed".into();
        self.state.current_version = target.clone();
        self.reboot_at_ms = None;
        let reply = std::mem::take(&mut self.deferred_product_query);
        Ok(OtaTick {
            version_changed: Some(target),
            reset_heartbeat: true,
            reply_product_info: reply,
        })
    }

    pub fn defer_product_query_if_rebooting(&mut self) -> bool {
        if self.state.status == "rebooting" {
            self.deferred_product_query = true;
            true
        } else {
            false
        }
    }

    pub fn cancel(&mut self) {
        self.interrupt("OTA cancelled by user", "cancelled");
    }

    pub fn simulate_power_loss(&mut self) {
        self.interrupt("simulated power loss", "power_loss");
    }

    pub fn clear(&mut self) {
        self.session = None;
        self.reboot_at_ms = None;
        self.pending_version_change = None;
        self.state = McuOtaState {
            enabled: self.config.enabled,
            status: if self.config.enabled {
                "idle"
            } else {
                "disabled"
            }
            .into(),
            config: self.config.clone(),
            ..McuOtaState::default()
        };
    }

    pub fn set_manual_version(
        &mut self,
        product_key: &str,
        version: &str,
        now_ms: u64,
    ) -> Result<(), String> {
        if self.is_busy() {
            return Err("MCU version cannot be changed during an active OTA or reboot".into());
        }
        let version = FirmwareVersion::parse(version)?.to_string();
        self.schedule_version_reboot(product_key, &version, "manual", false, now_ms);
        Ok(())
    }

    pub fn restore_debugfile_version(
        &mut self,
        product_key: &str,
        debugfile_version: &str,
        now_ms: u64,
    ) -> Result<(), String> {
        if self.is_busy() {
            return Err("MCU version cannot be restored during an active OTA or reboot".into());
        }
        let version = FirmwareVersion::parse(debugfile_version)?.to_string();
        self.schedule_version_reboot(product_key, &version, "debugfile", true, now_ms);
        Ok(())
    }

    fn schedule_version_reboot(
        &mut self,
        product_key: &str,
        target_version: &str,
        source: &str,
        restore_debugfile: bool,
        now_ms: u64,
    ) {
        // 手动设置与恢复均复用真实 OTA 的重启窗口，确保心跳和产品信息时序一致。
        self.state.status = "rebooting".into();
        self.state.target_version = Some(target_version.into());
        self.state.error = None;
        self.state.injected_fault = None;
        self.reboot_at_ms = Some(now_ms + 1000);
        self.pending_version_change = Some(PendingVersionChange {
            product_key: product_key.into(),
            target_version: target_version.into(),
            source: source.into(),
            package_sha256: String::new(),
            payload_sha256: String::new(),
            restore_debugfile,
        });
    }

    pub fn export_received(&self, destination: &Path) -> Result<(), String> {
        let source = self
            .state
            .received_path
            .as_ref()
            .ok_or_else(|| "no received firmware is available".to_string())?;
        fs::copy(source, destination).map_err(|error| error.to_string())?;
        Ok(())
    }

    fn interrupt(&mut self, message: &str, fault: &str) {
        // 中断后不删除 .part，便于检查故障注入结果；只释放句柄，下一次升级仍从 offset 0 开始。
        self.session = None;
        self.state.status = "interrupted".into();
        self.state.error = Some(message.into());
        self.state.injected_fault = Some(fault.into());
        self.reboot_at_ms = None;
        self.pending_version_change = None;
    }

    fn fail(&mut self, message: &str, fault: Option<&str>) {
        self.session = None;
        self.state.status = "failed".into();
        self.state.error = Some(message.into());
        self.state.injected_fault = fault.map(str::to_string);
        self.reboot_at_ms = None;
        self.pending_version_change = None;
    }

    fn persist_versions(&self) -> Result<(), String> {
        let directory = self
            .app_data_dir
            .as_ref()
            .ok_or_else(|| "OTA app data path is not initialized".to_string())?;
        let path = directory.join(VERSION_FILE);
        let temp = directory.join(format!("{VERSION_FILE}.tmp"));
        fs::write(
            &temp,
            serde_json::to_vec_pretty(&self.versions).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        fs::rename(temp, path).map_err(|error| error.to_string())
    }
}

pub fn generate_package(config: &FirmwareGenerateConfig) -> Result<FirmwarePackageInfo, String> {
    let version = FirmwareVersion::parse(&config.target_version)?;
    let current = FirmwareVersion::parse(&config.current_version)?;
    if !config.allow_non_upgrade && version <= current {
        return Err(format!(
            "target version {} must be newer than current version {}",
            version, current
        ));
    }
    let output = PathBuf::from(&config.output_path);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut file = File::create(&output).map_err(|error| error.to_string())?;
    file.write_all(&[0u8; TMSF_HEADER_SIZE])
        .map_err(|error| error.to_string())?;
    let (payload_size, source_code, source_label, payload_hash) = write_payload(&mut file, config)?;
    let package_size = payload_size + TMSF_HEADER_SIZE as u64;
    let created_at = unix_seconds();
    let pid_hash = pid_hash(&config.product_key);
    let header = build_header(
        version,
        package_size,
        payload_size,
        source_code,
        created_at,
        pid_hash,
        payload_hash,
    );
    file.seek(SeekFrom::Start(0))
        .and_then(|_| file.write_all(&header))
        .and_then(|_| file.flush())
        .map_err(|error| error.to_string())?;
    drop(file);
    let mut info = inspect_package(&output)?;
    info.product_key = Some(config.product_key.clone());
    info.payload_source = source_label;
    let manifest_path = output.with_extension("manifest.json");
    info.manifest_path = Some(manifest_path.to_string_lossy().to_string());
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&info).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(info)
}

pub fn inspect_package(path: &Path) -> Result<FirmwarePackageInfo, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let actual_size = file.metadata().map_err(|error| error.to_string())?.len();
    let mut header_bytes = [0u8; TMSF_HEADER_SIZE];
    file.read_exact(&mut header_bytes)
        .map_err(|error| error.to_string())?;
    let header = parse_header(&header_bytes)?;
    let mut payload_hasher = Sha256::new();
    let mut package_hasher = Sha256::new();
    package_hasher.update(header_bytes);
    let mut buffer = [0u8; 64 * 1024];
    let mut payload_size = 0u64;
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        payload_hasher.update(&buffer[..read]);
        package_hasher.update(&buffer[..read]);
        payload_size += read as u64;
    }
    let payload_hash: [u8; 32] = payload_hasher.finalize().into();
    let package_hash: [u8; 32] = package_hasher.finalize().into();
    let calculated_crc = crc32(&header_bytes[..76]);
    let valid = header.package_size == actual_size
        && header.payload_size == payload_size
        && header.payload_sha256 == payload_hash
        && header.header_crc32 == calculated_crc;
    let error = (!valid).then(|| {
        format!(
            "package verification failed: package={}/{}, payload={}/{}, crc={:08x}/{:08x}",
            actual_size,
            header.package_size,
            payload_size,
            header.payload_size,
            calculated_crc,
            header.header_crc32
        )
    });
    Ok(FirmwarePackageInfo {
        path: path.to_string_lossy().to_string(),
        manifest_path: None,
        product_key: None,
        target_version: header.version.to_string(),
        package_size: header.package_size,
        payload_size: header.payload_size,
        payload_source: payload_source_label(header.payload_source).into(),
        created_at: header.created_at,
        pid_hash: hex(&header.pid_hash),
        payload_sha256: hex(&payload_hash),
        package_sha256: hex(&package_hash),
        header_crc32: format!("{:08x}", header.header_crc32),
        valid,
        error,
    })
}

fn write_payload(
    output: &mut File,
    config: &FirmwareGenerateConfig,
) -> Result<(u64, u8, String, [u8; 32]), String> {
    let mut hasher = Sha256::new();
    let mut written = 0u64;
    if config.payload_mode == "import" {
        let source_path = config
            .source_path
            .as_ref()
            .ok_or_else(|| "sourcePath is required for imported payload".to_string())?;
        let mut source = File::open(source_path).map_err(|error| error.to_string())?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = source
                .read(&mut buffer)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            output
                .write_all(&buffer[..read])
                .map_err(|error| error.to_string())?;
            hasher.update(&buffer[..read]);
            written += read as u64;
        }
        return Ok((written, 2, "import".into(), hasher.finalize().into()));
    }
    if !(1024..=64 * 1024 * 1024).contains(&config.payload_size) {
        return Err("generated payload size must be between 1 KiB and 64 MiB".into());
    }
    let mut seed = config.seed.unwrap_or(1).max(1);
    let mut buffer = [0u8; 64 * 1024];
    while written < config.payload_size {
        let len = buffer.len().min((config.payload_size - written) as usize);
        for (index, byte) in buffer[..len].iter_mut().enumerate() {
            *byte = match config.payload_mode.as_str() {
                "zero" => 0,
                "ff" => 0xff,
                "increment" => ((written + index as u64) & 0xff) as u8,
                "random" => {
                    seed ^= seed << 13;
                    seed ^= seed >> 7;
                    seed ^= seed << 17;
                    seed as u8
                }
                _ => return Err(format!("unknown payload mode: {}", config.payload_mode)),
            };
        }
        output
            .write_all(&buffer[..len])
            .map_err(|error| error.to_string())?;
        hasher.update(&buffer[..len]);
        written += len as u64;
    }
    let source_code = if config.payload_mode == "random" {
        1
    } else {
        0
    };
    Ok((
        written,
        source_code,
        config.payload_mode.clone(),
        hasher.finalize().into(),
    ))
}

fn build_header(
    version: FirmwareVersion,
    package_size: u64,
    payload_size: u64,
    payload_source: u8,
    created_at: u64,
    pid_hash: [u8; 8],
    payload_hash: [u8; 32],
) -> [u8; TMSF_HEADER_SIZE] {
    let mut header = [0u8; TMSF_HEADER_SIZE];
    header[0..4].copy_from_slice(TMSF_MAGIC);
    header[4] = TMSF_FORMAT_VERSION;
    header[5] = 0;
    header[6..8].copy_from_slice(&(TMSF_HEADER_SIZE as u16).to_be_bytes());
    header[8..12].copy_from_slice(&(package_size as u32).to_be_bytes());
    header[12..16].copy_from_slice(&(payload_size as u32).to_be_bytes());
    header[16] = version.major;
    header[17] = version.minor;
    header[18] = version.patch;
    header[19] = payload_source;
    header[20..24].copy_from_slice(&(created_at as u32).to_be_bytes());
    header[24..32].copy_from_slice(&pid_hash);
    header[32..64].copy_from_slice(&payload_hash);
    let crc = crc32(&header[..76]);
    header[76..80].copy_from_slice(&crc.to_be_bytes());
    header
}

fn parse_header(bytes: &[u8]) -> Result<ParsedHeader, String> {
    if bytes.len() < TMSF_HEADER_SIZE || &bytes[0..4] != TMSF_MAGIC {
        return Err("invalid TMSF magic or header length".into());
    }
    if bytes[4] != TMSF_FORMAT_VERSION
        || u16::from_be_bytes([bytes[6], bytes[7]]) as usize != TMSF_HEADER_SIZE
    {
        return Err("unsupported TMSF format version or header size".into());
    }
    Ok(ParsedHeader {
        version: FirmwareVersion {
            major: bytes[16],
            minor: bytes[17],
            patch: bytes[18],
        },
        package_size: u32::from_be_bytes(bytes[8..12].try_into().unwrap()) as u64,
        payload_size: u32::from_be_bytes(bytes[12..16].try_into().unwrap()) as u64,
        payload_source: bytes[19],
        created_at: u32::from_be_bytes(bytes[20..24].try_into().unwrap()) as u64,
        pid_hash: bytes[24..32].try_into().unwrap(),
        payload_sha256: bytes[32..64].try_into().unwrap(),
        header_crc32: u32::from_be_bytes(bytes[76..80].try_into().unwrap()),
    })
}

fn validate_header(
    header: &ParsedHeader,
    bytes: &[u8],
    product_key: &str,
    expected_size: u64,
    current_version: &str,
    allow_non_upgrade: bool,
) -> Result<(), String> {
    if header.package_size != expected_size
        || header.package_size != header.payload_size + TMSF_HEADER_SIZE as u64
    {
        return Err("TMSF size fields do not match OTA start size".into());
    }
    if header.pid_hash != pid_hash(product_key) {
        return Err("TMSF product key hash does not match current Debugfile".into());
    }
    if header.header_crc32 != crc32(&bytes[..76]) {
        return Err("TMSF header CRC32 verification failed".into());
    }
    let current = FirmwareVersion::parse(current_version)?;
    if !allow_non_upgrade && header.version <= current {
        return Err(format!(
            "firmware version {} is not newer than current version {}",
            header.version, current
        ));
    }
    Ok(())
}

fn pid_hash(product_key: &str) -> [u8; 8] {
    let digest = Sha256::digest(product_key.as_bytes());
    digest[..8].try_into().unwrap()
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut hasher = Crc32::new();
    hasher.update(bytes);
    hasher.finalize()
}

fn payload_source_label(code: u8) -> &'static str {
    match code {
        0 => "pattern",
        1 => "random",
        2 => "import",
        _ => "unknown",
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sanitize(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_ID: AtomicU64 = AtomicU64::new(1);

    fn test_dir(name: &str) -> PathBuf {
        let id = TEST_ID.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("tuya-mcu-ota-{name}-{}-{id}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn generation_config(path: &Path, mode: &str, seed: Option<u64>) -> FirmwareGenerateConfig {
        FirmwareGenerateConfig {
            output_path: path.to_string_lossy().to_string(),
            product_key: "test-product-key".into(),
            target_version: "1.0.1".into(),
            payload_mode: mode.into(),
            payload_size: 1024,
            seed,
            source_path: None,
            allow_non_upgrade: false,
            current_version: "1.0.0".into(),
        }
    }

    #[test]
    fn version_parsing_and_ordering() {
        assert!(
            FirmwareVersion::parse("1.2.3").unwrap() > FirmwareVersion::parse("1.2.2").unwrap()
        );
        assert!(FirmwareVersion::parse("1.2").is_err());
    }

    #[test]
    fn header_round_trip_and_crc() {
        let header = build_header(
            FirmwareVersion {
                major: 1,
                minor: 2,
                patch: 3,
            },
            336,
            256,
            1,
            100,
            pid_hash("pid"),
            [7; 32],
        );
        let parsed = parse_header(&header).unwrap();
        assert_eq!(parsed.version.to_string(), "1.2.3");
        assert_eq!(parsed.header_crc32, crc32(&header[..76]));
        assert!(validate_header(&parsed, &header, "pid", 336, "1.0.0", false).is_ok());
    }

    #[test]
    fn generated_random_payload_is_deterministic_and_inspectable() {
        let directory = test_dir("deterministic");
        let first = directory.join("first.bin");
        let second = directory.join("second.bin");
        let first_info = generate_package(&generation_config(&first, "random", Some(42))).unwrap();
        let second_info =
            generate_package(&generation_config(&second, "random", Some(42))).unwrap();

        assert!(first_info.valid);
        assert_eq!(first_info.payload_sha256, second_info.payload_sha256);
        assert_eq!(fs::read(first).unwrap(), fs::read(second).unwrap());
        assert_eq!(first_info.package_size, TMSF_HEADER_SIZE as u64 + 1024);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn imported_binary_is_wrapped_without_changing_payload() {
        let directory = test_dir("import");
        let source = directory.join("source.bin");
        let output = directory.join("wrapped.bin");
        let payload: Vec<u8> = (0..1500).map(|index| (index & 0xff) as u8).collect();
        fs::write(&source, &payload).unwrap();
        let mut config = generation_config(&output, "import", None);
        config.source_path = Some(source.to_string_lossy().to_string());
        let info = generate_package(&config).unwrap();

        assert!(info.valid);
        assert_eq!(info.payload_size, payload.len() as u64);
        assert_eq!(&fs::read(output).unwrap()[TMSF_HEADER_SIZE..], payload);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ota_receive_reboot_and_version_persistence_complete_the_loop() {
        let directory = test_dir("receive");
        let package_path = directory.join("firmware.bin");
        let info = generate_package(&generation_config(&package_path, "increment", None)).unwrap();
        let package = fs::read(&package_path).unwrap();
        let app_data = directory.join("data");
        let cache = directory.join("cache");
        let mut manager = McuOtaManager::default();
        manager.initialize(app_data.clone(), cache).unwrap();
        manager.configure(McuOtaConfig {
            enabled: true,
            ..McuOtaConfig::default()
        });

        assert!(matches!(
            manager
                .start(info.package_size, "test-product-key", "1.0.0", 1000, None)
                .unwrap(),
            OtaFrameResult::Ack(ref data) if data == &[OTA_CHUNK_SIZE_CODE]
        ));
        for (index, chunk) in package.chunks(OTA_CHUNK_SIZE).enumerate() {
            let offset = (index * OTA_CHUNK_SIZE) as u32;
            let mut packet = offset.to_be_bytes().to_vec();
            packet.extend_from_slice(chunk);
            assert!(matches!(
                manager
                    .receive_packet(&packet, "1.0.0", 1100 + index as u64)
                    .unwrap(),
                OtaFrameResult::Ack(_)
            ));
        }
        let end = (package.len() as u32).to_be_bytes();
        assert!(matches!(
            manager.receive_packet(&end, "1.0.0", 2000).unwrap(),
            OtaFrameResult::Ack(_)
        ));
        assert_eq!(manager.snapshot(None, None).status, "rebooting");
        let tick = manager.tick(3000).unwrap();
        assert_eq!(tick.version_changed.as_deref(), Some("1.0.1"));
        assert_eq!(
            manager.effective_version("test-product-key", "1.0.0"),
            "1.0.1"
        );

        let mut restored = McuOtaManager::default();
        restored
            .initialize(app_data, directory.join("cache-2"))
            .unwrap();
        assert_eq!(
            restored.effective_version("test-product-key", "1.0.0"),
            "1.0.1"
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn invalid_pid_header_is_rejected_without_ack() {
        let directory = test_dir("pid-mismatch");
        let package_path = directory.join("firmware.bin");
        let info = generate_package(&generation_config(&package_path, "zero", None)).unwrap();
        let package = fs::read(package_path).unwrap();
        let mut manager = McuOtaManager::default();
        manager
            .initialize(directory.join("data"), directory.join("cache"))
            .unwrap();
        manager.configure(McuOtaConfig {
            enabled: true,
            ..McuOtaConfig::default()
        });
        manager
            .start(info.package_size, "another-product", "1.0.0", 1000, None)
            .unwrap();
        let mut packet = 0u32.to_be_bytes().to_vec();
        packet.extend_from_slice(&package[..OTA_CHUNK_SIZE]);
        assert!(matches!(
            manager.receive_packet(&packet, "1.0.0", 1100).unwrap(),
            OtaFrameResult::NoAck
        ));
        let state = manager.snapshot(None, None);
        assert_eq!(state.status, "failed");
        assert_eq!(state.header_valid, Some(false));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn legacy_version_record_defaults_to_ota_source() {
        let record: StoredVersion = serde_json::from_value(serde_json::json!({
            "version": "1.2.3",
            "updatedAt": "2026-07-16T10:00:00Z",
            "packageSha256": "package",
            "payloadSha256": "payload"
        }))
        .unwrap();
        assert_eq!(record.source, "ota");
    }

    #[test]
    fn manual_version_and_restore_use_reboot_transaction() {
        let directory = test_dir("manual-version");
        let mut manager = McuOtaManager::default();
        manager
            .initialize(directory.join("data"), directory.join("cache"))
            .unwrap();
        let initial = manager.snapshot(Some("pid-a"), Some("1.0.0"));
        assert_eq!(initial.current_version, "1.0.0");
        assert_eq!(initial.version_source, "debugfile");
        assert_eq!(initial.version_updated_at, None);

        manager.set_manual_version("pid-a", "0.9.0", 1000).unwrap();
        assert_eq!(manager.snapshot(None, None).status, "rebooting");
        assert_eq!(manager.effective_version("pid-a", "1.0.0"), "1.0.0");
        assert!(manager.tick(1999).unwrap().version_changed.is_none());
        assert_eq!(
            manager.tick(2000).unwrap().version_changed.as_deref(),
            Some("0.9.0")
        );
        let manual = manager.snapshot(Some("pid-a"), Some("1.0.0"));
        assert_eq!(manual.current_version, "0.9.0");
        assert_eq!(manual.version_source, "manual");
        assert!(manual.version_updated_at.is_some());

        manager
            .restore_debugfile_version("pid-a", "1.0.0", 3000)
            .unwrap();
        assert_eq!(manager.effective_version("pid-a", "1.0.0"), "0.9.0");
        manager.tick(4000).unwrap();
        let restored = manager.snapshot(Some("pid-a"), Some("1.0.0"));
        assert_eq!(restored.current_version, "1.0.0");
        assert_eq!(restored.version_source, "debugfile");
        assert_eq!(restored.version_updated_at, None);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn manual_version_validates_format_and_rejects_busy_changes() {
        let directory = test_dir("manual-validation");
        let mut manager = McuOtaManager::default();
        manager
            .initialize(directory.join("data"), directory.join("cache"))
            .unwrap();
        for invalid in ["", "1", "1.2", "1.2.3.4", "-1.0.0", "256.0.0"] {
            assert!(manager.set_manual_version("pid", invalid, 1000).is_err());
        }
        manager.set_manual_version("pid", "1.0.0", 1000).unwrap();
        assert!(manager.set_manual_version("pid", "2.0.0", 1001).is_err());
        assert!(manager
            .restore_debugfile_version("pid", "1.0.0", 1001)
            .is_err());
        let _ = fs::remove_dir_all(directory);
    }
}
