"""Versioned additive storage for explicitly installed, trusted products.

Only declarations are read, never legacy migration Python. The caller owns one
transaction on a recognized IVE database. Existing data is never adopted or
deleted. Product upgrades/rebuilds require a separately reviewed protocol.
This contract does not sandbox the product's executable backend.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3

import extension_host


class StorageContractError(RuntimeError):
    pass


_NAME = r"[A-Za-z_][A-Za-z0-9_]*"
_CREATE_TABLE = re.compile(rf"CREATE\s+(?:VIRTUAL\s+)?TABLE\s+({_NAME})\s*(?:\(|USING\s+fts5\s*\()", re.I)
_CREATE_INDEX = re.compile(rf"CREATE\s+(?:UNIQUE\s+)?INDEX\s+({_NAME})\s+ON\s+({_NAME})\s*\(", re.I)
_COLUMN = re.compile(rf"({_NAME})\s+(TEXT|INTEGER|REAL|BLOB)(?:\s+DEFAULT\s+(NULL|-?\d+(?:\.\d+)?|'(?:[^']|'')*'))?", re.I)
_HOST_TABLES = frozenset({"workspaces"})
_LEDGER = "ive_extension_storage"


def selected_contracts() -> list[dict]:
    result = []
    for metadata in extension_host.installed_extensions():
        owner = metadata["id"]
        path = extension_host.extension_path(owner)
        manifest = json.loads((path / "extension.json").read_text(encoding="utf-8"))
        declaration = (manifest.get("backend") or {}).get("storage")
        if declaration is None:
            if (path / "backend/database.py").is_file():
                raise StorageContractError(f"Extension {owner} has no supported fresh storage contract")
            continue
        if (not isinstance(declaration, dict) or set(declaration) != {"api_version", "entry"}
                or type(declaration["api_version"]) is not int or declaration["api_version"] != 1):
            raise StorageContractError(f"Unsupported storage interface for {owner}")
        source = extension_host.extension_path(owner, declaration["entry"])
        if source.suffix != ".json" or not source.is_file():
            raise StorageContractError("Storage declarations must be owned JSON files")
        raw = source.read_bytes()
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeError) as exc:
            raise StorageContractError("Invalid storage JSON") from exc
        result.append({**validate_contract(owner, data, hashlib.sha256(raw).hexdigest()), "requires": metadata["requires"]})
    # Dependency order, independent of alphabetical extension IDs.
    ordered = []
    pending = {item["owner"]: item for item in result}
    metadata = {item["id"]: item for item in extension_host.installed_extensions()}
    while pending:
        ready = sorted(owner for owner in pending if not set(metadata[owner]["requires"]) & pending.keys())
        if not ready:
            raise StorageContractError("Cyclic storage dependencies")
        for owner in ready:
            ordered.append(pending.pop(owner))
    return ordered


def validate_contract(owner: str, data: dict, digest: str) -> dict:
    if (not isinstance(data, dict) or set(data) != {"api_version", "owner", "version", "statements", "columns"}
            or type(data["api_version"]) is not int or data["api_version"] != 1 or data["owner"] != owner
            or type(data["version"]) is not int or data["version"] < 1
            or not isinstance(data["statements"], list) or not isinstance(data["columns"], dict)):
        raise StorageContractError("Unsupported product storage declaration")
    objects, tables = [], set()
    for statement in data["statements"]:
        if not isinstance(statement, str):
            raise StorageContractError("Storage statements must be strings")
        table = _CREATE_TABLE.match(statement.strip())
        index = _CREATE_INDEX.match(statement.strip())
        if table:
            name = table.group(1)
            tables.add(name)
        elif index and index.group(2) in tables:
            name = index.group(1)
        else:
            raise StorageContractError("Only new tables and indexes on owned tables are supported")
        if name.lower() in {value.lower() for value in objects} or name.lower().startswith(("sqlite_", "ive_")):
            raise StorageContractError("Invalid or duplicate product storage object")
        objects.append(name)
    columns = {}
    for table, definitions in data["columns"].items():
        if not isinstance(table, str) or not re.fullmatch(_NAME, table) or not isinstance(definitions, list):
            raise StorageContractError("Undeclared host table extension")
        for definition in definitions:
            match = _COLUMN.fullmatch(definition) if isinstance(definition, str) else None
            if not match or match.group(1) in columns.get(table, {}):
                raise StorageContractError("Only distinct nullable literal-default columns are supported")
            columns.setdefault(table, {})[match.group(1)] = definition
    return {**data, "digest": digest, "objects": objects, "tables": sorted(tables), "parsed_columns": columns}


async def _snapshot(db, contract, baseline=None):
    snapshot = {"objects": {}, "columns": {}, "declarations": contract["parsed_columns"]}
    for name in contract["objects"]:
        cursor = await db.execute("SELECT sql FROM sqlite_master WHERE name = ?", (name,))
        row = await cursor.fetchone()
        if not row:
            raise StorageContractError("Installed product schema is incomplete")
        if name not in contract["tables"]:
            snapshot["objects"][name] = row[0]
            continue
        cursor = await db.execute(f'PRAGMA table_info("{name}")')
        fields = {row[1]: list(row)[1:] for row in await cursor.fetchall()}
        table_sql = row[0]
        if baseline:
            expected = baseline["objects"][name]["columns"]
            if not expected.keys() <= fields.keys():
                raise StorageContractError("Installed product table columns are incomplete")
            # Only fields introduced by a recorded product may extend another
            # product's table, even if that contributor is currently disabled.
            extra = [key for key in fields if key not in expected]
            additions = []
            if extra:
                cursor = await db.execute(f"SELECT schema_json FROM {_LEDGER}")
                recorded = [json.loads(item[0]) for item in await cursor.fetchall()]
                for field in extra:
                    providers = [item for item in recorded if field in item.get("columns", {}).get(name, {})]
                    if len(providers) != 1 or providers[0]["columns"][name][field] != fields[field]:
                        raise StorageContractError("Unowned or changed additive product column")
                    additions.append(providers[0]["declarations"][name][field])
            original_sql = baseline["objects"][name]["sql"]
            expected_sql = original_sql
            if additions:
                # Let SQLite itself format ADD COLUMN around table-level
                # constraints. This schema-only in-memory check contains no
                # rows and cannot adopt or change the installation's data.
                scratch = sqlite3.connect(":memory:")
                try:
                    scratch.execute(original_sql)
                    for definition in additions:
                        scratch.execute(f'ALTER TABLE "{name}" ADD COLUMN {definition}')
                    expected_sql = scratch.execute("SELECT sql FROM sqlite_master WHERE name = ?", (name,)).fetchone()[0]
                finally:
                    scratch.close()
            if table_sql != expected_sql:
                raise StorageContractError("Product table constraints differ from its installed schema")
            table_sql = original_sql
            fields = {key: fields[key] for key in expected}
        cursor = await db.execute(f'PRAGMA foreign_key_list("{name}")')
        snapshot["objects"][name] = {"sql": table_sql, "columns": fields, "foreign_keys": [list(row) for row in await cursor.fetchall()]}
    for table, columns in contract["parsed_columns"].items():
        cursor = await db.execute(f'PRAGMA table_info("{table}")')
        fields = {row[1]: list(row)[1:] for row in await cursor.fetchall()}
        if not columns.keys() <= fields.keys():
            raise StorageContractError("Installed product columns are incomplete")
        snapshot["columns"][table] = {name: fields[name] for name in columns}
    return snapshot


async def verify_storage(db, contracts):
    if not contracts:
        return
    cursor = await db.execute("SELECT name FROM sqlite_master WHERE name = ?", (_LEDGER,))
    if not await cursor.fetchone():
        raise StorageContractError("Initialize the explicitly selected product storage first")
    for contract in contracts:
        cursor = await db.execute(f"SELECT version, digest, schema_json FROM {_LEDGER} WHERE owner = ?", (contract["owner"],))
        row = await cursor.fetchone()
        if not row or (row[0], row[1]) != (contract["version"], contract["digest"]):
            raise StorageContractError("Product schema version/hash changed; implicit upgrades are refused")
        baseline = json.loads(row[2])
        if baseline != await _snapshot(db, contract, baseline):
            raise StorageContractError("Product schema differs from its installed declaration")


async def apply_storage(db, contracts):
    if not contracts:
        return
    await db.execute(f"CREATE TABLE IF NOT EXISTS {_LEDGER} (owner TEXT PRIMARY KEY, version INTEGER NOT NULL, digest TEXT NOT NULL, schema_json TEXT NOT NULL)")
    for contract in contracts:
        cursor = await db.execute(f"SELECT version, digest FROM {_LEDGER} WHERE owner = ?", (contract["owner"],))
        row = await cursor.fetchone()
        if row:
            if tuple(row) != (contract["version"], contract["digest"]):
                raise StorageContractError("Product schema version/hash changed; implicit upgrades are refused")
            continue
        # Plain CREATE deliberately refuses collisions instead of adopting an
        # existing unowned table. No data-changing statements or legacy replay.
        for statement in contract["statements"]:
            await db.execute(statement)
        for table, definitions in contract["parsed_columns"].items():
            if table not in _HOST_TABLES:
                cursor = await db.execute(f"SELECT owner, schema_json FROM {_LEDGER}")
                owners = [owner for owner, snapshot in await cursor.fetchall()
                          if table in json.loads(snapshot)["objects"]
                          and isinstance(json.loads(snapshot)["objects"][table], dict)]
                if len(owners) != 1 or owners[0] not in contract.get("requires", []):
                    raise StorageContractError("Column target must be a core port or a directly required product table")
            cursor = await db.execute(f'PRAGMA table_info("{table}")')
            existing = {row[1] for row in await cursor.fetchall()}
            for name, definition in definitions.items():
                if name in existing:
                    raise StorageContractError("Refusing to adopt an existing unowned product column")
                await db.execute(f'ALTER TABLE "{table}" ADD COLUMN {definition}')
        snapshot = await _snapshot(db, contract)
        await db.execute(f"INSERT INTO {_LEDGER} VALUES (?, ?, ?, ?)",
                         (contract["owner"], contract["version"], contract["digest"], json.dumps(snapshot, sort_keys=True)))
    await verify_storage(db, contracts)
