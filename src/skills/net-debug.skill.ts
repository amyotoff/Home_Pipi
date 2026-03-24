import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { runCommand } from '../utils/shell';

const skill: SkillManifest = {
    name: 'net-debug',
    description: 'Сетевая диагностика: tcpdump, порт-скан, traceroute, ARP-таблица, DNS lookup',
    version: '1.0.0',

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
            const filter = args.filter || '';
            const sanitized = filter.replace(/[;&|`$()]/g, '');

            try {
                const cmd = `timeout ${seconds} tcpdump -nn -c ${count} ${sanitized} 2>&1 | head -50`;
                const output = await runCommand(cmd, (seconds + 2) * 1000);

                if (!output || output.includes('tcpdump: command not found')) {
                    return '[TOOL_RESULT] tcpdump не установлен на PiPi.';
                }

                const lines = output.split('\n');
                const packetLines = lines.filter(l => !l.startsWith('tcpdump:') && !l.startsWith('listening on'));
                const summary = lines.find(l => l.includes('packets captured')) || '';

                return `[TOOL_RESULT] Захват пакетов (${seconds}с, фильтр: "${filter || 'all'}"):\n${packetLines.slice(0, 30).join('\n')}\n${summary}`;
            } catch (err: any) {
                return `[TOOL_RESULT] Ошибка tcpdump: ${err.message}`;
            }
        },

        async net_portscan(args: { target: string; ports?: string }) {
            const ip = args.target.replace(/[^0-9.]/g, '');
            if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
                return '[TOOL_RESULT] Некорректный IP-адрес.';
            }

            const ports = args.ports ? `-p ${args.ports.replace(/[^0-9,\-]/g, '')}` : '--top-ports 100';

            try {
                const output = await runCommand(`nmap -Pn ${ports} ${ip} 2>/dev/null`, 30000);
                const portLines = output.split('\n').filter(l =>
                    /^\d+\//.test(l.trim()) || l.includes('PORT') || l.includes('Host is')
                );

                return `[TOOL_RESULT] Скан портов ${ip}:\n${portLines.join('\n') || 'Открытых портов не найдено.'}`;
            } catch (err: any) {
                return `[TOOL_RESULT] Ошибка сканирования: ${err.message}`;
            }
        },

        async net_arp() {
            try {
                const output = await runCommand('arp -a 2>/dev/null || ip neigh show 2>/dev/null');
                const lines = output.split('\n').filter(l => l.trim());
                return `[TOOL_RESULT] ARP-таблица (${lines.length} записей):\n${lines.join('\n')}`;
            } catch (err: any) {
                return `[TOOL_RESULT] Ошибка: ${err.message}`;
            }
        },

        async net_traceroute(args: { target: string }) {
            const target = args.target.replace(/[;&|`$()]/g, '');
            try {
                const output = await runCommand(`traceroute -m 15 -w 2 ${target} 2>&1`, 30000);
                return `[TOOL_RESULT] Traceroute до ${target}:\n${output}`;
            } catch (err: any) {
                return `[TOOL_RESULT] Ошибка traceroute: ${err.message}`;
            }
        },

        async net_dns(args: { hostname: string }) {
            const hostname = args.hostname.replace(/[;&|`$()]/g, '');
            try {
                const output = await runCommand(`nslookup ${hostname} 2>&1 || dig +short ${hostname} 2>&1`, 10000);
                return `[TOOL_RESULT] DNS ${hostname}:\n${output}`;
            } catch (err: any) {
                return `[TOOL_RESULT] Ошибка DNS: ${err.message}`;
            }
        },

        async net_ping(args: { target: string; count?: number }) {
            const target = args.target.replace(/[;&|`$()]/g, '');
            const count = Math.min(Math.max(args.count || 4, 1), 10);
            try {
                const output = await runCommand(`ping -c ${count} -W 3 ${target} 2>&1`, (count * 4 + 2) * 1000);
                // Extract the summary line
                const lines = output.split('\n');
                const stats = lines.filter(l =>
                    l.includes('packets transmitted') || l.includes('rtt') || l.includes('round-trip')
                );
                return `[TOOL_RESULT] Ping ${target}:\n${stats.join('\n') || output}`;
            } catch (err: any) {
                return `[TOOL_RESULT] ${target} недоступен: ${err.message}`;
            }
        },

        async net_connections(args: { filter?: string }) {
            const filter = args.filter || 'listening';
            let cmd: string;

            switch (filter) {
                case 'established':
                    cmd = 'ss -tnp state established 2>/dev/null || netstat -tnp 2>/dev/null | grep ESTABLISHED';
                    break;
                case 'all':
                    cmd = 'ss -tnap 2>/dev/null || netstat -tnap 2>/dev/null';
                    break;
                default: // listening
                    cmd = 'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null';
            }

            try {
                const output = await runCommand(cmd, 10000);
                const lines = output.split('\n').slice(0, 30);
                return `[TOOL_RESULT] Сетевые соединения (${filter}):\n${lines.join('\n')}`;
            } catch (err: any) {
                return `[TOOL_RESULT] Ошибка: ${err.message}`;
            }
        },
    }
};

export default skill;
