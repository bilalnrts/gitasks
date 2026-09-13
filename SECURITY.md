# Security Policy

## Supported versions

| Version | Security updates |
| --- | --- |
| 0.5.x | Supported |
| 0.4.x and earlier | Not supported |

Use the latest available 0.5 patch before reporting a problem.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability and do not include tokens, repository content, personal data, screenshots, prompts, or model output in a report.

Use GitHub's private vulnerability-reporting form:

https://github.com/bilalnrts/gitasks/security/advisories/new

Include only the minimum information needed to reproduce and assess the problem:

- affected Gitasks and Node.js versions;
- operating system and relevant `gh` version;
- the affected command or local route;
- impact and a minimal reproduction using sanitized values;
- whether the problem requires a particular GitHub permission or repository setting;
- any suggested remediation.

If private vulnerability reporting is unavailable, contact the repository owner through their GitHub profile without disclosing vulnerability details publicly, then arrange a private channel.

## Security boundaries

Gitasks is a development-only local tool. It binds its HTTP server to `127.0.0.1`, validates Host and mutation Origin, requires a per-process CSRF token, and serves a restrictive Content Security Policy. GitHub operations run through the authenticated `gh` CLI; credentials are not sent to browser JavaScript or stored by Gitasks.

User-controlled GitHub content must render as text. Only validated HTTP(S) GitHub and avatar URLs may become links or images. Gitasks does not provide a hosted service, database, polling process, WebSocket, admin merge bypass, or branch deletion control.

Repository Analytics is read-only. Analytics routes accept only validated, allowlisted filter values and never accept a repository, URL, filesystem path, or command from the browser. Cached datasets are bounded to the current repository and authenticated GitHub user and are invalidated after mutations. CSV export escapes RFC 4180 fields and prefixes spreadsheet-formula characters; exported content can still contain repository data and should be handled accordingly.

These controls do not replace workstation security, GitHub repository permissions, organization policy, branch protection, or credential hygiene. Anyone able to execute software as the same local user may be able to invoke that user's `gh` authentication independently of Gitasks.

## Response process

Maintainers will acknowledge a report through the private channel, reproduce it with sanitized data, assess affected versions, and coordinate remediation and disclosure. Release timing depends on severity and the availability of a verified fix; no fixed response deadline is promised.
