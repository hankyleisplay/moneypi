// Version helpers for the release workflows (kept in one place so they can be tested without GitHub).
//
//   node version.mjs valid 0.22.0-preview.1      exit 0 if it is "x.y.z" or "x.y.z-preview.N"
//   node version.mjs pre   0.22.0-preview.1      prints true / false
//   node version.mjs code  0.22.0-preview.1      prints the Android versionCode
//   node version.mjs newer A B                   exit 0 if A is a newer version than B (an empty / unknown B is older than anything)
//
// Order: 0.21.5 < 0.22.0-preview.1 < 0.22.0-preview.2 < 0.22.0 (a preview is older than the stable release it leads to).
// Android versionCode = (major*1e6 + minor*1e3 + patch) * 100 + (preview N, 1..98 | 99 for a stable release): it grows with every
// release, a stable release always beats its previews, and it stays above the old scheme (0.21.0 was 21000).
import { pathToFileURL } from "node:url";

const RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?$/;
export function parse(v) {
  const m = RE.exec(String(v ?? "").trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] === undefined ? null : +m[4] } : null;
}
export const key = (p) => [p.major, p.minor, p.patch, p.pre === null ? Infinity : p.pre];
export function newer(a, b) {
  const pa = parse(a);
  if (!pa) return false;
  const pb = parse(b);
  if (!pb) return true;
  const [ka, kb] = [key(pa), key(pb)];
  for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return ka[i] > kb[i];
  return false;
}
export function versionCode(v) {
  const p = parse(v);
  if (!p) throw new Error(`not a MoneyPi version: ${v}`);
  if (p.minor > 999 || p.patch > 999) throw new Error("minor and patch must stay below 1000");
  const base = p.major * 1_000_000 + p.minor * 1_000 + p.patch;
  const slot = p.pre === null ? 99 : Math.min(Math.max(p.pre, 1), 98);
  return base * 100 + slot;
}

// (pathToFileURL, not a hand-made "file://" string: on the Windows runner the path has backslashes and a drive letter)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "valid") process.exit(parse(a) ? 0 : 1);
  else if (cmd === "pre") console.log(parse(a)?.pre !== null && parse(a) !== null ? "true" : "false");
  else if (cmd === "code") console.log(versionCode(a));
  else if (cmd === "newer") process.exit(newer(a, b) ? 0 : 1);
  else { console.error("usage: version.mjs valid|pre|code|newer <version> [other]"); process.exit(2); }
}
