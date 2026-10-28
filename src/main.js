const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 });
const fmt0 = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
const fmtQ = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 6 });
const COLORS = ["#6aa5ff", "#3ecf8e", "#f5b83d", "#b57cf5", "#f472b6", "#2dc4b2", "#fb7185", "#94a3b8"];
const CATS = ["現金", "銀行存款", "股票", "基金/ETF", "加密貨幣", "不動產", "保險", "其他"];
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const num = (v) => parseFloat(v) || 0;
const todayStr = () => new Date().toLocaleDateString("sv-SE");

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

/* ---------- backend access: Tauri IPC on the desktop, HTTP+PIN from a LAN browser ---------- */
const inTauri = !!(window.__TAURI__ && window.__TAURI__.core);
let token = store.get("token", "");
if (!inTauri && location.hash.startsWith("#pin=")) {
  token = decodeURIComponent(location.hash.slice(5));
  store.set("token", token);
  history.replaceState(null, "", location.pathname);
}

async function invoke(cmd, args = {}) {
  if (inTauri) return window.__TAURI__.core.invoke("call", { cmd, args });
  for (;;) {
    let r;
    try {
      r = await fetch("/api/" + cmd, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Token": token },
        body: JSON.stringify(args),
      });
    } catch {
      throw "無法連線到電腦，請確認在同一個 Wi-Fi 且電腦上的 MoneyPi 正在執行";
    }
    if (r.status === 401) {
      token = await askPin(token ? (viaTunnel ? "連線密鑰錯誤或已失效。每次重新開啟遠端連線都會換新密鑰，請回電腦重新掃描 QR Code。" : "PIN 錯誤，請重新輸入") : "");
      store.set("token", token);
      continue;
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw j.error || "錯誤 " + r.status;
    return j;
  }
}

const viaTunnel = location.hostname.endsWith(".trycloudflare.com");
// accepts a bare PIN/secret or a whole pasted sign-in link
const extractToken = (s) => { const m = s.match(/(?:\/t\/|#pin=)([0-9a-f]{32})/i); return (m ? m[1] : s).trim(); };

function askPin(msg) {
  const d = $("pdlg");
  $("pform").querySelector("h3").textContent = viaTunnel ? "輸入連線密鑰" : "輸入同步 PIN";
  $("perr").textContent = msg || (viaTunnel
    ? "這是遠端連線，需要連線密鑰（不是區域網路 PIN）。請在電腦的「手機連線 → 遠端」掃描 QR Code，或按「複製連結」傳到手機開啟；也可以把整條連結貼在這裡。"
    : "請輸入電腦上 MoneyPi「手機連線」裡顯示的 PIN。");
  $("pform").pin.value = "";
  $("pform").pin.placeholder = viaTunnel ? "貼上連結或密鑰" : "PIN";
  d.oncancel = (e) => e.preventDefault();
  return new Promise((res) => {
    d.addEventListener("close", () => res(extractToken($("pform").pin.value)), { once: true });
    if (!d.open) d.showModal();
  });
}

let data = { assets: [], snapshots: [], rates: { TWD: 1 }, goals: [], refresh_min: 0, cashflow: [] };
const ui = {
  kind: "all", cat: "", q: "", sort: "value", range: 0, fcRange: "1y", rm: new Date().toLocaleDateString("sv-SE").slice(0, 7), sel: null, hover: -1, fm: new Date().toLocaleDateString("sv-SE").slice(0, 7),
  hidden: store.get("hidden", "0") === "1",
};

const rate = (cur) => data.rates[cur] ?? 1;
const toBase = (a) => a.value * rate(a.currency);
const money = (n) => (ui.hidden ? "NT$ ••••" : "NT$ " + fmt0.format(n));
const sum = (xs) => xs.reduce((s, a) => s + toBase(a), 0);
const mask = () => (ui.hidden ? "blur" : "");
const signed = (n, f = fmt0) => (n >= 0 ? "+" : "−") + f.format(Math.abs(n));

function catColor(c) {
  let i = CATS.indexOf(c);
  if (i < 0) i = [...c].reduce((h, ch) => h + ch.codePointAt(0), 0);
  return COLORS[i % COLORS.length];
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  // popover => top layer, so the toast stays visible above open modal dialogs
  try { t.hidePopover(); } catch {}
  try { t.showPopover(); } catch {}
  clearTimeout(toast.id);
  toast.id = setTimeout(() => { try { t.hidePopover(); } catch {} }, 3400);
}

// jelly squish on every press
document.addEventListener("pointerdown", (e) => {
  const el = e.target.closest("button:not(.link):not(:disabled), .card, .stat");
  if (!el) return;
  el.classList.remove("jelly");
  void el.offsetWidth;
  el.classList.add("jelly");
});
document.addEventListener("animationend", (e) => e.target.classList.remove("jelly"));

/* ---------- custom dropdown (replaces native <select>) ---------- */
class Dropdown {
  constructor(root, onChange) {
    this.root = root;
    this.onChange = onChange;
    this.opts = [];
    this.value = "";
    this.act = -1;
    root.innerHTML = `<button type="button" class="dd-btn" aria-haspopup="listbox"><span></span>
      <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <ul class="dd-menu" role="listbox" hidden></ul>`;
    this.btn = root.firstElementChild;
    this.menu = root.lastElementChild;
    this.btn.onclick = () => (this.isOpen ? this.close() : this.open());
    this.btn.onkeydown = (e) => this.key(e);
    this.menu.onmousedown = (e) => e.preventDefault();
    this.menu.onclick = (e) => {
      const li = e.target.closest("li");
      if (li) this.pick(li.dataset.v);
    };
    document.addEventListener("mousedown", (e) => { if (!root.contains(e.target)) this.close(); });
  }
  get isOpen() { return !this.menu.hidden; }
  setOptions(opts, value) {
    this.opts = opts.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
    this.menu.innerHTML = this.opts
      .map((o) => `<li role="option" data-v="${esc(o.value)}">${esc(o.label)}</li>`).join("");
    this.setValue(this.opts.some((o) => o.value === value) ? value : this.opts[0]?.value ?? "");
  }
  setValue(v) {
    this.value = v;
    const o = this.opts.find((x) => x.value === v);
    this.btn.firstElementChild.textContent = o ? o.label : "";
    [...this.menu.children].forEach((li) => li.setAttribute("aria-selected", li.dataset.v === v));
  }
  pick(v) {
    const changed = v !== this.value;
    this.setValue(v);
    this.close();
    this.btn.focus();
    if (changed && this.onChange) this.onChange(v);
  }
  open() {
    this.menu.hidden = false;
    this.root.classList.add("open");
    const r = this.btn.getBoundingClientRect();
    this.root.classList.toggle("up", r.bottom + 240 > innerHeight && r.top > 240);
    this.act = Math.max(0, this.opts.findIndex((o) => o.value === this.value));
    this.hilite();
  }
  close() {
    this.menu.hidden = true;
    this.root.classList.remove("open", "up");
  }
  hilite() {
    [...this.menu.children].forEach((li, i) => li.classList.toggle("act", i === this.act));
    this.menu.children[this.act]?.scrollIntoView({ block: "nearest" });
  }
  key(e) {
    const n = this.opts.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!this.isOpen) return this.open();
      this.act = (this.act + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      this.hilite();
    } else if ((e.key === "Enter" || e.key === " ") && this.isOpen) {
      e.preventDefault();
      this.pick(this.opts[this.act].value);
    } else if (e.key === "Escape" && this.isOpen) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }
}

const ddCat = new Dropdown($("cat"), (v) => { ui.cat = v; renderList(); });
const ddSort = new Dropdown($("sort"), (v) => { ui.sort = v; renderList(); });
ddSort.setOptions([
  { value: "value", label: "金額高→低" }, { value: "name", label: "名稱" }, { value: "updated", label: "最近更新" },
], "value");
const fCat = new Dropdown($("f-cat"));
const fCur = new Dropdown($("f-cur"));
const fMkt = new Dropdown($("f-mkt"), () => { updateHoldHint(); syncDivUI(); });
const fDivCash = new Dropdown($("f-divcash"));
function syncDivUI() { $("div-fields").hidden = !(form.holding.checked && fMkt.value); }
const tKind = new Dropdown($("t-kind"), () => syncTxUI());
const tCash = new Dropdown($("t-cash"), () => syncTxUI());
fCat.setOptions(CATS, CATS[0]);
fMkt.setOptions([
  { value: "", label: "手動輸入價格" },
  { value: "tw", label: "台股（自動同步）" },
  { value: "other", label: "國際／加密（Yahoo 代號）" },
], "");
tKind.setOptions([{ value: "buy", label: "買入" }, { value: "sell", label: "賣出" }, { value: "div", label: "配息" }], "buy");

/* ---------- sidebar collapse / hide amounts ---------- */
const side = $("side");
function setCollapsed(c) {
  side.classList.toggle("collapsed", c);
  $("collapse-btn").title = $("collapse-btn").ariaLabel = c ? "展開清單" : "收合清單";
  store.set("collapsed", c ? "1" : "0");
}
side.style.transition = "none"; // no slide animation on first paint
setCollapsed(store.get("collapsed", innerWidth < 760 ? "1" : "0") === "1");
requestAnimationFrame(() => requestAnimationFrame(() => (side.style.transition = "")));
$("collapse-btn").onclick = () => setCollapsed(!side.classList.contains("collapsed"));
// phone: the expanded list floats over the page, so a tap anywhere else closes it
document.addEventListener("click", (e) => {
  if (innerWidth <= 640 && !side.classList.contains("collapsed") && !e.target.closest("#side, dialog")) setCollapsed(true);
});
$("hide-btn").onclick = () => {
  ui.hidden = !ui.hidden;
  store.set("hidden", ui.hidden ? "1" : "0");
  render();
};

/* ---------- goals ---------- */
const DAY = 864e5, MONTH_DAYS = 30.44;
const GOAL_ICONS = ["🎯", "💰", "🏎️", "🏠", "✈️", "🎓", "💍", "🏖️", "🚗", "📱"];
const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function fmtDuration(days) {
  if (days < 45) return `約 ${Math.max(1, Math.ceil(days))} 天`;
  const tm = Math.round(days / MONTH_DAYS), y = Math.floor(tm / 12), m = tm % 12;
  if (y > 100) return "超過 100 年";
  return "約 " + [y ? `${y} 年` : "", m ? `${m} 個月` : ""].filter(Boolean).join(" ");
}
const dateStr = (ms) => new Date(ms).toLocaleDateString("sv-SE");

/** Least-squares trend over the last 180 days of a goal's history → growth per day. */
function projection(history) {
  const pts = history.map((s) => ({ t: Date.parse(s.date + "T00:00:00Z") / DAY, v: s.value }));
  const lastT = pts.length ? pts[pts.length - 1].t : 0;
  const rec = pts.filter((p) => p.t >= lastT - 180);
  const span = rec.length ? rec[rec.length - 1].t - rec[0].t : 0;
  const out = { n: rec.length, span, slope: null, monthly: 0 };
  if (rec.length < 2 || span < 3) return out;
  const mt = rec.reduce((s, p) => s + p.t, 0) / rec.length, mv = rec.reduce((s, p) => s + p.v, 0) / rec.length;
  const sxx = rec.reduce((s, p) => s + (p.t - mt) ** 2, 0);
  out.slope = sxx ? rec.reduce((s, p) => s + (p.t - mt) * (p.v - mv), 0) / sxx : 0; // TWD per day
  out.monthly = out.slope * MONTH_DAYS;
  return out;
}

function goalVal(g) {
  return data.assets
    .filter((a) => !g.assets.length || g.assets.includes(a.id))
    .reduce((s, a) => s + (a.liability ? -1 : 1) * toBase(a), 0);
}

function goalInfo(g) {
  const cur = goalVal(g), left = g.amount - cur, p = projection(g.history);
  const info = { cur, left, p, pct: Math.max(0, (cur / g.amount) * 100), done: left <= 0, eta: "", etaSub: "" };
  if (info.done) info.eta = "🎉 已達成";
  else if (p.slope === null) { info.eta = "資料不足"; info.etaSub = "需累積至少 3 天、2 筆以上的記錄"; }
  else if (p.slope <= 0) { info.eta = "目前無法預估"; info.etaSub = "近期沒有成長"; }
  else {
    const days = left / p.slope;
    info.eta = days / 365 > 100 ? "超過 100 年" : dateStr(Date.now() + days * DAY);
    info.etaSub = fmtDuration(days);
  }
  if (g.date && !info.done) {
    const ml = (Date.parse(g.date + "T00:00:00") - Date.now()) / DAY / MONTH_DAYS;
    if (ml <= 0) info.late = true;
    else {
      info.leftText = fmtDuration(ml * MONTH_DAYS).replace("約 ", "");
      info.need = left / ml;
      if (p.slope !== null) info.ahead = p.monthly >= info.need;
    }
  }
  return info;
}

function renderGoalHero() {
  const gs = data.goals;
  if (!gs.length) {
    $("goal-label").textContent = "目標進度";
    $("goal-pct").textContent = "—";
    $("goal-bar").style.width = "0";
    $("goal-text").textContent = "按下方「新增目標」開始";
    return;
  }
  const infos = gs.map((g) => ({ g, i: goalInfo(g) }));
  const open = infos.filter((x) => !x.i.done);
  const pick = [...(open.length ? open : infos)].sort((a, b) => b.i.pct - a.i.pct)[0];
  $("goal-label").textContent = `目標 · ${pick.g.icon} ${pick.g.name}`;
  $("goal-pct").textContent = pick.i.pct.toFixed(1) + "%";
  $("goal-bar").style.width = Math.min(100, pick.i.pct) + "%";
  const done = infos.filter((x) => x.i.done).length;
  $("goal-text").textContent = `${done}/${gs.length} 個已達成` + (!pick.i.done && !ui.hidden ? ` · 還差 ${fmt0.format(pick.i.left)}` : "");
}

function renderGoals() {
  const el = $("goal-panel"), m = mask();
  const head = `<div class="panel-head"><h3>目標</h3><button class="primary" data-gadd>＋ 新增目標</button></div>`;
  if (!data.goals.length) {
    el.innerHTML = head + '<p class="muted">還沒有目標。新增幾個，例如「財富自由」「買跑車」「出國旅行」，會依你的資產成長速度，自動估算還要多久達成。</p>';
    return;
  }
  el.innerHTML = head + `<div class="goals">${data.goals.map((g) => {
    const i = goalInfo(g);
    const basis = g.assets.length
      ? "指定 " + g.assets.map((id) => data.assets.find((a) => a.id === id)?.name).filter(Boolean).join("、")
      : "全部淨資產";
    const dl = g.date
      ? `<div class="gline"><span>目標日</span><b>${esc(g.date)}</b>${
          i.done ? "" : i.late ? '<small class="neg">已逾期</small>'
          : `<small>剩 ${esc(i.leftText)}${ui.hidden ? "" : ` · 需每月 ${fmt0.format(i.need)}`}${i.ahead === undefined ? "" : i.ahead ? ' · <span class="pos">超前</span>' : ' · <span class="neg">落後</span>'}</small>`}</div>`
      : "";
    return `<div class="gcard ${i.done ? "done" : ""}" data-gid="${g.id}">
      <div class="ghead"><span class="gicon">${esc(g.icon)}</span>
        <div class="gname"><b>${esc(g.name)}</b><small title="${esc(basis)}">${esc(basis)}</small></div>
        <div class="gbtns"><button class="link" data-gedit>編輯</button><button class="link danger" data-gdel>刪除</button></div></div>
      <div class="gamt"><b class="${m}">${money(i.cur)}</b><span class="muted ${m}"> / ${money(g.amount)}</span><span class="gpct">${i.pct.toFixed(1)}%</span></div>
      <div class="progress"><div data-w="${Math.min(100, i.pct)}%"></div></div>
      <div class="gline"><span>預計達成</span><b>${esc(i.eta)}</b>${i.etaSub ? `<small>${esc(i.etaSub)}</small>` : ""}</div>
      ${dl}
    </div>`;
  }).join("")}</div>
  <p class="note">預估依各目標近 180 天的進度記錄做線性趨勢（含股價漲跌），僅供參考。</p>`;
  // let the bars animate from 0
  requestAnimationFrame(() => requestAnimationFrame(() => el.querySelectorAll(".progress div[data-w]").forEach((d) => (d.style.width = d.dataset.w))));
}

const gdlg = $("gdlg"), gform = $("gform"), gIcon = new Dropdown($("g-icon"));
gIcon.setOptions(GOAL_ICONS.map((e) => ({ value: e, label: e })), "🎯");
let editingGoal = 0, gBasis = "net";
const gPicked = new Set();

function renderGoalAssets() {
  $("g-assets").innerHTML = data.assets.length
    ? data.assets.map((a) => `<label class="chk sm"><input type="checkbox" data-aid="${a.id}" ${gPicked.has(a.id) ? "checked" : ""}><span class="box">${CHECK_SVG}</span>
        <span>${esc(a.name)} <small class="muted">${a.liability ? "負債 · " : ""}${esc(a.category)}</small></span></label>`).join("")
    : '<p class="muted">還沒有任何項目，請先新增資產。</p>';
}
function setGoalBasis(b) {
  gBasis = b;
  [...$("g-basis").children].forEach((x) => x.classList.toggle("on", x.dataset.b === b));
  $("g-assets").hidden = b !== "pick";
  $("g-hint").textContent = b === "pick"
    ? "只計入勾選的項目（負債會扣除），例如把「跑車基金」專用帳戶設為這個目標的基準。"
    : "以全部資產扣掉負債後的淨資產計算進度。";
  if (b === "pick") renderGoalAssets();
}
$("g-basis").onclick = (e) => { const b = e.target.closest("button"); if (b) setGoalBasis(b.dataset.b); };
$("g-assets").onchange = (e) => {
  const id = Number(e.target.dataset.aid);
  e.target.checked ? gPicked.add(id) : gPicked.delete(id);
};

function openGoal(g) {
  editingGoal = g ? g.id : 0;
  $("gdlg-title").textContent = g ? "編輯目標" : "新增目標";
  gform.reset();
  $("gerr").textContent = "";
  gIcon.setValue(g ? g.icon : "🎯");
  gPicked.clear();
  if (g) {
    gform.name.value = g.name;
    gform.amount.value = g.amount;
    gform.date.value = g.date;
    g.assets.forEach((id) => gPicked.add(id));
  }
  setGoalBasis(g && g.assets.length ? "pick" : "net");
  gdlg.showModal();
  gform.name.focus();
}

gform.onsubmit = async (e) => {
  e.preventDefault();
  if (gBasis === "pick" && !gPicked.size) return ($("gerr").textContent = "請至少勾選一個項目，或改用「全部淨資產」");
  try {
    data = await invoke("save_goal", {
      goal: {
        id: editingGoal, name: gform.name.value.trim(), icon: gIcon.value, amount: num(gform.amount.value),
        date: gform.date.value.trim(), assets: gBasis === "pick" ? [...gPicked] : [], history: [],
      },
    });
    gdlg.close();
    render();
    toast(editingGoal ? "目標已更新" : "目標已新增");
  } catch (err) {
    $("gerr").textContent = String(err);
  }
};

$("goal-panel").onclick = async (e) => {
  if (e.target.closest("[data-gadd]")) return openGoal(null);
  const card = e.target.closest("[data-gid]");
  if (!card) return;
  const g = data.goals.find((x) => x.id === Number(card.dataset.gid));
  if (!g) return;
  if (e.target.closest("[data-gedit]")) openGoal(g);
  else if (e.target.closest("[data-gdel]") && (await confirmBox(`刪除目標「${g.name}」？`, "只會刪除目標，不會動到你的資產"))) {
    try { data = await invoke("delete_goal", { id: g.id }); render(); toast("已刪除目標"); } catch (err) { toast(String(err)); }
  }
};

/* ---------- render ---------- */
function render() {
  if (typeof ui.sel === "number" && !data.assets.some((a) => a.id === ui.sel)) ui.sel = null;
  const A = data.assets.filter((a) => !a.liability);
  const L = data.assets.filter((a) => a.liability);
  const ta = sum(A), tl = sum(L), net = ta - tl;

  $("net").textContent = money(net);
  $("assets").textContent = money(ta);
  $("liab").textContent = money(tl);
  $("debt-ratio").textContent = ta > 0 ? `負債比 ${((tl / ta) * 100).toFixed(1)}%` : "";
  $("hide-btn").style.opacity = ui.hidden ? 0.5 : 1;

  const snaps = data.snapshots, d = $("net-delta");
  if (snaps.length > 1) {
    const prev = snaps[snaps.length - 2];
    const diff = net - (prev.assets - prev.liabilities);
    d.textContent = ui.hidden ? "" : `較 ${prev.date}：${signed(diff)}`;
    d.className = diff >= 0 ? "pos" : "neg";
  } else d.textContent = "";

  renderGoalHero();
  renderGoals();
  renderPortfolio();

  const cats = [...new Set(data.assets.map((a) => a.category))].sort();
  if (!cats.includes(ui.cat)) ui.cat = "";
  ddCat.setOptions([{ value: "", label: "所有類別" }, ...cats], ui.cat);

  renderList();
  renderView();
}

function visibleAssets() {
  const q = ui.q.trim().toLowerCase();
  const xs = data.assets.filter(
    (a) =>
      (ui.kind === "all" || (ui.kind === "liab") === a.liability) &&
      (!ui.cat || a.category === ui.cat) &&
      (!q || `${a.name} ${a.note} ${a.category} ${a.symbol}`.toLowerCase().includes(q))
  );
  const by = {
    value: (a, b) => toBase(b) - toBase(a),
    name: (a, b) => a.name.localeCompare(b.name, "zh-Hant"),
    updated: (a, b) => b.updated.localeCompare(a.updated) || b.id - a.id,
  };
  return xs.sort(by[ui.sort]);
}

function renderList() {
  const xs = visibleAssets();
  $("nav-overview").classList.toggle("on", ui.sel === null);
  $("nav-flow").classList.toggle("on", ui.sel === "flow");
  $("nav-report").classList.toggle("on", ui.sel === "report");
  $("empty").hidden = xs.length > 0;
  $("empty").textContent = data.assets.length ? "沒有符合條件的項目" : "尚無項目，按下方「新增項目」開始記錄";
  $("list").innerHTML = xs
    .map((a) => {
      const sub = [a.liability ? "負債" : "", a.holding && a.symbol ? a.symbol : a.category, a.currency === "TWD" ? "" : a.currency].filter(Boolean).join(" · ");
      return `<button class="item ${a.id === ui.sel ? "on" : ""}" data-id="${a.id}" title="${esc(a.name)}">
      <span class="av" style="background:${catColor(a.category)}">${esc([...a.name][0] || "?")}</span>
      <span class="meta"><b>${esc(a.name)}</b><small>${esc(sub)}</small></span>
      <span class="amt ${a.liability ? "neg" : ""} ${mask()}">${a.liability ? "−" : ""}${fmt0.format(toBase(a))}</span>
    </button>`;
    })
    .join("");
}

const KIND = { buy: "買入", sell: "賣出", div: "配息" };

/* ---------- ? tips ---------- */
const TIPS = {
  "淨資產": "總資產 − 總負債，也就是你真正擁有的錢。",
  "現值": "這檔標的現在值多少錢 = 持有數量 × 現價／淨值。會隨股價每天變動，總資產加的是現值，不是成本。",
  "持有數量": "目前持有的股數或單位數，由你記錄的買入、賣出自動算出。",
  "現價／淨值": "最新報價。有設定行情代號的，按上方「同步股價」會自動更新；沒設定的要自己改。",
  "平均成本": "每一股平均花了多少錢（含手續費）。多次買入用加權平均計算。",
  "總成本": "你實際投入、而且目前還持有的這些股數花的總金額（含手續費）。賣掉一部分，成本會按比例減少。",
  "未實現損益": "現值 − 總成本。還沒賣出，所以只是帳面上的賺賠；下面的百分比 = 損益 ÷ 總成本。",
  "已實現損益": "已經賣出的部分，實際賺賠了多少（賣出金額 − 手續費 − 對應的成本）。",
  "累計配息": "你記錄的配息總額。配息不改變持有數量，但會算進總報酬。",
  "總報酬": "未實現損益 + 已實現損益 + 累計配息；百分比是占總成本的比例。",
  "年化報酬率 (XIRR)": "依你每一筆買賣、配息的實際日期，換算成「一年」大約賺賠幾 %。交易跨度要滿 90 天才顯示，太短會被放大而失真。",
  "持倉": "股票、ETF、基金的持有狀況。現值 = 數量 × 現價；數量與成本由「記錄交易」自動計算。",
  "定期定額": "每月固定日期自動買入。每期會記成一筆買入交易，價格用扣款日當天（或之後第一個交易日）的收盤價；開始日期填過去會自動補上之前每一期。",
  "價格走勢與預測": "用過去價格畫一條趨勢線往後延伸一年，淡色帶是歷史波動範圍。這只是統計外推，不是預測保證，也不構成投資建議。",
  "資金來源": "買入的錢從哪裡來。選存款項目，MoneyPi 會從那個存款扣掉（賣出、配息則加回）；選外部資金就不動 App 內的存款。",
};
const tip = (k) => (TIPS[k] ? `<button type="button" class="qm" data-tip="${esc(k)}" aria-label="${esc(k)}說明">?</button>` : "");

document.addEventListener("click", (e) => {
  const el = $("tip");
  if (el.contains(e.target)) return;
  const q = e.target.closest(".qm[data-tip]");
  if (!q) { if (el.matches(":popover-open")) el.hidePopover(); return; }
  e.preventDefault();
  e.stopPropagation();
  if (el.matches(":popover-open")) el.hidePopover();
  el.textContent = TIPS[q.dataset.tip] || "";
  el.showPopover();
  const r = q.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
  const x = Math.min(Math.max(r.left + r.width / 2 - w / 2, 8), innerWidth - w - 8);
  const y = r.bottom + 8 + h < innerHeight - 8 ? r.bottom + 8 : Math.max(8, r.top - 8 - h);
  el.style.left = x + "px";
  el.style.top = y + "px";
}, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("tip").matches(":popover-open")) $("tip").hidePopover(); });

/* annualised money-weighted return from the real trade dates (null when it cannot be solved) */
function xirr(a) {
  const f = a.txs.map((t) => ({
    t: Date.parse(t.date + "T00:00:00Z"),
    v: t.kind === "buy" ? -(t.units * t.price + t.fee) : t.kind === "sell" ? t.units * t.price - t.fee : t.price,
  })).sort((x, y) => x.t - y.t);
  if (a.value > 0) f.push({ t: Date.now(), v: a.value });
  if (!f.some((x) => x.v < 0) || !f.some((x) => x.v > 0) || f.at(-1).t - f[0].t < 90 * DAY) return null;
  const npv = (r) => f.reduce((s, c) => s + c.v / Math.pow(1 + r, (c.t - f[0].t) / (365 * DAY)), 0);
  let lo = -0.99, hi = 20;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 120; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

/* ---- price history + trend extrapolation (log-linear regression) ---- */
const fcCache = new Map();
const FC_RANGES = [["1y", "1 年"], ["2y", "2 年"], ["5y", "5 年"]];
function fitTrend(pts) {
  const x = pts.map((p) => Date.parse(p[0] + "T00:00:00Z") / DAY), y = pts.map((p) => Math.log(p[1]));
  const n = x.length, mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  x.forEach((v, i) => { sxx += (v - mx) ** 2; sxy += (v - mx) * (y[i] - my); syy += (y[i] - my) ** 2; });
  const b = sxx ? sxy / sxx : 0, c = my - b * mx;
  const sse = y.reduce((s, v, i) => s + (v - (c + b * x[i])) ** 2, 0);
  return { b, c, sigma: Math.sqrt(sse / Math.max(1, n - 2)), r2: syy ? 1 - sse / syy : 0, x0: x[0], x1: x[n - 1] };
}

function forecastCard(a) {
  return `<div class="glass detail" id="fc-card">
    <div class="sect"><h3>價格走勢與預測${tip("價格走勢與預測")}</h3>
      <div class="seg" id="fc-seg">${FC_RANGES.map(([v, l]) => `<button type="button" data-r="${v}" class="${v === ui.fcRange ? "on" : ""}">${l}</button>`).join("")}</div></div>
    <canvas id="fc"></canvas>
    <div id="fc-sum" class="fc-sum"><p class="muted">載入歷史價格中…</p></div>
  </div>`;
}

async function loadForecast(a) {
  const key = a.id + ":" + ui.fcRange;
  let s = fcCache.get(key);
  try {
    if (!s || Date.now() - s.at > 3600e3) {
      s = { at: Date.now(), ...(await invoke("price_history", { id: a.id, range: ui.fcRange })) };
      fcCache.set(key, s);
    }
  } catch (err) {
    if ($("fc-sum") && ui.sel === a.id) { $("fc-sum").innerHTML = `<p class="muted">無法取得歷史價格：${esc(String(err))}</p>`; $("fc").style.display = "none"; }
    return;
  }
  if (ui.sel !== a.id || !$("fc")) return;
  $("fc").style.display = "";
  fcState = { a, s };
  drawForecast(a, s);
  fcRO ??= new ResizeObserver(() => { if (fcState && $("fc") && ui.sel === fcState.a.id) drawForecast(fcState.a, fcState.s); });
  fcRO.disconnect();
  fcRO.observe($("fc"));
}
let fcState = null, fcRO = null;

function drawForecast(a, s) {
  const pts = s.points, fit = fitTrend(pts), HOR = 365;
  const { g, W, H } = setupCanvas($("fc"));
  const padL = ui.hidden ? 12 : 58, padR = 12, padT = 12, padB = 24;
  const day = (d) => Date.parse(d + "T00:00:00Z") / DAY;
  const t0 = fit.x0, t1 = fit.x1 + HOR;
  const trend = (t) => Math.exp(fit.c + fit.b * t);
  const hi = (t) => trend(t) * Math.exp(fit.sigma), lo = (t) => trend(t) * Math.exp(-fit.sigma);
  const avg = a.quantity > 0 && a.cost > 0 ? a.cost / a.quantity : null;
  let min = Math.min(...pts.map((p) => p[1]), lo(t1)), max = Math.max(...pts.map((p) => p[1]), hi(t1));
  if (avg) { min = Math.min(min, avg); max = Math.max(max, avg); }
  const X = (t) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  g.font = "12px 'Segoe UI Variable', sans-serif";
  g.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const v = min + ((max - min) * i) / 3, yy = Y(v);
    g.strokeStyle = css("--line"); g.beginPath(); g.moveTo(padL, yy); g.lineTo(W - padR, yy); g.stroke();
    if (!ui.hidden) { g.fillStyle = css("--muted"); g.textAlign = "left"; g.fillText(fmt.format(v), 2, yy + 3); }
  }
  const accent = css("--accent"), nowX = X(fit.x1);
  // forecast band + trend line (future part)
  g.fillStyle = accent + "22";
  g.beginPath(); g.moveTo(nowX, Y(hi(fit.x1)));
  for (let t = fit.x1; t <= t1; t += 5) g.lineTo(X(t), Y(hi(t)));
  g.lineTo(X(t1), Y(hi(t1)));
  g.lineTo(X(t1), Y(lo(t1)));
  for (let t = t1; t >= fit.x1; t -= 5) g.lineTo(X(t), Y(lo(t)));
  g.closePath(); g.fill();
  g.setLineDash([6, 5]); g.strokeStyle = accent; g.lineWidth = 1.8;
  g.beginPath(); g.moveTo(X(t0), Y(trend(t0))); g.lineTo(X(t1), Y(trend(t1))); g.stroke();
  g.setLineDash([]);
  g.strokeStyle = "rgba(90,105,160,.4)"; g.beginPath(); g.moveTo(nowX, padT); g.lineTo(nowX, H - padB); g.stroke();
  // actual closes
  g.strokeStyle = "#1b2340"; g.lineWidth = 1.6; g.lineJoin = "round";
  g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(X(day(p[0])), Y(p[1])) : g.moveTo(X(day(p[0])), Y(p[1])))); g.stroke();
  // my average cost
  if (avg) {
    g.setLineDash([3, 4]); g.strokeStyle = "#f59e0b"; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(padL, Y(avg)); g.lineTo(W - padR, Y(avg)); g.stroke(); g.setLineDash([]);
    g.fillStyle = "#b45309"; g.textAlign = "right"; g.fillText("我的平均成本", W - padR, Y(avg) - 4);
  }
  // my trades
  const at = (d) => { let v = null; for (const p of pts) { if (p[0] <= d) v = p[1]; else break; } return v; };
  a.txs.filter((t) => t.kind !== "div" && t.date >= pts[0][0]).forEach((t) => {
    const v = at(t.date); if (v == null) return;
    const x = X(day(t.date)), y = Y(v), up = t.kind === "buy";
    g.fillStyle = up ? "#12935a" : "#e0475b";
    g.beginPath();
    if (up) { g.moveTo(x, y - 3); g.lineTo(x - 5, y + 7); g.lineTo(x + 5, y + 7); } else { g.moveTo(x, y + 3); g.lineTo(x - 5, y - 7); g.lineTo(x + 5, y - 7); }
    g.closePath(); g.fill();
  });
  g.fillStyle = css("--muted"); g.textAlign = "left"; g.fillText(pts[0][0], padL, H - 6);
  g.textAlign = "center"; g.fillText("今天", nowX, H - 6);
  g.textAlign = "right"; g.fillText("＋1 年", W - padR, H - 6);

  const last = pts.at(-1)[1], yr = Math.exp(fit.b * 365) - 1, m = mask();
  const p1 = trend(fit.x1 + HOR), cur = esc(s.currency || a.currency);
  const mine = a.value * Math.exp(fit.b * 365);
  const weak = fit.r2 < 0.3 ? "走勢起伏大、不太像一條直線，外推的參考性低。" : fit.r2 < 0.6 ? "走勢與直線趨勢的吻合度普通。" : "";
  $("fc-sum").innerHTML = `<div class="stats">
      <div class="stat"><span>期間歷史趨勢（年化）</span><b class="${yr >= 0 ? "pos" : "neg"}">${signed(yr * 100, fmt)}%</b></div>
      <div class="stat"><span>一年後趨勢價</span><b class="${m}">${cur} ${fmt.format(p1)}</b><small class="${m}">${fmt.format(lo(fit.x1 + HOR))} ～ ${fmt.format(hi(fit.x1 + HOR))}</small></div>
      <div class="stat"><span>你的持倉一年後約</span><b class="${m}">${a.currency} ${fmt0.format(mine)}</b><small class="${m}">目前 ${fmt0.format(a.value)}</small></div>
      <div class="stat"><span>趨勢吻合度 R²</span><b>${fit.r2.toFixed(2)}</b></div>
    </div>
    <p class="hint">依這段期間的價格走勢畫出直線趨勢往後延伸，淡色帶是歷史波動範圍（±1 個標準差）。${weak}這只是統計外推，<b>不是預測保證，也不構成投資建議</b>；▲買入 ▼賣出為你的記錄。收盤 ${fmt.format(last)} ${cur}（${esc(pts.at(-1)[0])}）。</p>`;
}

$("view-detail").addEventListener("click", (e) => {
  const b = e.target.closest("#fc-seg button");
  if (!b) return;
  ui.fcRange = b.dataset.r;
  const a = data.assets.find((x) => x.id === ui.sel);
  if (a) { [...$("fc-seg").children].forEach((x) => x.classList.toggle("on", x === b)); loadForecast(a); }
});

function plansCard(a) {
  const ps = (data.plans || []).filter((p) => p.asset === a.id);
  const rows = ps.map((p) => {
    const c = p.cash ? data.assets.find((x) => x.id === p.cash) : null;
    return `<div class="plan"><div class="plan-t"><b class="${mask()}">每月 ${p.day} 日　${esc(a.currency)} ${fmt0.format(p.amount)}</b>
      <span class="muted">${esc(p.start)} 起${p.end ? ` 至 ${esc(p.end)}` : ""}・${c ? `從「${esc(c.name)}」扣款` : "外部資金"}${p.whole ? "・只買整股" : ""}${p.fee ? `・手續費 ${fmt.format(p.fee)}` : ""}</span>
      ${p.status ? `<div class="neg">⚠ ${esc(p.status)}</div>` : ""}</div>
      <div class="btns"><button class="link" data-editplan="${p.id}">編輯</button><button class="link danger" data-delplan="${p.id}">刪除</button></div></div>`;
  }).join("");
  return `<div class="glass detail">
    <div class="sect"><h3>定期定額${tip("定期定額")} <span class="muted">(${ps.length})</span></h3><div class="btns"><button data-addplan>＋ 新增定期定額</button></div></div>
    ${ps.length ? rows : '<p class="muted">每月固定日期自動買入。設定後 MoneyPi 會依當天收盤價自動記成買入交易，開始日期填過去也會自動補上之前每期。</p>'}
  </div>`;
}

function cashTag(t) {
  if (!t.cash) return "";
  const c = data.assets.find((x) => x.id === t.cash);
  return `<div class="cashtag">${c ? `${esc(c.name)} ${t.cash_delta >= 0 ? "+" : "−"}${fmt.format(Math.abs(t.cash_delta))} ${esc(c.currency)}` : "已刪除的存款"}</div>`;
}

function holdingHtml(a) {
  const q = a.quantity, hasCost = a.cost > 0 && q > 0;
  const unreal = a.value - a.cost, pct = hasCost ? (unreal / a.cost) * 100 : 0;
  const total = (hasCost ? unreal : 0) + a.realized + a.dividends;
  const m = mask(), cur = esc(a.currency);
  const tile = (k, v, cls = "", sub = "") =>
    `<div class="stat ${cls}"><span>${k}${tip(k)}</span><b class="${m}">${v}</b>${sub ? `<small class="${m}">${sub}</small>` : ""}</div>`;
  const tiles = [
    tile("持有數量", fmtQ.format(q)),
    tile("現價／淨值", `${cur} ${fmt.format(a.price)}`, "", a.market ? (a.price_updated ? `行情 ${esc(a.price_updated)}` : "尚未同步") : "手動"),
    tile("平均成本", hasCost ? `${cur} ${fmt.format(a.cost / q)}` : "—"),
    tile("總成本", a.cost > 0 ? `${cur} ${fmt0.format(a.cost)}` : "—"),
    hasCost ? tile("未實現損益", `${signed(unreal)} ${cur}`, unreal >= 0 ? "up" : "down", `${signed(pct, fmt)}%`) : "",
    a.txs.length ? tile("已實現損益", `${signed(a.realized)} ${cur}`, a.realized >= 0 ? "up" : "down") : "",
    a.dividends > 0 ? tile("累計配息", `${cur} ${fmt0.format(a.dividends)}`, "up") : "",
    (() => { const r = xirr(a); return r == null ? "" : tile("年化報酬率 (XIRR)", `${signed(r * 100, fmt)}%`, r >= 0 ? "up" : "down", "依實際買賣日期"); })(),
    hasCost && (a.realized || a.dividends) ? tile("總報酬", `${signed(total)} ${cur}`, total >= 0 ? "up" : "down", `${signed((total / a.cost) * 100, fmt)}%`) : "",
  ].join("");

  const rows = a.txs
    .map((t, i) => ({ t, i }))
    .sort((x, y) => y.t.date.localeCompare(x.t.date) || y.i - x.i)
    .map(({ t, i }) => {
      const amt = t.kind === "div" ? t.price : t.units * t.price;
      return `<tr><td>${esc(t.date)}</td><td><span class="kindtag ${t.kind}">${KIND[t.kind] || t.kind}</span></td>
        <td class="r ${m}">${t.kind === "div" ? "—" : fmtQ.format(t.units)}</td>
        <td class="r ${m}">${t.kind === "div" ? "—" : fmt.format(t.price)}</td>
        <td class="r ${m}">${t.fee ? fmt.format(t.fee) : "—"}</td>
        <td class="r ${m}">${fmt.format(amt)}</td>
        <td class="muted">${esc(t.note)}${cashTag(t)}</td>
        <td class="r"><button class="link danger" data-deltx="${i}">刪除</button></td></tr>`;
    })
    .join("");

  return `<div class="glass detail">
    <div class="sect"><h3>持倉${tip("持倉")}</h3>
      <div class="btns">${a.market ? "<button data-sync>同步行情</button>" : ""}<button class="primary" data-addtx>＋ 記錄交易</button></div></div>
    <div class="stats">${tiles}</div>
  </div>
  <div class="glass detail">
    <div class="sect"><h3>交易記錄 <span class="muted">(${a.txs.length})</span></h3></div>
    ${a.txs.length
      ? `<div class="tx-wrap"><table class="tx"><thead><tr><th>日期</th><th>類型</th><th class="r">單位</th><th class="r">單價</th><th class="r">手續費</th><th class="r">金額</th><th>備註</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="muted">尚無交易記錄。記錄買入／賣出／配息後，數量、平均成本與損益會自動計算。已經持有很久？按「記錄交易」，把日期改成當初買進那天，就能用當時的價格算出真實損益。</p>'}
  </div>${plansCard(a)}${a.market ? forecastCard(a) : ""}`;
}

function renderView() {
  const a = typeof ui.sel === "number" ? data.assets.find((x) => x.id === ui.sel) : null;
  const flow = ui.sel === "flow", report = ui.sel === "report";
  $("view-overview").hidden = !!a || flow || report;
  $("view-detail").hidden = !a;
  $("view-flow").hidden = !flow;
  $("view-report").hidden = !report;
  $("title").textContent = a ? a.name : flow ? "記帳" : report ? "月報" : "總覽";
  if (flow) return renderFlow();
  if (report) return renderReport();
  if (!a) return drawCharts();

  const pool = sum(data.assets.filter((x) => x.liability === a.liability));
  const share = pool > 0 ? (toBase(a) / pool) * 100 : 0;
  const sgn = a.liability ? "−" : "";
  $("view-detail").innerHTML = `<div class="glass detail">
    <div class="d-head">
      <span class="av lg" style="background:${catColor(a.category)}">${esc([...a.name][0] || "?")}</span>
      <div class="who"><h2>${esc(a.name)}</h2><span class="tag ${a.liability ? "debt" : ""}">${a.liability ? "負債 · " : ""}${esc(a.category)}</span>${a.holding && a.symbol ? ` <span class="tag">${esc(a.symbol)}</span>` : ""}</div>
      <div class="d-actions"><button data-edit>編輯</button><button class="danger" data-del>刪除</button></div>
    </div>
    <div class="d-amount ${a.liability ? "neg" : ""} ${mask()}">${sgn}${esc(a.currency)} ${fmt.format(a.value)}</div>
    ${a.holding ? `<div class="d-cap muted">現值 = 持有數量 × 現價${tip("現值")}　（成本與損益在下方「持倉」）</div>` : ""}
    <div class="stats">
      <div class="stat"><span>折合 TWD</span><b class="${mask()}">${sgn}${fmt0.format(toBase(a))}</b></div>
      <div class="stat"><span>佔總${a.liability ? "負債" : "資產"}</span><b>${share.toFixed(1)}%</b></div>
      <div class="stat"><span>匯率</span><b>${a.currency === "TWD" ? "—" : `1 ${esc(a.currency)} = ${fmt.format(rate(a.currency))} TWD`}</b></div>
      <div class="stat"><span>最後更新</span><b>${esc(a.updated)}</b></div>
      <div class="stat"><span>備註</span><b>${a.note ? esc(a.note) : "—"}</b></div>
    </div>
  </div>${a.holding ? holdingHtml(a) : ""}`;
  if (a.holding && a.market) loadForecast(a);
}

function select(id) {
  ui.sel = id;
  renderList();
  renderView();
  $("view-overview").parentElement.scrollTop = 0;
  if (innerWidth <= 640) setCollapsed(true);
}
$("nav-overview").onclick = () => select(null);
$("nav-flow").onclick = () => select("flow");
$("nav-report").onclick = () => select("report");
$("list").onclick = (e) => {
  const b = e.target.closest(".item");
  if (b) select(Number(b.dataset.id));
};
$("view-detail").onclick = async (e) => {
  const a = data.assets.find((x) => x.id === ui.sel);
  if (!a) return;
  const t = (sel) => e.target.closest(sel);
  try {
    if (t("[data-edit]")) openDialog(a);
    else if (t("[data-addtx]")) openTx(a);
    else if (t("[data-sync]")) doRefresh(true);
    else if (t("[data-deltx]")) {
      const i = Number(t("[data-deltx]").dataset.deltx), tx = a.txs[i];
      if (await confirmBox(`刪除這筆${KIND[tx.kind]}記錄？`, `${tx.date}，刪除後會重新計算持倉`)) {
        data = await invoke("delete_tx", { id: a.id, index: i });
        render();
        toast("已刪除");
      }
    } else if (t("[data-del]") && (await confirmBox(`刪除「${a.name}」？`, "刪除後無法復原"))) {
      data = await invoke("delete_asset", { id: a.id });
      ui.sel = null;
      render();
      toast("已刪除");
    }
  } catch (err) {
    toast(String(err));
  }
};

/* ---------- charts ---------- */
function setupCanvas(c) {
  const r = { width: c.clientWidth, height: c.clientHeight }, dpr = window.devicePixelRatio || 1;
  c.width = Math.round(r.width * dpr);
  c.height = Math.round(r.height * dpr);
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  return { g, W: r.width, H: r.height };
}

let trendPts = [];
function drawCharts() {
  if ($("view-overview").hidden) return;
  drawTrend();
  drawAlloc();
  drawMonths();
}
const ro = new ResizeObserver(drawCharts);
ro.observe($("trend"));
ro.observe($("months"));

function drawTrend() {
  const { g, W, H } = setupCanvas($("trend"));
  const padL = ui.hidden ? 12 : 58, padR = 14, padT = 14, padB = 24;
  let all = data.snapshots.map((s) => ({ date: s.date, v: s.assets - s.liabilities }));
  if (ui.range) {
    const cutStr = dateStr(Date.now() - ui.range * DAY);
    all = all.filter((p) => p.date >= cutStr);
  }
  g.font = "11px 'Segoe UI Variable', sans-serif";
  trendPts = [];
  if (!all.length) {
    g.fillStyle = css("--muted"); g.textAlign = "center";
    g.fillText("尚無資料", W / 2, H / 2);
    return;
  }
  let min = Math.min(...all.map((p) => p.v)), max = Math.max(...all.map((p) => p.v));
  const netGoals = data.goals.filter((x) => !x.assets.length);
  if (all.length > 1) max = Math.max(max, ...netGoals.map((x) => x.amount).filter((a) => a <= max * 1.6));
  if (min === max) { const m = Math.abs(min) * 0.05 || 1; min -= m; max += m; }
  const x = (i) => padL + (all.length === 1 ? (W - padL - padR) / 2 : (i * (W - padL - padR)) / (all.length - 1));
  const y = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  trendPts = all.map((p, i) => ({ ...p, x: x(i), y: y(p.v) }));

  g.lineWidth = 1; g.textAlign = "left";
  for (let i = 0; i <= 3; i++) {
    const v = min + ((max - min) * i) / 3, yy = y(v);
    g.strokeStyle = css("--line");
    g.beginPath(); g.moveTo(padL, yy); g.lineTo(W - padR, yy); g.stroke();
    if (!ui.hidden) { g.fillStyle = css("--muted"); g.fillText(fmt0.format(v), 2, yy + 3); }
  }
  netGoals.filter((x) => x.amount >= min && x.amount <= max).slice(0, 4).forEach((x) => { // goal lines
    g.setLineDash([5, 4]); g.strokeStyle = "#3ecf8e"; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(padL, y(x.amount)); g.lineTo(W - padR, y(x.amount)); g.stroke();
    g.setLineDash([]); g.fillStyle = "#12935a"; g.textAlign = "right";
    g.fillText(`${x.icon} ${x.name}`, W - padR, y(x.amount) - 4);
    g.textAlign = "left";
  });
  const accent = css("--accent");
  const grad = g.createLinearGradient(0, padT, 0, H - padB);
  grad.addColorStop(0, accent + "55");
  grad.addColorStop(1, accent + "00");
  g.beginPath();
  trendPts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  g.lineTo(trendPts.at(-1).x, H - padB); g.lineTo(trendPts[0].x, H - padB); g.closePath();
  g.fillStyle = grad; g.fill();

  g.strokeStyle = accent; g.lineWidth = 2.5; g.lineJoin = "round";
  g.beginPath();
  trendPts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  g.stroke();
  g.fillStyle = accent;
  trendPts.forEach((p) => { g.beginPath(); g.arc(p.x, p.y, 3, 0, 7); g.fill(); });

  g.fillStyle = css("--muted");
  g.textAlign = "left"; g.fillText(trendPts[0].date, padL, H - 6);
  if (trendPts.length > 1) { g.textAlign = "right"; g.fillText(trendPts.at(-1).date, W - padR, H - 6); }

  const h = trendPts[ui.hover];
  if (h) {
    g.strokeStyle = "rgba(90,105,160,.35)"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(h.x, padT); g.lineTo(h.x, H - padB); g.stroke();
    g.fillStyle = "#fff"; g.beginPath(); g.arc(h.x, h.y, 5, 0, 7); g.fill();
    g.strokeStyle = accent; g.lineWidth = 2; g.stroke();
    const label = `${h.date}  ${ui.hidden ? "••••" : fmt0.format(h.v)}`;
    const w = g.measureText(label).width + 16, bx = Math.min(Math.max(h.x - w / 2, 4), W - w - 4), by = Math.max(h.y - 34, 2);
    g.fillStyle = "rgba(27,35,64,.88)";
    g.beginPath(); g.roundRect(bx, by, w, 22, 11); g.fill();
    g.fillStyle = "#fff"; g.textAlign = "left"; g.fillText(label, bx + 8, by + 15);
  }
}

$("trend").addEventListener("mousemove", (e) => {
  if (!trendPts.length) return;
  const mx = e.clientX - $("trend").getBoundingClientRect().left;
  let best = 0;
  trendPts.forEach((p, i) => { if (Math.abs(p.x - mx) < Math.abs(trendPts[best].x - mx)) best = i; });
  if (best !== ui.hover) { ui.hover = best; drawTrend(); }
});
$("trend").addEventListener("mouseleave", () => { ui.hover = -1; drawTrend(); });

function drawAlloc() {
  const { g, W, H } = setupCanvas($("alloc"));
  if (W < 80 || H < 80) return;
  const by = {};
  data.assets.filter((a) => !a.liability).forEach((a) => (by[a.category] = (by[a.category] || 0) + toBase(a)));
  const items = Object.entries(by).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const total = items.reduce((s, [, v]) => s + v, 0);
  $("legend").innerHTML = items
    .map(([k, v]) => `<li><i style="background:${catColor(k)}"></i>${esc(k)} ${((v / total) * 100).toFixed(1)}%</li>`).join("");
  if (!total) { g.fillStyle = css("--muted"); g.textAlign = "center"; g.fillText("尚無資產", W / 2, H / 2); return; }
  const cx = W / 2, cy = H / 2, lw = 26, r = Math.min(W, H) / 2 - lw / 2 - 6;
  let a0 = -Math.PI / 2;
  g.lineWidth = lw; g.lineCap = "butt";
  items.forEach(([k, v]) => {
    const sweep = (v / total) * Math.PI * 2, gap = items.length > 1 ? Math.min(0.03, sweep / 4) : 0; // a gap wider than the slice would flip the arc into a full circle
    g.strokeStyle = catColor(k);
    g.beginPath(); g.arc(cx, cy, r, a0 + gap, a0 + sweep - gap); g.stroke();
    a0 += sweep;
  });
  g.fillStyle = css("--muted"); g.textAlign = "center"; g.font = "12px 'Segoe UI Variable', sans-serif";
  g.fillText("總資產", cx, cy - 4);
  g.fillStyle = css("--fg"); g.font = "600 15px 'Segoe UI Variable', sans-serif";
  g.fillText(ui.hidden ? "••••" : fmt0.format(total), cx, cy + 16);
}

$("range").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  ui.range = Number(b.dataset.r);
  [...$("range").children].forEach((c) => c.classList.toggle("on", c === b));
  drawTrend();
};
$("kind").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  ui.kind = b.dataset.k;
  [...$("kind").children].forEach((c) => c.classList.toggle("on", c === b));
  renderList();
};
$("q").oninput = (e) => { ui.q = e.target.value; renderList(); };

/* ---------- confirm dialog ---------- */
function confirmBox(msg, sub = "", ok = "刪除") {
  const d = $("cdlg");
  $("cok").textContent = ok;
  $("cmsg").textContent = msg;
  $("csub").textContent = sub;
  d.returnValue = "";
  return new Promise((res) => {
    d.addEventListener("close", () => res(d.returnValue === "ok"), { once: true });
    d.showModal();
  });
}

document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => b.closest("dialog").close()));

/* ---------- asset dialog ---------- */
const dlg = $("dlg"), form = $("form");
let editingId = 0, editingHasTxs = false;

function updateHoldHint() {
  const m = fMkt.value;
  $("hold-hint").textContent = editingHasTxs
    ? "數量與成本由交易記錄自動計算（可在項目詳情新增或刪除交易）。"
    : m === "tw" ? "台股只需填代號，如 2330、0050（上櫃會自動辨識）。"
    : m === "other" ? "請填 Yahoo Finance 代號，如 AAPL、VOO、BTC-USD、0050.TW。"
    : "";
}

function syncHoldingUI() {
  const on = form.holding.checked;
  if ($("div-fields")) syncDivUI();
  $("holding-fields").hidden = !on;
  $("value-wrap").hidden = on;
  form.value.required = !on;
  form.quantity.disabled = form.cost.disabled = on && editingHasTxs;
  updateHoldHint();
}
form.holding.onchange = syncHoldingUI;
fCat.onChange = (v) => {
  if (!editingId && (v === "股票" || v === "基金/ETF") && !form.holding.checked) {
    form.holding.checked = true;
    syncHoldingUI();
  }
};

function openDialog(asset) {
  editingId = asset ? asset.id : 0;
  editingHasTxs = !!(asset && asset.txs.length);
  $("dlg-title").textContent = asset ? "編輯項目" : "新增項目";
  form.reset();
  $("err").textContent = "";
  const cats = asset && !CATS.includes(asset.category) ? [...CATS, asset.category] : CATS;
  fCat.setOptions(cats, asset ? asset.category : CATS[0]);
  fCur.setOptions(Object.keys(data.rates), asset ? asset.currency : "TWD");
  fMkt.setOptions(fMkt.opts, asset ? asset.market : "");
  if (asset) {
    form.name.value = asset.name;
    form.value.value = asset.value;
    form.liability.checked = asset.liability;
    form.note.value = asset.note;
    form.holding.checked = asset.holding;
    form.symbol.value = asset.symbol;
    form.quantity.value = asset.quantity || "";
    form.price.value = asset.price || "";
    form.cost.value = asset.cost || "";
  }
  form.autodiv.checked = asset ? asset.auto_div !== false : true;
  fDivCash.setOptions([{ value: "0", label: "外部資金（不動用 App 內存款）" },
    ...data.assets.filter((x) => !x.holding && !x.liability && x.id !== editingId).map((c) => ({ value: String(c.id), label: `${c.name}（${c.currency}）` }))], asset ? String(asset.div_cash || 0) : "0");
  syncHoldingUI();
  syncDivUI();
  dlg.showModal();
  form.name.focus();
}
$("add-btn").onclick = () => {
  openDialog(null);
  if (innerWidth <= 640) setCollapsed(true);
};

form.onsubmit = async (e) => {
  e.preventDefault();
  try {
    const wasNew = !editingId, holding = form.holding.checked, market = holding ? fMkt.value : "";
    data = await invoke("save_asset", {
      asset: {
        id: editingId,
        name: form.name.value.trim(),
        category: fCat.value,
        currency: fCur.value,
        value: holding ? 0 : num(form.value.value),
        liability: form.liability.checked,
        note: form.note.value.trim(),
        updated: "",
        holding,
        symbol: holding ? form.symbol.value.trim() : "",
        market,
        quantity: holding ? num(form.quantity.value) : 0,
        price: holding ? num(form.price.value) : 0,
        cost: holding ? num(form.cost.value) : 0,
        auto_div: form.autodiv.checked,
        div_cash: Number(fDivCash.value) || 0,
      },
    });
    dlg.close();
    if (wasNew) ui.sel = Math.max(...data.assets.map((a) => a.id));
    render();
    toast(wasNew ? "已新增" : "已更新");
    if (market) doRefresh(false);
    runDividends(false);
  } catch (err) {
    $("err").textContent = String(err);
  }
};

/* ---------- transaction dialog (fund / stock records) ---------- */
const tdlg = $("tdlg"), tform = $("tform");
let txAsset = null;

function syncTxUI() {
  const div = tKind.value === "div", sell = tKind.value === "sell";
  $("t-units-wrap").hidden = $("t-fee-wrap").hidden = div;
  $("t-price-label").textContent = div ? "配息總額" : "單價／淨值";
  $("t-pick-row").hidden = div || !txAsset?.market;
  const src = cashSources().find((a) => String(a.id) === tCash.value);
  $("t-cash-hint").textContent = src
    ? (tKind.value === "buy" ? `買入金額會從「${src.name}」扣除（目前 ${src.currency} ${fmt.format(src.value)}）。` : `${sell ? "賣出所得" : "配息"}會加到「${src.name}」。`)
    : "不動用 App 內的存款，視為另外準備的資金，不影響其他資產。";
}

/* deposits / cash a trade can be paid from or settled into */
const cashSources = () => data.assets.filter((a) => !a.holding && !a.liability && a.id !== txAsset?.id);

function openTx(a) {
  txAsset = a;
  tform.reset();
  $("terr").textContent = "";
  $("tdlg-title").textContent = `記錄交易 · ${a.name}`;
  tKind.setValue("buy");
  const last = store.get("tx_cash", "0");
  tCash.setOptions([{ value: "0", label: "外部資金（不動用 App 內存款）" },
    ...cashSources().map((c) => ({ value: String(c.id), label: `${c.name}（${c.currency} ${fmt0.format(c.value)}）` }))], last);
  tform.date.value = todayStr();
  tform.price.value = a.price || "";
  $("t-pick-msg").textContent = "之前就買了？把日期改成買進那天，再按左邊的鈕帶入當時收盤價（實際成交價請以對帳單為準）。";
  syncTxUI();
  tdlg.showModal();
  tform.units.focus();
}

$("t-pick").onclick = async () => {
  const date = tform.date.value.trim(), msg = $("t-pick-msg");
  msg.textContent = "查詢中…";
  try {
    const r = await invoke("price_on", { id: txAsset.id, date });
    tform.price.value = r.price;
    msg.textContent = `已帶入 ${r.date} 收盤價 ${fmt.format(r.price)} ${r.currency}${r.date !== date ? "（當天休市，取前一個交易日）" : ""}`;
  } catch (err) { msg.textContent = String(err); }
};

tform.onsubmit = async (e) => {
  e.preventDefault();
  const div = tKind.value === "div";
  try {
    data = await invoke("add_tx", {
      id: txAsset.id,
      tx: {
        date: tform.date.value.trim(),
        kind: tKind.value,
        units: div ? 0 : num(tform.units.value),
        price: num(tform.price.value),
        fee: div ? 0 : num(tform.fee.value),
        note: tform.note.value.trim(),
        cash: Number(tCash.value) || 0,
      },
    });
    store.set("tx_cash", tCash.value);
    tdlg.close();
    render();
    toast("已記錄交易");
  } catch (err) {
    $("terr").textContent = String(err);
  }
};

/* ---------- recurring plan (定期定額) ---------- */
const pldlg = $("pldlg"), plform = $("plform"), plCash = new Dropdown($("pl-cash"), () => syncPlanUI());
let plAsset = null, plId = 0;

function syncPlanUI() {
  const src = data.assets.find((x) => String(x.id) === plCash.value);
  $("pl-hint").textContent = src
    ? `每期會從「${src.name}」扣除（目前 ${src.currency} ${fmt.format(src.value)}）。`
    : "不動用 App 內的存款，視為另外準備的資金。";
}

function openPlan(a, p) {
  plAsset = a;
  plId = p ? p.id : 0;
  plform.reset();
  $("plerr").textContent = "";
  $("pl-title").textContent = `${p ? "編輯" : "新增"}定期定額 · ${a.name}`;
  plCash.setOptions([{ value: "0", label: "外部資金（不動用 App 內存款）" },
    ...data.assets.filter((x) => !x.holding && !x.liability).map((c) => ({ value: String(c.id), label: `${c.name}（${c.currency} ${fmt0.format(c.value)}）` }))], p ? String(p.cash) : "0");
  plform.amount.value = p ? p.amount : "";
  plform.day.value = p ? p.day : new Date().getDate();
  plform.fee.value = p && p.fee ? p.fee : "";
  plform.start.value = p ? p.start : todayStr();
  plform.end.value = p ? p.end : "";
  plform.whole.checked = p ? p.whole : a.market === "tw";
  syncPlanUI();
  pldlg.showModal();
  plform.amount.focus();
}

$("view-detail").addEventListener("click", async (e) => {
  const a = data.assets.find((x) => x.id === ui.sel);
  if (!a) return;
  const t = (sel) => e.target.closest(sel);
  try {
    if (t("[data-addplan]")) openPlan(a, null);
    else if (t("[data-editplan]")) openPlan(a, (data.plans || []).find((p) => p.id === Number(t("[data-editplan]").dataset.editplan)));
    else if (t("[data-delplan]")) {
      if (await confirmBox("刪除這個定期定額？", "已經記下的買入交易不會被刪除，只是之後不再自動買入。", "刪除")) {
        data = await invoke("delete_plan", { id: Number(t("[data-delplan]").dataset.delplan) });
        render();
        toast("已刪除");
      }
    }
  } catch (err) { toast(String(err)); }
});

plform.onsubmit = async (e) => {
  e.preventDefault();
  try {
    data = await invoke("save_plan", {
      plan: {
        id: plId, asset: plAsset.id,
        amount: num(plform.amount.value), day: Number(plform.day.value), fee: num(plform.fee.value),
        start: plform.start.value.trim(), end: plform.end.value.trim(), whole: plform.whole.checked,
        cash: Number(plCash.value) || 0,
      },
    });
    pldlg.close();
    render();
    await runPlans(true);
    if (!$("pldlg").open) toast("已儲存定期定額");
  } catch (err) {
    $("plerr").textContent = String(err);
  }
};

// Book whatever has come due (also backfills). Only the desktop app does this.
async function runPlans(announce) {
  if (!inTauri || !data.plans?.length) return;
  try {
    const r = await invoke("run_plans");
    data = r.data;
    if (r.added || announce) render();
    if (r.added) toast(`定期定額已自動新增 ${r.added} 筆買入`);
  } catch (err) { if (announce) toast(String(err)); }
}

/* ---------- password prompt / lock ---------- */
const qdlg = $("qdlg"), qform = $("qform");
// Resolves with the typed password, or null when cancelled.
function askPassword(title, msg, { cancelable = true, err = "" } = {}) {
  $("q-title").textContent = title;
  $("q-msg").textContent = msg;
  $("qerr").textContent = err;
  qform.reset();
  $("q-cancel").hidden = !cancelable;
  qdlg.oncancel = cancelable ? null : (e) => e.preventDefault();
  qdlg.dataset.ok = "";
  return new Promise((res) => {
    qdlg.addEventListener("close", () => res(qdlg.dataset.ok ? qform.pw.value : null), { once: true });
    qdlg.showModal();
    qform.pw.focus();
  });
}
qform.addEventListener("submit", () => { qdlg.dataset.ok = "1"; });

async function unlockFlow() {
  let err = "";
  for (;;) {
    const pw = await askPassword("MoneyPi 已鎖定", "請輸入密碼解鎖。", { cancelable: false, err });
    try { await invoke("unlock", { password: pw }); return; } catch (e) { err = String(e); }
  }
}
$("lock-btn").onclick = async () => {
  try { await invoke("lock"); location.reload(); } catch (err) { toast(String(err)); }
};

/* ---------- help + guided tour ---------- */
$("help-btn").onclick = () => $("hdlg").showModal();
$("h-tour").onclick = () => { $("hdlg").close(); setTimeout(startTour, 250); };

const TOUR = [
  { t: "歡迎使用 MoneyPi", d: "這是你的個人資產追蹤工具：記錄存款、股票、基金與負債，自動算出淨資產、損益，以及離目標還有多久。花 30 秒看一下怎麼用？" },
  { sel: "#add-btn", t: "第 1 步：新增項目", d: "存款、現金、股票、ETF、基金、貸款都從這裡新增。存款填目前餘額；股票、基金請勾選「持倉」，再用「記錄交易」輸入買賣，成本與損益就會自動算出來。" },
  { sel: "#list", t: "你的項目清單", d: "新增的項目會列在這裡，點一下看詳細：現值、成本、損益、交易記錄、定期定額和走勢預測。" },
  { sel: "#nav-overview", t: "總覽", d: "看淨資產走勢、資產配置、投資組合與目標進度，也可以在這裡設定多個目標。" },
  { sel: "#nav-flow", t: "記帳", d: "記錄每天的收入與支出，查看每月統計。" },
  { sel: "#nav-report", t: "月報", d: "每個月一份：淨資產變多少、存了多少、買賣與配息、各目標的進度，以及預估何時達成。" },
  { sel: "#refresh-btn", t: "同步股價與匯率", d: "有設定行情代號的股票、ETF 會抓最新報價，外幣也會更新匯率。自動更新的間隔在「設定」裡調整。" },
  { sel: "#hide-btn", t: "隱藏金額", d: "在公共場合想遮住數字，就按這裡。" },
  { sel: "#phone-btn", t: "手機連線", d: "用手機查看同一份資料：同一個 Wi-Fi 掃 QR Code，或用「遠端」在外面也能連。" },
  { sel: "#settings-btn", t: "設定", d: "匯率、自動更新、備份與還原、檢查更新都在這裡。" },
  { sel: "#help-btn", t: "隨時看說明", d: "名詞旁邊有 ? 的，點一下就會解釋。完整教學在這個按鈕裡，也可以重新播放這個導覽。" },
];
let tourSteps = [], tourI = 0;
const visibleEl = (sel) => {
  const el = document.querySelector(sel);
  if (!el || !el.offsetWidth || !el.offsetHeight) return null;
  const r = el.getBoundingClientRect();
  return r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight ? el : null;
};
function startTour() {
  if (document.querySelector("dialog[open]")) return;
  tourSteps = TOUR.filter((s) => !s.sel || visibleEl(s.sel));
  tourI = 0;
  $("tour").showPopover();
  drawTour();
}
function endTour() {
  store.set("toured", "1");
  if ($("tour").matches(":popover-open")) $("tour").hidePopover();
}
function drawTour() {
  const s = tourSteps[tourI], last = tourI === tourSteps.length - 1;
  const el = s.sel ? visibleEl(s.sel) : null;
  const card = $("tour-card"), hole = document.querySelector(".tour-hole");
  card.innerHTML = `<h4>${s.t}</h4><p>${s.d}</p><div class="tour-foot"><span class="muted">${tourI + 1} / ${tourSteps.length}</span><span class="grow"></span>
    ${last ? "" : "<button type=\"button\" data-tskip>略過</button>"}${tourI ? "<button type=\"button\" data-tprev>上一步</button>" : ""}<button type="button" class="primary" data-tnext>${last ? "完成" : "下一步"}</button></div>`;
  const cw = card.offsetWidth, ch = card.offsetHeight, clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  let x, y;
  if (el) {
    const r = el.getBoundingClientRect(), p = 6;
    Object.assign(hole.style, { left: r.left - p + "px", top: r.top - p + "px", width: r.width + 2 * p + "px", height: r.height + 2 * p + "px" });
    if (r.left < 200 && r.right + 14 + cw < innerWidth - 12) { x = r.right + 14 + p; y = clamp(r.top, 12, innerHeight - ch - 12); }
    else {
      x = clamp(r.left + r.width / 2 - cw / 2, 12, innerWidth - cw - 12);
      y = r.bottom + 14 + ch < innerHeight - 12 ? r.bottom + 14 + p : Math.max(12, r.top - 14 - ch - p);
    }
  } else {
    Object.assign(hole.style, { left: innerWidth / 2 + "px", top: innerHeight / 2 + "px", width: "0px", height: "0px" });
    x = (innerWidth - cw) / 2;
    y = (innerHeight - ch) / 2;
  }
  card.style.left = x + "px";
  card.style.top = y + "px";
}
$("tour-card").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.hasAttribute("data-tskip")) endTour();
  else if (b.hasAttribute("data-tprev")) { tourI--; drawTour(); }
  else if (tourI >= tourSteps.length - 1) endTour();
  else { tourI++; drawTour(); }
};
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("tour").matches(":popover-open")) endTour(); });
addEventListener("resize", () => { if ($("tour").matches(":popover-open")) drawTour(); });

// Dividends reported by the quote source (desktop app only; runs after the plans).
async function runDividends(announce) {
  if (!inTauri || !data.assets.some((a) => a.holding && a.auto_div && a.market)) return;
  try {
    const r = await invoke("run_dividends");
    data = r.data;
    if (r.added) { render(); toast(`已自動記錄 ${r.added} 筆配息`); }
    else if (announce) toast("目前沒有新的配息");
  } catch (err) { if (announce) toast(String(err)); }
}

/* ---------- security + automatic backup (settings) ---------- */
let secState = { encrypted: false };
async function refreshSecurity() {
  if (!inTauri) return;
  try {
    secState = await invoke("lock_status");
    $("pw-state").textContent = secState.encrypted ? "🔒 已啟用密碼保護（資料檔已加密）" : "尚未設定密碼（資料檔為明文）";
    $("pw-btn").textContent = secState.encrypted ? "變更密碼" : "設定密碼";
    $("pw-off").hidden = !secState.encrypted;
    $("lock-btn").hidden = !secState.encrypted;
    showBackup(await invoke("backup_info"));
  } catch (err) { $("serr").textContent = String(err); }
}
function showBackup(i) {
  $("bk-on").checked = i.on;
  $("bk-dir").value = i.dir;
  [...$("bk-keep").children].forEach((b) => b.classList.toggle("on", Number(b.dataset.k) === i.keep));
  $("bk-info").textContent = `${i.on ? "已開啟" : "未開啟"}・位置：${i.path}・目前 ${i.count} 份${i.files.length ? `，最近：${i.files[0].replace("moneypi-", "").replace(".json", "")}` : ""}`;
}
async function saveBackup(patch = {}) {
  try {
    const cur = { on: $("bk-on").checked, dir: $("bk-dir").value.trim(), keep: Number([...$("bk-keep").children].find((b) => b.classList.contains("on"))?.dataset.k || 14), ...patch };
    showBackup(await invoke("set_backup", cur));
    $("serr").textContent = "";
  } catch (err) { $("serr").textContent = String(err); refreshSecurity(); }
}
$("bk-on").onchange = () => saveBackup();
$("bk-dir").onchange = () => saveBackup();
$("bk-keep").onclick = (e) => { const b = e.target.closest("button"); if (b) saveBackup({ keep: Number(b.dataset.k) }); };
$("bk-now").onclick = async () => {
  try { const r = await invoke("backup_now"); showBackup(r.info); toast("已備份：" + r.name); } catch (err) { $("serr").textContent = String(err); }
};
$("bk-open").onclick = () => invoke("open_external", { target: "backups" }).catch((err) => ($("serr").textContent = String(err)));

const spdlg = $("spdlg"), spform = $("spform");
let spMode = "set";
function openPassword(mode) {
  spMode = mode;
  spform.reset();
  $("sperr").textContent = "";
  $("sp-title").textContent = { set: "設定密碼", change: "變更密碼", off: "關閉密碼" }[mode];
  $("sp-old-wrap").hidden = mode === "set";
  $("sp-new-wrap").hidden = $("sp-new2-wrap").hidden = mode === "off";
  $("sp-hint").textContent = mode === "off" ? "關閉後資料檔會改回明文儲存。" : "忘記密碼就無法救回資料，MoneyPi 也無法幫你重設，請務必記好。建議同時保留一份你信任的備份。";
  spdlg.showModal();
  (mode === "set" ? spform.nw : spform.old).focus();
}
$("pw-btn").onclick = () => openPassword(secState.encrypted ? "change" : "set");
$("pw-off").onclick = () => openPassword("off");
spform.onsubmit = async (e) => {
  e.preventDefault();
  const f = spform;
  if (spMode !== "off") {
    if (f.nw.value.length < 6) return ($("sperr").textContent = "密碼至少 6 個字");
    if (f.nw.value !== f.nw2.value) return ($("sperr").textContent = "兩次輸入的密碼不一樣");
  }
  try {
    await invoke("set_password", { old: spMode === "set" ? "" : f.old.value, new: spMode === "off" ? "" : f.nw.value });
    spdlg.close();
    toast(spMode === "off" ? "已關閉密碼" : "已儲存密碼，下次開啟需要輸入");
    refreshSecurity();
  } catch (err) { $("sperr").textContent = String(err); }
};

/* ---------- settings dialog ---------- */
const sdlg = $("sdlg"), sform = $("sform");
let refreshSel = 0;

function rateRow(code, val) {
  const base = code === "TWD";
  return `<div class="rate-row" data-code="${esc(code)}"><b>${esc(code)}</b>
    <input type="number" min="0" step="any" value="${val}" ${base ? "disabled" : ""}>
    ${base ? "<span></span>" : '<button type="button" class="link" data-rm>移除</button>'}</div>`;
}

function setRefreshSeg(m) {
  refreshSel = m;
  [...$("refresh-seg").children].forEach((b) => b.classList.toggle("on", Number(b.dataset.m) === m));
}
$("refresh-seg").onclick = (e) => {
  const b = e.target.closest("button");
  if (b) setRefreshSeg(Number(b.dataset.m));
};

async function openSettings() {
  setRefreshSeg(data.refresh_min || 0);
  $("rates").innerHTML = Object.entries(data.rates).map(([c, r]) => rateRow(c, r)).join("");
  $("new-code").value = $("new-rate").value = "";
  $("serr").textContent = "";
  sdlg.showModal();
  if (inTauri) {
    try {
      $("ver").textContent = "目前版本 v" + (await window.__TAURI__.core.invoke("app_version"));
    } catch (e) { $("upd-status").textContent = String(e); }
  }
}
$("settings-btn").onclick = () => { refreshSecurity(); openSettings(); };
$("rates").onclick = (e) => e.target.matches("[data-rm]") && e.target.closest(".rate-row").remove();

sform.onsubmit = async (e) => {
  e.preventDefault();
  const rates = {};
  document.querySelectorAll("#rates .rate-row").forEach((r) => {
    const v = r.querySelector("input").value;
    rates[r.dataset.code] = v === "" ? 0 : parseFloat(v);
  });
  rates.TWD = 1;
  const code = $("new-code").value.trim().toUpperCase();
  if (code) {
    if (!/^[A-Z]{2,5}$/.test(code)) return ($("serr").textContent = "幣別代碼需為 2–5 個英文字母");
    rates[code] = parseFloat($("new-rate").value) || 0;
  }
  try {
    data = await invoke("set_settings", {
      rates, refresh_min: refreshSel,
    });
    sdlg.close();
    render();
    scheduleRefresh();
    toast("設定已儲存");
  } catch (err) {
    $("serr").textContent = String(err);
  }
};

/* ---------- quote sync ---------- */
let refreshing = false, refreshTimer = 0;
async function doRefresh(manual) {
  if (refreshing) return;
  refreshing = true;
  $("refresh-btn").classList.add("spin");
  try {
    const r = await invoke("refresh_quotes");
    data = r.data;
    render();
    const msg = `已更新 ${r.updated} 檔報價、${r.rates} 個匯率` + (r.failed.length ? `；失敗：${r.failed.join("、")}` : "");
    if (manual || r.failed.length) toast(msg);
  } catch (err) {
    if (manual) toast("同步失敗：" + err);
  } finally {
    refreshing = false;
    $("refresh-btn").classList.remove("spin");
  }
}
$("refresh-btn").onclick = () => doRefresh(true);

function scheduleRefresh() {
  clearInterval(refreshTimer);
  // Only the desktop app drives quote refresh; LAN browsers just pick up the results via polling.
  if (inTauri && data.refresh_min > 0) refreshTimer = setInterval(() => doRefresh(false), data.refresh_min * 60000);
}

// Pick up changes made on another device (and quote refreshes) without clobbering an open dialog.
setInterval(async () => {
  if (document.hidden || document.querySelector("dialog[open]") || refreshing) return;
  try {
    const d = await invoke("get_data");
    if (JSON.stringify(d) !== JSON.stringify(data)) { data = d; render(); }
  } catch {}
}, 30000);

/* ---------- CSV export / import ---------- */
$("export-btn").onclick = async () => {
  try {
    const csv = await invoke("export_csv");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `moneypi-${todayStr()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("已匯出 CSV");
  } catch (err) { toast("匯出失敗：" + err); }
};
$("import-btn").onclick = () => $("import-file").click();
$("import-file").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const before = data.assets.length;
    data = await invoke("import_csv", { text: await f.text() });
    render();
    toast(`已匯入 ${data.assets.length - before} 筆`);
  } catch (err) {
    toast("匯入失敗：" + err);
  }
};

/* ---------- auto update (desktop only) ---------- */
let pendingUpdate = null;
async function checkUpdate(manual) {
  if (!inTauri) return;
  const st = $("upd-status"), btn = $("upd-btn");
  if (manual) { btn.disabled = true; btn.textContent = "檢查中…"; st.textContent = ""; }
  try {
    const u = await window.__TAURI__.core.invoke("check_update");
    if (u) {
      pendingUpdate = u;
      $("update-text").textContent = `發現新版本 v${u.version}`;
      $("update-bar").hidden = false;
      st.textContent = `發現新版本 v${u.version}，按下「立即更新」安裝`;
      btn.textContent = "立即更新";
    } else if (manual) {
      st.textContent = `✓ 目前已是最新版本（${$("ver").textContent.replace("目前版本 ", "")}）`;
      btn.textContent = "檢查更新";
    }
  } catch (err) {
    if (manual) { st.textContent = "檢查失敗：" + err; btn.textContent = "檢查更新"; }
  } finally {
    btn.disabled = false;
  }
}
async function installUpdate() {
  $("update-now").disabled = $("upd-btn").disabled = true;
  $("update-text").textContent = "下載並安裝中，完成後會自動重新啟動…";
  $("upd-status").textContent = "下載並安裝中，完成後會自動重新啟動…";
  try {
    await window.__TAURI__.core.invoke("install_update");
  } catch (err) {
    $("update-now").disabled = $("upd-btn").disabled = false;
    $("upd-status").textContent = "更新失敗：" + err;
    toast("更新失敗：" + err);
  }
}
$("update-later").onclick = () => ($("update-bar").hidden = true);
$("update-now").onclick = installUpdate;
$("upd-btn").onclick = () => (pendingUpdate ? installUpdate() : checkUpdate(true));

/* ---------- portfolio overview ---------- */
function renderPortfolio() {
  const el = $("port-panel");
  const hs = data.assets.filter((a) => a.holding && !a.liability);
  if (!hs.length) { el.hidden = true; return; }
  el.hidden = false;
  const r = (a) => rate(a.currency), m = mask();
  const val = hs.reduce((t, a) => t + a.value * r(a), 0);
  const wc = hs.filter((a) => a.cost > 0 && a.quantity > 0);
  const cost = wc.reduce((t, a) => t + a.cost * r(a), 0);
  const unreal = wc.reduce((t, a) => t + (a.value - a.cost) * r(a), 0);
  const real = hs.reduce((t, a) => t + a.realized * r(a), 0);
  const div = hs.reduce((t, a) => t + a.dividends * r(a), 0);
  const tile = (k, v, cls = "", sub = "") => `<div class="stat ${cls}"><span>${k}</span><b class="${m}">${v}</b>${sub ? `<small class="${m}">${sub}</small>` : ""}</div>`;
  const rows = hs
    .map((a) => ({ a, pct: a.cost > 0 && a.quantity > 0 ? ((a.value - a.cost) / a.cost) * 100 : null }))
    .sort((x, y) => (y.pct ?? -1e9) - (x.pct ?? -1e9));
  const maxAbs = Math.max(1, ...rows.map((x) => Math.abs(x.pct ?? 0)));
  el.innerHTML = `<div class="panel-head"><h3>投資組合</h3></div>
    <div class="stats">
      ${tile("持倉市值", money(val))}
      ${tile("總成本", cost > 0 ? money(cost) : "—")}
      ${cost > 0 ? tile("未實現損益", signed(unreal), unreal >= 0 ? "up" : "down", `${signed((unreal / cost) * 100, fmt)}%`) : ""}
      ${real ? tile("已實現損益", signed(real), real >= 0 ? "up" : "down") : ""}
      ${div ? tile("累計配息", money(div), "up") : ""}
    </div>
    <div class="plist">${rows.map(({ a, pct }) => `<button class="prow" data-id="${a.id}">
      <span><b>${esc(a.name)}</b><small>${esc(a.symbol || a.category)}</small></span>
      <span class="bar-track"><span class="bar-fill" style="display:block;width:${pct === null ? 0 : Math.max(3, (Math.abs(pct) / maxAbs) * 100)}%;background:${pct !== null && pct < 0 ? "#fb7185" : "#3ecf8e"}"></span></span>
      <span class="pct ${pct === null ? "muted" : pct >= 0 ? "pos" : "neg"}">${pct === null ? "—" : signed(pct, fmt) + "%"}</span>
    </button>`).join("")}</div>`;
}
$("port-panel").onclick = (e) => {
  const b = e.target.closest("[data-id]");
  if (b) select(Number(b.dataset.id));
};

/* ---------- monthly net-worth change ---------- */
function monthlyChanges() {
  const last = new Map();
  data.snapshots.forEach((s) => last.set(s.date.slice(0, 7), s.assets - s.liabilities)); // chronological: last of month wins
  const keys = [...last.keys()].sort();
  return keys.slice(1).map((k, i) => ({ m: k, v: last.get(k) - last.get(keys[i]) }));
}
const compact = (v) => (Math.abs(v) >= 1e4 ? (v / 1e4).toFixed(Math.abs(v) >= 1e5 ? 0 : 1) + "萬" : fmt0.format(v));

function drawMonths() {
  const { g, W, H } = setupCanvas($("months"));
  if (W < 80) return;
  const rows = monthlyChanges().slice(-12);
  $("months-note").textContent = rows.length ? "每月月底淨資產相較上月底的變化（本月為截至目前）。" : "";
  g.font = "11px 'Segoe UI Variable', sans-serif";
  if (!rows.length) {
    g.fillStyle = css("--muted"); g.textAlign = "center";
    g.fillText("累積滿兩個月的記錄後，會顯示每月變化", W / 2, H / 2);
    return;
  }
  const top = 18, bot = H - 22;
  const maxV = Math.max(...rows.map((r) => r.v), 0), minV = Math.min(...rows.map((r) => r.v), 0);
  const span = maxV - minV || 1, y0 = top + (maxV / span) * (bot - top);
  const bw = Math.min(46, (W / rows.length) * 0.58), step = W / rows.length;
  g.strokeStyle = css("--line"); g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, y0); g.lineTo(W, y0); g.stroke();
  rows.forEach((r, i) => {
    const x = i * step + (step - bw) / 2, h = Math.max(2, (Math.abs(r.v) / span) * (bot - top));
    const y = r.v >= 0 ? y0 - h : y0;
    g.fillStyle = r.v >= 0 ? "#3ecf8e" : "#fb7185";
    g.beginPath(); g.roundRect(x, y, bw, h, 6); g.fill();
    g.fillStyle = css("--muted"); g.textAlign = "center";
    g.fillText(r.m.slice(2).replace("-", "/"), x + bw / 2, H - 6);
    if (!ui.hidden) { g.fillStyle = css("--fg"); g.fillText(compact(r.v), x + bw / 2, r.v >= 0 ? y - 4 : y + h + 12); }
  });
}

/* ---------- bookkeeping (income / expense) ---------- */
const FLOW_CATS = { out: ["餐飲", "交通", "居住", "娛樂", "購物", "醫療", "學習", "其他"], in: ["薪資", "獎金", "投資", "其他"] };
const shiftMonth = (ym, d) => {
  const [y, m] = ym.split("-").map(Number), dt = new Date(y, m - 1 + d, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
};

function renderFlow() {
  const ym = ui.fm, all = data.cashflow || [];
  $("fm-label").textContent = ym.replace("-", " 年 ") + " 月";
  const mf = all.filter((f) => f.date.startsWith(ym));
  const tot = (xs, k) => xs.filter((f) => f.kind === k).reduce((t, f) => t + f.amount, 0);
  const inc = tot(mf, "in"), out = tot(mf, "out"), bal = inc - out, m = mask();
  const tile = (k, v, cls = "", sub = "") => `<div class="stat ${cls}"><span>${k}</span><b class="${m}">${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  // average balance over the last 6 months that have any entries
  const months = new Map();
  all.forEach((f) => months.set(f.date.slice(0, 7), (months.get(f.date.slice(0, 7)) || 0) + (f.kind === "in" ? f.amount : -f.amount)));
  const recent = [...months.entries()].sort().slice(-6).map(([, v]) => v);
  const avg = recent.length >= 2 ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
  $("flow-sum").innerHTML =
    tile("收入", money(inc), "up") + tile("支出", money(out), "down") +
    tile("結餘", money(bal), bal >= 0 ? "up" : "down") +
    tile("儲蓄率", inc > 0 ? ((bal / inc) * 100).toFixed(1) + "%" : "—") +
    (avg !== null ? tile(`近 ${recent.length} 個月平均結餘`, money(avg), avg >= 0 ? "up" : "down", "僅計有記帳的月份") : "");

  const byCat = {};
  mf.filter((f) => f.kind === "out").forEach((f) => (byCat[f.category] = (byCat[f.category] || 0) + f.amount));
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  $("flow-cats").innerHTML = cats.length
    ? cats.map(([c, v], i) => `<div class="bar-row"><span>${esc(c)}</span>
        <span class="bar-track"><span class="bar-fill" style="display:block;width:${(v / out) * 100}%;background:${COLORS[i % COLORS.length]}"></span></span>
        <span class="${m}">${fmt0.format(v)} <span class="muted">${((v / out) * 100).toFixed(0)}%</span></span></div>`).join("")
    : '<p class="muted">這個月還沒有支出記錄。</p>';

  const list = [...mf].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  $("flow-count").textContent = `(${list.length})`;
  $("flow-list").innerHTML = list.length
    ? list.map((f) => `<div class="frow"><span class="muted">${esc(f.date.slice(5))}</span>
        <span class="tag">${esc(f.category)}</span><span class="note-t">${esc(f.note)}</span>
        <span class="amt ${f.kind === "in" ? "pos" : "neg"} ${m}">${f.kind === "in" ? "+" : "−"}${fmt0.format(f.amount)}</span>
        <button class="link danger" data-delflow="${f.id}">刪除</button></div>`).join("")
    : '<p class="muted">沒有記錄，按右上角「記一筆」開始記帳。</p>';
}
/* ---------- monthly report ---------- */
const lastDayOf = (ym) => { const [y, m] = ym.split("-").map(Number); return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`; };

// What happened to one holding in a month (average-cost replay, original currency).
function monthTrades(a, ym) {
  const r = { buy: 0, sell: 0, div: 0, realized: 0 };
  let q = 0, c = 0;
  [...a.txs].sort((x, y) => x.date.localeCompare(y.date)).forEach((t) => {
    const inM = t.date.startsWith(ym);
    if (t.kind === "buy") {
      q += t.units; c += t.units * t.price + t.fee;
      if (inM) r.buy += t.units * t.price + t.fee;
    } else if (t.kind === "sell") {
      const avg = q > 0 ? c / q : 0, sold = Math.min(t.units, q);
      if (inM) { r.sell += t.units * t.price - t.fee; r.realized += sold * t.price - t.fee - sold * avg; }
      c -= sold * avg; q -= sold;
    } else if (t.kind === "div" && inM) r.div += t.price;
  });
  return r;
}

function renderReport() {
  const ym = ui.rm, first = ym + "-01", last = lastDayOf(ym), thisYm = todayStr().slice(0, 7), cur = ym === thisYm, m = mask();
  $("rm-label").textContent = ym.replace("-", " 年 ") + " 月";
  $("rm-next").disabled = ym >= thisYm;
  const tile = (k, v, cls = "", sub = "") => `<div class="stat ${cls}"><span>${k}</span><b class="${m}">${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;

  // net worth at the start and end of the month
  const nw = (s) => s.assets - s.liabilities;
  const snaps = data.snapshots, before = snaps.filter((s) => s.date < first).at(-1), inMonth = snaps.filter((s) => s.date.startsWith(ym));
  const netNow = sum(data.assets.filter((a) => !a.liability)) - sum(data.assets.filter((a) => a.liability));
  const startV = before ? nw(before) : inMonth.length ? nw(inMonth[0]) : null;
  const endV = cur ? netNow : inMonth.length ? nw(inMonth.at(-1)) : before ? nw(before) : null;
  const flows = (data.cashflow || []).filter((f) => f.date.startsWith(ym));
  const inc = flows.filter((f) => f.kind === "in").reduce((t, f) => t + f.amount, 0), out = flows.filter((f) => f.kind === "out").reduce((t, f) => t + f.amount, 0);

  let tiles = "", note = "";
  if (startV === null || endV === null) note = "這個月沒有資產紀錄（MoneyPi 每天開啟時會記錄一次淨資產）。";
  else {
    const d = endV - startV;
    tiles += tile(before ? "月初淨資產" : "起算淨資產", money(startV)) + tile(cur ? "目前淨資產" : "月底淨資產", money(endV)) +
      tile("本月變動", `${signed(d)}`, d >= 0 ? "up" : "down", startV ? `${signed((d / Math.abs(startV)) * 100, fmt)}%` : "");
    if (!before) note = `資產紀錄從 ${inMonth[0].date} 才開始，所以以這天作為起點。`;
  }
  if (flows.length) {
    tiles += tile("記帳收入", money(inc), "up") + tile("記帳支出", money(out), "down") + tile("記帳結餘", money(inc - out), inc - out >= 0 ? "up" : "down");
    if (startV !== null && endV !== null) {
      const est = endV - startV - (inc - out);
      tiles += tile("估計投資與其他變動", signed(est), est >= 0 ? "up" : "down", "淨資產變動 − 記帳結餘");
    }
  } else if (startV !== null) note += (note ? " " : "") + "這個月沒有記帳資料；到「記帳」記錄收支，月報就能算出存了多少、投資賺賠多少。";
  $("rp-sum").innerHTML = tiles;
  $("rp-note").textContent = note;

  // investments
  const rows = data.assets.filter((a) => a.holding).map((a) => ({ a, t: monthTrades(a, ym), f: rate(a.currency) }))
    .filter(({ t }) => t.buy || t.sell || t.div);
  const tot = rows.reduce((s, { t, f }) => ({ buy: s.buy + t.buy * f, sell: s.sell + t.sell * f, div: s.div + t.div * f, realized: s.realized + t.realized * f }), { buy: 0, sell: 0, div: 0, realized: 0 });
  const unreal = data.assets.filter((a) => a.holding && a.cost > 0 && a.quantity > 0).reduce((s, a) => s + (a.value - a.cost) * rate(a.currency), 0);
  $("rp-inv").innerHTML = (rows.length
    ? `<table class="rp-tbl"><thead><tr><th>標的</th><th>買入</th><th>賣出</th><th>已實現損益</th><th>配息</th></tr></thead><tbody>${rows.map(({ a, t, f }) =>
      `<tr><td>${esc(a.name)}</td><td class="${m}">${t.buy ? fmt0.format(t.buy * f) : "—"}</td><td class="${m}">${t.sell ? fmt0.format(t.sell * f) : "—"}</td>
        <td class="${m} ${t.sell ? (t.realized >= 0 ? "pos" : "neg") : ""}">${t.sell ? signed(t.realized * f) : "—"}</td><td class="${m}">${t.div ? fmt0.format(t.div * f) : "—"}</td></tr>`).join("")}
      <tr><td><b>合計（TWD）</b></td><td class="${m}"><b>${fmt0.format(tot.buy)}</b></td><td class="${m}"><b>${fmt0.format(tot.sell)}</b></td><td class="${m}"><b>${tot.sell ? signed(tot.realized) : "—"}</b></td><td class="${m}"><b>${fmt0.format(tot.div)}</b></td></tr></tbody></table>`
    : '<p class="muted">這個月沒有買賣或配息記錄。</p>')
    + (cur && data.assets.some((a) => a.holding && a.cost > 0) ? `<p class="hint">目前所有持倉的未實現損益：<b class="${unreal >= 0 ? "pos" : "neg"} ${m}">${signed(unreal)} TWD</b>（金額以目前匯率折算，買入含手續費）</p>` : "");

  // goals
  const goalAt = (g, date) => g.history.filter((p) => p.date <= date).at(-1);
  $("rp-goals").innerHTML = data.goals.length ? data.goals.map((g) => {
    const info = goalInfo(g);
    const endVal = cur ? info.cur : goalAt(g, last)?.value ?? null;
    const s0 = g.history.filter((p) => p.date < first).at(-1) || g.history.find((p) => p.date.startsWith(ym));
    const delta = endVal !== null && s0 ? endVal - s0.value : null;
    const pct = endVal === null ? null : Math.max(0, (endVal / g.amount) * 100);
    let extra = "";
    if (cur && !info.done) {
      extra = info.eta === "資料不足" ? "預估達成時間：資料不足，需要再累積幾天的紀錄。" : `預估 ${info.eta}${info.etaSub ? "（" + info.etaSub + "）" : ""} 達成。`;
      if (g.date) extra += info.late ? " 已超過目標日期。" : info.need !== undefined ? ` 距目標日期還有 ${info.leftText}，每月需增加約 ${fmt0.format(info.need)}${info.ahead === undefined ? "" : info.ahead ? "，目前速度趕得上" : "，目前速度會落後"}。` : "";
    }
    return `<div class="rp-goal"><div class="top"><b>${esc(g.icon)} ${esc(g.name)}</b><span class="${m}">${endVal === null ? "—" : `${fmt0.format(endVal)} / ${fmt0.format(g.amount)}（${pct.toFixed(1)}%）`}</span></div>
      <div class="progress"><div style="width:${Math.min(100, pct || 0)}%"></div></div>
      <small class="muted ${m}">${delta === null ? "本月沒有可比較的紀錄" : `本月 ${signed(delta)}`}${extra ? "　" + esc(extra) : ""}</small></div>`;
  }).join("") : '<p class="muted">還沒有目標。到「總覽」新增目標後，這裡會顯示每月進度。</p>';

  // spending
  const byCat = {};
  flows.filter((f) => f.kind === "out").forEach((f) => (byCat[f.category] = (byCat[f.category] || 0) + f.amount));
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 5);
  $("rp-cats").innerHTML = cats.length ? cats.map(([c, v], i) => `<div class="bar-row"><span>${esc(c)}</span>
      <span class="bar-track"><span class="bar-fill" style="display:block;width:${(v / out) * 100}%;background:${COLORS[i % COLORS.length]}"></span></span>
      <span class="${m}">${fmt0.format(v)} <span class="muted">${((v / out) * 100).toFixed(0)}%</span></span></div>`).join("") : '<p class="muted">這個月沒有支出記錄。</p>';
}
$("rm-prev").onclick = () => { ui.rm = shiftMonth(ui.rm, -1); renderReport(); };
$("rm-next").onclick = () => { if (ui.rm < todayStr().slice(0, 7)) { ui.rm = shiftMonth(ui.rm, 1); renderReport(); } };

$("fm-prev").onclick = () => { ui.fm = shiftMonth(ui.fm, -1); renderFlow(); };
$("fm-next").onclick = () => { ui.fm = shiftMonth(ui.fm, 1); renderFlow(); };
$("flow-list").onclick = async (e) => {
  const b = e.target.closest("[data-delflow]");
  if (!b) return;
  const f = data.cashflow.find((x) => x.id === Number(b.dataset.delflow));
  if (f && (await confirmBox(`刪除這筆${f.kind === "in" ? "收入" : "支出"}？`, `${f.date} ${f.category} ${fmt0.format(f.amount)}`))) {
    try { data = await invoke("delete_flow", { id: f.id }); render(); toast("已刪除"); } catch (err) { toast(String(err)); }
  }
};

const fdlg = $("fdlg"), fform = $("fform"), ffCat = new Dropdown($("ff-cat"));
let flowKind = "out";
function setFlowKind(k) {
  flowKind = k;
  [...$("f-kind").children].forEach((b) => b.classList.toggle("on", b.dataset.k === k));
  ffCat.setOptions(FLOW_CATS[k], FLOW_CATS[k][0]);
}
$("f-kind").onclick = (e) => { const b = e.target.closest("button"); if (b) setFlowKind(b.dataset.k); };
$("flow-add").onclick = () => {
  fform.reset();
  $("ferr").textContent = "";
  setFlowKind("out");
  fform.date.value = ui.fm === todayStr().slice(0, 7) ? todayStr() : ui.fm + "-01";
  fdlg.showModal();
  fform.amount.focus();
};
fform.onsubmit = async (e) => {
  e.preventDefault();
  try {
    data = await invoke("add_flow", {
      flow: { id: 0, date: fform.date.value.trim(), kind: flowKind, category: ffCat.value, amount: num(fform.amount.value), note: fform.note.value.trim() },
    });
    ui.fm = fform.date.value.trim().slice(0, 7);
    fdlg.close();
    render();
    toast("已記一筆");
  } catch (err) {
    $("ferr").textContent = String(err);
  }
};

/* ---------- full backup / restore ---------- */
$("backup-btn").onclick = async () => {
  try {
    const txt = await invoke("export_backup");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([txt], { type: "application/json;charset=utf-8" }));
    a.download = `moneypi-backup-${todayStr()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("已匯出備份");
  } catch (err) { toast("備份失敗：" + err); }
};
$("restore-btn").onclick = () => $("restore-file").click();
$("restore-file").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  if (!(await confirmBox("還原備份？", "將以備份內容取代目前所有資料（原資料會自動另存為 moneypi.before-restore.json）", "還原"))) return;
  try {
    const text = await f.text();
    let password, again = "";
    for (;;) {
      try { data = await invoke("import_backup", { text, password }); break; }
      catch (err) {
        if (String(err) !== "ENCRYPTED" && !String(err).includes("密碼錯誤")) throw err;
        password = await askPassword("這是加密的備份", "請輸入建立這份備份時的密碼。", { err: String(err) === "ENCRYPTED" ? "" : again });
        if (password === null) return;
        again = "密碼錯誤，請再試一次";
      }
    }
    ui.sel = null;
    render();
    toast("已還原備份");
  } catch (err) { toast("還原失敗：" + err); }
};

/* ---------- phone / LAN connection (desktop only) ---------- */
const phdlg = $("phdlg");

function showPhone(i) {
  $("sync-on").checked = i.enabled;
  $("sync-port").value = i.port;
  $("sync-pin").value = i.pin;
  $("ph-conn").hidden = !i.running;
  $("ph-qr").innerHTML = i.qr || "";
  $("ph-urls").innerHTML = i.urls.length
    ? i.urls.map((u) => `<div class="url">${esc(u)}</div>`).join("")
    : '<p class="muted">找不到區網位址，請確認電腦已連上 Wi-Fi 或網路。</p>';
  $("ph-status").textContent = i.running ? "● 服務執行中" : i.enabled ? "服務未能啟動（連接埠可能被占用，請換一個）" : "未啟用";
  $("ph-status").className = "hint " + (i.running ? "pos" : "");
  $("phone-btn").classList.toggle("live-lan", i.running);
  $("phone-btn").classList.toggle("live", i.running || $("phone-btn").classList.contains("live-tunnel"));
}
$("phone-btn").onclick = async () => {
  $("pherr").textContent = "";
  $("ph-tips").hidden = true;
  setPhTab("lan");
  phdlg.showModal();
  try { showPhone(await invoke("get_sync")); } catch (err) { $("pherr").textContent = String(err); }
};

/* ---- remote access through a Cloudflare quick tunnel ---- */
function setPhTab(t) {
  [...$("ph-tabs").children].forEach((b) => b.classList.toggle("on", b.dataset.t === t));
  $("ph-lan").hidden = t !== "lan";
  $("ph-remote").hidden = t !== "remote";
  $("ph-apply").hidden = t !== "lan";
  $("pherr").textContent = "";
  if (t === "remote") refreshTunnel();
}
$("ph-tabs").onclick = (e) => { const b = e.target.closest("button"); if (b) setPhTab(b.dataset.t); };

const INSTALL_NOTE = "需要 Cloudflare 的 cloudflared 工具（約 55 MB）。只從官方發布頁下載，並核對官方公布的校驗碼，通過才會安裝；安裝在 MoneyPi 自己的資料夾，不需要系統管理員權限。";
let tunnelLink = "";
async function copyText(t) {
  try {
    // writeText can wait forever when the window has no focus, so give it a deadline
    const ok = await Promise.race([navigator.clipboard.writeText(t).then(() => true), new Promise((r) => setTimeout(() => r(false), 1500))]);
    if (ok) return true;
  } catch {}
  const ta = Object.assign(document.createElement("textarea"), { value: t });
  document.body.appendChild(ta); ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok;
}
function renderTunnel(s, busy = "") {
  tunnelLink = s.link || "";
  $("phone-btn").classList.toggle("live-tunnel", !!s.running);
  $("phone-btn").classList.toggle("live", !!s.running || $("phone-btn").classList.contains("live-lan"));
  const b = $("rm-body");
  if (busy) { b.innerHTML = `<p class="hint">${esc(busy)}</p>`; return; }
  if (!s.installed) {
    b.innerHTML = `<p class="hint">${INSTALL_NOTE}</p><button type="button" class="primary" id="rm-install">安裝 cloudflared</button>`;
  } else if (!s.running) {
    b.innerHTML = `<button type="button" class="primary" id="rm-start">開啟遠端連線</button>
      <p class="hint">每次開啟都會產生新的網址與一次性密鑰，關閉或結束 MoneyPi 後網址立即失效。資料會經過 Cloudflare 的伺服器（到 Cloudflare 為 HTTPS 加密），請只在你能接受的情況下使用。</p>`;
  } else {
    b.innerHTML = `<p class="hint pos">● 遠端連線已開啟</p>
      <div class="conn"><div class="qr">${s.qr || ""}</div><div class="conn-t">
        <p class="muted">用手機相機掃描 QR Code（行動數據即可）。</p>
        <div class="url">${esc(s.url)}</div>
        <p class="hint">只輸入上面的網址<b>不能</b>連線，因為少了密鑰。請掃描 QR Code，或按「複製連結」傳給自己（例如 LINE 記事本）再用手機開啟。連結內含這次連線專用的密鑰，請勿分享給別人。</p></div></div>
      <div class="btnrow"><button type="button" id="rm-copy">複製連結</button><button type="button" class="danger" id="rm-stop">關閉遠端連線</button></div>`;
  }
}
async function refreshTunnel() {
  try {
    if (installing) return;
    if (inTauri && (await invoke("tunnel_progress")).active) return runInstall("direct", true);
    renderTunnel(await invoke("tunnel_status"));
  } catch (err) { $("pherr").textContent = String(err); }
}
const mb = (n) => (n / 1048576).toFixed(1);
function renderProgress(p, method) {
  const b = $("rm-body");
  if (!$("pg-bar")) {
    b.innerHTML = `<div class="prog"><b>${method === "winget" ? "正在用 winget 安裝 cloudflared" : "正在下載並安裝 cloudflared"}</b>
      <div class="pgbar"><i id="pg-bar"></i></div><p class="hint" id="pg-txt"></p>
      <p class="hint">請不要關閉 MoneyPi，完成後會自動顯示下一步。</p></div>`;
  }
  const known = p.total > 0 && p.done > 0 && p.stage === "下載中";
  const bar = $("pg-bar");
  bar.classList.toggle("ind", !known);
  bar.style.width = known ? Math.min(100, (p.done / p.total) * 100).toFixed(1) + "%" : "";
  $("pg-txt").textContent = known
    ? `下載中　${mb(p.done)} / ${mb(p.total)} MB（${Math.floor((p.done / p.total) * 100)}%）`
    : p.stage || "準備中…";
}

let installing = false;
// attach = only watch an installation that is already running (e.g. the dialog was reopened)
async function runInstall(method = "direct", attach = false) {
  if (installing) return false;
  installing = true;
  renderProgress({ stage: "準備中…", done: 0, total: 0 }, method);
  const poll = setInterval(async () => {
    try { renderProgress(await invoke("tunnel_progress"), method); } catch {}
  }, 250);
  try {
    let s;
    if (attach) {
      do { await new Promise((r) => setTimeout(r, 400)); } while ((await invoke("tunnel_progress")).active);
      s = await invoke("tunnel_status");
      if (!s.installed) throw new Error("安裝沒有完成");
    } else s = await invoke("tunnel_install", { method });
    clearInterval(poll);
    renderTunnel(s);
    toast("cloudflared 已安裝，可以開啟遠端連線了");
    return true;
  } catch (err) {
    clearInterval(poll);
    await renderInstallFail(String(err));
    return false;
  } finally {
    installing = false;
  }
}

// Install failed: offer retry, winget (only if this PC has it) or a do-it-yourself guide.
async function renderInstallFail(err) {
  let s = {};
  try { s = await invoke("tunnel_status"); } catch {}
  $("rm-body").innerHTML = `<p class="neg">安裝沒有成功：${esc(err)}</p>
    <div class="guide">
      <b>可以這樣處理</b>
      <div class="btnrow"><button type="button" class="primary" id="rm-retry">重試</button>
        ${s.winget ? '<button type="button" id="rm-winget">改用 winget 安裝</button>' : ""}</div>
      ${s.winget ? "" : '<p class="hint">這台電腦沒有 winget（Windows 內建的安裝工具），所以請自行下載：</p>'}
      <p class="hint">自己安裝只要 3 步：</p>
      <ol class="steps">
        <li>按「開啟下載頁」，下載 <code>cloudflared-windows-amd64.exe</code></li>
        <li>把它改名為 <code>cloudflared.exe</code>，放到這個資料夾（沒有就自己建立）：<div class="url">${esc(s.bin_dir || "")}</div></li>
        <li>回到這裡按「重新偵測」</li>
      </ol>
      <div class="btnrow"><button type="button" id="rm-open">開啟下載頁</button><button type="button" id="rm-detect">重新偵測</button></div>
    </div>`;
}

async function installCloudflared() {
  if (!(await confirmBox("安裝 cloudflared？", INSTALL_NOTE, "安裝"))) return false;
  return runInstall("direct");
}
$("rm-body").onclick = async (e) => {
  const id = e.target.closest("button")?.id;
  $("pherr").textContent = "";
  try {
    if (id === "rm-install") await installCloudflared();
    else if (id === "rm-retry") await runInstall("direct");
    else if (id === "rm-winget") await runInstall("winget");
    else if (id === "rm-open") await invoke("open_external", { target: "releases" });
    else if (id === "rm-detect") {
      const s = await invoke("tunnel_status");
      if (s.installed) { renderTunnel(s); toast("已偵測到 cloudflared"); } else $("pherr").textContent = "還沒找到 cloudflared，請確認檔名是 cloudflared.exe 且放在上面的資料夾";
    }
    else if (id === "rm-start") {
      renderTunnel({}, "正在建立遠端連線（約數秒）…");
      renderTunnel(await invoke("tunnel_start"));
    } else if (id === "rm-stop") renderTunnel(await invoke("tunnel_stop"));
    else if (id === "rm-copy") toast((await copyText(tunnelLink)) ? "已複製連結（含密鑰，請勿分享）" : "複製失敗，請改用 QR Code");
  } catch (err) {
    $("pherr").textContent = String(err);
    refreshTunnel();
  }
};

// after installing MoneyPi, offer once to set up remote access (declining is fine; it can be done later)
async function offerRemoteInstall() {
  if (!inTauri || store.get("remote_prompted", "0") === "1") return;
  if (document.querySelector("dialog[open]") || $("tour").matches(":popover-open")) return setTimeout(offerRemoteInstall, 30000);
  try {
    const s = await invoke("tunnel_status");
    store.set("remote_prompted", "1");
    if (s.installed) return;
    if (await confirmBox("要啟用遠端連線功能嗎？", "遠端連線讓你不用同一個 Wi-Fi，在外面也能用手機連回這台電腦。需要下載 Cloudflare 的 cloudflared 工具（約 55 MB，官方來源並核對校驗碼）。不安裝也能正常使用 MoneyPi，之後隨時可以在「手機連線 → 遠端」補裝。", "安裝")) {
      $("phone-btn").click(); // show the installation where the user can follow it
      setPhTab("remote");
      await runInstall("direct");
    }
  } catch (err) { toast("無法開始安裝：" + err); }
}
$("ph-tips-btn").onclick = () => ($("ph-tips").hidden = !$("ph-tips").hidden);
$("phform").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const on = $("sync-on").checked, port = parseInt($("sync-port").value, 10) || 8787;
    let pin = $("sync-pin").value.trim();
    if (on && !pin) pin = String(Math.floor(100000 + Math.random() * 900000));
    showPhone(await invoke("set_sync", { enabled: on, port, pin }));
    $("pherr").textContent = "";
    toast(on ? "手機連線已啟用" : "手機連線已關閉");
  } catch (err) {
    $("pherr").textContent = String(err);
  }
};

/* ---------- custom form validation (replaces the browser's native "please fill out" bubble) ---------- */
document.querySelectorAll("form").forEach((f) => (f.noValidate = true));

function fieldName(el) {
  const lab = el.closest("label");
  const text = lab
    ? [...lab.childNodes].filter((n) => n.nodeType === 3 || (n.nodeType === 1 && n.tagName === "SPAN" && !n.classList.contains("box"))).map((n) => n.textContent).join("")
    : el.placeholder || "";
  return text.replace(/（.*?）|\(.*?\)/g, "").trim() || "此欄位";
}
function problem(el) {
  const v = el.validity;
  if (v.valid) return "";
  const n = fieldName(el);
  if (v.valueMissing) return `請填寫「${n}」`;
  if (v.rangeUnderflow) return `「${n}」不可小於 ${el.min}`;
  if (v.rangeOverflow) return `「${n}」不可大於 ${el.max}`;
  if (v.badInput) return `「${n}」請輸入數字`;
  return `「${n}」格式不正確`;
}
function clearInvalid(form) {
  form.querySelectorAll(".field-err").forEach((x) => x.remove());
  form.querySelectorAll(".invalid").forEach((x) => x.classList.remove("invalid"));
}
// capture phase: runs before each form's own submit handler, and stops it when something is wrong
document.addEventListener("submit", (e) => {
  const form = e.target;
  clearInvalid(form);
  for (const el of form.querySelectorAll("input, textarea")) {
    if (el.disabled || el.closest("[hidden]") || el.type === "checkbox" || el.type === "file") continue;
    const msg = problem(el);
    if (!msg) continue;
    e.preventDefault();
    e.stopImmediatePropagation();
    el.classList.add("invalid");
    const m = document.createElement("div");
    m.className = "field-err";
    m.textContent = msg;
    (el.closest("label") || el.parentElement).appendChild(m);
    el.focus();
    return;
  }
}, true);
document.addEventListener("input", (e) => {
  if (!e.target.classList || !e.target.classList.contains("invalid")) return;
  e.target.classList.remove("invalid");
  (e.target.closest("label") || e.target.parentElement).querySelector(".field-err")?.remove();
});

/* ---------- boot ---------- */
document.querySelectorAll(".desk-only").forEach((el) => (el.hidden = !inTauri));
async function boot() {
  const st = await invoke("lock_status");
  $("lock-btn").hidden = !(inTauri && st.encrypted);
  if (st.locked) {
    if (!inTauri) {
      document.body.innerHTML = '<p style="margin:40px 20px;font:16px sans-serif">電腦上的 MoneyPi 已鎖定。請先在電腦輸入密碼解鎖，再重新整理這個頁面。</p>';
      return;
    }
    await unlockFlow();
  }
  data = await invoke("get_data");
  render();
  scheduleRefresh();
  if (inTauri && data.refresh_min > 0) doRefresh(false);
  runPlans(false).then(() => runDividends(false));
  setInterval(() => runPlans(false).then(() => runDividends(false)), 3600e3);
  if (store.get("toured", "0") !== "1") setTimeout(startTour, 1200);
}
boot().catch((err) => toast(String(err)));
if (inTauri) {
  invoke("get_sync").then(showPhone).catch(() => {});
  setTimeout(() => checkUpdate(false), 4000);
  setTimeout(offerRemoteInstall, 9000);
  setInterval(() => checkUpdate(false), 6 * 3600 * 1000);
}
