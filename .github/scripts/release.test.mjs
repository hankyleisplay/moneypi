import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingAssets, updaterJson } from "./updater-json.mjs";
import { releaseBody } from "./release-body.mjs";

// what tauri-action uploads for one stable release (names as it builds them)
const stable = ["MoneyPi_0.23.0_x64-setup.exe", "MoneyPi_0.23.0_x64-setup.exe.sig", "MoneyPi_0.23.0_x64_en-US.msi", "MoneyPi_0.23.0_x64_en-US.msi.sig",
  "MoneyPi_0.23.0_universal.dmg", "MoneyPi_universal.app.tar.gz", "MoneyPi_universal.app.tar.gz.sig",
  "MoneyPi_0.23.0_amd64.AppImage", "MoneyPi_0.23.0_amd64.AppImage.sig", "MoneyPi_0.23.0_amd64.deb", "MoneyPi-0.23.0-1.x86_64.rpm", "latest.json"];
assert.deepEqual(missingAssets("0.23.0", stable), []);
assert.deepEqual(missingAssets("0.23.0", stable.filter((n) => !n.endsWith(".dmg"))), ["macOS 磁碟映像 (.dmg)"]);
assert.deepEqual(missingAssets("0.23.0", stable.filter((n) => !n.endsWith(".rpm") && !n.includes(".msi"))).sort(), ["Linux .rpm", "Windows MSI", "Windows MSI 簽章"].sort());
const preview = stable.filter((n) => !n.endsWith(".rpm") && !n.includes(".msi")).map((n) => n.replace("0.23.0", "0.23.0-preview.1"));
assert.deepEqual(missingAssets("0.23.0-preview.1", preview), [], "a preview needs no MSI / rpm");

const sig = (n) => (n.endsWith(".sig") ? undefined : `SIG(${n})\n`);
const { json, lacking } = updaterJson({ version: "0.23.0", notes: " notes \n", names: stable, sig, repo: "o/r", now: new Date("2026-01-01T00:00:00Z") });
assert.deepEqual(lacking, []);
assert.equal(json.notes, "notes");
assert.deepEqual(Object.keys(json.platforms).sort(), ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"]);
assert.equal(json.platforms["windows-x86_64"].url, "https://github.com/o/r/releases/download/v0.23.0/MoneyPi_0.23.0_x64-setup.exe", "NSIS, not the MSI");
assert.equal(json.platforms["windows-x86_64"].signature, "SIG(MoneyPi_0.23.0_x64-setup.exe)");
assert.equal(json.platforms["darwin-aarch64"].url, json.platforms["darwin-x86_64"].url, "one universal app serves both Macs");
assert.match(json.platforms["linux-x86_64"].url, /AppImage$/);
// separate per-arch macOS builds are mapped too, and a missing signature is reported
const split = ["a_x64-setup.exe", "MoneyPi_aarch64.app.tar.gz", "MoneyPi_x64.app.tar.gz", "a_amd64.AppImage"];
const r = updaterJson({ version: "1.0.0", notes: "", names: split, sig: (n) => (n === "a_amd64.AppImage" ? undefined : "s"), repo: "o/r" });
assert.match(r.json.platforms["darwin-aarch64"].url, /aarch64/);
assert.match(r.json.platforms["darwin-x86_64"].url, /x64\.app/);
assert.deepEqual(r.lacking, ["linux-x86_64"]);
// encoded file names
const enc = updaterJson({ version: "1.0.0-preview.1", notes: "", names: ["My App_x64-setup.exe"], sig: () => "s", repo: "o/r" });
assert.equal(enc.json.platforms["windows-x86_64"].url, "https://github.com/o/r/releases/download/v1.0.0-preview.1/My%20App_x64-setup.exe");

// release page text
const b = releaseBody("0.23.0", "## Notes");
assert.match(b, /Windows/); assert.match(b, /macOS/); assert.match(b, /Linux/); assert.match(b, /\.msi/); assert.match(b, /\.rpm/);
const bp = releaseBody("0.23.0-preview.1", "## Notes");
assert.match(bp, /預覽版/); assert.doesNotMatch(bp, /\.msi/); assert.doesNotMatch(bp, /\.rpm/);

// the command line as the workflow calls it
const dir = mkdtempSync(join(tmpdir(), "mp-rel-"));
mkdirSync(join(dir, "sigs"));
for (const n of stable.filter((n) => n.endsWith(".sig"))) writeFileSync(join(dir, "sigs", n), "S\n");
writeFileSync(join(dir, "assets.json"), JSON.stringify({ assets: stable.map((name) => ({ name })) }));
writeFileSync(join(dir, "notes.md"), "Notes");
const script = new URL("./updater-json.mjs", import.meta.url).pathname;
execFileSync("node", [script, "0.23.0", join(dir, "notes.md"), join(dir, "assets.json"), join(dir, "sigs"), join(dir, "latest.json"), "o/r"]);
assert.equal(Object.keys(JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")).platforms).length, 4);
writeFileSync(join(dir, "assets.json"), JSON.stringify({ assets: stable.filter((n) => !n.endsWith(".AppImage")).map((name) => ({ name })) }));
assert.throws(() => execFileSync("node", [script, "0.23.0", join(dir, "notes.md"), join(dir, "assets.json"), join(dir, "sigs"), join(dir, "x.json"), "o/r"], { stdio: "pipe" }), "a missing file stops the release");
execFileSync("node", [new URL("./release-body.mjs", import.meta.url).pathname, "0.23.0", join(dir, "notes.md"), dir]);
assert.match(readFileSync(join(dir, "release-body.md"), "utf8"), /macOS/);
console.log("release scripts ok");
