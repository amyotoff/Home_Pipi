# Security

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public issue
2. Email security concerns to the maintainer via [amyote.com](https://amyote.com)
3. Include a description of the vulnerability and steps to reproduce

You should receive a response within 48 hours.

## Security Model

| Entity | Trust Level | Notes |
|--------|-------------|-------|
| Telegram owner (OWNER_TG_IDS) | Trusted | Full access to all skills |
| Non-owner Telegram users | Untrusted | Rejected by router |
| LLM tool calls | Sandboxed | Allowlisted commands only |
| Docker container | Isolated | Limited capabilities in production |

## Security Boundaries

### 1. Access Control
Only Telegram users listed in `OWNER_TG_IDS` can interact with the bot. Non-owners are silently rejected (private chat gets a polite refusal).

### 2. Shell Command Isolation
`src/utils/shell.ts` restricts commands to an allowlist of safe network diagnostic tools. Shell operators (`;`, `&&`, `|`, `` ` ``, `$()`) are blocked.

### 3. Container Security (Production)
Production `docker-compose.yml` runs with:
- No `network_mode: host`
- No Docker socket mount
- `security_opt: [no-new-privileges:true]`
- Non-root user inside container

### 4. Credential Isolation
All API keys and tokens are loaded from environment variables, never hardcoded. The `.env` file is gitignored.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | ✅         |
| < 2.0   | ❌         |
