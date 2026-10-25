use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::PathBuf, sync::Mutex};
use tauri::{Manager, State};

const BASE: &str = "TWD";

#[derive(Serialize, Deserialize, Clone, Default)]
struct Asset {
    #[serde(default)]
    id: u64,
    name: String,
    category: String,
    #[serde(default = "base_currency")]
    currency: String,
    value: f64,
    #[serde(default)]
    liability: bool,
    #[serde(default)]
    note: String,
    #[serde(default)]
    updated: String,
}

/// Totals are stored in the base currency (TWD) at the rates in force on that day.
#[derive(Serialize, Deserialize, Clone)]
struct Snapshot {
    date: String,
    assets: f64,
    liabilities: f64,
}

#[derive(Serialize, Deserialize, Clone)]
struct Data {
    next_id: u64,
    assets: Vec<Asset>,
    snapshots: Vec<Snapshot>,
    #[serde(default = "default_rates")]
    rates: BTreeMap<String, f64>,
    #[serde(default)]
    goal: f64,
}

impl Default for Data {
    fn default() -> Self {
        Data { next_id: 0, assets: vec![], snapshots: vec![], rates: default_rates(), goal: 0.0 }
    }
}

fn base_currency() -> String {
    BASE.to_string()
}

fn default_rates() -> BTreeMap<String, f64> {
    [("TWD", 1.0), ("USD", 32.0), ("JPY", 0.21), ("EUR", 35.0), ("CNY", 4.5), ("HKD", 4.1)]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect()
}

struct AppState {
    path: PathBuf,
    data: Mutex<Data>,
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn in_base(d: &Data, a: &Asset) -> f64 {
    a.value * d.rates.get(&a.currency).copied().unwrap_or(1.0)
}

impl AppState {
    /// Record today's totals (replacing any earlier snapshot of the same day) and persist.
    fn commit(&self, d: &mut Data) -> Result<(), String> {
        let assets: f64 = d.assets.iter().filter(|a| !a.liability).map(|a| in_base(d, a)).sum();
        let liabilities: f64 = d.assets.iter().filter(|a| a.liability).map(|a| in_base(d, a)).sum();
        let date = today();
        let snap = Snapshot { date: date.clone(), assets, liabilities };
        match d.snapshots.last_mut() {
            Some(last) if last.date == date => *last = snap,
            _ => d.snapshots.push(snap),
        }
        let json = serde_json::to_string_pretty(d).map_err(|e| e.to_string())?;
        fs::write(&self.path, json).map_err(|e| e.to_string())
    }
}

fn validate(a: &Asset, d: &Data) -> Result<(), String> {
    if a.name.trim().is_empty() {
        return Err("名稱不可為空".into());
    }
    if !a.value.is_finite() || a.value < 0.0 {
        return Err("金額必須為非負數".into());
    }
    if !d.rates.contains_key(&a.currency) {
        return Err(format!("未知幣別：{}", a.currency));
    }
    Ok(())
}

#[tauri::command]
fn get_data(state: State<AppState>) -> Data {
    state.data.lock().unwrap().clone()
}

#[tauri::command]
fn save_asset(state: State<AppState>, mut asset: Asset) -> Result<Data, String> {
    let mut d = state.data.lock().unwrap();
    validate(&asset, &d)?;
    asset.updated = today();
    if asset.id == 0 {
        d.next_id += 1;
        asset.id = d.next_id;
        d.assets.push(asset);
    } else if let Some(slot) = d.assets.iter_mut().find(|a| a.id == asset.id) {
        *slot = asset;
    } else {
        return Err("找不到該項目".into());
    }
    state.commit(&mut d)?;
    Ok(d.clone())
}

#[tauri::command]
fn delete_asset(state: State<AppState>, id: u64) -> Result<Data, String> {
    let mut d = state.data.lock().unwrap();
    d.assets.retain(|a| a.id != id);
    state.commit(&mut d)?;
    Ok(d.clone())
}

#[tauri::command]
fn set_settings(state: State<AppState>, rates: BTreeMap<String, f64>, goal: f64) -> Result<Data, String> {
    if rates.get(BASE) != Some(&1.0) {
        return Err("TWD 匯率必須為 1".into());
    }
    if rates.values().any(|r| !r.is_finite() || *r <= 0.0) {
        return Err("匯率必須為正數".into());
    }
    if !goal.is_finite() || goal < 0.0 {
        return Err("目標金額必須為非負數".into());
    }
    let mut d = state.data.lock().unwrap();
    if let Some(a) = d.assets.iter().find(|a| !rates.contains_key(&a.currency)) {
        return Err(format!("「{}」仍使用幣別 {}，無法移除", a.name, a.currency));
    }
    d.rates = rates;
    d.goal = goal;
    state.commit(&mut d)?;
    Ok(d.clone())
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

#[tauri::command]
fn export_csv(state: State<AppState>) -> String {
    let d = state.data.lock().unwrap();
    let mut out = String::from("\u{feff}名稱,類別,幣別,金額,負債,備註\n");
    for a in &d.assets {
        out += &format!(
            "{},{},{},{},{},{}\n",
            csv_field(&a.name),
            csv_field(&a.category),
            a.currency,
            a.value,
            if a.liability { "是" } else { "否" },
            csv_field(&a.note)
        );
    }
    out
}

/// Minimal RFC 4180 parser: quoted fields, doubled quotes, CRLF or LF.
fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let (mut rows, mut row, mut field) = (vec![], vec![], String::new());
    let (mut quoted, mut chars) = (false, text.trim_start_matches('\u{feff}').chars().peekable());
    while let Some(c) = chars.next() {
        match (quoted, c) {
            (true, '"') if chars.peek() == Some(&'"') => {
                chars.next();
                field.push('"');
            }
            (true, '"') => quoted = false,
            (true, _) => field.push(c),
            (false, '"') => quoted = true,
            (false, ',') => row.push(std::mem::take(&mut field)),
            (false, '\r') => {}
            (false, '\n') => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            (false, _) => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

#[tauri::command]
fn import_csv(state: State<AppState>, text: String) -> Result<Data, String> {
    let mut d = state.data.lock().unwrap();
    let mut added = vec![];
    for (i, r) in parse_csv(&text).into_iter().enumerate().skip(1) {
        if r.iter().all(|c| c.trim().is_empty()) {
            continue;
        }
        let get = |n: usize| r.get(n).map(|s| s.trim().to_string()).unwrap_or_default();
        let value: f64 = get(3).parse().map_err(|_| format!("第 {} 行：金額格式錯誤", i + 1))?;
        let currency = if get(2).is_empty() { base_currency() } else { get(2).to_uppercase() };
        let a = Asset {
            id: 0,
            name: get(0),
            category: if get(1).is_empty() { "其他".into() } else { get(1) },
            currency,
            value,
            liability: matches!(get(4).as_str(), "是" | "true" | "TRUE" | "1" | "yes"),
            note: get(5),
            updated: today(),
        };
        validate(&a, &d).map_err(|e| format!("第 {} 行：{}", i + 1, e))?;
        added.push(a);
    }
    if added.is_empty() {
        return Err("檔案中沒有可匯入的資料".into());
    }
    for mut a in added {
        d.next_id += 1;
        a.id = d.next_id;
        d.assets.push(a);
    }
    state.commit(&mut d)?;
    Ok(d.clone())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            fs::create_dir_all(&dir)?;
            let path = dir.join("moneypi.json");
            let data: Data = fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            app.manage(AppState { path, data: Mutex::new(data) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_data,
            save_asset,
            delete_asset,
            set_settings,
            export_csv,
            import_csv
        ])
        .run(tauri::generate_context!())
        .expect("error while running MoneyPi");
}
