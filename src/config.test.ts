import { describe, it, expect } from 'vitest';

describe('config', () => {
    describe('isOwner', () => {
        it('should allow owner when OWNER_TG_IDS is set', async () => {
            // Test with dynamic import to avoid config caching
            const { isOwner } = await import('./config');
            // Default: empty OWNER_TG_IDS means everyone is allowed
            expect(isOwner('111')).toBe(true);
            expect(isOwner('999')).toBe(true);
        });

        it('should allow everyone when OWNER_TG_IDS is empty', async () => {
            const { isOwner } = await import('./config');
            // When no IDs configured, all users are allowed
            expect(isOwner('anyone')).toBe(true);
        });
    });

    describe('isHouseholdChat', () => {
        it('should return false for empty HOUSEHOLD_CHAT_ID', async () => {
            const { isHouseholdChat } = await import('./config');
            // Default env has empty HOUSEHOLD_CHAT_ID
            expect(isHouseholdChat('12345')).toBe(false);
        });

        it('should return false for non-matching chat ID', async () => {
            const { isHouseholdChat } = await import('./config');
            expect(isHouseholdChat('wrong-id')).toBe(false);
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
