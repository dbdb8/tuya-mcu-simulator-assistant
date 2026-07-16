use crate::dp_schema::{dp_type, DpKind, DpSchema};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DpPatch {
    pub code: String,
    pub value: Value,
}

#[derive(Clone, Debug)]
pub struct DpReport {
    pub id: u8,
    pub kind: DpKind,
    pub value: Value,
    pub enum_range: Vec<String>,
}

#[derive(Debug, Default)]
pub struct DpSimulator {
    values: HashMap<String, Value>,
    pending_events: VecDeque<DpReport>,
}

impl DpSimulator {
    pub fn with_schema(schema: &DpSchema) -> Self {
        let mut sim = Self::default();
        for point in &schema.points {
            let value = point
                .default_value
                .clone()
                .unwrap_or_else(|| default_value(&point.kind, &point.code));
            sim.values.insert(point.code.clone(), value);
        }
        sim
    }

    pub fn values_json(&self) -> Value {
        let mut map = Map::new();
        for (key, value) in &self.values {
            map.insert(key.clone(), value.clone());
        }
        Value::Object(map)
    }

    pub fn apply_user_patch(&mut self, patch: DpPatch, schema: &DpSchema) -> Vec<DpReport> {
        self.apply_dp_code(&patch.code, patch.value, schema)
    }

    pub fn apply_user_patches(
        &mut self,
        patches: Vec<DpPatch>,
        schema: &DpSchema,
    ) -> Vec<DpReport> {
        let mut reports = Vec::new();
        for patch in patches {
            // 定时上报允许一次提交多个 DP；每个 DP 都先写入最新状态，再生成对应上报项。
            reports.extend(self.apply_dp_code(&patch.code, patch.value, schema));
        }
        reports
    }

    pub fn apply_download(&mut self, id: u8, payload: &[u8], schema: &DpSchema) -> Vec<DpReport> {
        let Some(point) = schema.by_id(id) else {
            return Vec::new();
        };
        let value = decode_value(&point.kind, payload);
        let value = if point.kind == DpKind::Enum {
            let index = value.as_u64().unwrap_or(0) as usize;
            enum_range(point)
                .get(index)
                .map(|item| json!(item))
                .unwrap_or(value)
        } else {
            value
        };
        self.apply_dp_code(&point.code, value, schema)
    }

    pub fn all_reports(&self, schema: &DpSchema) -> Vec<DpReport> {
        schema
            .points
            .iter()
            .filter_map(|point| {
                self.values.get(&point.code).map(|value| DpReport {
                    id: point.id,
                    kind: point.kind.clone(),
                    value: value.clone(),
                    enum_range: enum_range(point),
                })
            })
            .collect()
    }

    fn apply_dp_code(&mut self, code: &str, value: Value, schema: &DpSchema) -> Vec<DpReport> {
        self.set(code, value);
        let mut reports = Vec::new();
        if let Some(report) = self.report_by_code(code, schema) {
            reports.push(report);
        }
        // 通用 Debugfile 模式只保存并回报当前 DP，不再内置任何设备业务联动。
        reports.extend(self.pending_events.drain(..));
        reports
    }

    fn report_by_code(&self, code: &str, schema: &DpSchema) -> Option<DpReport> {
        let point = schema.by_code(code)?;
        let value = self.values.get(code)?.clone();
        Some(DpReport {
            id: point.id,
            kind: point.kind.clone(),
            value,
            enum_range: enum_range(point),
        })
    }

    fn set(&mut self, code: &str, value: Value) {
        self.values.insert(code.to_string(), value);
    }
}

pub fn encode_value(kind: &DpKind, value: &Value) -> Vec<u8> {
    match kind {
        DpKind::Bool => vec![if value_as_bool(Some(value)) { 1 } else { 0 }],
        DpKind::Enum => vec![value.as_u64().unwrap_or(0) as u8],
        DpKind::Value | DpKind::Bitmap => {
            (value.as_i64().unwrap_or(0) as u32).to_be_bytes().to_vec()
        }
        DpKind::String => value.as_str().unwrap_or_default().as_bytes().to_vec(),
        DpKind::Raw => {
            if let Some(hex_text) = value.as_str() {
                hex::decode(hex_text).unwrap_or_default()
            } else {
                Vec::new()
            }
        }
    }
}

pub fn encode_report_with_enum(report: &DpReport) -> Vec<u8> {
    let data = if report.kind == DpKind::Enum {
        let index = report
            .value
            .as_str()
            .and_then(|text| report.enum_range.iter().position(|item| item == text))
            .unwrap_or_else(|| report.value.as_u64().unwrap_or(0) as usize);
        vec![index as u8]
    } else {
        encode_value(&report.kind, &report.value)
    };
    let mut payload = vec![report.id, dp_type(&report.kind)];
    payload.extend_from_slice(&(data.len() as u16).to_be_bytes());
    payload.extend_from_slice(&data);
    payload
}

pub fn reports_from_patches(
    patches: &[DpPatch],
    schema: &DpSchema,
) -> Result<Vec<DpReport>, String> {
    patches
        .iter()
        .map(|patch| {
            let point = schema
                .by_code(&patch.code)
                .ok_or_else(|| format!("unknown DP code: {}", patch.code))?;
            Ok(DpReport {
                id: point.id,
                kind: point.kind.clone(),
                value: patch.value.clone(),
                enum_range: enum_range(point),
            })
        })
        .collect()
}

pub fn decode_value(kind: &DpKind, payload: &[u8]) -> Value {
    match kind {
        DpKind::Bool => json!(payload.first().copied().unwrap_or(0) != 0),
        DpKind::Enum => json!(payload.first().copied().unwrap_or(0)),
        DpKind::Value | DpKind::Bitmap => {
            let mut bytes = [0u8; 4];
            let start = 4usize.saturating_sub(payload.len().min(4));
            bytes[start..].copy_from_slice(&payload[payload.len().saturating_sub(4)..]);
            json!(u32::from_be_bytes(bytes))
        }
        DpKind::String => json!(String::from_utf8_lossy(payload).to_string()),
        DpKind::Raw => json!(hex::encode(payload)),
    }
}

fn default_value(kind: &DpKind, code: &str) -> Value {
    let _ = code;
    match kind {
        DpKind::Bool => json!(false),
        DpKind::Value | DpKind::Bitmap => json!(0),
        DpKind::Enum => json!(0),
        DpKind::String => json!(""),
        DpKind::Raw => json!(""),
    }
}

fn enum_range(point: &crate::dp_schema::DpPoint) -> Vec<String> {
    point
        .property
        .get("range")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn value_as_bool(value: Option<&Value>) -> bool {
    value.and_then(Value::as_bool).unwrap_or(false)
}

mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        bytes
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    pub fn decode(text: &str) -> Result<Vec<u8>, ()> {
        let clean = text.replace(' ', "");
        if !clean.len().is_multiple_of(2) {
            return Err(());
        }
        (0..clean.len())
            .step_by(2)
            .map(|idx| u8::from_str_radix(&clean[idx..idx + 2], 16).map_err(|_| ()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dp_schema::{DpPoint, DpSchema};

    fn schema() -> DpSchema {
        DpSchema {
            product_key: "pid".into(),
            profile_name: "test".into(),
            mcu_version: "1.0.0".into(),
            config_mode: 0,
            config_mode_label: "test".into(),
            points: vec![
                DpPoint {
                    id: 1,
                    code: "switch".into(),
                    name: "switch".into(),
                    mode: "rw".into(),
                    kind: DpKind::Bool,
                    default_value: Some(json!(false)),
                    property: json!({"type":"bool"}),
                },
                DpPoint {
                    id: 101,
                    code: "work_status".into(),
                    name: "work status".into(),
                    mode: "ro".into(),
                    kind: DpKind::Enum,
                    default_value: Some(json!("idle")),
                    property: json!({"type":"enum","range":["idle","active","paused","error"]}),
                },
                DpPoint {
                    id: 122,
                    code: "secondary_switch".into(),
                    name: "secondary switch".into(),
                    mode: "rw".into(),
                    kind: DpKind::Bool,
                    default_value: Some(json!(false)),
                    property: json!({"type":"bool"}),
                },
                DpPoint {
                    id: 123,
                    code: "secondary_state".into(),
                    name: "secondary state".into(),
                    mode: "ro".into(),
                    kind: DpKind::Enum,
                    default_value: Some(json!("idle")),
                    property: json!({"type":"enum","range":["idle","running","finished"]}),
                },
                DpPoint {
                    id: 127,
                    code: "remaining_time".into(),
                    name: "remaining time".into(),
                    mode: "ro".into(),
                    kind: DpKind::Value,
                    default_value: Some(json!(0)),
                    property: json!({"type":"value"}),
                },
            ],
        }
    }

    #[test]
    fn user_patch_reports_current_dp_only() {
        let schema = schema();
        let mut sim = DpSimulator::with_schema(&schema);
        let reports = sim.apply_user_patch(
            DpPatch {
                code: "switch".into(),
                value: json!(true),
            },
            &schema,
        );
        assert_eq!(reports.len(), 1);
        assert!(reports
            .iter()
            .any(|report| report.id == 1 && report.value == json!(true)));
    }

    #[test]
    fn enum_report_uses_range_index() {
        let report = DpReport {
            id: 101,
            kind: DpKind::Enum,
            value: json!("active"),
            enum_range: vec!["idle".into(), "active".into()],
        };
        assert_eq!(encode_report_with_enum(&report), vec![101, 4, 0, 1, 1]);
    }

    #[test]
    fn download_saves_latest_dp_value() {
        let schema = schema();
        let mut sim = DpSimulator::with_schema(&schema);
        let reports = sim.apply_download(127, &[0, 0, 0, 1], &schema);
        let values = sim.values_json();

        assert!(reports
            .iter()
            .any(|report| report.id == 127 && report.value == json!(1)));
        assert_eq!(values.get("remaining_time"), Some(&json!(1)));
    }

    #[test]
    fn user_batch_patch_saves_all_latest_values() {
        let schema = schema();
        let mut sim = DpSimulator::with_schema(&schema);
        let reports = sim.apply_user_patches(
            vec![
                DpPatch {
                    code: "switch".into(),
                    value: json!(true),
                },
                DpPatch {
                    code: "remaining_time".into(),
                    value: json!(42),
                },
            ],
            &schema,
        );
        let values = sim.values_json();

        assert_eq!(reports.len(), 2);
        assert_eq!(values.get("switch"), Some(&json!(true)));
        assert_eq!(values.get("remaining_time"), Some(&json!(42)));
    }
}
