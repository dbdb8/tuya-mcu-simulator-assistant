use crate::dp_schema::{DpKind, DpPoint, DpSchema};
use crate::dp_simulator::DpPatch;
use crate::language::AppLanguage;
use crate::serial_runtime::{AppError, NetworkStatus};
use rquickjs::{Context, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::{Duration, Instant};

const MAX_SOURCE_BYTES: usize = 64 * 1024;
const MAX_STATE_BYTES: usize = 16 * 1024;
const MAX_REPORTS: usize = 64;
const SCRIPT_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerScriptRequest {
    pub source: String,
    #[serde(default)]
    pub state: Value,
    pub context: TimerScriptContext,
    #[serde(default)]
    pub preview: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerScriptContext {
    pub task_id: String,
    pub task_name: String,
    pub run_index: u64,
    pub now_ms: u64,
    #[serde(default)]
    pub trigger: Option<TriggerScriptContext>,
    #[serde(default)]
    pub sequence: Option<SequenceScriptContext>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerScriptContext {
    pub id: u8,
    pub code: String,
    pub value: Value,
    pub received_at_ms: u64,
    pub frame_index: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceScriptContext {
    pub id: String,
    pub group: String,
    pub run_index: u64,
    pub started_at_ms: u64,
    pub elapsed_ms: u64,
    pub previous_run_at_ms: Option<u64>,
    pub is_first_run: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerScriptResponse {
    pub patches: Vec<DpPatch>,
    pub state: Value,
    pub summary: Option<String>,
    pub skip: bool,
    pub complete: bool,
}

#[derive(Debug, Deserialize)]
struct RawScriptResult {
    #[serde(default)]
    reports: Vec<RawScriptReport>,
    #[serde(default)]
    state: Value,
    summary: Option<String>,
    #[serde(default)]
    skip: bool,
    #[serde(default)]
    complete: bool,
}

#[derive(Debug, Deserialize)]
struct RawScriptReport {
    code: String,
    value: Value,
}

pub fn execute(
    request: TimerScriptRequest,
    schema: &DpSchema,
    values: Value,
    network: NetworkStatus,
    language: AppLanguage,
) -> Result<TimerScriptResponse, AppError> {
    if request.source.len() > MAX_SOURCE_BYTES {
        return Err(script_error(
            language,
            "script_source_too_large",
            "脚本源码过大",
            "Script source is too large",
            format!("source_bytes={}", request.source.len()),
        ));
    }
    ensure_json_size(
        &request.state,
        MAX_STATE_BYTES,
        language,
        "script_state_too_large",
    )?;

    let input = json!({
        "nowMs": request.context.now_ms,
        "nowUnix": request.context.now_ms / 1000,
        "runIndex": request.context.run_index,
        "state": request.state,
        "values": values,
        "schema": schema,
        "network": network,
        "task": {
            "id": request.context.task_id,
            "name": request.context.task_name,
            "runCount": request.context.run_index.saturating_sub(1),
        },
        "trigger": request.context.trigger,
        "sequence": request.context.sequence,
        "preview": request.preview,
    });
    let output = run_quickjs(&request.source, &input).map_err(|detail| {
        script_error(
            language,
            "timer_script_execution_failed",
            "定时脚本执行失败",
            "Scheduled script execution failed",
            detail,
        )
    })?;
    let raw: RawScriptResult = serde_json::from_str(&output).map_err(|err| {
        script_error(
            language,
            "timer_script_result_invalid",
            "脚本返回格式无效",
            "The script returned an invalid result",
            err.to_string(),
        )
    })?;
    ensure_json_size(
        &raw.state,
        MAX_STATE_BYTES,
        language,
        "script_state_too_large",
    )?;
    if raw.reports.len() > MAX_REPORTS {
        return Err(script_error(
            language,
            "timer_script_too_many_reports",
            "脚本返回的 DP 数量过多",
            "The script returned too many DPs",
            format!("reports={}, max={MAX_REPORTS}", raw.reports.len()),
        ));
    }
    if !raw.skip && raw.reports.is_empty() {
        return Err(script_error(
            language,
            "timer_script_empty_reports",
            "脚本没有返回 DP",
            "The script returned no DPs",
            "reports is empty and skip is false".into(),
        ));
    }

    let mut seen = HashSet::new();
    let mut patches = Vec::with_capacity(raw.reports.len());
    for report in raw.reports {
        if !seen.insert(report.code.clone()) {
            return Err(script_error(
                language,
                "timer_script_duplicate_dp",
                "脚本返回了重复 DP",
                "The script returned a duplicate DP",
                format!("code={}", report.code),
            ));
        }
        let point = schema.by_code(&report.code).ok_or_else(|| {
            script_error(
                language,
                "timer_script_unknown_dp",
                "脚本返回了未知 DP",
                "The script returned an unknown DP",
                format!("code={}", report.code),
            )
        })?;
        patches.push(DpPatch {
            code: report.code,
            value: normalize_value(point, report.value, language)?,
        });
    }

    Ok(TimerScriptResponse {
        patches,
        state: raw.state,
        summary: raw.summary.map(|text| text.chars().take(180).collect()),
        skip: raw.skip,
        complete: raw.complete,
    })
}

pub(crate) fn validate_source(source: &str) -> Result<(), String> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(format!(
            "source_bytes={}, max={MAX_SOURCE_BYTES}",
            source.len()
        ));
    }
    let runtime = Runtime::new().map_err(|err| err.to_string())?;
    runtime.set_memory_limit(8 * 1024 * 1024);
    runtime.set_max_stack_size(256 * 1024);
    let context = Context::full(&runtime).map_err(|err| err.to_string())?;
    let program = format!(
        "\"use strict\";\n{source}\nif (typeof generate !== \"function\") throw new Error(\"generate(ctx) is required\");"
    );
    context.with(|ctx| ctx.eval::<(), _>(program).map_err(|err| err.to_string()))
}

fn run_quickjs(source: &str, input: &Value) -> Result<String, String> {
    let runtime = Runtime::new().map_err(|err| err.to_string())?;
    runtime.set_memory_limit(8 * 1024 * 1024);
    runtime.set_max_stack_size(256 * 1024);
    let started = Instant::now();
    runtime.set_interrupt_handler(Some(Box::new(move || started.elapsed() > SCRIPT_TIMEOUT)));
    let context = Context::full(&runtime).map_err(|err| err.to_string())?;
    let input_literal = serde_json::to_string(&input.to_string()).map_err(|err| err.to_string())?;
    let program = format!(
        r#"
"use strict";
const ctx = JSON.parse({input_literal});
function randomInt(min, max) {{
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return low + Math.floor(Math.random() * (high - low + 1));
}}
function randomChoice(values) {{
  if (!Array.isArray(values) || values.length === 0) throw new Error("randomChoice requires values");
  return values[randomInt(0, values.length - 1)];
}}
function clamp(value, min, max) {{ return Math.min(max, Math.max(min, value)); }}
function u16le(value) {{ const n = Number(value) >>> 0; return [n & 255, (n >>> 8) & 255]; }}
function u32le(value) {{ const n = Number(value) >>> 0; return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }}
function concatBytes(...arrays) {{ return arrays.flatMap((item) => Array.from(item)); }}
function crc16Modbus(bytes) {{
  let crc = 0xFFFF;
  for (const byte of bytes) {{
    crc ^= Number(byte) & 255;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? ((crc >>> 1) ^ 0xA001) : (crc >>> 1);
  }}
  return crc & 0xFFFF;
}}
function bytesToHex(bytes) {{ return Array.from(bytes, (byte) => (Number(byte) & 255).toString(16).padStart(2, "0")).join(""); }}
function raw(bytes) {{ return {{ "$raw": Array.from(bytes) }}; }}
function json(value) {{ return {{ "$json": value }}; }}
{source}
if (typeof generate !== "function") throw new Error("generate(ctx) is required");
JSON.stringify(generate(Object.freeze(ctx)));
"#
    );
    context.with(|ctx| {
        ctx.eval::<String, _>(program)
            .map_err(|err| err.to_string())
    })
}

pub(crate) fn normalize_value(
    point: &DpPoint,
    value: Value,
    language: AppLanguage,
) -> Result<Value, AppError> {
    let invalid = |detail: String| {
        script_error(
            language,
            "timer_script_dp_value_invalid",
            "脚本返回的 DP 值无效",
            "The script returned an invalid DP value",
            format!("code={}; {detail}", point.code),
        )
    };
    match point.kind {
        DpKind::Bool => value
            .as_bool()
            .map(Value::Bool)
            .ok_or_else(|| invalid("expected bool".into())),
        DpKind::Value | DpKind::Bitmap => {
            let number = value
                .as_i64()
                .ok_or_else(|| invalid("expected integer".into()))?;
            let min = point.property.get("min").and_then(Value::as_i64);
            let max = point.property.get("max").and_then(Value::as_i64);
            let step = point
                .property
                .get("step")
                .and_then(Value::as_i64)
                .unwrap_or(1)
                .max(1);
            if min.is_some_and(|bound| number < bound) || max.is_some_and(|bound| number > bound) {
                return Err(invalid(format!("value={number}, range={min:?}..={max:?}")));
            }
            if let Some(base) = min {
                if (number - base) % step != 0 {
                    return Err(invalid(format!("value={number}, step={step}")));
                }
            }
            Ok(Value::from(number))
        }
        DpKind::Enum => {
            let range = point
                .property
                .get("range")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if let Some(text) = value.as_str() {
                if range.iter().any(|item| item.as_str() == Some(text)) {
                    return Ok(Value::String(text.into()));
                }
            }
            if let Some(index) = value.as_u64() {
                if let Some(text) = range.get(index as usize).and_then(Value::as_str) {
                    return Ok(Value::String(text.into()));
                }
            }
            Err(invalid(format!("enum value={value}")))
        }
        DpKind::String => {
            let text = if let Some(text) = value.as_str() {
                text.to_string()
            } else if let Some(data) = value.get("$json") {
                serde_json::to_string(data).map_err(|err| invalid(err.to_string()))?
            } else {
                return Err(invalid("expected string or json(value)".into()));
            };
            enforce_max_len(point, text.len(), language)?;
            Ok(Value::String(text))
        }
        DpKind::Raw => {
            let hex = if let Some(text) = value.as_str() {
                normalize_hex(text).ok_or_else(|| invalid("expected even-length hex".into()))?
            } else if let Some(bytes) = value.get("$raw").and_then(Value::as_array) {
                bytes_to_hex(bytes).ok_or_else(|| invalid("raw bytes must be 0..255".into()))?
            } else if let Some(bytes) = value.as_array() {
                bytes_to_hex(bytes).ok_or_else(|| invalid("raw bytes must be 0..255".into()))?
            } else {
                return Err(invalid("expected hex, byte array, or raw(bytes)".into()));
            };
            enforce_max_len(point, hex.len() / 2, language)?;
            Ok(Value::String(hex))
        }
    }
}

fn enforce_max_len(point: &DpPoint, length: usize, language: AppLanguage) -> Result<(), AppError> {
    let max = point
        .property
        .get("maxlen")
        .and_then(Value::as_u64)
        .unwrap_or(255) as usize;
    if length > max {
        return Err(script_error(
            language,
            "timer_script_dp_too_long",
            "脚本返回的 DP 数据过长",
            "The script returned DP data that is too long",
            format!("code={}, bytes={length}, max={max}", point.code),
        ));
    }
    Ok(())
}

fn normalize_hex(text: &str) -> Option<String> {
    let clean: String = text.chars().filter(|ch| !ch.is_whitespace()).collect();
    (!clean.is_empty()
        && clean.len().is_multiple_of(2)
        && clean.chars().all(|ch| ch.is_ascii_hexdigit()))
    .then(|| clean.to_ascii_lowercase())
}

fn bytes_to_hex(bytes: &[Value]) -> Option<String> {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let number = byte.as_u64()?;
        if number > 255 {
            return None;
        }
        output.push_str(&format!("{number:02x}"));
    }
    Some(output)
}

fn ensure_json_size(
    value: &Value,
    max: usize,
    language: AppLanguage,
    code: &str,
) -> Result<(), AppError> {
    let size = serde_json::to_vec(value)
        .map_err(|err| {
            script_error(
                language,
                code,
                "脚本状态无效",
                "Invalid script state",
                err.to_string(),
            )
        })?
        .len();
    if size > max {
        return Err(script_error(
            language,
            code,
            "脚本状态过大",
            "Script state is too large",
            format!("bytes={size}, max={max}"),
        ));
    }
    Ok(())
}

fn script_error(
    language: AppLanguage,
    code: &str,
    zh: &'static str,
    en: &'static str,
    detail: String,
) -> AppError {
    AppError {
        code: code.into(),
        title: language.text(zh, en).into(),
        message: language
            .text(
                "脚本未产生可发送的上报数据。",
                "The script did not produce report data that can be sent.",
            )
            .into(),
        detail,
        suggestion: language
            .text(
                "请检查脚本返回结构、DP 类型和字段范围。",
                "Check the script result, DP types, and field ranges.",
            )
            .into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dp_schema::DpPoint;

    fn schema() -> DpSchema {
        DpSchema {
            product_key: "pid".into(),
            profile_name: "test".into(),
            mcu_version: "1".into(),
            config_mode: 0,
            config_mode_label: "test".into(),
            points: vec![
                DpPoint {
                    id: 1,
                    code: "switch".into(),
                    name: "switch".into(),
                    mode: "rw".into(),
                    kind: DpKind::Bool,
                    default_value: None,
                    property: json!({"type":"bool"}),
                },
                DpPoint {
                    id: 2,
                    code: "level".into(),
                    name: "level".into(),
                    mode: "ro".into(),
                    kind: DpKind::Value,
                    default_value: None,
                    property: json!({"type":"value","min":0,"max":100,"step":5}),
                },
                DpPoint {
                    id: 3,
                    code: "mode".into(),
                    name: "mode".into(),
                    mode: "ro".into(),
                    kind: DpKind::Enum,
                    default_value: None,
                    property: json!({"type":"enum","range":["idle","run"]}),
                },
                DpPoint {
                    id: 4,
                    code: "detail".into(),
                    name: "detail".into(),
                    mode: "ro".into(),
                    kind: DpKind::String,
                    default_value: None,
                    property: json!({"type":"string","maxlen":64}),
                },
                DpPoint {
                    id: 5,
                    code: "packet".into(),
                    name: "packet".into(),
                    mode: "ro".into(),
                    kind: DpKind::Raw,
                    default_value: None,
                    property: json!({"type":"raw","maxlen":16}),
                },
            ],
        }
    }

    fn request(source: &str) -> TimerScriptRequest {
        TimerScriptRequest {
            source: source.into(),
            state: json!({"seq":1}),
            context: TimerScriptContext {
                task_id: "t".into(),
                task_name: "test".into(),
                run_index: 1,
                now_ms: 1_700_000_000_000,
                trigger: None,
                sequence: None,
            },
            preview: false,
        }
    }

    #[test]
    fn generates_multiple_typed_reports_and_state() {
        let result = execute(request(r#"function generate(ctx) { const bytes=[49,50,51,52,53,54,55,56,57]; const crc=crc16Modbus(bytes); return { reports:[{code:'switch',value:true},{code:'level',value:50},{code:'mode',value:1},{code:'detail',value:json({seq:ctx.state.seq})},{code:'packet',value:raw(concatBytes(bytes,u16le(crc)))}], state:{seq:ctx.state.seq+1}, summary:'ok' }; }"#), &schema(), json!({}), NetworkStatus::new(4, AppLanguage::ZhCn), AppLanguage::ZhCn).unwrap();
        assert_eq!(result.patches.len(), 5);
        assert_eq!(result.state, json!({"seq":2}));
        assert_eq!(result.patches[4].value, json!("313233343536373839374b"));
    }

    #[test]
    fn rejects_duplicate_and_out_of_range_dp() {
        let duplicate = execute(request("function generate(){return {reports:[{code:'switch',value:true},{code:'switch',value:false}],state:{}}}"), &schema(), json!({}), NetworkStatus::new(4, AppLanguage::ZhCn), AppLanguage::ZhCn).unwrap_err();
        assert_eq!(duplicate.code, "timer_script_duplicate_dp");
        let range = execute(
            request("function generate(){return {reports:[{code:'level',value:101}],state:{}}}"),
            &schema(),
            json!({}),
            NetworkStatus::new(4, AppLanguage::ZhCn),
            AppLanguage::ZhCn,
        )
        .unwrap_err();
        assert_eq!(range.code, "timer_script_dp_value_invalid");
    }

    #[test]
    fn skip_can_return_no_reports() {
        let result = execute(
            request(
                "function generate(ctx){return {reports:[],state:{seq:ctx.state.seq+1},skip:true}}",
            ),
            &schema(),
            json!({}),
            NetworkStatus::new(4, AppLanguage::ZhCn),
            AppLanguage::ZhCn,
        )
        .unwrap();
        assert!(result.skip);
        assert!(result.patches.is_empty());
    }

    #[test]
    fn interrupts_runaway_script() {
        let error = execute(
            request("function generate(){ while(true){} }"),
            &schema(),
            json!({}),
            NetworkStatus::new(4, AppLanguage::ZhCn),
            AppLanguage::ZhCn,
        )
        .unwrap_err();
        assert_eq!(error.code, "timer_script_execution_failed");
    }

    #[test]
    fn sandbox_exposes_no_external_runtime_apis() {
        let result = execute(
            request(
                "function generate(){return {reports:[],state:{fetch:typeof fetch,process:typeof process,require:typeof require},skip:true}}",
            ),
            &schema(),
            json!({}),
            NetworkStatus::new(4, AppLanguage::ZhCn),
            AppLanguage::ZhCn,
        )
        .unwrap();
        assert_eq!(
            result.state,
            json!({"fetch":"undefined","process":"undefined","require":"undefined"})
        );
    }
}
