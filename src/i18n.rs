//! Interface messages only. Never translate terminal output, paths, identifiers,
//! user-authored names, or commands. English source messages are the fallback.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub enum Language {
    #[serde(rename = "en", alias = "en-US", alias = "en-GB")]
    English,
    #[default]
    #[serde(rename = "zh-CN", alias = "zh-Hans", alias = "zh")]
    SimplifiedChinese,
}

pub const CHINESE: &str = include_str!("../locales/zh-CN.json");

fn messages() -> &'static BTreeMap<String, String> {
    static MESSAGES: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    MESSAGES.get_or_init(|| serde_json::from_str(CHINESE).expect("valid Simplified Chinese catalog"))
}

pub fn translate(language: Language, source: &str, values: &[String]) -> String {
    let template = if language == Language::SimplifiedChinese {
        messages().get(source).map(String::as_str).unwrap_or(source)
    } else {
        source
    };
    // A single pass ensures a user's value containing e.g. "{1}" stays literal.
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        if let Some(end) = rest.find('}')
            && let Ok(index) = rest[1..end].parse::<usize>()
            && let Some(value) = values.get(index)
        {
            out.push_str(value);
            rest = &rest[end + 1..];
        } else {
            out.push('{');
            rest = &rest[1..];
        }
    }
    out.push_str(rest);
    out
}

pub fn tr(source: &str, values: &[String]) -> String {
    translate(crate::settings::get().language, source, values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_and_user_values_are_preserved() {
        assert_eq!(translate(Language::English, "Settings", &[]), "Settings");
        assert_eq!(translate(Language::SimplifiedChinese, "Settings", &[]), "设置");
        assert_eq!(translate(Language::SimplifiedChinese, "unknown key", &[]), "unknown key");
        assert_eq!(translate(Language::English, "{1} / {0}", &["路径 {1}".into(), "β".into()]), "β / 路径 {1}");
        assert_eq!(translate(Language::English, "missing {4}, {name}", &[]), "missing {4}, {name}");
    }

    #[test]
    fn saved_language_roundtrips_and_legacy_settings_load() {
        let legacy: crate::settings::Person = serde_json::from_str("{}").unwrap();
        assert_eq!(legacy.language, Language::SimplifiedChinese);
        for language in [Language::English, Language::SimplifiedChinese] {
            let person = crate::settings::Person { language, ..Default::default() };
            let saved = serde_json::to_string(&person).unwrap();
            let loaded: crate::settings::Person = serde_json::from_str(&saved).unwrap();
            assert_eq!(loaded.language, language);
        }
    }
}
