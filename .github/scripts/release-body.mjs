// The release page text: the version's notes plus how to install it on every platform (so no release ships without it).
//   node release-body.mjs <version> <notes.md> <out-dir>  ->  <out-dir>/release-body.md and <out-dir>/update-notes.md
import { readFileSync, writeFileSync } from "node:fs";

export function releaseBody(v, notes) {
  const pre = v.includes("-");
  const lines = [];
  if (pre) lines.push("> ⚠️ **這是預覽版（preview）**：提早試用新功能，可能還有沒修好的問題。只有在「設定 → 版本 → 更新頻道」選了「預覽版」的人才會收到更新提示；一般使用者不會被推送。重要資料請先匯出備份。", "");
  lines.push(notes.trim(), "", "### 安裝與更新");
  lines.push(pre
    ? "- 已安裝的電腦版：選了「預覽版」頻道的使用者會在啟動時收到更新提示，一鍵更新"
    : "- 已安裝 v0.13.0 以上的電腦版會在啟動時收到更新提示，一鍵更新（Linux 限 AppImage 版）");
  lines.push(
    `- **Windows**：\`MoneyPi_${v}_x64-setup.exe\`${pre ? "（預覽版只提供這個安裝檔）" : `（建議）或 \`MoneyPi_${v}_x64_en-US.msi\``}。安裝檔未經程式碼簽章，SmartScreen 可能會提示，請選「更多資訊 → 仍要執行」`,
    "- **macOS**（Intel 與 Apple 晶片通用）：下載 `.dmg`，把 MoneyPi 拖進「應用程式」。程式沒有經過 Apple 公證，第一次開啟會被擋下：到「系統設定 → 隱私權與安全性」，在下方按「強制打開」即可（只需一次）",
    `- **Linux**：\`.AppImage\`（加上執行權限後直接開，會自動更新）或 \`.deb\`（Ubuntu／Debian，需手動更新）${pre ? "" : "，Fedora 等可用 `.rpm`"}`,
  );
  if (!pre) lines.push("- v0.12.0 以前的 Windows 使用者請先手動安裝一次（簽章金鑰已更換）");
  lines.push("");
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const [v, file, out] = process.argv.slice(2);
  const notes = readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim();
  writeFileSync(`${out}/release-body.md`, releaseBody(v, notes));
  writeFileSync(`${out}/update-notes.md`, notes + "\n");
}
