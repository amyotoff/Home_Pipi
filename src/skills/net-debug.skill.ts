import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { runSafeCommand } from '../utils/safe-shell';

const skill: SkillManifest = {
    name: 'net-debug',
    description: 'Сетевая диагностика: tcpdump, порт-скан, traceroute, ARP-таблица, DNS lookup',
    version: '1.1.0',

    tools: [
        {
            name: 'net_capture',
            description: 'Capture network packets with tcpdump. Useful for debugging device communication, finding chatty devices, or investigating traffic patterns. Returns a summary of captured packets. Max 10 seconds.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    filter: {
                        type: Type.STRING,
                        description: 'tcpdump filter expression. Examples: "host 192.168.1.100" (IKEA gateway traffic), "port 53" (DNS queries), "arp" (ARP requests), "icmp" (pings). Default: all traffic.'
                    },
                    seconds: {
                        type: Type.INTEGER,
                        description: 'Capture duration in seconds (1-10, default 5).'
                    },
                    count: {
                        type: Type.INTEGER,
                        description: 'Max number of packets to capture (1-100, default 20).'
                    }
                }
            }
        },
        {
            name: 'net_portscan',
            description: 'Scan open ports on a specific device. Use to investigate what services a device is running.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    target: {
                        type: Type.STRING,
                        description: 'IP address to scan, e.g. "192.168.1.100".'
                    },
                    ports: {
                        type: Type.STRING,
                        description: 'Port range. Examples: "1-1024" (common ports), "80,443,8080" (specific), "1-65535" (all). Default: top 100 ports.'
                    }
                },
                required: ['target'],
            }
        },
        {
            name: 'net_arp',
            description: 'Show the ARP table — all devices the Pi has recently communicated with. Fast, no scan needed.',
            parameters: {
                type: Type.OBJECT,
                properties: {}
            }
        },
        {
            name: 'net_traceroute',
            description: 'Trace the network path to a host. Useful for diagnosing connectivity issues.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    target: {
                        type: Type.STRING,
                        description: 'Hostname or IP to trace, e.g. "8.8.8.8" or "google.com".'
                    }
                },
                required: ['target'],
            }
        },
        {
            name: 'net_dns',
            description: 'DNS lookup for a hostname. Shows resolved IPs and response time.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    hostname: {
                        type: Type.STRING,
                        description: 'Hostname to resolve, e.g. "api.telegram.org".'
                    }
                },
                required: ['hostname'],
            }
        },
        {
            name: 'net_ping',
            description: 'Ping a host to check latency and reachability.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    target: {
                        type: Type.STRING,
                        description: 'IP or hostname to ping.'
                    },
                    count: {
                        type: Type.INTEGER,
                        description: 'Number of pings (1-10, default 4).'
                    }
                },
                required: ['target'],
            }
        },
        {
            name: 'net_connections',
            description: 'Show active network connections on the Pi. Useful for seeing what services are listening and who is connected.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    filter: {
                        type: Type.STRING,
                        description: 'Filter: "listening" (only listening ports), "established" (active connections), "all" (everything). Default: "listening".',
                        enum: ['listening', 'established', 'all']
                    }
                }
            }
        },
    ],

    handlers: {
        async net_capture(args: { filter?: string; seconds?: number; count?: number }) {
            const seconds = Math.min(Math.max(args.seconds || 5, 1), 10);
            const count = Math.min(Math.max(args.count || 20, 1), 100);

            // Build args array — no shell string concatenation
            const tcpdumpArgs: string[] = ['-nn', '-c', String(count)];
            if (args.filter) {
                // Split filter into tokens — tcpdump expects them as separate args
                const filterTokens = args.filter.trim().split(/\s+/);
                tcpdumpArgs.push(...filterTokens);
            }

            try {
                const output = await runSafeCommand('timeout', [String(seconds), 'tcpdump', ...tcpdumpArgs], (seconds + 2) * 1000);

                if (!output || output.includes('tcpdump: command not found')) {
                    return '[TOOL_RESULT] tcpdump не установлен на PiPi.';
                }

                const lines = output.split('\n');
                const packetLines = lines.filter(l => !l.startsWith('tcpdump:') && !l.startsWith('listening on'));
                const summary = lines.find(l => l.includes('packets captured')) || '';

                return `[TOOL_RESULT] Захват пакетов (${seconds}с, фильтр: "${args.filter || 'all'}"):\n${packetLines.slice(0, 30).join('\n')}\n${summary}`;
            } catch (err: any) {
                return `[TOOL_ERROR] tcpdump: ${err.message}`;
            }
        },

        async net_portscan(args: { target: string; ports?: string }) {
            const ip = args.target.replace(/[^0-9.]/g, '');
            if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
                return '[TOOL_RESULT] Некорректный IP-адрес.';
            }

            const nmapArgs = ['-Pn'];
            if (args.ports) {
                const safePorts = args.ports.replace(/[^0-9,-]/g, '');
                nmapArgs.push('-p', safePorts);
            } else {
                nmapArgs.push('--top-ports', '100');
            }
            nmapArgs.push(ip);

            try {
                const output = await runSafeCommand('nmap', nmapArgs, 30000);
                const portLines = output.split('\n').filter(l =>
                    /^\d+\//.test(l.trim()) || l.includes('PORT') || l.includes('Host is')
                );

                return `[TOOL_RESULT] Скан портов ${ip}:\n${portLines.join('\n') || 'Открытых портов не найдено.'}`;
            } catch (err: any) {
                return `[TOOL_ERROR] Сканирование: ${err.message}`;
            }
        },

        async net_arp() {
            try {
                const output = await runSafeCommand('arp', ['-a']);
                const lines = output.split('\n').filter(l => l.trim());
                return `[TOOL_RESULT] ARP-таблица (${lines.length} записей):\n${lines.join('\n')}`;
            } catch {
                try {
                    const output = await runSafeCommand('ip', ['neigh', 'show']);
                    const lines = output.split('\n').filter(l => l.trim());
                    return `[TOOL_RESULT] ARP-таблица (${lines.length} записей):\n${lines.join('\n')}`;
                } catch (err: any) {
                    return `[TOOL_ERROR] ARP: ${err.message}`;
                }
            }
        },

        async net_traceroute(args: { target: string }) {
            const target = args.target.replace(/[^a-zA-Z0-9.\-:]/g, '');
            if (!target) return '[TOOL_ERROR] Некорректный хост.';

            try {
                const output = await runSafeCommand('traceroute', ['-m', '15', '-w', '2', target], 30000);
                return `[TOOL_RESULT] Traceroute до ${target}:\n${output}`;
            } catch (err: any) {
                return `[TOOL_ERROR] traceroute: ${err.message}`;
            }
        },

        async net_dns(args: { hostname: string }) {
            const hostname = args.hostname.replace(/[^a-zA-Z0-9.\-]/g, '');
            if (!hostname) return '[TOOL_ERROR] Некорректный хостнейм.';

            try {
                const output = await runSafeCommand('nslookup', [hostname], 10000);
                return `[TOOL_RESULT] DNS ${hostname}:\n${output}`;
            } catch {
                try {
                    const output = await runSafeCommand('dig', ['+short', hostname], 10000);
                    return `[TOOL_RESULT] DNS ${hostname}:\n${output}`;
                } catch (err: any) {
                    return `[TOOL_ERROR] DNS: ${err.message}`;
                }
            }
        },

        async net_ping(args: { target: string; count?: number }) {
            const target = args.target.replace(/[^a-zA-Z0-9.\-:]/g, '');
            if (!target) return '[TOOL_ERROR] Некорректный хост.';
            const count = Math.min(Math.max(args.count || 4, 1), 10);

            try {
                const output = await runSafeCommand('ping', ['-c', String(count), '-W', '3', target], (count * 4 + 2) * 1000);
                const lines = output.split('\n');
                const stats = lines.filter(l =>
                    l.includes('packets transmitted') || l.includes('rtt') || l.includes('round-trip')
                );
                return `[TOOL_RESULT] Ping ${target}:\n${stats.join('\n') || output}`;
            } catch (err: any) {
                return `[TOOL_ERROR] ${target} недоступен: ${err.message}`;
            }
        },

        async net_connections(args: { filter?: string }) {
            const filter = args.filter || 'listening';
            let ssArgs: string[];

            switch (filter) {
                case 'established':
                    ssArgs = ['-tnp', 'state', 'established'];
                    break;
                case 'all':
                    ssArgs = ['-tnap'];
                    break;
                default: // listening
                    ssArgs = ['-tlnp'];
            }

            try {
                const output = await runSafeCommand('ss', ssArgs, 10000);
                const lines = output.split('\n').slice(0, 30);
                return `[TOOL_RESULT] Сетевые соединения (${filter}):\n${lines.join('\n')}`;
            } catch (err: any) {
                return `[TOOL_ERROR] Подключения: ${err.message}`;
            }
        },
    }
};

export default skill;
