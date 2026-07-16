mod dp_schema;
mod dp_simulator;
mod language;
mod serial_runtime;
mod timer_script;
mod trigger_rules;
mod tuya_protocol;

use dp_schema::DpSchema;
use dp_simulator::{DpPatch, DpSimulator};
use language::AppLanguage;
use parking_lot::Mutex;
use serde::Serialize;
use serial_runtime::{AppError, NetworkStatus, SerialOutbound, SerialRuntime, SerialSettings};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use timer_script::{TimerScriptRequest, TimerScriptResponse};
use trigger_rules::{
    collect_rule_errors, generate_run, DueTriggerRun, TriggerDownload, TriggerEngine, TriggerRule,
    TriggerRuntimeState,
};
use tuya_protocol::{
    CMD_GET_GREEN_TIME, CMD_GET_LOCAL_TIME, CMD_GET_MAC, CMD_GET_WIFI_STATUS, CMD_HEARTBEAT_STOP,
    CMD_NEW_FUNCTION_NOTICE, CMD_QUERY_MEMORY, CMD_QUERY_SIGNAL_STRENGTH,
};

struct AppState {
    schema: Mutex<Option<DpSchema>>,
    simulator: Mutex<DpSimulator>,
    dp_file_path: Mutex<Option<String>>,
    serial: Mutex<Option<SerialRuntime>>,
    manual_tx: Mutex<Option<std::sync::mpsc::Sender<SerialOutbound>>>,
    network: Mutex<NetworkStatus>,
    language: Mutex<AppLanguage>,
    trigger_engine: Mutex<TriggerEngine>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            // 默认不加载任何设备配置，避免启动后误以为已经选择了某个产品的 Debugfile。
            schema: Mutex::new(None),
            simulator: Mutex::new(DpSimulator::default()),
            dp_file_path: Mutex::new(None),
            serial: Mutex::new(None),
            manual_tx: Mutex::new(None),
            network: Mutex::new(NetworkStatus::unknown(AppLanguage::default())),
            language: Mutex::new(AppLanguage::default()),
            trigger_engine: Mutex::new(TriggerEngine::default()),
        }
    }
}

#[tauri::command]
fn set_app_language(
    language: AppLanguage,
    app: tauri::AppHandle,
    state: tauri::State<Arc<AppState>>,
) {
    // 后端日志在生成时读取语言；历史日志保持原文，避免切换语言后改变已有调试证据。
    *state.language.lock() = language;
    let code = state.network.lock().code;
    let network = NetworkStatus::new(code, language);
    *state.network.lock() = network.clone();
    let _ = app.emit("network-status", network);
}

#[derive(Serialize)]
struct BootstrapState {
    schema: Option<DpSchema>,
    values: serde_json::Value,
    network: NetworkStatus,
    dp_file_path: Option<String>,
}

#[tauri::command]
fn load_dp_file(
    path: String,
    state: tauri::State<Arc<AppState>>,
) -> Result<BootstrapState, AppError> {
    let canonical_path = PathBuf::from(path.clone())
        .canonicalize()
        .map_err(|err| AppError::dp_file_failed(&path, err.to_string(), *state.language.lock()))?;
    let display_path = path_for_display(&canonical_path);
    let schema = DpSchema::from_path(canonical_path)
        .map_err(|err| AppError::dp_file_failed(&path, err.to_string(), *state.language.lock()))?;
    let simulator = DpSimulator::with_schema(&schema);
    *state.schema.lock() = Some(schema.clone());
    *state.simulator.lock() = simulator;
    // Debugfile 切换后旧规则的 DP 定义可能失效，关闭总开关并清空所有待执行序列。
    state.trigger_engine.lock().set_master(false);
    // Debugfile 是当前设备配置的唯一来源，保存完整路径用于界面展示和排查。
    *state.dp_file_path.lock() = Some(display_path.clone());
    let sim = state.simulator.lock();
    Ok(BootstrapState {
        schema: Some(schema),
        values: sim.values_json(),
        network: state.network.lock().clone(),
        dp_file_path: Some(display_path),
    })
}

fn path_for_display(path: &Path) -> String {
    let raw = path.display().to_string();
    // Windows canonicalize 会添加扩展路径前缀；文件访问保留 PathBuf，界面只展示常规路径。
    #[cfg(windows)]
    {
        normalize_windows_display_path(&raw)
    }
    #[cfg(not(windows))]
    {
        raw
    }
}

#[cfg(any(windows, test))]
fn normalize_windows_display_path(path: &str) -> String {
    if let Some(unc_path) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc_path}");
    }
    path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
}

#[tauri::command]
fn get_state(state: tauri::State<Arc<AppState>>) -> BootstrapState {
    let sim = state.simulator.lock();
    BootstrapState {
        schema: state.schema.lock().clone(),
        values: sim.values_json(),
        network: state.network.lock().clone(),
        dp_file_path: state.dp_file_path.lock().clone(),
    }
}

#[tauri::command]
fn list_serial_ports() -> Result<Vec<String>, String> {
    serialport::available_ports()
        .map(|ports| ports.into_iter().map(|port| port.port_name).collect())
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn start_serial(
    settings: SerialSettings,
    app: tauri::AppHandle,
    state: tauri::State<Arc<AppState>>,
) -> Result<(), AppError> {
    let language = *state.language.lock();
    let schema = state.schema.lock().clone().ok_or_else(|| AppError {
        code: "dp_file_required".into(),
        title: language
            .text("请先加载 DP 文件", "Load a DP file first")
            .into(),
        message: language
            .text(
                "开始串口调试前需要先加载涂鸦功能点调试文件。",
                "Load a Tuya Debugfile before starting serial debugging.",
            )
            .into(),
        detail: "schema is empty".into(),
        suggestion: language
            .text(
                "请点击“加载”或“浏览”选择 Debugfile JSON 后再开始调试。",
                "Select a Debugfile JSON and try again.",
            )
            .into(),
    })?;
    let runtime = SerialRuntime::start(settings, app, state.inner().clone(), schema, language)?;
    *state.manual_tx.lock() = Some(runtime.sender());
    *state.serial.lock() = Some(runtime);
    Ok(())
}

#[tauri::command]
fn stop_serial(state: tauri::State<Arc<AppState>>) {
    stop_serial_runtime(state.inner());
}

fn stop_serial_runtime(state: &Arc<AppState>) {
    if let Some(mut runtime) = state.serial.lock().take() {
        runtime.stop();
    }
    *state.manual_tx.lock() = None;
    state.trigger_engine.lock().clear_schedule();
}

fn emit_trigger_state(app: &tauri::AppHandle, state: &Arc<AppState>) {
    let _ = app.emit("trigger-rule-state", state.trigger_engine.lock().state());
}

#[tauri::command]
fn set_trigger_rules(
    rules: Vec<TriggerRule>,
    app: tauri::AppHandle,
    state: tauri::State<Arc<AppState>>,
) -> Result<TriggerRuntimeState, AppError> {
    let language = *state.language.lock();
    let schema = state.schema.lock().clone().ok_or_else(|| AppError {
        code: "dp_file_required".into(),
        title: language
            .text("请先加载 DP 文件", "Load a DP file first")
            .into(),
        message: language
            .text(
                "触发规则需要当前 Debugfile 的 DP 定义。",
                "Trigger rules require a loaded Debugfile.",
            )
            .into(),
        detail: "schema is empty".into(),
        suggestion: language
            .text("请先加载 Debugfile JSON。", "Load a Debugfile JSON first.")
            .into(),
    })?;
    let errors = collect_rule_errors(&rules, &schema);
    let runtime = {
        let mut engine = state.trigger_engine.lock();
        engine.set_rules_with_errors(rules, errors);
        engine.state()
    };
    let _ = app.emit("trigger-rule-state", runtime.clone());
    Ok(runtime)
}

#[tauri::command]
fn update_trigger_rules(
    rules: Vec<TriggerRule>,
    changed_rule_ids: Vec<String>,
    app: tauri::AppHandle,
    state: tauri::State<Arc<AppState>>,
) -> Result<TriggerRuntimeState, AppError> {
    let language = *state.language.lock();
    let schema = state.schema.lock().clone().ok_or_else(|| AppError {
        code: "dp_file_required".into(),
        title: language
            .text("请先加载 DP 文件", "Load a DP file first")
            .into(),
        message: language
            .text(
                "触发规则热更新需要当前 Debugfile 的 DP 定义。",
                "Trigger rule hot updates require a loaded Debugfile.",
            )
            .into(),
        detail: "schema is empty".into(),
        suggestion: language
            .text("请先加载 Debugfile JSON。", "Load a Debugfile JSON first.")
            .into(),
    })?;
    let errors = collect_rule_errors(&rules, &schema);
    let runtime = {
        let mut engine = state.trigger_engine.lock();
        engine.update_rules(rules, errors, &changed_rule_ids);
        engine.state()
    };
    let _ = app.emit("trigger-rule-state", runtime.clone());
    Ok(runtime)
}

#[tauri::command]
fn set_trigger_master(
    enabled: bool,
    app: tauri::AppHandle,
    state: tauri::State<Arc<AppState>>,
) -> TriggerRuntimeState {
    let runtime = {
        let mut engine = state.trigger_engine.lock();
        engine.set_master(enabled);
        engine.state()
    };
    let _ = app.emit("trigger-rule-state", runtime.clone());
    runtime
}

#[tauri::command]
fn get_trigger_runtime_state(state: tauri::State<Arc<AppState>>) -> TriggerRuntimeState {
    state.trigger_engine.lock().state()
}

#[tauri::command]
fn cancel_trigger_sequence(
    sequence_group: String,
    app: tauri::AppHandle,
    state: tauri::State<Arc<AppState>>,
) -> usize {
    let count = state.trigger_engine.lock().cancel_group(&sequence_group);
    emit_trigger_state(&app, state.inner());
    count
}

#[tauri::command]
fn preview_trigger_rule(
    mut rule: TriggerRule,
    trigger_value: serde_json::Value,
    state: tauri::State<Arc<AppState>>,
) -> Result<trigger_rules::GeneratedTriggerRun, AppError> {
    let language = *state.language.lock();
    let schema = state.schema.lock().clone().ok_or_else(|| AppError {
        code: "dp_file_required".into(),
        title: language
            .text("请先加载 DP 文件", "Load a DP file first")
            .into(),
        message: language
            .text(
                "预览触发规则需要 Debugfile。",
                "Rule preview requires a Debugfile.",
            )
            .into(),
        detail: "schema is empty".into(),
        suggestion: language
            .text("请先加载 Debugfile JSON。", "Load a Debugfile JSON first.")
            .into(),
    })?;
    rule.enabled = true;
    trigger_rules::validate_rules(std::slice::from_ref(&rule), &schema).map_err(|detail| {
        AppError {
            code: "trigger_rule_invalid".into(),
            title: language
                .text("触发规则配置无效", "Invalid trigger rule")
                .into(),
            message: language
                .text("无法生成预览。", "The preview could not be generated.")
                .into(),
            detail,
            suggestion: language
                .text("请检查规则必填项。", "Check the required rule fields.")
                .into(),
        }
    })?;
    let point = schema.by_code(&rule.trigger_code).ok_or_else(|| AppError {
        code: "trigger_dp_unknown".into(),
        title: language.text("触发 DP 不存在", "Unknown trigger DP").into(),
        message: rule.trigger_code.clone(),
        detail: "trigger code not found".into(),
        suggestion: language
            .text("请重新选择触发 DP。", "Select the trigger DP again.")
            .into(),
    })?;
    let now = trigger_rules::now_ms();
    let due = DueTriggerRun {
        rule,
        trigger: TriggerDownload {
            id: point.id,
            code: point.code.clone(),
            value: trigger_value,
            received_at_ms: now,
            frame_index: 0,
        },
        sequence: None,
        instance_id: None,
    };
    generate_run(
        &due,
        &schema,
        state.simulator.lock().values_json(),
        state.network.lock().clone(),
        language,
        true,
    )
    .map_err(|detail| AppError {
        code: "trigger_preview_failed".into(),
        title: language
            .text("触发规则预览失败", "Trigger rule preview failed")
            .into(),
        message: language
            .text(
                "规则没有生成有效上报数据。",
                "The rule did not generate valid report data.",
            )
            .into(),
        detail,
        suggestion: language
            .text(
                "请检查匹配值、输出 DP 和脚本。",
                "Check the match value, output DPs, and script.",
            )
            .into(),
    })
}

#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    window.hide().map_err(|err| err.to_string())
}

#[tauri::command]
fn exit_application(app: tauri::AppHandle, state: tauri::State<Arc<AppState>>) {
    // 托盘退出和首次关闭弹窗共用清理入口，必须先停止串口线程，确保 COM 口立即释放。
    stop_serial_runtime(state.inner());
    app.exit(0);
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn wifi_reset(state: tauri::State<Arc<AppState>>) -> Result<(), AppError> {
    SerialRuntime::send_wifi_reset(&state)
}

#[tauri::command]
fn set_wifi_mode(mode: u8, state: tauri::State<Arc<AppState>>) -> Result<(), AppError> {
    let language = *state.language.lock();
    if !matches!(mode, 0x00 | 0x01) {
        return Err(AppError {
            code: "invalid_wifi_mode".into(),
            title: language
                .text("Wi-Fi 配网模式无效", "Invalid Wi-Fi pairing mode")
                .into(),
            message: language
                .text(
                    "Wi-Fi 配网模式只支持 EZ/SmartConfig 或 AP。",
                    "Only EZ/SmartConfig and AP pairing modes are supported.",
                )
                .into(),
            detail: format!("mode={mode}"),
            suggestion: language
                .text(
                    "请使用界面上的 EZ 或 AP 按钮发送配网模式。",
                    "Use the EZ or AP button in the application.",
                )
                .into(),
        });
    }
    SerialRuntime::send_wifi_mode(&state, mode)
}

#[tauri::command]
fn query_memory(state: tauri::State<Arc<AppState>>) -> Result<(), AppError> {
    // 对齐官方助手“相关指令”日志：查询内存使用 0x0F 空包，而不是 OTA 升级开始命令。
    let title = state.language.lock().text("查询内存", "Query memory");
    SerialRuntime::send_basic_command(&state, CMD_QUERY_MEMORY, Vec::new(), title)
}

#[tauri::command]
fn query_signal_strength(state: tauri::State<Arc<AppState>>) -> Result<(), AppError> {
    SerialRuntime::send_basic_command(
        &state,
        CMD_QUERY_SIGNAL_STRENGTH,
        Vec::new(),
        state
            .language
            .lock()
            .text("查询信号强度", "Query signal strength"),
    )
}

#[tauri::command]
fn get_green_time(state: tauri::State<Arc<AppState>>) -> Result<(), AppError> {
    let title = state.language.lock().text("获取格林时间", "Get UTC time");
    SerialRuntime::send_basic_command(&state, CMD_GET_GREEN_TIME, Vec::new(), title)
}

#[tauri::command]
fn get_local_time(state: tauri::State<Arc<AppState>>) -> Result<(), AppError> {
    let title = state.language.lock().text("获取本地时间", "Get local time");
    SerialRuntime::send_basic_command(&state, CMD_GET_LOCAL_TIME, Vec::new(), title)
}

#[tauri::command]
fn stop_heartbeat(state: tauri::State<Arc<AppState>>) -> Result<(), AppError> {
    let title = state.language.lock().text("停止心跳", "Stop heartbeat");
    SerialRuntime::send_basic_command(&state, CMD_HEARTBEAT_STOP, Vec::new(), title)
}

#[tauri::command]
fn get_wifi_status(state: tauri::State<Arc<AppState>>) -> Result<(), AppError> {
    let title = state
        .language
        .lock()
        .text("获取联网状态", "Get network status");
    SerialRuntime::send_basic_command(&state, CMD_GET_WIFI_STATUS, Vec::new(), title)
}

#[tauri::command]
fn get_mac(state: tauri::State<Arc<AppState>>) -> Result<(), AppError> {
    let title = state.language.lock().text("获取 MAC", "Get MAC");
    SerialRuntime::send_basic_command(&state, CMD_GET_MAC, Vec::new(), title)
}

#[tauri::command]
fn send_new_function_notice(state: tauri::State<Arc<AppState>>) -> Result<(), AppError> {
    let mut payload = vec![0x00];
    payload.extend_from_slice(br#"{"OTAMethod":2,"Abv":1,"Buff":256}"#);
    // 官方助手相关指令使用 0x37，新功能子命令 0x00 后跟 OTA 能力 JSON。
    let title = state
        .language
        .lock()
        .text("新功能设置通知", "New function notification");
    SerialRuntime::send_basic_command(&state, CMD_NEW_FUNCTION_NOTICE, payload, title)
}

#[tauri::command]
fn set_dp_value(
    patch: DpPatch,
    app: tauri::AppHandle,
    state: tauri::State<Arc<AppState>>,
) -> Result<(), AppError> {
    let language = *state.language.lock();
    let schema = state.schema.lock().clone().ok_or_else(|| AppError {
        code: "dp_file_required".into(),
        title: language
            .text("请先加载 DP 文件", "Load a DP file first")
            .into(),
        message: language
            .text(
                "没有 DP 定义，无法编码并上报功能点。",
                "No DP definitions are loaded, so the value cannot be encoded or reported.",
            )
            .into(),
        detail: "schema is empty".into(),
        suggestion: language
            .text("请先加载 Debugfile JSON。", "Load a Debugfile JSON first.")
            .into(),
    })?;
    let reports = state.simulator.lock().apply_user_patch(patch, &schema);
    SerialRuntime::send_reports_if_open(&state, &schema, reports)
        .map_err(|detail| AppError::serial_io_failed(detail, *state.language.lock()))?;
    let sim = state.simulator.lock();
    let _ = app.emit("sim-state", sim.values_json());
    Ok(())
}

#[tauri::command]
fn report_dp_batch(
    patches: Vec<DpPatch>,
    title: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<Arc<AppState>>,
) -> Result<(), AppError> {
    let language = *state.language.lock();
    let schema = state.schema.lock().clone().ok_or_else(|| AppError {
        code: "dp_file_required".into(),
        title: language
            .text("请先加载 DP 文件", "Load a DP file first")
            .into(),
        message: language
            .text(
                "定时上报需要先加载涂鸦功能点调试文件。",
                "Scheduled reports require a loaded Debugfile.",
            )
            .into(),
        detail: "schema is empty".into(),
        suggestion: language
            .text(
                "请先加载 Debugfile JSON，再启动定时上报任务。",
                "Load a Debugfile JSON before starting the scheduled task.",
            )
            .into(),
    })?;
    if state.serial.lock().is_none() {
        return Err(AppError {
            code: "command_requires_serial".into(),
            title: language
                .text("请先开始串口调试", "Start serial debugging first")
                .into(),
            message: language
                .text(
                    "定时上报需要通过已打开的串口发送 DP 数据。",
                    "Scheduled reports require an open serial port.",
                )
                .into(),
            detail: "serial runtime is not open".into(),
            suggestion: language
                .text(
                    "请选择串口并点击“开始调试”，连接成功后再启动定时上报任务。",
                    "Select a serial port and start debugging before starting the scheduled task.",
                )
                .into(),
        });
    }
    // 定时任务可能一次上报多个 DP，这里统一保存状态并合并成同一个 0x07 上报帧。
    let reports = state.simulator.lock().apply_user_patches(patches, &schema);
    let report_title = title.unwrap_or_else(|| "timed DP report".into());
    SerialRuntime::send_reports_with_title(&state, reports, &report_title)
        .map_err(|detail| AppError::serial_io_failed(detail, language))?;
    let sim = state.simulator.lock();
    let _ = app.emit("sim-state", sim.values_json());
    Ok(())
}

#[tauri::command]
fn execute_timer_script(
    request: TimerScriptRequest,
    state: tauri::State<Arc<AppState>>,
) -> Result<TimerScriptResponse, AppError> {
    let language = *state.language.lock();
    let schema = state.schema.lock().clone().ok_or_else(|| AppError {
        code: "dp_file_required".into(),
        title: language
            .text("请先加载 DP 文件", "Load a DP file first")
            .into(),
        message: language
            .text(
                "脚本生成上报数据前需要加载 Debugfile。",
                "Load a Debugfile before generating script reports.",
            )
            .into(),
        detail: "schema is empty".into(),
        suggestion: language
            .text("请先加载 Debugfile JSON。", "Load a Debugfile JSON first.")
            .into(),
    })?;
    let values = state.simulator.lock().values_json();
    let network = state.network.lock().clone();
    timer_script::execute(request, &schema, values, network, language)
}

#[tauri::command]
fn save_log_file(
    path: String,
    content: String,
    state: tauri::State<Arc<AppState>>,
) -> Result<(), AppError> {
    // 保存路径来自系统“另存为”对话框；这里只做文件写入并保留系统错误，便于定位目录权限问题。
    let language = *state.language.lock();
    fs::write(&path, content).map_err(|err| AppError {
        code: "log_save_failed".into(),
        title: language
            .text("串口日志保存失败", "Failed to save serial log")
            .into(),
        message: match language {
            AppLanguage::ZhCn => format!("无法保存串口日志到：{path}"),
            AppLanguage::EnUs => format!("Unable to save the serial log to: {path}"),
        },
        detail: err.to_string(),
        suggestion: language
            .text(
                "请确认目标目录存在且当前用户有写入权限，或换一个目录重新保存。",
                "Verify the destination directory and write permission, or choose another folder.",
            )
            .into(),
    })
}

#[tauri::command]
fn load_text_file(path: String, state: tauri::State<Arc<AppState>>) -> Result<String, AppError> {
    // 导入定时任务配置只读取用户通过文件对话框选择的 JSON 文本，错误保留系统详情便于定位权限/路径问题。
    let language = *state.language.lock();
    fs::read_to_string(&path).map_err(|err| AppError {
        code: "file_read_failed".into(),
        title: language.text("文件读取失败", "Failed to read file").into(),
        message: match language {
            AppLanguage::ZhCn => format!("无法读取文件：{path}"),
            AppLanguage::EnUs => format!("Unable to read file: {path}"),
        },
        detail: err.to_string(),
        suggestion: language
            .text(
                "请确认文件存在且当前用户有读取权限，或重新选择一个 JSON 文件。",
                "Verify that the file exists and is readable, or select another JSON file.",
            )
            .into(),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateEnvironment {
    platform: String,
    arch: String,
    install_mode: String,
    can_install_in_app: bool,
}

#[tauri::command]
fn get_update_environment() -> UpdateEnvironment {
    let platform = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    // Linux 只有 AppImage 能由 Tauri updater 原地替换；deb 安装应交给用户或系统包管理器处理。
    let (install_mode, can_install_in_app) =
        if cfg!(target_os = "windows") || cfg!(target_os = "macos") {
            ("native", true)
        } else if cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_some() {
            ("appimage", true)
        } else if cfg!(target_os = "linux") {
            ("deb", false)
        } else {
            ("unknown", false)
        };
    UpdateEnvironment {
        platform,
        arch,
        install_mode: install_mode.into(),
        can_install_in_app,
    }
}

pub fn run() {
    let state = Arc::new(AppState::default());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .setup(|app| {
            // Windows 标题栏左上角图标不总是跟随 bundle.icon，启动时显式设置窗口图标，避免开发模式继续显示旧缓存。
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_icon(tauri::include_image!("icons/128x128.png"));
            }
            #[cfg(target_os = "windows")]
            {
                let show = MenuItem::with_id(app, "show", "显示主窗口 / Show", true, None::<&str>)?;
                let exit = MenuItem::with_id(app, "exit", "退出 / Exit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &exit])?;
                TrayIconBuilder::new()
                    .icon(tauri::include_image!("icons/128x128.png"))
                    .tooltip("Tuya MCU Simulator Assistant")
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => show_main_window(app),
                        "exit" => {
                            // 托盘菜单不经过前端关闭事件，因此在 Rust 中直接执行相同的串口清理。
                            let state = app.state::<Arc<AppState>>();
                            stop_serial_runtime(state.inner());
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_window(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            load_dp_file,
            list_serial_ports,
            start_serial,
            stop_serial,
            wifi_reset,
            set_wifi_mode,
            query_memory,
            query_signal_strength,
            get_green_time,
            get_local_time,
            stop_heartbeat,
            get_wifi_status,
            get_mac,
            send_new_function_notice,
            set_dp_value,
            report_dp_batch,
            execute_timer_script,
            set_trigger_rules,
            update_trigger_rules,
            set_trigger_master,
            get_trigger_runtime_state,
            preview_trigger_rule,
            cancel_trigger_sequence,
            save_log_file,
            load_text_file,
            get_update_environment,
            set_app_language,
            hide_main_window,
            exit_application
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Tuya MCU simulator");
}

pub(crate) fn emit_state(app: &tauri::AppHandle, state: &Arc<AppState>) {
    let sim = state.simulator.lock();
    let _ = app.emit("sim-state", sim.values_json());
    let _ = app.emit("network-status", state.network.lock().clone());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_app_state_has_no_loaded_device_config() {
        let state = AppState::default();
        assert!(state.schema.lock().is_none());
        assert!(state.dp_file_path.lock().is_none());
        assert_eq!(state.simulator.lock().values_json(), serde_json::json!({}));
    }

    #[test]
    fn update_environment_matches_current_package_mode() {
        let environment = get_update_environment();
        assert_eq!(environment.platform, std::env::consts::OS);
        assert_eq!(environment.arch, std::env::consts::ARCH);
        if cfg!(target_os = "windows") || cfg!(target_os = "macos") {
            assert_eq!(environment.install_mode, "native");
            assert!(environment.can_install_in_app);
        }
    }

    #[test]
    fn windows_extended_paths_are_normalized_for_display() {
        assert_eq!(
            normalize_windows_display_path(r"\\?\C:\Users\tester\Downloads\debug.json"),
            r"C:\Users\tester\Downloads\debug.json"
        );
        assert_eq!(
            normalize_windows_display_path(r"\\?\UNC\server\share\debug.json"),
            r"\\server\share\debug.json"
        );
        assert_eq!(
            normalize_windows_display_path(r"C:\Users\tester\debug.json"),
            r"C:\Users\tester\debug.json"
        );
    }
}
