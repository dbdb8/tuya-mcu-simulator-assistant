use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub enum AppLanguage {
    #[default]
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en-US")]
    EnUs,
}

impl AppLanguage {
    pub fn text(self, zh: &'static str, en: &'static str) -> &'static str {
        match self {
            Self::ZhCn => zh,
            Self::EnUs => en,
        }
    }
}
