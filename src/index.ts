import { initDatabase, logEvent } from './db';
import { startTelegramBot, setMessageHandler, notifyHousehold } from './channels/telegram';
import { connectAll as connectOutboundChannels } from './channels/_registry';
// Import channel modules for self-registration (side-effect imports)
import './channels/whatsapp';
import './channels/discord';
import './channels/gmail';
import { handleIncomingMessage } from './router';
import { initAllSkills } from './skills/_registry';
import { startTaskScheduler } from './task-scheduler';
import { MQTT_URL } from './config';
import { startMqtt } from './mqtt';

async function bootstrap() {
    console.log('Bootstrapping Jivs PiPi...');

    initDatabase();
    console.log('Database initialized.');

    if (MQTT_URL) {
        startMqtt(MQTT_URL);
    }

    // Connect outbound channels (WhatsApp, Discord, Gmail) before skills init
    await connectOutboundChannels();

    await initAllSkills();
    startTaskScheduler();

    setMessageHandler(handleIncomingMessage);
    startTelegramBot();

    logEvent('reboot', { reason: 'startup', timestamp: new Date().toISOString() });
    const startupMsg = 'Jivs PiPi is running.';
    console.log(startupMsg);
    notifyHousehold(startupMsg);
}

bootstrap().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
