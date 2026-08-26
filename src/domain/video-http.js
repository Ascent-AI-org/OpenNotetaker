// The HTTP edge of video: reading an octet-stream upload from the recording worker, and
// serving a file back with the byte-range handling a player needs to scrub.
import { pipeline } from "node:stream";
import { parseRangeHeader } from "./http-range.js";

// Matches the chunk cap on POST /api/runner/meetings/:id/video. Callers pass their own
// limit; this only keeps a caller that forgets from becoming unbounded.
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

// Client aborts are the normal shape of video traffic, not faults: a browser opens a
// range per scrub and drops the ones the user seeks past. Logging them would bury real
// stream errors under a line per seek.
const DISCONNECT_CODES = new Set(["ECONNRESET", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE", "ERR_STREAM_DESTROYED"]);

// Unlike readJsonBody in server.js there is nothing to parse — the caller wants the raw
// bytes — but the cap has to work the same way: measured on the running total, because a
// chunked upload declares no Content-Length and buffering first to measure afterwards is
// exactly the memory exhaustion the cap exists to prevent.
//
// On refusal the request is paused, never destroyed. Destroying it resets the socket out
// from under the 413 that is still being written and the client sees a connection error
// instead of the reason it was rejected. The unread bytes left on the socket are the
// caller's problem to close over: server.js already sets Connection: close on any
// response written before the body was fully read, which stops those bytes from being
// parsed as the next request on that connection.
export async function readRawBody(request, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const declared = Number(request.headers?.["content-length"]);
  // A body that announces itself as oversize is refused without reading a byte of it.
  if (Number.isSafeInteger(declared) && declared > maxBytes) throw tooLargeError(maxBytes);

  // Called after something else already drained the request. Waiting on an 'end' that
  // has already fired would hang the handler until the server timeout kills it.
  if (request.readableEnded) return Buffer.alloc(0);

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const settle = (finish, value) => {
      if (settled) return;
      settled = true;
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("close", onClose);
      finish(value);
    };

    function onData(chunk) {
      size += chunk.length;
      if (size > maxBytes) {
        request.pause();
        settle(reject, tooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      settle(resolve, Buffer.concat(chunks, size));
    }

    function onError(error) {
      settle(reject, error);
    }

    function onClose() {
      // 'end' fires first on a complete body, so reaching close without it means the
      // client hung up mid-upload. Resolving here would hand the caller a truncated
      // chunk to append at an offset it does not actually cover.
      if (!request.readableEnded) settle(reject, abortedError());
    }

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("close", onClose);
  });
}

// `stream` is either a factory called with the resolved { start, end } window — the form
// to prefer, since it opens no file descriptor for a HEAD or a 416 — or a readable that
// ALREADY covers exactly the window this function computes for the same rangeHeader and
// size. Handing in a whole-file readable alongside a Range header sends more bytes than
// the Content-Length claims, and the surplus is read as the next response on a keep-alive
// connection; use the factory form and that cannot happen.
export function serveFileWithRange(response, { stream, size, rangeHeader, contentType, extraHeaders, method } = {}) {
  // A size that is not a real byte count collapses to an empty body rather than framing
  // a response around NaN, which would put a Content-Length the client cannot parse on
  // the wire and desynchronise the connection.
  const total = Number.isSafeInteger(size) && size >= 0 ? size : 0;
  const isHead = String(method || "GET").toUpperCase() === "HEAD";
  const range = parseRangeHeader(rangeHeader, total);

  const base = {
    // Ahead of extraHeaders so a caller can loosen it deliberately (a public clip link
    // wants its own directives) but never leaks a private recording into a shared cache
    // by forgetting to set anything.
    "Cache-Control": "private, no-store",
    ...(extraHeaders || {}),
    // Computed last: nothing a caller passes may rewrite the framing or drop the sniff
    // guard. A video/mp4 a browser is free to re-type as HTML is stored XSS on the
    // public share route, where the viewer is not even signed in.
    "Content-Type": contentType || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff"
  };

  if (range?.unsatisfiable) {
    destroyStream(stream);
    response.writeHead(416, { ...base, "Content-Range": `bytes */${total}`, "Content-Length": 0 });
    response.end();
    return { statusCode: 416, start: 0, end: -1, bytes: 0 };
  }

  // A zero-byte file has no satisfiable range, so a Range request already left through
  // the 416 above; what reaches here is a plain GET, answered without opening anything.
  if (total === 0) {
    destroyStream(stream);
    response.writeHead(200, { ...base, "Content-Length": 0 });
    response.end();
    return { statusCode: 200, start: 0, end: -1, bytes: 0 };
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;
  const bytes = end - start + 1;
  const statusCode = range ? 206 : 200;
  const headers = { ...base, "Content-Length": bytes };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${total}`;

  if (isHead) {
    // A player probes with HEAD to learn the length and whether ranges are supported.
    destroyStream(stream);
    response.writeHead(statusCode, headers);
    response.end();
    return { statusCode, start, end, bytes };
  }

  // Opened before the status line goes out: a factory that throws here still leaves the
  // caller free to answer 404/500, which it would not once headers were sent.
  const body = typeof stream === "function" ? stream({ start, end }) : stream;
  response.writeHead(statusCode, headers);
  // pipeline, not pipe: when the viewer abandons a range mid-transfer the response closes
  // early and pipeline destroys the file handle behind it. pipe leaves that handle open,
  // and a few minutes of someone dragging a scrubber exhausts the process fd limit.
  pipeline(body, response, (error) => {
    if (!error || DISCONNECT_CODES.has(error.code)) return;
    console.error(error);
  });
  return { statusCode, start, end, bytes };
}

function destroyStream(stream) {
  if (stream && typeof stream.destroy === "function") stream.destroy();
}

function tooLargeError(maxBytes) {
  const error = new Error(`Request body exceeds ${maxBytes} bytes.`);
  error.code = "too_large";
  error.statusCode = 413;
  error.maxBytes = maxBytes;
  return error;
}

function abortedError() {
  const error = new Error("Client closed the connection before the body was fully sent.");
  error.code = "client_aborted";
  error.statusCode = 400;
  return error;
}
