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
      token = await askPin(token ? "PIN 錯誤，請重新輸入" : "");
      store.set("token", token);
      continue;
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw j.error || "錯誤 " + r.status;
    return j;
  }
}

function askPin(msg) {
  const d = $("pdlg");
  if (msg) $("perr").textContent = msg;
  $("pform").pin.value = "";
  d.oncancel = (e) => e.preventDefault();
  return new Promise((res) => {
    d.addEventListener("close", () => res($("pform").pin.value.trim()), { once: true });
    if (!d.open) d.showModal();
  });
}

let data = { assets: [], snapshots: [], rates: { TWD: 1 }, goal: 0, goal_date: "", refresh_min: 0 };
const ui = {
  kind: "all", cat: "", q: "", sort: "value", range: 0, sel: null, hover: -1,
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
  t.hidden = false;
  clearTimeout(toast.id);
  toast.id = setTimeout(() => (t.hidden = true), 3200);
}

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
$("hide-btn").onclick = () => {
  ui.hidden = !ui.hidden;
  store.set("hidden", ui.hidden ? "1" : "0");
  render();
};

/* ---------- goal projection ---------- */
const DAY = 864e5, MONTH_DAYS = 30.44;

function fmtDuration(days) {
  if (days < 45) return `約 ${Math.max(1, Math.ceil(days))} 天`;
  const tm = Math.round(days / MONTH_DAYS), y = Math.floor(tm / 12), m = tm % 12;
  if (y > 100) return "超過 100 年";
  return "約 " + [y ? `${y} 年` : "", m ? `${m} 個月` : ""].filter(Boolean).join(" ");
}
const dateStr = (ms) => new Date(ms).toLocaleDateString("sv-SE");

/** Least-squares trend of net worth over the last 180 days of snapshots → growth per day. */
function projection() {
  const pts = data.snapshots.map((s) => ({ t: Date.parse(s.date + "T00:00:00Z") / DAY, v: s.assets - s.liabilities }));
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

function renderGoalPanel(net) {
  const el = $("goal-panel");
  if (!(data.goal > 0)) {
    el.innerHTML = `<div class="panel-head"><h3>目標預測</h3><button class="link" data-goal-edit>設定目標</button></div>
      <p class="muted">設定淨資產目標後，會依你近期的資產成長速度，自動推算還要多久才能達成。</p>`;
    return;
  }
  const p = projection(), goal = data.goal, left = goal - net;
  let eta, etaSub = "";
  if (left <= 0) eta = "🎉 已達成";
  else if (p.slope === null) { eta = "資料不足"; etaSub = "需累積至少 3 天、2 筆以上的記錄"; }
  else if (p.slope <= 0) { eta = "目前無法預估"; etaSub = "近期資產沒有成長"; }
  else {
    const days = left / p.slope;
    eta = days / 365 > 100 ? "超過 100 年" : dateStr(Date.now() + days * DAY);
    etaSub = fmtDuration(days);
  }
  // [label, value, sub, masked?]
  const tiles = [
    ["目標", money(goal), "", true],
    ["目前淨資產", money(net), left > 0 ? `還差 ${ui.hidden ? "••••" : fmt0.format(left)}` : "", true],
    ["近期成長速度", p.slope === null ? "—" : `${ui.hidden ? "••••" : signed(p.monthly)} / 月`, p.slope === null ? "" : `依近 ${Math.round(p.span)} 天、${p.n} 筆記錄`, true],
    ["預計達成", eta, etaSub, false],
  ];
  let tail = "";
  if (data.goal_date) {
    const monthsLeft = (Date.parse(data.goal_date + "T00:00:00") - Date.now()) / DAY / MONTH_DAYS;
    if (left > 0 && monthsLeft <= 0) tiles.push(["目標日期", data.goal_date, "已逾期", false]);
    else if (left > 0) {
      const need = left / monthsLeft;
      tiles.push(["目標日期", data.goal_date, `剩 ${fmtDuration(monthsLeft * MONTH_DAYS).replace("約 ", "")}`, false]);
      tiles.push(["需每月成長", ui.hidden ? "••••" : fmt0.format(need), "", true]);
      if (p.slope !== null) {
        const ok = p.monthly >= need;
        tail = `<div class="stat ${ok ? "up" : "down"}"><span>目前進度</span><b>${ok ? "超前" : "落後"}</b><small>${ui.hidden ? "" : `每月${ok ? "多" : "少"} ${fmt0.format(Math.abs(p.monthly - need))}`}</small></div>`;
      }
    } else tiles.push(["目標日期", data.goal_date, "", false]);
  }
  el.innerHTML = `<div class="panel-head"><h3>目標預測</h3><button class="link" data-goal-edit>調整目標</button></div>
    <div class="stats">${tiles.map(([k, v, s, m]) => `<div class="stat"><span>${k}</span><b class="${m ? mask() : ""}">${esc(v)}</b>${s ? `<small>${esc(s)}</small>` : ""}</div>`).join("")}${tail}</div>
    <p class="note">以近 180 天淨資產記錄做線性趨勢估算（含股價漲跌），僅供參考。</p>`;
}
$("goal-panel").onclick = (e) => e.target.closest("[data-goal-edit]") && openSettings();

/* ---------- render ---------- */
function render() {
  if (ui.sel && !data.assets.some((a) => a.id === ui.sel)) ui.sel = null;
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

  if (data.goal > 0) {
    $("goal-pct").textContent = ((net / data.goal) * 100).toFixed(1) + "%";
    $("goal-bar").style.width = Math.max(0, Math.min(1, net / data.goal)) * 100 + "%";
    $("goal-text").textContent = net >= data.goal ? "🎉 已達成目標" : ui.hidden ? "" : `還差 ${fmt0.format(data.goal - net)}`;
  } else {
    $("goal-pct").textContent = "—";
    $("goal-bar").style.width = "0";
    $("goal-text").textContent = "到「設定」設定淨資產目標";
  }
  renderGoalPanel(net);

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
        <td class="muted">${esc(t.note)}</td>
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
  const a = data.assets.find((x) => x.id === ui.sel);
  $("view-overview").hidden = !!a;
  $("view-detail").hidden = !a;
  $("title").textContent = a ? a.name : "總覽";
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
}
new ResizeObserver(drawCharts).observe($("trend"));

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
  if (data.goal > 0 && data.goal <= max * 1.6 && all.length > 1) max = Math.max(max, data.goal);
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
  if (data.goal > 0 && data.goal >= min && data.goal <= max) { // goal line
    g.setLineDash([5, 4]); g.strokeStyle = "#3ecf8e"; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(padL, y(data.goal)); g.lineTo(W - padR, y(data.goal)); g.stroke();
    g.setLineDash([]); g.fillStyle = "#12935a"; g.textAlign = "right";
    g.fillText("目標", W - padR, y(data.goal) - 4);
    g.textAlign = "left";
  }
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
function confirmBox(msg, sub = "") {
  const d = $("cdlg");
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
  const div = tKind.value === "div";
  $("t-units-wrap").hidden = $("t-fee-wrap").hidden = div;
  $("t-price-label").textContent = div ? "配息總額" : "單價／淨值";
}

function openTx(a) {
  txAsset = a;
  tform.reset();
  $("terr").textContent = "";
  $("tdlg-title").textContent = `記錄交易 · ${a.name}`;
  tKind.setValue("buy");
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
      },
    });
    tdlg.close();
    render();
    toast("已記錄交易");
  } catch (err) {
    $("terr").textContent = String(err);
  }
};

/* ---------- settings dialog ---------- */
const sdlg = $("sdlg"), sform = $("sform");
let refreshSel = 0, syncLoaded = null;

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

function showSyncInfo(i) {
  syncLoaded = i;
  $("sync-on").checked = i.enabled;
  $("sync-port").value = i.port;
  $("sync-pin").value = i.pin;
  $("sync-info").textContent = i.running && i.urls.length
    ? `服務執行中。手機瀏覽器開啟 ${i.urls.join("、")}，輸入 PIN 即可。連線為區網 HTTP（未加密），請只在可信任的網路使用。`
    : "未啟動。";
}

async function openSettings() {
  sform.goal.value = data.goal || "";
  sform.goal_date.value = data.goal_date || "";
  setRefreshSeg(data.refresh_min || 0);
  $("rates").innerHTML = Object.entries(data.rates).map(([c, r]) => rateRow(c, r)).join("");
  $("new-code").value = $("new-rate").value = "";
  $("serr").textContent = "";
  sdlg.showModal();
  if (inTauri) {
    try {
      $("ver").textContent = "目前版本 v" + (await window.__TAURI__.core.invoke("app_version"));
      showSyncInfo(await invoke("get_sync"));
    } catch (e) { $("sync-info").textContent = String(e); }
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
    if (inTauri && syncLoaded) {
      const on = $("sync-on").checked, port = parseInt($("sync-port").value, 10) || 8787;
      let pin = $("sync-pin").value.trim();
      if (on && !pin) pin = String(Math.floor(100000 + Math.random() * 900000));
      if (on !== syncLoaded.enabled || port !== syncLoaded.port || pin !== syncLoaded.pin) {
        showSyncInfo(await invoke("set_sync", { enabled: on, port, pin }));
      }
    }
    data = await invoke("set_settings", {
      rates, goal: num(sform.goal.value), goal_date: sform.goal_date.value.trim(), refresh_min: refreshSel,
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
async function checkUpdate(manual) {
  if (!inTauri) return;
  try {
    const u = await window.__TAURI__.core.invoke("check_update");
    if (u) {
      $("update-text").textContent = `發現新版本 v${u.version}`;
      $("update-bar").hidden = false;
      if (manual) toast(`發現新版本 v${u.version}`);
    } else if (manual) toast("目前已是最新版本");
  } catch (err) {
    if (manual) toast("檢查更新失敗：" + err);
  }
}
$("update-later").onclick = () => ($("update-bar").hidden = true);
$("update-now").onclick = async () => {
  $("update-now").disabled = true;
  $("update-text").textContent = "下載並安裝中，完成後會自動重新啟動…";
  try {
    await window.__TAURI__.core.invoke("install_update");
  } catch (err) {
    $("update-now").disabled = false;
    toast("更新失敗：" + err);
  }
};
$("upd-btn").onclick = () => checkUpdate(true);

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
  setTimeout(() => checkUpdate(false), 4000);
  setInterval(() => checkUpdate(false), 6 * 3600 * 1000);
}
