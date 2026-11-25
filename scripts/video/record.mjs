#!/usr/bin/env node
/**
 * Records a product video of the Vigil web app.
 *
 * It drives a headless Chrome over the DevTools protocol through a list of
 * scenes, captures the screen, speaks each scene's narration with a built-in
 * Windows voice, and joins everything into an H.264 MP4 with ffmpeg.
 *
 *   node scripts/video/record.mjs <scene-file-name> [base-url]
 *
 * Scene files live in scripts/video/scenes. Secrets are only ever read from
 * the environment by name (a "type" step with "env"), typed into password
 * fields, and never written to disk or to the log.
 *
 * Needs: Google Chrome, ffmpeg and ffprobe on PATH (or FFMPEG_DIR), Windows
 * PowerShell for narration.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const [sceneName, baseArg] = process.argv.slice(2);
if (!sceneName) {
  console.error("usage: record.mjs <scene-file-name> [base-url]");
  process.exit(2);
}
const plan = JSON.parse(readFileSync(join(here, "scenes", `${sceneName}.json`), "utf8"));
const BASE = baseArg ?? plan.baseUrl ?? "http://127.0.0.1:8090";
// The page is captured at a smaller size and scaled up, so text reads well on video.
const WIDTH = plan.viewportWidth ?? 1440;
const HEIGHT = plan.viewportHeight ?? 810;
const OUT_W = 1920;
const OUT_H = 1080;
const FPS = 30;

const tool = (name) => {
  // ffmpeg and ffprobe come from FFMPEG_DIR when set, otherwise from PATH.
  const dir = process.env.FFMPEG_DIR;
  if (dir === undefined) return name;
  const candidate = join(dir, process.platform === "win32" ? `${name}.exe` : name);
  return existsSync(candidate) ? candidate : name;
};
const FFMPEG = tool("ffmpeg");
const FFPROBE = tool("ffprobe");
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

const work = mkdtempSync(join(tmpdir(), `vigil-video-${sceneName}-`));
const outDir = join(repo, "media");
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => process.stdout.write(`${line}\n`);

// ---------- narration ----------

function probeSeconds(file) {
  const out = execFileSync(FFPROBE, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    file,
  ]);
  return Number(out.toString().trim());
}

function narrate(text, index) {
  const file = join(work, `voice-${String(index).padStart(2, "0")}.wav`);
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(here, "narrate.ps1"),
    "-Text",
    text,
    "-Out",
    file,
    "-Voice",
    plan.voice ?? "Microsoft Zira Desktop",
    "-Rate",
    String(plan.rate ?? 0),
  ]);
  return { file, seconds: probeSeconds(file) };
}

// ---------- browser ----------

const profile = join(work, "chrome");
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--remote-debugging-port=9336",
    `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    "--force-device-scale-factor=1",
    "about:blank",
  ],
  { stdio: "ignore" },
);
let target;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(250);
  try {
    target = (await (await fetch("http://127.0.0.1:9336/json")).json()).find(
      (t) => t.type === "page",
    );
  } catch {
    /* Chrome is still starting */
  }
}
if (!target) throw new Error("Chrome did not start");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 0;
const pending = new Map();
const frames = [];
let capturing = false;
let sceneIndex = -1;
ws.onmessage = (message) => {
  const data = JSON.parse(message.data);
  if (data.id && pending.has(data.id)) {
    pending.get(data.id)(data.result ?? { error: data.error });
    pending.delete(data.id);
  }
  if (data.method === "Page.screencastFrame") {
    const { sessionId, data: image, metadata } = data.params;
    void send("Page.screencastFrameAck", { sessionId });
    if (capturing) {
      const file = join(work, `f-${String(frames.length).padStart(6, "0")}.jpg`);
      writeFileSync(file, Buffer.from(image, "base64"));
      frames.push({ file, t: metadata.timestamp, scene: sceneIndex });
    }
  }
};
const send = (method, params = {}) =>
  new Promise((r) => {
    pending.set(++nextId, r);
    ws.send(JSON.stringify({ id: nextId, method, params }));
  });
const js = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? "script failed");
  return result.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
await send("Emulation.setDeviceMetricsOverride", {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: false,
});

// Overlay helpers: a caption bar and a pointer, added to the page for the recording only.
const OVERLAY = `(() => {
  if (document.getElementById("rec-caption")) return;
  const caption = document.createElement("div");
  caption.id = "rec-caption";
  Object.assign(caption.style, {
    position: "fixed", left: "50%", bottom: "32px", transform: "translateX(-50%)", zIndex: 99999,
    maxWidth: "1000px", padding: "12px 22px", borderRadius: "14px", background: "rgba(9,9,11,0.88)",
    color: "#fafafa", font: "600 21px/1.35 Inter, 'Segoe UI', sans-serif", textAlign: "center",
    boxShadow: "0 16px 40px rgba(0,0,0,0.35)", opacity: "0", transition: "opacity 0.35s",
    border: "1px solid rgba(255,255,255,0.12)",
  });
  document.body.append(caption);
  const pointer = document.createElement("div");
  pointer.id = "rec-pointer";
  Object.assign(pointer.style, {
    position: "fixed", left: "960px", top: "560px", width: "26px", height: "26px", zIndex: 100000,
    borderRadius: "50%", background: "rgba(52,211,153,0.35)", border: "3px solid #34d399",
    transform: "translate(-50%,-50%)", transition: "left 0.7s cubic-bezier(.22,1,.36,1), top 0.7s cubic-bezier(.22,1,.36,1), transform 0.15s",
    pointerEvents: "none", opacity: "0",
  });
  document.body.append(pointer);
})()`;

async function caption(text) {
  await js(OVERLAY);
  await js(
    `(() => { const c = document.getElementById("rec-caption"); c.textContent = ${JSON.stringify(text ?? "")}; c.style.opacity = ${text ? "1" : "0"}; })()`,
  );
}

async function pointAt(selector) {
  await js(OVERLAY);
  const box = await js(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: "center", behavior: "smooth" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  if (!box) throw new Error(`element not found: ${selector}`);
  await sleep(450);
  const again = await js(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  await js(
    `(() => { const p = document.getElementById("rec-pointer"); p.style.opacity = "1"; p.style.left = "${again.x}px"; p.style.top = "${again.y}px"; })()`,
  );
  await sleep(750);
}

async function runStep(step) {
  switch (step.action) {
    case "goto":
      await js(`location.hash = ${JSON.stringify(step.hash)}`);
      await sleep(step.ms ?? 1600);
      await js(OVERLAY);
      return;
    case "load":
      await send("Page.navigate", { url: `${BASE}/${step.hash ?? ""}` });
      await sleep(step.ms ?? 3000);
      await js(OVERLAY);
      return;
    case "theme":
      // Storage belongs to the app's origin, so open the app first if needed.
      if (!(await js("location.origin")).startsWith("http")) {
        await send("Page.navigate", { url: `${BASE}/` });
        await sleep(1500);
      }
      await js(`localStorage.setItem("vigil-theme", ${JSON.stringify(step.theme)})`);
      return;
    case "wait":
      await sleep(step.ms);
      return;
    case "click":
      await pointAt(step.selector);
      await js(
        `(() => { const p = document.getElementById("rec-pointer"); p.style.transform = "translate(-50%,-50%) scale(0.75)"; document.querySelector(${JSON.stringify(step.selector)}).click(); setTimeout(() => p.style.transform = "translate(-50%,-50%)", 160); })()`,
      );
      await sleep(step.ms ?? 900);
      return;
    case "type": {
      await pointAt(step.selector);
      await js(`document.querySelector(${JSON.stringify(step.selector)}).focus()`);
      const value = step.env ? process.env[step.env] : step.text;
      if (value === undefined || value === "")
        throw new Error(`no value for a type step (${step.env ?? "text"})`);
      if (step.env) {
        await send("Input.insertText", { text: value });
      } else {
        for (const ch of value) {
          await send("Input.insertText", { text: ch });
          await sleep(step.delay ?? 45);
        }
      }
      await sleep(step.ms ?? 400);
      return;
    }
    case "scroll":
      await js(`window.scrollTo({ top: ${step.y}, behavior: "smooth" })`);
      await sleep(step.ms ?? 1200);
      return;
    case "scrollTo":
      await js(
        `document.querySelector(${JSON.stringify(step.selector)})?.scrollIntoView({ block: ${JSON.stringify(step.block ?? "start")}, behavior: "smooth" })`,
      );
      await sleep(step.ms ?? 1200);
      return;
    case "waitForSelector": {
      const deadline = Date.now() + (step.timeoutMs ?? 30_000);
      while (!(await js(`Boolean(document.querySelector(${JSON.stringify(step.selector)}))`))) {
        if (Date.now() > deadline) {
          const shown = await js(`document.querySelector("main")?.innerText.slice(0, 400)`);
          throw new Error(`timed out waiting for ${step.selector}; the page shows: ${shown}`);
        }
        await sleep(300);
      }
      return;
    }
    case "hidePointer":
      await js(
        `document.getElementById("rec-pointer") && (document.getElementById("rec-pointer").style.opacity = "0")`,
      );
      return;
    case "waitFor": {
      // Waits off camera: frames captured meanwhile are dropped, so the wait is a cut.
      const was = capturing;
      capturing = false;
      const deadline = Date.now() + (step.timeoutMs ?? 120_000);
      while (!(await js(step.js))) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for: ${step.js}`);
        await sleep(2000);
      }
      if (step.reload) {
        await send("Page.reload");
        await sleep(2500);
        await js(OVERLAY);
      }
      capturing = was;
      return;
    }
    default:
      throw new Error(`unknown step ${step.action}`);
  }
}

// ---------- record ----------

const scenes = [];
await send("Page.startScreencast", {
  format: "jpeg",
  quality: 88,
  maxWidth: WIDTH,
  maxHeight: HEIGHT,
  everyNthFrame: 1,
});

for (const [index, scene] of plan.scenes.entries()) {
  sceneIndex = index;
  const voice = scene.narration ? narrate(scene.narration, index) : { file: undefined, seconds: 0 };
  log(
    `scene ${index + 1}/${plan.scenes.length}: ${scene.name ?? ""} (${voice.seconds.toFixed(1)} s narration)`,
  );
  if (scene.card) {
    scenes.push({
      card: join(repo, scene.card),
      voice,
      seconds: Math.max(scene.minSeconds ?? 3, voice.seconds + 0.6),
    });
    continue;
  }
  // Steps marked "before" run off camera, so the scene opens on the right page.
  capturing = false;
  for (const step of scene.before ?? []) await runStep(step);
  await caption(scene.caption);
  capturing = true;
  // A first frame at the start of the scene, even if nothing moves.
  await js(`document.body.style.setProperty("--rec-tick", "${index}")`);
  const started = Date.now();
  for (const step of scene.steps ?? []) await runStep(step);
  const elapsed = (Date.now() - started) / 1000;
  const hold = Math.max(scene.minSeconds ?? 0, voice.seconds + 0.6) - elapsed;
  if (hold > 0) await sleep(hold * 1000);
  // Nudge the page so the screencast emits a closing frame.
  await js(`document.body.style.setProperty("--rec-tick", "${index}-end")`);
  await sleep(120);
  capturing = false;
  scenes.push({ voice, seconds: Math.max((Date.now() - started) / 1000, voice.seconds + 0.6) });
}
await send("Page.stopScreencast");
ws.close();
chrome.kill();

// ---------- build ----------

log(`building video from ${frames.length} frames`);
const parts = [];
for (const [index, scene] of scenes.entries()) {
  const part = join(work, `part-${String(index).padStart(2, "0")}.mp4`);
  const audioArgs = scene.voice.file
    ? [
        "-i",
        scene.voice.file,
        "-af",
        `apad=whole_dur=${scene.seconds.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11`,
      ]
    : ["-f", "lavfi", "-t", scene.seconds.toFixed(3), "-i", "anullsrc=r=48000:cl=mono"];
  const videoFilter = `scale=${OUT_W}:${OUT_H}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2:color=0x09090b,fps=${FPS},format=yuv420p`;
  if (scene.card) {
    execFileSync(FFMPEG, [
      "-y",
      "-loglevel",
      "error",
      // Frame-threaded PNG decoding fails at random in recent ffmpeg builds
      // ("inflate returned error -3"): decode the images on one thread.
      "-threads",
      "1",
      "-loop",
      "1",
      "-t",
      scene.seconds.toFixed(3),
      "-i",
      scene.card,
      ...audioArgs,
      "-vf",
      `${videoFilter},fade=t=in:st=0:d=0.5,fade=t=out:st=${(scene.seconds - 0.5).toFixed(3)}:d=0.5`,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-t",
      scene.seconds.toFixed(3),
      part,
    ]);
  } else {
    const own = frames.filter((f) => f.scene === index);
    if (own.length === 0) throw new Error(`scene ${index + 1} captured no frames`);
    const end = own[0].t + scene.seconds;
    const list = own
      .map((frame, i) => {
        const next = i + 1 < own.length ? own[i + 1].t : end;
        return `file '${frame.file.replaceAll("\\", "/")}'\nduration ${Math.max(1 / FPS, next - frame.t).toFixed(4)}`;
      })
      .join("\n");
    const listFile = join(work, `frames-${index}.txt`);
    writeFileSync(listFile, `${list}\nfile '${own.at(-1).file.replaceAll("\\", "/")}'\n`);
    execFileSync(FFMPEG, [
      "-y",
      "-loglevel",
      "error",
      "-threads",
      "1",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      ...audioArgs,
      "-vf",
      videoFilter,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-t",
      scene.seconds.toFixed(3),
      part,
    ]);
  }
  parts.push(part);
}
const concatList = join(work, "parts.txt");
writeFileSync(concatList, parts.map((p) => `file '${p.replaceAll("\\", "/")}'`).join("\n"));
const output = join(outDir, plan.output ?? `vigil-${sceneName}.mp4`);
execFileSync(FFMPEG, [
  "-y",
  "-loglevel",
  "error",
  "-f",
  "concat",
  "-safe",
  "0",
  "-i",
  concatList,
  "-c",
  "copy",
  "-movflags",
  "+faststart",
  output,
]);
log(`wrote ${output} (${probeSeconds(output).toFixed(1)} s)`);
if (!process.env.KEEP_VIDEO_WORK) rmSync(work, { recursive: true, force: true });
