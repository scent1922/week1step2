// 위젯 미리보기 이미지를 만들고 동작 점검 결과를 출력한다.
// 사용법: cd dev && npm install && node render-previews.mjs [출력폴더]
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const devDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(devDir, "..");
const outDir = resolve(process.argv[2] || join(root, "docs", "previews"));
await mkdir(outDir, { recursive: true });

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff" };
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, "." + decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!path.startsWith(root)) throw new Error("outside root");
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
let failed = false;

async function capture(theme, scenarios, file, cols = 1) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 400 }, deviceScaleFactor: 2 });
  const q = new URLSearchParams({ theme, cols });
  if (scenarios) q.set("scenarios", scenarios.join(","));
  await page.goto(`${base}/dev/preview.html?${q}`);
  await page.waitForFunction(() => window.__done === true, null, { timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  const report = await page.evaluate(() => window.__report);
  await page.locator("#board").screenshot({ path: join(outDir, file) });
  await page.close();
  return report;
}

function check(report) {
  for (const r of report) {
    if (r.fatal) { console.log("치명적 오류:", r.fatal); failed = true; continue; }
    const problems = [...r.errors];
    if (r.expectRequests !== null && r.requests.length !== r.expectRequests) problems.push(`요청 수 ${r.requests.length} (예상 ${r.expectRequests}): ${r.requests.join(", ")}`);
    if (!r.cookieHeaderOk) problems.push("쿠키 헤더가 올바르지 않음");
    for (const [family, w] of Object.entries(r.widgets)) {
      if (w.truncated.length) problems.push(`${family}: 글자 잘림 → ${w.truncated.join(" | ")}`);
      if (w.refreshMinutes !== 15) problems.push(`${family}: 갱신 간격 ${w.refreshMinutes}분`);
      if (w.url !== "https://claude.ai/settings/usage") problems.push(`${family}: 탭 주소 ${w.url}`);
    }
    console.log(`\n[${r.id}] ${problems.length ? "문제 있음" : "OK"}`);
    for (const [family, w] of Object.entries(r.widgets)) console.log(`  ${family.padEnd(21)} ${w.text}`);
    if (r.alerts) console.log(`  안내 창: ${r.alerts.join(" → ")}`);
    for (const p of problems) console.log(`  ! ${p}`);
    if (problems.length) failed = true;
  }
}

check(await capture("light", ["normal"], "preview-light.png"));
check(await capture("dark", ["normal"], "preview-dark.png"));
check(await capture("light", null, "preview-all-states.png", 2));
await capture("dark", null, "preview-all-states-dark.png", 2);

await browser.close();
server.close();
console.log(failed ? "\n점검 실패" : `\n모든 점검 통과 → ${outDir}`);
process.exit(failed ? 1 : 0);
