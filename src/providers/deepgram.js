const KEEPALIVE_INTERVAL_MS = 8000;
const BYTES_PER_SAMPLE = 2;

export class DeepgramStreamingClient {
  constructor({
    apiKey,
    model = "nova-3",
    language = "multi",
    encoding = "linear16",
    sampleRate = 16000,
    channels = 1,
    keyterms = [],
    extraParams = {},
    endpointing = 300,
    maxReconnectAttempts = 5,
    reconnectBufferSeconds = 60
  }) {
    if (!apiKey) throw new Error("DeepgramStreamingClient requires an API key.");
    this.apiKey = apiKey;
    this.model = model;
    this.language = language;
    this.encoding = encoding;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.keyterms = keyterms;
    this.extraParams = extraParams;
    this.endpointing = endpointing;
    this.maxReconnectAttempts = Math.max(0, Number(maxReconnectAttempts) || 0);
    this.maxBufferedBytes =
      Math.max(1, Number(reconnectBufferSeconds) || 60) * sampleRate * channels * BYTES_PER_SAMPLE;
    this.socket = null;
    this.keepAliveTimer = null;
    this.reconnectTimer = null;
    this.handlers = {};
    this.closing = false;
    this.reconnectAttempts = 0;
    // Wall-clock time of the first audio chunk; segment timestamps are seconds from here.
    this.captureStartMs = null;
    // Deepgram timestamps restart at zero on every new connection, so segments from a
    // reconnected socket must be shifted by where in the meeting that connection began.
    this.streamOffsetSeconds = 0;
    this.pendingChunks = [];
    this.pendingBytes = 0;
    this.pendingStartMs = null;
    this.droppedBytes = 0;
  }

  connect(handlers = {}) {
    this.handlers = handlers;
    this.closing = false;
    return this.openSocket();
  }

  openSocket() {
    if (typeof WebSocket === "undefined") {
      throw new Error("This Node runtime does not expose WebSocket. Use Node 22+.");
    }

    const url = this.buildUrl();
    const socket = new WebSocket(url, ["token", this.apiKey]);
    this.socket = socket;

    const openPromise = new Promise((resolve, reject) => {
      const handleOpen = () => {
        socket.removeEventListener("error", handleOpeningError);
        this.keepAliveTimer = setInterval(() => {
          this.sendControl({ type: "KeepAlive" });
        }, KEEPALIVE_INTERVAL_MS);
        this.reconnectAttempts = 0;
        this.flushPendingAudio();
        this.handlers.onOpen?.();
        resolve();
      };
      const handleOpeningError = (event) => {
        socket.removeEventListener("open", handleOpen);
        reject(event.error || new Error("Deepgram WebSocket failed to open."));
      };
      socket.addEventListener("open", handleOpen, { once: true });
      socket.addEventListener("error", handleOpeningError, { once: true });
    });

    socket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data);
        for (const segment of deepgramResultToSegments(payload, this.streamOffsetSeconds)) {
          this.handlers.onSegment?.(segment, payload);
        }
      } catch (error) {
        this.handlers.onError?.(error);
      }
    });

    socket.addEventListener("error", (event) => {
      this.handlers.onError?.(event.error || new Error("Deepgram WebSocket error."));
    });

    socket.addEventListener("close", () => {
      if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
      if (socket !== this.socket) return;
      this.socket = null;
      if (!this.closing) this.scheduleReconnect();
    });

    return openPromise;
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.closing) return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      this.handlers.onFatal?.(
        new Error(`Deepgram connection lost and ${this.maxReconnectAttempts} reconnect attempts failed.`)
      );
      return;
    }

    const backoffMs = Math.min(15_000, 1000 * 2 ** (this.reconnectAttempts - 1));
    this.handlers.onReconnect?.({ attempt: this.reconnectAttempts, backoffMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // The first audio the new connection hears is the oldest buffered chunk, so its
      // zero-point in meeting time is when that chunk was captured.
      const resumeMs = this.pendingStartMs ?? Date.now();
      this.streamOffsetSeconds = this.captureStartMs
        ? Math.max(0, (resumeMs - this.captureStartMs) / 1000)
        : 0;
      this.openSocket().catch(() => {
        if (!this.closing) this.scheduleReconnect();
      });
    }, backoffMs);
    this.reconnectTimer.unref?.();
  }

  sendAudio(chunk) {
    if (this.closing) return false;
    if (this.captureStartMs === null) this.captureStartMs = Date.now();

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(chunk);
      return true;
    }

    // Buffer audio while disconnected so a reconnect loses (almost) nothing; Deepgram
    // accepts faster-than-realtime audio, so the backlog is flushed on reopen.
    if (this.pendingStartMs === null) this.pendingStartMs = Date.now();
    const chunkBytes = chunk.length ?? chunk.byteLength ?? 0;
    this.pendingChunks.push(chunk);
    this.pendingBytes += chunkBytes;
    const bytesPerSecond = this.sampleRate * this.channels * BYTES_PER_SAMPLE;
    while (this.pendingBytes > this.maxBufferedBytes && this.pendingChunks.length > 1) {
      const dropped = this.pendingChunks.shift();
      const droppedBytes = dropped.length ?? dropped.byteLength ?? 0;
      this.pendingBytes -= droppedBytes;
      this.droppedBytes += droppedBytes;
      this.pendingStartMs += (droppedBytes / bytesPerSecond) * 1000;
    }
    return false;
  }

  flushPendingAudio() {
    if (!this.pendingChunks.length) return;
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    for (const chunk of this.pendingChunks) {
      this.socket.send(chunk);
    }
    this.pendingChunks = [];
    this.pendingBytes = 0;
    this.pendingStartMs = null;
  }

  sendControl(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  async close({ drainTimeoutMs = 5000 } = {}) {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      socket?.close();
      this.socket = null;
      return;
    }

    // Deepgram sends the remaining final results after CloseStream and then closes the
    // socket itself; closing immediately would drop the last utterances of the meeting.
    this.flushPendingAudio();
    this.sendControl({ type: "CloseStream" });
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        socket.close();
        resolve();
      }, drainTimeoutMs);
      timer.unref?.();
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
    this.socket = null;
  }

  buildUrl() {
    const url = new URL("wss://api.deepgram.com/v1/listen");
    url.searchParams.set("model", this.model);
    url.searchParams.set("language", this.language);
    url.searchParams.set("encoding", this.encoding);
    url.searchParams.set("sample_rate", String(this.sampleRate));
    url.searchParams.set("channels", String(this.channels));
    url.searchParams.set("smart_format", "true");
    url.searchParams.set("punctuate", "true");
    url.searchParams.set("diarize", "true");
    url.searchParams.set("interim_results", "false");
    url.searchParams.set("utterances", "true");
    url.searchParams.set("endpointing", String(this.endpointing));
    for (const keyterm of this.keyterms) {
      url.searchParams.append("keyterm", keyterm);
    }
    for (const [key, value] of Object.entries(this.extraParams)) {
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, item);
      } else {
        url.searchParams.set(key, value);
      }
    }
    return url;
  }
}

export function deepgramResultToSegments(payload, offsetSeconds = 0) {
  if (payload?.type !== "Results" || !payload.is_final) return [];
  const alternative = payload.channel?.alternatives?.[0];
  const transcript = alternative?.transcript?.trim();
  if (!transcript) return [];

  const words = Array.isArray(alternative.words) ? alternative.words : [];
  if (!words.length) {
    return [
      {
        id: crypto.randomUUID(),
        speaker: "Speaker Unknown",
        start: offsetSeconds + Number(payload.start || 0),
        end: offsetSeconds + Number((payload.start || 0) + (payload.duration || 0)),
        text: transcript,
        language: payload.metadata?.detected_language || "multi",
        confidence: Number(alternative.confidence || 0),
        lowConfidenceWords: []
      }
    ];
  }

  // Deepgram tags every word with a speaker, and one Results payload regularly contains
  // a speaker change mid-utterance. Split into one segment per consecutive-speaker run
  // instead of attributing the whole payload to whoever spoke the first word.
  const runs = [];
  for (const word of words) {
    const speaker = Number.isInteger(word.speaker) ? word.speaker : null;
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun.speaker === speaker) {
      lastRun.words.push(word);
    } else {
      runs.push({ speaker, words: [word] });
    }
  }

  return runs
    .map((run) => {
      const first = run.words[0];
      const last = run.words[run.words.length - 1];
      const text = run.words
        .map((word) => String(word.punctuated_word || word.word || "").trim())
        .filter(Boolean)
        .join(" ");
      return {
        id: crypto.randomUUID(),
        speaker: run.speaker === null ? "Speaker Unknown" : `Speaker ${run.speaker + 1}`,
        start: offsetSeconds + Number(first.start ?? payload.start ?? 0),
        end: offsetSeconds + Number(last.end ?? first.start ?? 0),
        text,
        language: payload.metadata?.detected_language || "multi",
        confidence: averageConfidence(run.words),
        lowConfidenceWords: lowConfidenceWords(run.words)
      };
    })
    .filter((segment) => segment.text);
}

function averageConfidence(words) {
  if (!words.length) return 0;
  const total = words.reduce((sum, word) => sum + Number(word.confidence || 0), 0);
  return total / words.length;
}

function lowConfidenceWords(words) {
  return words
    .filter((word) => Number(word.confidence || 0) > 0 && Number(word.confidence || 0) < 0.75)
    .slice(0, 12)
    .map((word) => ({
      word: String(word.punctuated_word || word.word || "").trim(),
      confidence: Number(word.confidence || 0)
    }))
    .filter((word) => word.word);
}
