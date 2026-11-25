#!/usr/bin/env node
/*
  Renders the landing-page demo video from scene.html, frame by frame.

  From this folder:
    npm install                 # fetches the Inter font (@fontsource-variable/inter)
    node render.js              # frames -> ../media/billett-demo.{webm,mp4} + poster/stills

  Needs Node 18+, Playwright with Chromium (require("playwright") must resolve), and
  ffmpeg built with libvpx-vp9 and libx264.

  Environment options:
    FRAMES_DIR=dir    where the PNG frames go (default ./out/frames)
    OUT_DIR=dir       where the media go (default ../media)
    ONLY=frames       render frames only; ONLY=encode encodes existing frames only
    SHOTS=2.6,9.1     just save PNGs at these times (seconds) to SHOTS_DIR (./out/shots) and stop
    WORKERS=4         parallel browser pages
*/
const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const ROOT = __dirname;
const FPS = 30;
const DURATION = 30; // seconds; must match window.DURATION in scene.html
const FRAMES = FPS * DURATION;
const SIZE = { width: 360, height: 780, scale: 2 }; // -> 720x1560 video
const FRAMES_DIR = path.resolve(process.env.FRAMES_DIR || path.join(ROOT, "out/frames"));
const OUT_DIR = path.resolve(process.env.OUT_DIR || path.join(ROOT, "../media"));
const WORKERS = Number(process.env.WORKERS || 4);
const FFMPEG = process.env.FFMPEG || "ffmpeg";

// Stills: the poster (also reduced-motion still 1), then stills 2 and 3.
const STILLS = [
  { name: "demo-1-deal.webp", t: 2.6 },
  { name: "demo-2-booked.webp", t: 18.7 },
  { name: "demo-3-tickets.webp", t: 23.0 },
];

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".woff2": "font/woff2", ".css": "text/css" };
function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function openScene(browser, url) {
  const page = await browser.newPage({ viewport: { width: SIZE.width, height: SIZE.height }, deviceScaleFactor: SIZE.scale });
  await page.goto(url);
  await page.waitForFunction(() => window.sceneReady === true, null, { timeout: 20000 });
  return page;
}

const frameName = (i) => path.join(FRAMES_DIR, `f${String(i).padStart(4, "0")}.png`);

async function renderFrames(url) {
  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  const browser = await chromium.launch();
  const pages = await Promise.all(Array.from({ length: WORKERS }, () => openScene(browser, url)));
  let next = 0, done = 0;
  const started = Date.now();
  await Promise.all(pages.map(async (page) => {
    while (next < FRAMES) {
      const i = next++;
      await page.evaluate((t) => window.renderAt(t), i / FPS);
      await page.screenshot({ path: frameName(i), type: "png" });
      if (++done % 90 === 0) console.log(`  ${done}/${FRAMES} frames (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    }
  }));
  await browser.close();
}

async function renderShots(url, times) {
  const dir = path.resolve(process.env.SHOTS_DIR || path.join(ROOT, "out/shots"));
  fs.mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch();
  const page = await openScene(browser, url);
  for (const t of times) {
    await page.evaluate((x) => window.renderAt(x), t);
    const file = path.join(dir, `t${t.toFixed(2)}.png`);
    await page.screenshot({ path: file, type: "png" });
    console.log(file);
  }
  await browser.close();
}

function ff(args) { execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" }); }

function encode() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const input = ["-framerate", String(FPS), "-i", path.join(FRAMES_DIR, "f%04d.png")];
  // Convert the RGB frames with the BT.709 matrix and tag the streams to match, so the
  // blue and the whites decode to the same values as the page's CSS colors.
  const vf = ["-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p"];
  const tags = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
  const passlog = path.join(FRAMES_DIR, "..", "vp9pass");

  console.log("WebM (VP9, two-pass constrained quality)…");
  const vp9 = ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "38", "-g", "150", "-row-mt", "1", "-tile-columns", "1",
    "-auto-alt-ref", "1", "-lag-in-frames", "25", "-passlogfile", passlog, "-an"];
  ff([...input, ...vf, ...vp9, "-deadline", "good", "-cpu-used", "4", "-pass", "1", "-f", "null", "/dev/null"]);
  ff([...input, ...vf, ...vp9, ...tags, "-deadline", "good", "-cpu-used", "1", "-pass", "2", path.join(OUT_DIR, "billett-demo.webm")]);

  console.log("MP4 (H.264 High, yuv420p, faststart)…");
  // Level 4.0 caps the reference frames so older phones decode it in hardware.
  ff([...input, ...vf, "-c:v", "libx264", "-preset", "veryslow", "-crf", "27", "-profile:v", "high", "-level:v", "4.0",
    "-tune", "animation", "-g", "150", "-movflags", "+faststart", ...tags, "-an", path.join(OUT_DIR, "billett-demo.mp4")]);

  console.log("Poster and stills (WebP)…");
  for (const s of STILLS) {
    const src = frameName(Math.round(s.t * FPS));
    ff(["-i", src, "-c:v", "libwebp", "-pix_fmt", "bgra", "-quality", "82", "-compression_level", "6", path.join(OUT_DIR, s.name)]);
  }
  for (const f of ["billett-demo.webm", "billett-demo.mp4", ...STILLS.map((s) => s.name)]) {
    const kb = fs.statSync(path.join(OUT_DIR, f)).size / 1024;
    console.log(`  ${f}: ${kb.toFixed(0)} KB`);
  }
}

(async () => {
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/scene.html`;
  try {
    if (process.env.SHOTS) return await renderShots(url, process.env.SHOTS.split(",").map(Number));
    if (process.env.ONLY !== "encode") { console.log(`Rendering ${FRAMES} frames to ${FRAMES_DIR}…`); await renderFrames(url); }
    if (process.env.ONLY !== "frames") encode();
  } finally {
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
