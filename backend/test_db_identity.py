"""get_db() under concurrent WAL writes and checkpoints (review finding 5)."""
import asyncio
import sqlite3
import threading
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import aiosqlite
import db as database


class DatabaseIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "test.db"
        for target, value in [("DATA_DIR", Path(self.tmp.name)), ("DB_PATH", self.path)]:
            p = patch.object(database, target, value); p.start(); self.addCleanup(p.stop)
        self.addCleanup(database.reset_identity_cache)
        database.reset_identity_cache()
        await database.init_db()

    async def test_identity_checked_once_per_file(self):
        calls = 0
        original = database._inspect_existing

        async def counting():
            nonlocal calls
            calls += 1
            return await original()

        with patch.object(database, "_inspect_existing", counting):
            for _ in range(5):
                conn = await database.get_db()
                await conn.close()
        self.assertEqual(calls, 0, "init_db already verified this file")
        database.reset_identity_cache()
        with patch.object(database, "_inspect_existing", counting):
            for _ in range(5):
                conn = await database.get_db()
                await conn.close()
        self.assertEqual(calls, 1)

    async def test_replaced_file_is_rechecked(self):
        self.path.unlink()
        for suffix in ("-wal", "-shm"):
            Path(str(self.path) + suffix).unlink(missing_ok=True)
        async with aiosqlite.connect(self.path) as conn:
            await conn.execute("CREATE TABLE foreign_table (x)")
            await conn.commit()
        with self.assertRaises(database.FreshDatabaseRequired):
            await database.get_db()

    async def test_get_db_survives_concurrent_writes_and_checkpoints(self):
        stop = threading.Event()
        errors = []

        def writer():
            conn = sqlite3.connect(self.path, timeout=10)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA wal_autocheckpoint=20")
            conn.execute("CREATE TABLE IF NOT EXISTS stress (i INTEGER, pad TEXT)")
            i = 0
            try:
                while not stop.is_set():
                    conn.execute("INSERT INTO stress VALUES (?, ?)", (i, "x" * 2000))
                    conn.commit()
                    i += 1
                    if i % 25 == 0:
                        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                    if i % 200 == 0:
                        conn.execute("DELETE FROM stress")
                        conn.commit()
            except Exception as exc:  # pragma: no cover - reported below
                errors.append(exc)
            finally:
                conn.close()

        threads = [threading.Thread(target=writer) for _ in range(2)]
        for t in threads:
            t.start()
        failures = []

        async def reader():
            for _ in range(150):
                try:
                    conn = await database.get_db()
                    try:
                        cur = await conn.execute("SELECT COUNT(*) FROM sessions")
                        await cur.fetchone()
                    finally:
                        await conn.close()
                except database.FreshDatabaseRequired as exc:
                    failures.append(exc)
                await asyncio.sleep(0)

        try:
            await asyncio.gather(*(reader() for _ in range(3)))
        finally:
            stop.set()
            for t in threads:
                t.join()
        self.assertEqual(errors, [])
        self.assertEqual(failures, [])


if __name__ == "__main__":
    unittest.main()
