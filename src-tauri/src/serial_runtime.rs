use crate::dp_schema::{DpKind, DpSchema};
use crate::dp_simulator::{decode_value, encode_report_with_enum, DpReport};
use crate::emit_state;
use crate::language::AppLanguage;
use crate::tuya_protocol::{
    build_frame, hex, FrameParser, CMD_DP_DOWNLOAD, CMD_DP_REPORT, CMD_GET_GREEN_TIME,
    CMD_GET_LOCAL_TIME, CMD_GET_MAC, CMD_GET_WIFI_STATUS, CMD_HEARTBEAT, CMD_HEARTBEAT_STOP,
    CMD_NEW_FUNCTION_NOTICE, CMD_PRODUCT_INFO, CMD_QUERY_ALL_DP, CMD_QUERY_MEMORY,
    CMD_QUERY_SIGNAL_STRENGTH, CMD_WIFI_RESET, CMD_WIFI_SELECT_MODE, CMD_WIFI_STATE, CMD_WORK_MODE,
};
use crate::AppState;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serialport::{ClearBuffer, DataBits, FlowControl, Parity, SerialPort, StopBits};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SerialSettings {
    pub port_name: String,
    pub baud_rate: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct SerialLog {
    pub direction: String,
    pub title: String,
    pub command: Option<u8>,
    pub hex: String,
    pub raw: bool,
    pub timestamp_ms: u128,
}

#[derive(Clone, Debug, Serialize)]
pub struct AppError {
    pub code: String,
    pub title: String,
    pub message: String,
    pub detail: String,
    pub suggestion: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct NetworkStatus {
    pub code: u8,
    pub label: String,
    pub updated_at_ms: u128,
}

#[derive(Clone, Debug)]
pub struct SerialOutbound {
    title: String,
    frame: Vec<u8>,
    keep_heartbeat_alive: bool,
}

pub struct SerialRuntime {
    stop: Arc<AtomicBool>,
    tx: Sender<SerialOutbound>,
    worker: Option<JoinHandle<()>>,
}

impl SerialRuntime {
    pub fn start(
        settings: SerialSettings,
        app: AppHandle,
        state: Arc<AppState>,
        schema: DpSchema,
        language: AppLanguage,
    ) -> Result<Self, AppError> {
        // 串口打开必须在命令调用阶段同步完成，这样“被占用/不存在”能直接反馈到按钮点击处。
        let port = open_serial_port(&settings, language)?;
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel::<SerialOutbound>();
        let worker_stop = stop.clone();
        let worker_state = state.clone();
        let worker = thread::Builder::new()
            .name("tuya-serial-runtime".to_string())
            .spawn(move || {
                if let Err(err) = run_loop(
                    port,
                    app.clone(),
                    worker_state.clone(),
                    schema,
                    worker_stop,
                    rx,
                ) {
                    let language = *worker_state.language.lock();
                    let app_error = AppError::serial_io_failed(err.to_string(), language);
                    emit_error(&app, &app_error);
                }
            })
            .map_err(|err| AppError::runtime_failed(err.to_string(), language))?;

        Ok(Self {
            stop,
            tx,
            worker: Some(worker),
        })
    }

    pub fn sender(&self) -> Sender<SerialOutbound> {
        self.tx.clone()
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }

    pub fn send_reports_if_open(
        state: &tauri::State<Arc<AppState>>,
        _schema: &DpSchema,
        reports: Vec<DpReport>,
    ) -> Result<(), String> {
        Self::send_reports_with_title(state, reports, "manual DP report")
    }

    pub fn send_reports_with_title(
        state: &tauri::State<Arc<AppState>>,
        reports: Vec<DpReport>,
        title: &str,
    ) -> Result<(), String> {
        if reports.is_empty() {
            return Ok(());
        }
        if state.serial.lock().is_some() {
            let payload = combine_reports(reports);
            let frame = build_frame(CMD_DP_REPORT, &payload);
            if let Some(tx) = state.manual_tx.lock().as_ref() {
                tx.send(SerialOutbound {
                    // 定时上报会传入任务名，串口日志里可直接对应到触发来源。
                    title: title.into(),
                    frame,
                    keep_heartbeat_alive: false,
                })
                .map_err(|err| err.to_string())?;
            }
        }
        Ok(())
    }

    pub fn send_wifi_reset(state: &tauri::State<Arc<AppState>>) -> Result<(), AppError> {
        send_control_frames(
            state,
            vec![SerialOutbound {
                title: "Wi-Fi reset".into(),
                frame: build_frame(CMD_WIFI_RESET, &[]),
                keep_heartbeat_alive: true,
            }],
        )
    }

    pub fn send_wifi_mode(state: &tauri::State<Arc<AppState>>, mode: u8) -> Result<(), AppError> {
        let title = match mode {
            0x00 => "set EZ/SmartConfig mode",
            0x01 => "set AP mode",
            _ => "set Wi-Fi mode",
        };
        send_control_frames(
            state,
            vec![SerialOutbound {
                title: title.into(),
                frame: build_frame(CMD_WIFI_SELECT_MODE, &[mode]),
                keep_heartbeat_alive: false,
            }],
        )
    }

    pub fn send_basic_command(
        state: &tauri::State<Arc<AppState>>,
        command: u8,
        payload: Vec<u8>,
        title: &str,
    ) -> Result<(), AppError> {
        // 相关指令按钮都走同一条发送链路，保证未开串口、写失败、日志记录的行为一致。
        send_control_frames(
            state,
            vec![SerialOutbound {
                title: title.into(),
                frame: build_frame(command, &payload),
                keep_heartbeat_alive: false,
            }],
        )
    }
}

fn run_loop(
    mut port: Box<dyn SerialPort>,
    app: AppHandle,
    state: Arc<AppState>,
    schema: DpSchema,
    stop: Arc<AtomicBool>,
    manual_rx: Receiver<SerialOutbound>,
) -> Result<()> {
    let _ = app.emit("serial-opened", true);
    let language = *state.language.lock();
    emit_log(
        &app,
        "rx",
        language.text(
            "串口配置: 8N1/无流控，已清空打开时缓冲",
            "Serial settings: 8N1, no flow control; buffers cleared on open",
        ),
        None,
        &[],
        false,
    );
    let mut parser = FrameParser::default();
    let mut buf = [0u8; 512];
    let mut heartbeat_seen = false;
    let mut reset_pairing_session = false;
    let mut raw_bytes_without_frame = 0usize;
    let mut last_frame_diagnostic = Instant::now() - Duration::from_secs(10);

    while !stop.load(Ordering::Relaxed) {
        match port.read(&mut buf) {
            Ok(size) if size > 0 => {
                let incoming = &buf[..size];
                emit_log(
                    &app,
                    "rx",
                    state
                        .language
                        .lock()
                        .text("原始串口分片", "Raw serial chunk"),
                    None,
                    incoming,
                    true,
                );
                let frames = parser.push(incoming);
                if frames.is_empty() {
                    raw_bytes_without_frame += incoming.len();
                    emit_no_frame_diagnostic(
                        &app,
                        raw_bytes_without_frame,
                        incoming,
                        &mut last_frame_diagnostic,
                        *state.language.lock(),
                    );
                } else {
                    // 只要成功解析到完整 55 AA 帧，就清空底层噪声计数，避免旧诊断影响后续判断。
                    raw_bytes_without_frame = 0;
                }
                for frame in frames {
                    let language = *state.language.lock();
                    let raw_frame = build_raw_frame(frame.version, frame.command, &frame.payload);
                    let title = enrich_title(
                        sdk_rx_title(frame.command, language),
                        describe_frame(&schema, "rx", frame.command, &frame.payload, language),
                    );
                    emit_log(&app, "rx", &title, Some(frame.command), &raw_frame, false);
                    let response_frames = handle_frame(
                        &schema,
                        &state,
                        &frame.command,
                        &frame.payload,
                        &mut heartbeat_seen,
                        &mut reset_pairing_session,
                        &app,
                    );
                    for response in response_frames {
                        // parking_lot::Mutex 不可重入；同一表达式连续 lock 两次会让串口线程等待自身，
                        // 从而出现只有 RX、没有心跳 TX，并导致停止调试 join 永久等待。
                        let language = *state.language.lock();
                        write_frame(
                            &mut port,
                            &app,
                            &schema,
                            sdk_tx_title(response.get(3).copied(), language),
                            &response,
                            language,
                        )?;
                    }
                    emit_state(&app, &state);
                }
            }
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::TimedOut => {}
            Err(err) => return Err(anyhow!("failed to read serial port: {err}")),
        }

        while let Ok(outbound) = manual_rx.try_recv() {
            if outbound.keep_heartbeat_alive {
                // 严格参照附件配网时序：Wi-Fi reset 不等于 MCU 重启，后续心跳继续回复 1。
                heartbeat_seen = true;
                // reset 后模组会重新查询产品信息，附件中的成功配网握手要求本轮使用 m=0。
                reset_pairing_session = true;
            }
            write_frame(
                &mut port,
                &app,
                &schema,
                &outbound.title,
                &outbound.frame,
                *state.language.lock(),
            )?;
        }
    }

    let _ = app.emit("serial-opened", false);
    Ok(())
}

fn handle_frame(
    schema: &DpSchema,
    state: &Arc<AppState>,
    command: &u8,
    payload: &[u8],
    heartbeat_seen: &mut bool,
    reset_pairing_session: &mut bool,
    app: &AppHandle,
) -> Vec<Vec<u8>> {
    match *command {
        CMD_HEARTBEAT => {
            // 涂鸦 SDK 首次心跳回复 0，后续回复 1，用于模组判断 MCU 是否重启。
            let value = if *heartbeat_seen { 0x01 } else { 0x00 };
            *heartbeat_seen = true;
            vec![build_frame(CMD_HEARTBEAT, &[value])]
        }
        CMD_PRODUCT_INFO => {
            let info = product_info_payload(schema, reset_pairing_session.then_some(0));
            if *reset_pairing_session {
                let language = *state.language.lock();
                emit_log(
                    app,
                    "tx",
                    language.text(
                        "SDK TX: reset配网产品信息使用 m=0",
                        "SDK TX: Reset pairing product information uses m=0",
                    ),
                    Some(CMD_PRODUCT_INFO),
                    info.as_bytes(),
                    false,
                );
            }
            vec![build_frame(CMD_PRODUCT_INFO, info.as_bytes())]
        }
        // 当前 SDK 未开启 WIFI_CONTROL_SELF_MODE，因此工作模式回复空包，表示 Wi-Fi 按键/灯由 MCU 侧自行处理。
        CMD_WORK_MODE => vec![build_frame(CMD_WORK_MODE, &[])],
        CMD_WIFI_STATE => {
            let code = payload.first().copied().unwrap_or(0xff);
            let language = *state.language.lock();
            let status = NetworkStatus::new(code, language);
            *state.network.lock() = status.clone();
            let _ = app.emit("network-status", status);
            if code == 0x01 {
                // 附件时序中 AP 配置状态出现并 ACK 后，reset 配网握手已经完成。
                *reset_pairing_session = false;
            }
            vec![build_frame(CMD_WIFI_STATE, &[])]
        }
        CMD_WIFI_RESET | CMD_WIFI_SELECT_MODE => {
            let language = *state.language.lock();
            let title = if *command == CMD_WIFI_RESET {
                language.text("Wi-Fi 重置成功", "Wi-Fi reset acknowledged")
            } else {
                language.text("Wi-Fi 配网模式设置成功", "Wi-Fi mode acknowledged")
            };
            let _ = app.emit("wifi-action", title.to_string());
            Vec::new()
        }
        CMD_QUERY_ALL_DP => {
            let reports = state.simulator.lock().all_reports(schema);
            split_report_frames(reports)
        }
        CMD_DP_DOWNLOAD => {
            let reports = handle_dp_download(schema, state, payload, app);
            // DP 下发后立即把后端保存后的最终状态推送到页面，避免 UI 只显示旧值或乐观值。
            emit_state(app, state);
            split_report_frames(reports)
        }
        CMD_QUERY_MEMORY
        | CMD_GET_GREEN_TIME
        | CMD_QUERY_SIGNAL_STRENGTH
        | CMD_GET_LOCAL_TIME
        | CMD_HEARTBEAT_STOP => Vec::new(),
        CMD_GET_WIFI_STATUS => {
            let code = payload.first().copied().unwrap_or(0xff);
            let language = *state.language.lock();
            let status = NetworkStatus::new(code, language);
            *state.network.lock() = status.clone();
            let _ = app.emit("network-status", status.clone());
            Vec::new()
        }
        CMD_GET_MAC | CMD_NEW_FUNCTION_NOTICE => Vec::new(),
        _ => Vec::new(),
    }
}

fn handle_dp_download(
    schema: &DpSchema,
    state: &Arc<AppState>,
    payload: &[u8],
    app: &AppHandle,
) -> Vec<DpReport> {
    let mut reports = Vec::new();
    let mut index = 0usize;
    while index + 4 <= payload.len() {
        let id = payload[index];
        let len = u16::from_be_bytes([payload[index + 2], payload[index + 3]]) as usize;
        index += 4;
        if index + len > payload.len() {
            break;
        }
        let dp_payload = &payload[index..index + len];
        let next_reports = state
            .simulator
            .lock()
            .apply_download(id, dp_payload, schema);
        emit_dp_download_log(
            app,
            schema,
            id,
            dp_payload,
            &next_reports,
            *state.language.lock(),
        );
        reports.extend(next_reports);
        index += len;
    }
    reports
}

fn emit_dp_download_log(
    app: &AppHandle,
    schema: &DpSchema,
    id: u8,
    payload: &[u8],
    reports: &[DpReport],
    language: AppLanguage,
) {
    let code = schema
        .by_id(id)
        .map(|point| point.code.as_str())
        .unwrap_or("unknown");
    let saved = reports
        .iter()
        .find(|report| report.id == id)
        .map(|report| report.value.to_string())
        .unwrap_or_else(|| {
            language
                .text("未保存或未定义", "not saved or undefined")
                .into()
        });
    emit_log(
        app,
        "rx",
        &match language {
            AppLanguage::ZhCn => format!("DP{id} {code} 下发={saved}，已保存并回报"),
            AppLanguage::EnUs => format!("DP{id} {code} downloaded={saved}, saved and reported"),
        },
        Some(CMD_DP_DOWNLOAD),
        payload,
        false,
    );
}

fn combine_reports(reports: Vec<DpReport>) -> Vec<u8> {
    reports
        .into_iter()
        .flat_map(|report| encode_report_with_enum(&report))
        .collect()
}

fn product_info_payload(schema: &DpSchema, config_mode_override: Option<u8>) -> String {
    // 产品信息来自用户手动加载的 Debugfile；Wi-Fi reset 后的配网握手按附件临时使用 m=0。
    serde_json::json!({
        "p": schema.product_key,
        "v": schema.mcu_version,
        "m": config_mode_override.unwrap_or(schema.config_mode)
    })
    .to_string()
}

fn split_report_frames(reports: Vec<DpReport>) -> Vec<Vec<u8>> {
    // 通用调试时优先拆成多帧，避免单帧过长导致小缓存 MCU SDK 或串口助手显示异常。
    reports
        .into_iter()
        .map(|report| build_frame(CMD_DP_REPORT, &encode_report_with_enum(&report)))
        .collect()
}

fn write_frame(
    port: &mut Box<dyn SerialPort>,
    app: &AppHandle,
    schema: &DpSchema,
    title: &str,
    frame: &[u8],
    language: AppLanguage,
) -> Result<()> {
    port.write_all(frame)?;
    port.flush()?;
    let command = frame.get(3).copied();
    let payload = frame_payload(frame);
    let title = if let Some(command) = command {
        enrich_title(
            title,
            describe_frame(schema, "tx", command, payload, language),
        )
    } else {
        title.to_string()
    };
    emit_log(app, "tx", &title, command, frame, false);
    Ok(())
}

fn frame_payload(frame: &[u8]) -> &[u8] {
    if frame.len() < 7 {
        return &[];
    }
    let declared = u16::from_be_bytes([frame[4], frame[5]]) as usize;
    let available = frame.len().saturating_sub(7);
    let len = declared.min(available);
    &frame[6..6 + len]
}

fn sdk_rx_title(command: u8, language: AppLanguage) -> &'static str {
    match (command, language) {
        (CMD_HEARTBEAT, AppLanguage::EnUs) => "SDK RX: Module heartbeat",
        (CMD_PRODUCT_INFO, AppLanguage::EnUs) => "SDK RX: Product information query",
        (CMD_WORK_MODE, AppLanguage::EnUs) => "SDK RX: Work mode query",
        (CMD_WIFI_STATE, AppLanguage::EnUs) => "SDK RX: Network status report",
        (CMD_WIFI_RESET, AppLanguage::EnUs) => "SDK RX: Wi-Fi reset response",
        (CMD_WIFI_SELECT_MODE, AppLanguage::EnUs) => "SDK RX: Wi-Fi mode response",
        (CMD_DP_DOWNLOAD, AppLanguage::EnUs) => "SDK RX: DP download",
        (CMD_QUERY_ALL_DP, AppLanguage::EnUs) => "SDK RX: All DP query",
        (CMD_QUERY_MEMORY, AppLanguage::EnUs) => "SDK RX: Memory query response",
        (CMD_GET_GREEN_TIME, AppLanguage::EnUs) => "SDK RX: UTC time response",
        (CMD_QUERY_SIGNAL_STRENGTH, AppLanguage::EnUs) => "SDK RX: Signal strength response",
        (CMD_GET_LOCAL_TIME, AppLanguage::EnUs) => "SDK RX: Local time response",
        (CMD_HEARTBEAT_STOP, AppLanguage::EnUs) => "SDK RX: Stop heartbeat response",
        (CMD_GET_WIFI_STATUS, AppLanguage::EnUs) => "SDK RX: Network status response",
        (CMD_GET_MAC, AppLanguage::EnUs) => "SDK RX: MAC response",
        (CMD_NEW_FUNCTION_NOTICE, AppLanguage::EnUs) => "SDK RX: New function response",
        (_, AppLanguage::EnUs) => "SDK RX: Unknown command",
        (command, AppLanguage::ZhCn) => match command {
            CMD_HEARTBEAT => "SDK RX: 模组心跳",
            CMD_PRODUCT_INFO => "SDK RX: 查询产品信息",
            CMD_WORK_MODE => "SDK RX: 查询工作模式",
            CMD_WIFI_STATE => "SDK RX: 上报联网状态",
            CMD_WIFI_RESET => "SDK RX: Wi-Fi reset 回复",
            CMD_WIFI_SELECT_MODE => "SDK RX: Wi-Fi mode 回复",
            CMD_DP_DOWNLOAD => "SDK RX: DP 下发",
            CMD_QUERY_ALL_DP => "SDK RX: 全量状态查询",
            CMD_QUERY_MEMORY => "SDK RX: 查询内存回复",
            CMD_GET_GREEN_TIME => "SDK RX: 格林时间回复",
            CMD_QUERY_SIGNAL_STRENGTH => "SDK RX: 查询信号强度回复",
            CMD_GET_LOCAL_TIME => "SDK RX: 本地时间回复",
            CMD_HEARTBEAT_STOP => "SDK RX: 停止心跳回复",
            CMD_GET_WIFI_STATUS => "SDK RX: 获取联网状态回复",
            CMD_GET_MAC => "SDK RX: 获取 MAC 回复",
            CMD_NEW_FUNCTION_NOTICE => "SDK RX: 新功能设置回复",
            _ => "SDK RX: 未识别命令",
        },
    }
}

fn sdk_tx_title(command: Option<u8>, language: AppLanguage) -> &'static str {
    if language == AppLanguage::EnUs {
        return match command {
            Some(CMD_HEARTBEAT) => "SDK TX: Heartbeat response",
            Some(CMD_PRODUCT_INFO) => "SDK TX: Product information",
            Some(CMD_WORK_MODE) => "SDK TX: Work mode response",
            Some(CMD_WIFI_STATE) => "SDK TX: Network status ACK",
            Some(CMD_DP_REPORT) => "SDK TX: DP status report",
            Some(CMD_WIFI_RESET) => "SDK TX: Wi-Fi reset",
            Some(CMD_WIFI_SELECT_MODE) => "SDK TX: Wi-Fi mode",
            Some(CMD_QUERY_MEMORY) => "SDK TX: Query memory",
            Some(CMD_GET_GREEN_TIME) => "SDK TX: Get UTC time",
            Some(CMD_QUERY_SIGNAL_STRENGTH) => "SDK TX: Query signal strength",
            Some(CMD_GET_LOCAL_TIME) => "SDK TX: Get local time",
            Some(CMD_HEARTBEAT_STOP) => "SDK TX: Stop heartbeat",
            Some(CMD_GET_WIFI_STATUS) => "SDK TX: Get network status",
            Some(CMD_GET_MAC) => "SDK TX: Get MAC",
            Some(CMD_NEW_FUNCTION_NOTICE) => "SDK TX: New function notification",
            _ => "SDK TX: MCU data",
        };
    }
    match command {
        Some(CMD_HEARTBEAT) => "SDK TX: 心跳回复",
        Some(CMD_PRODUCT_INFO) => "SDK TX: 产品信息",
        Some(CMD_WORK_MODE) => "SDK TX: 工作模式回复",
        Some(CMD_WIFI_STATE) => "SDK TX: 联网状态 ACK",
        Some(CMD_DP_REPORT) => "SDK TX: DP 状态上报",
        Some(CMD_WIFI_RESET) => "SDK TX: Wi-Fi reset",
        Some(CMD_WIFI_SELECT_MODE) => "SDK TX: Wi-Fi mode",
        Some(CMD_QUERY_MEMORY) => "SDK TX: 查询内存",
        Some(CMD_GET_GREEN_TIME) => "SDK TX: 获取格林时间",
        Some(CMD_QUERY_SIGNAL_STRENGTH) => "SDK TX: 查询信号强度",
        Some(CMD_GET_LOCAL_TIME) => "SDK TX: 获取本地时间",
        Some(CMD_HEARTBEAT_STOP) => "SDK TX: 停止心跳",
        Some(CMD_GET_WIFI_STATUS) => "SDK TX: 获取联网状态",
        Some(CMD_GET_MAC) => "SDK TX: 获取 MAC",
        Some(CMD_NEW_FUNCTION_NOTICE) => "SDK TX: 新功能设置通知",
        _ => "SDK TX: MCU 数据",
    }
}

fn enrich_title(base: &str, detail: Option<String>) -> String {
    match detail.map(|text| truncate_detail(text, 180)) {
        Some(detail) if !detail.is_empty() => format!("{base} | {detail}"),
        _ => base.to_string(),
    }
}

fn describe_frame(
    schema: &DpSchema,
    direction: &str,
    command: u8,
    payload: &[u8],
    language: AppLanguage,
) -> Option<String> {
    // 日志解释只基于已经校验通过的完整帧生成，不参与协议应答，避免说明文本影响真实串口行为。
    if language == AppLanguage::EnUs {
        return describe_frame_en(schema, direction, command, payload);
    }
    let description = match command {
        CMD_HEARTBEAT => {
            if direction == "rx" {
                "模组心跳".to_string()
            } else {
                match payload.first().copied() {
                    Some(0) => "心跳回复：首次=0".to_string(),
                    Some(1) => "心跳回复：正常=1".to_string(),
                    Some(value) => format!("心跳回复：0x{value:02X}"),
                    None => "心跳回复：空 payload".to_string(),
                }
            }
        }
        CMD_PRODUCT_INFO => {
            if direction == "rx" {
                "模组查询产品信息/PID".to_string()
            } else {
                describe_product_info(payload)
            }
        }
        CMD_WORK_MODE => {
            if direction == "rx" {
                "模组查询工作模式".to_string()
            } else if payload.is_empty() {
                "回复空包：未启用 Wi-Fi 自处理模式".to_string()
            } else {
                format!("工作模式回复 payload={}", hex(payload))
            }
        }
        CMD_WIFI_STATE => {
            if direction == "rx" {
                let code = payload.first().copied().unwrap_or(0xff);
                format!(
                    "模组上报网络状态：0x{code:02X} {}",
                    wifi_state_label(code, language)
                )
            } else {
                "联网状态 ACK".to_string()
            }
        }
        CMD_WIFI_RESET => {
            if direction == "rx" {
                "模组确认 Wi-Fi reset".to_string()
            } else {
                "MCU 请求 Wi-Fi 重置".to_string()
            }
        }
        CMD_WIFI_SELECT_MODE => {
            if direction == "rx" {
                "模组确认配网模式设置".to_string()
            } else {
                match payload.first().copied() {
                    Some(0x00) => "MCU 设置 EZ/SmartConfig 配网".to_string(),
                    Some(0x01) => "MCU 设置 AP 配网".to_string(),
                    Some(value) => format!("MCU 设置配网模式 0x{value:02X}"),
                    None => "MCU 设置配网模式：空 payload".to_string(),
                }
            }
        }
        CMD_DP_DOWNLOAD => describe_dp_items(schema, payload, "下发"),
        CMD_DP_REPORT => describe_dp_items(schema, payload, "上报"),
        CMD_QUERY_ALL_DP => {
            if direction == "rx" {
                "模组查询全部 DP 状态".to_string()
            } else {
                describe_dp_items(schema, payload, "全量 DP 上报")
            }
        }
        CMD_QUERY_MEMORY => {
            if direction == "tx" {
                "MCU 查询内存/OTA 包大小".to_string()
            } else {
                describe_query_memory_payload(payload)
            }
        }
        CMD_GET_GREEN_TIME => {
            if direction == "tx" {
                "MCU 获取格林时间".to_string()
            } else {
                describe_time_payload("格林时间", payload, false)
            }
        }
        CMD_QUERY_SIGNAL_STRENGTH => {
            if direction == "tx" {
                "MCU 查询信号强度/Wi-Fi 测试".to_string()
            } else {
                describe_signal_strength_payload(payload)
            }
        }
        CMD_GET_LOCAL_TIME => {
            if direction == "tx" {
                "MCU 获取本地时间".to_string()
            } else {
                describe_time_payload("本地时间", payload, true)
            }
        }
        CMD_HEARTBEAT_STOP => {
            if direction == "tx" {
                "MCU 请求停止心跳".to_string()
            } else {
                "模组确认停止心跳".to_string()
            }
        }
        CMD_GET_WIFI_STATUS => {
            if direction == "tx" {
                "MCU 获取联网状态".to_string()
            } else {
                let code = payload.first().copied().unwrap_or(0xff);
                format!(
                    "获取联网状态回复：0x{code:02X} {}",
                    wifi_state_label(code, language)
                )
            }
        }
        CMD_GET_MAC => {
            if direction == "tx" {
                "MCU 获取 MAC".to_string()
            } else {
                describe_mac_payload(payload)
            }
        }
        CMD_NEW_FUNCTION_NOTICE => {
            if direction == "tx" {
                "MCU 新功能设置通知".to_string()
            } else {
                describe_new_function_payload(payload)
            }
        }
        _ => return None,
    };
    Some(description)
}

fn describe_frame_en(
    schema: &DpSchema,
    direction: &str,
    command: u8,
    payload: &[u8],
) -> Option<String> {
    let tx = direction == "tx";
    let description = match command {
        CMD_HEARTBEAT if !tx => "Module heartbeat".into(),
        CMD_HEARTBEAT => match payload.first().copied() {
            Some(0) => "Heartbeat response: first=0".into(),
            Some(1) => "Heartbeat response: normal=1".into(),
            Some(value) => format!("Heartbeat response: 0x{value:02X}"),
            None => "Heartbeat response: empty payload".into(),
        },
        CMD_PRODUCT_INFO if !tx => "Module queries product information/PID".into(),
        CMD_PRODUCT_INFO => describe_product_info_en(payload),
        CMD_WORK_MODE if !tx => "Module queries work mode".into(),
        CMD_WORK_MODE if payload.is_empty() => {
            "Empty response: Wi-Fi self-processing mode is disabled".into()
        }
        CMD_WORK_MODE => format!("Work mode response payload={}", hex(payload)),
        CMD_WIFI_STATE if !tx => {
            let code = payload.first().copied().unwrap_or(0xff);
            format!(
                "Module reports network status: 0x{code:02X} {}",
                wifi_state_label(code, AppLanguage::EnUs)
            )
        }
        CMD_WIFI_STATE => "Network status ACK".into(),
        CMD_WIFI_RESET if !tx => "Module confirms Wi-Fi reset".into(),
        CMD_WIFI_RESET => "MCU requests Wi-Fi reset".into(),
        CMD_WIFI_SELECT_MODE if !tx => "Module confirms pairing mode".into(),
        CMD_WIFI_SELECT_MODE => match payload.first().copied() {
            Some(0) => "MCU selects EZ/SmartConfig pairing".into(),
            Some(1) => "MCU selects AP pairing".into(),
            Some(value) => format!("MCU selects pairing mode 0x{value:02X}"),
            None => "MCU selects pairing mode: empty payload".into(),
        },
        CMD_DP_DOWNLOAD => describe_dp_items(schema, payload, "Download"),
        CMD_DP_REPORT => describe_dp_items(schema, payload, "Report"),
        CMD_QUERY_ALL_DP if !tx => "Module queries all DP states".into(),
        CMD_QUERY_ALL_DP => describe_dp_items(schema, payload, "Full DP report"),
        CMD_QUERY_MEMORY if tx => "MCU queries memory/OTA packet size".into(),
        CMD_QUERY_MEMORY => describe_query_memory_payload_en(payload),
        CMD_GET_GREEN_TIME if tx => "MCU requests UTC time".into(),
        CMD_GET_GREEN_TIME => describe_time_payload_en("UTC time", payload, false),
        CMD_QUERY_SIGNAL_STRENGTH if tx => "MCU queries signal strength/Wi-Fi test".into(),
        CMD_QUERY_SIGNAL_STRENGTH => describe_signal_strength_payload_en(payload),
        CMD_GET_LOCAL_TIME if tx => "MCU requests local time".into(),
        CMD_GET_LOCAL_TIME => describe_time_payload_en("Local time", payload, true),
        CMD_HEARTBEAT_STOP if tx => "MCU requests heartbeat stop".into(),
        CMD_HEARTBEAT_STOP => "Module confirms heartbeat stop".into(),
        CMD_GET_WIFI_STATUS if tx => "MCU queries network status".into(),
        CMD_GET_WIFI_STATUS => {
            let code = payload.first().copied().unwrap_or(0xff);
            format!(
                "Network status response: 0x{code:02X} {}",
                wifi_state_label(code, AppLanguage::EnUs)
            )
        }
        CMD_GET_MAC if tx => "MCU requests MAC address".into(),
        CMD_GET_MAC => describe_mac_payload_en(payload),
        CMD_NEW_FUNCTION_NOTICE if tx => "MCU sends new function notification".into(),
        CMD_NEW_FUNCTION_NOTICE => describe_new_function_payload_en(payload),
        _ => return None,
    };
    Some(description)
}

fn describe_product_info_en(payload: &[u8]) -> String {
    let Ok(text) = std::str::from_utf8(payload) else {
        return format!("Product information is not UTF-8: payload={}", hex(payload));
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return format!("Product information response: {text}");
    };
    let pid = value
        .get("p")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("-");
    let version = value
        .get("v")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("-");
    let mode = value
        .get("m")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    format!(
        "PID={pid}, MCU version={version}, m={mode} {}",
        match mode {
            0 => "default pairing",
            1 => "low-power pairing",
            2 => "anti-misoperation pairing",
            _ => "custom pairing",
        }
    )
}

fn describe_query_memory_payload_en(payload: &[u8]) -> String {
    if payload.len() == 4 {
        let size = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
        return format!("Memory query response: MemorySize {size} Byte");
    }
    format!("Invalid memory query response: payload={}", hex(payload))
}

fn describe_time_payload_en(name: &str, payload: &[u8], has_weekday: bool) -> String {
    let min_len = if has_weekday { 8 } else { 7 };
    if payload.len() < min_len {
        return format!("{name} response is too short: payload={}", hex(payload));
    }
    if payload[0] != 1 {
        return format!(
            "Failed to get {name}: flag={}, payload={}",
            payload[0],
            hex(payload)
        );
    }
    let year = 2000u16 + payload[1] as u16;
    let base = format!(
        "{name}: {year:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        payload[2], payload[3], payload[4], payload[5], payload[6]
    );
    if has_weekday {
        format!("{base}, weekday {}", payload[7])
    } else {
        base
    }
}

fn describe_signal_strength_payload_en(payload: &[u8]) -> String {
    payload.first().map_or_else(
        || format!("Invalid signal strength response: payload={}", hex(payload)),
        |value| format!("Signal strength response: RSSI {}", *value as i8),
    )
}

fn describe_mac_payload_en(payload: &[u8]) -> String {
    if payload.len() < 7 {
        return format!("Invalid MAC response: payload={}", hex(payload));
    }
    if payload[0] != 0 {
        return format!(
            "Failed to get MAC: flag={}, payload={}",
            payload[0],
            hex(payload)
        );
    }
    let mac = payload[1..7]
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":");
    format!("MAC address: {mac}")
}

fn describe_new_function_payload_en(payload: &[u8]) -> String {
    if payload.len() < 2 {
        return format!("Invalid new function response: payload={}", hex(payload));
    }
    if payload[0] == 0 && payload[1] == 0 {
        "New function notification succeeded: SubCmd 0x00, Result 0".into()
    } else {
        format!(
            "New function response: sub_cmd=0x{:02X}, result=0x{:02X}",
            payload[0], payload[1]
        )
    }
}

fn describe_product_info(payload: &[u8]) -> String {
    let Ok(text) = std::str::from_utf8(payload) else {
        return format!("产品信息回复非 UTF-8: payload={}", hex(payload));
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return format!("产品信息回复: {text}");
    };
    let pid = value
        .get("p")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("-");
    let version = value
        .get("v")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("-");
    let mode = value
        .get("m")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    format!(
        "PID={pid}，MCU版本={version}，m={mode} {}",
        config_mode_hint(mode as u8)
    )
}

fn config_mode_hint(mode: u8) -> &'static str {
    match mode {
        0 => "默认配网",
        1 => "低功耗配网",
        2 => "防误触配网",
        _ => "自定义配网",
    }
}

fn describe_dp_items(schema: &DpSchema, payload: &[u8], verb: &str) -> String {
    let mut index = 0usize;
    let mut parts = Vec::new();
    while index + 4 <= payload.len() {
        let id = payload[index];
        let dp_type = payload[index + 1];
        let len = u16::from_be_bytes([payload[index + 2], payload[index + 3]]) as usize;
        index += 4;
        if index + len > payload.len() {
            parts.push(format!(
                "DP{id} 长度异常，payload={}",
                hex(&payload[index..])
            ));
            break;
        }
        let data = &payload[index..index + len];
        parts.push(describe_one_dp(schema, id, dp_type, data, verb));
        index += len;
    }
    if parts.is_empty() {
        format!("{verb}: 空 payload")
    } else {
        parts.join("；")
    }
}

fn describe_one_dp(schema: &DpSchema, id: u8, dp_type: u8, data: &[u8], verb: &str) -> String {
    let Some(point) = schema.by_id(id) else {
        return format!(
            "{verb} unknown DP={id}，type=0x{dp_type:02X}，payload={}",
            hex(data)
        );
    };
    let value = describe_dp_value(point, data);
    format!("{verb} {} DP={}，value={value}", point.code, point.id)
}

fn describe_dp_value(point: &crate::dp_schema::DpPoint, data: &[u8]) -> String {
    // enum 的协议值是下标，日志优先显示 Debugfile range 文案，方便直接对照 App 面板。
    if point.kind == DpKind::Enum {
        let index = data.first().copied().unwrap_or(0) as usize;
        if let Some(label) = point
            .property
            .get("range")
            .and_then(serde_json::Value::as_array)
            .and_then(|items| items.get(index))
            .and_then(serde_json::Value::as_str)
        {
            return format!("{label}({index})");
        }
        return index.to_string();
    }
    match point.kind {
        DpKind::Raw => hex(data),
        DpKind::String => String::from_utf8_lossy(data).to_string(),
        DpKind::Bool => {
            if data.first().copied().unwrap_or(0) == 0 {
                "false".to_string()
            } else {
                "true".to_string()
            }
        }
        DpKind::Value | DpKind::Bitmap => decode_value(&point.kind, data).to_string(),
        DpKind::Enum => unreachable!(),
    }
}

fn truncate_detail(text: String, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text;
    }
    let mut truncated = text.chars().take(max_chars).collect::<String>();
    truncated.push_str("...");
    truncated
}

fn describe_query_memory_payload(payload: &[u8]) -> String {
    if payload.len() == 4 {
        // 官方助手按 little-endian 显示内存大小，例如 A0 B0 00 00 => 45216 Byte。
        let size = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
        return format!("查询内存回复: MemorySize {size} Byte");
    }
    format!("查询内存回复异常: payload={}", hex(payload))
}

fn describe_time_payload(name: &str, payload: &[u8], has_weekday: bool) -> String {
    let min_len = if has_weekday { 8 } else { 7 };
    if payload.len() < min_len {
        return format!("{name}回复异常: 长度不足，payload={}", hex(payload));
    }
    if payload[0] != 1 {
        return format!(
            "{name}获取失败: 标志位={}, payload={}",
            payload[0],
            hex(payload)
        );
    }
    let year = 2000u16 + payload[1] as u16;
    let base = format!(
        "{name}获取成功: {year:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        payload[2], payload[3], payload[4], payload[5], payload[6]
    );
    if has_weekday {
        format!("{base} 星期{}", payload[7])
    } else {
        base
    }
}

fn describe_signal_strength_payload(payload: &[u8]) -> String {
    if payload.is_empty() {
        return format!("查询信号强度回复异常: 长度不足，payload={}", hex(payload));
    }
    // 官方助手把单字节 RSSI 当作有符号整数显示，例如 C4 => -60。
    let rssi = payload[0] as i8;
    format!("查询信号强度回复: RSSI {rssi}")
}

fn describe_mac_payload(payload: &[u8]) -> String {
    if payload.len() < 7 {
        return format!("获取 MAC 回复异常: 长度不足，payload={}", hex(payload));
    }
    if payload[0] != 0 {
        return format!(
            "获取 MAC 失败: 标志位={}, payload={}",
            payload[0],
            hex(payload)
        );
    }
    let mac = payload[1..7]
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":");
    format!("获取 MAC 成功: {mac}")
}

fn describe_new_function_payload(payload: &[u8]) -> String {
    if payload.len() < 2 {
        return format!("新功能设置回复异常: 长度不足，payload={}", hex(payload));
    }
    if payload[0] == 0x00 && payload[1] == 0x00 {
        "新功能设置通知成功: SubCmd 0x00, Result 0".into()
    } else {
        format!(
            "新功能设置通知回复: sub_cmd=0x{:02X}, result=0x{:02X}",
            payload[0], payload[1]
        )
    }
}

fn emit_log(
    app: &AppHandle,
    direction: &str,
    title: &str,
    command: Option<u8>,
    bytes: &[u8],
    raw: bool,
) {
    let _ = app.emit(
        "serial-log",
        SerialLog {
            direction: direction.to_string(),
            title: title.to_string(),
            command,
            hex: hex(bytes),
            raw,
            timestamp_ms: current_timestamp_ms(),
        },
    );
}

fn emit_no_frame_diagnostic(
    app: &AppHandle,
    raw_bytes_without_frame: usize,
    latest_raw: &[u8],
    last_frame_diagnostic: &mut Instant,
    language: AppLanguage,
) {
    if raw_bytes_without_frame < 96 || last_frame_diagnostic.elapsed() < Duration::from_secs(5) {
        return;
    }
    *last_frame_diagnostic = Instant::now();
    let _ = app.emit(
        "serial-log",
        SerialLog {
            direction: "error".into(),
            title: language
                .text(
                    "收到字节但暂未组成完整校验帧",
                    "Serial bytes received but no complete validated frame yet",
                )
                .into(),
            command: None,
            hex: match language {
                AppLanguage::ZhCn => format!("已连续收到 {raw_bytes_without_frame} 字节，但暂未解析到校验通过的 55 AA 完整帧；可能是半包、前置噪声、坏校验帧、串口被其他程序同时占用，或打开时残留了上一轮半帧。最近 Raw 片段：{}", hex(latest_raw)),
                AppLanguage::EnUs => format!("Received {raw_bytes_without_frame} bytes without a validated 55 AA frame. Possible causes include a partial frame, leading noise, a bad checksum, another serial application, or stale bytes from a previous session. Latest Raw chunk: {}", hex(latest_raw)),
            },
            // 这是协议层诊断，不属于原始流；提示语避免把官方助手已验证的串口误判为接线问题。
            raw: false,
            timestamp_ms: current_timestamp_ms(),
        },
    );
}

fn send_control_frames(
    state: &tauri::State<Arc<AppState>>,
    frames: Vec<SerialOutbound>,
) -> Result<(), AppError> {
    let Some(tx) = state.manual_tx.lock().as_ref().cloned() else {
        return Err(AppError::command_requires_serial(*state.language.lock()));
    };
    for frame in frames {
        tx.send(frame)
            .map_err(|err| AppError::serial_io_failed(err.to_string(), *state.language.lock()))?;
    }
    Ok(())
}

fn build_raw_frame(version: u8, command: u8, payload: &[u8]) -> Vec<u8> {
    let mut raw = Vec::with_capacity(payload.len() + 7);
    raw.extend_from_slice(&[0x55, 0xaa, version, command]);
    raw.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    raw.extend_from_slice(payload);
    let sum = raw.iter().fold(0u8, |acc, value| acc.wrapping_add(*value));
    raw.push(sum);
    raw
}

impl NetworkStatus {
    pub fn unknown(language: AppLanguage) -> Self {
        Self::new(0xff, language)
    }

    pub fn new(code: u8, language: AppLanguage) -> Self {
        Self {
            code,
            label: wifi_state_label(code, language).to_string(),
            updated_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        }
    }
}

fn wifi_state_label(code: u8, language: AppLanguage) -> &'static str {
    match (code, language) {
        (0x00, AppLanguage::ZhCn) => "SmartConfig 配网中",
        (0x00, AppLanguage::EnUs) => "SmartConfig pairing",
        (0x01, AppLanguage::ZhCn) => "AP 配网中",
        (0x01, AppLanguage::EnUs) => "AP pairing",
        (0x02, AppLanguage::ZhCn) => "已配网未连路由",
        (0x02, AppLanguage::EnUs) => "Provisioned, router disconnected",
        (0x03, AppLanguage::ZhCn) => "已连路由",
        (0x03, AppLanguage::EnUs) => "Router connected",
        (0x04, AppLanguage::ZhCn) => "已连云",
        (0x04, AppLanguage::EnUs) => "Cloud connected",
        (0x05, AppLanguage::ZhCn) => "低功耗",
        (0x05, AppLanguage::EnUs) => "Low power",
        (0x06, AppLanguage::ZhCn) => "Smart/AP 共存配网",
        (0x06, AppLanguage::EnUs) => "Smart/AP concurrent pairing",
        (_, AppLanguage::ZhCn) => "未知",
        (_, AppLanguage::EnUs) => "Unknown",
    }
}

fn open_serial_port(
    settings: &SerialSettings,
    language: AppLanguage,
) -> Result<Box<dyn SerialPort>, AppError> {
    let mut port = serialport::new(&settings.port_name, settings.baud_rate)
        // 涂鸦 MCU 通用串口协议按 8N1、无流控工作；显式设置避免不同驱动继承系统默认值。
        .data_bits(DataBits::Eight)
        .parity(Parity::None)
        .stop_bits(StopBits::One)
        .flow_control(FlowControl::None)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|err| {
            AppError::serial_open(
                &settings.port_name,
                settings.baud_rate,
                err.to_string(),
                language,
            )
        })?;

    // 打开后清掉旧工具或上一次会话遗留的半帧；DTR/RTS 设为稳定低电平，避免部分 USB-TTL 驱动打开串口时抖动。
    let _ = port.clear(ClearBuffer::All);
    let _ = port.write_data_terminal_ready(false);
    let _ = port.write_request_to_send(false);
    Ok(port)
}

fn emit_error(app: &AppHandle, error: &AppError) {
    let _ = app.emit("serial-opened", false);
    let _ = app.emit("serial-error", error.clone());
    let _ = app.emit(
        "serial-log",
        SerialLog {
            direction: "error".into(),
            title: error.title.clone(),
            command: None,
            hex: format!(
                "{} | {} | {}",
                error.message, error.suggestion, error.detail
            ),
            raw: false,
            timestamp_ms: current_timestamp_ms(),
        },
    );
}

fn current_timestamp_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

impl AppError {
    pub fn dp_file_failed(path: &str, detail: String, language: AppLanguage) -> Self {
        Self {
            code: "dp_file_failed".into(),
            title: language
                .text("DP 文件加载失败", "Failed to load DP file")
                .into(),
            message: match language {
                AppLanguage::ZhCn => format!("无法加载 DP 文件：{path}"),
                AppLanguage::EnUs => format!("Unable to load DP file: {path}"),
            },
            detail,
            suggestion: language
                .text(
                    "请确认文件路径存在、JSON 格式正确，并重新选择功能点调试文件。",
                    "Verify that the file exists and contains valid JSON, then select it again.",
                )
                .into(),
        }
    }

    pub fn serial_open(port: &str, baud_rate: u32, detail: String, language: AppLanguage) -> Self {
        let lower = detail.to_lowercase();
        if lower.contains("access is denied")
            || lower.contains("permission denied")
            || lower.contains("拒绝访问")
            || lower.contains("被拒绝")
            || lower.contains("busy")
            || lower.contains("占用")
        {
            return Self {
                code: "serial_port_busy".into(),
                title: language.text("串口被占用，无法开始调试", "Serial port is busy").into(),
                message: match language { AppLanguage::ZhCn => format!("串口 {port} 当前不能打开，通常是被其他程序占用。"), AppLanguage::EnUs => format!("Serial port {port} cannot be opened and is probably in use by another application.") },
                detail: format!("port={port}, baud_rate={baud_rate}, error={detail}"),
                suggestion: language.text("请关闭涂鸦官方模组调试助手、其他串口工具，或上一次未退出的本应用后再试。", "Close other serial tools or another running instance of this application and try again.").into(),
            };
        }
        if lower.contains("not found")
            || lower.contains("no such")
            || lower.contains("cannot find")
            || lower.contains("找不到")
            || lower.contains("不存在")
        {
            return Self {
                code: "serial_port_not_found".into(),
                title: language.text("串口不存在或已断开", "Serial port not found or disconnected").into(),
                message: match language { AppLanguage::ZhCn => format!("没有找到串口 {port}，设备可能已拔出或端口号已变化。"), AppLanguage::EnUs => format!("Serial port {port} was not found. The device may be disconnected or its port name may have changed.") },
                detail: format!("port={port}, baud_rate={baud_rate}, error={detail}"),
                suggestion: language.text("请检查 USB-TTL 连接和驱动，点击刷新串口后重新选择。", "Check the USB-TTL adapter and driver, refresh the port list, and select the port again.").into(),
            };
        }
        if lower.contains("permission") || lower.contains("权限") {
            return Self {
                code: "serial_permission_denied".into(),
                title: language
                    .text("没有串口访问权限", "Serial port permission denied")
                    .into(),
                message: match language {
                    AppLanguage::ZhCn => format!("当前系统不允许访问串口 {port}。"),
                    AppLanguage::EnUs => {
                        format!("The operating system denied access to serial port {port}.")
                    }
                },
                detail: format!("port={port}, baud_rate={baud_rate}, error={detail}"),
                suggestion: language
                    .text(
                        "Windows 请检查驱动和管理员权限；macOS 请检查串口设备权限。",
                        "Check the serial driver and operating-system device permissions.",
                    )
                    .into(),
            };
        }
        Self {
            code: "serial_open_failed".into(),
            title: language
                .text("串口打开失败", "Failed to open serial port")
                .into(),
            message: match language {
                AppLanguage::ZhCn => format!("无法打开串口 {port}。"),
                AppLanguage::EnUs => format!("Unable to open serial port {port}."),
            },
            detail: format!("port={port}, baud_rate={baud_rate}, error={detail}"),
            suggestion: language
                .text(
                    "请确认端口、波特率、USB-TTL 接线和驱动状态后重试。",
                    "Verify the port, baud rate, USB-TTL wiring, and driver, then try again.",
                )
                .into(),
        }
    }

    pub fn serial_io_failed(detail: String, language: AppLanguage) -> Self {
        Self {
            code: "serial_io_failed".into(),
            title: language.text("串口读写失败", "Serial I/O failed").into(),
            message: language
                .text(
                    "调试过程中串口读写失败，设备可能被拔出或连接中断。",
                    "Serial I/O failed during debugging. The device may have been disconnected.",
                )
                .into(),
            detail,
            suggestion: language
                .text(
                    "请检查 USB-TTL 连接，关闭串口后重新开始调试。",
                    "Check the USB-TTL connection, close the port, and start debugging again.",
                )
                .into(),
        }
    }

    pub fn command_requires_serial(language: AppLanguage) -> Self {
        Self {
            code: "command_requires_serial".into(),
            title: language.text("请先开始串口调试", "Start serial debugging first").into(),
            message: language.text("当前没有打开的串口连接，无法发送 MCU 主动指令。", "No serial port is open, so the MCU command cannot be sent.").into(),
            detail: "serial runtime is not open".into(),
            suggestion: language.text("请选择串口并点击“开始调试”，连接成功后再执行 Wi-Fi 或相关指令操作。", "Select a serial port, start debugging, and retry the command after the connection opens.").into(),
        }
    }

    pub fn runtime_failed(detail: String, language: AppLanguage) -> Self {
        Self {
            code: "serial_runtime_failed".into(),
            title: language.text("串口运行线程启动失败", "Failed to start serial worker").into(),
            message: language.text("串口已打开，但后台读写线程未能启动。", "The serial port opened, but the background I/O worker could not start.").into(),
            detail,
            suggestion: language.text("请重启应用后再试；如果仍然出现，请把错误详情发给开发人员。", "Restart the application and try again. Include the error details when reporting a persistent issue.").into(),
        }
    }
}

#[cfg(test)]
mod error_tests {
    use super::*;

    #[test]
    fn classifies_busy_serial_error() {
        let err =
            AppError::serial_open("COM3", 9600, "Access is denied.".into(), AppLanguage::ZhCn);
        assert_eq!(err.code, "serial_port_busy");
    }

    #[test]
    fn classifies_missing_serial_error() {
        let err = AppError::serial_open(
            "COM99",
            9600,
            "The system cannot find the file specified.".into(),
            AppLanguage::ZhCn,
        );
        assert_eq!(err.code, "serial_port_not_found");
    }

    #[test]
    fn command_without_serial_has_clear_error() {
        let err = AppError::command_requires_serial(AppLanguage::ZhCn);
        assert_eq!(err.code, "command_requires_serial");
        assert!(err.suggestion.contains("开始调试"));
    }
}

#[cfg(test)]
mod wifi_flow_tests {
    use super::*;
    use crate::dp_schema::DpPoint;
    use serde_json::json;

    #[test]
    fn product_info_uses_debugfile_config_mode() {
        let schema = DpSchema {
            product_key: "pid123".into(),
            profile_name: "debugfile".into(),
            mcu_version: "1.0.0".into(),
            config_mode: 0,
            config_mode_label: "默认配网".into(),
            points: vec![],
        };
        let payload = product_info_payload(&schema, None);
        assert!(payload.contains("\"p\":\"pid123\""));
        assert!(payload.contains("\"v\":\"1.0.0\""));
        assert!(payload.contains("\"m\":0"));
    }

    #[test]
    fn explains_common_wifi_and_product_frames() {
        let schema = DpSchema {
            product_key: "pid123".into(),
            profile_name: "debugfile".into(),
            mcu_version: "1.0.0".into(),
            config_mode: 0,
            config_mode_label: "默认配网".into(),
            points: vec![],
        };
        assert!(
            describe_frame(&schema, "rx", CMD_WIFI_STATE, &[0x00], AppLanguage::ZhCn)
                .unwrap()
                .contains("SmartConfig")
        );
        assert!(
            describe_frame(&schema, "rx", CMD_WIFI_STATE, &[0x04], AppLanguage::ZhCn)
                .unwrap()
                .contains("已连云")
        );
        assert!(
            describe_frame(&schema, "rx", CMD_PRODUCT_INFO, &[], AppLanguage::ZhCn)
                .unwrap()
                .contains("查询产品信息")
        );
        assert!(describe_frame(
            &schema,
            "tx",
            CMD_PRODUCT_INFO,
            br#"{"p":"pid123","v":"1.0.0","m":0}"#,
            AppLanguage::ZhCn,
        )
        .unwrap()
        .contains("PID=pid123"));
        assert!(
            describe_frame(&schema, "tx", CMD_HEARTBEAT, &[0x00], AppLanguage::ZhCn)
                .unwrap()
                .contains("首次=0")
        );
        assert!(
            describe_frame(&schema, "tx", CMD_HEARTBEAT, &[0x01], AppLanguage::ZhCn)
                .unwrap()
                .contains("正常=1")
        );
    }

    #[test]
    fn explains_dp_report_and_unknown_dp() {
        let schema = DpSchema {
            product_key: "pid123".into(),
            profile_name: "debugfile".into(),
            mcu_version: "1.0.0".into(),
            config_mode: 0,
            config_mode_label: "默认配网".into(),
            points: vec![DpPoint {
                id: 106,
                code: "child_lock".into(),
                name: "童锁".into(),
                mode: "rw".into(),
                kind: DpKind::Value,
                default_value: Some(json!(0)),
                property: json!({"type":"value","min":0,"max":1,"step":1}),
            }],
        };
        let known = describe_frame(
            &schema,
            "tx",
            CMD_DP_REPORT,
            &[106, 0x02, 0x00, 0x04, 0, 0, 0, 0],
            AppLanguage::ZhCn,
        )
        .unwrap();
        assert!(known.contains("上报 child_lock DP=106"));
        assert!(known.contains("value=0"));

        let unknown = describe_frame(
            &schema,
            "rx",
            CMD_DP_DOWNLOAD,
            &[9, 0x01, 0x00, 0x01, 1],
            AppLanguage::ZhCn,
        )
        .unwrap();
        assert!(unknown.contains("unknown DP=9"));
    }

    #[test]
    fn product_info_uses_reset_pairing_override_from_attachment() {
        let schema = DpSchema {
            product_key: "pid123".into(),
            profile_name: "debugfile".into(),
            mcu_version: "1.0.0".into(),
            config_mode: 2,
            config_mode_label: "test".into(),
            points: vec![],
        };
        let payload = product_info_payload(&schema, Some(0));
        assert!(payload.contains("\"p\":\"pid123\""));
        assert!(payload.contains("\"m\":0"));
    }

    #[test]
    fn wifi_reset_flow_matches_official_log() {
        let reset = build_frame(CMD_WIFI_RESET, &[]);
        assert_eq!(reset[3], CMD_WIFI_RESET);
        assert_eq!(reset[4..6], [0x00, 0x00]);
        assert_eq!(reset, vec![0x55, 0xaa, 0x03, 0x04, 0x00, 0x00, 0x06]);
    }

    #[test]
    fn ez_mode_frame_is_available_as_separate_action() {
        let reset = build_frame(CMD_WIFI_RESET, &[]);
        let ez = build_frame(CMD_WIFI_SELECT_MODE, &[0x00]);
        assert_eq!(reset[3], CMD_WIFI_RESET);
        assert_eq!(reset[4..6], [0x00, 0x00]);
        assert_eq!(ez[3], CMD_WIFI_SELECT_MODE);
        assert_eq!(ez[6], 0x00);
    }

    #[test]
    fn related_command_frames_match_sdk_commands() {
        let cases = [
            (CMD_QUERY_MEMORY, vec![]),
            (CMD_QUERY_SIGNAL_STRENGTH, vec![]),
            (CMD_GET_GREEN_TIME, vec![]),
            (CMD_GET_LOCAL_TIME, vec![]),
            (CMD_HEARTBEAT_STOP, vec![]),
            (CMD_GET_WIFI_STATUS, vec![]),
            (CMD_GET_MAC, vec![]),
            (CMD_NEW_FUNCTION_NOTICE, {
                let mut payload = vec![0x00];
                payload.extend_from_slice(br#"{"OTAMethod":2,"Abv":1,"Buff":256}"#);
                payload
            }),
        ];

        for (command, payload) in cases {
            let frame = build_frame(command, &payload);
            assert_eq!(frame[2], 0x03);
            assert_eq!(frame[3], command);
            assert_eq!(&frame[6..6 + payload.len()], payload.as_slice());
        }
    }

    #[test]
    fn related_command_frames_match_official_assistant_log() {
        assert_eq!(
            build_frame(CMD_QUERY_MEMORY, &[]),
            vec![0x55, 0xaa, 0x03, 0x0f, 0x00, 0x00, 0x11]
        );
        assert_eq!(
            build_frame(CMD_QUERY_SIGNAL_STRENGTH, &[]),
            vec![0x55, 0xaa, 0x03, 0x24, 0x00, 0x00, 0x26]
        );
        assert_eq!(
            build_frame(CMD_GET_GREEN_TIME, &[]),
            vec![0x55, 0xaa, 0x03, 0x0c, 0x00, 0x00, 0x0e]
        );
        assert_eq!(
            build_frame(CMD_GET_LOCAL_TIME, &[]),
            vec![0x55, 0xaa, 0x03, 0x1c, 0x00, 0x00, 0x1e]
        );
        assert_eq!(
            build_frame(CMD_HEARTBEAT_STOP, &[]),
            vec![0x55, 0xaa, 0x03, 0x25, 0x00, 0x00, 0x27]
        );
        assert_eq!(
            build_frame(CMD_GET_WIFI_STATUS, &[]),
            vec![0x55, 0xaa, 0x03, 0x2b, 0x00, 0x00, 0x2d]
        );
        assert_eq!(
            build_frame(CMD_GET_MAC, &[]),
            vec![0x55, 0xaa, 0x03, 0x2d, 0x00, 0x00, 0x2f]
        );

        let mut new_function_payload = vec![0x00];
        new_function_payload.extend_from_slice(br#"{"OTAMethod":2,"Abv":1,"Buff":256}"#);
        assert_eq!(
            build_frame(CMD_NEW_FUNCTION_NOTICE, &new_function_payload),
            vec![
                0x55, 0xaa, 0x03, 0x37, 0x00, 0x23, 0x00, 0x7b, 0x22, 0x4f, 0x54, 0x41, 0x4d, 0x65,
                0x74, 0x68, 0x6f, 0x64, 0x22, 0x3a, 0x32, 0x2c, 0x22, 0x41, 0x62, 0x76, 0x22, 0x3a,
                0x31, 0x2c, 0x22, 0x42, 0x75, 0x66, 0x66, 0x22, 0x3a, 0x32, 0x35, 0x36, 0x7d, 0x07
            ]
        );
    }

    #[test]
    fn parses_related_command_response_descriptions() {
        assert!(describe_query_memory_payload(&[0xa0, 0xb0, 0x00, 0x00]).contains("45216 Byte"));
        assert!(
            describe_time_payload("格林时间", &[1, 26, 7, 10, 9, 8, 7], false)
                .contains("2026-07-10 09:08:07")
        );
        assert!(
            describe_time_payload("本地时间", &[1, 26, 7, 10, 9, 8, 7, 5], true).contains("星期5")
        );
        assert!(describe_signal_strength_payload(&[0xc4]).contains("RSSI -60"));
        assert!(
            describe_mac_payload(&[0, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff])
                .contains("AA:BB:CC:DD:EE:FF")
        );
        assert!(describe_new_function_payload(&[0, 0]).contains("成功"));
    }
}
