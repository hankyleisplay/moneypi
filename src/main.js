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
  kind: "all", cat: "", q: "", sort: "value", range: 0, sel: null, hover: -1, fm: new Date().toLocaleDateString("sv-SE").slice(0, 7),
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
const fMkt = new Dropdown($("f-mkt"), () => updateHoldHint());
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
    `<div class="stat ${cls}"><span>${k}</span><b class="${m}">${v}</b>${sub ? `<small class="${m}">${sub}</small>` : ""}</div>`;
  const tiles = [
    tile("持有數量", fmtQ.format(q)),
    tile("現價／淨值", `${cur} ${fmt.format(a.price)}`, "", a.market ? (a.price_updated ? `行情 ${esc(a.price_updated)}` : "尚未同步") : "手動"),
    tile("平均成本", hasCost ? `${cur} ${fmt.format(a.cost / q)}` : "—"),
    tile("總成本", a.cost > 0 ? `${cur} ${fmt0.format(a.cost)}` : "—"),
    hasCost ? tile("未實現損益", `${signed(unreal)} ${cur}`, unreal >= 0 ? "up" : "down", `${signed(pct, fmt)}%`) : "",
    a.txs.length ? tile("已實現損益", `${signed(a.realized)} ${cur}`, a.realized >= 0 ? "up" : "down") : "",
    a.dividends > 0 ? tile("累計配息", `${cur} ${fmt0.format(a.dividends)}`, "up") : "",
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
    <div class="sect"><h3>持倉</h3>
      <div class="btns">${a.market ? "<button data-sync>同步行情</button>" : ""}<button class="primary" data-addtx>＋ 記錄交易</button></div></div>
    <div class="stats">${tiles}</div>
  </div>
  <div class="glass detail">
    <div class="sect"><h3>交易記錄 <span class="muted">(${a.txs.length})</span></h3></div>
    ${a.txs.length
      ? `<div class="tx-wrap"><table class="tx"><thead><tr><th>日期</th><th>類型</th><th class="r">單位</th><th class="r">單價</th><th class="r">手續費</th><th class="r">金額</th><th>備註</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="muted">尚無交易記錄。記錄買入／賣出／配息後，數量、平均成本與損益會自動計算。</p>'}
  </div>`;
}

function renderView() {
  const a = typeof ui.sel === "number" ? data.assets.find((x) => x.id === ui.sel) : null;
  const flow = ui.sel === "flow";
  $("view-overview").hidden = !!a || flow;
  $("view-detail").hidden = !a;
  $("view-flow").hidden = !flow;
  $("title").textContent = a ? a.name : flow ? "記帳" : "總覽";
  if (flow) return renderFlow();
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
    <div class="stats">
      <div class="stat"><span>折合 TWD</span><b class="${mask()}">${sgn}${fmt0.format(toBase(a))}</b></div>
      <div class="stat"><span>佔總${a.liability ? "負債" : "資產"}</span><b>${share.toFixed(1)}%</b></div>
      <div class="stat"><span>匯率</span><b>${a.currency === "TWD" ? "—" : `1 ${esc(a.currency)} = ${fmt.format(rate(a.currency))} TWD`}</b></div>
      <div class="stat"><span>最後更新</span><b>${esc(a.updated)}</b></div>
      <div class="stat"><span>備註</span><b>${a.note ? esc(a.note) : "—"}</b></div>
    </div>
  </div>${a.holding ? holdingHtml(a) : ""}`;
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
  const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
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
    const sweep = (v / total) * Math.PI * 2, gap = items.length > 1 ? 0.03 : 0;
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
  syncHoldingUI();
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
      },
    });
    dlg.close();
    if (wasNew) ui.sel = Math.max(...data.assets.map((a) => a.id));
    render();
    toast(wasNew ? "已新增" : "已更新");
    if (market) doRefresh(false);
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
  syncTxUI();
  tdlg.showModal();
  tform.units.focus();
}

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
$("settings-btn").onclick = openSettings;
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
    data = await invoke("import_backup", { text: await f.text() });
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
  try { renderTunnel(await invoke("tunnel_status")); } catch (err) { $("pherr").textContent = String(err); }
}
async function installCloudflared() {
  if (!(await confirmBox("安裝 cloudflared？", INSTALL_NOTE, "安裝"))) return false;
  try {
    renderTunnel({}, "下載並驗證中（約 55 MB），請稍候…");
    renderTunnel(await invoke("tunnel_install"));
    toast("cloudflared 已安裝");
    return true;
  } catch (err) {
    $("pherr").textContent = "安裝失敗：" + err;
    refreshTunnel();
    return false;
  }
}
$("rm-body").onclick = async (e) => {
  const id = e.target.closest("button")?.id;
  $("pherr").textContent = "";
  try {
    if (id === "rm-install") await installCloudflared();
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
  if (document.querySelector("dialog[open]")) return setTimeout(offerRemoteInstall, 30000);
  try {
    const s = await invoke("tunnel_status");
    store.set("remote_prompted", "1");
    if (s.installed) return;
    if (await confirmBox("要啟用遠端連線功能嗎？", "遠端連線讓你不用同一個 Wi-Fi，在外面也能用手機連回這台電腦。需要下載 Cloudflare 的 cloudflared 工具（約 55 MB，官方來源並核對校驗碼）。不安裝也能正常使用 MoneyPi，之後隨時可以在「手機連線 → 遠端」補裝。", "安裝")) {
      toast("下載並驗證中…");
      await invoke("tunnel_install");
      toast("cloudflared 已安裝，可到「手機連線 → 遠端」開啟");
    }
  } catch (err) { toast("安裝失敗：" + err); }
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
invoke("get_data")
  .then((d) => {
    data = d;
    render();
    scheduleRefresh();
    if (inTauri && data.refresh_min > 0) doRefresh(false);
  })
  .catch((err) => toast(String(err)));
if (inTauri) {
  invoke("get_sync").then(showPhone).catch(() => {});
  setTimeout(() => checkUpdate(false), 4000);
  setTimeout(offerRemoteInstall, 9000);
  setInterval(() => checkUpdate(false), 6 * 3600 * 1000);
}
