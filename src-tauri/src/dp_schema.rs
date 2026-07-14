use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DpSchema {
    pub product_key: String,
    pub profile_name: String,
    pub mcu_version: String,
    pub config_mode: u8,
    pub config_mode_label: String,
    pub points: Vec<DpPoint>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DpPoint {
    pub id: u8,
    pub code: String,
    pub name: String,
    pub mode: String,
    pub kind: DpKind,
    pub default_value: Option<Value>,
    pub property: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DpKind {
    Bool,
    Enum,
    Value,
    Bitmap,
    String,
    Raw,
}

#[derive(Deserialize)]
struct DebugFile {
    #[serde(rename = "Pro_Key")]
    product_key: String,
    #[serde(rename = "Dp_Data")]
    dp_data: Vec<DebugDp>,
}

#[derive(Deserialize)]
struct DebugDp {
    id: u8,
    code: String,
    name: String,
    mode: String,
    #[serde(rename = "defaultValue")]
    default_value: Option<String>,
    property: Value,
    #[serde(rename = "subType")]
    sub_type: Option<String>,
}

impl DpSchema {
    pub fn from_path(path: PathBuf) -> Result<Self> {
        let content = fs::read_to_string(&path)
            .with_context(|| format!("读取 DP 调试文件失败: {}", path.display()))?;
        let debug: DebugFile =
            serde_json::from_str(&content).context("解析 DP 调试文件 JSON 失败")?;
        let mut points = debug
            .dp_data
            .into_iter()
            .map(|dp| {
                let raw_kind = dp
                    .property
                    .get("type")
                    .and_then(Value::as_str)
                    .or(dp.sub_type.as_deref())
                    .unwrap_or("string");
                let kind = match raw_kind {
                    "bool" => DpKind::Bool,
                    "enum" => DpKind::Enum,
                    "value" => DpKind::Value,
                    "bitmap" => DpKind::Bitmap,
                    "raw" => DpKind::Raw,
                    _ => DpKind::String,
                };
                DpPoint {
                    id: dp.id,
                    code: dp.code,
                    name: dp.name,
                    mode: dp.mode,
                    default_value: parse_default(dp.default_value, &kind),
                    kind,
                    property: dp.property,
                }
            })
            .collect::<Vec<_>>();
        points.sort_by_key(|point| point.id);
        Ok(Self {
            product_key: debug.product_key,
            profile_name: "debugfile".into(),
            mcu_version: "1.0.0".into(),
            config_mode: 0,
            config_mode_label: "默认配网".into(),
            points,
        })
    }

    pub fn by_id(&self, id: u8) -> Option<&DpPoint> {
        self.points.iter().find(|point| point.id == id)
    }

    pub fn by_code(&self, code: &str) -> Option<&DpPoint> {
        self.points.iter().find(|point| point.code == code)
    }
}

fn parse_default(default_value: Option<String>, kind: &DpKind) -> Option<Value> {
    let text = default_value?;
    if text.is_empty() {
        return None;
    }
    Some(match kind {
        DpKind::Bool => Value::Bool(text == "true" || text == "1"),
        DpKind::Value | DpKind::Bitmap => text
            .parse::<i64>()
            .map(Value::from)
            .unwrap_or(Value::from(0)),
        DpKind::Enum | DpKind::String | DpKind::Raw => Value::String(text),
    })
}

pub fn dp_type(kind: &DpKind) -> u8 {
    match kind {
        DpKind::Raw => 0x00,
        DpKind::Bool => 0x01,
        DpKind::Value => 0x02,
        DpKind::String => 0x03,
        DpKind::Enum => 0x04,
        DpKind::Bitmap => 0x05,
    }
}
