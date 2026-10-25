use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{Manager, State};

#[derive(Serialize, Deserialize, Clone, Default)]
struct Asset {
    #[serde(default)]
    id: u64,
    name: String,
    category: String,
    value: f64,
    #[serde(default)]
    liability: bool,
    #[serde(default)]
    note: String,
    #[serde(default)]
    updated: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct Snapshot {
    date: String,
    assets: f64,
    liabilities: f64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Data {
    next_id: u64,
    assets: Vec<Asset>,
    snapshots: Vec<Snapshot>,
}

struct AppState {
    path: PathBuf,
    data: Mutex<Data>,
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

impl AppState {
    /// Record today's totals (replacing any earlier snapshot of the same day) and persist.
    fn commit(&self, d: &mut Data) -> Result<(), String> {
        let assets: f64 = d.assets.iter().filter(|a| !a.liability).map(|a| a.value).sum();
        let liabilities: f64 = d.assets.iter().filter(|a| a.liability).map(|a| a.value).sum();
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

#[tauri::command]
fn get_data(state: State<AppState>) -> Data {
    state.data.lock().unwrap().clone()
}

#[tauri::command]
fn save_asset(state: State<AppState>, mut asset: Asset) -> Result<Data, String> {
    if asset.name.trim().is_empty() {
        return Err("名稱不可為空".into());
    }
    if !asset.value.is_finite() || asset.value < 0.0 {
        return Err("金額必須為非負數".into());
    }
    let mut d = state.data.lock().unwrap();
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
        .invoke_handler(tauri::generate_handler![get_data, save_asset, delete_asset])
        .run(tauri::generate_context!())
        .expect("error while running MoneyPi");
}
