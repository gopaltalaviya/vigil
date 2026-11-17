# Security policy

## Scope

Vigil is testnet software. It has not been audited. Do not use it with keys or funds that
matter.

## Reporting a problem

Please do not open a public issue for a vulnerability. Use GitHub's private vulnerability
reporting on this repository (Security tab, "Report a vulnerability"). Include what you found,
how to reproduce it, and the commit you tested.

You can expect an acknowledgement within a few days.

## Handling of secrets

- Secrets are read from environment variables only and are never written to disk by Vigil.
- Log output redacts seed phrases, private keys and tokens.
- The `.env` file is ignored by git; continuous integration scans every push for leaked secrets.
