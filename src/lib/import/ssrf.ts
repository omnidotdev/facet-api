/**
 * SSRF guards for the import proxy. A user-supplied URL is fetched server-side,
 * so it must never be allowed to reach internal or cloud-metadata addresses. The
 * host is resolved and EVERY resolved IP is checked against the blocked ranges
 * (this also closes the common DNS-rebind hole where a name resolves public once
 * for the check and private for the fetch, as long as the caller fetches by the
 * resolved IPs; see fetchImport). A literal-IP host is checked directly.
 *
 * Residual caveat: a TOCTOU rebind between this resolution and a fetch-by-name is
 * only fully closed by connecting to the pinned IP. fetchImport pins the checked
 * IP where the runtime allows it; otherwise this is defense-in-depth, not a proof.
 */

/** A user-safe import failure. The message is generic; detail is logged server-side. */
export class ImportError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ImportError";
    this.status = status;
  }
}

/** Parse a dotted IPv4 string to a 32-bit unsigned int, or null if not IPv4. */
function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return (
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  );
}

/** Whether a 32-bit IPv4 address falls in `base/bits`. */
function inV4Cidr(ip: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base);
  if (b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (b & mask);
}

// Non-public IPv4 ranges: loopback, private, link-local (incl. 169.254.169.254
// metadata), CGNAT, this-host, protocol assignments, benchmarking, multicast,
// reserved, and broadcast.
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];

function isBlockedV4(ip: number): boolean {
  return V4_BLOCKED.some(([base, bits]) => inV4Cidr(ip, base, bits));
}

/**
 * Whether an IP (v4 or v6) is outside the public internet and must not be
 * fetched. Unparseable input is treated as blocked (fail closed).
 */
export function isBlockedIp(ip: string): boolean {
  const raw = ip.trim().toLowerCase();

  const v4 = ipv4ToInt(raw);
  if (v4 !== null) return isBlockedV4(v4);

  // IPv4-mapped / -compatible IPv6: pull out the trailing dotted-quad and judge it
  const mapped = raw.match(
    /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
  );
  if (mapped) {
    const inner = ipv4ToInt(mapped[1]);
    return inner === null ? true : isBlockedV4(inner);
  }

  if (!raw.includes(":")) return true; // neither valid v4 nor v6: fail closed

  if (raw === "::1" || raw === "::") return true; // loopback / unspecified
  // ULA fc00::/7 (fc.. or fd..) and link-local fe80::/10
  const head = raw.split(":")[0];
  if (/^f[cd][0-9a-f]{0,2}$/.test(head)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]?$/.test(head)) return true; // fe80::/10
  return false;
}

/**
 * Validate a user URL for the import proxy and resolve its host. Rejects a
 * non-http(s) scheme, embedded credentials, a literal blocked IP, a host that
 * does not resolve, and any host that resolves to a blocked IP. Returns the
 * parsed URL on success.
 */
export async function assertPublicUrl(
  rawUrl: string,
  resolveHost: (hostname: string) => Promise<string[]>,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ImportError("That does not look like a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new ImportError("Only http(s) URLs can be imported.");
  if (url.username || url.password)
    throw new ImportError("URLs with embedded credentials are not allowed.");

  // A bracketed IPv6 or dotted IPv4 literal host is judged directly, never resolved
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = ipv4ToInt(host) !== null || host.includes(":");
  if (literal) {
    if (isBlockedIp(host))
      throw new ImportError("That address is not allowed.", 403);
    return url;
  }

  const ips = await resolveHost(host);
  if (ips.length === 0)
    throw new ImportError("Could not resolve that host.", 400);
  if (ips.some((ip) => isBlockedIp(ip)))
    throw new ImportError("That host is not allowed.", 403);
  return url;
}
