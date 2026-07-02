import { spawn } from "node:child_process";
import { readConfig } from "../config.js";

export async function listAvfoundationDevices({ ffmpegPath = "ffmpeg" } = {}) {
  const output = await command(ffmpegPath, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
    allowNonZero: true,
    timeoutMs: 5000
  });
  return parseAvfoundationDevices(output);
}

export function parseAvfoundationDevices(output) {
  const devices = { video: [], audio: [] };
  let section = null;

  for (const line of output.split(/\r?\n/)) {
    if (/AVFoundation video devices/i.test(line)) {
      section = "video";
      continue;
    }
    if (/AVFoundation audio devices/i.test(line)) {
      section = "audio";
      continue;
    }
    if (!section) continue;

    const match = line.match(/\[(\d+)\]\s+(.+)$/);
    if (match) {
      devices[section].push({
        index: Number.parseInt(match[1], 10),
        name: match[2].trim()
      });
    }
  }

  return devices;
}

export function resolveAvfoundationAudioDevice(source, devices) {
  const audioIndex = parseAudioIndex(source);
  if (audioIndex === null) return null;
  return devices.audio.find((device) => device.index === audioIndex) || null;
}

export function looksLikeLoopbackDevice(name) {
  return /blackhole|loopback|soundflower|monitor|virtual/i.test(name || "");
}

export function parseAudioIndex(source) {
  const parts = String(source || "").split(":");
  const audioPart = parts.length > 1 ? parts.at(-1) : parts[0];
  if (audioPart === "" || audioPart === undefined) return null;
  const index = Number.parseInt(audioPart, 10);
  return Number.isInteger(index) ? index : null;
}

function command(bin, args, { allowNonZero = false, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const output = `${stdout}${stderr}`;
      if (code === 0 || allowNonZero) {
        resolve(output);
        return;
      }
      reject(new Error(output.trim().split(/\r?\n/).slice(-3).join(" | ") || `Exited with ${code}.`));
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = readConfig();
  const devices = await listAvfoundationDevices({ ffmpegPath: config.runner.ffmpegPath });
  console.log("AVFoundation audio devices:");
  for (const device of devices.audio) {
    const loopback = looksLikeLoopbackDevice(device.name) ? " loopback-candidate" : "";
    console.log(`  [${device.index}] ${device.name}${loopback}`);
  }
  if (!devices.audio.length) {
    console.log("  none");
  }
}
