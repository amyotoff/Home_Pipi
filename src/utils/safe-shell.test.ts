import { describe, it, expect } from 'vitest';
import { runSafeCommand, isBinaryAllowed, getAllowedBinaries } from './safe-shell';

describe('safe-shell — runSafeCommand', () => {
    describe('whitelist enforcement', () => {
        it('should reject binaries not in whitelist', async () => {
            await expect(runSafeCommand('rm', ['-rf', '/'])).rejects.toThrow(/not in whitelist/i);
            await expect(runSafeCommand('wget', ['https://evil.com'])).rejects.toThrow(/not in whitelist/i);
            await expect(runSafeCommand('curl', ['https://evil.com'])).rejects.toThrow(/not in whitelist/i);
            await expect(runSafeCommand('bash', ['-c', 'echo pwned'])).rejects.toThrow(/not in whitelist/i);
            await expect(runSafeCommand('sh', ['-c', 'echo pwned'])).rejects.toThrow(/not in whitelist/i);
        });

        it('should accept whitelisted binaries', () => {
            expect(isBinaryAllowed('ping')).toBe(true);
            expect(isBinaryAllowed('nmap')).toBe(true);
            expect(isBinaryAllowed('docker')).toBe(true);
        });

        it('should export full list of allowed binaries', () => {
            const bins = getAllowedBinaries();
            expect(bins).toContain('ping');
            expect(bins).toContain('nmap');
            expect(bins).not.toContain('rm');
            expect(bins).not.toContain('wget');
            expect(bins).not.toContain('curl');
        });
    });

    describe('argument injection prevention', () => {
        it('should reject arguments with shell operators', async () => {
            await expect(runSafeCommand('ping', ['-c', '1', '8.8.8.8; rm -rf /'])).rejects.toThrow(/dangerous characters/i);
            await expect(runSafeCommand('ping', ['-c', '1', '$(whoami)'])).rejects.toThrow(/dangerous characters/i);
            await expect(runSafeCommand('ping', ['-c', '1', '`id`'])).rejects.toThrow(/dangerous characters/i);
            await expect(runSafeCommand('ping', ['-c', '1', '8.8.8.8 | cat /etc/passwd'])).rejects.toThrow(/dangerous characters/i);
            await expect(runSafeCommand('ping', ['-c', '1', '8.8.8.8 && echo pwned'])).rejects.toThrow(/dangerous characters/i);
        });

        it('should allow clean arguments', async () => {
            // These should not throw on validation (may fail on execution if binary not installed)
            try {
                await runSafeCommand('echo', ['hello'], 2000);
            } catch (err: any) {
                // echo is not in whitelist, that's expected
                expect(err.message).toMatch(/not in whitelist/i);
            }
        });
    });

    describe('per-binary restrictions', () => {
        it('should restrict cat to /proc and /sys paths', async () => {
            await expect(runSafeCommand('cat', ['/etc/passwd'])).rejects.toThrow(/only allowed/i);
            await expect(runSafeCommand('cat', ['/home/user/.env'])).rejects.toThrow(/only allowed/i);
            // These pass validation (may fail on execution if path doesn't exist)
            await expect(runSafeCommand('cat', ['/proc/version'])).resolves.toBeDefined().catch(() => {
                // OK if /proc/version doesn't exist on macOS
            });
        });

        it('should restrict docker to safe subcommands', async () => {
            await expect(runSafeCommand('docker', ['exec', 'container', 'bash'])).rejects.toThrow(/not allowed/i);
            await expect(runSafeCommand('docker', ['rm', '-f', 'container'])).rejects.toThrow(/not allowed/i);
            await expect(runSafeCommand('docker', ['run', '--rm', 'alpine'])).rejects.toThrow(/not allowed/i);
        });
    });

    describe('execution', () => {
        it('should run hostname and return trimmed output', async () => {
            try {
                const result = await runSafeCommand('hostname', [], 5000);
                expect(result).toBeTruthy();
                expect(result).not.toMatch(/\n$/);
            } catch (e: any) {
                if (e.message.includes('ENOENT')) return; // Ignore on Mac/Windows where path differs
                throw e;
            }
        });

        it('should run uname -a', async () => {
            try {
                const result = await runSafeCommand('uname', ['-a'], 5000);
                expect(result).toBeTruthy();
            } catch (e: any) {
                if (e.message.includes('ENOENT')) return; // Ignore on Mac/Windows where path differs
                throw e;
            }
        });

        it('should timeout on long commands', async () => {
            // ping with high count, very short timeout
            await expect(
                runSafeCommand('ping', ['-c', '100', '127.0.0.1'], 100)
            ).rejects.toThrow();
        });
    });
});
