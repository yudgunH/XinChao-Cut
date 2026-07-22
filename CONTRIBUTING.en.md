# Contributing to XinChao-Cut

**\*English** · [Tiếng Việt](CONTRIBUTING.md)\*

Thanks for your interest in the project! All contributions — bug reports, feature requests, documentation improvements, or code — are welcome.

## Code of Conduct

By participating in this project, you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.en.md).

## Reporting bugs (issues)

Before opening a new issue, please check whether it has already been reported. When reporting a bug, please include:

- A short description of the problem and the expected behavior.
- Steps to reproduce (as specific as possible).
- Environment: OS, browser (and version), whether the backend is enabled.
- Logs or screenshots if available.

> ⚠️ Don't paste secrets, tokens, or personal information into issues.

## Feature requests

Open an issue describing the feature, why it's useful, and (if you have one) an implementation idea. Please discuss large changes first to avoid wasted effort.

## Pull Request workflow

1. **Fork** the repo and create a branch off `main`:
   ```bash
   git checkout -b feat/your-feature
   ```
2. Install and run the project per the [README](README.en.md).
3. Make your changes, keeping the PR small and focused on a single goal.
4. Make sure all the checks below are **green** before opening the PR.
5. Open a Pull Request against `main`, clearly describing the change, the reason, and how you tested it. Link the related issue if any.

## Checks before submitting

**Frontend:**

```bash
npm run lint
npm run typecheck
npm run build
npm test -- --run
```

**Backend** (if you changed anything under `backend/`):

```bash
cd backend
python -m compileall -q app
pytest -q
```

CI runs the frontend and backend gates above for every pull request. If you change `src-tauri/`, also run:

```bash
cd src-tauri
cargo fmt --all -- --check
cargo test --lib
```

The current workflow has no Rust job, so these two checks are required locally for Tauri changes.

## Coding conventions

- **TypeScript/React:** follow the project's ESLint + Prettier setup (`npm run lint:fix`, `npm run format`). Keep TypeScript in strict mode and avoid `any`.
- **Python:** follow the existing style, add type hints where reasonable.
- Use clear names and prefer readable code. See `docs/04-clean-code.md` for more.
- Don't add new dependencies unless truly necessary; if you do, pin the version and explain why in the PR.

## Commit conventions

We encourage [Conventional Commits](https://www.conventionalcommits.org/) to keep history readable:

- `feat:` a new feature
- `fix:` a bug fix
- `docs:` documentation changes
- `refactor:` behavior-preserving refactor
- `test:` add/update tests
- `chore:` chores (build, config…)

## License

By contributing, you agree that your contributions are released under the project's [MIT](LICENSE) license.
