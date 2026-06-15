# Security Policy

***English** · [Tiếng Việt](SECURITY.md)*

## Supported versions

This is a personal/learning project. Security fixes apply only to the latest code on the `main` branch.

| Version | Supported |
|---|---|
| `main` (latest) | ✅ |
| Older releases | ❌ |

## Reporting a vulnerability

If you discover a security vulnerability, please **do not open a public issue**.

Instead, report it privately through one of these channels:

- Use GitHub's **[Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)** (the repo's *Security* tab), or
- Contact the maintainer directly via GitHub.

When reporting, please include:

- A description of the vulnerability and its impact.
- Steps to reproduce or a proof-of-concept.
- The affected version/commit and the environment.

## Handling process

- We aim to respond within **7 days**.
- If the vulnerability is confirmed, we will patch it and credit you (if you agree).
- Please give us a reasonable window to patch before public disclosure.

## Notes for self-hosting

- **The backend ships without authentication.** It is designed to run locally (`127.0.0.1`). If you expose the backend to a network, add your own authentication/proxy layer and restrict access — otherwise anyone could call the media/AI endpoints.
- **Never commit secrets.** The `.env` / `.env.local` files are already in `.gitignore`; don't put tokens or keys in the repo.
- Media and project data are stored locally in the browser (OPFS/IndexedDB) and in the backend's `.work/` directory — nothing is sent anywhere unless you configure it.
