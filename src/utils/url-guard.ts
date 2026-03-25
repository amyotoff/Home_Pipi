import { URL } from 'url';
import dns from 'dns';
import { promisify } from 'util';
import net from 'net';

const dnsResolve = promisify(dns.resolve4);

/**
 * Private / reserved IP ranges that browser tools must NOT access.
 * Prevents SSRF attacks where the LLM tries to reach internal services.
 */
const PRIVATE_RANGES: Array<{ network: number; mask: number; label: string }> = [
    // 10.0.0.0/8
    { network: 0x0A000000, mask: 0xFF000000, label: '10.0.0.0/8' },
    // 172.16.0.0/12
    { network: 0xAC100000, mask: 0xFFF00000, label: '172.16.0.0/12' },
    // 192.168.0.0/16
    { network: 0xC0A80000, mask: 0xFFFF0000, label: '192.168.0.0/16' },
    // 127.0.0.0/8 (loopback)
    { network: 0x7F000000, mask: 0xFF000000, label: '127.0.0.0/8' },
    // 169.254.0.0/16 (link-local)
    { network: 0xA9FE0000, mask: 0xFFFF0000, label: '169.254.0.0/16' },
    // 0.0.0.0/8 (this network)
    { network: 0x00000000, mask: 0xFF000000, label: '0.0.0.0/8' },
];

/**
 * Blocked hostnames and TLDs.
 */
const BLOCKED_HOST_PATTERNS = [
    /^localhost$/i,
    /\.local$/i,         // mDNS hostnames
    /\.internal$/i,      // internal hostnames
    /\.home$/i,          // home network
    /\.lan$/i,           // LAN hostnames
    /\.localdomain$/i,   // local domain
];

/**
 * Allowed URL schemes.
 */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * Convert IPv4 string to 32-bit unsigned integer.
 */
function ipToInt(ip: string): number {
    const parts = ip.split('.').map(Number);
    // Use multiplication instead of bit shifts to avoid signed int32 issues
    return (parts[0] * 0x1000000 + parts[1] * 0x10000 + parts[2] * 0x100 + parts[3]) >>> 0;
}

/**
 * Check if an IPv4 address is in a private/reserved range.
 */
function isPrivateIP(ip: string): boolean {
    if (!net.isIPv4(ip)) return false;
    const ipInt = ipToInt(ip);
    return PRIVATE_RANGES.some(r => ((ipInt & r.mask) >>> 0) === (r.network >>> 0));
}

/**
 * Check if an IPv6 address is loopback or link-local.
 */
function isPrivateIPv6(ip: string): boolean {
    if (!net.isIPv6(ip)) return false;
    const normalized = ip.toLowerCase();
    // ::1 loopback
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
    // fe80::/10 link-local
    if (normalized.startsWith('fe80:')) return true;
    // fc00::/7 unique local
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    return false;
}

/**
 * Assert that a URL is safe to browse — i.e. it points to a public host.
 * Throws if the URL would access local/private network resources.
 *
 * Checks:
 * 1. URL scheme must be http or https
 * 2. Hostname must not be localhost, .local, or other reserved names
 * 3. IP addresses (direct or resolved) must not be in private ranges
 *
 * @param urlString - The URL to validate
 * @throws Error if the URL is not safe to browse
 */
export async function assertPublicUrl(urlString: string): Promise<void> {
    let parsed: URL;
    try {
        parsed = new URL(urlString);
    } catch {
        throw new Error(`Invalid URL: ${urlString}`);
    }

    // 1. Scheme check
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
        throw new Error(`Blocked URL scheme: ${parsed.protocol} — only http/https allowed`);
    }

    const hostname = parsed.hostname;

    // 2. Strip brackets from IPv6 literal
    const cleanHost = hostname.replace(/^\[|\]$/g, '');

    // 3. Direct IP check
    if (net.isIPv4(cleanHost)) {
        if (isPrivateIP(cleanHost)) {
            throw new Error(`Blocked: ${cleanHost} is a private/local IP address`);
        }
        return; // Public IPv4 — OK
    }

    if (net.isIPv6(cleanHost)) {
        if (isPrivateIPv6(cleanHost)) {
            throw new Error(`Blocked: ${cleanHost} is a private/local IPv6 address`);
        }
        return; // Public IPv6 — OK
    }

    // 4. Blocked hostname patterns
    for (const pattern of BLOCKED_HOST_PATTERNS) {
        if (pattern.test(hostname)) {
            throw new Error(`Blocked hostname: ${hostname} — local/internal hostnames are not allowed`);
        }
    }

    // 5. DNS resolution check — ensure hostname doesn't resolve to private IP
    try {
        const ips = await dnsResolve(hostname);
        for (const ip of ips) {
            if (isPrivateIP(ip)) {
                throw new Error(`Blocked: ${hostname} resolves to private IP ${ip} (DNS rebinding protection)`);
            }
        }
    } catch (err: any) {
        // If DNS fails for non-resolution reasons, allow the request
        // (the browser will fail on its own with a clear error)
        if (err.message?.includes('Blocked')) throw err;
        // DNS resolution failure is OK — browser will handle it
    }
}

// Export for testing
export { isPrivateIP, isPrivateIPv6, BLOCKED_HOST_PATTERNS };
