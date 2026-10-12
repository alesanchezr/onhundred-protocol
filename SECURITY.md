# Security

Your log holds personal data, so security reports come first.

## Report a vulnerability

Report it privately through GitHub: open the [Security tab](https://github.com/onhundred/protocol-log/security) and click **Report a vulnerability**. Only the maintainers see it.

Don't open a public issue, discussion or pull request for a vulnerability. Include the steps to reproduce it and what an attacker could reach.

You get a first answer within 7 days. Once a fix ships, the release notes credit you, unless you prefer not to be named.

## Supported versions

Fixes ship in the newest `v1.x` release. Installs receive it through their **Update from template** pull request. Older releases don't get fixes.

## In scope

- Owner sign-in, the session cookie and the lockout after failed sign-ins
- OAuth sign-in for AI apps, and API keys
- The privacy allowlist: anything private that reaches the public page or `/public.json`
- Writes that skip the protocol checks or the owner-only rules
- The update workflow and script

## Out of scope

- Your own Cloudflare or GitHub account settings, and secrets you shared
- Denial of service against a single install
- Bugs in Cloudflare, GitHub or the AI apps themselves. Report those to them.
