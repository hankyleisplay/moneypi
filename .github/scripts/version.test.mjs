import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { newer, parse, versionCode } from "./version.mjs";

for (const ok of ["0.21.1", "v0.22.0-preview.1", "1.0.0-preview.12"]) assert.ok(parse(ok), ok);
for (const bad of ["", "1.2", "1.2.3.4", "0.22.0-beta.1", "0.22.0-preview", "0.22.0-preview.x", "latest", "0.22.0-rc.1", undefined]) assert.equal(parse(bad), null, String(bad));

assert.ok(newer("0.21.1", "0.21.0"));
assert.ok(newer("0.21.0", "0.9.0"), "numbers, not text");
assert.ok(newer("0.22.0-preview.1", "0.21.5"));
assert.ok(newer("0.22.0-preview.10", "0.22.0-preview.2"));
assert.ok(newer("0.22.0", "0.22.0-preview.9"), "stable beats its previews");
assert.ok(!newer("0.22.0-preview.9", "0.22.0"));
assert.ok(!newer("0.21.0", "0.21.0"));
assert.ok(newer("0.21.0", ""), "nothing published yet");
assert.ok(newer("0.21.0", "preview-channel"));
assert.ok(!newer("garbage", "0.21.0"));

assert.equal(versionCode("0.21.1"), 2100199);
assert.ok(versionCode("0.21.1") > 21000, "above the old scheme (0.21.0 was 21000)");
assert.ok(versionCode("0.22.0-preview.1") > versionCode("0.21.9"));
assert.ok(versionCode("0.22.0-preview.2") > versionCode("0.22.0-preview.1"));
assert.ok(versionCode("0.22.0") > versionCode("0.22.0-preview.98"), "stable beats its previews");
assert.ok(versionCode("0.22.0-preview.500") < versionCode("0.22.0"), "clamped");
assert.ok(versionCode("1.999.999") < 2_100_000_000, "fits Android's limit");
assert.throws(() => versionCode("1.0.1000"));
console.log("version helpers ok");

// the command line itself (this is how the workflows call it, also from a path with a drive letter on Windows runners)
const cli = (...a) => execFileSync("node", [new URL("./version.mjs", import.meta.url).pathname, ...a]).toString().trim();
assert.equal(cli("code", "0.21.1"), "2100199");
assert.equal(cli("pre", "0.22.0-preview.1"), "true");
assert.equal(cli("pre", "0.22.0"), "false");
assert.throws(() => cli("valid", "nope"), "an invalid version must fail the step");
assert.throws(() => cli("bogus"), "an unknown command must fail, not succeed silently");
console.log("version cli ok");
