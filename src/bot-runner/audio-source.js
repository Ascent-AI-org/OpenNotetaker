import { spawn } from "node:child_process";

export class FfmpegAudioSource {
  constructor({ ffmpegPath = "ffmpeg", driver = "pulse", source = "default" } = {}) {
    this.ffmpegPath = ffmpegPath;
    this.driver = driver;
    this.source = source;
    this.process = null;
    this.bytesCaptured = 0;
    this.lastStderr = "";
  }

  start(onChunk, { onExit, onStderr } = {}) {
    if (this.process) throw new Error("Audio capture is already running.");
    this.bytesCaptured = 0;
    this.lastStderr = "";
    const args = this.buildArgs();
    this.process = spawn(this.ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.process.stdout.on("data", (chunk) => {
      this.bytesCaptured += chunk.length;
      onChunk(chunk);
    });
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk) => {
      const line = String(chunk).trim();
      if (!line) return;
      this.lastStderr = line.slice(-1000);
      onStderr?.(this.lastStderr);
      console.error(`[ffmpeg] ${line.slice(0, 500)}`);
    });

    this.process.on("exit", (code, signal) => {
      console.log(`audio capture exited with code ${code ?? "none"} and signal ${signal ?? "none"}`);
      onExit?.({
        code,
        signal,
        bytesCaptured: this.bytesCaptured,
        lastStderr: this.lastStderr
      });
      this.process = null;
    });

    return this.process;
  }

  stop() {
    if (!this.process) return;
    this.process.kill("SIGTERM");
    this.process = null;
  }

  buildArgs() {
    const output = ["-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"];
    if (this.driver === "pulse") {
      return ["-hide_banner", "-loglevel", "warning", "-f", "pulse", "-i", this.source, ...output];
    }
    if (this.driver === "avfoundation") {
      return ["-hide_banner", "-loglevel", "warning", "-f", "avfoundation", "-i", this.source, ...output];
    }
    throw new Error(`Unsupported AUDIO_CAPTURE_DRIVER: ${this.driver}.`);
  }
}
