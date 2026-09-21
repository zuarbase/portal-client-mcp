// Transport failure handling for the upstream portal connections.
//
// Each portal is reached through the SDK's StreamableHTTPClientTransport,
// which calls Node's global fetch (undici). undici reports every
// connection-level failure as a bare `TypeError: fetch failed` and keeps
// the useful part — the socket error and its code — in `cause`. This
// module reads that chain, tells a request that never left from one
// that may have been delivered, and tracks a cooldown during which
// pooled keep-alive sockets are treated as suspect.

export type TransportFailure = "never-sent" | "ambiguous" | "not-transport";

/** The request provably never reached the portal: safe to repeat anything. */
const NEVER_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/** The connection broke at a point where the request may have been delivered. */
const AMBIGUOUS_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** How long pooled sockets stay suspect after a connection-level failure. */
export const POOL_COOLDOWN_MS = 60_000;

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
  errors?: unknown;
}

function isErrorLike(value: unknown): value is ErrorLike {
  return typeof value === "object" && value !== null;
}

/** The link's own code, or the first inner code of an AggregateError. */
function codeOf(link: ErrorLike): string | undefined {
  if (typeof link.code === "string") return link.code;
  if (Array.isArray(link.errors)) {
    for (const inner of link.errors) {
      if (isErrorLike(inner) && typeof inner.code === "string") return inner.code;
    }
  }
  return undefined;
}

function messageOf(link: ErrorLike): string {
  if (typeof link.message === "string" && link.message) return link.message;
  // An AggregateError (one connect attempt per address family) has no
  // message of its own; its inner errors carry the detail.
  if (Array.isArray(link.errors)) {
    return link.errors
      .map((inner) => (isErrorLike(inner) ? messageOf(inner) : String(inner)))
      .filter(Boolean)
      .join("; ");
  }
  return "";
}

/** `err` followed by its `cause` chain, guarded against cycles. */
function causeChain(err: unknown): ErrorLike[] {
  const links: ErrorLike[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (isErrorLike(current) && !seen.has(current) && links.length < 10) {
    seen.add(current);
    links.push(current);
    current = current.cause;
  }
  return links;
}

/**
 * The error's name and message, then the codes and messages of its
 * cause chain in parentheses: `TypeError: fetch failed (ECONNRESET:
 * socket hang up)`. Non-errors are stringified as they are.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const [head, ...causes] = causeChain(err);
  const name = typeof head.name === "string" && head.name ? head.name : "Error";
  const message = messageOf(head);
  const details = causes
    .map((link) => {
      const code = codeOf(link);
      const text = messageOf(link);
      if (code && text) return `${code}: ${text}`;
      return code ?? text;
    })
    .filter(Boolean);
  let text = message ? `${name}: ${message}` : name;
  if (details.length > 0) text += ` (${details.join("; ")})`;
  return text;
}

/**
 * Where a failed upstream call stands. The deepest code in the cause
 * chain decides; a `fetch failed` TypeError or an AbortError without a
 * recognizable code is a broken connection of unknown timing. Anything
 * the portal itself answered — an MCP protocol error, a tool refusal,
 * an HTTP status error from the SDK — is not a transport failure.
 */
export function classifyTransportFailure(err: unknown): TransportFailure {
  const links = causeChain(err);
  let deepest: string | undefined;
  for (const link of links) deepest = codeOf(link) ?? deepest;
  if (deepest !== undefined) {
    if (NEVER_SENT_CODES.has(deepest)) return "never-sent";
    if (AMBIGUOUS_CODES.has(deepest)) return "ambiguous";
  }
  const connectionBroke = links.some(
    (link) =>
      (link.name === "TypeError" && link.message === "fetch failed") ||
      link.name === "AbortError",
  );
  return connectionBroke ? "ambiguous" : "not-transport";
}

/** Thrown for a call that failed after its request may have reached the portal. */
export class AmbiguousDeliveryError extends Error {
  constructor(cause: unknown) {
    super(`request may have been delivered (${describeError(cause)})`, { cause });
    this.name = "AmbiguousDeliveryError";
  }
}

/**
 * The tool result for a call whose connection broke after the request
 * was sent: what failed, why, and what to check before repeating it.
 * The client does not know which tools write, so the advice is the
 * same for every tool; a read is simply safe to repeat. The entity
 * words come from the call's own arguments and are left out when absent.
 */
export function ambiguousDeliveryMessage(
  tool: string,
  alias: string,
  args: Record<string, unknown>,
  cause: unknown,
): string {
  const entity = [args.entity_type, args.id]
    .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
    .map(String)
    .join(" ");
  const target = entity ? ` for ${entity}` : "";
  return (
    `${tool} on ${alias}: the connection broke after the request was sent ` +
    `(${describeError(cause)}), so it may have been delivered. Repeat a read ` +
    `as is. Before repeating a write, check whether it applied: ` +
    `list_change_sets${target}, newest first; after a create_entity, ` +
    `list_entities by the name you sent.`
  );
}

let socketsSuspectUntil = 0;

/** Record a connection-level failure: pooled sockets are suspect for POOL_COOLDOWN_MS. */
export function noteConnectionFailure(now: number = Date.now()): void {
  socketsSuspectUntil = Math.max(socketsSuspectUntil, now + POOL_COOLDOWN_MS);
}

/** True while a recent connection-level failure makes pooled keep-alive sockets suspect. */
export function pooledSocketsSuspect(now: number = Date.now()): boolean {
  return now < socketsSuspectUntil;
}
