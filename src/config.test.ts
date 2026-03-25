import { describe, it, expect } from 'vitest';

describe('config', () => {
    describe('isOwner', () => {
        it('should reject everyone when OWNER_TG_IDS is empty (fail-closed)', async () => {
            const { isOwner } = await import('./config');
            // In test env OWNER_TG_IDS is empty → fail-closed
            expect(isOwner('111')).toBe(false);
            expect(isOwner('999')).toBe(false);
            expect(isOwner('anyone')).toBe(false);
        });
    });

    describe('isHouseholdChat', () => {
        it('should return false for empty HOUSEHOLD_CHAT_ID', async () => {
            const { isHouseholdChat } = await import('./config');
            expect(isHouseholdChat('12345')).toBe(false);
        });

        it('should return false for non-matching chat ID', async () => {
            const { isHouseholdChat } = await import('./config');
            expect(isHouseholdChat('wrong-id')).toBe(false);
        });
    });

    describe('validateCriticalConfig', () => {
        it('should throw when env vars are missing', async () => {
            const { validateCriticalConfig } = await import('./config');
            // In test env TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, OWNER_TG_IDS are empty
            expect(() => validateCriticalConfig()).toThrow(/Unsafe config/);
        });
    });

    describe('exports', () => {
        it('should export all required config values', async () => {
            const config = await import('./config');
            expect(config.TELEGRAM_BOT_TOKEN).toBeDefined();
            expect(config.GEMINI_API_KEY).toBeDefined();
            expect(config.OLLAMA_URL).toBeDefined();
            expect(config.OLLAMA_MODEL).toBeDefined();
            expect(config.DATA_DIR).toBeDefined();
            expect(config.DB_PATH).toBeDefined();
            expect(config.LOCATION_LAT).toBeDefined();
            expect(config.LOCATION_LON).toBeDefined();
        });

        it('should have sensible defaults', async () => {
            const config = await import('./config');
            expect(config.OLLAMA_URL).toBe('http://localhost:11434');
            expect(config.OLLAMA_MODEL).toBe('qwen2.5:1.5b');
            expect(config.MOCK_SENSORS).toBe(false);
        });
    });
});
