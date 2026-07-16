use crate::dp_schema::{DpKind, DpPoint, DpSchema};
use crate::dp_simulator::DpPatch;
use crate::language::AppLanguage;
use crate::serial_runtime::NetworkStatus;
use crate::timer_script::{
    self, SequenceScriptContext, TimerScriptContext, TimerScriptRequest, TriggerScriptContext,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};

const MAX_PENDING_RUNS: usize = 256;
const MAX_SEQUENCES: usize = 64;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerScriptConfig {
    pub api_version: u8,
    pub source: String,
    #[serde(default)]
    pub initial_state: Value,
    #[serde(default)]
    pub state: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerDpItem {
    pub id: String,
    pub dp_code: String,
    #[serde(default = "manual_mode")]
    pub value_mode: String,
    #[serde(default)]
    pub manual_values: String,
    #[serde(default)]
    pub manual_index: usize,
    pub random_min: Option<i64>,
    pub random_max: Option<i64>,
    #[serde(default)]
    pub random_candidates: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerRule {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub group_name: String,
    #[serde(default)]
    pub enabled: bool,
    pub trigger_code: String,
    #[serde(default = "any_match")]
    pub match_mode: String,
    pub match_value: Option<Value>,
    #[serde(default)]
    pub match_values: Vec<Value>,
    pub match_min: Option<f64>,
    pub match_max: Option<f64>,
    #[serde(default = "once_mode")]
    pub execution_mode: String,
    #[serde(default = "fixed_mode")]
    pub delay_mode: String,
    #[serde(default)]
    pub delay_seconds: f64,
    #[serde(default)]
    pub delay_min_seconds: f64,
    #[serde(default)]
    pub delay_max_seconds: f64,
    #[serde(default)]
    pub sequence_group: String,
    #[serde(default = "replace_action")]
    pub sequence_action: String,
    #[serde(default = "fixed_mode")]
    pub interval_mode: String,
    #[serde(default = "one_second")]
    pub interval_seconds: f64,
    #[serde(default = "one_second")]
    pub interval_min_seconds: f64,
    #[serde(default = "one_second")]
    pub interval_max_seconds: f64,
    pub max_runs: Option<u64>,
    pub max_duration_seconds: Option<f64>,
    #[serde(default = "batch_mode")]
    pub report_mode: String,
    #[serde(default = "items_mode")]
    pub generation_mode: String,
    #[serde(default)]
    pub items: Vec<TriggerDpItem>,
    pub script: Option<TriggerScriptConfig>,
    #[serde(default)]
    pub trigger_count: u64,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerDownload {
    pub id: u8,
    pub code: String,
    pub value: Value,
    pub received_at_ms: u64,
    pub frame_index: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerRuntimeState {
    pub master_enabled: bool,
    pub revision: u64,
    pub rules: Vec<TriggerRule>,
    pub rule_errors: HashMap<String, String>,
    pub pending_count: usize,
    pub active_sequences: Vec<TriggerSequenceState>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerSequenceState {
    pub id: String,
    pub rule_id: String,
    pub rule_name: String,
    pub group: String,
    pub run_index: u64,
    pub started_at_ms: u64,
    pub next_run_at_ms: u64,
    pub status: String,
}

#[derive(Clone, Debug)]
struct PendingRun {
    order: u64,
    due_at_ms: u64,
    rule_id: String,
    trigger: TriggerDownload,
}

#[derive(Clone, Debug)]
struct SequenceRun {
    id: String,
    rule_id: String,
    rule_name: String,
    group: String,
    trigger: TriggerDownload,
    started_at_ms: u64,
    previous_run_at_ms: Option<u64>,
    next_run_at_ms: u64,
    run_index: u64,
    order: u64,
}

#[derive(Clone, Debug)]
struct QueuedSequence {
    rule_id: String,
    rule_name: String,
    group: String,
    trigger: TriggerDownload,
    delay_ms: u64,
    order: u64,
}

#[derive(Clone, Debug)]
pub struct DueTriggerRun {
    pub rule: TriggerRule,
    pub trigger: TriggerDownload,
    pub sequence: Option<SequenceScriptContext>,
    pub instance_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedTriggerRun {
    pub patches: Vec<DpPatch>,
    pub next_state: Option<Value>,
    pub next_indices: HashMap<String, usize>,
    pub summary: Option<String>,
    pub skip: bool,
    pub complete: bool,
}

#[derive(Debug, Default)]
pub struct TriggerEngine {
    master_enabled: bool,
    revision: u64,
    rules: Vec<TriggerRule>,
    rule_errors: HashMap<String, String>,
    pending: Vec<PendingRun>,
    active: Vec<SequenceRun>,
    queued: VecDeque<QueuedSequence>,
    next_order: u64,
}

impl TriggerEngine {
    pub fn state(&self) -> TriggerRuntimeState {
        TriggerRuntimeState {
            master_enabled: self.master_enabled,
            revision: self.revision,
            rules: self.rules.clone(),
            rule_errors: self.rule_errors.clone(),
            pending_count: self.pending.len() + self.queued.len(),
            active_sequences: self
                .active
                .iter()
                .map(|sequence| TriggerSequenceState {
                    id: sequence.id.clone(),
                    rule_id: sequence.rule_id.clone(),
                    rule_name: sequence.rule_name.clone(),
                    group: sequence.group.clone(),
                    run_index: sequence.run_index,
                    started_at_ms: sequence.started_at_ms,
                    next_run_at_ms: sequence.next_run_at_ms,
                    status: "running".into(),
                })
                .collect(),
        }
    }

    #[cfg(test)]
    pub fn set_rules(&mut self, rules: Vec<TriggerRule>) {
        self.set_rules_with_errors(rules, HashMap::new());
    }

    pub fn set_rules_with_errors(
        &mut self,
        rules: Vec<TriggerRule>,
        rule_errors: HashMap<String, String>,
    ) {
        self.rules = rules;
        self.rule_errors = rule_errors;
        self.revision = self.revision.wrapping_add(1);
        self.clear_schedule();
    }

    pub fn update_rules(
        &mut self,
        rules: Vec<TriggerRule>,
        rule_errors: HashMap<String, String>,
        changed_rule_ids: &[String],
    ) {
        let next_ids = rules
            .iter()
            .map(|rule| rule.id.as_str())
            .collect::<HashSet<_>>();
        let mut affected = changed_rule_ids.iter().cloned().collect::<HashSet<_>>();
        // 删除规则时前端只会提交新快照，后端需要自行找出消失的 ID 并终止其旧调度。
        affected.extend(
            self.rules
                .iter()
                .filter(|rule| !next_ids.contains(rule.id.as_str()))
                .map(|rule| rule.id.clone()),
        );
        self.cancel_rules(&affected);
        self.rules = rules;
        self.rule_errors = rule_errors;
        self.revision = self.revision.wrapping_add(1);
    }

    pub fn set_master(&mut self, enabled: bool) {
        self.master_enabled = enabled;
        if !enabled {
            self.clear_schedule();
        }
    }

    pub fn clear_schedule(&mut self) {
        self.pending.clear();
        self.active.clear();
        self.queued.clear();
    }

    pub fn cancel_group(&mut self, group: &str) -> usize {
        let before = self.active.len() + self.queued.len();
        self.active.retain(|item| item.group != group);
        self.queued.retain(|item| item.group != group);
        before - self.active.len() - self.queued.len()
    }

    fn cancel_rules(&mut self, rule_ids: &HashSet<String>) -> usize {
        let before = self.pending.len() + self.active.len() + self.queued.len();
        self.pending
            .retain(|item| !rule_ids.contains(&item.rule_id));
        self.active.retain(|item| !rule_ids.contains(&item.rule_id));
        self.queued.retain(|item| !rule_ids.contains(&item.rule_id));
        before - self.pending.len() - self.active.len() - self.queued.len()
    }

    pub fn handle_download(&mut self, trigger: TriggerDownload, now_ms: u64) -> Vec<String> {
        if !self.master_enabled {
            return Vec::new();
        }
        let matched: Vec<TriggerRule> = self
            .rules
            .iter()
            .filter(|rule| {
                rule.enabled
                    && !self.rule_errors.contains_key(&rule.id)
                    && rule.trigger_code == trigger.code
                    && matches_value(rule, &trigger.value)
            })
            .cloned()
            .collect();
        if matched.is_empty() {
            return Vec::new();
        }

        let names = matched.iter().map(|rule| rule.name.clone()).collect();
        for rule in matched {
            let delay_ms = timing_ms(
                &rule.delay_mode,
                rule.delay_seconds,
                rule.delay_min_seconds,
                rule.delay_max_seconds,
            );
            if rule.execution_mode != "sequence" {
                self.push_pending(rule.id.clone(), trigger.clone(), now_ms + delay_ms);
                continue;
            }

            let group = if rule.sequence_group.trim().is_empty() {
                rule.id.clone()
            } else {
                rule.sequence_group.clone()
            };
            if rule.sequence_action == "cancel" {
                self.cancel_group(&group);
                self.push_pending(rule.id.clone(), trigger.clone(), now_ms + delay_ms);
                continue;
            }
            let exists = self.active.iter().any(|item| item.group == group)
                || self.queued.iter().any(|item| item.group == group);
            match rule.sequence_action.as_str() {
                "ignore" if exists => continue,
                "queue" if exists => {
                    if self.active.len() + self.queued.len() < MAX_SEQUENCES {
                        let order = self.take_order();
                        self.queued.push_back(QueuedSequence {
                            rule_id: rule.id.clone(),
                            rule_name: rule.name.clone(),
                            group,
                            trigger: trigger.clone(),
                            delay_ms,
                            order,
                        });
                    }
                    continue;
                }
                "replace" => {
                    self.cancel_group(&group);
                }
                _ => {}
            }
            self.start_sequence(&rule, group, trigger.clone(), now_ms + delay_ms, now_ms);
        }
        names
    }

    pub fn take_due(&mut self, now_ms: u64) -> Option<DueTriggerRun> {
        let pending_index = self
            .pending
            .iter()
            .enumerate()
            .filter(|(_, item)| item.due_at_ms <= now_ms)
            .min_by_key(|(_, item)| (item.due_at_ms, item.order))
            .map(|(index, _)| index);
        let sequence_index = self
            .active
            .iter()
            .enumerate()
            .filter(|(_, item)| item.next_run_at_ms <= now_ms)
            .min_by_key(|(_, item)| (item.next_run_at_ms, item.order))
            .map(|(index, _)| index);

        let choose_pending = match (pending_index, sequence_index) {
            (Some(pending), Some(sequence)) => {
                let p = &self.pending[pending];
                let s = &self.active[sequence];
                (p.due_at_ms, p.order) <= (s.next_run_at_ms, s.order)
            }
            (Some(_), None) => true,
            _ => false,
        };
        if choose_pending {
            let item = self.pending.remove(pending_index?);
            let rule = self
                .rules
                .iter()
                .find(|rule| rule.id == item.rule_id)?
                .clone();
            return Some(DueTriggerRun {
                rule,
                trigger: item.trigger,
                sequence: None,
                instance_id: None,
            });
        }
        let item = self.active.get(sequence_index?)?.clone();
        let rule = self
            .rules
            .iter()
            .find(|rule| rule.id == item.rule_id)?
            .clone();
        Some(DueTriggerRun {
            rule,
            trigger: item.trigger,
            sequence: Some(SequenceScriptContext {
                id: item.id.clone(),
                group: item.group,
                run_index: item.run_index,
                started_at_ms: item.started_at_ms,
                elapsed_ms: now_ms.saturating_sub(item.started_at_ms),
                previous_run_at_ms: item.previous_run_at_ms,
                is_first_run: item.run_index == 0,
            }),
            instance_id: Some(item.id),
        })
    }

    pub fn commit_success(
        &mut self,
        due: &DueTriggerRun,
        generated: &GeneratedTriggerRun,
        now_ms: u64,
    ) {
        if let Some(rule) = self.rules.iter_mut().find(|rule| rule.id == due.rule.id) {
            rule.trigger_count = rule.trigger_count.saturating_add((!generated.skip) as u64);
            rule.last_error = None;
            if let (Some(script), Some(state)) =
                (rule.script.as_mut(), generated.next_state.clone())
            {
                script.state = state;
            }
            for item in &mut rule.items {
                if let Some(index) = generated.next_indices.get(&item.id) {
                    item.manual_index = *index;
                }
            }
        }
        let Some(instance_id) = due.instance_id.as_ref() else {
            return;
        };
        let Some(index) = self.active.iter().position(|item| &item.id == instance_id) else {
            return;
        };
        let run_count = self.active[index].run_index + (!generated.skip) as u64;
        let elapsed = now_ms.saturating_sub(self.active[index].started_at_ms);
        let reached_runs = due.rule.max_runs.is_some_and(|max| run_count >= max);
        let reached_duration = due
            .rule
            .max_duration_seconds
            .is_some_and(|max| elapsed as f64 >= max.max(0.0) * 1000.0);
        if generated.complete || reached_runs || reached_duration {
            let group = self.active.remove(index).group;
            self.start_next_queued(&group, now_ms);
            return;
        }
        let interval = timing_ms(
            &due.rule.interval_mode,
            due.rule.interval_seconds,
            due.rule.interval_min_seconds,
            due.rule.interval_max_seconds,
        )
        .max(1);
        let sequence = &mut self.active[index];
        sequence.run_index = run_count;
        sequence.previous_run_at_ms = Some(now_ms);
        sequence.next_run_at_ms = now_ms + interval;
    }

    pub fn fail_run(&mut self, due: &DueTriggerRun, message: String, now_ms: u64) {
        if let Some(rule) = self.rules.iter_mut().find(|rule| rule.id == due.rule.id) {
            rule.last_error = Some(message);
        }
        if let Some(instance_id) = due.instance_id.as_ref() {
            if let Some(index) = self.active.iter().position(|item| &item.id == instance_id) {
                let group = self.active.remove(index).group;
                self.start_next_queued(&group, now_ms);
            }
        }
    }

    fn push_pending(&mut self, rule_id: String, trigger: TriggerDownload, due_at_ms: u64) {
        if self.pending.len() >= MAX_PENDING_RUNS {
            if let Some(rule) = self.rules.iter_mut().find(|rule| rule.id == rule_id) {
                rule.last_error = Some("trigger pending queue is full".into());
            }
            return;
        }
        let order = self.take_order();
        self.pending.push(PendingRun {
            order,
            due_at_ms,
            rule_id,
            trigger,
        });
    }

    fn start_sequence(
        &mut self,
        rule: &TriggerRule,
        group: String,
        trigger: TriggerDownload,
        due_at_ms: u64,
        started_at_ms: u64,
    ) {
        if self.active.len() + self.queued.len() >= MAX_SEQUENCES {
            return;
        }
        let order = self.take_order();
        self.active.push(SequenceRun {
            id: format!("sequence-{}-{order}", rule.id),
            rule_id: rule.id.clone(),
            rule_name: rule.name.clone(),
            group,
            trigger,
            started_at_ms,
            previous_run_at_ms: None,
            next_run_at_ms: due_at_ms,
            run_index: 0,
            order,
        });
    }

    fn start_next_queued(&mut self, group: &str, now_ms: u64) {
        let Some(index) = self.queued.iter().position(|item| item.group == group) else {
            return;
        };
        let Some(queued) = self.queued.remove(index) else {
            return;
        };
        let Some(rule) = self
            .rules
            .iter()
            .find(|rule| rule.id == queued.rule_id)
            .cloned()
        else {
            return;
        };
        self.active.push(SequenceRun {
            id: format!("sequence-{}-{}", rule.id, queued.order),
            rule_id: rule.id,
            rule_name: queued.rule_name,
            group: queued.group,
            trigger: queued.trigger,
            started_at_ms: now_ms,
            previous_run_at_ms: None,
            next_run_at_ms: now_ms + queued.delay_ms,
            run_index: 0,
            order: queued.order,
        });
    }

    fn take_order(&mut self) -> u64 {
        let order = self.next_order;
        self.next_order = self.next_order.wrapping_add(1);
        order
    }
}

pub fn generate_run(
    due: &DueTriggerRun,
    schema: &DpSchema,
    values: Value,
    network: NetworkStatus,
    language: AppLanguage,
    preview: bool,
) -> Result<GeneratedTriggerRun, String> {
    if due.rule.execution_mode == "sequence"
        && due.rule.sequence_action == "cancel"
        && due.rule.generation_mode == "items"
        && due.rule.items.is_empty()
    {
        // 纯取消规则允许没有输出 DP；它只负责停止同组序列并抑制触发 DP 的默认回报。
        return Ok(GeneratedTriggerRun {
            patches: Vec::new(),
            next_state: None,
            next_indices: HashMap::new(),
            summary: Some("sequence cancelled".into()),
            skip: true,
            complete: true,
        });
    }
    if due.rule.generation_mode == "script" {
        let script = due
            .rule
            .script
            .as_ref()
            .ok_or_else(|| "script configuration is missing".to_string())?;
        let response = timer_script::execute(
            TimerScriptRequest {
                source: script.source.clone(),
                state: script.state.clone(),
                context: TimerScriptContext {
                    task_id: due.rule.id.clone(),
                    task_name: due.rule.name.clone(),
                    run_index: due.rule.trigger_count + 1,
                    now_ms: now_ms(),
                    trigger: Some(TriggerScriptContext {
                        id: due.trigger.id,
                        code: due.trigger.code.clone(),
                        value: due.trigger.value.clone(),
                        received_at_ms: due.trigger.received_at_ms,
                        frame_index: due.trigger.frame_index,
                    }),
                    sequence: due.sequence.clone(),
                },
                preview,
            },
            schema,
            values,
            network,
            language,
        )
        .map_err(|error| format!("{}: {}", error.title, error.detail))?;
        return Ok(GeneratedTriggerRun {
            patches: response.patches,
            next_state: Some(response.state),
            next_indices: HashMap::new(),
            summary: response.summary,
            skip: response.skip,
            complete: response.complete,
        });
    }

    if due.rule.items.is_empty() {
        return Err("trigger rule has no report items".into());
    }
    let mut patches = Vec::new();
    let mut next_indices = HashMap::new();
    let mut seen = HashSet::new();
    for item in &due.rule.items {
        if !seen.insert(item.dp_code.clone()) {
            return Err(format!("duplicate output DP: {}", item.dp_code));
        }
        let point = schema
            .by_code(&item.dp_code)
            .ok_or_else(|| format!("unknown output DP: {}", item.dp_code))?;
        let raw_value = if item.value_mode == "random" {
            random_value(item, point)?
        } else {
            let values = split_values(&item.manual_values);
            if values.is_empty() {
                return Err(format!("{} has no manual values", item.dp_code));
            }
            let index = item.manual_index % values.len();
            next_indices.insert(item.id.clone(), (index + 1) % values.len());
            parse_token(point, &values[index])?
        };
        let value = timer_script::normalize_value(point, raw_value, language)
            .map_err(|error| format!("{}: {}", error.title, error.detail))?;
        patches.push(DpPatch {
            code: item.dp_code.clone(),
            value,
        });
    }
    Ok(GeneratedTriggerRun {
        patches,
        next_state: None,
        next_indices,
        summary: None,
        skip: false,
        complete: false,
    })
}

pub fn validate_rules(rules: &[TriggerRule], schema: &DpSchema) -> Result<(), String> {
    let mut ids = HashSet::new();
    for rule in rules {
        if !ids.insert(&rule.id) {
            return Err(format!("duplicate rule id: {}", rule.id));
        }
        // 未启用规则允许作为草稿保存，开启总开关时只校验真正参与匹配的规则。
        if !rule.enabled {
            continue;
        }
        validate_rule(rule, schema)?;
    }
    Ok(())
}

pub fn collect_rule_errors(rules: &[TriggerRule], schema: &DpSchema) -> HashMap<String, String> {
    let mut errors = HashMap::new();
    let mut counts = HashMap::<&str, usize>::new();
    for rule in rules {
        *counts.entry(rule.id.as_str()).or_default() += 1;
    }
    for rule in rules.iter().filter(|rule| rule.enabled) {
        let error = if counts.get(rule.id.as_str()).copied().unwrap_or(0) > 1 {
            Some(format!("duplicate rule id: {}", rule.id))
        } else {
            validate_rule(rule, schema).err()
        };
        if let Some(error) = error {
            errors.insert(rule.id.clone(), error);
        }
    }
    errors
}

fn validate_rule(rule: &TriggerRule, schema: &DpSchema) -> Result<(), String> {
    let trigger = schema
        .by_code(&rule.trigger_code)
        .ok_or_else(|| format!("unknown trigger DP: {}", rule.trigger_code))?;
    validate_match(rule, trigger)?;
    if rule.execution_mode == "sequence"
        && rule.sequence_action != "cancel"
        && rule.generation_mode != "script"
        && rule.max_runs.is_none()
        && rule.max_duration_seconds.is_none()
    {
        return Err(format!(
            "sequence rule {} requires maxRuns or maxDurationSeconds",
            rule.name
        ));
    }
    if rule.generation_mode == "script" {
        let script = rule
            .script
            .as_ref()
            .ok_or_else(|| format!("{} has no script", rule.name))?;
        if script.api_version != 1 || script.source.trim().is_empty() {
            return Err(format!("{} has invalid script", rule.name));
        }
        timer_script::validate_source(&script.source)
            .map_err(|error| format!("{} script syntax error: {error}", rule.name))?;
    } else if rule.items.is_empty() && rule.sequence_action != "cancel" {
        return Err(format!("{} has no report items", rule.name));
    } else if rule.sequence_action != "cancel" {
        let mut output_codes = HashSet::new();
        for item in &rule.items {
            if !output_codes.insert(item.dp_code.as_str()) {
                return Err(format!("duplicate output DP: {}", item.dp_code));
            }
            let point = schema
                .by_code(&item.dp_code)
                .ok_or_else(|| format!("unknown output DP: {}", item.dp_code))?;
            if item.value_mode == "random" {
                let value = random_value(item, point)?;
                timer_script::normalize_value(point, value, AppLanguage::ZhCn)
                    .map_err(|error| error.detail)?;
            } else {
                let values = split_values(&item.manual_values);
                if values.is_empty() {
                    return Err(format!("{} has no manual values", item.dp_code));
                }
                for token in values {
                    let value = parse_token(point, &token)?;
                    timer_script::normalize_value(point, value, AppLanguage::ZhCn)
                        .map_err(|error| error.detail)?;
                }
            }
        }
    }
    Ok(())
}

fn validate_match(rule: &TriggerRule, point: &DpPoint) -> Result<(), String> {
    match rule.match_mode.as_str() {
        "any" => Ok(()),
        "equals" => rule
            .match_value
            .as_ref()
            .ok_or_else(|| format!("{} requires matchValue", rule.name))
            .and_then(|value| {
                timer_script::normalize_value(point, value.clone(), AppLanguage::ZhCn)
                    .map(|_| ())
                    .map_err(|error| error.detail)
            }),
        "one_of" if !rule.match_values.is_empty() => Ok(()),
        "range" if matches!(point.kind, DpKind::Value | DpKind::Bitmap) => {
            if rule
                .match_min
                .zip(rule.match_max)
                .is_some_and(|(min, max)| min <= max)
            {
                Ok(())
            } else {
                Err(format!("{} has invalid match range", rule.name))
            }
        }
        _ => Err(format!("{} has invalid match condition", rule.name)),
    }
}

fn matches_value(rule: &TriggerRule, value: &Value) -> bool {
    match rule.match_mode.as_str() {
        "any" => true,
        "equals" => rule.match_value.as_ref() == Some(value),
        "one_of" => rule.match_values.iter().any(|item| item == value),
        "range" => value.as_f64().is_some_and(|number| {
            number >= rule.match_min.unwrap_or(f64::MIN)
                && number <= rule.match_max.unwrap_or(f64::MAX)
        }),
        _ => false,
    }
}

fn random_value(item: &TriggerDpItem, point: &DpPoint) -> Result<Value, String> {
    match point.kind {
        DpKind::Bool => Ok(json!(fastrand::bool())),
        DpKind::Enum => {
            let range = point
                .property
                .get("range")
                .and_then(Value::as_array)
                .ok_or_else(|| format!("{} has no enum range", point.code))?;
            let value = range
                .get(fastrand::usize(..range.len()))
                .cloned()
                .ok_or_else(|| format!("{} has empty enum range", point.code))?;
            Ok(value)
        }
        DpKind::Value | DpKind::Bitmap => {
            let min = item
                .random_min
                .or_else(|| point.property.get("min").and_then(Value::as_i64))
                .unwrap_or(0);
            let max = item
                .random_max
                .or_else(|| point.property.get("max").and_then(Value::as_i64))
                .unwrap_or(100);
            let step = point
                .property
                .get("step")
                .and_then(Value::as_i64)
                .unwrap_or(1)
                .max(1);
            if min > max {
                return Err(format!("{} random min is greater than max", point.code));
            }
            let slots = ((max - min) / step).max(0) as usize;
            Ok(json!(min + fastrand::usize(..=slots) as i64 * step))
        }
        DpKind::String => {
            let candidates = split_values(&item.random_candidates);
            if candidates.is_empty() {
                Ok(json!(format!("trigger-{}", fastrand::u32(..))))
            } else {
                Ok(json!(candidates[fastrand::usize(..candidates.len())]))
            }
        }
        DpKind::Raw => {
            let candidates = split_values(&item.random_candidates);
            if candidates.is_empty() {
                Err(format!("{} requires Raw candidates", point.code))
            } else {
                Ok(json!(candidates[fastrand::usize(..candidates.len())]))
            }
        }
    }
}

fn parse_token(point: &DpPoint, token: &str) -> Result<Value, String> {
    match point.kind {
        DpKind::Bool => match token.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "on" | "开" => Ok(json!(true)),
            "false" | "0" | "off" | "关" => Ok(json!(false)),
            _ => Err(format!("{} requires bool", point.code)),
        },
        DpKind::Value | DpKind::Bitmap => token
            .trim()
            .parse::<i64>()
            .map(Value::from)
            .map_err(|_| format!("{} requires integer", point.code)),
        DpKind::Enum => {
            if let Ok(index) = token.trim().parse::<u64>() {
                Ok(Value::from(index))
            } else {
                Ok(Value::String(token.trim().into()))
            }
        }
        DpKind::String | DpKind::Raw => Ok(Value::String(token.trim().into())),
    }
}

fn split_values(text: &str) -> Vec<String> {
    text.lines()
        .flat_map(|line| line.split(','))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn timing_ms(mode: &str, fixed: f64, min: f64, max: f64) -> u64 {
    let seconds = if mode == "random" {
        let low = min.min(max).max(0.0);
        let high = min.max(max).max(0.0);
        if high <= low {
            low
        } else {
            fastrand::f64() * (high - low) + low
        }
    } else {
        fixed.max(0.0)
    };
    (seconds * 1000.0).round() as u64
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn manual_mode() -> String {
    "manual".into()
}
fn any_match() -> String {
    "any".into()
}
fn once_mode() -> String {
    "once".into()
}
fn fixed_mode() -> String {
    "fixed".into()
}
fn replace_action() -> String {
    "replace".into()
}
fn batch_mode() -> String {
    "batch".into()
}
fn items_mode() -> String {
    "items".into()
}
fn one_second() -> f64 {
    1.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dp_schema::DpPoint;

    fn rule(action: &str) -> TriggerRule {
        TriggerRule {
            id: action.into(),
            name: action.into(),
            group_name: "test".into(),
            enabled: true,
            trigger_code: "control".into(),
            match_mode: "equals".into(),
            match_value: Some(json!(action)),
            match_values: Vec::new(),
            match_min: None,
            match_max: None,
            execution_mode: "sequence".into(),
            delay_mode: "fixed".into(),
            delay_seconds: 0.0,
            delay_min_seconds: 0.0,
            delay_max_seconds: 0.0,
            sequence_group: "motion".into(),
            sequence_action: if action == "stop" {
                "cancel"
            } else {
                "replace"
            }
            .into(),
            interval_mode: "fixed".into(),
            interval_seconds: 1.0,
            interval_min_seconds: 1.0,
            interval_max_seconds: 1.0,
            max_runs: Some(3),
            max_duration_seconds: None,
            report_mode: "batch".into(),
            generation_mode: "items".into(),
            items: vec![TriggerDpItem {
                id: "out".into(),
                dp_code: "position".into(),
                value_mode: "manual".into(),
                manual_values: "1,2,3".into(),
                manual_index: 0,
                random_min: None,
                random_max: None,
                random_candidates: String::new(),
            }],
            script: None,
            trigger_count: 0,
            last_error: None,
        }
    }

    fn download(value: &str) -> TriggerDownload {
        TriggerDownload {
            id: 1,
            code: "control".into(),
            value: json!(value),
            received_at_ms: 1000,
            frame_index: 0,
        }
    }

    fn schema() -> DpSchema {
        DpSchema {
            product_key: "pid".into(),
            profile_name: "test".into(),
            mcu_version: "1".into(),
            config_mode: 0,
            config_mode_label: "default".into(),
            points: vec![
                DpPoint {
                    id: 1,
                    code: "control".into(),
                    name: "control".into(),
                    mode: "rw".into(),
                    kind: DpKind::Enum,
                    default_value: Some(json!("stop")),
                    property: json!({"type":"enum","range":["stop","up","down"]}),
                },
                DpPoint {
                    id: 2,
                    code: "position".into(),
                    name: "position".into(),
                    mode: "ro".into(),
                    kind: DpKind::Value,
                    default_value: Some(json!(0)),
                    property: json!({"type":"value","min":0,"max":50,"step":1}),
                },
            ],
        }
    }

    #[test]
    fn replace_and_cancel_sequence_group() {
        let mut engine = TriggerEngine::default();
        engine.set_rules(vec![rule("up"), rule("down"), rule("stop")]);
        engine.set_master(true);
        assert_eq!(engine.handle_download(download("up"), 1000), vec!["up"]);
        assert_eq!(engine.active.len(), 1);
        engine.handle_download(download("down"), 1100);
        assert_eq!(engine.active.len(), 1);
        assert_eq!(engine.active[0].rule_id, "down");
        engine.handle_download(download("stop"), 1200);
        assert!(engine.active.is_empty());
        assert_eq!(engine.pending.len(), 1);
    }

    #[test]
    fn unmatched_download_does_not_suppress_default_report() {
        let mut engine = TriggerEngine::default();
        engine.set_rules(vec![rule("up")]);
        engine.set_master(true);
        assert!(engine.handle_download(download("stop"), 1000).is_empty());
    }

    #[test]
    fn ordinary_sequence_rotates_values_and_stops_at_limit() {
        let mut engine = TriggerEngine::default();
        engine.set_rules(vec![rule("up")]);
        engine.set_master(true);
        engine.handle_download(download("up"), 1000);
        for (index, now) in [1000, 2000, 3000].into_iter().enumerate() {
            let due = engine.take_due(now).unwrap();
            let generated = generate_run(
                &due,
                &schema(),
                json!({"position":index}),
                NetworkStatus::new(4, AppLanguage::ZhCn),
                AppLanguage::ZhCn,
                false,
            )
            .unwrap();
            assert_eq!(generated.patches[0].value, json!(index + 1));
            engine.commit_success(&due, &generated, now);
        }
        assert!(engine.active.is_empty());
        assert_eq!(engine.rules[0].trigger_count, 3);
        assert_eq!(engine.rules[0].items[0].manual_index, 0);
    }

    #[test]
    fn queue_and_ignore_keep_one_active_sequence_per_group() {
        let mut up = rule("up");
        up.max_runs = Some(1);
        let mut down = rule("down");
        down.sequence_action = "queue".into();
        down.max_runs = Some(1);
        let mut ignored = rule("ignored");
        ignored.match_value = Some(json!("ignore"));
        ignored.sequence_action = "ignore".into();
        let mut engine = TriggerEngine::default();
        engine.set_rules(vec![up, down, ignored]);
        engine.set_master(true);
        engine.handle_download(download("up"), 1000);
        engine.handle_download(download("down"), 1001);
        engine.handle_download(download("ignore"), 1002);
        assert_eq!(engine.active.len(), 1);
        assert_eq!(engine.queued.len(), 1);

        let due = engine.take_due(1000).unwrap();
        let generated = generate_run(
            &due,
            &schema(),
            json!({"position":0}),
            NetworkStatus::new(4, AppLanguage::ZhCn),
            AppLanguage::ZhCn,
            false,
        )
        .unwrap();
        engine.commit_success(&due, &generated, 1000);
        assert_eq!(engine.active.len(), 1);
        assert_eq!(engine.active[0].rule_id, "down");
        assert!(engine.queued.is_empty());
    }

    #[test]
    fn script_receives_trigger_and_can_complete_sequence() {
        let mut script_rule = rule("up");
        script_rule.generation_mode = "script".into();
        script_rule.items.clear();
        script_rule.script = Some(TriggerScriptConfig {
            api_version: 1,
            source: "function generate(ctx){return {reports:[{code:'position',value:ctx.trigger.value==='up'?10:0}],state:{seen:ctx.sequence.runIndex},complete:true}}".into(),
            initial_state: json!({}),
            state: json!({}),
        });
        let mut engine = TriggerEngine::default();
        engine.set_rules(vec![script_rule]);
        engine.set_master(true);
        engine.handle_download(download("up"), 1000);
        let due = engine.take_due(1000).unwrap();
        let generated = generate_run(
            &due,
            &schema(),
            json!({"position":0}),
            NetworkStatus::new(4, AppLanguage::ZhCn),
            AppLanguage::ZhCn,
            false,
        )
        .unwrap();
        assert_eq!(generated.patches[0].value, json!(10));
        assert!(generated.complete);
        engine.commit_success(&due, &generated, 1000);
        assert!(engine.active.is_empty());
    }

    #[test]
    fn invalid_enabled_rule_is_paused_without_disabling_master() {
        let invalid = rule("up");
        let errors = collect_rule_errors(
            std::slice::from_ref(&invalid),
            &DpSchema {
                points: vec![],
                ..schema()
            },
        );
        let mut engine = TriggerEngine::default();
        engine.set_rules_with_errors(vec![invalid], errors);
        engine.set_master(true);

        assert!(engine.state().master_enabled);
        assert!(engine.state().rule_errors.contains_key("up"));
        assert!(engine.handle_download(download("up"), 1000).is_empty());
    }

    #[test]
    fn invalid_script_draft_is_reported_before_it_can_match() {
        let mut invalid = rule("up");
        invalid.generation_mode = "script".into();
        invalid.items.clear();
        invalid.script = Some(TriggerScriptConfig {
            api_version: 1,
            source: "function generate(ctx) {".into(),
            initial_state: json!({}),
            state: json!({}),
        });

        let errors = collect_rule_errors(&[invalid], &schema());
        assert!(errors
            .get("up")
            .is_some_and(|error| error.contains("syntax error")));
    }

    #[test]
    fn hot_update_cancels_only_the_changed_rule_schedule() {
        let up = rule("up");
        let mut down = rule("down");
        down.sequence_group = "down-motion".into();
        let mut engine = TriggerEngine::default();
        engine.set_rules_with_errors(vec![up.clone(), down.clone()], HashMap::new());
        engine.set_master(true);
        engine.handle_download(download("up"), 1000);
        engine.handle_download(download("down"), 1000);
        assert_eq!(engine.active.len(), 2);

        let mut updated_up = up;
        updated_up.name = "updated up".into();
        engine.update_rules(vec![updated_up, down], HashMap::new(), &["up".into()]);

        assert!(engine.state().master_enabled);
        assert_eq!(engine.active.len(), 1);
        assert_eq!(engine.active[0].rule_id, "down");
    }

    #[test]
    fn disabling_all_rules_keeps_master_armed_and_idle() {
        let mut disabled = rule("up");
        disabled.enabled = false;
        let mut engine = TriggerEngine::default();
        engine.set_rules_with_errors(vec![rule("up")], HashMap::new());
        engine.set_master(true);
        engine.update_rules(vec![disabled], HashMap::new(), &["up".into()]);

        assert!(engine.state().master_enabled);
        assert!(engine.handle_download(download("up"), 1000).is_empty());
        assert!(engine.active.is_empty());
    }
}
