use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::UdpSocket,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;

/// Base currency of data files that predate the choice (and the default for a new install until one is picked).
const DEFAULT_BASE: &str = "TWD";
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
    /// Id of the deposit/cash asset this trade was paid from / settled into; 0 = money outside the app.
    #[serde(default)]
    cash: u64,
    /// Signed change applied to that cash asset (its own currency); set by the core, kept so a delete can undo it.
    #[serde(default)]
    cash_delta: f64,
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
    /// Record dividends from the quote source automatically (holdings with a market symbol).
    #[serde(default = "yes")]
    auto_div: bool,
    /// Deposit that automatic dividends are paid into; 0 = outside the app.
    #[serde(default)]
    div_cash: u64,
    /// Ex-dividend dates already handled, so a deleted automatic dividend does not come back.
    #[serde(default)]
    div_seen: Vec<String>,
}

fn yes() -> bool {
    true
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
    /// Daily progress values (base currency), used for the "when will I get there" estimate.
    #[serde(default)]
    history: Vec<GoalPoint>,
}

/// A recurring monthly purchase (定期定額) that books itself as "buy" transactions.
#[derive(Serialize, Deserialize, Clone, Default)]
struct Plan {
    #[serde(default)]
    id: u64,
    /// The holding that gets bought.
    asset: u64,
    /// Money taken each period, in the asset's currency; the fee is part of it.
    amount: f64,
    /// Day of the month (1-31; short months use their last day).
    day: u32,
    start: String,
    /// Empty = no end.
    #[serde(default)]
    end: String,
    #[serde(default)]
    fee: f64,
    /// Only whole units (Taiwan stocks); otherwise fractional units are bought.
    #[serde(default)]
    whole: bool,
    /// Deposit the money comes from; 0 = outside the app.
    #[serde(default)]
    cash: u64,
    /// Last scheduled date that has been booked (YYYY-MM-DD).
    #[serde(default)]
    last: String,
    /// Why the plan is stuck (e.g. not enough deposit); empty when fine.
    #[serde(default)]
    status: String,
}

/// One income/expense entry of the bookkeeping ledger (in the base currency).
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

/// Totals are stored in the base currency at the rates in force on that day.
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
    /// Legacy refresh interval in minutes (pre-0.18); migrated into `refresh_sec` on load and never written back.
    #[serde(default, skip_serializing)]
    refresh_min: u32,
    /// Auto quote refresh interval in seconds (0 = off); the frontend drives the timer.
    #[serde(default)]
    refresh_sec: u32,
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
    #[serde(default)]
    plans: Vec<Plan>,
    #[serde(default)]
    next_plan: u64,
    /// Daily copy of the data file (encrypted too, when a password is set).
    #[serde(default)]
    backup_on: bool,
    /// Empty = the "backups" folder next to the data file.
    #[serde(default)]
    backup_dir: String,
    #[serde(default = "default_keep")]
    backup_keep: u32,
    /// Identity of this device in a sync pair: 0 for the original (desktop) data file, a random number on a phone.
    /// It is the high part of every id created here, so two devices can add records offline without id clashes.
    #[serde(default)]
    device: u32,
    /// Only the primary device books recurring plans and dividends; the others receive the result through sync.
    #[serde(default = "yes")]
    primary: bool,
    /// Change stamps per record ("a:12", "g:3", "f:7", "p:2"), used to merge two devices. Deleted records stay as tombstones.
    #[serde(default)]
    stamps: BTreeMap<String, Stamp>,
    /// The other device this one is bound to (never part of the data that is synced).
    #[serde(default)]
    peer: Option<Peer>,
    /// Name shown on the other device; empty = the computer name / "手機".
    #[serde(default)]
    device_name: String,
    /// Random id of this installation (not the device number): lets the other device recognise this one again after its
    /// IP address changed.
    #[serde(default)]
    install_id: String,
    /// The main currency every total, goal and the ledger is shown in; foreign-currency items convert into it.
    #[serde(default = "base_currency")]
    base: String,
    /// Which releases this device is offered: "stable" (default) or "preview" (early builds, 0.x.y-preview.N).
    /// A device setting: never synced and kept when a backup is restored.
    #[serde(default = "default_channel")]
    channel: String,
    /// false only on a brand-new install, until the user has picked `base` (old data files count as picked: they are TWD).
    #[serde(default = "yes")]
    base_set: bool,
}

/// The device this one syncs with: where to reach it and the PIN it expects.
#[derive(Serialize, Deserialize, Clone, Default, Debug)]
struct Peer {
    url: String,
    pin: String,
    name: String,
    /// `install_id` of that device, so it can be found again on the network when its IP changes.
    #[serde(default)]
    id: String,
    /// ms since epoch of the last successful sync
    #[serde(default)]
    last_sync: u64,
}

#[derive(Clone, Default)]
struct PeerStatus {
    /// "" | "syncing" | "ok" | "offline" | "denied" | "error"
    state: String,
    message: String,
    at: u64,
}

enum PeerError {
    Offline,
    Denied(String),
    Other(String),
}
impl PeerError {
    fn state(&self) -> &'static str {
        match self {
            PeerError::Offline => "offline",
            PeerError::Denied(_) => "denied",
            PeerError::Other(_) => "error",
        }
    }
    fn message(&self) -> String {
        match self {
            PeerError::Offline => "找不到對方：可能沒開機、不在同一個 Wi-Fi，或對方沒有開啟手機連線".into(),
            PeerError::Denied(m) | PeerError::Other(m) => m.clone(),
        }
    }
}

/// When a record last changed (ms since epoch), a hash of its user-editable content, and whether it was deleted.
#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
struct Stamp {
    h: u64,
    at: u64,
    #[serde(default)]
    del: bool,
}

fn default_keep() -> u32 {
    14
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
            refresh_sec: 60,
            sync_enabled: false,
            sync_port: DEFAULT_PORT,
            sync_pin: String::new(),
            cashflow: vec![],
            next_flow: 0,
            plans: vec![],
            next_plan: 0,
            backup_on: false,
            backup_dir: String::new(),
            backup_keep: default_keep(),
            device: 0,
            primary: true,
            stamps: BTreeMap::new(),
            peer: None,
            device_name: String::new(),
            install_id: String::new(),
            base: base_currency(),
            channel: default_channel(),
            base_set: false,
        }
    }
}

fn base_currency() -> String {
    DEFAULT_BASE.to_string()
}
fn default_channel() -> String {
    "stable".to_string()
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

/// Rough value of one unit in USD. Only used to seed the rate list for a newly chosen base currency;
/// the first quote refresh replaces these with live rates.
const APPROX_USD: [(&str, f64); 14] = [
    ("USD", 1.0),
    ("TWD", 0.03125),
    ("JPY", 0.00656),
    ("EUR", 1.09375),
    ("GBP", 1.27),
    ("CNY", 0.1406),
    ("HKD", 0.1281),
    ("KRW", 0.00073),
    ("AUD", 0.66),
    ("CAD", 0.73),
    ("SGD", 0.75),
    ("THB", 0.028),
    ("MYR", 0.21),
    ("VND", 0.00004),
];

fn approx_usd(code: &str) -> Option<f64> {
    APPROX_USD.iter().find(|(c, _)| *c == code).map(|(_, v)| *v)
}

/// The starter rate list for `base` (1 unit of each currency in `base`). `base_usd` is the live value of one `base` in USD
/// when it is not in the built-in table.
fn seed_rates(base: &str, base_usd: Option<f64>) -> BTreeMap<String, f64> {
    if base == DEFAULT_BASE {
        return default_rates();
    }
    let mut out = BTreeMap::new();
    out.insert(base.to_string(), 1.0);
    if let Some(b) = approx_usd(base).or(base_usd).filter(|b| *b > 0.0) {
        for c in ["TWD", "USD", "JPY", "EUR", "CNY", "HKD"] {
            if c != base {
                out.insert(c.to_string(), approx_usd(c).unwrap_or(1.0) / b);
            }
        }
    }
    out
}

/// Round to `digits` significant digits (converted rates would otherwise show 15 digits of float noise).
fn round_sig(v: f64, digits: i32) -> f64 {
    if v == 0.0 || !v.is_finite() {
        return v;
    }
    let m = 10f64.powi(digits - 1 - v.abs().log10().floor() as i32);
    (v * m).round() / m
}

fn norm_code(code: &str) -> Result<String, String> {
    let code = code.trim().to_uppercase();
    if !(2..=5).contains(&code.len()) || !code.chars().all(|c| c.is_ascii_uppercase()) {
        return Err("幣別代碼需為 2–5 個英文字母".into());
    }
    Ok(code)
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn net_history(d: &Data) -> Vec<GoalPoint> {
    d.snapshots.iter().map(|s| GoalPoint { date: s.date.clone(), value: s.assets - s.liabilities }).collect()
}

/// Move the legacy single goal into the goals list.
/// Next id for a new record created on this device: the device number in the high bits, a counter in the low 32.
/// Device 0 (the desktop's original file) therefore keeps plain 1, 2, 3 ids. All ids stay below 2^53 so JavaScript is exact.
fn next_record_id(counter: &mut u64, device: u32) -> u64 {
    *counter += 1;
    ((device as u64 & 0xFFFF) << 32) | (*counter & 0xFFFF_FFFF)
}

/// Where this device's counter must start after ids were loaded from elsewhere (a restored backup).
fn counter_floor(ids: impl Iterator<Item = u64>, device: u32, current: u64) -> u64 {
    ids.filter(|id| (id >> 32) as u32 == device & 0xFFFF).map(|id| id & 0xFFFF_FFFF).max().unwrap_or(0).max(current)
}

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

/// Stable (version independent) 64-bit FNV-1a hash.
fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x0100_0000_01b3))
}

/// What counts as the user's own edit of an asset: not the quote refresh (price, time, value) or the bookkeeping date.
fn asset_digest(a: &Asset) -> u64 {
    let mut a = a.clone();
    a.updated.clear();
    if !a.market.is_empty() {
        a.price = 0.0;
        a.price_updated.clear();
        a.value = 0.0;
    }
    fnv(&serde_json::to_vec(&a).unwrap_or_default())
}

fn goal_digest(g: &Goal) -> u64 {
    let mut g = g.clone();
    g.history.clear(); // derived every day
    fnv(&serde_json::to_vec(&g).unwrap_or_default())
}

fn json_digest<T: Serialize>(x: &T) -> u64 {
    fnv(&serde_json::to_vec(x).unwrap_or_default())
}

/// Bring the change stamps up to date: records whose content changed get `now`, new ones get `now`, records that
/// disappeared become tombstones stamped `now`. Called on every write, so `at` is the real time of the edit.
fn stamp(d: &mut Data, now: u64) {
    let mut live: BTreeMap<String, u64> = BTreeMap::new();
    for a in &d.assets {
        live.insert(format!("a:{}", a.id), asset_digest(a));
    }
    for g in &d.goals {
        live.insert(format!("g:{}", g.id), goal_digest(g));
    }
    for f in &d.cashflow {
        live.insert(format!("f:{}", f.id), json_digest(f));
    }
    for p in &d.plans {
        live.insert(format!("p:{}", p.id), json_digest(p));
    }
    for (k, h) in &live {
        match d.stamps.get(k) {
            Some(s) if !s.del && s.h == *h => {}
            _ => {
                d.stamps.insert(k.clone(), Stamp { h: *h, at: now, del: false });
            }
        }
    }
    for (k, s) in d.stamps.iter_mut() {
        if !s.del && !live.contains_key(k) {
            *s = Stamp { h: 0, at: now, del: true };
        }
    }
}

/// The part of the data that two paired devices exchange. Device settings (PIN, port, backup folder…) stay local.
#[derive(Serialize, Deserialize, Clone, Default)]
struct SyncPayload {
    #[serde(default)]
    assets: Vec<Asset>,
    #[serde(default)]
    goals: Vec<Goal>,
    #[serde(default)]
    cashflow: Vec<Flow>,
    #[serde(default)]
    plans: Vec<Plan>,
    #[serde(default)]
    snapshots: Vec<Snapshot>,
    #[serde(default)]
    rates: BTreeMap<String, f64>,
    #[serde(default)]
    stamps: BTreeMap<String, Stamp>,
    /// Main currency of the sender; empty = an older version, which was always TWD.
    #[serde(default)]
    base: String,
    /// The sender is a brand-new install that has not picked its main currency yet (it adopts the other side's).
    #[serde(default)]
    fresh: bool,
}

/// A brand-new install: no currency chosen yet and nothing entered.
fn is_fresh(d: &Data) -> bool {
    !d.base_set && d.assets.is_empty() && d.cashflow.is_empty() && d.goals.is_empty() && d.plans.is_empty()
}

fn sync_payload(d: &Data) -> SyncPayload {
    SyncPayload {
        assets: d.assets.clone(),
        goals: d.goals.clone(),
        cashflow: d.cashflow.clone(),
        plans: d.plans.clone(),
        snapshots: d.snapshots.clone(),
        rates: d.rates.clone(),
        stamps: d.stamps.clone(),
        base: d.base.clone(),
        fresh: is_fresh(d),
    }
}

/// How to settle a record that both devices changed since they last synced (instead of dropping one side's edit).
struct Conflict<T> {
    /// ms of the last sync with that device; 0 = unknown, then the later edit simply wins
    base: u64,
    now: u64,
    /// (newer, older) -> merged
    resolve: fn(&T, &T) -> T,
    digest: fn(&T) -> u64,
}

/// Merge one record collection: for every key either side knows, the newer stamp wins (equal time: the larger hash,
/// so both devices pick the same one). A newer tombstone deletes the record. A record both sides edited since the last
/// sync is merged with `conflict.resolve` when given.
fn merge_records<T: Clone>(local: &mut Vec<T>, remote: &[T], id_of: fn(&T) -> u64, prefix: &str, ls: &mut BTreeMap<String, Stamp>, rs: &BTreeMap<String, Stamp>, conflict: Option<&Conflict<T>>) {
    let keys: std::collections::BTreeSet<String> = ls.keys().chain(rs.keys()).filter(|k| k.starts_with(prefix)).cloned().collect();
    for k in keys {
        let Some(r) = rs.get(&k) else { continue };
        let id: u64 = k[prefix.len()..].parse().unwrap_or(0);
        if let (Some(l), Some(c)) = (ls.get(&k), conflict) {
            if c.base > 0 && l.at > c.base && r.at > c.base && !l.del && !r.del && l.h != r.h {
                if let (Some(i), Some(rr)) = (local.iter().position(|x| id_of(x) == id), remote.iter().find(|x| id_of(x) == id)) {
                    let merged = if (r.at, r.h) > (l.at, l.h) { (c.resolve)(rr, &local[i]) } else { (c.resolve)(&local[i], rr) };
                    ls.insert(k.clone(), Stamp { h: (c.digest)(&merged), at: c.now, del: false });
                    local[i] = merged;
                    continue;
                }
            }
        }
        if let Some(l) = ls.get(&k) {
            if (r.at, r.h) <= (l.at, l.h) {
                continue;
            }
        }
        if r.del {
            local.retain(|x| id_of(x) != id);
        } else if let Some(rec) = remote.iter().find(|x| id_of(x) == id) {
            match local.iter().position(|x| id_of(x) == id) {
                Some(i) => local[i] = rec.clone(),
                None => local.push(rec.clone()),
            }
        } else {
            continue; // the stamp says "live" but the record is missing: ignore rather than lose data
        }
        ls.insert(k, r.clone());
    }
}

/// Two edits of the same asset: take the newer one's fields and keep every transaction either side recorded
/// (as a multiset, so a buy that both sides entered identically is not counted twice).
fn merge_asset_conflict(newer: &Asset, older: &Asset) -> Asset {
    let key = |t: &Tx| format!("{}|{}|{}|{}|{}|{}|{}", t.date, t.kind, t.units, t.price, t.fee, t.note, t.cash);
    let mut out = newer.clone();
    let mut have: BTreeMap<String, usize> = BTreeMap::new();
    for t in &newer.txs {
        *have.entry(key(t)).or_default() += 1;
    }
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for t in &older.txs {
        let k = key(t);
        let n = seen.entry(k.clone()).or_default();
        *n += 1;
        if *n > have.get(&k).copied().unwrap_or(0) {
            out.txs.push(t.clone());
            *have.entry(k).or_default() += 1;
        }
    }
    out
}

/// Merge what another device sent into this one. Returns how many records changed here.
fn merge_payload(d: &mut Data, remote: &SyncPayload, now: u64, base: u64) -> usize {
    stamp(d, now); // make sure our own edits are stamped before comparing
    let mut remote = remote.clone();
    if remote.stamps.is_empty() {
        // a peer without stamps (older version): its records count as old, ours win
        let mut tmp = Data { assets: remote.assets.clone(), goals: remote.goals.clone(), cashflow: remote.cashflow.clone(), plans: remote.plans.clone(), ..Default::default() };
        stamp(&mut tmp, 0);
        remote.stamps = tmp.stamps;
    }
    let before = d.stamps.clone();
    let mut stamps = std::mem::take(&mut d.stamps);
    let asset_conflict = Conflict { base, now, resolve: merge_asset_conflict, digest: asset_digest };
    merge_records(&mut d.assets, &remote.assets, |a| a.id, "a:", &mut stamps, &remote.stamps, Some(&asset_conflict));
    merge_records(&mut d.goals, &remote.goals, |g| g.id, "g:", &mut stamps, &remote.stamps, None);
    merge_records(&mut d.cashflow, &remote.cashflow, |f| f.id, "f:", &mut stamps, &remote.stamps, None);
    merge_records(&mut d.plans, &remote.plans, |p| p.id, "p:", &mut stamps, &remote.stamps, None);
    d.stamps = stamps;
    let changed = d.stamps.iter().filter(|(k, v)| before.get(*k) != Some(*v)).count();
    add_missing_snapshots(&mut d.snapshots, remote.snapshots.clone(), "9999-12-31");
    for (c, r) in &remote.rates {
        d.rates.entry(c.clone()).or_insert(*r);
    }
    // references that now point at records another device deleted
    let ids: std::collections::HashSet<u64> = d.assets.iter().map(|a| a.id).collect();
    for g in d.goals.iter_mut() {
        g.assets.retain(|id| ids.contains(id));
    }
    d.plans.retain(|p| ids.contains(&p.asset));
    for p in d.plans.iter_mut() {
        if p.cash != 0 && !ids.contains(&p.cash) {
            p.cash = 0;
        }
    }
    for a in d.assets.iter_mut() {
        for t in a.txs.iter_mut() {
            if t.cash != 0 && !ids.contains(&t.cash) {
                t.cash = 0;
            }
        }
        recompute(a);
    }
    changed
}

/// Read what the user typed or pasted when binding: "192.168.1.5:8787", "http://pc:8787/#pin=123456", …
/// Returns the base url (no path) and the PIN (from the link's `#pin=` or the separate field).
fn parse_peer_link(input: &str, pin: &str) -> Result<(String, String), String> {
    let input = input.trim();
    let (base, frag) = input.split_once('#').unwrap_or((input, ""));
    let from_link = frag.split('&').find_map(|kv| kv.strip_prefix("pin=")).unwrap_or("");
    let pin = if pin.trim().is_empty() { from_link } else { pin.trim() }.to_string();
    let with_scheme = if base.contains("://") { base.to_string() } else { format!("http://{base}") };
    let (scheme, rest) = with_scheme.split_once("://").unwrap_or(("http", ""));
    if !matches!(scheme, "http" | "https") {
        return Err("位址需以 http:// 開頭".into());
    }
    let host = rest.split(['/', '?']).next().unwrap_or("");
    if host.is_empty() || host.contains(char::is_whitespace) || host.contains('@') {
        return Err("找不到電腦位址，請貼上手機連線的網址，例如 192.168.1.5:8787".into());
    }
    let host = if host.contains(':') { host.to_string() } else { format!("{host}:{DEFAULT_PORT}") };
    if pin.is_empty() {
        return Err("請輸入 PIN（在電腦的「手機連線」裡）".into());
    }
    Ok((format!("{scheme}://{host}"), pin))
}

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
    if d.refresh_min > 0 {
        if d.refresh_sec == 0 {
            d.refresh_sec = d.refresh_min * 60;
        }
        d.refresh_min = 0;
    }
    if d.stamps.is_empty() {
        stamp(d, 0); // records that existed before sync support count as old
    }
    if d.install_id.is_empty() {
        d.install_id = random_hex(8);
    }
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
        o.remove("stamps");
        if let Some(p) = o.get_mut("peer").and_then(|p| p.as_object_mut()) {
            p.remove("pin");
        }
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

fn backup_files(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| n.starts_with("moneypi-") && n.ends_with(".json") && n.len() == "moneypi-2026-01-01.json".len())
                .collect()
        })
        .unwrap_or_default()
}

fn r4(x: f64) -> f64 {
    (x * 10_000.0).round() / 10_000.0
}

/// Units one plan period buys at `price`: the fee comes out of the amount first.
fn plan_units(amount: f64, fee: f64, price: f64, whole: bool) -> f64 {
    if price <= 0.0 {
        return 0.0;
    }
    let u = ((amount - fee) / price).max(0.0);
    if whole { u.floor() } else { (u * 10_000.0).floor() / 10_000.0 }
}

/// Scheduled dates of a plan up to `today` that have not been booked yet.
fn due_dates(p: &Plan, today: chrono::NaiveDate) -> Vec<chrono::NaiveDate> {
    use chrono::Datelike;
    let Ok(start) = chrono::NaiveDate::parse_from_str(&p.start, "%Y-%m-%d") else { return vec![] };
    let end = chrono::NaiveDate::parse_from_str(&p.end, "%Y-%m-%d").unwrap_or(today).min(today);
    let (mut y, mut m) = (start.year(), start.month());
    let mut out = vec![];
    while out.len() < 600 {
        let mut d = p.day.clamp(1, 31);
        let date = loop {
            if let Some(x) = chrono::NaiveDate::from_ymd_opt(y, m, d) {
                break x;
            }
            d -= 1;
        };
        if date > end {
            break;
        }
        if date >= start && date.format("%Y-%m-%d").to_string() > p.last {
            out.push(date);
        }
        if m == 12 { y += 1; m = 1 } else { m += 1 }
    }
    out
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

// ------------------------------------------------------------ encryption at rest

#[derive(Default)]
struct EncState {
    /// The data file on disk is an encrypted envelope.
    encrypted: bool,
    key: Option<[u8; 32]>,
    salt: Vec<u8>,
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 || !s.is_ascii() {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

fn kdf(pw: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut k = [0u8; 32];
    argon2::Argon2::default().hash_password_into(pw.as_bytes(), salt, &mut k).map_err(|e| format!("金鑰衍生失敗：{e}"))?;
    Ok(k)
}

fn seal(key: &[u8; 32], salt: &[u8], plain: &[u8]) -> Result<String, String> {
    use chacha20poly1305::{aead::Aead, KeyInit, XChaCha20Poly1305, XNonce};
    let mut nonce = [0u8; 24];
    getrandom::getrandom(&mut nonce).map_err(|e| e.to_string())?;
    let ct = XChaCha20Poly1305::new(key.into()).encrypt(XNonce::from_slice(&nonce), plain).map_err(|_| "加密失敗".to_string())?;
    Ok(json!({ "moneypi_enc": 1, "kdf": "argon2id", "cipher": "xchacha20poly1305", "salt": hex(salt), "nonce": hex(&nonce), "ct": hex(&ct) }).to_string())
}

fn is_envelope(text: &str) -> bool {
    serde_json::from_str::<Value>(text).ok().is_some_and(|v| v.get("moneypi_enc").is_some())
}

/// Decrypt an envelope; returns the plaintext, the derived key and the salt.
fn open_envelope(text: &str, pw: &str) -> Result<(Vec<u8>, [u8; 32], Vec<u8>), String> {
    use chacha20poly1305::{aead::Aead, KeyInit, XChaCha20Poly1305, XNonce};
    let v: Value = serde_json::from_str(text).map_err(|_| "檔案格式錯誤".to_string())?;
    let field = |k: &str| v[k].as_str().and_then(unhex).ok_or_else(|| "加密檔案格式錯誤".to_string());
    let (salt, nonce, ct) = (field("salt")?, field("nonce")?, field("ct")?);
    if nonce.len() != 24 || salt.len() < 8 {
        return Err("加密檔案格式錯誤".into());
    }
    let key = kdf(pw, &salt)?;
    let plain = XChaCha20Poly1305::new((&key).into())
        .decrypt(XNonce::from_slice(&nonce), ct.as_ref())
        .map_err(|_| "密碼錯誤".to_string())?;
    Ok((plain, key, salt))
}

/// Read the data file. A missing file starts empty; an unreadable one is kept aside, never overwritten silently.
fn load_state(path: &Path) -> (Data, EncState) {
    let Ok(text) = fs::read_to_string(path) else { return (Data::default(), EncState::default()) };
    if is_envelope(&text) {
        let salt = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["salt"].as_str().and_then(unhex)).unwrap_or_default();
        return (Data::default(), EncState { encrypted: true, key: None, salt });
    }
    match serde_json::from_str::<Data>(&text) {
        Ok(mut d) => {
            migrate(&mut d);
            (d, EncState::default())
        }
        Err(e) => {
            let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
            let _ = fs::copy(path, path.with_extension(format!("corrupt-{stamp}.json")));
            eprintln!("資料檔無法讀取，已另存一份：{e}");
            (Data::default(), EncState::default())
        }
    }
}

// ------------------------------------------------------------------ the core

struct Core {
    path: PathBuf,
    data: Mutex<Data>,
    server: Mutex<Option<Arc<tiny_http::Server>>>,
    tunnel: Mutex<Option<Tunnel>>,
    /// Consecutive failed LAN PIN attempts and the end of the current lockout.
    auth_fail: Mutex<(u32, Option<Instant>)>,
    /// What the cloudflared installer is doing right now (polled by the window).
    progress: Mutex<Progress>,
    /// Held while recurring plans are being booked so two clients cannot book the same period twice.
    plan_lock: Mutex<()>,
    enc: Mutex<EncState>,
    /// Bumped on every write (and lock/unlock) so other windows/phones can notice changes without polling the data.
    rev: std::sync::atomic::AtomicU64,
    peer_status: Mutex<PeerStatus>,
    /// ms of the last network sweep for a moved peer (rate limit)
    last_sweep: std::sync::atomic::AtomicU64,
}

#[derive(Default, Clone)]
struct Progress {
    active: bool,
    stage: String,
    done: u64,
    total: u64,
}

/// A running Cloudflare quick tunnel. Killed when dropped.
struct Tunnel {
    child: Child,
    url: String,
    /// Per-tunnel secret; the only credential accepted for requests that arrive through the tunnel.
    token: String,
    /// The HTTP server was started only for the tunnel (loopback), so stop it with the tunnel.
    started_server: bool,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

enum Auth {
    Ok,
    Denied,
    Locked,
}

fn random_hex(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    getrandom::getrandom(&mut b).expect("OS random generator unavailable");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Constant-time comparison; an empty expected secret never matches.
fn check_secret(expected: &str, given: &str) -> bool {
    !expected.is_empty()
        && expected.len() == given.len()
        && expected.bytes().zip(given.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// Pull the quick-tunnel address out of a cloudflared log line.
fn extract_tunnel_url(line: &str) -> Option<String> {
    let i = line.find("https://")?;
    let url: String = line[i..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | ':' | '/'))
        .collect();
    let host = url.trim_start_matches("https://");
    (host.ends_with(".trycloudflare.com") && !host.starts_with("api.")).then_some(url)
}

const CLOUDFLARED_ASSET: &str = "cloudflared-windows-amd64.exe";
const CLOUDFLARED_RELEASES: &str = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";

/// Download the official cloudflared build and install it only if it matches the SHA-256
/// digest GitHub publishes for the release asset.
fn download_cloudflared(dest: &Path, report: &dyn Fn(&str, u64, u64)) -> Result<(), String> {
    report("查詢官方版本…", 0, 0);
    let rel: Value = ureq::get(CLOUDFLARED_RELEASES)
        .set("User-Agent", "MoneyPi")
        .set("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(20))
        .call()
        .map_err(|e| format!("無法取得版本資訊：{e}"))?
        .into_json()
        .map_err(|e| format!("版本資訊格式錯誤：{e}"))?;
    let asset = rel["assets"]
        .as_array()
        .and_then(|a| a.iter().find(|x| x["name"] == CLOUDFLARED_ASSET))
        .ok_or("找不到 Windows 版安裝檔")?;
    let url = asset["browser_download_url"].as_str().ok_or("找不到下載網址")?;
    if !url.starts_with("https://github.com/cloudflare/cloudflared/releases/download/") {
        return Err("下載網址不在預期的官方來源，已中止".into());
    }
    let want = asset["digest"]
        .as_str()
        .and_then(|d| d.strip_prefix("sha256:"))
        .ok_or("官方發布未附校驗碼，已中止")?
        .to_ascii_lowercase();

    let resp = ureq::get(url)
        .set("User-Agent", "MoneyPi")
        .timeout(Duration::from_secs(600))
        .call()
        .map_err(|e| format!("下載失敗：{e}"))?;
    let total = resp
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok())
        .or_else(|| asset["size"].as_u64())
        .unwrap_or(0);
    let mut reader = resp.into_reader();
    let part = dest.with_extension("exe.part");
    let result = (|| -> Result<String, String> {
        let mut f = fs::File::create(&part).map_err(|e| e.to_string())?;
        let (mut hasher, mut buf) = (Sha256::new(), vec![0u8; 64 * 1024]);
        let mut done = 0u64;
        let mut last = Instant::now() - Duration::from_secs(1);
        loop {
            let n = reader.read(&mut buf).map_err(|e| format!("下載中斷：{e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            f.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            done += n as u64;
            if last.elapsed() >= Duration::from_millis(100) {
                report("下載中", done, total);
                last = Instant::now();
            }
        }
        report("下載中", done, total);
        report("驗證校驗碼…", done, total);
        f.flush().map_err(|e| e.to_string())?;
        Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
    })();
    let got = match result {
        Ok(h) => h,
        Err(e) => {
            let _ = fs::remove_file(&part);
            return Err(e);
        }
    };
    if got != want {
        let _ = fs::remove_file(&part);
        return Err("下載檔案的校驗碼不符，已中止（檔案可能損毀或被竄改）".into());
    }
    report("安裝中…", 1, 1);
    fs::rename(&part, dest).map_err(|e| e.to_string())
}

/// winget (App Installer) ships with current Windows 10/11 but not every machine has it.
fn winget_available() -> bool {
    static CACHE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CACHE.get_or_init(|| {
        let mut c = Command::new("winget");
        c.arg("--version").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000);
        }
        c.status().map(|s| s.success()).unwrap_or(false)
    })
}

/// The APK of one of this project's own releases (what the phone's update notice offers to download).
fn is_release_apk(u: &str) -> bool {
    u.starts_with("https://github.com/hankyleisplay/moneypi/releases/download/v")
        && u.ends_with(".apk")
        && u.len() < 200
        && u.chars().all(|c| c.is_ascii_alphanumeric() || "-._/:".contains(c))
        && !u.contains("..")
}

/// Only known official research pages and the existing installation guide may be opened.
fn external_url(target: &str) -> Result<&str, String> {
    match target {
        "releases" => Ok("https://github.com/cloudflare/cloudflared/releases/latest"),
        "https://www.ishares.com/us/products/314116/ishares-0-3-month-treasury-bond-etf"
        | "https://www.yuantaetfs.com/product/detail/0050/Basic_information"
        | "https://investor.vanguard.com/investment-products/etfs/profile/vt"
        | "https://investor.vanguard.com/investment-products/etfs/profile/voo"
        | "https://investor.tsmc.com/chinese" => Ok(target),
        "update" => Ok("https://github.com/hankyleisplay/moneypi/releases/latest"),
        t if is_release_apk(t) => Ok(t),
        _ => Err("不支援的項目".into()),
    }
}

// ---------------------------------------------------------- price history

/// Cash dividends per share as (ex-dividend date, amount), oldest first.
fn fetch_dividends(symbol: &str, market: &str, from: &str) -> Result<Vec<(String, f64)>, String> {
    let day = chrono::NaiveDate::parse_from_str(from, "%Y-%m-%d").map_err(|e| e.to_string())?;
    let t0 = (day - chrono::Duration::days(3)).and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp();
    let t1 = (chrono::Local::now().date_naive() + chrono::Duration::days(2)).and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp();
    let q = format!("period1={t0}&period2={t1}&interval=1mo&events=div");
    let one = |sym: String| -> Result<Vec<(String, f64)>, String> {
        let url = format!("https://query1.finance.yahoo.com/v8/finance/chart/{}?{q}", percent_encode(&sym));
        let v: Value = ureq::get(&url)
            .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MoneyPi")
            .timeout(Duration::from_secs(15))
            .call()
            .map_err(|e| format!("連線失敗：{e}"))?
            .into_json()
            .map_err(|e| format!("回應格式錯誤：{e}"))?;
        let r = &v["chart"]["result"][0];
        if r.is_null() {
            return Err("查無資料".into());
        }
        let off = r["meta"]["gmtoffset"].as_i64().unwrap_or(0);
        let mut out: Vec<(String, f64)> = r["events"]["dividends"]
            .as_object()
            .map(|m| {
                m.values()
                    .filter_map(|e| {
                        let (t, a) = (e["date"].as_i64()?, e["amount"].as_f64()?);
                        Some((chrono::DateTime::from_timestamp(t + off, 0)?.format("%Y-%m-%d").to_string(), r4(a)))
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    };
    if market == "tw" {
        one(format!("{symbol}.TW")).or_else(|_| one(format!("{symbol}.TWO")))
    } else {
        one(symbol.to_string())
    }
}

/// Dividend events not handled yet, with the units held the day before the ex-date.
fn dividend_candidates(txs: &[Tx], events: &[(String, f64)], seen: &[String]) -> Vec<(String, f64, f64)> {
    let mut sorted: Vec<&Tx> = txs.iter().filter(|t| t.kind == "buy" || t.kind == "sell").collect();
    sorted.sort_by(|a, b| a.date.cmp(&b.date));
    events
        .iter()
        .filter(|(d, _)| !seen.contains(d))
        .map(|(d, per)| {
            let units: f64 = sorted
                .iter()
                .filter(|t| t.date.as_str() < d.as_str())
                .map(|t| if t.kind == "buy" { t.units } else { -t.units })
                .sum();
            (d.clone(), units.max(0.0), *per)
        })
        .collect()
}

/// Daily closes from Yahoo as (YYYY-MM-DD, close), oldest first.
fn fetch_chart(symbol: &str, query: &str) -> Result<(Vec<(String, f64)>, String), String> {
    let url = format!("https://query1.finance.yahoo.com/v8/finance/chart/{}?{query}", percent_encode(symbol));
    let v: Value = ureq::get(&url)
        .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MoneyPi")
        .timeout(Duration::from_secs(15))
        .call()
        .map_err(|e| format!("連線失敗：{e}"))?
        .into_json()
        .map_err(|e| format!("回應格式錯誤：{e}"))?;
    let r = &v["chart"]["result"][0];
    let ts = r["timestamp"].as_array().ok_or("查無歷史價格")?;
    let closes = r["indicators"]["quote"][0]["close"].as_array().ok_or("查無歷史價格")?;
    let off = r["meta"]["gmtoffset"].as_i64().unwrap_or(0);
    let cur = r["meta"]["currency"].as_str().unwrap_or("").to_uppercase();
    let mut out = Vec::new();
    for (t, c) in ts.iter().zip(closes) {
        if let (Some(t), Some(c)) = (t.as_i64(), c.as_f64()) {
            if let Some(dt) = chrono::DateTime::from_timestamp(t + off, 0) {
                out.push((dt.format("%Y-%m-%d").to_string(), r4(c)));
            }
        }
    }
    if out.is_empty() {
        return Err("查無歷史價格".into());
    }
    Ok((out, cur))
}

fn fetch_series(symbol: &str, market: &str, query: &str) -> Result<(Vec<(String, f64)>, String), String> {
    if market == "tw" {
        fetch_chart(&format!("{symbol}.TW"), query).or_else(|_| fetch_chart(&format!("{symbol}.TWO"), query))
    } else {
        fetch_chart(symbol, query)
    }
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

    fn bump(&self) {
        self.rev.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    /// Long poll: returns as soon as the revision differs from `since`, or after ~20 s with the unchanged revision.
    fn wait_rev(&self, since: i64) -> Value {
        let end = Instant::now() + Duration::from_secs(20);
        loop {
            let r = self.rev.load(std::sync::atomic::Ordering::SeqCst) as i64;
            if r != since || Instant::now() >= end {
                return json!({ "rev": r });
            }
            thread::sleep(Duration::from_millis(150));
        }
    }

    fn persist(&self, d: &mut Data) -> Result<(), String> {
        if !self.is_locked() {
            stamp(d, now_ms());
        }
        let json = serde_json::to_string_pretty(d).map_err(|e| e.to_string())?;
        let out = {
            let e = self.enc.lock().unwrap();
            if e.encrypted {
                // never write while locked: the in-memory data is just the empty placeholder
                let key = e.key.ok_or("已鎖定，請先解鎖")?;
                seal(&key, &e.salt, json.as_bytes())?
            } else {
                json
            }
        };
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, out).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &self.path).map_err(|e| e.to_string())?;
        self.bump();
        Ok(())
    }

    fn is_locked(&self) -> bool {
        let e = self.enc.lock().unwrap();
        e.encrypted && e.key.is_none()
    }

    fn lock_status(&self) -> Value {
        let e = self.enc.lock().unwrap();
        json!({ "encrypted": e.encrypted, "locked": e.encrypted && e.key.is_none() })
    }

    fn unlock(self: &Arc<Self>, pw: &str) -> Result<Value, String> {
        if !self.is_locked() {
            return Ok(self.lock_status());
        }
        let text = fs::read_to_string(&self.path).map_err(|e| e.to_string())?;
        let (plain, key, salt) = match open_envelope(&text, pw) {
            Ok(x) => x,
            Err(e) => {
                thread::sleep(Duration::from_millis(500)); // slow down guessing
                return Err(e);
            }
        };
        let mut data: Data = serde_json::from_slice(&plain).map_err(|e| format!("資料格式錯誤：{e}"))?;
        migrate(&mut data);
        let (enabled, port) = (data.sync_enabled, data.sync_port);
        *self.data.lock().unwrap() = data;
        *self.enc.lock().unwrap() = EncState { encrypted: true, key: Some(key), salt };
        self.bump();
        if enabled {
            let _ = self.start_server("0.0.0.0", port);
        }
        Ok(self.lock_status())
    }

    /// Lock the app again: save, forget the key and the data, and stop serving.
    fn lock(&self) -> Result<Value, String> {
        if !self.enc.lock().unwrap().encrypted {
            return Err("尚未設定密碼".into());
        }
        {
            let mut d = self.data.lock().unwrap();
            self.persist(&mut d)?;
        }
        self.tunnel_stop();
        self.stop_server();
        self.enc.lock().unwrap().key = None;
        *self.data.lock().unwrap() = Data::default();
        self.bump();
        Ok(self.lock_status())
    }

    /// Turn the password on, change it, or (empty `new`) turn it off. `old` is required once a password exists.
    fn set_password(&self, old: &str, new: &str) -> Result<Value, String> {
        let mut d = self.data.lock().unwrap();
        {
            let e = self.enc.lock().unwrap();
            if e.encrypted {
                let k = kdf(old, &e.salt)?;
                let cur = e.key.ok_or("已鎖定，請先解鎖")?;
                if k.iter().zip(cur.iter()).fold(0u8, |a, (x, y)| a | (x ^ y)) != 0 {
                    drop(e);
                    thread::sleep(Duration::from_millis(500));
                    return Err("目前的密碼不正確".into());
                }
            }
        }
        if new.is_empty() {
            if !self.enc.lock().unwrap().encrypted {
                return Err("目前沒有設定密碼".into());
            }
            *self.enc.lock().unwrap() = EncState::default();
        } else {
            if new.chars().count() < 6 {
                return Err("密碼至少 6 個字".into());
            }
            let mut salt = [0u8; 16];
            getrandom::getrandom(&mut salt).map_err(|e| e.to_string())?;
            let key = kdf(new, &salt)?;
            *self.enc.lock().unwrap() = EncState { encrypted: true, key: Some(key), salt: salt.to_vec() };
        }
        self.persist(&mut d)?;
        Ok(self.lock_status())
    }

    // ------------------------------------------------------------- backups

    fn backup_path(&self, d: &Data) -> PathBuf {
        if d.backup_dir.trim().is_empty() {
            self.path.parent().map(|p| p.join("backups")).unwrap_or_else(|| PathBuf::from("backups"))
        } else {
            PathBuf::from(d.backup_dir.trim())
        }
    }

    fn set_backup(&self, on: bool, dir: &str, keep: u32) -> Result<Value, String> {
        let dir = dir.trim();
        if !dir.is_empty() && !Path::new(dir).is_absolute() {
            return Err("備份資料夾請填完整路徑，例如 D:\\MoneyPiBackup；留空則用預設位置".into());
        }
        if !(3..=60).contains(&keep) {
            return Err("保留份數需介於 3 到 60".into());
        }
        {
            let mut d = self.data.lock().unwrap();
            d.backup_on = on;
            d.backup_dir = dir.to_string();
            d.backup_keep = keep;
            self.persist(&mut d)?;
        }
        if on {
            self.auto_backup(false)?;
        }
        Ok(self.backup_info())
    }

    /// Copy the data file into the backup folder once a day (or right now when `force`).
    fn auto_backup(&self, force: bool) -> Result<Option<String>, String> {
        if self.is_locked() {
            return Ok(None);
        }
        let (on, dir, keep) = {
            let d = self.data.lock().unwrap();
            (d.backup_on, self.backup_path(&d), d.backup_keep.clamp(3, 60) as usize)
        };
        if !on && !force {
            return Ok(None);
        }
        fs::create_dir_all(&dir).map_err(|e| format!("無法建立備份資料夾：{e}"))?;
        let name = format!("moneypi-{}.json", today());
        let target = dir.join(&name);
        if target.exists() && !force {
            return Ok(None);
        }
        if !self.path.exists() {
            let mut d = self.data.lock().unwrap();
            self.persist(&mut d)?;
        }
        fs::copy(&self.path, &target).map_err(|e| format!("備份失敗：{e}"))?;
        let mut files = backup_files(&dir);
        files.sort();
        while files.len() > keep {
            let _ = fs::remove_file(dir.join(files.remove(0)));
        }
        Ok(Some(name))
    }

    fn backup_info(&self) -> Value {
        let d = self.data.lock().unwrap();
        let dir = self.backup_path(&d);
        let mut files = backup_files(&dir);
        files.sort();
        files.reverse();
        json!({ "on": d.backup_on, "dir": d.backup_dir, "path": dir.display().to_string(), "keep": d.backup_keep,
                "count": files.len(), "files": files.into_iter().take(5).collect::<Vec<_>>() })
    }

    fn open_backups(&self) -> Result<(), String> {
        let dir = {
            let d = self.data.lock().unwrap();
            self.backup_path(&d)
        };
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut c = Command::new("explorer");
        c.arg(&dir);
        c.spawn().map(|_| ()).map_err(|e| e.to_string())
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
            let dev = d.device;
            g.id = next_record_id(&mut d.next_goal, dev);
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
        self.persist(&mut d)?;
        Ok(view(&d))
    }

    fn add_flow(&self, mut f: Flow) -> Result<Value, String> {
        f.category = f.category.trim().to_string();
        f.note = f.note.trim().to_string();
        validate_flow(&f)?;
        let mut d = self.data.lock().unwrap();
        let dev = d.device;
        f.id = next_record_id(&mut d.next_flow, dev);
        d.cashflow.push(f);
        self.persist(&mut d)?;
        Ok(view(&d))
    }

    fn delete_flow(&self, id: u64) -> Result<Value, String> {
        let mut d = self.data.lock().unwrap();
        d.cashflow.retain(|f| f.id != id);
        self.persist(&mut d)?;
        Ok(view(&d))
    }

    fn export_backup(&self) -> String {
        let mut d = self.data.lock().unwrap().clone();
        d.sync_pin.clear();
        serde_json::to_string_pretty(&d).unwrap_or_default()
    }

    fn import_backup(&self, text: &str, password: Option<&str>) -> Result<Value, String> {
        let decrypted;
        let text = if is_envelope(text) {
            let pw = password.filter(|p| !p.is_empty()).ok_or("ENCRYPTED")?;
            decrypted = String::from_utf8(open_envelope(text, pw)?.0).map_err(|_| "備份檔格式錯誤".to_string())?;
            decrypted.as_str()
        } else {
            text
        };
        let mut inc: Data = serde_json::from_str(text).map_err(|e| format!("備份檔格式錯誤：{e}"))?;
        migrate(&mut inc);
        inc.base = norm_code(&inc.base).map_err(|_| "備份檔的主要幣別不正確".to_string())?;
        if inc.rates.get(&inc.base) != Some(&1.0) || inc.rates.values().any(|r| !r.is_finite() || *r <= 0.0) {
            return Err("備份檔的匯率資料不正確".into());
        }
        inc.base_set = true;
        for a in &inc.assets {
            validate_asset(a, &inc).map_err(|e| format!("備份檔中的「{}」：{e}", a.name))?;
        }
        for f in &inc.cashflow {
            validate_flow(f)?;
        }
        let mut d = self.data.lock().unwrap();
        // The backup only carries finance data; keep this machine's own sync settings.
        inc.channel = d.channel.clone();
        inc.sync_enabled = d.sync_enabled;
        inc.sync_port = d.sync_port;
        inc.sync_pin = d.sync_pin.clone();
        inc.backup_on = d.backup_on;
        inc.backup_dir = d.backup_dir.clone();
        inc.backup_keep = d.backup_keep;
        inc.device = d.device;
        inc.primary = d.primary;
        inc.stamps = d.stamps.clone(); // changed / removed records get new stamps on the commit below
        inc.next_id = counter_floor(inc.assets.iter().map(|a| a.id), inc.device, inc.next_id);
        inc.next_flow = counter_floor(inc.cashflow.iter().map(|f| f.id), inc.device, inc.next_flow);
        inc.next_goal = counter_floor(inc.goals.iter().map(|g| g.id), inc.device, inc.next_goal);
        inc.next_plan = counter_floor(inc.plans.iter().map(|p| p.id), inc.device, inc.next_plan);
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
            asset.div_seen = old.div_seen.clone();
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
            let dev = d.device;
            asset.id = next_record_id(&mut d.next_id, dev);
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
        d.plans.retain(|p| p.asset != id);
        for p in d.plans.iter_mut().filter(|p| p.cash == id) {
            p.cash = 0;
        }
        self.commit(&mut d)?;
        Ok(view(&d))
    }

    /// Add the dividends the quote source reports for every holding with automatic dividends on.
    fn run_dividends(&self) -> Result<Value, String> {
        let _guard = self.plan_lock.lock().unwrap();
        if !self.data.lock().unwrap().primary {
            return Ok(json!({ "added": 0, "failed": Vec::<String>::new(), "data": view(&self.data.lock().unwrap()) }));
        }
        let today_s = today();
        let targets: Vec<(u64, String, String, String)> = {
            let d = self.data.lock().unwrap();
            d.assets
                .iter()
                .filter(|a| a.holding && a.auto_div && !a.market.is_empty() && !a.symbol.trim().is_empty())
                .filter_map(|a| {
                    let first = a.txs.iter().filter(|t| t.kind == "buy").map(|t| t.date.clone()).min()?;
                    Some((a.id, a.symbol.trim().to_string(), a.market.clone(), first))
                })
                .collect()
        };
        let (mut added, mut failed) = (0usize, 0usize);
        for (id, sym, mkt, first) in targets {
            let Ok(events) = fetch_dividends(&sym, &mkt, &first) else {
                failed += 1;
                continue;
            };
            let (txs, seen, cash) = {
                let d = self.data.lock().unwrap();
                match d.assets.iter().find(|a| a.id == id) {
                    Some(a) => (a.txs.clone(), a.div_seen.clone(), a.div_cash),
                    None => continue,
                }
            };
            let mut handled = vec![];
            for (date, units, per) in dividend_candidates(&txs, &events, &seen) {
                if date.as_str() > today_s.as_str() {
                    continue;
                }
                handled.push(date.clone());
                if units <= 0.0 {
                    continue;
                }
                let amount = ((units * per) * 100.0).round() / 100.0;
                // the user may already have recorded this one by hand
                let dup = txs.iter().filter(|t| t.kind == "div").any(|t| {
                    let close = match (
                        chrono::NaiveDate::parse_from_str(&t.date, "%Y-%m-%d"),
                        chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d"),
                    ) {
                        (Ok(a), Ok(b)) => (a - b).num_days().abs() <= 45,
                        _ => false,
                    };
                    close && (t.price - amount).abs() <= amount * 0.1 + 1.0
                });
                if dup || amount <= 0.0 {
                    continue;
                }
                let tx = Tx {
                    date: date.clone(),
                    kind: "div".into(),
                    units: 0.0,
                    price: amount,
                    fee: 0.0,
                    note: format!("自動配息：每股 {} × {} 股（除息日，稅前）", per, units),
                    cash,
                    cash_delta: 0.0,
                };
                if self.add_tx(id, tx).is_ok() {
                    added += 1;
                } else {
                    handled.pop();
                }
            }
            if !handled.is_empty() {
                let mut d = self.data.lock().unwrap();
                if let Some(a) = d.assets.iter_mut().find(|a| a.id == id) {
                    a.div_seen.extend(handled);
                }
                let _ = self.persist(&mut d);
            }
        }
        Ok(json!({ "added": added, "failed": failed, "data": view(&self.data.lock().unwrap()) }))
    }

    fn save_plan(&self, mut p: Plan) -> Result<Value, String> {
        let mut d = self.data.lock().unwrap();
        let a = d.assets.iter().find(|a| a.id == p.asset).ok_or("找不到該項目")?;
        if !a.holding {
            return Err("請先將此項目設為「持倉」".into());
        }
        if !p.amount.is_finite() || p.amount <= 0.0 {
            return Err("每期金額必須大於 0".into());
        }
        if !p.fee.is_finite() || p.fee < 0.0 || p.fee >= p.amount {
            return Err("手續費必須小於每期金額".into());
        }
        if !(1..=31).contains(&p.day) {
            return Err("扣款日必須是 1 到 31".into());
        }
        if !valid_date(&p.start) {
            return Err("開始日期格式需為 YYYY-MM-DD".into());
        }
        if !p.end.is_empty() && (!valid_date(&p.end) || p.end < p.start) {
            return Err("結束日期需晚於開始日期".into());
        }
        if p.cash != 0 {
            let c = d.assets.iter().find(|x| x.id == p.cash).ok_or("找不到資金來源（存款）")?;
            if c.holding || c.liability || c.id == p.asset {
                return Err("資金來源必須是一般資產（如銀行存款、現金）".into());
            }
        }
        p.status.clear();
        if p.id == 0 {
            p.last.clear();
            let dev = d.device;
            p.id = next_record_id(&mut d.next_plan, dev);
            d.plans.push(p);
        } else {
            let slot = d.plans.iter_mut().find(|x| x.id == p.id).ok_or("找不到這個定期定額")?;
            p.last = slot.last.clone();
            *slot = p;
        }
        self.persist(&mut d)?;
        Ok(view(&d))
    }

    fn delete_plan(&self, id: u64) -> Result<Value, String> {
        let mut d = self.data.lock().unwrap();
        d.plans.retain(|p| p.id != id);
        self.persist(&mut d)?;
        Ok(view(&d))
    }

    fn plan_mark(&self, id: u64, last: Option<&str>, status: &str) {
        let mut d = self.data.lock().unwrap();
        if let Some(p) = d.plans.iter_mut().find(|p| p.id == id) {
            if let Some(l) = last {
                p.last = l.to_string();
            }
            p.status = status.to_string();
        }
        let _ = self.persist(&mut d);
    }

    /// Book every plan period that has come due since the last run (also backfills past periods).
    /// Prices are the first close on or after the scheduled day, so the date is the real trading day.
    fn run_plans(&self) -> Result<Value, String> {
        let _guard = self.plan_lock.lock().unwrap();
        if !self.data.lock().unwrap().primary {
            return Ok(json!({ "added": 0, "failed": Vec::<String>::new(), "data": view(&self.data.lock().unwrap()) }));
        }
        let today_d = chrono::Local::now().date_naive();
        let today_s = today_d.format("%Y-%m-%d").to_string();
        let plans: Vec<Plan> = self.data.lock().unwrap().plans.clone();
        let mut added = 0usize;
        for p in plans {
            let due = due_dates(&p, today_d);
            if due.is_empty() {
                continue;
            }
            let target = {
                let d = self.data.lock().unwrap();
                d.assets.iter().find(|a| a.id == p.asset).map(|a| (a.symbol.trim().to_string(), a.market.clone(), a.price))
            };
            let Some((sym, mkt, cur_price)) = target else { continue };
            let series = if mkt.is_empty() {
                None
            } else {
                let ts = |d: chrono::NaiveDate| d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp();
                let q = format!("period1={}&period2={}&interval=1d", ts(due[0]), ts(today_d + chrono::Duration::days(2)));
                match fetch_series(&sym, &mkt, &q) {
                    Ok((pts, _)) => Some(pts),
                    Err(e) => {
                        self.plan_mark(p.id, None, &format!("查詢價格失敗，之後會再試：{e}"));
                        continue;
                    }
                }
            };
            for day in due.into_iter().take(60) {
                let ds = day.format("%Y-%m-%d").to_string();
                let (date, price, est) = match &series {
                    // the day's close is only final once the day is over
                    Some(pts) => match pts.iter().find(|(d, _)| d.as_str() >= ds.as_str() && d.as_str() < today_s.as_str()) {
                        Some((d, c)) => (d.clone(), *c, false),
                        None => break,
                    },
                    None if cur_price > 0.0 => (ds.clone(), cur_price, true),
                    None => {
                        self.plan_mark(p.id, None, "沒有行情代號，請先在項目裡填現價／淨值");
                        break;
                    }
                };
                let units = plan_units(p.amount, p.fee, price, p.whole);
                if units <= 0.0 {
                    self.plan_mark(p.id, Some(&ds), &format!("{ds} 的金額不足以買 1 單位，已略過"));
                    continue;
                }
                let tx = Tx {
                    date,
                    kind: "buy".into(),
                    units,
                    price: r4(price),
                    fee: p.fee,
                    note: if est { "定期定額（以目前價格估算）" } else { "定期定額" }.into(),
                    cash: p.cash,
                    cash_delta: 0.0,
                };
                match self.add_tx(p.asset, tx) {
                    Ok(_) => {
                        added += 1;
                        self.plan_mark(p.id, Some(&ds), "");
                    }
                    Err(e) => {
                        self.plan_mark(p.id, None, &format!("{ds} 沒有成功：{e}"));
                        break;
                    }
                }
            }
        }
        Ok(json!({ "added": added, "data": view(&self.data.lock().unwrap()) }))
    }

    fn add_tx(&self, id: u64, mut tx: Tx) -> Result<Value, String> {
        validate_tx(&tx)?;
        tx.cash_delta = 0.0;
        let mut d = self.data.lock().unwrap();
        let (cur, holding) = {
            let a = d.assets.iter().find(|a| a.id == id).ok_or("找不到該項目")?;
            (a.currency.clone(), a.holding)
        };
        if !holding {
            return Err("請先將此項目設為「持倉」".into());
        }
        // Work out the effect on the chosen cash asset before touching anything.
        let mut cash_change: Option<(u64, f64)> = None;
        if tx.cash != 0 {
            if tx.cash == id {
                return Err("不能用該項目本身當作資金來源".into());
            }
            let c = d.assets.iter().find(|a| a.id == tx.cash).ok_or("找不到資金來源（存款）")?;
            if c.holding || c.liability {
                return Err("資金來源必須是一般資產（如銀行存款、現金）".into());
            }
            let gross = match tx.kind.as_str() {
                "buy" => -(tx.units * tx.price + tx.fee),
                "sell" => tx.units * tx.price - tx.fee,
                _ => tx.price,
            };
            let rate = |code: &str| d.rates.get(code).copied().unwrap_or(1.0);
            let delta = gross * rate(&cur) / rate(&c.currency);
            if c.value + delta < -1e-9 {
                return Err(format!("「{}」餘額不足（餘額 {:.2} {}，需要 {:.2}）", c.name, c.value, c.currency, -delta));
            }
            tx.cash_delta = delta;
            cash_change = Some((c.id, delta));
        }
        let a = d.assets.iter_mut().find(|a| a.id == id).ok_or("找不到該項目")?;
        a.txs.push(tx);
        if !recompute(a) {
            a.txs.pop();
            recompute(a);
            return Err("賣出數量超過當時持有的單位數".into());
        }
        a.updated = today();
        if let Some((cid, delta)) = cash_change {
            if let Some(c) = d.assets.iter_mut().find(|a| a.id == cid) {
                c.value = (c.value + delta).max(0.0);
                c.updated = today();
            }
        }
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
        // Undo the cash movement of this trade (if its cash asset still exists).
        if removed.cash != 0 && removed.cash_delta != 0.0 {
            if let Some(c) = d.assets.iter().find(|x| x.id == removed.cash) {
                if c.value - removed.cash_delta < -1e-9 {
                    let msg = format!("「{}」餘額不足，無法還原這筆交易的資金變動", c.name);
                    let a = d.assets.iter_mut().find(|a| a.id == id).ok_or("找不到該項目")?;
                    a.txs.insert(index, removed);
                    recompute(a);
                    return Err(msg);
                }
            }
            if let Some(c) = d.assets.iter_mut().find(|x| x.id == removed.cash) {
                c.value = (c.value - removed.cash_delta).max(0.0);
                c.updated = today();
            }
        }
        self.commit(&mut d)?;
        Ok(view(&d))
    }

    fn set_settings(
        &self,
        rates: BTreeMap<String, f64>,
        refresh_sec: u32,
    ) -> Result<Value, String> {
        let base = self.data.lock().unwrap().base.clone();
        if rates.get(&base) != Some(&1.0) {
            return Err(format!("{base} 匯率必須為 1"));
        }
        if rates.values().any(|r| !r.is_finite() || *r <= 0.0) {
            return Err("匯率必須為正數".into());
        }
        if !matches!(refresh_sec, 0 | 15 | 30 | 60 | 300 | 900) {
            return Err("不支援的更新間隔".into());
        }
        let mut d = self.data.lock().unwrap();
        if let Some(a) = d.assets.iter().find(|a| !rates.contains_key(&a.currency)) {
            return Err(format!("「{}」仍使用幣別 {}，無法移除", a.name, a.currency));
        }
        d.rates = rates;
        d.refresh_sec = refresh_sec;
        for a in d.assets.iter_mut() {
            recompute(a);
        }
        self.commit(&mut d)?;
        Ok(view(&d))
    }

    // ------------------------------------------------------------- quotes

    /// Fetch live prices for every holding with a symbol, plus FX rates for the
    /// currencies other than the base in use. Network I/O happens without holding the lock.
    fn refresh_quotes(&self) -> Result<Value, String> {
        let (targets, currencies, base) = {
            let d = self.data.lock().unwrap();
            let t: Vec<(u64, String, String)> = d
                .assets
                .iter()
                .filter(|a| a.holding && !a.market.is_empty() && !a.symbol.is_empty())
                .map(|a| (a.id, a.symbol.clone(), a.market.clone()))
                .collect();
            let c: Vec<String> = d.rates.keys().filter(|k| **k != d.base).cloned().collect();
            (t, c, d.base.clone())
        };

        // Fetch in parallel (8 at a time): one slow Yahoo reply no longer holds up all the others.
        let mut quotes: Vec<(u64, Result<Quote, String>)> = vec![];
        for chunk in targets.chunks(8) {
            let part: Vec<(u64, Result<Quote, String>)> = thread::scope(|s| {
                let handles: Vec<_> = chunk.iter().map(|(id, sym, market)| s.spawn(move || (*id, fetch_quote(sym, market)))).collect();
                handles.into_iter().map(|h| h.join().unwrap_or_else(|_| (0, Err("內部錯誤".to_string())))).collect()
            });
            quotes.extend(part);
        }
        let mut fx: Vec<(String, f64)> = vec![];
        for chunk in currencies.chunks(8) {
            let part: Vec<Option<(String, f64)>> = thread::scope(|s| {
                let base = &base;
                let handles: Vec<_> = chunk
                    .iter()
                    .map(|cur| s.spawn(move || fetch_yahoo(&fx_symbol(cur, base)).ok().filter(|q| q.price > 0.0).map(|q| (cur.clone(), q.price))))
                    .collect();
                handles.into_iter().map(|h| h.join().ok().flatten()).collect()
            });
            fx.extend(part.into_iter().flatten());
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

    /// Merge what a paired device sent, and answer with this device's merged state so the caller can merge it back.
    /// Both sides then hold the same records.
    fn sync(&self, remote: SyncPayload) -> Result<Value, String> {
        let _guard = self.plan_lock.lock().unwrap(); // never in the middle of booking plans
        let mut d = self.data.lock().unwrap();
        let remote_base = if remote.base.is_empty() { DEFAULT_BASE } else { remote.base.as_str() };
        if is_fresh(&d) {
            // a brand-new install takes over the other device's main currency and rate list
            if remote_base != d.base || !remote.fresh {
                d.base = remote_base.to_string();
                d.rates = if remote.rates.get(remote_base) == Some(&1.0) { remote.rates.clone() } else { seed_rates(remote_base, None) };
            }
            if !remote.fresh {
                d.base_set = true;
            }
        } else if remote_base != d.base {
            if remote.fresh {
                // the other side has nothing yet and will adopt our currency from this reply
                return Ok(json!({ "changed": 0, "payload": sync_payload(&d) }));
            }
            return Err(format!("兩台裝置的主要幣別不同（{}與{}）。請先在其中一台的設定把主要幣別改成一樣，再同步。", d.base, remote_base));
        }
        let base = d.peer.as_ref().map(|p| p.last_sync).unwrap_or(0); // last time we synced with that device
        let changed = merge_payload(&mut d, &remote, now_ms(), base);
        self.commit(&mut d)?;
        Ok(json!({ "changed": changed, "payload": sync_payload(&d) }))
    }

    /// Pick the main currency. On a new install that is just a choice; later it converts every stored amount that is
    /// counted in the base currency (rates, daily totals, goals, ledger) at today's rates and keeps a copy of the old file.
    fn set_base(&self, code: &str) -> Result<Value, String> {
        let code = norm_code(code)?;
        // a currency outside the built-in table needs its USD value, which comes from the network before taking any lock
        let live_usd = if approx_usd(&code).is_none() {
            fetch_yahoo(&format!("USD{code}=X")).ok().filter(|q| q.price.is_finite() && q.price > 0.0).map(|q| 1.0 / q.price)
        } else {
            None
        };
        let _guard = self.plan_lock.lock().unwrap();
        let mut d = self.data.lock().unwrap();
        if is_fresh(&d) {
            d.rates = seed_rates(&code, live_usd);
            d.base = code;
            d.base_set = true;
            self.commit(&mut d)?;
            return Ok(view(&d));
        }
        if d.base == code {
            if !d.base_set {
                d.base_set = true; // already on this currency, just never confirmed
                self.commit(&mut d)?;
            }
            return Ok(view(&d));
        }
        // units of the old base per 1 unit of the new one
        let f = d
            .rates
            .get(&code)
            .copied()
            .or_else(|| Some(approx_usd(&code).or(live_usd)? / approx_usd(&d.base)?))
            .filter(|f| f.is_finite() && *f > 0.0)
            .ok_or_else(|| format!("還沒有 {code} 的匯率，請先在「設定」的匯率清單加入這個幣別"))?;
        let _ = fs::copy(&self.path, self.path.with_extension("before-rebase.json"));
        for r in d.rates.values_mut() {
            *r = round_sig(*r / f, 9);
        }
        d.rates.insert(code.clone(), 1.0);
        for s in d.snapshots.iter_mut() {
            s.assets /= f;
            s.liabilities /= f;
        }
        for g in d.goals.iter_mut() {
            g.amount /= f;
            for p in g.history.iter_mut() {
                p.value /= f;
            }
        }
        for fl in d.cashflow.iter_mut() {
            fl.amount /= f;
        }
        d.base = code;
        d.base_set = true;
        self.commit(&mut d)?;
        Ok(view(&d))
    }

    /// "stable" or "preview": which releases the update check offers on this device.
    fn set_channel(&self, channel: &str) -> Result<Value, String> {
        if !matches!(channel, "stable" | "preview") {
            return Err("不支援的更新頻道".into());
        }
        let mut d = self.data.lock().unwrap();
        d.channel = channel.to_string();
        self.persist(&mut d)?;
        Ok(view(&d))
    }

    fn my_name(&self) -> String {
        let d = self.data.lock().unwrap();
        if !d.device_name.trim().is_empty() {
            return d.device_name.trim().to_string();
        }
        if cfg!(target_os = "android") {
            "手機".into()
        } else {
            std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "電腦".into())
        }
    }

    /// The `sync` command as the other device calls it over HTTP. If it says how to reach it back (`reply`), remember
    /// that device as our peer, so that this side can start a sync later too (e.g. the computer checking the phone).
    fn sync_cmd(&self, args: &Value, remote: bool) -> Result<Value, String> {
        let payload: SyncPayload = serde_json::from_value(args["payload"].clone()).map_err(|e| format!("同步資料格式錯誤：{e}"))?;
        let mut out = self.sync(payload)?;
        if remote {
            if let Some(r) = args["reply"].as_object() {
                let (url, pin) = (r.get("url").and_then(Value::as_str).unwrap_or(""), r.get("pin").and_then(Value::as_str).unwrap_or(""));
                if let Ok((url, pin)) = parse_peer_link(url, pin) {
                    let mut d = self.data.lock().unwrap();
                    let name = r.get("name").and_then(Value::as_str).unwrap_or("").trim().chars().take(40).collect::<String>();
                    let id = r.get("id").and_then(Value::as_str).unwrap_or("").chars().take(32).collect::<String>();
                    d.peer = Some(Peer { url, pin, name: if name.is_empty() { "另一台裝置".into() } else { name }, id, last_sync: now_ms() });
                    let _ = self.persist(&mut d);
                }
            }
        }
        out["name"] = json!(self.my_name());
        out["id"] = json!(self.data.lock().unwrap().install_id);
        Ok(out)
    }

    /// How the other device can reach this one, if this one is listening.
    fn reply_info(&self) -> Option<Value> {
        let (running, port, pin) = {
            let d = self.data.lock().unwrap();
            (self.server.lock().unwrap().is_some(), d.sync_port, d.sync_pin.clone())
        };
        if !running || pin.is_empty() {
            return None;
        }
        let ip = lan_ips().into_iter().next()?;
        Some(json!({ "url": format!("http://{ip}:{port}"), "pin": pin, "name": self.my_name(), "id": self.data.lock().unwrap().install_id }))
    }

    fn set_peer_status(&self, state: &str, message: &str) {
        *self.peer_status.lock().unwrap() = PeerStatus { state: state.into(), message: message.into(), at: now_ms() };
    }

    /// One exchange with the bound device: send ours, merge theirs. Short timeouts, so an absent device costs seconds.
    fn exchange_with(&self, url: &str, pin: &str) -> Result<(String, String, usize), PeerError> {
        let payload = {
            let mut d = self.data.lock().unwrap();
            stamp(&mut d, now_ms());
            sync_payload(&d)
        };
        let body = json!({ "payload": payload, "reply": self.reply_info() });
        let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(3)).timeout(Duration::from_secs(20)).build();
        let resp = agent.post(&format!("{url}/api/sync")).set("X-Token", pin).send_json(body).map_err(|e| match e {
            ureq::Error::Status(401, _) => PeerError::Denied("PIN 不正確，或對方已更換 PIN".into()),
            ureq::Error::Status(429, _) => PeerError::Denied("嘗試次數過多，請稍後再試".into()),
            ureq::Error::Status(_, r) => PeerError::Other(r.into_json::<Value>().ok().and_then(|v| v["error"].as_str().map(String::from)).unwrap_or_else(|| "對方回應錯誤".into())),
            ureq::Error::Transport(_) => PeerError::Offline,
        })?;
        let v: Value = resp.into_json().map_err(|e| PeerError::Other(format!("回應格式錯誤：{e}")))?;
        let remote: SyncPayload = serde_json::from_value(v["payload"].clone()).map_err(|e| PeerError::Other(format!("同步資料格式錯誤：{e}")))?;
        let merged = self.sync(remote).map_err(PeerError::Other)?;
        Ok((v["name"].as_str().unwrap_or("").to_string(), v["id"].as_str().unwrap_or("").chars().take(32).collect(), merged["changed"].as_u64().unwrap_or(0) as usize))
    }

    /// Bind to the other device (first sync, which also tells it how to reach us), then keep it as the peer.
    fn pair_peer(&self, link: &str, pin: &str) -> Result<Value, String> {
        let (url, pin) = parse_peer_link(link, pin)?;
        self.set_peer_status("syncing", "");
        match self.exchange_with(&url, &pin) {
            Ok((name, id, _)) => {
                {
                    let mut d = self.data.lock().unwrap();
                    d.peer = Some(Peer { url, pin, name: if name.is_empty() { "另一台裝置".into() } else { name }, id, last_sync: now_ms() });
                    self.persist(&mut d)?;
                }
                self.set_peer_status("ok", "");
                Ok(self.peer_info())
            }
            Err(e) => {
                self.set_peer_status(e.state(), &e.message());
                Err(e.message())
            }
        }
    }

    /// Sync with the bound device (called when the app starts, comes back to the front, and after local edits).
    /// If it cannot be reached but is known by its id, look for it on the local network: its IP address may have changed.
    fn sync_peer(&self) -> Result<Value, String> {
        self.sync_peer_with(&lan_candidates)
    }

    fn sync_peer_with(&self, candidates: &dyn Fn() -> Vec<String>) -> Result<Value, String> {
        let Some(peer) = self.data.lock().unwrap().peer.clone() else { return Err("尚未綁定裝置".into()) };
        self.set_peer_status("syncing", "");
        let mut result = self.exchange_with(&peer.url, &peer.pin);
        if matches!(result, Err(PeerError::Offline)) && !peer.id.is_empty() {
            let last = self.last_sweep.load(std::sync::atomic::Ordering::SeqCst);
            if now_ms().saturating_sub(last) > 120_000 {
                self.last_sweep.store(now_ms(), std::sync::atomic::Ordering::SeqCst);
                let port = peer.url.rsplit(':').next().and_then(|p| p.trim_matches('/').parse::<u16>().ok()).unwrap_or(DEFAULT_PORT);
                if let Some(found) = sweep_for(&peer.id, port, &candidates()) {
                    if found != peer.url {
                        {
                            let mut d = self.data.lock().unwrap();
                            if let Some(p) = d.peer.as_mut() {
                                p.url = found.clone();
                            }
                            let _ = self.persist(&mut d);
                        }
                        result = self.exchange_with(&found, &peer.pin);
                    }
                }
            }
        }
        match result {
            Ok((name, id, changed)) => {
                {
                    let mut d = self.data.lock().unwrap();
                    if let Some(p) = d.peer.as_mut() {
                        p.last_sync = now_ms();
                        if !name.is_empty() {
                            p.name = name;
                        }
                        if !id.is_empty() {
                            p.id = id;
                        }
                    }
                    self.persist(&mut d)?;
                }
                self.set_peer_status("ok", "");
                let mut info = self.peer_info();
                info["changed"] = json!(changed);
                Ok(info)
            }
            Err(e) => {
                self.set_peer_status(e.state(), &e.message());
                Ok(self.peer_info()) // not a failure of the app: the other device just is not there
            }
        }
    }

    fn unpair_peer(&self) -> Value {
        {
            let mut d = self.data.lock().unwrap();
            d.peer = None;
            let _ = self.persist(&mut d);
        }
        self.set_peer_status("", "");
        self.peer_info()
    }

    fn peer_info(&self) -> Value {
        let d = self.data.lock().unwrap();
        let st = self.peer_status.lock().unwrap().clone();
        let listening = self.server.lock().unwrap().is_some();
        json!({
            "bound": d.peer.is_some(),
            "name": d.peer.as_ref().map(|p| p.name.clone()),
            "url": d.peer.as_ref().map(|p| p.url.clone()),
            "last_sync": d.peer.as_ref().map(|p| p.last_sync),
            "state": st.state, "message": st.message, "at": st.at,
            "listening": listening, "device": d.device, "primary": d.primary,
        })
    }

    /// Import holdings (with their transactions) and daily totals from an "Asset Tracker" JSON backup.
    /// Holdings that already exist (same ticker or name) are left alone; existing snapshot days are kept.
    fn import_tracker(&self, text: &str) -> Result<Value, String> {
        let (assets, days, skipped_tx) = parse_tracker(text)?;
        let mut d = self.data.lock().unwrap();
        let (mut added, mut dup) = (vec![], vec![]);
        for mut a in assets {
            let exists = d.assets.iter().any(|o| o.name == a.name || (!a.symbol.is_empty() && o.symbol == a.symbol && o.market == a.market));
            if exists {
                dup.push(a.name);
                continue;
            }
            validate_asset(&a, &d).map_err(|e| format!("{}：{}", a.name, e))?;
            a.updated = today();
            recompute(&mut a);
            let dev = d.device;
            a.id = next_record_id(&mut d.next_id, dev);
            added.push(a.name.clone());
            d.assets.push(a);
        }
        let (days_added, days_skipped) = add_missing_snapshots(&mut d.snapshots, days, &today());
        if !added.is_empty() || days_added > 0 {
            self.commit(&mut d)?;
        }
        Ok(json!({ "data": view(&d), "added": added, "duplicates": dup, "days": days_added, "days_skipped": days_skipped, "skipped_tx": skipped_tx }))
    }

    /// Import a daily net-worth history (see `merge_history`). Does not touch today's snapshot.
    fn import_history(&self, text: &str) -> Result<Value, String> {
        let mut d = self.data.lock().unwrap();
        let (added, skipped) = merge_history(&mut d.snapshots, text, &today())?;
        if added > 0 {
            self.persist(&mut d)?;
        }
        Ok(json!({ "data": view(&d), "added": added, "skipped": skipped }))
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
                currency: if get(2).is_empty() { d.base.clone() } else { get(2).to_uppercase() },
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
            let dev = d.device;
            a.id = next_record_id(&mut d.next_id, dev);
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
        if self.data.lock().unwrap().sync_port != port {
            self.tunnel_stop(); // it points at the old port
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
            if let Err(e) = self.start_server("0.0.0.0", port) {
                self.data.lock().unwrap().sync_enabled = false;
                return Err(e);
            }
        } else if self.tunnel.lock().unwrap().is_some() {
            // LAN sync switched off, but the tunnel still needs a (loopback) server
            self.start_server("127.0.0.1", port)?;
        }
        Ok(self.sync_info())
    }

    // ----------------------------------------------------- remote tunnel

    fn find_cloudflared(&self) -> Option<PathBuf> {
        let mut c: Vec<PathBuf> = vec![];
        // our own verified copy first
        if let Some(dir) = self.path.parent() {
            c.push(dir.join("bin").join("cloudflared.exe"));
        }
        if let Some(p) = std::env::var_os("PATH") {
            c.extend(std::env::split_paths(&p).map(|d| d.join("cloudflared.exe")));
        }
        for var in ["ProgramFiles(x86)", "ProgramFiles"] {
            if let Some(b) = std::env::var_os(var) {
                c.push(PathBuf::from(b).join("cloudflared").join("cloudflared.exe"));
            }
        }
        if let Some(b) = std::env::var_os("LOCALAPPDATA") {
            c.push(PathBuf::from(b).join("Microsoft").join("WinGet").join("Links").join("cloudflared.exe"));
        }
        c.into_iter().find(|p| p.is_file())
    }

    fn tunnel_status(&self) -> Value {
        let installed = self.find_cloudflared();
        let mut t = self.tunnel.lock().unwrap();
        if t.as_mut().is_some_and(|x| matches!(x.child.try_wait(), Ok(Some(_)))) {
            *t = None; // cloudflared exited on its own
        }
        let (running, url, link) = match &*t {
            Some(x) => (true, Some(x.url.clone()), Some(format!("{}/t/{}", x.url, x.token))),
            None => (false, None, None),
        };
        let qr = link.as_deref().and_then(qr_svg);
        // `link` embeds the secret: it is only ever returned to the desktop window, never over HTTP
        json!({ "installed": installed.is_some(), "running": running, "url": url, "link": link, "qr": qr,
            "winget": winget_available(), "bin_dir": self.bin_dir().map(|p| p.display().to_string()).unwrap_or_default() })
    }

    fn set_progress(&self, active: bool, stage: &str, done: u64, total: u64) {
        *self.progress.lock().unwrap() = Progress { active, stage: stage.to_string(), done, total };
    }

    fn tunnel_progress(&self) -> Value {
        let p = self.progress.lock().unwrap().clone();
        json!({ "active": p.active, "stage": p.stage, "done": p.done, "total": p.total })
    }

    fn bin_dir(&self) -> Result<PathBuf, String> {
        Ok(self.path.parent().ok_or("找不到資料夾")?.join("bin"))
    }

    /// method: "direct" = official download with checksum, "winget" = `winget install`.
    fn tunnel_install(&self, method: &str) -> Result<Value, String> {
        if self.find_cloudflared().is_some() {
            return Ok(self.tunnel_status());
        }
        {
            let mut p = self.progress.lock().unwrap();
            if p.active {
                return Err("正在安裝中，請稍候".into());
            }
            *p = Progress { active: true, stage: "準備中…".into(), done: 0, total: 0 };
        }
        let res = match method {
            "winget" => self.install_with_winget(),
            _ => self.bin_dir().and_then(|dir| {
                fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                download_cloudflared(&dir.join("cloudflared.exe"), &|st, d, t| self.set_progress(true, st, d, t))
            }),
        };
        self.set_progress(false, "", 0, 0);
        res?;
        if self.find_cloudflared().is_none() {
            return Err("安裝完成但找不到 cloudflared，請按「重新偵測」或重新啟動 MoneyPi".into());
        }
        Ok(self.tunnel_status())
    }

    fn install_with_winget(&self) -> Result<(), String> {
        if !winget_available() {
            return Err("這台電腦沒有 winget".into());
        }
        let mut cmd = Command::new("winget");
        cmd.args(["install", "--id", "Cloudflare.cloudflared", "-e", "--accept-package-agreements", "--accept-source-agreements"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let mut child = cmd.spawn().map_err(|e| format!("無法執行 winget：{e}"))?;
        let mut out = child.stdout.take().ok_or("無法讀取 winget 輸出")?;
        let (mut buf, mut line) = ([0u8; 512], Vec::<u8>::new());
        loop {
            let n = out.read(&mut buf).unwrap_or(0);
            if n == 0 {
                break;
            }
            for &b in &buf[..n] {
                if b == b'\r' || b == b'\n' {
                    let t = String::from_utf8_lossy(&line).trim().to_string();
                    // winget draws its progress bar with block characters; keep only readable lines
                    if t.chars().any(|c| c.is_alphanumeric()) && t.chars().count() > 2 {
                        self.set_progress(true, &t.chars().take(70).collect::<String>(), 0, 0);
                    }
                    line.clear();
                } else {
                    line.push(b);
                }
            }
        }
        let st = child.wait().map_err(|e| e.to_string())?;
        if !st.success() && self.find_cloudflared().is_none() {
            return Err(format!("winget 安裝失敗（代碼 {}）", st.code().unwrap_or(-1)));
        }
        Ok(())
    }

    fn price_history(&self, id: u64, range: &str) -> Result<Value, String> {
        if !matches!(range, "6mo" | "1y" | "2y" | "5y") {
            return Err("不支援的區間".into());
        }
        let (sym, mkt) = self.quote_target(id)?;
        let (pts, cur) = fetch_series(&sym, &mkt, &format!("range={range}&interval=1d"))?;
        Ok(json!({ "currency": cur, "points": pts }))
    }

    /// Closing price on `date` (or the last trading day before it).
    fn price_on(&self, id: u64, date: &str) -> Result<Value, String> {
        if !valid_date(date) {
            return Err("日期格式需為 YYYY-MM-DD".into());
        }
        let day = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|e| e.to_string())?;
        if day > chrono::Local::now().date_naive() {
            return Err("這個日期還沒到，沒有收盤價".into());
        }
        let ts = |d: chrono::NaiveDate| d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp();
        let (sym, mkt) = self.quote_target(id)?;
        let q = format!("period1={}&period2={}&interval=1d", ts(day - chrono::Duration::days(10)), ts(day + chrono::Duration::days(2)));
        let (pts, cur) = fetch_series(&sym, &mkt, &q)?;
        let (d, p) = pts.iter().rev().find(|(d, _)| d.as_str() <= date).ok_or("該日期之前查無收盤價（可能早於上市日）")?;
        Ok(json!({ "date": d, "price": p, "currency": cur }))
    }

    fn quote_target(&self, id: u64) -> Result<(String, String), String> {
        let d = self.data.lock().unwrap();
        let a = d.assets.iter().find(|a| a.id == id).ok_or("找不到該項目")?;
        if !a.holding || a.market.is_empty() || a.symbol.trim().is_empty() {
            return Err("此項目沒有設定行情代號".into());
        }
        Ok((a.symbol.trim().to_string(), a.market.clone()))
    }

    fn tunnel_start(self: &Arc<Self>) -> Result<Value, String> {
        if self.tunnel.lock().unwrap().is_some() {
            return Ok(self.tunnel_status());
        }
        let exe = self.find_cloudflared().ok_or("尚未安裝 cloudflared")?;
        let port = self.data.lock().unwrap().sync_port;
        let mut started_server = false;
        if self.server.lock().unwrap().is_none() {
            self.start_server("127.0.0.1", port)?; // loopback only: just for the tunnel
            started_server = true;
        }
        let mut cmd = Command::new(&exe);
        cmd.args(["tunnel", "--url", &format!("http://127.0.0.1:{port}"), "--no-autoupdate"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // no console window
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                if started_server {
                    self.stop_server();
                }
                return Err(format!("無法啟動 cloudflared：{e}"));
            }
        };
        let stderr = child.stderr.take().ok_or("無法讀取 cloudflared 輸出")?;
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let mut sent = false;
            // keep draining so cloudflared never blocks on a full pipe
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if !sent {
                    if let Some(u) = extract_tunnel_url(&line) {
                        let _ = tx.send(u);
                        sent = true;
                    }
                }
            }
        });
        match rx.recv_timeout(Duration::from_secs(30)) {
            Ok(url) => {
                *self.tunnel.lock().unwrap() = Some(Tunnel { child, url, token: random_hex(16), started_server });
                Ok(self.tunnel_status())
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                if started_server {
                    self.stop_server();
                }
                Err("無法建立遠端連線，請確認電腦可以上網後再試".into())
            }
        }
    }

    fn tunnel_stop(&self) -> Value {
        let t = self.tunnel.lock().unwrap().take();
        if let Some(t) = t {
            let started = t.started_server;
            drop(t); // kills cloudflared
            if started && !self.data.lock().unwrap().sync_enabled {
                self.stop_server();
            }
        }
        self.tunnel_status()
    }

    /// Requests that came through the tunnel (Cloudflare adds its headers) must present the
    /// per-tunnel secret; the LAN PIN is not accepted there. LAN requests use the PIN, with a lockout.
    fn authorize(&self, pin: &str, remote_token: Option<&str>, via_tunnel: bool, given: &str) -> Auth {
        if via_tunnel {
            return if remote_token.is_some_and(|t| check_secret(t, given)) { Auth::Ok } else { Auth::Denied };
        }
        let mut f = self.auth_fail.lock().unwrap();
        if let Some(until) = f.1 {
            if Instant::now() < until {
                return Auth::Locked;
            }
            *f = (0, None);
        }
        if check_secret(pin, given) {
            f.0 = 0;
            Auth::Ok
        } else {
            f.0 += 1;
            if f.0 >= 10 {
                f.1 = Some(Instant::now() + Duration::from_secs(60));
            }
            Auth::Denied
        }
    }

    fn stop_server(&self) {
        if let Some(s) = self.server.lock().unwrap().take() {
            s.unblock();
        }
    }

    fn start_server(self: &Arc<Self>, host: &str, port: u16) -> Result<(), String> {
        let server = Arc::new(
            tiny_http::Server::http((host, port)).map_err(|e| format!("無法啟動同步服務（連接埠 {port}）：{e}"))?,
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
    let price = r4(meta["regularMarketPrice"].as_f64().ok_or("查無報價")?);
    let currency = meta["currency"].as_str().unwrap_or("").to_uppercase();
    Ok(Quote { price, currency })
}

/// Yahoo symbol for "how many `base` is one `cur` worth", e.g. USDTWD=X.
fn fx_symbol(cur: &str, base: &str) -> String {
    format!("{cur}{base}=X")
}

/// Live rate of one currency in the base currency (Yahoo "USDTWD=X"), for the "add a currency" form.
fn rate_quote(code: &str, base: &str) -> Result<Value, String> {
    let code = norm_code(code)?;
    if code == base {
        return Ok(json!({ "code": code, "rate": 1.0 }));
    }
    let q = fetch_yahoo(&fx_symbol(&code, base)).map_err(|e| format!("抓不到 {code} 的即時匯率（{e}）"))?;
    if !q.price.is_finite() || q.price <= 0.0 {
        return Err(format!("{code} 沒有可用的匯率"));
    }
    Ok(json!({ "code": code, "rate": q.price }))
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
/// "2026-8-5" / "2026/08/05" -> "2026-08-05" (None when it is not a real calendar date).
fn norm_date(s: &str) -> Option<String> {
    let p: Vec<&str> = s.trim().split(|c| c == '-' || c == '/').collect();
    if p.len() != 3 {
        return None;
    }
    let (y, m, d) = (p[0].trim().parse::<u32>().ok()?, p[1].trim().parse::<u32>().ok()?, p[2].trim().parse::<u32>().ok()?);
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let dim = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !(1900..=2200).contains(&y) || !(1..=12).contains(&m) || d < 1 || d > dim[m as usize - 1] {
        return None;
    }
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

/// Add snapshots for dates that have none yet (existing ones are kept, future dates skipped). Returns (added, skipped).
fn add_missing_snapshots(snaps: &mut Vec<Snapshot>, new: Vec<Snapshot>, today: &str) -> (usize, usize) {
    let mut known: std::collections::HashSet<String> = snaps.iter().map(|s| s.date.clone()).collect();
    let (mut added, mut skipped) = (0, 0);
    for s in new {
        if s.date.as_str() > today || !known.insert(s.date.clone()) {
            skipped += 1;
        } else {
            snaps.push(s);
            added += 1;
        }
    }
    snaps.sort_by(|a, b| a.date.cmp(&b.date));
    (added, skipped)
}

/// Merge a daily net-worth history CSV (columns found by header: 日期, 總資產, optional 總負債) into the snapshots.
/// Dates that already have a snapshot are kept untouched; future dates are skipped. Returns (added, skipped).
fn merge_history(snaps: &mut Vec<Snapshot>, text: &str, today: &str) -> Result<(usize, usize), String> {
    let rows = parse_csv(text);
    let head = rows.first().ok_or("檔案是空的")?;
    let col = |names: &[&str]| head.iter().position(|h| names.contains(&h.trim().to_lowercase().as_str()));
    let di = col(&["日期", "date"]);
    let ai = col(&["總資產", "資產", "淨值", "total", "assets"]);
    let li = col(&["總負債", "負債", "liabilities"]);
    let (Some(di), Some(ai)) = (di, ai) else {
        return Err("找不到「日期」與「總資產」欄位".into());
    };
    let mut new = vec![];
    for (i, r) in rows.iter().enumerate().skip(1) {
        if r.iter().all(|c| c.trim().is_empty()) {
            continue;
        }
        let num = |n: usize, allow_empty: bool| -> Result<f64, String> {
            let t = r.get(n).map(|c| c.trim().replace(',', "")).unwrap_or_default();
            if t.is_empty() && allow_empty {
                return Ok(0.0);
            }
            match t.parse::<f64>() {
                Ok(v) if v.is_finite() && v >= 0.0 => Ok(v),
                _ => Err(format!("第 {} 行：數字格式錯誤", i + 1)),
            }
        };
        let date = norm_date(r.get(di).map(String::as_str).unwrap_or("")).ok_or(format!("第 {} 行：日期格式錯誤（需要 2026-08-17）", i + 1))?;
        let assets = num(ai, false)?;
        let liabilities = match li {
            Some(l) => num(l, true)?,
            None => 0.0,
        };
        new.push(Snapshot { date, assets, liabilities });
    }
    if new.is_empty() {
        return Err("檔案中沒有可匯入的資料".into());
    }
    Ok(add_missing_snapshots(snaps, new, today))
}

/// Read a JSON backup from the "Asset Tracker" app (`holdings` with buy/sell transactions + daily `snapshots`).
/// Returns the holdings as MoneyPi assets, the daily totals, and how many transactions had to be skipped.
fn parse_tracker(text: &str) -> Result<(Vec<Asset>, Vec<Snapshot>, usize), String> {
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("不是有效的 JSON：{e}"))?;
    let (Some(holdings), Some(snaps)) = (v["holdings"].as_array(), v["snapshots"].as_array()) else {
        return Err("這不是支援的備份檔（找不到 holdings 與 snapshots）".into());
    };
    // latest close of a symbol, taken from the newest snapshot that lists it
    let last_close = |sym: &str| -> Option<f64> {
        snaps.iter().rev().find_map(|s| s["positions"].as_array()?.iter().find(|p| p["symbol"].as_str() == Some(sym))?["close"].as_f64())
    };
    let (mut assets, mut skipped_tx) = (vec![], 0);
    for h in holdings {
        let name = h["name"].as_str().unwrap_or("").trim().to_string();
        let sym = h["symbol"].as_str().unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        let manual = h["manualNav"].as_bool().unwrap_or(false);
        let mut txs = vec![];
        for t in h["transactions"].as_array().into_iter().flatten() {
            let kind = match t["kind"].as_str() {
                Some("buy") => "buy",
                Some("sell") => "sell",
                _ => {
                    skipped_tx += 1;
                    continue;
                }
            };
            let date = t["date"].as_str().unwrap_or("");
            let (units, price, fee) = (t["shares"].as_f64().unwrap_or(0.0), t["price"].as_f64().unwrap_or(0.0), t["fee"].as_f64().unwrap_or(0.0));
            if !valid_date(date) || !(units > 0.0) || !(price >= 0.0) || !(fee >= 0.0) {
                skipped_tx += 1;
                continue;
            }
            txs.push(Tx { date: date.into(), kind: kind.into(), units, price, fee, ..Default::default() });
        }
        if txs.is_empty() {
            continue;
        }
        // "2542:TPE" / "8042:TPEX" -> Taiwan listed ("tw"); funds priced by hand keep no ticker
        let (symbol, market) = if manual {
            (String::new(), "")
        } else if let Some((code, ex)) = sym.split_once(':') {
            (code.to_string(), if matches!(ex, "TPE" | "TPEX") { "tw" } else { "other" })
        } else {
            (sym.to_string(), "other")
        };
        let nav = h["navHistory"].as_object().and_then(|m| m.iter().max_by(|a, b| a.0.cmp(b.0))).map(|(d, v)| (d.clone(), v.as_f64().unwrap_or(0.0)));
        let last_tx = txs.last().map(|t| t.price).unwrap_or(0.0);
        let (price, price_updated) = match (&nav, manual) {
            (Some((d, v)), true) if *v > 0.0 => (*v, d.clone()),
            _ => (last_close(sym).unwrap_or(last_tx), String::new()),
        };
        let etf = market == "tw" && symbol.starts_with("00");
        let account = h["account"].as_str().unwrap_or("").trim();
        assets.push(Asset {
            name,
            category: if manual || etf { "基金/ETF" } else { "股票" }.into(),
            currency: h["currency"].as_str().filter(|c| !c.trim().is_empty()).unwrap_or("TWD").trim().to_uppercase(),
            note: if account.is_empty() { String::new() } else { format!("帳戶：{account}") },
            holding: true,
            symbol,
            market: market.into(),
            price,
            price_updated,
            txs,
            auto_div: !market.is_empty(),
            ..Default::default()
        });
    }
    let days = snaps
        .iter()
        .filter_map(|s| Some(Snapshot { date: norm_date(s["date"].as_str()?)?, assets: s["total"].as_f64().filter(|t| t.is_finite() && *t >= 0.0)?, liabilities: 0.0 }))
        .collect();
    Ok((assets, days, skipped_tx))
}

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
    if core.is_locked() && !matches!(cmd, "lock_status" | "unlock") {
        return Err("已鎖定：請先在電腦上輸入密碼解鎖".into());
    }
    match cmd {
        "lock_status" => Ok(core.lock_status()),
        "unlock" if !remote => core.unlock(&arg::<String>(&args, "password")?),
        "lock" if !remote => core.lock(),
        "set_password" if !remote => core.set_password(&arg::<String>(&args, "old")?, &arg::<String>(&args, "new")?),
        "backup_info" if !remote => Ok(core.backup_info()),
        "set_backup" if !remote => core.set_backup(arg(&args, "on")?, &arg::<String>(&args, "dir")?, arg(&args, "keep")?),
        "backup_now" if !remote => core.auto_backup(true).map(|n| json!({ "name": n, "info": core.backup_info() })),
        "run_dividends" => core.run_dividends(),
        "get_data" => Ok(view(&core.data.lock().unwrap())),
        "wait_rev" => Ok(core.wait_rev(args["since"].as_i64().unwrap_or(-1))),
        "save_asset" => core.save_asset(arg(&args, "asset")?),
        "delete_asset" => core.delete_asset(arg(&args, "id")?),
        "add_tx" => core.add_tx(arg(&args, "id")?, arg(&args, "tx")?),
        "delete_tx" => core.delete_tx(arg(&args, "id")?, arg(&args, "index")?),
        "set_settings" => core.set_settings(arg(&args, "rates")?, arg(&args, "refresh_sec")?),
        "save_goal" => core.save_goal(arg(&args, "goal")?),
        "delete_goal" => core.delete_goal(arg(&args, "id")?),
        "refresh_quotes" => core.refresh_quotes(),
        "export_csv" => Ok(Value::String(core.export_csv())),
        "sync" => core.sync_cmd(&args, remote),
        "peer_info" if !remote => Ok(core.peer_info()),
        "pair_peer" if !remote => core.pair_peer(&arg::<String>(&args, "link")?, args["pin"].as_str().unwrap_or("")),
        "sync_peer" if !remote => core.sync_peer(),
        "unpair_peer" if !remote => Ok(core.unpair_peer()),
        "rate_quote" if !remote => {
            let base = core.data.lock().unwrap().base.clone();
            rate_quote(&arg::<String>(&args, "code")?, &base)
        }
        "set_channel" if !remote => core.set_channel(&arg::<String>(&args, "channel")?),
        "set_base" if !remote => core.set_base(&arg::<String>(&args, "code")?),
        "import_tracker" => core.import_tracker(&arg::<String>(&args, "text")?),
        "import_history" => core.import_history(&arg::<String>(&args, "text")?),
        "import_csv" => core.import_csv(&arg::<String>(&args, "text")?),
        "add_flow" => core.add_flow(arg(&args, "flow")?),
        "delete_flow" => core.delete_flow(arg(&args, "id")?),
        "export_backup" => Ok(Value::String(core.export_backup())),
        "import_backup" => core.import_backup(&arg::<String>(&args, "text")?, args["password"].as_str()),
        "tunnel_status" if !remote => Ok(core.tunnel_status()),
        "tunnel_install" if !remote => core.tunnel_install(args["method"].as_str().unwrap_or("direct")),
        "tunnel_progress" if !remote => Ok(core.tunnel_progress()),
        "open_external" if !remote => {
            let t = arg::<String>(&args, "target")?;
            if t == "backups" { core.open_backups().map(|_| Value::Null) } else { Err("請在應用程式視窗中開啟連結".into()) } // links go through `call` and the opener plugin
        }
        "save_plan" => core.save_plan(arg(&args, "plan")?),
        "delete_plan" => core.delete_plan(arg(&args, "id")?),
        "run_plans" => core.run_plans(),
        "price_history" => core.price_history(arg(&args, "id")?, &arg::<String>(&args, "range")?),
        "price_on" => core.price_on(arg(&args, "id")?, &arg::<String>(&args, "date")?),
        "tunnel_start" if !remote => core.tunnel_start(),
        "tunnel_stop" if !remote => Ok(core.tunnel_stop()),
        "get_sync" if !remote => Ok(core.sync_info()),
        "set_sync" if !remote => core.set_sync(arg(&args, "enabled")?, arg(&args, "port")?, arg(&args, "pin")?),
        _ => Err(format!("不支援的命令：{cmd}")),
    }
}

#[tauri::command]
async fn call(app: AppHandle, state: State<'_, Arc<Core>>, cmd: String, args: Value) -> Result<Value, String> {
    // Links open through the opener plugin (system browser, also on Android), after the same whitelist check as before.
    if cmd == "open_external" {
        if let Some(t) = args["target"].as_str().filter(|t| *t != "backups") {
            let url = external_url(t)?;
            app.opener().open_url(url, None::<&str>).map_err(|e| format!("系統瀏覽器無法開啟連結：{e}"))?;
            return Ok(Value::Null);
        }
    }
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
        // Tunnel sign-in link: /t/<secret> stores the secret in the browser, then opens the app.
        if let Some(tok) = url.strip_prefix("/t/") {
            let via = header(&req, "Cf-Connecting-Ip").is_some() || header(&req, "Cf-Ray").is_some();
            let expected = core.tunnel.lock().unwrap().as_ref().map(|t| t.token.clone());
            if via && expected.as_deref().is_some_and(|e| check_secret(e, tok)) {
                // `tok` equals the (hex) secret here, so it is safe to embed
                let page = format!(
                    "<!doctype html><meta charset=utf-8><title>MoneyPi</title><script>try{{localStorage.setItem('token','{tok}')}}catch(e){{}}location.replace('/')</script>"
                );
                let _ = req.respond(
                    Response::from_string(page)
                        .with_header(hdr("Content-Type", "text/html; charset=utf-8"))
                        .with_header(hdr("Cache-Control", "no-store"))
                        .with_header(hdr("Referrer-Policy", "no-referrer")),
                );
            } else {
                thread::sleep(Duration::from_secs(1));
                let _ = req.respond(
                    Response::from_string("連結已失效，請回電腦重新掃描 QR Code")
                        .with_status_code(404)
                        .with_header(hdr("Content-Type", "text/plain; charset=utf-8")),
                );
            }
            return;
        }
        let _ = match url.as_str() {
            // no secrets here: just enough for a paired device to recognise this one after an IP change
            "/moneypi-id" => req.respond(
                Response::from_string(json!({ "app": "moneypi", "id": core.data.lock().unwrap().install_id }).to_string())
                    .with_header(hdr("Content-Type", "application/json; charset=utf-8"))
                    .with_header(hdr("Cache-Control", "no-store")),
            ),
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

    let via_tunnel = header(&req, "Cf-Connecting-Ip").is_some() || header(&req, "Cf-Ray").is_some();
    let given = header(&req, "X-Token").unwrap_or("").to_string();
    let pin = core.data.lock().unwrap().sync_pin.clone();
    let remote_token = core.tunnel.lock().unwrap().as_ref().map(|t| t.token.clone());
    match core.authorize(&pin, remote_token.as_deref(), via_tunnel, &given) {
        Auth::Ok => {}
        Auth::Locked => return reply(req, 429, json!({ "error": "嘗試次數過多，請稍後再試" })),
        Auth::Denied => {
            thread::sleep(Duration::from_secs(1)); // slow down guessing
            return reply(req, 401, json!({ "error": "PIN 或連線密鑰錯誤" }));
        }
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

/// Every host on the /24 networks of this machine's addresses, except itself.
fn lan_candidates() -> Vec<String> {
    let mut out = vec![];
    for ip in lan_ips() {
        let p: Vec<&str> = ip.split('.').collect();
        if p.len() == 4 {
            for last in 1..=254u32 {
                if p[3].parse::<u32>().ok() != Some(last) {
                    out.push(format!("{}.{}.{}.{last}", p[0], p[1], p[2]));
                }
            }
        }
    }
    out
}

/// Ask each address on `port` who it is (a small unauthenticated reply with just an install id) and return the base url
/// of the one whose id matches. 48 at a time with short timeouts: a /24 takes a few seconds.
fn sweep_for(id: &str, port: u16, ips: &[String]) -> Option<String> {
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_millis(600)).timeout(Duration::from_millis(1500)).build();
    for chunk in ips.chunks(48) {
        let hit: Option<String> = thread::scope(|s| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|ip| {
                    let agent = agent.clone();
                    s.spawn(move || {
                        let url = format!("http://{ip}:{port}");
                        let v: Value = agent.get(&format!("{url}/moneypi-id")).call().ok()?.into_json().ok()?;
                        (v["app"] == "moneypi" && v["id"].as_str() == Some(id)).then_some(url)
                    })
                })
                .collect();
            handles.into_iter().find_map(|h| h.join().ok().flatten())
        });
        if hit.is_some() {
            return hit;
        }
    }
    None
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

fn channel_of(app: &AppHandle) -> String {
    app.state::<Arc<Core>>().data.lock().unwrap().channel.clone()
}

/// The updater for this device's channel: stable uses the endpoint from tauri.conf.json (the latest stable release),
/// preview reads the feed that always points at the newest build.
#[cfg(desktop)]
fn updater_for(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let mut b = app.updater_builder();
    if channel_of(app) == "preview" {
        let url = PREVIEW_FEED.parse::<tauri::Url>().map_err(|e| e.to_string())?;
        b = b.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    b.build().map_err(|e| e.to_string())
}

#[cfg(desktop)]
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Value, String> {
    let upd = updater_for(&app)?.check().await.map_err(|e| e.to_string())?;
    Ok(match upd {
        Some(u) => json!({ "version": u.version, "notes": u.body, "preview": u.version.contains('-') }),
        None => Value::Null,
    })
}

#[cfg(desktop)]
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let upd = updater_for(&app)?.check().await.map_err(|e| e.to_string())?.ok_or("目前已是最新版本")?;
    upd.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart()
}
const RELEASES_API: &str = "https://api.github.com/repos/hankyleisplay/moneypi/releases";
/// Update description for the preview channel: always the newest build, preview or stable (the release workflow keeps it).
const PREVIEW_FEED: &str = "https://github.com/hankyleisplay/moneypi/releases/download/preview-channel/latest.json";

/// "v0.21.1" -> (0, 21, 1, MAX); "v0.22.0-preview.3" -> (0, 22, 0, 3). A preview sorts below the stable release of the same
/// number, previews by their number; anything else is not one of our versions.
fn version_key(v: &str) -> Option<(u64, u64, u64, u64)> {
    let v = v.trim().trim_start_matches('v');
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p.strip_prefix("preview.")?.parse::<u64>().ok()?)),
        None => (v, None),
    };
    let mut it = core.split('.').map(|p| p.parse::<u64>().ok());
    let t = (it.next()??, it.next()??, it.next()??);
    it.next().is_none().then_some((t.0, t.1, t.2, pre.unwrap_or(u64::MAX)))
}

/// The best newer release that already has its APK attached, from GitHub's release list (or a single release).
/// A preview build only counts on the preview channel. (The APK is attached a few minutes after a release goes public,
/// so a release without one is not offered yet.)
#[cfg_attr(not(mobile), allow(dead_code))]
fn pick_update(releases: &Value, current: &str, channel: &str) -> Option<Value> {
    let cur = version_key(current)?;
    let list: Vec<&Value> = match releases.as_array() {
        Some(a) => a.iter().collect(),
        None => vec![releases],
    };
    list.into_iter()
        .filter(|r| r["draft"].as_bool() != Some(true))
        .filter(|r| channel == "preview" || r["prerelease"].as_bool() != Some(true))
        .filter_map(|r| {
            let tag = r["tag_name"].as_str()?;
            let key = version_key(tag)?;
            if key <= cur || (channel != "preview" && key.3 != u64::MAX) {
                return None;
            }
            let url = r["assets"].as_array()?.iter().filter_map(|a| a["browser_download_url"].as_str()).find(|u| is_release_apk(u))?;
            Some((key, json!({ "version": tag.trim_start_matches('v'), "notes": r["body"].as_str().unwrap_or(""), "url": url, "preview": key.3 != u64::MAX })))
        })
        .max_by_key(|(k, _)| *k)
        .map(|(_, v)| v)
}

#[cfg(mobile)]
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Value, String> {
    // The phone cannot install an update by itself (Android does not allow that): it only looks for a newer release and
    // offers its APK for download. Nothing about the user is sent besides the plain request.
    let channel = channel_of(&app);
    tauri::async_runtime::spawn_blocking(move || {
        // stable: GitHub's own "latest" (never a pre-release); preview: the recent list, which includes pre-releases
        let url = if channel == "preview" { format!("{RELEASES_API}?per_page=20") } else { format!("{RELEASES_API}/latest") };
        let v: Value = ureq::get(&url)
            .set("Accept", "application/vnd.github+json")
            .set("User-Agent", "MoneyPi")
            .timeout(Duration::from_secs(10))
            .call()
            .map_err(|_| "連不上 GitHub，請確認網路".to_string())?
            .into_json()
            .map_err(|_| "GitHub 回應格式錯誤".to_string())?;
        Ok(pick_update(&v, env!("CARGO_PKG_VERSION"), &channel).unwrap_or(Value::Null))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(mobile)]
#[tauri::command]
async fn install_update(_app: AppHandle) -> Result<(), String> {
    Err("手機版請下載新版 APK 安裝".into())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    let builder = builder.plugin(tauri_plugin_opener::init());
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            fs::create_dir_all(&dir)?;
            let path = dir.join("moneypi.json");
            let (mut data, enc) = load_state(&path);
            if cfg!(target_os = "android") {
                // the phone is a secondary device: it listens (so the computer can find it while the app is open),
                // has its own PIN and device number, and leaves plans and dividends to the computer
                data.sync_enabled = true;
                data.primary = false;
                if data.sync_pin.is_empty() {
                    data.sync_pin = (u32::from_str_radix(&random_hex(3), 16).unwrap_or(0) % 900_000 + 100_000).to_string();
                }
                while data.device == 0 {
                    data.device = u32::from_str_radix(&random_hex(2), 16).unwrap_or(0);
                }
            }
            // a locked file is read after the password is entered
            let (enabled, port) = (data.sync_enabled && !enc.encrypted, data.sync_port);
            let core = Arc::new(Core {
                path,
                data: Mutex::new(data),
                server: Mutex::new(None),
                tunnel: Mutex::new(None),
                auth_fail: Mutex::new((0, None)),
                progress: Mutex::new(Progress::default()),
                plan_lock: Mutex::new(()),
                enc: Mutex::new(enc),
                rev: Default::default(),
                peer_status: Default::default(),
                last_sweep: Default::default(),
            });
            if enabled {
                if let Err(e) = core.start_server("0.0.0.0", port) {
                    eprintln!("{e}");
                }
            }
            let c = core.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(20));
                loop {
                    if let Err(e) = c.auto_backup(false) {
                        eprintln!("自動備份失敗：{e}");
                    }
                    thread::sleep(Duration::from_secs(1800));
                }
            });
            app.manage(core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![call, app_version, check_update, install_update])
        .build(tauri::generate_context!())
        .expect("error while building MoneyPi")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(core) = app.try_state::<Arc<Core>>() {
                    core.tunnel_stop(); // never leave cloudflared running after the app closes
                }
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn official_links_allow_only_known_pages() {
        for url in [
            "https://www.ishares.com/us/products/314116/ishares-0-3-month-treasury-bond-etf",
            "https://www.yuantaetfs.com/product/detail/0050/Basic_information",
            "https://investor.vanguard.com/investment-products/etfs/profile/vt",
            "https://investor.vanguard.com/investment-products/etfs/profile/voo",
            "https://investor.tsmc.com/chinese",
        ] { assert_eq!(external_url(url).unwrap(), url); }
        assert!(external_url("releases").unwrap().starts_with("https://github.com/"));
        for invalid in ["https://example.com", "javascript:alert(1)", "file:///etc/passwd", "https://investor.tsmc.com/chinese&calc", "https://investor.tsmc.com.evil.test/chinese"] {
            assert!(external_url(invalid).is_err());
        }
    }


    #[test]
    fn tracker_backup_converts_holdings_and_days() {
        let json = r#"{"holdings":[
          {"name":"興富發建設","symbol":"2542:TPE","currency":"TWD","account":"國泰","manualNav":false,
           "transactions":[{"kind":"buy","date":"2026-08-14","shares":1.0,"price":46.05,"fee":1.0},{"kind":"bogus","date":"2026-08-15","shares":1.0,"price":1.0,"fee":0.0}]},
          {"name":"某基金","symbol":"某基金","currency":"TWD","account":"投信","manualNav":true,"navHistory":{"2026-08-01":700.0,"2026-11-06":576.27},
           "transactions":[{"kind":"buy","date":"2026-03-03","shares":10.0,"price":600.0,"fee":0.0}]},
          {"name":"沒有交易","symbol":"1:TPE","transactions":[]}],
          "snapshots":[{"date":"2026-08-17","total":54727.027,"positions":[]},{"date":"bad","total":1.0}]}"#;
        let (assets, days, skipped) = parse_tracker(json).unwrap();
        assert_eq!((assets.len(), days.len(), skipped), (2, 1, 1));
        let (a, f) = (&assets[0], &assets[1]);
        assert_eq!((a.symbol.as_str(), a.market.as_str(), a.category.as_str(), a.price), ("2542", "tw", "股票", 46.05));
        assert_eq!((f.symbol.as_str(), f.market.as_str(), f.category.as_str(), f.price, f.price_updated.as_str()), ("", "", "基金/ETF", 576.27, "2026-11-06"));
        assert!(parse_tracker("{\"a\":1}").is_err());
    }

    #[test]
    fn history_import_adds_missing_days_only() {
        let mut snaps = vec![Snapshot { date: "2026-08-18".into(), assets: 1.0, liabilities: 0.0 }];
        let csv = "\u{feff}日期,總資產,投資市值,幣別\n2026-08-17,\"54,727.03\",1,TWD\n2026-08-18,56346.49,1,TWD\n2026/8/19,55126.24,1,TWD\n2030-01-01,9,1,TWD\n\n";
        let (added, skipped) = merge_history(&mut snaps, csv, "2026-11-07").unwrap();
        assert_eq!((added, skipped), (2, 2)); // 08-18 exists, 2030 is in the future
        assert_eq!(snaps.iter().map(|s| s.date.as_str()).collect::<Vec<_>>(), ["2026-08-17", "2026-08-18", "2026-08-19"]);
        assert_eq!(snaps[0].assets, 54727.03);
        assert_eq!(snaps[1].assets, 1.0, "existing snapshot must not be overwritten");
        assert!(merge_history(&mut snaps, "名稱,金額\nx,1\n", "2026-11-07").is_err());
        assert!(merge_history(&mut snaps, "日期,總資產\n2026-02-30,5\n", "2026-11-07").is_err());
        assert!(merge_history(&mut snaps, "日期,總資產\n2026-08-20,abc\n", "2026-11-07").is_err());
    }
    use super::*;

    fn tx(date: &str, kind: &str, units: f64, price: f64, fee: f64) -> Tx {
        Tx { date: date.into(), kind: kind.into(), units, price, fee, ..Default::default() }
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
    fn legacy_refresh_minutes_become_seconds() {
        let mut d: Data = serde_json::from_str(r#"{"next_id":0,"assets":[],"snapshots":[],"refresh_min":15}"#).unwrap();
        migrate(&mut d);
        migrate(&mut d);
        assert_eq!((d.refresh_sec, d.refresh_min), (900, 0));
        let mut off: Data = serde_json::from_str(r#"{"next_id":0,"assets":[],"snapshots":[]}"#).unwrap();
        migrate(&mut off);
        assert_eq!(off.refresh_sec, 0, "an old file without the setting stays off");
        assert!(!serde_json::to_string(&d).unwrap().contains("refresh_min"));
        let core = temp_core("settings");
        assert!(core.set_settings([("TWD".to_string(), 1.0)].into(), 7).is_err(), "unsupported interval");
        assert!(core.set_settings([("TWD".to_string(), 1.0)].into(), 15).is_ok());
        assert_eq!(core.data.lock().unwrap().refresh_sec, 15);
    }

    #[test]
    fn wait_rev_returns_when_data_changes() {
        let core = std::sync::Arc::new(temp_core("rev"));
        let r0 = core.wait_rev(-1)["rev"].as_i64().unwrap();
        let c2 = core.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            let mut d = c2.data.lock().unwrap();
            c2.persist(&mut d).unwrap();
        });
        let t = Instant::now();
        let r1 = core.wait_rev(r0)["rev"].as_i64().unwrap();
        assert!(r1 > r0 && t.elapsed() < Duration::from_secs(3), "woke on the write, not on the timeout");
    }

    /// Real Yahoo requests: `cargo test live_refresh -- --ignored --nocapture`
    #[test]
    #[ignore = "uses the network"]
    fn live_refresh_is_parallel() {
        let core = temp_core("live");
        let symbols = ["2330", "2317", "2454", "2412", "2882", "2881", "1301", "1303", "2002", "2603", "2308", "3711", "2891", "5880", "0050", "0056"];
        {
            let mut d = core.data.lock().unwrap();
            for (i, sym) in symbols.iter().enumerate() {
                d.assets.push(Asset { id: i as u64 + 1, name: sym.to_string(), category: "股票".into(), holding: true, symbol: sym.to_string(), market: "tw".into(), quantity: 1.0, ..Default::default() });
            }
        }
        let t = Instant::now();
        for sym in symbols {
            let _ = fetch_quote(sym, "tw");
        }
        let seq = t.elapsed();
        let t = Instant::now();
        let r = core.refresh_quotes().unwrap();
        let par = t.elapsed();
        println!("sequential quotes only: {seq:?}\nrefresh_quotes (quotes + fx, parallel): {par:?}\nresult: updated={} rates={} failed={}", r["updated"], r["rates"], r["failed"]);
        assert!(r["updated"].as_u64().unwrap() >= 12, "most symbols should have a price");
        assert!(core.data.lock().unwrap().assets.iter().all(|a| a.price >= 0.0));
    }

    /// Smoke test with real exports: `MONEYPI_TRACKER=backup.json MONEYPI_HISTORY=history.csv cargo test real_files -- --ignored --nocapture`
    #[test]
    #[ignore = "needs MONEYPI_TRACKER / MONEYPI_HISTORY files"]
    fn real_files_import_end_to_end() {
        let core = Arc::new(temp_core("real"));
        if let Ok(f) = std::env::var("MONEYPI_HISTORY") {
            let r = dispatch(&core, "import_history", json!({ "text": std::fs::read_to_string(f).unwrap() }), false).unwrap();
            println!("history: added={} skipped={}", r["added"], r["skipped"]);
        }
        if let Ok(f) = std::env::var("MONEYPI_TRACKER") {
            let text = std::fs::read_to_string(f).unwrap();
            let r = dispatch(&core, "import_tracker", json!({ "text": text }), false).unwrap();
            println!("tracker: added={} dup={} days={} days_skipped={} skipped_tx={}", r["added"].as_array().unwrap().len(), r["duplicates"], r["days"], r["days_skipped"], r["skipped_tx"]);
            let again = dispatch(&core, "import_tracker", json!({ "text": text }), false).unwrap();
            assert_eq!(again["added"].as_array().unwrap().len(), 0, "second import must not duplicate holdings");
            assert_eq!(again["duplicates"].as_array().unwrap().len(), r["added"].as_array().unwrap().len());
        }
        let d = core.data.lock().unwrap();
        let (mut value, mut cost) = (0.0, 0.0);
        for a in &d.assets {
            println!("{:<16} {:<6} {:<5} qty={:<6} price={:<8} cost={:<10.2} value={:<10.2} txs={}", a.name.chars().take(8).collect::<String>(), a.symbol, a.market, a.quantity, a.price, a.cost, a.value, a.txs.len());
            value += a.value;
            cost += a.cost;
        }
        println!("assets={} snapshots={} total value={:.2} total cost={:.2}", d.assets.len(), d.snapshots.len(), value, cost);
        assert!(d.assets.iter().all(|a| a.holding && a.quantity > 0.0 && a.value > 0.0));
    }

    // ------------------------------------------------------------- two-device sync

    fn pair() -> (Arc<Core>, Arc<Core>) {
        let (a, b) = (Arc::new(temp_core("syncA")), Arc::new(temp_core("syncB")));
        {
            let mut d = b.data.lock().unwrap();
            d.device = 7;
            d.primary = false;
        }
        for c in [&a, &b] {
            c.data.lock().unwrap().install_id = random_hex(8);
        }
        (a, b)
    }
    fn save(c: &Arc<Core>, v: Value) -> Value {
        dispatch(c, "save_asset", json!({ "asset": v }), false).unwrap()
    }
    /// What the real exchange does: A sends to B, B answers with its merged state, A merges that back.
    fn exchange(a: &Arc<Core>, b: &Arc<Core>) -> (u64, u64) {
        let pa = sync_payload(&a.data.lock().unwrap());
        let rb = b.sync(pa).unwrap();
        let back: SyncPayload = serde_json::from_value(rb["payload"].clone()).unwrap();
        let ra = a.sync(back).unwrap();
        (rb["changed"].as_u64().unwrap(), ra["changed"].as_u64().unwrap())
    }
    fn names(c: &Arc<Core>) -> Vec<String> {
        let mut v: Vec<String> = c.data.lock().unwrap().assets.iter().map(|a| a.name.clone()).collect();
        v.sort();
        v
    }
    fn cash(name: &str, value: f64) -> Value {
        json!({ "name": name, "category": "銀行存款", "currency": "TWD", "value": value })
    }
    fn pause() {
        thread::sleep(Duration::from_millis(5));
    }

    #[test]
    fn devices_add_offline_without_id_clashes_and_converge() {
        let (pc, phone) = pair();
        save(&pc, cash("電腦存款", 100.0));
        save(&phone, cash("手機現金", 50.0));
        let (id_pc, id_phone) = (pc.data.lock().unwrap().assets[0].id, phone.data.lock().unwrap().assets[0].id);
        assert_eq!(id_pc, 1, "the desktop keeps plain ids");
        assert_eq!(id_phone, (7u64 << 32) | 1);
        assert!(id_phone < (1u64 << 53), "must stay exact in JavaScript");
        let (c1, c2) = exchange(&pc, &phone);
        assert!(c1 > 0 && c2 > 0);
        assert_eq!(names(&pc), ["手機現金", "電腦存款"]);
        assert_eq!(names(&phone), names(&pc));
        assert_eq!(exchange(&pc, &phone), (0, 0), "a second round changes nothing");
        // both keep creating without clashes afterwards
        save(&pc, cash("電腦 2", 1.0));
        save(&phone, cash("手機 2", 1.0));
        exchange(&pc, &phone);
        let ids: std::collections::HashSet<u64> = pc.data.lock().unwrap().assets.iter().map(|a| a.id).collect();
        assert_eq!((ids.len(), names(&pc).len(), names(&phone)), (4, 4, names(&pc)));
    }

    #[test]
    fn the_later_edit_wins_and_quote_refreshes_do_not_count_as_edits() {
        let (pc, phone) = pair();
        save(&pc, cash("存款", 100.0));
        exchange(&pc, &phone);
        let id = pc.data.lock().unwrap().assets[0].id;
        // PC edits first, the phone edits the same record later: the phone's edit wins everywhere
        let mut v = serde_json::to_value(&pc.data.lock().unwrap().assets[0]).unwrap();
        v["value"] = json!(111.0);
        save(&pc, v);
        pause();
        let mut v = serde_json::to_value(&phone.data.lock().unwrap().assets[0]).unwrap();
        v["value"] = json!(222.0);
        save(&phone, v);
        exchange(&pc, &phone);
        for c in [&pc, &phone] {
            assert_eq!(c.data.lock().unwrap().assets.iter().find(|a| a.id == id).unwrap().value, 222.0);
        }
        // a price refresh of a quoted holding (market set) must not look like an edit
        let mut h = cash("台積電", 0.0);
        h["holding"] = json!(true);
        h["market"] = json!("tw");
        h["symbol"] = json!("2330");
        h["quantity"] = json!(1.0);
        h["price"] = json!(500.0);
        save(&pc, h);
        let hid = pc.data.lock().unwrap().assets.iter().find(|a| a.name == "台積電").unwrap().id;
        let before = pc.data.lock().unwrap().stamps[&format!("a:{hid}")].clone();
        pause();
        {
            let mut d = pc.data.lock().unwrap();
            let a = d.assets.iter_mut().find(|a| a.id == hid).unwrap();
            a.price = 999.0;
            a.price_updated = "2026-11-10 13:30".into();
            recompute(a);
            pc.persist(&mut d).unwrap();
        }
        assert_eq!(pc.data.lock().unwrap().stamps[&format!("a:{hid}")], before);
    }

    #[test]
    fn deletes_travel_and_a_newer_edit_beats_an_older_delete() {
        let (pc, phone) = pair();
        save(&pc, cash("要刪除", 1.0));
        save(&pc, cash("要修改", 1.0));
        exchange(&pc, &phone);
        let (del_id, keep_id) = {
            let d = pc.data.lock().unwrap();
            (d.assets.iter().find(|a| a.name == "要刪除").unwrap().id, d.assets.iter().find(|a| a.name == "要修改").unwrap().id)
        };
        dispatch(&phone, "delete_asset", json!({ "id": del_id }), false).unwrap();
        pause();
        dispatch(&phone, "delete_asset", json!({ "id": keep_id }), false).unwrap(); // phone deletes it...
        pause();
        let mut v = serde_json::to_value(pc.data.lock().unwrap().assets.iter().find(|a| a.id == keep_id).unwrap()).unwrap();
        v["value"] = json!(5.0);
        save(&pc, v); // ...but the PC edits it afterwards
        exchange(&pc, &phone);
        assert_eq!(names(&pc), ["要修改"]);
        assert_eq!(names(&phone), ["要修改"]);
        assert_eq!(phone.data.lock().unwrap().assets[0].value, 5.0);
    }

    #[test]
    fn goals_flows_plans_and_history_sync_and_dangling_references_are_cleaned() {
        let (pc, phone) = pair();
        save(&pc, cash("存款", 100.0));
        exchange(&pc, &phone);
        let aid = pc.data.lock().unwrap().assets[0].id;
        dispatch(&phone, "save_goal", json!({ "goal": { "name": "旅行", "amount": 1000.0, "assets": [aid] } }), false).unwrap();
        dispatch(&phone, "add_flow", json!({ "flow": { "date": "2026-11-09", "kind": "out", "category": "餐飲", "amount": 80.0 } }), false).unwrap();
        pc.data.lock().unwrap().snapshots.push(Snapshot { date: "2026-10-01".into(), assets: 10.0, liabilities: 0.0 });
        exchange(&pc, &phone);
        {
            let d = pc.data.lock().unwrap();
            assert_eq!((d.goals.len(), d.cashflow.len()), (1, 1));
        }
        assert!(phone.data.lock().unwrap().snapshots.iter().any(|s| s.date == "2026-10-01"));
        // the PC deletes the asset: the goal that pointed at it must not keep a dangling id on either side
        dispatch(&pc, "delete_asset", json!({ "id": aid }), false).unwrap();
        pause();
        exchange(&pc, &phone);
        assert!(phone.data.lock().unwrap().goals[0].assets.is_empty());
        assert!(phone.data.lock().unwrap().assets.is_empty());
    }

    #[test]
    fn only_the_primary_device_books_plans_and_dividends() {
        let (_pc, phone) = pair();
        let r = dispatch(&phone, "run_plans", json!({}), false).unwrap();
        assert_eq!(r["added"], 0);
        let r = dispatch(&phone, "run_dividends", json!({}), false).unwrap();
        assert_eq!(r["added"], 0);
    }

    #[test]
    fn data_from_before_sync_support_counts_as_old_and_keeps_its_ids() {
        let mut d: Data = serde_json::from_str(r#"{"next_id":2,"assets":[{"id":1,"name":"舊存款","category":"銀行存款","currency":"TWD","value":5.0},{"id":2,"name":"舊現金","category":"現金","currency":"TWD","value":6.0}],"snapshots":[]}"#).unwrap();
        migrate(&mut d);
        assert_eq!(d.stamps.len(), 2);
        assert!(d.stamps.values().all(|s| s.at == 0 && !s.del));
        assert_eq!((d.device, d.primary), (0, true));
        assert_eq!(d.assets.iter().map(|a| a.id).collect::<Vec<_>>(), [1, 2]);
        // a peer edit made after the upgrade beats the untouched old record
        let mut remote = sync_payload(&d);
        remote.assets[0].value = 9.0;
        remote.stamps.insert("a:1".into(), Stamp { h: 123, at: 5, del: false });
        merge_payload(&mut d, &remote, 10, 0);
        assert_eq!(d.assets[0].value, 9.0);
        // a payload without stamps (older peer) never overrides
        let mut old = sync_payload(&d);
        old.stamps.clear();
        old.assets[1].value = 1.0;
        merge_payload(&mut d, &old, 20, 0);
        assert_eq!(d.assets[1].value, 6.0);
    }

    /// Real export on the "phone": `MONEYPI_TRACKER=backup.json cargo test real_files_sync -- --ignored --nocapture`
    #[test]
    #[ignore = "needs MONEYPI_TRACKER"]
    fn real_files_sync_to_an_empty_phone() {
        let (pc, phone) = pair();
        let text = std::fs::read_to_string(std::env::var("MONEYPI_TRACKER").unwrap()).unwrap();
        dispatch(&pc, "import_tracker", json!({ "text": text }), false).unwrap();
        let (c1, _) = exchange(&pc, &phone);
        {
            let d = phone.data.lock().unwrap();
            println!("records sent to the phone: {c1}; phone has {} assets, {} snapshots", d.assets.len(), d.snapshots.len());
        }
        assert_eq!(names(&phone), names(&pc));
        let total = |c: &Arc<Core>| c.data.lock().unwrap().assets.iter().map(|a| a.value).sum::<f64>();
        assert!((total(&phone) - total(&pc)).abs() < 1e-6);
        assert_eq!(exchange(&pc, &phone), (0, 0));
    }


    // --------------------------------------------------------------- pairing over real HTTP

    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    #[test]
    fn peer_links_are_read_leniently_and_checked() {
        assert_eq!(parse_peer_link("192.168.1.5:8787", "123456").unwrap(), ("http://192.168.1.5:8787".into(), "123456".into()));
        assert_eq!(parse_peer_link("http://pc.local:9000/#pin=424242", "").unwrap(), ("http://pc.local:9000".into(), "424242".into()));
        assert_eq!(parse_peer_link(" 10.0.0.2 ", "1234").unwrap().0, format!("http://10.0.0.2:{DEFAULT_PORT}"));
        assert_eq!(parse_peer_link("http://10.0.0.2:8787/#pin=1111", "2222").unwrap().1, "2222", "the typed PIN wins");
        for bad in [("", "1234"), ("ftp://x:1", "1234"), ("http://", "1234"), ("http://user@host:1", "1234"), ("192.168.1.5:8787", "")] {
            assert!(parse_peer_link(bad.0, bad.1).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn two_devices_pair_sync_both_ways_and_notice_when_the_other_is_gone() {
        let (pc, phone) = pair();
        let (pa, pb) = (free_port(), free_port());
        for (c, pin, port) in [(&pc, "123456", pa), (&phone, "654321", pb)] {
            {
                let mut d = c.data.lock().unwrap();
                d.sync_pin = pin.into();
                d.sync_port = port;
            }
            c.start_server("0.0.0.0", port).unwrap();
        }
        save(&pc, cash("電腦存款", 100.0));
        save(&phone, cash("手機現金", 50.0));

        // wrong PIN: refused, nothing merged, status says so
        let e = phone.pair_peer(&format!("127.0.0.1:{pa}"), "000000").unwrap_err();
        assert!(e.contains("PIN"), "{e}");
        assert_eq!(phone.peer_status.lock().unwrap().state, "denied");
        assert_eq!(names(&phone), ["手機現金"]);

        // right PIN: the first sync binds and merges
        let info = phone.pair_peer(&format!("127.0.0.1:{pa}"), "123456").unwrap();
        assert_eq!(info["bound"], true);
        assert_eq!(names(&phone), ["手機現金", "電腦存款"]);
        assert_eq!(names(&pc), names(&phone));
        // the PC learned how to reach the phone, if it has a LAN address in this environment
        let reachable_back = phone.reply_info().is_some();
        println!("reverse direction testable: {reachable_back}");
        assert_eq!(pc.data.lock().unwrap().peer.is_some(), reachable_back);
        // the PIN never leaves through the view the UI gets
        assert!(!serde_json::to_string(&view(&phone.data.lock().unwrap())).unwrap().contains("123456"));

        // phone edits -> PC receives it when the phone syncs
        save(&phone, cash("手機 2", 1.0));
        assert_eq!(phone.sync_peer().unwrap()["state"], "ok");
        assert_eq!(names(&pc), names(&phone));
        // PC edits -> the PC checks the phone (the "computer starts up and looks for the phone" direction)
        if reachable_back {
            save(&pc, cash("電腦 2", 2.0));
            assert_eq!(pc.sync_peer().unwrap()["state"], "ok");
            assert_eq!(names(&phone), names(&pc));
            assert_eq!(names(&pc).len(), 4);
        }

        // the PC is switched off: the phone reports it instead of failing
        pc.stop_server();
        thread::sleep(Duration::from_millis(200));
        let t = Instant::now();
        let r = phone.sync_peer().unwrap();
        assert_eq!(r["state"], "offline");
        assert!(t.elapsed() < Duration::from_secs(6));
        save(&phone, cash("離線新增", 3.0)); // still works offline
        assert!(names(&phone).contains(&"離線新增".to_string()));

        // unbinding forgets the peer
        assert_eq!(phone.unpair_peer()["bound"], false);
        assert!(phone.sync_peer().is_err());
        phone.stop_server();
    }


    // ------------------------------------------------ moved peer + concurrent edits

    #[test]
    fn a_moved_peer_is_found_again_by_its_id() {
        let (pc, phone) = pair();
        let pa = free_port();
        {
            let mut d = pc.data.lock().unwrap();
            d.sync_pin = "123456".into();
            d.sync_port = pa;
        }
        pc.start_server("0.0.0.0", pa).unwrap();
        // /moneypi-id says who it is and nothing else
        let v: Value = ureq::get(&format!("http://127.0.0.1:{pa}/moneypi-id")).call().unwrap().into_json().unwrap();
        assert_eq!(v.as_object().unwrap().len(), 2);
        let id = pc.data.lock().unwrap().install_id.clone();
        assert_eq!((v["app"].as_str(), v["id"].as_str()), (Some("moneypi"), Some(id.as_str())));

        phone.pair_peer(&format!("127.0.0.1:{pa}"), "123456").unwrap();
        assert_eq!(phone.data.lock().unwrap().peer.as_ref().unwrap().id, id);

        // the PC got a new address: the phone still has the old one (a blackhole address) but knows the id
        let moved = |c: &Arc<Core>| c.data.lock().unwrap().peer.as_mut().unwrap().url = format!("http://192.0.2.1:{pa}");
        moved(&phone);
        save(&pc, cash("換 IP 後新增", 1.0));
        let r = phone.sync_peer_with(&|| vec!["127.0.0.1".into()]).unwrap();
        assert_eq!(r["state"], "ok", "{r}");
        assert_eq!(phone.data.lock().unwrap().peer.as_ref().unwrap().url, format!("http://127.0.0.1:{pa}"));
        assert!(names(&phone).contains(&"換 IP 後新增".to_string()));

        // a second loss within two minutes does not sweep the network again
        moved(&phone);
        let r = phone.sync_peer_with(&|| panic!("must not sweep again so soon")).unwrap();
        assert_eq!(r["state"], "offline");

        // somebody else with a different id is never taken for the PC
        phone.last_sweep.store(0, std::sync::atomic::Ordering::SeqCst);
        phone.data.lock().unwrap().peer.as_mut().unwrap().id = "not-the-pc".into();
        let r = phone.sync_peer_with(&|| vec!["127.0.0.1".into()]).unwrap();
        assert_eq!(r["state"], "offline");
        assert!(phone.data.lock().unwrap().peer.as_ref().unwrap().url.contains("192.0.2.1"));
        pc.stop_server();
    }

    fn bind_for_merge(a: &Arc<Core>, b: &Arc<Core>) {
        // what a real pairing records: the time of the last sync (the base for telling real conflicts apart)
        let t = now_ms();
        for c in [a, b] {
            c.data.lock().unwrap().peer = Some(Peer { url: "http://x:1".into(), pin: "1".into(), name: "x".into(), id: String::new(), last_sync: t });
        }
        pause();
    }
    fn buy(c: &Arc<Core>, id: u64, date: &str, units: f64, price: f64) {
        dispatch(c, "add_tx", json!({ "id": id, "tx": { "date": date, "kind": "buy", "units": units, "price": price, "fee": 0.0 } }), false).unwrap();
    }
    fn stock_json(name: &str) -> Value {
        json!({ "name": name, "category": "股票", "currency": "TWD", "value": 0.0, "holding": true, "market": "", "symbol": "", "quantity": 0.0, "price": 10.0 })
    }
    fn tx_count(c: &Arc<Core>, id: u64) -> (usize, f64) {
        let d = c.data.lock().unwrap();
        let a = d.assets.iter().find(|a| a.id == id).unwrap();
        (a.txs.len(), a.quantity)
    }

    #[test]
    fn buys_entered_on_both_devices_since_the_last_sync_are_all_kept() {
        let (pc, phone) = pair();
        save(&pc, stock_json("台積電"));
        exchange(&pc, &phone);
        let id = pc.data.lock().unwrap().assets[0].id;
        bind_for_merge(&pc, &phone);
        buy(&pc, id, "2026-11-10", 1.0, 100.0);
        pause();
        buy(&phone, id, "2026-11-11", 2.0, 110.0);
        for _ in 0..3 {
            exchange(&pc, &phone);
        }
        assert_eq!(tx_count(&pc, id), (2, 3.0));
        assert_eq!(tx_count(&phone, id), (2, 3.0));
        assert_eq!(exchange(&pc, &phone), (0, 0), "settled");
    }

    #[test]
    fn a_buy_entered_identically_on_both_sides_counts_once_but_two_real_ones_stay_two() {
        let a = Asset { txs: vec![tx("2026-11-10", 1.0, 100.0), tx("2026-11-10", 1.0, 100.0)], ..Default::default() };
        let b = Asset { txs: vec![tx("2026-11-10", 1.0, 100.0), tx("2026-11-11", 5.0, 9.0)], ..Default::default() };
        let m = merge_asset_conflict(&a, &b);
        assert_eq!(m.txs.len(), 3, "two identical stay two (the larger count), plus the one only b has");
        fn tx(date: &str, units: f64, price: f64) -> Tx {
            Tx { date: date.into(), kind: "buy".into(), units, price, ..Default::default() }
        }
    }

    // ------------------------------------------------------------- main currency

    #[test]
    fn a_new_install_asks_for_the_currency_but_old_files_count_as_chosen() {
        let fresh = Data::default();
        assert_eq!((fresh.base.as_str(), fresh.base_set), ("TWD", false));
        let old: Data = serde_json::from_str(r#"{"next_id":0,"assets":[],"snapshots":[]}"#).unwrap();
        assert_eq!((old.base.as_str(), old.base_set), ("TWD", true), "no prompt for people who already use the app");
    }

    #[test]
    fn choosing_a_currency_on_a_new_install_seeds_rates_around_it() {
        let c = Arc::new(temp_core("basejpy"));
        let v = dispatch(&c, "set_base", json!({ "code": " jpy " }), false).unwrap();
        assert_eq!(v["base"], "JPY");
        assert_eq!(v["base_set"], true);
        let d = c.data.lock().unwrap();
        assert_eq!(d.rates["JPY"], 1.0);
        assert!((d.rates["TWD"] - 0.03125 / 0.00656 as f64).abs() < 1e-9, "TWD is worth ~4.76 yen");
        assert!(d.rates.contains_key("USD") && d.rates.contains_key("EUR"));
        drop(d);
        // the rate form and the settings check now use JPY as the one
        assert!(c.set_settings([("TWD".to_string(), 1.0)].into(), 15).is_err());
        let ok: BTreeMap<String, f64> = [("JPY".to_string(), 1.0), ("USD".to_string(), 150.0)].into();
        assert!(c.set_settings(ok, 15).is_ok());
        assert_eq!(rate_quote("jpy", "JPY").unwrap()["rate"], 1.0);
        assert_eq!(fx_symbol("USD", "JPY"), "USDJPY=X");
        assert!(dispatch(&c, "set_base", json!({ "code": "x" }), false).is_err());
    }

    #[test]
    fn changing_the_currency_later_converts_stored_totals_and_keeps_a_copy() {
        let c = Arc::new(temp_core("rebase"));
        dispatch(&c, "set_base", json!({ "code": "TWD" }), false).unwrap();
        save(&c, cash("銀行", 3200.0));
        save(&c, json!({ "name": "美金", "category": "現金", "currency": "USD", "value": 100.0 }));
        dispatch(&c, "add_flow", json!({ "flow": { "date": "2026-11-01", "kind": "out", "category": "餐飲", "amount": 320.0 } }), false).unwrap();
        dispatch(&c, "save_goal", json!({ "goal": { "name": "目標", "amount": 6400.0 } }), false).unwrap();
        let usd_rate = c.data.lock().unwrap().rates["USD"]; // TWD per USD (32)
        let before = c.data.lock().unwrap().snapshots.last().unwrap().assets;
        let v = dispatch(&c, "set_base", json!({ "code": "USD" }), false).unwrap();
        assert_eq!(v["base"], "USD");
        let d = c.data.lock().unwrap();
        assert_eq!(d.rates["USD"], 1.0);
        assert!((d.rates["TWD"] - 1.0 / usd_rate).abs() < 1e-9);
        assert_eq!(round_sig(4.761904761904762, 9), 4.76190476);
        assert_eq!(d.assets.iter().find(|a| a.name == "銀行").unwrap().value, 3200.0, "an item keeps its own currency and amount");
        assert!((d.cashflow[0].amount - 320.0 / usd_rate).abs() < 1e-9);
        assert!((d.goals[0].amount - 6400.0 / usd_rate).abs() < 1e-9);
        assert!((d.snapshots.last().unwrap().assets - before / usd_rate).abs() < 1e-6);
        drop(d);
        // and back again lands on the original numbers
        dispatch(&c, "set_base", json!({ "code": "TWD" }), false).unwrap();
        let d = c.data.lock().unwrap();
        assert!((d.cashflow[0].amount - 320.0).abs() < 1e-6);
        assert!((d.rates["USD"] - usd_rate).abs() < 1e-9);
        assert!(c.path.with_extension("before-rebase.json").exists());
        // a currency with no rate yet and not in the built-in list is refused rather than guessed
        drop(d);
        assert!(c.set_base("ZZZ").is_err());
    }

    #[test]
    fn two_devices_with_different_main_currencies_do_not_mix() {
        let (pc, phone) = pair();
        for c in [&pc, &phone] {
            dispatch(c, "set_base", json!({ "code": "TWD" }), false).unwrap();
        }
        save(&pc, cash("電腦存款", 100.0));
        save(&phone, cash("手機存款", 5.0));
        dispatch(&phone, "set_base", json!({ "code": "JPY" }), false).unwrap();
        let before = names(&pc);
        let pa = sync_payload(&pc.data.lock().unwrap());
        let err = phone.sync(pa).err().unwrap();
        assert!(err.contains("主要幣別不同"), "{err}");
        assert_eq!(names(&phone), vec!["手機存款".to_string()], "nothing was merged");
        assert_eq!(names(&pc), before);
        // same currency again: they sync
        dispatch(&phone, "set_base", json!({ "code": "TWD" }), false).unwrap();
        exchange(&pc, &phone);
        assert_eq!(names(&phone).len(), 2);
    }

    #[test]
    fn a_fresh_phone_adopts_the_computers_currency_and_does_not_disturb_it() {
        let (pc, phone) = pair();
        dispatch(&pc, "set_base", json!({ "code": "JPY" }), false).unwrap();
        save(&pc, json!({ "name": "日圓存款", "category": "銀行存款", "currency": "JPY", "value": 5000.0 }));
        assert!(phone.data.lock().unwrap().base_set == false);
        let pc_rates = pc.data.lock().unwrap().rates.clone();
        // phone connects first: its payload says it is fresh, so the computer keeps its own rates and currency
        let (a, b) = exchange(&phone, &pc);
        assert_eq!(a, 0, "nothing was changed on the computer");
        let _ = b;
        assert_eq!(pc.data.lock().unwrap().base, "JPY");
        assert_eq!(pc.data.lock().unwrap().rates, pc_rates);
        let d = phone.data.lock().unwrap();
        assert_eq!((d.base.as_str(), d.base_set), ("JPY", true));
        assert_eq!(d.rates, pc_rates);
        assert_eq!(d.assets.len(), 1);
    }

    #[test]
    fn an_older_peer_without_a_currency_counts_as_twd() {
        let (pc, phone) = pair();
        save(&pc, cash("存款", 1.0));
        let mut p = sync_payload(&pc.data.lock().unwrap());
        p.base = String::new();
        p.fresh = false;
        assert!(phone.sync(p).is_ok());
        assert_eq!(phone.data.lock().unwrap().base, "TWD");
    }

    // ------------------------------------------------------------- phone update notice

    #[test]
    fn versions_compare_by_number_and_a_preview_is_below_its_stable_release() {
        assert_eq!(version_key("v0.21.1"), Some((0, 21, 1, u64::MAX)));
        assert_eq!(version_key("0.22.0-preview.3"), Some((0, 22, 0, 3)));
        assert!(version_key("0.9.0") < version_key("0.21.0"), "0.9 is older than 0.21");
        assert!(version_key("0.22.0-preview.2") < version_key("0.22.0-preview.10"), "preview numbers are numbers");
        assert!(version_key("0.22.0-preview.9") < version_key("0.22.0"), "a preview is older than its stable release");
        assert!(version_key("0.21.5") < version_key("0.22.0-preview.1"), "but newer than the previous stable one");
        for bad in ["", "v1", "1.2", "1.2.3.4", "1.2.x", "latest", "v-1.0.0", "preview-channel", "0.22.0-beta.1", "0.22.0-preview", "0.22.0-preview.x", "0.22.0-preview.1.2"] {
            assert_eq!(version_key(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_update_notice_offers_the_best_newer_release_for_the_channel_and_only_with_its_apk() {
        let apk = |v: &str| format!("https://github.com/hankyleisplay/moneypi/releases/download/v{v}/MoneyPi_{v}_android.apk");
        let rel = |v: &str, pre: bool, with_apk: bool| {
            let assets = if with_apk { json!([{ "browser_download_url": format!("https://github.com/hankyleisplay/moneypi/releases/download/v{v}/x.exe") }, { "browser_download_url": apk(v) }]) } else { json!([]) };
            json!({ "tag_name": format!("v{v}"), "body": "notes", "draft": false, "prerelease": pre, "assets": assets })
        };
        // single release (what /releases/latest returns)
        let u = pick_update(&rel("0.21.1", false, true), "0.21.0", "stable").unwrap();
        assert_eq!((u["version"].as_str(), u["url"].as_str(), u["notes"].as_str(), u["preview"].as_bool()), (Some("0.21.1"), Some(apk("0.21.1").as_str()), Some("notes"), Some(false)));
        assert!(pick_update(&rel("0.21.0", false, true), "0.21.0", "stable").is_none(), "same version");
        assert!(pick_update(&rel("0.20.9", false, true), "0.21.0", "stable").is_none(), "older");
        assert!(pick_update(&rel("0.21.1", false, false), "0.21.0", "stable").is_none(), "APK not attached yet");
        let mut draft = rel("0.22.0", false, true);
        draft["draft"] = json!(true);
        assert!(pick_update(&draft, "0.21.0", "preview").is_none(), "drafts are never offered");
        assert!(pick_update(&json!({ "message": "rate limited" }), "0.21.0", "stable").is_none());
        let evil = json!({ "tag_name": "v0.22.0", "assets": [{ "browser_download_url": "https://evil.example/MoneyPi.apk" }] });
        assert!(pick_update(&evil, "0.21.0", "stable").is_none(), "only this project's own APK");

        // the release list: previews only count on the preview channel, and the highest version wins
        let list = json!([rel("0.22.0-preview.2", true, true), rel("0.22.0-preview.1", true, true), rel("0.21.1", false, true), rel("0.21.0", false, true), json!({ "tag_name": "preview-channel", "prerelease": true, "assets": [] })]);
        assert_eq!(pick_update(&list, "0.21.0", "stable").unwrap()["version"], "0.21.1", "stable never gets a preview");
        let p = pick_update(&list, "0.21.0", "preview").unwrap();
        assert_eq!((p["version"].as_str(), p["preview"].as_bool()), (Some("0.22.0-preview.2"), Some(true)));
        assert_eq!(pick_update(&list, "0.22.0-preview.1", "preview").unwrap()["version"], "0.22.0-preview.2");
        assert!(pick_update(&list, "0.22.0-preview.2", "preview").is_none(), "already on the newest preview");
        // when the stable release arrives it is newer than its previews
        let list = json!([rel("0.22.0", false, true), rel("0.22.0-preview.2", true, true)]);
        assert_eq!(pick_update(&list, "0.22.0-preview.2", "preview").unwrap()["version"], "0.22.0");
        assert_eq!(pick_update(&list, "0.22.0-preview.2", "stable").unwrap()["version"], "0.22.0", "a preview build on the stable channel still gets the stable release");
        // a preview whose APK is still being attached is skipped in favour of the next one down that is complete
        let list = json!([rel("0.22.0-preview.3", true, false), rel("0.22.0-preview.2", true, true)]);
        assert_eq!(pick_update(&list, "0.21.0", "preview").unwrap()["version"], "0.22.0-preview.2");
    }

    #[test]
    fn the_update_channel_is_a_device_setting_that_stays_out_of_sync_and_backups() {
        let c = Arc::new(temp_core("channel"));
        assert_eq!(c.data.lock().unwrap().channel, "stable", "stable by default (and for old data files)");
        assert!(c.set_channel("beta").is_err());
        let v = dispatch(&c, "set_channel", json!({ "channel": "preview" }), false).unwrap();
        assert_eq!(v["channel"], "preview");
        assert!(dispatch(&c, "set_channel", json!({ "channel": "preview" }), true).is_err(), "not available over the network");
        // never part of what two devices exchange
        let (pc, phone) = pair();
        dispatch(&pc, "set_channel", json!({ "channel": "preview" }), false).unwrap();
        exchange(&pc, &phone);
        assert_eq!(phone.data.lock().unwrap().channel, "stable");
        // a restored backup keeps this device's own choice
        let backup = pc.data.lock().unwrap().channel.clone();
        let text = c.export_backup().replace("\"channel\": \"preview\"", "\"channel\": \"stable\"");
        assert_eq!(backup, "preview");
        c.import_backup(&text, None).unwrap();
        assert_eq!(c.data.lock().unwrap().channel, "preview");
        let old: Data = serde_json::from_str(r#"{"next_id":0,"assets":[],"snapshots":[]}"#).unwrap();
        assert_eq!(old.channel, "stable");
    }

    #[test]
    fn only_this_projects_release_apks_can_be_opened_from_the_update_notice() {
        let good = "https://github.com/hankyleisplay/moneypi/releases/download/v0.21.1/MoneyPi_0.21.1_android.apk";
        assert_eq!(external_url(good), Ok(good));
        let pre = "https://github.com/hankyleisplay/moneypi/releases/download/v0.22.0-preview.1/MoneyPi_0.22.0-preview.1_android.apk";
        assert_eq!(external_url(pre), Ok(pre), "preview builds are release APKs too");
        assert_eq!(external_url("update"), Ok("https://github.com/hankyleisplay/moneypi/releases/latest"));
        for bad in [
            "https://github.com/other/moneypi/releases/download/v0.21.1/a.apk",
            "https://github.com/hankyleisplay/moneypi/releases/download/v0.21.1/a.exe",
            "https://github.com/hankyleisplay/moneypi/releases/download/v0.21.1/a.apk?x=1",
            "https://github.com/hankyleisplay/moneypi/releases/download/v0.21.1/../../../x.apk",
            "https://github.com.evil.example/hankyleisplay/moneypi/releases/download/v1/a.apk",
            "http://github.com/hankyleisplay/moneypi/releases/download/v0.21.1/a.apk",
        ] {
            assert!(external_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_delete_on_one_side_is_not_undone_when_only_that_side_changed() {
        let (pc, phone) = pair();
        save(&pc, stock_json("台積電"));
        exchange(&pc, &phone);
        let id = pc.data.lock().unwrap().assets[0].id;
        buy(&pc, id, "2026-11-01", 1.0, 100.0);
        buy(&pc, id, "2026-11-02", 1.0, 100.0);
        exchange(&pc, &phone);
        bind_for_merge(&pc, &phone);
        dispatch(&phone, "delete_tx", json!({ "id": id, "index": 0 }), false).unwrap(); // only the phone changed the asset
        for _ in 0..2 {
            exchange(&pc, &phone);
        }
        assert_eq!(tx_count(&pc, id), (1, 1.0));
        assert_eq!(tx_count(&phone, id), (1, 1.0));
    }

    #[test]
    fn without_a_known_last_sync_the_later_edit_still_wins() {
        let (pc, phone) = pair();
        save(&pc, stock_json("台積電"));
        exchange(&pc, &phone);
        let id = pc.data.lock().unwrap().assets[0].id; // no peer recorded => base 0
        buy(&pc, id, "2026-11-10", 1.0, 100.0);
        pause();
        buy(&phone, id, "2026-11-11", 2.0, 110.0);
        exchange(&pc, &phone);
        assert_eq!(tx_count(&pc, id), tx_count(&phone, id));
        assert_eq!(tx_count(&pc, id).0, 1, "plain last-writer-wins: the phone's later edit replaced the whole asset");
    }


    #[test]
    fn rate_quote_checks_the_code_before_it_goes_to_the_network() {
        for bad in ["", "U", "usd1", "USDXYZ", "US D", "../../x", "€"] {
            assert!(rate_quote(bad, "TWD").is_err(), "{bad:?}");
        }
        assert_eq!(rate_quote(" twd ", "TWD").unwrap()["rate"], 1.0);
        assert_eq!(rate_quote("twd", "TWD").unwrap()["code"], "TWD");
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
    fn tunnel_url_extraction() {
        let line = "2026-10-25T10:00:00Z INF |  https://wise-owl-demo-1234.trycloudflare.com                            |";
        assert_eq!(extract_tunnel_url(line).as_deref(), Some("https://wise-owl-demo-1234.trycloudflare.com"));
        assert_eq!(extract_tunnel_url("INF Requesting new quick Tunnel on trycloudflare.com..."), None);
        assert_eq!(extract_tunnel_url("ERR failed https://api.trycloudflare.com/tunnel"), None);
        assert_eq!(extract_tunnel_url("see https://example.com/docs"), None);
    }

    #[test]
    fn secrets_compare_strictly() {
        assert!(check_secret("abc123", "abc123"));
        assert!(!check_secret("abc123", "abc124") && !check_secret("abc123", "abc12") && !check_secret("", ""));
        assert_eq!(random_hex(16).len(), 32);
        assert_ne!(random_hex(16), random_hex(16));
    }

    fn test_core() -> Core {
        Core {
            path: PathBuf::new(),
            data: Mutex::new(Data::default()),
            server: Mutex::new(None),
            tunnel: Mutex::new(None),
            auth_fail: Mutex::new((0, None)),
            progress: Mutex::new(Progress::default()),
            plan_lock: Mutex::new(()),
            enc: Mutex::new(EncState::default()),
            rev: Default::default(),
            peer_status: Default::default(),
            last_sweep: Default::default(),
        }
    }

    #[test]
    fn trades_can_be_paid_from_a_cash_asset_and_undone() {
        let c = test_core();
        let c = Core { path: std::env::temp_dir().join(format!("moneypi-test-{}.json", random_hex(4))), ..c };
        {
            let mut d = c.data.lock().unwrap();
            d.rates.insert("USD".into(), 32.0);
            d.assets = vec![
                Asset { id: 1, name: "銀行".into(), category: "銀行存款".into(), currency: "TWD".into(), value: 10_000.0, ..Default::default() },
                Asset { id: 2, name: "股".into(), category: "股票".into(), currency: "TWD".into(), holding: true, ..Default::default() },
                Asset { id: 3, name: "美股".into(), category: "股票".into(), currency: "USD".into(), holding: true, ..Default::default() },
            ];
        }
        let cash_of = |c: &Core| c.data.lock().unwrap().assets[0].value;
        let mut t = tx("2026-01-01", "buy", 10.0, 500.0, 20.0);
        t.cash = 1;
        c.add_tx(2, t).unwrap();
        assert_eq!(cash_of(&c), 4_980.0); // 10000 - (5000 + 20)
        // not enough money left: rejected, nothing changes
        let mut big = tx("2026-01-02", "buy", 100.0, 500.0, 0.0);
        big.cash = 1;
        assert!(c.add_tx(2, big).is_err());
        assert_eq!((cash_of(&c), c.data.lock().unwrap().assets[1].txs.len()), (4_980.0, 1));
        // spending outside the app leaves the deposit alone
        c.add_tx(2, tx("2026-01-03", "buy", 1.0, 500.0, 0.0)).unwrap();
        assert_eq!(cash_of(&c), 4_980.0);
        // a USD trade is converted into the deposit's currency
        let mut u = tx("2026-01-04", "buy", 2.0, 10.0, 0.0);
        u.cash = 1;
        c.add_tx(3, u).unwrap();
        assert_eq!(cash_of(&c), 4_340.0); // 20 USD * 32
        // selling pays back, a forged cash_delta is ignored
        let mut s = tx("2026-02-01", "sell", 5.0, 600.0, 10.0);
        s.cash = 1;
        s.cash_delta = 1e9;
        c.add_tx(2, s).unwrap();
        assert_eq!(cash_of(&c), 7_330.0); // + 3000 - 10
        // deleting the sale takes the money back; deleting the first buy returns it
        c.delete_tx(2, 2).unwrap();
        assert_eq!(cash_of(&c), 4_340.0);
        c.delete_tx(2, 0).unwrap();
        assert_eq!(cash_of(&c), 9_360.0);
        // a non-cash asset cannot be the source
        let mut bad = tx("2026-03-01", "buy", 1.0, 1.0, 0.0);
        bad.cash = 3;
        assert!(c.add_tx(2, bad).is_err());
        let _ = fs::remove_file(&c.path);
    }

    #[test]
    fn plan_schedule_and_units() {
        let day = |y, m, d| chrono::NaiveDate::from_ymd_opt(y, m, d).unwrap();
        let p = Plan { day: 31, start: "2026-01-15".into(), amount: 3000.0, ..Default::default() };
        let due = due_dates(&p, day(2026, 4, 15));
        assert_eq!(due, vec![day(2026, 1, 31), day(2026, 2, 28), day(2026, 3, 31)]);
        let done = Plan { last: "2026-02-28".into(), ..p.clone() };
        assert_eq!(due_dates(&done, day(2026, 4, 15)), vec![day(2026, 3, 31)]);
        let ended = Plan { end: "2026-02-10".into(), ..p };
        assert_eq!(due_dates(&ended, day(2026, 4, 15)), vec![day(2026, 1, 31)]);
        // fee comes out of the amount; whole units round down
        assert_eq!(plan_units(3000.0, 20.0, 100.0, true), 29.0);
        assert_eq!(plan_units(3000.0, 0.0, 7.0, false), 428.5714);
        assert_eq!(plan_units(50.0, 1.0, 2400.0, true), 0.0);
    }

    #[test]
    fn recurring_plan_books_buys_from_the_deposit() {
        let c = test_core();
        let c = Core { path: std::env::temp_dir().join(format!("moneypi-test-{}.json", random_hex(4))), ..c };
        let today_d = chrono::Local::now().date_naive();
        let start = (today_d - chrono::Duration::days(75)).format("%Y-%m-%d").to_string();
        {
            let mut d = c.data.lock().unwrap();
            d.assets = vec![
                Asset { id: 1, name: "銀行".into(), category: "銀行存款".into(), currency: "TWD".into(), value: 100_000.0, ..Default::default() },
                Asset { id: 2, name: "基金".into(), category: "基金/ETF".into(), currency: "TWD".into(), holding: true, price: 10.0, ..Default::default() },
            ];
        }
        c.save_plan(Plan { asset: 2, amount: 3000.0, day: 5, start: start.clone(), cash: 1, ..Default::default() }).unwrap();
        let expected = due_dates(&c.data.lock().unwrap().plans[0], today_d).len();
        assert!(expected >= 2);
        let r = c.run_plans().unwrap();
        assert_eq!(r["added"].as_u64().unwrap() as usize, expected);
        {
            let d = c.data.lock().unwrap();
            assert_eq!(d.assets[1].quantity, 300.0 * expected as f64);
            assert_eq!(d.assets[0].value, 100_000.0 - 3000.0 * expected as f64);
            assert!(d.plans[0].status.is_empty());
        }
        // running again books nothing new
        assert_eq!(c.run_plans().unwrap()["added"], 0);
        // not enough deposit: the plan stops and says why
        c.data.lock().unwrap().assets[0].value = 10.0;
        let tomorrow_plan = Plan { asset: 2, amount: 3000.0, day: 1, start, cash: 1, ..Default::default() };
        c.save_plan(tomorrow_plan).unwrap();
        c.run_plans().unwrap();
        assert!(!c.data.lock().unwrap().plans[1].status.is_empty());
        assert!(c.save_plan(Plan { asset: 2, amount: 100.0, fee: 100.0, day: 5, start: "2026-01-01".into(), ..Default::default() }).is_err());
        let _ = fs::remove_file(&c.path);
    }

    fn temp_core(tag: &str) -> Core {
        let c = test_core();
        Core { path: std::env::temp_dir().join(format!("moneypi-{tag}-{}.json", random_hex(4))), ..c }
    }

    #[test]
    fn encryption_roundtrip_and_tamper_detection() {
        let salt = [7u8; 16];
        let key = kdf("secret1", &salt).unwrap();
        let env = seal(&key, &salt, b"{\"hello\":1}").unwrap();
        assert!(!env.contains("hello"));
        assert_eq!(open_envelope(&env, "secret1").unwrap().0, b"{\"hello\":1}");
        assert_eq!(open_envelope(&env, "wrong!").unwrap_err(), "密碼錯誤");
        let mut v: Value = serde_json::from_str(&env).unwrap();
        let ct = v["ct"].as_str().unwrap().to_string();
        v["ct"] = Value::String(format!("{}{}", if ct.starts_with('0') { "1" } else { "0" }, &ct[1..]));
        assert!(open_envelope(&v.to_string(), "secret1").is_err());
        assert!(is_envelope(&env) && !is_envelope("{\"assets\":[]}"));
    }

    #[test]
    fn password_locks_the_app_and_the_file_is_unreadable_without_it() {
        let c = temp_core("pw");
        let core = Arc::new(c);
        core.data.lock().unwrap().assets.push(Asset { id: 1, name: "我的秘密存款".into(), currency: "TWD".into(), value: 123.0, ..Default::default() });
        {
            let mut d = core.data.lock().unwrap();
            core.persist(&mut d).unwrap();
        }
        assert!(core.set_password("", "abc").is_err()); // too short
        core.set_password("", "secret1").unwrap();
        let on_disk = fs::read_to_string(&core.path).unwrap();
        assert!(is_envelope(&on_disk) && !on_disk.contains("我的秘密存款"));
        // changing needs the current password
        assert!(core.set_password("nope", "another1").is_err());
        core.lock().unwrap();
        assert!(core.is_locked());
        assert!(dispatch(&core, "get_data", Value::Null, false).is_err());
        assert!(dispatch(&core, "save_asset", Value::Null, false).is_err());
        assert!(core.persist(&mut core.data.lock().unwrap()).is_err()); // must not overwrite with the empty placeholder
        assert!(core.unlock("bad-pass").is_err());
        assert!(core.is_locked());
        // a fresh start sees an encrypted file and stays locked
        let (d0, e0) = load_state(&core.path);
        assert!(e0.encrypted && e0.key.is_none() && d0.assets.is_empty());
        core.unlock("secret1").unwrap();
        assert_eq!(dispatch(&core, "get_data", Value::Null, false).unwrap()["assets"][0]["name"], "我的秘密存款");
        // remote clients can never unlock or change the password
        assert!(dispatch(&core, "set_password", json!({"old":"secret1","new":""}), true).is_err());
        // turning it off writes plain JSON again
        core.set_password("secret1", "").unwrap();
        assert!(!is_envelope(&fs::read_to_string(&core.path).unwrap()));
        let _ = fs::remove_file(&core.path);
    }

    #[test]
    fn encrypted_backup_can_be_restored_with_its_password() {
        let c = temp_core("rb");
        c.data.lock().unwrap().assets.push(Asset { id: 1, name: "存款".into(), currency: "TWD".into(), value: 50.0, ..Default::default() });
        c.set_password("", "secret1").unwrap();
        let env = fs::read_to_string(&c.path).unwrap();
        assert_eq!(c.import_backup(&env, None).unwrap_err(), "ENCRYPTED");
        assert!(c.import_backup(&env, Some("wrong!")).is_err());
        assert!(c.import_backup(&env, Some("secret1")).is_ok());
        let _ = fs::remove_file(&c.path);
    }

    #[test]
    fn daily_backup_keeps_only_the_newest_copies() {
        let c = temp_core("bk");
        let dir = std::env::temp_dir().join(format!("moneypi-bk-dir-{}", random_hex(4)));
        fs::create_dir_all(&dir).unwrap();
        for d in ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"] {
            fs::write(dir.join(format!("moneypi-{d}.json")), "{}").unwrap();
        }
        fs::write(dir.join("notes.txt"), "keep me").unwrap();
        assert!(c.set_backup(true, "relative\\path", 3).is_err());
        assert!(c.set_backup(true, &dir.display().to_string(), 2).is_err()); // keep < 3
        c.set_backup(true, &dir.display().to_string(), 3).unwrap();
        let files = backup_files(&dir);
        assert_eq!(files.len(), 3);
        assert!(files.contains(&format!("moneypi-{}.json", today())) && !files.contains(&"moneypi-2026-01-01.json".to_string()));
        assert!(dir.join("notes.txt").exists());
        assert_eq!(c.auto_backup(false).unwrap(), None); // already done today
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&c.path);
    }

    #[test]
    fn dividends_use_the_units_held_before_the_ex_date() {
        let txs = vec![
            tx("2026-01-10", "buy", 100.0, 10.0, 0.0),
            tx("2026-03-01", "buy", 50.0, 10.0, 0.0),
            tx("2026-04-10", "sell", 30.0, 10.0, 0.0),
        ];
        let ev = vec![("2026-01-05".to_string(), 0.5), ("2026-03-01".to_string(), 0.5), ("2026-06-01".to_string(), 0.5)];
        let got = dividend_candidates(&txs, &ev, &[]);
        assert_eq!(got[0].1, 0.0); // before the first buy
        assert_eq!(got[1].1, 100.0); // bought on the ex-date: not entitled
        assert_eq!(got[2].1, 120.0);
        let again = dividend_candidates(&txs, &ev, &["2026-01-05".to_string(), "2026-03-01".to_string()]);
        assert_eq!(again.len(), 1);
    }

    #[test]
    fn tunnel_requests_need_the_tunnel_secret_not_the_pin() {
        let c = test_core();
        // via tunnel: PIN is useless, only the per-tunnel token works
        assert!(matches!(c.authorize("123456", Some("tok"), true, "123456"), Auth::Denied));
        assert!(matches!(c.authorize("123456", Some("tok"), true, "tok"), Auth::Ok));
        assert!(matches!(c.authorize("123456", None, true, "tok"), Auth::Denied)); // no tunnel running
        // LAN: PIN works, token does not
        assert!(matches!(c.authorize("123456", Some("tok"), false, "123456"), Auth::Ok));
        assert!(matches!(c.authorize("123456", Some("tok"), false, "tok"), Auth::Denied));
        assert!(matches!(c.authorize("", None, false, ""), Auth::Denied)); // sync off => empty PIN never matches
    }

    #[test]
    fn lan_pin_guessing_is_locked_out() {
        let c = test_core();
        for _ in 0..10 {
            assert!(matches!(c.authorize("123456", None, false, "000000"), Auth::Denied));
        }
        assert!(matches!(c.authorize("123456", None, false, "123456"), Auth::Locked)); // even the right PIN waits
    }

    #[test]
    #[ignore = "downloads ~55 MB from GitHub; run with --ignored"]
    fn downloads_and_verifies_real_cloudflared() {
        let dir = std::env::temp_dir().join("moneypi-cloudflared-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("cloudflared.exe");
        let seen = Mutex::new(Vec::<(String, u64, u64)>::new());
        download_cloudflared(&dest, &|st, d, t| seen.lock().unwrap().push((st.to_string(), d, t))).unwrap();
        let seen = seen.into_inner().unwrap();
        let dl: Vec<_> = seen.iter().filter(|x| x.0 == "下載中").collect();
        assert!(dl.len() > 5, "progress should be reported repeatedly");
        assert!(dl.windows(2).all(|w| w[0].1 <= w[1].1));
        let last = dl.last().unwrap();
        assert!(last.2 > 1_000_000 && last.1 == last.2, "download ends at 100%: {last:?}");
        assert!(seen.iter().any(|x| x.0.starts_with("驗證")) && seen.last().unwrap().0.starts_with("安裝"));
        let out = Command::new(&dest).arg("--version").output().unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).contains("cloudflared version"));
        assert!(!dest.with_extension("exe.part").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn symbol_encoding() {
        assert_eq!(percent_encode("^GSPC"), "%5EGSPC");
        assert_eq!(percent_encode("BTC-USD"), "BTC-USD");
    }
}
