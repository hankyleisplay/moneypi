// Builds the updater description (latest.json) for every desktop platform from the release's own assets, and checks
// that every file a release must have is there. Used by release.yml after the Windows, macOS and Linux builds finished,
// so the parallel builds never race on one shared latest.json.
//
//   node updater-json.mjs <version> <notes.md> <assets.json> <sig-dir> <out.json> <repo>
//     assets.json: `gh release view vX --json assets` output; sig-dir: the downloaded *.sig files
//
// Platforms (what the Tauri updater asks for): windows-x86_64 = NSIS setup.exe, darwin-aarch64 / darwin-x86_64 = the
// .app.tar.gz (one universal build serves both), linux-x86_64 = the AppImage.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function requiredAssets(version) {
  const pre = version.includes("-");
  const need = [
    { what: "Windows 安裝檔 (NSIS)", test: (n) => n.endsWith("_x64-setup.exe") },
    { what: "Windows 更新簽章", test: (n) => n.endsWith("_x64-setup.exe.sig") },
    { what: "macOS 磁碟映像 (.dmg)", test: (n) => n.endsWith(".dmg") },
    { what: "macOS 更新檔 (.app.tar.gz)", test: (n) => n.endsWith(".app.tar.gz") },
    { what: "macOS 更新簽章", test: (n) => n.endsWith(".app.tar.gz.sig") },
    { what: "Linux AppImage", test: (n) => n.endsWith(".AppImage") },
    { what: "Linux AppImage 更新簽章", test: (n) => n.endsWith(".AppImage.sig") },
    { what: "Linux .deb", test: (n) => n.endsWith(".deb") },
  ];
  if (!pre) {
    need.push({ what: "Windows MSI", test: (n) => n.endsWith(".msi") }, { what: "Windows MSI 簽章", test: (n) => n.endsWith(".msi.sig") },
      { what: "Linux .rpm", test: (n) => n.endsWith(".rpm") });
  }
  return need;
}

export function missingAssets(version, names) {
  return requiredAssets(version).filter((r) => !names.some(r.test)).map((r) => r.what);
}

/** names: asset file names; sig(name) -> contents of `${name}.sig` (or undefined). */
export function updaterJson({ version, notes, names, sig, repo, now = new Date() }) {
  const url = (n) => `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(n)}`;
  const entry = (n) => (n && sig(n) ? { signature: sig(n).trim(), url: url(n) } : undefined);
  const platforms = {};
  const exe = names.find((n) => n.endsWith("_x64-setup.exe"));
  if (entry(exe)) platforms["windows-x86_64"] = entry(exe);
  for (const n of names.filter((n) => n.endsWith(".app.tar.gz"))) {
    const e = entry(n);
    if (!e) continue;
    if (/universal/i.test(n)) { platforms["darwin-aarch64"] ??= e; platforms["darwin-x86_64"] ??= e; }
    else if (/aarch64|arm64/i.test(n)) platforms["darwin-aarch64"] = e;
    else if (/x64|x86_64|amd64/i.test(n)) platforms["darwin-x86_64"] = e;
  }
  const appimage = names.find((n) => n.endsWith(".AppImage") && /amd64|x86_64/i.test(n)) ?? names.find((n) => n.endsWith(".AppImage"));
  if (entry(appimage)) platforms["linux-x86_64"] = entry(appimage);
  const want = ["windows-x86_64", "darwin-aarch64", "darwin-x86_64", "linux-x86_64"];
  const lacking = want.filter((p) => !platforms[p]);
  return { json: { version, notes: notes.trim(), pub_date: now.toISOString(), platforms }, lacking };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const [version, notesFile, assetsFile, sigDir, out, repo] = process.argv.slice(2);
  const names = JSON.parse(readFileSync(assetsFile, "utf8")).assets.map((a) => a.name);
  const missing = missingAssets(version, names);
  if (missing.length) { console.log(`::error::release v${version} is missing: ${missing.join("、")}`); process.exit(1); }
  const sig = (n) => { const f = join(sigDir, `${n}.sig`); return existsSync(f) ? readFileSync(f, "utf8") : undefined; };
  const { json, lacking } = updaterJson({ version, notes: readFileSync(notesFile, "utf8"), names, sig, repo });
  if (lacking.length) { console.log(`::error::latest.json has no entry for: ${lacking.join(", ")}`); process.exit(1); }
  writeFileSync(out, JSON.stringify(json, null, 2) + "\n");
  console.log("latest.json:", Object.keys(json.platforms).join(", "));
}
