const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
const money = (n) => "NT$ " + fmt.format(n);
const COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#a855f7", "#ec4899", "#14b8a6", "#ef4444", "#64748b"];
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

let data = { assets: [], snapshots: [] };

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function render() {
  const A = data.assets.filter((a) => !a.liability);
  const L = data.assets.filter((a) => a.liability);
  const sum = (xs) => xs.reduce((s, a) => s + a.value, 0);
  const net = sum(A) - sum(L);
  $("net").textContent = money(net);
  $("assets").textContent = money(sum(A));
  $("liab").textContent = money(sum(L));

  const snaps = data.snapshots;
  const d = $("net-delta");
  if (snaps.length > 1) {
    const prev = snaps[snaps.length - 2];
    const diff = net - (prev.assets - prev.liabilities);
    d.textContent = `較 ${prev.date}：${diff >= 0 ? "+" : ""}${fmt.format(diff)}`;
    d.className = diff >= 0 ? "pos" : "neg";
  } else d.textContent = "";

  $("empty").hidden = data.assets.length > 0;
  $("rows").innerHTML = data.assets
    .map(
      (a) => `<tr>
      <td>${esc(a.name)}${a.note ? ` <span class="muted">· ${esc(a.note)}</span>` : ""}</td>
      <td>${a.liability ? "負債 · " : ""}${esc(a.category)}</td>
      <td class="r ${a.liability ? "neg" : ""}">${a.liability ? "−" : ""}${money(a.value)}</td>
      <td class="muted">${esc(a.updated)}</td>
      <td class="r"><button class="link" data-edit="${a.id}">編輯</button><button class="link" data-del="${a.id}">刪除</button></td>
    </tr>`
    )
    .join("");

  drawTrend();
  drawAlloc(A);
}

function drawTrend() {
  const c = $("trend"), g = c.getContext("2d"), W = c.width, H = c.height, pad = 52;
  g.clearRect(0, 0, W, H);
  const pts = data.snapshots.map((s) => [s.date, s.assets - s.liabilities]);
  g.font = "11px sans-serif";
  g.fillStyle = css("--muted");
  g.strokeStyle = css("--line");
  g.lineWidth = 1;
  if (!pts.length) { g.fillText("尚無資料", W / 2 - 25, H / 2); return; }
  let min = Math.min(...pts.map((p) => p[1])), max = Math.max(...pts.map((p) => p[1]));
  if (min === max) { min -= 1; max += 1; }
  const x = (i) => pad + (pts.length === 1 ? (W - pad - 12) / 2 : (i * (W - pad - 12)) / (pts.length - 1));
  const y = (v) => H - 22 - ((v - min) / (max - min)) * (H - 22 - 14);
  for (let i = 0; i <= 3; i++) {
    const v = min + ((max - min) * i) / 3, yy = y(v);
    g.beginPath(); g.moveTo(pad, yy); g.lineTo(W - 8, yy); g.stroke();
    g.fillText(fmt.format(v), 2, yy + 3);
  }
  g.strokeStyle = css("--accent");
  g.lineWidth = 2;
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(x(i), y(p[1])) : g.moveTo(x(i), y(p[1]))));
  g.stroke();
  g.fillStyle = css("--accent");
  pts.forEach((p, i) => { g.beginPath(); g.arc(x(i), y(p[1]), 3, 0, 7); g.fill(); });
  g.fillStyle = css("--muted");
  g.fillText(pts[0][0], pad, H - 6);
  if (pts.length > 1) g.fillText(pts[pts.length - 1][0], W - 70, H - 6);
}

function drawAlloc(A) {
  const c = $("alloc"), g = c.getContext("2d"), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const by = {};
  A.forEach((a) => (by[a.category] = (by[a.category] || 0) + a.value));
  const items = Object.entries(by).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const total = items.reduce((s, [, v]) => s + v, 0);
  $("legend").innerHTML = items
    .map(([k, v], i) => `<li><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(k)} ${((v / total) * 100).toFixed(1)}%</li>`)
    .join("");
  if (!total) return;
  let a0 = -Math.PI / 2;
  const cx = W / 2, cy = H / 2, r = Math.min(W, H) / 2 - 8;
  items.forEach(([, v], i) => {
    const a1 = a0 + (v / total) * Math.PI * 2;
    g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, r, a0, a1); g.closePath();
    g.fillStyle = COLORS[i % COLORS.length]; g.fill();
    a0 = a1;
  });
  g.beginPath(); g.arc(cx, cy, r * 0.58, 0, 7); g.fillStyle = css("--card"); g.fill();
}

const dlg = $("dlg"), form = $("form");
let editingId = 0;

function openDialog(asset) {
  editingId = asset ? asset.id : 0;
  $("dlg-title").textContent = asset ? "編輯項目" : "新增項目";
  form.reset();
  $("err").textContent = "";
  if (asset) {
    form.name.value = asset.name;
    form.category.value = asset.category;
    form.value.value = asset.value;
    form.liability.checked = asset.liability;
    form.note.value = asset.note;
  }
  dlg.showModal();
}

$("add-btn").onclick = () => openDialog(null);
$("cancel").onclick = () => dlg.close();
$("rows").onclick = async (e) => {
  const edit = e.target.dataset.edit, del = e.target.dataset.del;
  if (edit) openDialog(data.assets.find((a) => a.id == edit));
  if (del && confirm("確定刪除此項目？")) {
    data = await invoke("delete_asset", { id: Number(del) });
    render();
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
        value: parseFloat(form.value.value),
        liability: form.liability.checked,
        note: form.note.value.trim(),
        updated: "",
      },
    });
    dlg.close();
    render();
  } catch (err) {
    $("err").textContent = String(err);
  }
};

invoke("get_data").then((d) => { data = d; render(); });
matchMedia("(prefers-color-scheme: dark)").onchange = render;
