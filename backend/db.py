"""Fresh-install-only database entrypoint for the isolated IVE team package.

The exporter installs this source as db.py. It never imports the development
initializer, copies data, or upgrades an unmarked/foreign database. Only empty
SQLite files and this package's explicitly marked schema version are accepted.
This is not a migration path for existing IVE or other-product installations.
"""
from pathlib import Path

import aiosqlite
import extension_host
from config import DATA_DIR, DB_PATH
from fresh_database_schema import SCHEMA_STATEMENTS


_SCHEMA_VERSION = 1
_IDENTITY = "ive-team-fresh"
_IDENTITY_TABLE = "ive_fresh_database"
_IDENTITY_SCHEMA = """CREATE TABLE ive_fresh_database (
    identity TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL
)"""


class FreshDatabaseRequired(RuntimeError):
    """This artifact cannot adopt or upgrade the selected database."""


def _check_storage_selection():
    from extension_storage import selected_contracts, StorageContractError
    try:
        return selected_contracts()
    except StorageContractError as exc:
        raise FreshDatabaseRequired(str(exc)) from exc


async def _database_state(connection) -> bool:
    """Return False only for an empty file; reject any unrecognized contents."""
    cursor = await connection.execute(
        "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
    )
    names = {row[0] for row in await cursor.fetchall()}
    if not names:
        return False
    if _IDENTITY_TABLE not in names:
        raise FreshDatabaseRequired(
            "Existing unmarked database refused; choose a new empty data directory. No data was imported."
        )
    try:
        cursor = await connection.execute(
            "SELECT identity, schema_version FROM ive_fresh_database"
        )
        records = [tuple(row) for row in await cursor.fetchall()]
    except aiosqlite.DatabaseError as exc:
        raise FreshDatabaseRequired("Invalid fresh-package database identity") from exc
    if records != [(_IDENTITY, _SCHEMA_VERSION)]:
        raise FreshDatabaseRequired("Unsupported fresh-package database identity or schema version")
    return True


async def _inspect_existing() -> bool:
    path = Path(DB_PATH)
    if not path.exists():
        return False
    if not path.is_file():
        raise FreshDatabaseRequired("Database path is not a regular file")
    # Immutable read-only mode avoids even WAL shared-memory creation/recovery.
    # The package identity is written in the initial main-file transaction;
    # unrecognized files with pending journals are never treated as empty.
    # immutable=1 is only safe while nobody writes: under a concurrent WAL
    # checkpoint it can read torn pages ("database disk image is malformed").
    # That is why the result is cached per file (see _verified_database) and,
    # if a WAL is present, a failed immutable read is retried with a normal
    # read-only connection that honours the WAL locks.
    base_uri = path.resolve().as_uri()
    try:
        try:
            async with aiosqlite.connect(base_uri + "?mode=ro&immutable=1", uri=True) as connection:
                initialized = await _database_state(connection)
        except aiosqlite.DatabaseError:
            if not Path(str(path) + "-wal").exists():
                raise
            async with aiosqlite.connect(base_uri + "?mode=ro", uri=True) as connection:
                initialized = await _database_state(connection)
        if not initialized and any(Path(str(path) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
            raise FreshDatabaseRequired("Unrecognized database with pending journal files refused")
        return initialized
    except FreshDatabaseRequired:
        raise
    except (OSError, aiosqlite.DatabaseError) as exc:
        raise FreshDatabaseRequired("Database is not a supported fresh-package SQLite file") from exc


# (resolved path, st_dev, st_ino, birthtime) of the database file whose identity was
# verified. get_db() used to re-run the immutable identity check on every
# call against the live WAL database; now it runs once per file.
_verified_database = None


def _database_file_key():
    path = Path(DB_PATH)
    try:
        st = path.stat()
    except OSError:
        return None
    return (str(path.resolve()), st.st_dev, st.st_ino, getattr(st, "st_birthtime", None))


def _mark_verified():
    global _verified_database
    _verified_database = _database_file_key()


def reset_identity_cache():
    global _verified_database
    _verified_database = None


async def _ensure_initialized() -> bool:
    key = _database_file_key()
    if key is not None and key == _verified_database:
        return True
    initialized = await _inspect_existing()
    if initialized:
        _mark_verified()
    return initialized


async def get_db() -> aiosqlite.Connection:
    contracts = _check_storage_selection()
    if not await _ensure_initialized():
        raise FreshDatabaseRequired("Initialize the empty fresh-package database first")
    connection = await aiosqlite.connect(str(DB_PATH))
    connection.row_factory = aiosqlite.Row
    try:
        from extension_storage import verify_storage
        await verify_storage(connection, contracts)
        await connection.execute("PRAGMA journal_mode=WAL")
        await connection.execute("PRAGMA foreign_keys=ON")
    except Exception:
        await connection.close()
        raise
    return connection


async def init_db():
    contracts = _check_storage_selection()
    await _inspect_existing()  # Unknown/nonempty databases are refused before write access.
    Path(DATA_DIR).mkdir(parents=True, exist_ok=True)
    connection = await aiosqlite.connect(str(DB_PATH))
    connection.row_factory = aiosqlite.Row
    try:
        await connection.execute("PRAGMA foreign_keys=ON")
        await connection.execute("BEGIN IMMEDIATE")
        # Recheck under the SQLite write lock to serialize simultaneous first init.
        initialized = await _database_state(connection)
        if not initialized:
            for statement in SCHEMA_STATEMENTS:
                await connection.execute(statement)
            await connection.execute(_IDENTITY_SCHEMA)
            await connection.execute(
                "INSERT INTO ive_fresh_database (identity, schema_version) VALUES (?, ?)",
                (_IDENTITY, _SCHEMA_VERSION),
            )
        from extension_storage import apply_storage
        await apply_storage(connection, contracts)
        from database_seeds import seed_core_defaults, seed_experimental_flags
        from model_providers import seed_and_migrate_model_providers
        from app_setting_extensions import refresh_ownership
        await seed_and_migrate_model_providers(connection)
        await seed_core_defaults(connection)
        await seed_experimental_flags(connection)
        from background_ai import initialize as initialize_background_ai
        await initialize_background_ai(connection)
        from safety_setup import migrate_unconfigured_classifier
        await migrate_unconfigured_classifier(connection)
        from model_policy import migrate_model_switching
        await migrate_model_switching(connection)
        from effort_migration import migrate_fake_high_effort
        await migrate_fake_high_effort(connection)
        await refresh_ownership(connection, commit=False)
        await connection.commit()
        _mark_verified()
    except Exception:
        await connection.rollback()
        raise
    finally:
        await connection.close()


async def resolve_workspace_orchestration_policy(db: aiosqlite.Connection, workspace_id: str, visited=None) -> str:
    if visited is None:
        visited = set()
    if not workspace_id or workspace_id in visited:
        return "{}"
    visited.add(workspace_id)
    cur = await db.execute(
        "SELECT orchestration_policy, inherit_orchestration_policy_from FROM workspaces WHERE id = ?",
        (workspace_id,),
    )
    row = await cur.fetchone()
    if not row:
        return "{}"
    inherit_id = row["inherit_orchestration_policy_from"]
    if inherit_id:
        return await resolve_workspace_orchestration_policy(db, inherit_id, visited)
    return row["orchestration_policy"] or "{}"
