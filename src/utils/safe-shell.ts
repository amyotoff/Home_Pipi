import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Whitelist of allowed binaries for LLM-facing tools.
 * Each entry maps a short name to the full binary path + allowed argument prefixes.
 */
const ALLOWED_BINARIES: Record<string, { path: string; description: string }> = {
    'ping':            { path: '/usr/bin/ping',       description: 'ICMP ping' },
    'nmap':            { path: '/usr/bin/nmap',        description: 'Port scanner' },
    'traceroute':      { path: '/usr/bin/traceroute',  description: 'Trace route' },
    'dig':             { path: '/usr/bin/dig',         description: 'DNS lookup' },
    'nslookup':        { path: '/usr/bin/nslookup',    description: 'DNS lookup' },
    'arp':             { path: '/usr/sbin/arp',        description: 'ARP table' },
    'ip':              { path: '/sbin/ip',             description: 'Network config' },
    'ss':              { path: '/usr/bin/ss',          description: 'Socket stats' },
    'tcpdump':         { path: '/usr/bin/tcpdump',     description: 'Packet capture' },
    'docker':          { path: '/usr/bin/docker',      description: 'Docker CLI' },
    'timeout':         { path: '/usr/bin/timeout',     description: 'Command timeout wrapper' },
    'free':            { path: '/usr/bin/free',        description: 'Memory stats' },
    'df':              { path: '/usr/bin/df',          description: 'Disk usage' },
    'uptime':          { path: '/usr/bin/uptime',      description: 'System uptime' },
    'hostname':        { path: '/usr/bin/hostname',    description: 'Hostname' },
    'uname':           { path: '/usr/bin/uname',       description: 'System info' },
    'rfkill':          { path: '/usr/sbin/rfkill',     description: 'RF kill switch' },
    'hciconfig':       { path: '/usr/bin/hciconfig',   description: 'Bluetooth config' },
    'bluetoothctl':    { path: '/usr/bin/bluetoothctl', description: 'Bluetooth control' },
    'hcitool':         { path: '/usr/bin/hcitool',     description: 'Bluetooth tools' },
    'l2ping':          { path: '/usr/bin/l2ping',      description: 'Bluetooth L2CAP ping' },
    'journalctl':      { path: '/usr/bin/journalctl',  description: 'Systemd journal' },
    'iwconfig':        { path: '/sbin/iwconfig',       description: 'WiFi config' },
    'cat':             { path: '/usr/bin/cat',         description: 'Read file (restricted)' },
    'systemctl':       { path: '/usr/bin/systemctl',   description: 'Systemd control' },
};

/** Characters that should never appear in individual arguments */
const DANGEROUS_CHARS = /[;`${}|&<>]/;

/**
 * Validate a single argument for shell injection patterns.
 */
function validateArg(arg: string): void {
    if (DANGEROUS_CHARS.test(arg)) {
        throw new Error(`Argument contains dangerous characters: "${arg}"`);
    }
}

/**
 * Restricted paths for `cat` — only /proc and /sys are allowed.
 */
const CAT_ALLOWED_PREFIXES = ['/proc/', '/sys/'];

/**
 * Docker subcommands that are read-only and safe.
 */
const DOCKER_SAFE_SUBCOMMANDS = ['ps', 'stats', 'logs', 'inspect', 'restart'];

/**
 * Run a command using execFile (no shell) with binary whitelist validation.
 *
 * @param bin  - Short binary name from ALLOWED_BINARIES (e.g. 'ping', 'nmap')
 * @param args - Array of arguments (each validated individually)
 * @param timeoutMs - Execution timeout in milliseconds (default 10000)
 * @returns stdout trimmed
 */
export async function runSafeCommand(
    bin: string,
    args: string[],
    timeoutMs: number = 10000,
): Promise<string> {
    const entry = ALLOWED_BINARIES[bin];
    if (!entry) {
        throw new Error(`Binary not in whitelist: "${bin}". Allowed: ${Object.keys(ALLOWED_BINARIES).join(', ')}`);
    }

    // Validate each argument
    for (const arg of args) {
        validateArg(arg);
    }

    // Per-binary restrictions
    if (bin === 'cat') {
        const filePath = args[args.length - 1];
        if (!filePath || !CAT_ALLOWED_PREFIXES.some(p => filePath.startsWith(p))) {
            throw new Error(`cat is only allowed for ${CAT_ALLOWED_PREFIXES.join(', ')} paths`);
        }
    }

    if (bin === 'docker') {
        const subcommand = args[0];
        if (!subcommand || !DOCKER_SAFE_SUBCOMMANDS.includes(subcommand)) {
            throw new Error(`docker subcommand "${subcommand}" not allowed. Safe: ${DOCKER_SAFE_SUBCOMMANDS.join(', ')}`);
        }
    }

    try {
        const { stdout } = await execFileAsync(entry.path, args, { timeout: timeoutMs });
        return stdout.trim();
    } catch (err: any) {
        // If killed by timeout, always throw
        if (err.killed) {
            throw new Error(`Command timed out after ${timeoutMs}ms: ${bin} ${args.join(' ')}`, { cause: err });
        }
        if (err.stdout) return err.stdout.trim();
        throw new Error(`Command failed: ${bin} ${args.join(' ')}: ${err.message}`, { cause: err });
    }
}

/**
 * Check if a binary is in the whitelist.
 */
export function isBinaryAllowed(bin: string): boolean {
    return bin in ALLOWED_BINARIES;
}

/**
 * Get list of allowed binary names (for error messages / documentation).
 */
export function getAllowedBinaries(): string[] {
    return Object.keys(ALLOWED_BINARIES);
}
