import { describe, it, expect } from 'vitest';
import { assertPublicUrl, isPrivateIP, isPrivateIPv6 } from './url-guard';

describe('url-guard', () => {
    describe('isPrivateIP', () => {
        it('should detect RFC1918 ranges', () => {
            // 10.0.0.0/8
            expect(isPrivateIP('10.0.0.1')).toBe(true);
            expect(isPrivateIP('10.255.255.255')).toBe(true);
            // 172.16.0.0/12
            expect(isPrivateIP('172.16.0.1')).toBe(true);
            expect(isPrivateIP('172.31.255.255')).toBe(true);
            // 192.168.0.0/16
            expect(isPrivateIP('192.168.0.1')).toBe(true);
            expect(isPrivateIP('192.168.1.1')).toBe(true);
            expect(isPrivateIP('192.168.255.255')).toBe(true);
        });

        it('should detect loopback', () => {
            expect(isPrivateIP('127.0.0.1')).toBe(true);
            expect(isPrivateIP('127.255.255.255')).toBe(true);
        });

        it('should detect link-local', () => {
            expect(isPrivateIP('169.254.0.1')).toBe(true);
        });

        it('should allow public IPs', () => {
            expect(isPrivateIP('8.8.8.8')).toBe(false);
            expect(isPrivateIP('1.1.1.1')).toBe(false);
            expect(isPrivateIP('142.250.80.46')).toBe(false);
            expect(isPrivateIP('172.32.0.1')).toBe(false); // just outside 172.16/12
        });
    });

    describe('isPrivateIPv6', () => {
        it('should detect loopback', () => {
            expect(isPrivateIPv6('::1')).toBe(true);
        });

        it('should detect link-local', () => {
            expect(isPrivateIPv6('fe80::1')).toBe(true);
        });

        it('should detect unique local', () => {
            expect(isPrivateIPv6('fd00::1')).toBe(true);
            expect(isPrivateIPv6('fc00::1')).toBe(true);
        });
    });

    describe('assertPublicUrl', () => {
        it('should block private IPs', async () => {
            await expect(assertPublicUrl('http://192.168.1.1')).rejects.toThrow(/private.*local/i);
            await expect(assertPublicUrl('http://10.0.0.1')).rejects.toThrow(/private.*local/i);
            await expect(assertPublicUrl('http://172.16.0.1')).rejects.toThrow(/private.*local/i);
            await expect(assertPublicUrl('http://127.0.0.1')).rejects.toThrow(/private.*local/i);
            await expect(assertPublicUrl('http://127.0.0.1:9222')).rejects.toThrow(/private.*local/i);
        });

        it('should block localhost', async () => {
            await expect(assertPublicUrl('http://localhost')).rejects.toThrow(/local.*internal/i);
            await expect(assertPublicUrl('http://localhost:3000')).rejects.toThrow(/local.*internal/i);
        });

        it('should block .local hostnames', async () => {
            await expect(assertPublicUrl('http://router.local')).rejects.toThrow(/local.*internal/i);
            await expect(assertPublicUrl('http://nas.local:5000')).rejects.toThrow(/local.*internal/i);
        });

        it('should block IPv6 loopback', async () => {
            await expect(assertPublicUrl('http://[::1]')).rejects.toThrow(/private.*local/i);
            await expect(assertPublicUrl('http://[::1]:9222')).rejects.toThrow(/private.*local/i);
        });

        it('should block non-http schemes', async () => {
            await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/scheme/i);
            await expect(assertPublicUrl('ftp://example.com')).rejects.toThrow(/scheme/i);
            await expect(assertPublicUrl('data:text/html,hello')).rejects.toThrow(/scheme/i);
        });

        it('should block invalid URLs', async () => {
            await expect(assertPublicUrl('not-a-url')).rejects.toThrow(/Invalid URL/i);
            await expect(assertPublicUrl('')).rejects.toThrow(/Invalid URL/i);
        });

        it('should allow public URLs', async () => {
            await expect(assertPublicUrl('https://google.com')).resolves.toBeUndefined();
            await expect(assertPublicUrl('https://example.org/path?q=1')).resolves.toBeUndefined();
            await expect(assertPublicUrl('http://8.8.8.8')).resolves.toBeUndefined();
        });
    });
});
