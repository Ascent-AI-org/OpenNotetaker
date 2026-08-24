// Resolving the client address is a security decision, not plumbing: this value is the
// key every rate limiter counts against. Read a forgeable header and an attacker rotates
// their own key at will, defeating the limits entirely; ignore a real reverse proxy and
// the whole team collapses into one bucket, so one person's retries lock everyone out.
//
// The hop count is therefore explicit configuration (TRUST_PROXY_HOPS) rather than
// something inferred from the request. With N > 0 we take the entry N from the right of
// X-Forwarded-For — the address the outermost proxy we trust actually observed — and
// everything to its left, which the client fully controls, is ignored.
//
// Fails closed to the socket address whenever reality does not match the declared shape:
// no header, a malformed one, or fewer entries than there are configured hops.
export function resolveClientIp(request, trustProxyHops = 0) {
  const hops = Number.isInteger(trustProxyHops) && trustProxyHops > 0 ? trustProxyHops : 0;
  if (hops > 0) {
    const forwarded = String(request?.headers?.["x-forwarded-for"] || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (forwarded.length >= hops) return forwarded[forwarded.length - hops];
  }
  return request?.socket?.remoteAddress || "unknown";
}
