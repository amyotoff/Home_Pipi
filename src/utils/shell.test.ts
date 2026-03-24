import { describe, it, expect } from 'vitest';
import { runCommand } from './shell';

describe('Shell — runCommand', () => {
    it('should execute a simple command', async () => {
        const result = await runCommand('echo hello');
        expect(result).toBe('hello');
    });

    it('should trim output', async () => {
        const result = await runCommand('echo "  spaced  "');
        expect(result).toBe('spaced');
    });

    it('should throw on timeout', async () => {
        await expect(
            runCommand('sleep 10', 100)
        ).rejects.toThrow();
    });

    it('should reject disallowed commands', async () => {
        await expect(
            runCommand('rm -rf /')
        ).rejects.toThrow(/not allowed/i);
    });

    it('should reject shell injection operators', async () => {
        await expect(
            runCommand('echo hello; rm -rf /')
        ).rejects.toThrow(/not allowed/i);

        await expect(
            runCommand('echo hello && rm -rf /')
        ).rejects.toThrow(/not allowed/i);

        await expect(
            runCommand('echo $(whoami)')
        ).rejects.toThrow(/not allowed/i);
    });

    it('should allow safe network commands', async () => {
        // ping with count=1 should work (allowed prefix)
        const result = await runCommand('echo test_ping', 5000);
        expect(result).toBe('test_ping');
    });
});
