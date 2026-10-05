# Security policy

Vaultsmith handles credentials, so please report vulnerabilities privately rather
than in a public issue: use GitHub's **Security → Report a vulnerability** on this
repository.

Please include the affected script/version, steps to reproduce, and what an
attacker could achieve. Do not include real credentials or customer data.

## Handling notes for users

- `.env` and `assets/` are gitignored. Never commit them.
- `assets/createdusers.json` and `assets/rotation-recovery.jsonl` contain plaintext
  passwords (written with owner-only permissions). Import/apply them, then delete them.
- Use `BW_SESSION_ID` or the interactive master-password prompt rather than storing
  `BW_MASTER_PASSWORD` in `.env`.
- Run mutating commands in dry-run mode against staging first.
