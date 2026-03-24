import { chromium, BrowserContext } from 'playwright-core';

export async function withBrowserContext<T>(
    action: (context: BrowserContext) => Promise<T>
): Promise<T> {
    const cdpUrl = process.env.CHROMIUM_CDP_URL || 'http://127.0.0.1:9222';

    // Connect to the persistent Chromium instance
    const browser = await chromium.connectOverCDP(cdpUrl);
    // Get the default context which holds the persistent cookies/session
    const context = browser.contexts()[0];

    try {
        return await action(context);
    } finally {
        // IMPORTANT: Playwright's `close()` on a browser connected via CDP
        // only disconnects the CDP session; it does NOT kill the underlying remote browser process.
        await browser.close();
    }
}
