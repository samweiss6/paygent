// node make.mjs stills 1,4,8   -> stills/t-<t>.jpg
// node make.mjs video out.mp4  -> frames + H.264/AAC MP4 encoded by Chrome's WebCodecs
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
const DIR = new URL(".", import.meta.url).pathname;
const [mode, arg] = process.argv.slice(2);
const FPS = 30;

const types = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".jpg": "image/jpeg" };
let resolveOut;
const outDone = new Promise((r) => (resolveOut = r));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "POST" && url.pathname === "/out") {
    const chunks = []; req.on("data", (c) => chunks.push(c));
    req.on("end", () => { writeFileSync(join(DIR, arg), Buffer.concat(chunks)); res.end("ok"); resolveOut(); });
    return;
  }
  if (req.method === "POST" && url.pathname === "/log") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { console.log("[page]", b); res.end(); }); return; }
  const p = join(DIR, decodeURIComponent(url.pathname));
  if (!p.startsWith(DIR) || !existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": types[extname(p)] ?? "application/octet-stream" });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const port = 9400 + Math.floor(Math.random() * 400);
const prof = mkdtempSync(join(process.env.TMPDIR, "adprof-"));
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required", "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.find((t) => t.type === "page")) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600)); return r.result?.result?.value; };

await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send("Page.enable");
await send("Page.navigate", { url: `${base}/ad.html` });
await new Promise((r) => setTimeout(r, 1500));
const shot = async (t, file) => {
  await evaluate(`render(${t})`);
  const s = await send("Page.captureScreenshot", { format: "jpeg", quality: 94 });
  writeFileSync(file, Buffer.from(s.result.data, "base64"));
};

if (mode === "stills") {
  mkdirSync(join(DIR, "stills"), { recursive: true });
  for (const t of arg.split(",")) await shot(Number(t), join(DIR, "stills", `t-${t}.jpg`));
  console.log("stills done");
} else {
  const duration = await evaluate("DURATION");
  const n = Math.round(duration * FPS);
  rmSync(join(DIR, "frames"), { recursive: true, force: true }); mkdirSync(join(DIR, "frames"));
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    await shot(i / FPS, join(DIR, "frames", `${String(i).padStart(5, "0")}.jpg`));
    if (i % 150 === 0) console.log(`frame ${i}/${n} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  console.log("encoding…");
  await send("Page.navigate", { url: `${base}/enc.html#${n}` });
  await Promise.race([outDone, new Promise((_, rej) => setTimeout(() => rej(new Error("encode timeout")), 600_000))]);
  console.log(`wrote ${arg}`);
}
ws.close(); chrome.kill(); server.closeAllConnections(); server.close(); process.exit(0);
