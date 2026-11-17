# Contributing

## Setup

```sh
pnpm install
pnpm test
```

## Before you push

```sh
pnpm format
pnpm lint
pnpm typecheck
pnpm test:coverage
```

Continuous integration runs the same checks.

## Conventions

- TypeScript in strict mode. No `any`. Amounts and heights that can exceed 2^53 are `bigint`.
- Every change comes with tests. Chain access in tests goes through a fake transport; tests
  never need a network or a key.
- Errors raised on purpose extend `VigilError` and carry a stable code.
- Never log, print or commit a secret. Never commit `.env`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- Database migrations are append-only: add a new entry, never edit a published one.
