use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    net::UdpSocket,
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::UpdaterExt;

const BASE: &str = "TWD";
const DEFAULT_PORT: u16 = 8787;

const INDEX_HTML: &str = include_str!("../../src/index.html");
const STYLE_CSS: &str = include_str!("../../src/style.css");
const MAIN_JS: &str = include_str!("../../src/main.js");
const MANIFEST: &str = include_str!("../../src/manifest.webmanifest");
const ICON_192: &[u8] = include_bytes!("../../src/icon-192.png");
const ICON_512: &[u8] = include_bytes!("../../src/icon-512.png");

// ---------------------------------------------------------------- data model

#[derive(Serialize, Deserialize, Clone, Default)]
struct Tx {
    date: String,
    /// "buy" | "sell" | "div" (for "div", `price` is the total dividend received)
    kind: String,
    #[serde(default)]
    units: f64,
    #[serde(default)]
    price: f64,
    #[serde(default)]
    fee: f64,
    #[serde(default)]
    note: String,
}

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
    /// Holding mode: value = quantity × price.
    #[serde(default)]
    holding: bool,
    #[serde(default)]
    symbol: String,
    /// "" = manual price, "tw" = Taiwan listed (.TW/.TWO), "other" = raw Yahoo ticker
    #[serde(default)]
    market: String,
    #[serde(default)]
    quantity: f64,
    #[serde(default)]
    price: f64,
    /// Total cost basis in the asset currency.
    #[serde(default)]
    cost: f64,
    #[serde(default)]
    realized: f64,
    #[serde(default)]
    dividends: f64,
    #[serde(default)]
    price_updated: String,
    #[serde(default)]
    txs: Vec<Tx>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct GoalPoint {
    date: String,
    value: f64,
}

/// A savings / wealth goal. Progress is measured on total net worth, or on a chosen set of assets.
#[derive(Serialize, Deserialize, Clone, Default)]
struct Goal {
    #[serde(default)]
    id: u64,
    name: String,
    #[serde(default)]
    icon: String,
    amount: f64,
    #[serde(default)]
    date: String,
    /// Asset ids that count toward this goal; empty = total net worth.
    #[serde(default)]
    assets: Vec<u64>,
    /// Daily progress values (TWD), used for the "when will I get there" estimate.
    #[serde(default)]
    history: Vec<GoalPoint>,
}

/// One income/expense entry of the bookkeeping ledger (always TWD).
#[derive(Serialize, Deserialize, Clone, Default)]
struct Flow {
    #[serde(default)]
    id: u64,
    date: String,
    /// "in" | "out"
    kind: String,
    category: String,
    amount: f64,
    #[serde(default)]
    note: String,
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
    /// Legacy single goal (pre-0.5); migrated into `goals` on load and never written back.
    #[serde(default, skip_serializing)]
    goal: f64,
    #[serde(default, skip_serializing)]
    goal_date: String,
    #[serde(default)]
    goals: Vec<Goal>,
    #[serde(default)]
    next_goal: u64,
    /// Auto quote refresh interval in minutes (0 = off); the frontend drives the timer.
    #[serde(default)]
    refresh_min: u32,
    #[serde(default)]
    sync_enabled: bool,
    #[serde(default = "default_port")]
    sync_port: u16,
    #[serde(default)]
    sync_pin: String,
    #[serde(default)]
    cashflow: Vec<Flow>,
    #[serde(default)]
    next_flow: u64,
}

impl Default for Data {
    fn default() -> Self {
        Data {
            next_id: 0,
            assets: vec![],
            snapshots: vec![],
            rates: default_rates(),
            goal: 0.0,
            goal_date: String::new(),
            goals: vec![],
            next_goal: 0,
            refresh_min: 0,
            sync_enabled: false,
            sync_port: DEFAULT_PORT,
            sync_pin: String::new(),
            cashflow: vec![],
            next_flow: 0,
        }
    }
}

fn base_currency() -> String {
    BASE.to_string()
}
fn default_port() -> u16 {
    DEFAULT_PORT
}
fn default_rates() -> BTreeMap<String, f64> {
    [("TWD", 1.0), ("USD", 32.0), ("JPY", 0.21), ("EUR", 35.0), ("CNY", 4.5), ("HKD", 4.1)]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect()
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn net_history(d: &Data) -> Vec<GoalPoint> {
    d.snapshots.iter().map(|s| GoalPoint { date: s.date.clone(), value: s.assets - s.liabilities }).collect()
}

/// Move the legacy single goal into the goals list.
fn migrate(d: &mut Data) {
    if d.goals.is_empty() && d.goal > 0.0 {
        d.next_goal += 1;
        let history = net_history(d);
        d.goals.push(Goal {
            id: d.next_goal,
            name: "財富目標".into(),
            icon: "🎯".into(),
            amount: d.goal,
            date: d.goal_date.clone(),
            assets: vec![],
            history,
        });
    }
    d.goal = 0.0;
    d.goal_date.clear();
}

fn goal_value(d: &Data, g: &Goal) -> f64 {
    d.assets
        .iter()
        .filter(|a| g.assets.is_empty() || g.assets.contains(&a.id))
        .map(|a| if a.liability { -in_base(d, a) } else { in_base(d, a) })
        .sum()
}

fn valid_date(s: &str) -> bool {
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

fn in_base(d: &Data, a: &Asset) -> f64 {
    a.value * d.rates.get(&a.currency).copied().unwrap_or(1.0)
}

/// What clients get to see: everything except the sync PIN.
fn view(d: &Data) -> Value {
    let mut v = serde_json::to_value(d).unwrap_or(Value::Null);
    if let Some(o) = v.as_object_mut() {
        o.remove("sync_pin");
    }
    v
}

// ------------------------------------------------------------ holdings maths

/// Rebuild quantity / cost / realized P&L / dividends from the transaction log
/// (average-cost method) and refresh `value`. Returns false if a sale exceeds
/// the units held at that point.
fn recompute(a: &mut Asset) -> bool {
    if !a.holding {
        return true;
    }
    let mut ok = true;
    if !a.txs.is_empty() {
        let mut txs = a.txs.clone();
        txs.sort_by(|x, y| x.date.cmp(&y.date)); // stable: same-day order is preserved
        let (mut q, mut c, mut r, mut dv, mut last) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
        for t in &txs {
            match t.kind.as_str() {
                "buy" => {
                    q += t.units;
                    c += t.units * t.price + t.fee;
                    last = t.price;
                }
                "sell" => {
                    if t.units > q + 1e-9 {
                        ok = false;
                    }
                    let sold = t.units.min(q);
                    let avg = if q > 0.0 { c / q } else { 0.0 };
                    r += sold * t.price - t.fee - sold * avg;
                    c -= sold * avg;
                    q -= sold;
                    last = t.price;
                }
                "div" => dv += t.price,
                _ => {}
            }
        }
        if q < 1e-9 {
            q = 0.0;
            c = 0.0;
        }
        a.quantity = q;
        a.cost = c;
        a.realized = r;
        a.dividends = dv;
        if a.price <= 0.0 && last > 0.0 {
            a.price = last;
        }
    }
    a.value = a.quantity * a.price;
    ok
}

fn validate_asset(a: &Asset, d: &Data) -> Result<(), String> {
    if a.name.trim().is_empty() {
        return Err("名稱不可為空".into());
    }
    if !d.rates.contains_key(&a.currency) {
        return Err(format!("未知幣別：{}", a.currency));
    }
    let nums = [a.value, a.quantity, a.price, a.cost];
    if nums.iter().any(|n| !n.is_finite() || *n < 0.0) {
        return Err("金額、數量、單價與成本必須為非負數".into());
    }
    if !matches!(a.market.as_str(), "" | "tw" | "other") {
        return Err("未知市場".into());
    }
    if a.holding && !a.market.is_empty() && a.symbol.trim().is_empty() {
        return Err("同步行情需要填寫代號".into());
    }
    Ok(())
}

fn validate_flow(f: &Flow) -> Result<(), String> {
    if !valid_date(&f.date) {
        return Err("日期格式需為 YYYY-MM-DD".into());
    }
    if !matches!(f.kind.as_str(), "in" | "out") {
        return Err("未知的收支類型".into());
    }
    if !f.amount.is_finite() || f.amount <= 0.0 {
        return Err("金額必須大於 0".into());
    }
    if f.category.is_empty() {
        return Err("請選擇類別".into());
    }
    Ok(())
}

fn validate_tx(t: &Tx) -> Result<(), String> {
    if !valid_date(&t.date) {
        return Err("日期格式需為 YYYY-MM-DD".into());
    }
    if !t.units.is_finite() || !t.price.is_finite() || !t.fee.is_finite() || t.fee < 0.0 || t.price < 0.0 || t.units < 0.0 {
        return Err("數值必須為非負數".into());
    }
    match t.kind.as_str() {
        "buy" | "sell" if t.units <= 0.0 => Err("單位數必須大於 0".into()),
        "buy" | "sell" => Ok(()),
        "div" if t.price <= 0.0 => Err("配息金額必須大於 0".into()),
        "div" => Ok(()),
        _ => Err("未知的交易類型".into()),
    }
}

// ------------------------------------------------------------------ the core

struct Core {
    path: PathBuf,
    data: Mutex<Data>,
    server: Mutex<Option<Arc<tiny_http::Server>>>,
}

impl Core {
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
        let vals: Vec<f64> = d.goals.iter().map(|g| goal_value(d, g)).collect();
        for (g, v) in d.goals.iter_mut().zip(vals) {
            match g.history.last_mut() {
                Some(p) if p.date == date => p.value = v,
                _ => g.history.push(GoalPoint { date: date.clone(), value: v }),
            }
        }
        self.persist(d)
    }

    fn persist(&self, d: &Data) -> Result<(), String> {
        let json = serde_json::to_string_pretty(d).map_err(|e| e.to_string())?;
        fs::write(&self.path, json).map_err(|e| e.to_string())
    }

    fn save_goal(&self, mut g: Goal) -> Result<Value, String> {
        g.name = g.name.trim().to_string();
        if g.name.is_empty() {
            return Err("目標名稱不可為空".into());
        }
        if !g.amount.is_finite() || g.amount <= 0.0 {
            return Err("目標金額必須大於 0".into());
        }
        if !g.date.is_empty() && !valid_date(&g.date) {
            return Err("目標日期格式需為 YYYY-MM-DD".into());
        }
        if g.icon.is_empty() {
            g.icon = "🎯".into();
        }
        let mut d = self.data.lock().unwrap();
        g.assets.retain(|id| d.assets.iter().any(|a| a.id == *id));
        g.assets.sort_unstable();
        g.assets.dedup();
        if g.id == 0 {
            if d.goals.len() >= 50 {
                return Err("目標數量已達上限（50）".into());
            }
            d.next_goal += 1;
            g.id = d.next_goal;
            g.history = if g.assets.is_empty() { net_history(&d) } else { vec![] };
            d.goals.push(g);
        } else {
            let i = d.goals.iter().position(|x| x.id == g.id).ok_or("找不到該目標")?;
            // Changing what the goal measures invalidates its history.
            g.history = if d.goals[i].assets == g.assets {
                d.goals[i].history.clone()
            } else if g.assets.is_empty() {
                net_history(&d)
            } else {
                vec![]
            };
            d.goals[i] = g;
        }
        self.commit(&mut d)?;
        Ok(view(&d))
    }

    fn delete_goal(&self, id: u64) -> Result<Value, String> {
        let mut d = self.data.lock().unwrap();
        d.goals.retain(|g| g.id != id);
        self.persist(&d)?;
        Ok(view(&d))
    }

    fn add_flow(&self, mut f: Flow) -> Result<Value, String> {
        f.category = f.category.trim().to_string();
        f.note = f.note.trim().to_string();
        validate_flow(&f)?;
        let mut d = self.data.lock().unwrap();
        d.next_flow += 1;
        f.id = d.next_flow;
        d.cashflow.push(f);
        self.persist(&d)?;
        Ok(view(&d))
    }

    fn delete_flow(&self, id: u64) -> Result<Value, String> {
        let mut d = self.data.lock().unwrap();
        d.cashflow.retain(|f| f.id != id);
        self.persist(&d)?;
        Ok(view(&d))
    }

    fn export_backup(&self) -> String {
        let mut d = self.data.lock().unwrap().clone();
        d.sync_pin.clear();
        serde_json::to_string_pretty(&d).unwrap_or_default()
    }

    fn import_backup(&self, text: &str) -> Result<Value, String> {
        let mut inc: Data = serde_json::from_str(text).map_err(|e| format!("備份檔格式錯誤：{e}"))?;
        migrate(&mut inc);
        if inc.rates.get(BASE) != Some(&1.0) || inc.rates.values().any(|r| !r.is_finite() || *r <= 0.0) {
            return Err("備份檔的匯率資料不正確".into());
        }
        for a in &inc.assets {
            validate_asset(a, &inc).map_err(|e| format!("備份檔中的「{}」：{e}", a.name))?;
        }
        for f in &inc.cashflow {
            validate_flow(f)?;
        }
        let mut d = self.data.lock().unwrap();
        // The backup only carries finance data; keep this machine's own sync settings.
        inc.sync_enabled = d.sync_enabled;
        inc.sync_port = d.sync_port;
        inc.sync_pin = d.sync_pin.clone();
        inc.next_id = inc.next_id.max(inc.assets.iter().map(|a| a.id).max().unwrap_or(0));
        inc.next_flow = inc.next_flow.max(inc.cashflow.iter().map(|f| f.id).max().unwrap_or(0));
        inc.next_goal = inc.next_goal.max(inc.goals.iter().map(|g| g.id).max().unwrap_or(0));
        let _ = fs::copy(&self.path, self.path.with_extension("before-restore.json"));
        for a in inc.assets.iter_mut() {
            recompute(a);
        }
        *d = inc;
        self.commit(&mut d)?;
        Ok(view(&d))
    }

    fn save_asset(&self, mut asset: Asset) -> Result<Value, String> {
        let mut d = self.data.lock().unwrap();
        asset.symbol = asset.symbol.trim().to_string();
        validate_asset(&asset, &d)?;
        asset.updated = today();
        if asset.id != 0 {
            let old = d.assets.iter().find(|a| a.id == asset.id).ok_or("找不到該項目")?;
            asset.txs = old.txs.clone();
            asset.price_updated = old.price_updated.clone();
            if asset.holding && asset.txs.is_empty() {
                asset.realized = old.realized;
                asset.dividends = old.dividends;
            }
        }
        if !asset.holding {
            asset.txs.clear();
            asset.quantity = 0.0;
            asset.cost = 0.0;
            asset.realized = 0.0;
            asset.dividends = 0.0;
        }
        recompute(&mut asset);
        if asset.id == 0 {
            d.next_id += 1;
            asset.id = d.next_id;
            d.assets.push(asset);
        } else if let Some(slot) = d.assets.iter_mut().find(|a| a.id == asset.id) {
            *slot = asset;
        }
        self.commit(&mut d)?;
        Ok(view(&d))
    }

    fn delete_asset(&self, id: u64) -> Result<Value, String> {
        let mut d = self.data.lock().unwrap();
        d.assets.retain(|a| a.id != id);
        self.commit(&mut d)?;
        Ok(view(&d))
    }

    fn add_tx(&self, id: u64, tx: Tx) -> Result<Value, String> {
        validate_tx(&tx)?;
        let mut d = self.data.lock().unwrap();
        let a = d.assets.iter_mut().find(|a| a.id == id).ok_or("找不到該項目")?;
        if !a.holding {
            return Err("請先將此項目設為「持倉」".into());
        }
        a.txs.push(tx);
        if !recompute(a) {
            a.txs.pop();
            recompute(a);
            return Err("賣出數量超過當時持有的單位數".into());
        }
        a.updated = today();
        self.commit(&mut d)?;
        Ok(view(&d))
    }

    fn delete_tx(&self, id: u64, index: usize) -> Result<Value, String> {
        let mut d = self.data.lock().unwrap();
        let a = d.assets.iter_mut().find(|a| a.id == id).ok_or("找不到該項目")?;
        if index >= a.txs.len() {
            return Err("找不到該筆交易".into());
        }
        let removed = a.txs.remove(index);
        if !recompute(a) {
            a.txs.insert(index, removed);
            recompute(a);
            return Err("刪除後會造成後續賣出數量超過持有，請先刪除較晚的賣出".into());
        }
        a.updated = today();
        self.commit(&mut d)?;
        Ok(view(&d))
    }

    fn set_settings(
        &self,
        rates: BTreeMap<String, f64>,
        refresh_min: u32,
    ) -> Result<Value, String> {
        if rates.get(BASE) != Some(&1.0) {
            return Err("TWD 匯率必須為 1".into());
        }
        if rates.values().any(|r| !r.is_finite() || *r <= 0.0) {
            return Err("匯率必須為正數".into());
        }
        if !matches!(refresh_min, 0 | 5 | 15 | 30 | 60) {
            return Err("不支援的更新間隔".into());
        }
        let mut d = self.data.lock().unwrap();
        if let Some(a) = d.assets.iter().find(|a| !rates.contains_key(&a.currency)) {
            return Err(format!("「{}」仍使用幣別 {}，無法移除", a.name, a.currency));
        }
        d.rates = rates;
        d.refresh_min = refresh_min;
        for a in d.assets.iter_mut() {
            recompute(a);
        }
        self.commit(&mut d)?;
        Ok(view(&d))
    }

    // ------------------------------------------------------------- quotes

    /// Fetch live prices for every holding with a symbol, plus FX rates for the
    /// non-TWD currencies in use. Network I/O happens without holding the lock.
    fn refresh_quotes(&self) -> Result<Value, String> {
        let (targets, currencies) = {
            let d = self.data.lock().unwrap();
            let t: Vec<(u64, String, String)> = d
                .assets
                .iter()
                .filter(|a| a.holding && !a.market.is_empty() && !a.symbol.is_empty())
                .map(|a| (a.id, a.symbol.clone(), a.market.clone()))
                .collect();
            let c: Vec<String> = d.rates.keys().filter(|k| *k != BASE).cloned().collect();
            (t, c)
        };

        let mut quotes: Vec<(u64, Result<Quote, String>)> = vec![];
        for (id, sym, market) in &targets {
            quotes.push((*id, fetch_quote(sym, market)));
        }
        let mut fx: Vec<(String, f64)> = vec![];
        for cur in &currencies {
            if let Ok(q) = fetch_yahoo(&format!("{cur}TWD=X")) {
                if q.price > 0.0 {
                    fx.push((cur.clone(), q.price));
                }
            }
        }

        let mut d = self.data.lock().unwrap();
        let (mut updated, mut failed) = (0usize, Vec::<String>::new());
        let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
        for (id, res) in quotes {
            let Some(pos) = d.assets.iter().position(|a| a.id == id) else { continue };
            match res {
                Ok(q) => {
                    let known = d.rates.contains_key(&q.currency);
                    let a = &mut d.assets[pos];
                    a.price = q.price;
                    a.price_updated = stamp.clone();
                    if known {
                        a.currency = q.currency;
                    }
                    recompute(a);
                    updated += 1;
                }
                Err(e) => failed.push(format!("{}（{}）", d.assets[pos].name, e)),
            }
        }
        for (cur, r) in &fx {
            d.rates.insert(cur.clone(), *r);
        }
        for a in d.assets.iter_mut() {
            recompute(a);
        }
        self.commit(&mut d)?;
        Ok(json!({ "data": view(&d), "updated": updated, "rates": fx.len(), "failed": failed }))
    }

    // --------------------------------------------------------------- CSV

    fn export_csv(&self) -> String {
        let d = self.data.lock().unwrap();
        let mut out = String::from("\u{feff}名稱,類別,幣別,金額,負債,備註,代號,市場,數量,單價,成本\n");
        for a in &d.assets {
            let (sym, mkt, q, p, c) = if a.holding {
                (csv_field(&a.symbol), a.market.clone(), a.quantity.to_string(), a.price.to_string(), a.cost.to_string())
            } else {
                Default::default()
            };
            out += &format!(
                "{},{},{},{},{},{},{},{},{},{},{}\n",
                csv_field(&a.name),
                csv_field(&a.category),
                a.currency,
                a.value,
                if a.liability { "是" } else { "否" },
                csv_field(&a.note),
                sym,
                mkt,
                q,
                p,
                c
            );
        }
        out
    }

    fn import_csv(&self, text: &str) -> Result<Value, String> {
        let mut d = self.data.lock().unwrap();
        let mut added = vec![];
        for (i, r) in parse_csv(text).into_iter().enumerate().skip(1) {
            if r.iter().all(|c| c.trim().is_empty()) {
                continue;
            }
            let get = |n: usize| r.get(n).map(|s| s.trim().to_string()).unwrap_or_default();
            let num = |n: usize| -> Result<f64, String> {
                let s = get(n);
                if s.is_empty() { Ok(0.0) } else { s.parse().map_err(|_| format!("第 {} 行：數字格式錯誤", i + 1)) }
            };
            let quantity = num(8)?;
            let holding = quantity > 0.0;
            let mut a = Asset {
                name: get(0),
                category: if get(1).is_empty() { "其他".into() } else { get(1) },
                currency: if get(2).is_empty() { base_currency() } else { get(2).to_uppercase() },
                value: num(3)?,
                liability: matches!(get(4).as_str(), "是" | "true" | "TRUE" | "1" | "yes"),
                note: get(5),
                updated: today(),
                holding,
                symbol: get(6),
                market: if holding { get(7) } else { String::new() },
                quantity,
                price: num(9)?,
                cost: num(10)?,
                ..Default::default()
            };
            validate_asset(&a, &d).map_err(|e| format!("第 {} 行：{}", i + 1, e))?;
            recompute(&mut a);
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
        self.commit(&mut d)?;
        Ok(view(&d))
    }

    // -------------------------------------------------------- LAN sync

    fn sync_info(&self) -> Value {
        let d = self.data.lock().unwrap();
        let running = self.server.lock().unwrap().is_some();
        let urls: Vec<String> = lan_ips().into_iter().map(|ip| format!("http://{ip}:{}", d.sync_port)).collect();
        // One scan connects: the PIN rides in the URL fragment, which is never sent over the network.
        let qr = if running && !d.sync_pin.is_empty() {
            urls.first().and_then(|u| qr_svg(&format!("{u}/#pin={}", d.sync_pin)))
        } else {
            None
        };
        json!({ "enabled": d.sync_enabled, "running": running, "port": d.sync_port, "pin": d.sync_pin, "urls": urls, "qr": qr })
    }

    fn set_sync(self: &Arc<Self>, enabled: bool, port: u16, pin: String) -> Result<Value, String> {
        if port < 1024 {
            return Err("連接埠需介於 1024–65535".into());
        }
        if enabled && !(pin.len() >= 4 && pin.len() <= 12 && pin.chars().all(|c| c.is_ascii_digit())) {
            return Err("PIN 需為 4–12 位數字".into());
        }
        self.stop_server();
        {
            let mut d = self.data.lock().unwrap();
            d.sync_enabled = enabled;
            d.sync_port = port;
            d.sync_pin = pin;
            let json = serde_json::to_string_pretty(&*d).map_err(|e| e.to_string())?;
            fs::write(&self.path, json).map_err(|e| e.to_string())?;
        }
        if enabled {
            if let Err(e) = self.start_server(port) {
                self.data.lock().unwrap().sync_enabled = false;
                return Err(e);
            }
        }
        Ok(self.sync_info())
    }

    fn stop_server(&self) {
        if let Some(s) = self.server.lock().unwrap().take() {
            s.unblock();
        }
    }

    fn start_server(self: &Arc<Self>, port: u16) -> Result<(), String> {
        let server = Arc::new(
            tiny_http::Server::http(("0.0.0.0", port)).map_err(|e| format!("無法啟動同步服務（連接埠 {port}）：{e}"))?,
        );
        *self.server.lock().unwrap() = Some(server.clone());
        let core = self.clone();
        thread::spawn(move || {
            for req in server.incoming_requests() {
                let core = core.clone();
                thread::spawn(move || handle_http(core, req));
            }
        });
        Ok(())
    }
}

// --------------------------------------------------------------- quote fetch

struct Quote {
    price: f64,
    currency: String,
}

fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn fetch_yahoo(symbol: &str) -> Result<Quote, String> {
    let url = format!(
        "https://query1.finance.yahoo.com/v8/finance/chart/{}?range=1d&interval=1d",
        percent_encode(symbol)
    );
    let v: Value = ureq::get(&url)
        .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MoneyPi")
        .timeout(Duration::from_secs(10))
        .call()
        .map_err(|e| format!("連線失敗：{e}"))?
        .into_json()
        .map_err(|e| format!("回應格式錯誤：{e}"))?;
    let meta = &v["chart"]["result"][0]["meta"];
    let price = meta["regularMarketPrice"].as_f64().ok_or("查無報價")?;
    let currency = meta["currency"].as_str().unwrap_or("").to_uppercase();
    Ok(Quote { price, currency })
}

fn fetch_quote(symbol: &str, market: &str) -> Result<Quote, String> {
    if market == "tw" {
        fetch_yahoo(&format!("{symbol}.TW")).or_else(|_| fetch_yahoo(&format!("{symbol}.TWO")))
    } else {
        fetch_yahoo(symbol)
    }
}

// ----------------------------------------------------------------------- CSV

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
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

// ----------------------------------------------------------------- dispatch

fn arg<T: DeserializeOwned>(a: &Value, k: &str) -> Result<T, String> {
    serde_json::from_value(a.get(k).cloned().unwrap_or(Value::Null)).map_err(|e| format!("參數錯誤（{k}）：{e}"))
}

/// Single entry point shared by the desktop webview (Tauri `call`) and LAN clients (HTTP).
/// `remote` callers cannot change sync settings.
fn dispatch(core: &Arc<Core>, cmd: &str, args: Value, remote: bool) -> Result<Value, String> {
    match cmd {
        "get_data" => Ok(view(&core.data.lock().unwrap())),
        "save_asset" => core.save_asset(arg(&args, "asset")?),
        "delete_asset" => core.delete_asset(arg(&args, "id")?),
        "add_tx" => core.add_tx(arg(&args, "id")?, arg(&args, "tx")?),
        "delete_tx" => core.delete_tx(arg(&args, "id")?, arg(&args, "index")?),
        "set_settings" => core.set_settings(arg(&args, "rates")?, arg(&args, "refresh_min")?),
        "save_goal" => core.save_goal(arg(&args, "goal")?),
        "delete_goal" => core.delete_goal(arg(&args, "id")?),
        "refresh_quotes" => core.refresh_quotes(),
        "export_csv" => Ok(Value::String(core.export_csv())),
        "import_csv" => core.import_csv(&arg::<String>(&args, "text")?),
        "add_flow" => core.add_flow(arg(&args, "flow")?),
        "delete_flow" => core.delete_flow(arg(&args, "id")?),
        "export_backup" => Ok(Value::String(core.export_backup())),
        "import_backup" => core.import_backup(&arg::<String>(&args, "text")?),
        "get_sync" if !remote => Ok(core.sync_info()),
        "set_sync" if !remote => core.set_sync(arg(&args, "enabled")?, arg(&args, "port")?, arg(&args, "pin")?),
        _ => Err(format!("不支援的命令：{cmd}")),
    }
}

#[tauri::command]
async fn call(state: State<'_, Arc<Core>>, cmd: String, args: Value) -> Result<Value, String> {
    let core = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || dispatch(&core, &cmd, args, false))
        .await
        .map_err(|e| e.to_string())?
}

// ------------------------------------------------------------ HTTP (LAN sync)

fn header<'a>(req: &'a tiny_http::Request, name: &str) -> Option<&'a str> {
    req.headers().iter().find(|h| h.field.to_string().eq_ignore_ascii_case(name)).map(|h| h.value.as_str())
}

fn handle_http(core: Arc<Core>, mut req: tiny_http::Request) {
    use tiny_http::{Header, Method, Response};
    let url = req.url().split('?').next().unwrap_or("/").to_string();
    let hdr = |k: &str, v: &str| Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap();

    let static_page = |body: &'static [u8], ctype: &str| {
        Response::from_data(body).with_header(hdr("Content-Type", ctype)).with_header(hdr("Cache-Control", "no-cache"))
    };

    if *req.method() == Method::Get {
        let _ = match url.as_str() {
            "/" | "/index.html" => req.respond(static_page(INDEX_HTML.as_bytes(), "text/html; charset=utf-8")),
            "/style.css" => req.respond(static_page(STYLE_CSS.as_bytes(), "text/css; charset=utf-8")),
            "/main.js" => req.respond(static_page(MAIN_JS.as_bytes(), "text/javascript; charset=utf-8")),
            "/manifest.webmanifest" => req.respond(static_page(MANIFEST.as_bytes(), "application/manifest+json")),
            "/icon-192.png" => req.respond(static_page(ICON_192, "image/png")),
            "/icon-512.png" => req.respond(static_page(ICON_512, "image/png")),
            _ => req.respond(Response::from_string("not found").with_status_code(404)),
        };
        return;
    }

    let reply = |req: tiny_http::Request, code: u16, body: Value| {
        let _ = req.respond(
            Response::from_string(body.to_string())
                .with_status_code(code)
                .with_header(hdr("Content-Type", "application/json; charset=utf-8")),
        );
    };

    let Some(cmd) = url.strip_prefix("/api/").filter(|_| *req.method() == Method::Post) else {
        return reply(req, 404, json!({ "error": "not found" }));
    };
    let cmd = cmd.to_string();

    let pin = core.data.lock().unwrap().sync_pin.clone();
    let given = header(&req, "X-Token").unwrap_or("").to_string();
    if pin.is_empty() || given != pin {
        thread::sleep(Duration::from_secs(1)); // slow down PIN guessing
        return reply(req, 401, json!({ "error": "PIN 錯誤" }));
    }

    let mut body = String::new();
    if req.as_reader().take(2_000_000).read_to_string(&mut body).is_err() {
        return reply(req, 400, json!({ "error": "無法讀取請求" }));
    }
    let args: Value = if body.trim().is_empty() { json!({}) } else { serde_json::from_str(&body).unwrap_or(Value::Null) };
    match dispatch(&core, &cmd, args, true) {
        Ok(v) => reply(req, 200, v),
        Err(e) => reply(req, 400, json!({ "error": e })),
    }
}

fn qr_svg(text: &str) -> Option<String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::new(text.as_bytes()).ok()?;
    let xml = code
        .render::<svg::Color>()
        .min_dimensions(180, 180)
        .quiet_zone(true)
        .dark_color(svg::Color("#1b2340"))
        .light_color(svg::Color("#ffffff"))
        .build();
    // drop the <?xml ...?> prolog so the markup can be inlined in HTML
    xml.find("<svg").map(|i| xml[i..].to_string())
}

fn is_private_ip(ip: &str) -> bool {
    ip.starts_with("192.168.")
        || ip.starts_with("10.")
        || (ip.starts_with("172.")
            && ip.split('.').nth(1).and_then(|n| n.parse::<u8>().ok()).is_some_and(|n| (16..=31).contains(&n)))
}

/// Private IPv4 addresses of this machine, the default-route one first.
fn lan_ips() -> Vec<String> {
    let mut v: Vec<String> = local_ip().into_iter().collect();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if let Ok(o) = std::process::Command::new("ipconfig").creation_flags(0x0800_0000).output() {
            for line in String::from_utf8_lossy(&o.stdout).lines().filter(|l| l.contains("IPv4")) {
                let ip: String = line.rsplit(':').next().unwrap_or("").chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
                if is_private_ip(&ip) && !v.contains(&ip) {
                    v.push(ip);
                }
            }
        }
    }
    v
}

fn local_ip() -> Option<String> {
    // Connecting a UDP socket sends no packets; it just selects the outbound interface.
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    Some(s.local_addr().ok()?.ip().to_string())
}

// ------------------------------------------------------------------- updater

#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Value, String> {
    let upd = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(match upd {
        Some(u) => json!({ "version": u.version, "notes": u.body }),
        None => Value::Null,
    })
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let upd = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("目前已是最新版本")?;
    upd.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            fs::create_dir_all(&dir)?;
            let path = dir.join("moneypi.json");
            let data: Data = fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            let mut data = data;
            migrate(&mut data);
            let (enabled, port) = (data.sync_enabled, data.sync_port);
            let core = Arc::new(Core { path, data: Mutex::new(data), server: Mutex::new(None) });
            if enabled {
                if let Err(e) = core.start_server(port) {
                    eprintln!("{e}");
                }
            }
            app.manage(core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![call, app_version, check_update, install_update])
        .run(tauri::generate_context!())
        .expect("error while running MoneyPi");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tx(date: &str, kind: &str, units: f64, price: f64, fee: f64) -> Tx {
        Tx { date: date.into(), kind: kind.into(), units, price, fee, note: String::new() }
    }

    fn holding(txs: Vec<Tx>) -> Asset {
        Asset { name: "T".into(), category: "股票".into(), currency: "TWD".into(), holding: true, txs, ..Default::default() }
    }

    #[test]
    fn average_cost_and_realized_pnl() {
        let mut a = holding(vec![
            tx("2026-01-01", "buy", 10.0, 100.0, 0.0),
            tx("2026-02-01", "buy", 10.0, 200.0, 0.0),
            tx("2026-03-01", "sell", 5.0, 250.0, 5.0),
            tx("2026-03-15", "div", 0.0, 40.0, 0.0),
        ]);
        a.price = 300.0;
        assert!(recompute(&mut a));
        assert_eq!(a.quantity, 15.0);
        assert!((a.cost - 2250.0).abs() < 1e-9); // 3000 - 5 * avg(150)
        assert!((a.realized - 495.0).abs() < 1e-9); // 5*250 - 5 - 5*150
        assert_eq!(a.dividends, 40.0);
        assert_eq!(a.value, 4500.0);
    }

    #[test]
    fn oversell_is_rejected_and_sell_out_resets_cost() {
        let mut a = holding(vec![tx("2026-01-01", "buy", 1.0, 10.0, 0.0), tx("2026-01-02", "sell", 2.0, 10.0, 0.0)]);
        assert!(!recompute(&mut a));
        let mut b = holding(vec![tx("2026-01-01", "buy", 2.0, 10.0, 0.0), tx("2026-01-02", "sell", 2.0, 12.0, 0.0)]);
        assert!(recompute(&mut b));
        assert_eq!((b.quantity, b.cost), (0.0, 0.0));
    }

    #[test]
    fn csv_roundtrip_with_quotes() {
        let rows = parse_csv("\u{feff}a,b\r\n\"x,1\",\"he said \"\"hi\"\"\"\n");
        assert_eq!(rows[1], vec!["x,1".to_string(), "he said \"hi\"".to_string()]);
        assert_eq!(csv_field("he said \"hi\""), "\"he said \"\"hi\"\"\"");
    }

    #[test]
    fn flow_validation() {
        let ok = Flow { id: 0, date: "2026-10-01".into(), kind: "out".into(), category: "餐飲".into(), amount: 120.0, note: String::new() };
        assert!(validate_flow(&ok).is_ok());
        assert!(validate_flow(&Flow { amount: 0.0, ..ok.clone() }).is_err());
        assert!(validate_flow(&Flow { kind: "x".into(), ..ok.clone() }).is_err());
        assert!(validate_flow(&Flow { date: "2026-13-40".into(), ..ok.clone() }).is_err());
        assert!(validate_flow(&Flow { category: String::new(), ..ok }).is_err());
    }

    #[test]
    fn legacy_goal_is_migrated_once() {
        let mut d: Data = serde_json::from_str(
            r#"{"next_id":0,"assets":[],"snapshots":[{"date":"2026-01-01","assets":100.0,"liabilities":40.0}],"goal":500.0,"goal_date":"2030-01-01"}"#,
        )
        .unwrap();
        migrate(&mut d);
        migrate(&mut d);
        assert_eq!(d.goals.len(), 1);
        assert_eq!((d.goals[0].amount, d.goals[0].date.as_str()), (500.0, "2030-01-01"));
        assert_eq!(d.goals[0].history[0].value, 60.0);
        assert_eq!(d.goal, 0.0);
        assert!(!serde_json::to_string(&d).unwrap().contains("\"goal\":"));
    }

    #[test]
    fn goal_value_counts_selected_assets_and_subtracts_debt() {
        let mut d = Data::default();
        let mk = |id, v, liab| Asset { id, name: "x".into(), currency: "TWD".into(), value: v, liability: liab, ..Default::default() };
        d.assets = vec![mk(1, 100.0, false), mk(2, 30.0, true), mk(3, 50.0, false)];
        let all = Goal::default();
        assert_eq!(goal_value(&d, &all), 120.0);
        let some = Goal { assets: vec![1, 3], ..Default::default() };
        assert_eq!(goal_value(&d, &some), 150.0);
    }

    #[test]
    fn private_ip_filter() {
        assert!(is_private_ip("192.168.1.5") && is_private_ip("10.0.0.2") && is_private_ip("172.20.1.1"));
        assert!(!is_private_ip("172.32.0.1") && !is_private_ip("169.254.1.1") && !is_private_ip("8.8.8.8"));
    }

    #[test]
    fn symbol_encoding() {
        assert_eq!(percent_encode("^GSPC"), "%5EGSPC");
        assert_eq!(percent_encode("BTC-USD"), "BTC-USD");
    }
}
