const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 });
const fmt0 = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
const COLORS = ["#6aa5ff", "#3ecf8e", "#f5b83d", "#b57cf5", "#f472b6", "#2dc4b2", "#fb7185", "#94a3b8"];
const CATS = ["現金", "銀行存款", "股票", "基金/ETF", "加密貨幣", "不動產", "保險", "其他"];
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

let data = { assets: [], snapshots: [], rates: { TWD: 1 }, goal: 0 };
const ui = {
  kind: "all", cat: "", q: "", sort: "value", range: 0, sel: null, hover: -1,
  hidden: store.get("hidden", "0") === "1",
};

const rate = (cur) => data.rates[cur] ?? 1;
const toBase = (a) => a.value * rate(a.currency);
const money = (n) => (ui.hidden ? "NT$ ••••" : "NT$ " + fmt0.format(n));
const sum = (xs) => xs.reduce((s, a) => s + toBase(a), 0);
const mask = () => (ui.hidden ? "blur" : "");

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
  toast.id = setTimeout(() => (t.hidden = true), 2600);
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
fCat.setOptions(CATS, CATS[0]);

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
    d.textContent = ui.hidden ? "" : `較 ${prev.date}：${diff >= 0 ? "+" : "−"}${fmt0.format(Math.abs(diff))}`;
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
      (!q || `${a.name} ${a.note} ${a.category}`.toLowerCase().includes(q))
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
    .map(
      (a) => `<button class="item ${a.id === ui.sel ? "on" : ""}" data-id="${a.id}" title="${esc(a.name)}">
      <span class="av" style="background:${catColor(a.category)}">${esc([...a.name][0] || "?")}</span>
      <span class="meta"><b>${esc(a.name)}</b><small>${a.liability ? "負債 · " : ""}${esc(a.category)}${a.currency === "TWD" ? "" : " · " + esc(a.currency)}</small></span>
      <span class="amt ${a.liability ? "neg" : ""} ${mask()}">${a.liability ? "−" : ""}${fmt0.format(toBase(a))}</span>
    </button>`
    )
    .join("");
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
      <div class="who"><h2>${esc(a.name)}</h2><span class="tag ${a.liability ? "debt" : ""}">${a.liability ? "負債 · " : ""}${esc(a.category)}</span></div>
      <div class="d-actions"><button data-edit>編輯</button><button class="danger" data-del>刪除</button></div>
    </div>
    <div class="d-amount ${a.liability ? "neg" : ""} ${mask()}">${sgn}${esc(a.currency)} ${fmt.format(a.value)}</div>
    <div class="stats">
      <div class="stat"><span>折合 TWD</span><b class="${mask()}">${sgn}${fmt0.format(toBase(a))}</b></div>
      <div class="stat"><span>佔總${a.liability ? "負債" : "資產"}</span><b>${share.toFixed(1)}%</b></div>
      <div class="stat"><span>匯率</span><b>${a.currency === "TWD" ? "—" : `1 ${esc(a.currency)} = ${rate(a.currency)} TWD`}</b></div>
      <div class="stat"><span>最後更新</span><b>${esc(a.updated)}</b></div>
      <div class="stat"><span>備註</span><b>${a.note ? esc(a.note) : "—"}</b></div>
    </div>
  </div>`;
}

function select(id) {
  ui.sel = id;
  renderList();
  renderView();
  $("view-overview").parentElement.scrollTop = 0;
}
$("nav-overview").onclick = () => select(null);
$("list").onclick = (e) => {
  const b = e.target.closest(".item");
  if (b) select(Number(b.dataset.id));
};
$("view-detail").onclick = async (e) => {
  const a = data.assets.find((x) => x.id === ui.sel);
  if (!a) return;
  if (e.target.closest("[data-edit]")) openDialog(a);
  if (e.target.closest("[data-del]") && (await confirmBox(`刪除「${a.name}」？`, "刪除後無法復原"))) {
    data = await invoke("delete_asset", { id: a.id });
    ui.sel = null;
    render();
    toast("已刪除");
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
    const cut = new Date(Date.now() - ui.range * 864e5);
    const cutStr = `${cut.getFullYear()}-${String(cut.getMonth() + 1).padStart(2, "0")}-${String(cut.getDate()).padStart(2, "0")}`;
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

/* ---------- asset dialog ---------- */
const dlg = $("dlg"), form = $("form");
let editingId = 0;

function openDialog(asset) {
  editingId = asset ? asset.id : 0;
  $("dlg-title").textContent = asset ? "編輯項目" : "新增項目";
  form.reset();
  $("err").textContent = "";
  const cats = asset && !CATS.includes(asset.category) ? [...CATS, asset.category] : CATS;
  fCat.setOptions(cats, asset ? asset.category : CATS[0]);
  fCur.setOptions(Object.keys(data.rates), asset ? asset.currency : "TWD");
  if (asset) {
    form.name.value = asset.name;
    form.value.value = asset.value;
    form.liability.checked = asset.liability;
    form.note.value = asset.note;
  }
  dlg.showModal();
  form.name.focus();
}

document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => b.closest("dialog").close()));
$("add-btn").onclick = () => openDialog(null);

form.onsubmit = async (e) => {
  e.preventDefault();
  try {
    const wasNew = !editingId;
    data = await invoke("save_asset", {
      asset: {
        id: editingId,
        name: form.name.value.trim(),
        category: fCat.value,
        currency: fCur.value,
        value: parseFloat(form.value.value),
        liability: form.liability.checked,
        note: form.note.value.trim(),
        updated: "",
      },
    });
    dlg.close();
    if (wasNew) ui.sel = Math.max(...data.assets.map((a) => a.id));
    render();
    toast(wasNew ? "已新增" : "已更新");
  } catch (err) {
    $("err").textContent = String(err);
  }
};

/* ---------- settings dialog ---------- */
const sdlg = $("sdlg"), sform = $("sform");

function rateRow(code, val) {
  const base = code === "TWD";
  return `<div class="rate-row" data-code="${esc(code)}"><b>${esc(code)}</b>
    <input type="number" min="0" step="any" value="${val}" ${base ? "disabled" : ""}>
    ${base ? "<span></span>" : '<button type="button" class="link" data-rm>移除</button>'}</div>`;
}

$("settings-btn").onclick = () => {
  sform.goal.value = data.goal || "";
  $("rates").innerHTML = Object.entries(data.rates).map(([c, r]) => rateRow(c, r)).join("");
  $("new-code").value = $("new-rate").value = "";
  $("serr").textContent = "";
  sdlg.showModal();
};
$("rates").onclick = (e) => e.target.matches("[data-rm]") && e.target.closest(".rate-row").remove();

sform.onsubmit = async (e) => {
  e.preventDefault();
  const rates = {};
  document.querySelectorAll("#rates .rate-row").forEach((r) => {
    const v = r.querySelector("input").value;
    rates[r.dataset.code] = v === "" ? NaN : parseFloat(v);
  });
  rates.TWD = 1;
  const code = $("new-code").value.trim().toUpperCase();
  if (code) {
    if (!/^[A-Z]{2,5}$/.test(code)) return ($("serr").textContent = "幣別代碼需為 2–5 個英文字母");
    rates[code] = parseFloat($("new-rate").value);
  }
  try {
    data = await invoke("set_settings", { rates, goal: parseFloat(sform.goal.value) || 0 });
    sdlg.close();
    render();
    toast("設定已儲存");
  } catch (err) {
    $("serr").textContent = String(err);
  }
};

/* ---------- CSV export / import ---------- */
$("export-btn").onclick = async () => {
  const csv = await invoke("export_csv");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `moneypi-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast("已匯出 CSV");
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

invoke("get_data").then((d) => { data = d; render(); });
