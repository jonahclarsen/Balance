# Raw-key migration removal

The PBKDF/160-bit path exists only to move the original Balance installation to
the permanent 256-bit raw-key format. Nothing in `backups/pre-raw-key/` may be
deleted as part of code cleanup.

Before removal, the user must verify on every active installation that:

- the displayed recovery key has thirteen Base32 groups and has been confirmed;
- the live database reports `database_key_format=raw-hkdf-sha256-v1`;
- no `.balance-raw-key-migration.*` file or pending raw credential remains;
- a force-stop/relaunch and a foreground sync both succeed.

Then remove every `TODO(raw-key-migration-removal)` site, including:

- `DatabaseKeyFormat::LegacyPassphrase160` and the 20-byte parser allowance;
- `prepare_database_recovery_key`, its journal, candidate, and recovery branches;
- the legacy Keychain/Android credential reader and migration-pending slot;
- PBKDF migration fixtures and preserved-copy compatibility tests;
- fallback attempts that pass a recovery string directly to SQLCipher.

Keep HKDF-SHA256 raw-v1 derivation, the 32-byte generator/parser, full-key
confirmation and rotation-pending credential for future rotations, and the
central SQLCipher key helper. The old Keychain/Keystore credential and every
preserved database file remain inert unless the user separately and explicitly
requests their deletion.

## Historical migrations already removed

This raw-key release removes startup migrations that the sole active user had
already completed: additive column backfills, cr-sqlite artifact stripping,
legacy metadata-to-`state_entities` copying, and origin-localStorage sync
settings import. The raw-key migration performs an integrity, foreign-key, and
final-schema check before changing any file or credential, so an unexpectedly
old database fails closed with instructions to open the last PBKDF release.

Legacy operation/checkpoint fields are not startup migrations: they still
describe durable sync history that may be present in the current database or
relay. Remove those only after a separate compaction/relay-readiness audit proves
that no retained operation or generation uses them.
