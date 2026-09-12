## Canonical issue

Closes #

## Change

Describe the observable behavior changed and why this is the smallest complete solution.

## Security and permissions

- [ ] Localhost Host, Origin, CSRF, and CSP behavior remains intact or the change is explained.
- [ ] User and GitHub content is rendered as text; any actionable URL is validated.
- [ ] No credential, personal data, repository content, screenshot, prompt, or model response was added to logs or tests.
- [ ] GitHub permissions, unsupported APIs, partial results, and ambiguous mutations are represented honestly where relevant.

## Verification

List the focused commands or scenarios exercised and their observed results.

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run verify:package`
- [ ] Relevant local CLI or UI path exercised

## Release surface

- [ ] Tests cover each new observable contract, or no new contract was introduced.
- [ ] Public documentation and `CHANGELOG.md` are updated where needed.
- [ ] No generated `dist/`, tarball, dependency directory, credential, or local repository data is included.
- [ ] This pull request does not publish a package or create a release.
