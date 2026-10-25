const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 });
const fmt0 = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
const COLORS = ["#6aa5ff", "#6ee7a0", "#fbbf24", "#c084fc", "#f472b6", "#2dd4bf", "#fb7185", "#94a3b8"];
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

let data = { assets: [], snapshots: [], rates: { TWD: 1 }, goal: 0 };
const ui = {
  kind: "all", cat: "", q: "", sort: "value", range: 0,
  hidden: store.get("hidden", "0") === "1",
  hover: -1,
};

const rate = (cur) => data.rates[cur] ?? 1;
const toBase = (a) => a.value * rate(a.currency);
const money = (n) => (ui.hidden ? "NT$ ••••" : "NT$ " + fmt0.format(n));
const sum = (xs) => xs.reduce((s, a) => s + toBase(a), 0);

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.id);
  toast.id = setTimeout(() => (t.hidden = true), 2600);
}

/* ---------- theme ---------- */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set("theme", t);
}
applyTheme(store.get("theme", matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
$("theme-btn").onclick = () => {
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
  drawCharts();
};
$("hide-btn").onclick = () => {
  ui.hidden = !ui.hidden;
  store.set("hidden", ui.hidden ? "1" : "0");
  render();
};

/* ---------- render ---------- */
function render() {
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
    const p = Math.max(0, Math.min(1, net / data.goal));
    $("goal-pct").textContent = (net / data.goal * 100).toFixed(1) + "%";
    $("goal-bar").style.width = p * 100 + "%";
    $("goal-text").textContent = net >= data.goal ? "🎉 已達成目標" : ui.hidden ? "" : `距離 ${money(data.goal)} 還差 ${fmt0.format(data.goal - net)}`;
  } else {
    $("goal-pct").textContent = "—";
    $("goal-bar").style.width = "0";
    $("goal-text").textContent = "到「設定」設定淨資產目標";
  }

  renderCategoryOptions();
  renderTable();
  drawCharts();
}

function renderCategoryOptions() {
  const cats = [...new Set(data.assets.map((a) => a.category))].sort();
  const cur = $("cat");
  const html = '<option value="">所有類別</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join("");
  if (cur.innerHTML !== html) cur.innerHTML = html;
  if (!cats.includes(ui.cat)) ui.cat = "";
  cur.value = ui.cat;
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

function renderTable() {
  const xs = visibleAssets();
  $("count").textContent = `(${xs.length})`;
  $("empty").hidden = xs.length > 0;
  $("empty").textContent = data.assets.length ? "沒有符合條件的項目。" : "尚無項目，按右上角「新增」開始記錄。";
  const mask = ui.hidden ? "blur" : "";
  $("rows").innerHTML = xs
    .map(
      (a) => `<tr>
      <td>${esc(a.name)}${a.note ? ` <span class="muted">· ${esc(a.note)}</span>` : ""}</td>
      <td><span class="tag ${a.liability ? "debt" : ""}">${a.liability ? "負債 · " : ""}${esc(a.category)}</span></td>
      <td class="r ${a.liability ? "neg" : ""} ${mask}">${a.liability ? "−" : ""}${esc(a.currency)} ${fmt.format(a.value)}</td>
      <td class="r ${a.liability ? "neg" : ""} ${mask}">${a.currency === "TWD" ? "" : (a.liability ? "−" : "") + fmt0.format(toBase(a))}</td>
      <td class="muted">${esc(a.updated)}</td>
      <td class="r"><button class="link" data-edit="${a.id}">編輯</button><button class="link danger" data-del="${a.id}">刪除</button></td>
    </tr>`
    )
    .join("");
}

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
  drawTrend();
  drawAlloc();
}

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
    g.fillStyle = css("--muted");
    g.textAlign = "center";
    g.fillText("尚無資料", W / 2, H / 2);
    return;
  }
  let min = Math.min(...all.map((p) => p.v)), max = Math.max(...all.map((p) => p.v));
  if (min === max) { const m = Math.abs(min) * 0.05 || 1; min -= m; max += m; }
  const x = (i) => padL + (all.length === 1 ? (W - padL - padR) / 2 : (i * (W - padL - padR)) / (all.length - 1));
  const y = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  trendPts = all.map((p, i) => ({ ...p, x: x(i), y: y(p.v) }));

  g.lineWidth = 1;
  g.textAlign = "left";
  for (let i = 0; i <= 3; i++) {
    const v = min + ((max - min) * i) / 3, yy = y(v);
    g.strokeStyle = css("--edge-dim");
    g.beginPath(); g.moveTo(padL, yy); g.lineTo(W - padR, yy); g.stroke();
    if (!ui.hidden) { g.fillStyle = css("--muted"); g.fillText(fmt0.format(v), 2, yy + 3); }
  }
  const accent = css("--accent");
  const grad = g.createLinearGradient(0, padT, 0, H - padB);
  grad.addColorStop(0, accent + "66");
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
    g.strokeStyle = css("--edge"); g.lineWidth = 1;
    g.beginPath(); g.moveTo(h.x, padT); g.lineTo(h.x, H - padB); g.stroke();
    g.fillStyle = "#fff"; g.beginPath(); g.arc(h.x, h.y, 5, 0, 7); g.fill();
    g.strokeStyle = accent; g.lineWidth = 2; g.stroke();
    const label = `${h.date}  ${ui.hidden ? "••••" : fmt0.format(h.v)}`;
    const w = g.measureText(label).width + 16, bx = Math.min(Math.max(h.x - w / 2, 4), W - w - 4), by = Math.max(h.y - 34, 2);
    g.fillStyle = "rgba(15,20,45,.82)";
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
  const by = {};
  data.assets.filter((a) => !a.liability).forEach((a) => (by[a.category] = (by[a.category] || 0) + toBase(a)));
  const items = Object.entries(by).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const total = items.reduce((s, [, v]) => s + v, 0);
  $("legend").innerHTML = items
    .map(([k, v], i) => `<li><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(k)} ${((v / total) * 100).toFixed(1)}%</li>`)
    .join("");
  if (!total) { g.fillStyle = css("--muted"); g.textAlign = "center"; g.fillText("尚無資產", W / 2, H / 2); return; }
  const cx = W / 2, cy = H / 2, lw = 26, r = Math.min(W, H) / 2 - lw / 2 - 6;
  let a0 = -Math.PI / 2;
  g.lineWidth = lw; g.lineCap = "butt";
  items.forEach(([, v], i) => {
    const sweep = (v / total) * Math.PI * 2, gap = items.length > 1 ? 0.03 : 0;
    g.strokeStyle = COLORS[i % COLORS.length];
    g.beginPath(); g.arc(cx, cy, r, a0 + gap, a0 + sweep - gap); g.stroke();
    a0 += sweep;
  });
  g.fillStyle = css("--muted"); g.textAlign = "center"; g.font = "12px 'Segoe UI Variable', sans-serif";
  g.fillText("總資產", cx, cy - 4);
  g.fillStyle = css("--fg"); g.font = "600 15px 'Segoe UI Variable', sans-serif";
  g.fillText(ui.hidden ? "••••" : fmt0.format(total), cx, cy + 16);
}

addEventListener("resize", drawCharts);

/* ---------- filters ---------- */
function bindSeg(id, attr, key, num) {
  $(id).onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    ui[key] = num ? Number(b.dataset[attr]) : b.dataset[attr];
    [...$(id).children].forEach((c) => c.classList.toggle("on", c === b));
    key === "range" ? drawTrend() : renderTable();
  };
}
bindSeg("range", "r", "range", true);
bindSeg("kind", "k", "kind", false);
$("cat").onchange = (e) => { ui.cat = e.target.value; renderTable(); };
$("sort").onchange = (e) => { ui.sort = e.target.value; renderTable(); };
$("q").oninput = (e) => { ui.q = e.target.value; renderTable(); };

/* ---------- asset dialog ---------- */
const dlg = $("dlg"), form = $("form");
let editingId = 0;

function currencyOptions() {
  return Object.keys(data.rates).map((c) => `<option>${esc(c)}</option>`).join("");
}

function openDialog(asset) {
  editingId = asset ? asset.id : 0;
  $("dlg-title").textContent = asset ? "編輯項目" : "新增項目";
  form.reset();
  form.currency.innerHTML = currencyOptions();
  $("err").textContent = "";
  if (asset) {
    form.name.value = asset.name;
    form.category.value = asset.category;
    form.currency.value = asset.currency;
    form.value.value = asset.value;
    form.liability.checked = asset.liability;
    form.note.value = asset.note;
  }
  dlg.showModal();
}

document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => b.closest("dialog").close()));
$("add-btn").onclick = () => openDialog(null);
$("rows").onclick = async (e) => {
  const edit = e.target.dataset.edit, del = e.target.dataset.del;
  if (edit) openDialog(data.assets.find((a) => a.id == edit));
  if (del && confirm("確定刪除此項目？")) {
    data = await invoke("delete_asset", { id: Number(del) });
    render();
    toast("已刪除");
  }
};

form.onsubmit = async (e) => {
  e.preventDefault();
  try {
    data = await invoke("save_asset", {
      asset: {
        id: editingId,
        name: form.name.value.trim(),
        category: form.category.value,
        currency: form.currency.value,
        value: parseFloat(form.value.value),
        liability: form.liability.checked,
        note: form.note.value.trim(),
        updated: "",
      },
    });
    dlg.close();
    render();
    toast(editingId ? "已更新" : "已新增");
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
    ${base ? "<span></span>" : '<button type="button" class="link danger" data-rm>移除</button>'}</div>`;
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
  document.querySelectorAll("#rates .rate-row").forEach((r) => (rates[r.dataset.code] = r.querySelector("input").value === "" ? NaN : parseFloat(r.querySelector("input").value)));
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
