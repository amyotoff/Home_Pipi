import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Allowlist of command prefixes that skills are permitted to run.
 * Any command not starting with one of these prefixes will be rejected.
 */
const ALLOWED_PREFIXES = [
    'ping', 'nmap', 'traceroute', 'dig', 'nslookup',
    'ip ', 'ip\t', 'arp', 'ss ', 'ss\t',
    'curl', 'wget',
    'cat /proc', 'cat /sys',
    'docker ps', 'docker stats', 'docker logs', 'docker inspect',
    'echo', 'date', 'uptime', 'hostname', 'whoami', 'uname',
    'rfkill', 'hciconfig', 'bluetoothctl',
    'tcpdump', 'netstat', 'ifconfig', 'iwconfig',
    'free', 'df', 'top -bn1', 'ps ',
];

/**
 * Validate that a command is safe to execute.
 * Rejects commands not in allowlist and blocks shell injection operators.
 */
export function validateCommand(command: string): void {
    const cmd = command.trim();

    // Block shell injection operators
    if (/[;`]|\$\(|\$\{|\|\||&&/.test(cmd)) {
        throw new Error(`Command not allowed: shell operators detected`);
    }

    // Block pipe only if it's used with disallowed commands
    // (some allowed commands legitimately use pipes with grep/awk/head)
    const beforePipe = cmd.split('|')[0].trim();

    if (!ALLOWED_PREFIXES.some(p => beforePipe.startsWith(p))) {
        throw new Error(`Command not allowed: ${cmd.split(' ')[0]}`);
    }
}

export async function runCommand(command: string, timeoutMs: number = 10000): Promise<string> {
    validateCommand(command);

    try {
        const { stdout } = await execAsync(command, { timeout: timeoutMs });
        return stdout.trim();
    } catch (err: any) {
        if (err.stdout) return err.stdout.trim();
        throw new Error(`Command failed: ${err.message}`, { cause: err });
    }
}
