import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { readConfig } from "../config.js";
import { FfmpegAudioSource } from "./audio-source.js";
import {
  listAvfoundationDevices,
  looksLikeLoopbackDevice,
  resolveAvfoundationAudioDevice
} from "./audio-devices.js";

const config = readConfig();

const checks = [];
await check("RUNNER_TOKEN is set", async () => {
  if (!config.runner.token) throw new Error("RUNNER_TOKEN is missing.");
});

await check("DEEPGRAM_API_KEY is set", async () => {
  if (!config.stt.deepgram.apiKey) throw new Error("DEEPGRAM_API_KEY is missing.");
});

await check("Chrome executable is available", async () => {
  if (!config.runner.chromeExecutablePath) return;
  await access(config.runner.chromeExecutablePath, constants.X_OK);
});

await check("ffmpeg executable is available", async () => {
  await command(config.runner.ffmpegPath, ["-version"], { timeoutMs: 3000 });
});

await check("Configured audio source opens", async () => {
  const audioSource = new FfmpegAudioSource({
    ffmpegPath: config.runner.ffmpegPath,
    driver: config.runner.audioCaptureDriver,
    source: config.runner.audioCaptureSource
  });
  const args = audioSource.buildArgs();
  const probeArgs = ["-t", "1", ...args.slice(0, -1), "-f", "null", "-"];
  await command(config.runner.ffmpegPath, probeArgs, { timeoutMs: 5000 });
});

await check("Configured audio source looks like loopback", async () => {
  if (config.runner.audioCaptureDriver !== "avfoundation") return;
  const devices = await listAvfoundationDevices({ ffmpegPath: config.runner.ffmpegPath });
  const selected = resolveAvfoundationAudioDevice(config.runner.audioCaptureSource, devices);
  if (!selected) {
    throw new Error(`No AVFoundation audio device matches AUDIO_CAPTURE_SOURCE=${config.runner.audioCaptureSource}.`);
  }
  if (!looksLikeLoopbackDevice(selected.name)) {
    throw new Error(
      `AUDIO_CAPTURE_SOURCE=${config.runner.audioCaptureSource} maps to "${selected.name}", not a loopback device. ` +
      "Install/configure BlackHole, Loopback, or a virtual monitor source for reliable Meet audio."
    );
  }
}, { level: "warn" });

for (const item of checks) {
  const marker = item.ok ? "PASS" : item.level === "warn" ? "WARN" : "FAIL";
  console.log(`${marker} ${item.name}${item.error ? `: ${item.error}` : ""}`);
}

if (checks.some((item) => !item.ok && item.level !== "warn")) {
  process.exitCode = 1;
}

async function check(name, fn, { level = "fail" } = {}) {
  try {
    await fn();
    checks.push({ name, ok: true, level });
  } catch (error) {
    checks.push({ name, ok: false, level, error: error.message });
  }
}

function command(bin, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim().split(/\r?\n/).slice(-3).join(" | ") || `Exited with ${code}.`));
    });
  });
}
