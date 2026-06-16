from pathlib import Path

import aiosqlite

DB_PATH = Path(__file__).parent.parent / "data" / "events.db"


async def _ensure_column(db: aiosqlite.Connection, table: str, column: str, definition: str) -> None:
    cursor = await db.execute(f"PRAGMA table_info({table})")
    columns = [row[1] for row in await cursor.fetchall()]
    if column not in columns:
        await db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


async def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                google_id TEXT UNIQUE NOT NULL,
                email TEXT NOT NULL,
                name TEXT,
                picture TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                filename TEXT NOT NULL,
                file_type TEXT NOT NULL,
                uploaded_at TEXT NOT NULL,
                raw_text TEXT,
                summary TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id INTEGER,
                title TEXT NOT NULL,
                description TEXT,
                event_date TEXT NOT NULL,
                end_date TEXT,
                event_time TEXT,
                location TEXT,
                category TEXT,
                notes TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (document_id) REFERENCES documents(id)
            )
            """
        )
        await _ensure_column(db, "documents", "user_id", "INTEGER REFERENCES users(id)")
        await _ensure_column(db, "documents", "stored_path", "TEXT")
        await _ensure_column(db, "events", "user_id", "INTEGER REFERENCES users(id)")
        await _ensure_column(db, "events", "source_filename", "TEXT")
        await db.commit()


async def upsert_user(
    google_id: str,
    email: str,
    name: str,
    picture: str,
    created_at: str,
) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM users WHERE google_id = ?", (google_id,))
        row = await cursor.fetchone()
        if row:
            await db.execute(
                "UPDATE users SET email = ?, name = ?, picture = ? WHERE google_id = ?",
                (email, name, picture, google_id),
            )
            await db.commit()
            cursor = await db.execute("SELECT * FROM users WHERE google_id = ?", (google_id,))
            return dict(await cursor.fetchone())

        cursor = await db.execute(
            """
            INSERT INTO users (google_id, email, name, picture, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (google_id, email, name, picture, created_at),
        )
        await db.commit()
        cursor = await db.execute("SELECT * FROM users WHERE id = ?", (cursor.lastrowid,))
        return dict(await cursor.fetchone())


async def get_user_by_id(user_id: int) -> dict | None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None


async def save_document(
    user_id: int,
    filename: str,
    file_type: str,
    uploaded_at: str,
    raw_text: str,
    summary: str,
    stored_path: str = "",
) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            """
            INSERT INTO documents (
                user_id, filename, file_type, uploaded_at, raw_text, summary, stored_path
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (user_id, filename, file_type, uploaded_at, raw_text, summary, stored_path),
        )
        await db.commit()
        return cursor.lastrowid


async def save_events(document_id: int, events: list[dict], created_at: str) -> int:
    count = 0
    async with aiosqlite.connect(DB_PATH) as db:
        for event in events:
            await db.execute(
                """
                INSERT INTO events (
                    document_id, title, description, event_date, end_date,
                    event_time, location, category, notes, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    document_id,
                    event.get("title", "未命名活動"),
                    event.get("description"),
                    event.get("event_date"),
                    event.get("end_date"),
                    event.get("event_time"),
                    event.get("location"),
                    event.get("category"),
                    event.get("notes"),
                    created_at,
                ),
            )
            count += 1
        await db.commit()
    return count


async def get_events_for_user(user_id: int) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT e.*, COALESCE(e.source_filename, d.filename, '手動新增') AS filename
            FROM events e
            LEFT JOIN documents d ON e.document_id = d.id
            WHERE d.user_id = ? OR (e.document_id IS NULL AND e.user_id = ?)
            ORDER BY e.event_date ASC
            """,
            (user_id, user_id),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def get_event_by_id(event_id: int, user_id: int) -> dict | None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT e.*, COALESCE(e.source_filename, d.filename, '手動新增') AS filename
            FROM events e
            LEFT JOIN documents d ON e.document_id = d.id
            WHERE e.id = ?
              AND (d.user_id = ? OR (e.document_id IS NULL AND e.user_id = ?))
            """,
            (event_id, user_id, user_id),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def create_manual_event(user_id: int, data: dict, created_at: str) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            """
            INSERT INTO events (
                document_id, user_id, source_filename, title, description, event_date,
                end_date, event_time, location, category, notes, created_at
            )
            VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                data.get("source_filename", "手動新增"),
                data.get("title", "未命名活動"),
                data.get("description"),
                data["event_date"],
                data.get("end_date"),
                data.get("event_time"),
                data.get("location"),
                data.get("category", "other"),
                data.get("notes"),
                created_at,
            ),
        )
        await db.commit()
        return cursor.lastrowid


async def create_events_bulk(
    user_id: int,
    events: list[dict],
    source_filename: str,
    created_at: str,
) -> list[int]:
    ids = []
    async with aiosqlite.connect(DB_PATH) as db:
        for event in events:
            event_date = event.get("event_date")
            if not event_date:
                continue
            cursor = await db.execute(
                """
                INSERT INTO events (
                    document_id, user_id, source_filename, title, description, event_date,
                    end_date, event_time, location, category, notes, created_at
                )
                VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    event.get("source_filename") or source_filename,
                    event.get("title", "未命名活動"),
                    event.get("description"),
                    event_date,
                    event.get("end_date"),
                    event.get("event_time"),
                    event.get("location"),
                    event.get("category", "other"),
                    event.get("notes"),
                    created_at,
                ),
            )
            ids.append(cursor.lastrowid)
        await db.commit()
    return ids


async def delete_events_by_ids(user_id: int, event_ids: list[int]) -> int:
    if not event_ids:
        return 0
    placeholders = ",".join("?" * len(event_ids))
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            f"""
            DELETE FROM events
            WHERE id IN ({placeholders})
              AND (
                document_id IN (SELECT id FROM documents WHERE user_id = ?)
                OR (document_id IS NULL AND user_id = ?)
              )
            """,
            (*event_ids, user_id, user_id),
        )
        await db.commit()
        return cursor.rowcount


async def update_event(event_id: int, user_id: int, data: dict) -> bool:
    existing = await get_event_by_id(event_id, user_id)
    if not existing:
        return False

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            UPDATE events
            SET title = ?, description = ?, event_date = ?, end_date = ?,
                event_time = ?, location = ?, category = ?, notes = ?
            WHERE id = ?
            """,
            (
                data.get("title", existing["title"]),
                data.get("description", existing.get("description")),
                data.get("event_date", existing["event_date"]),
                data.get("end_date", existing.get("end_date")),
                data.get("event_time", existing.get("event_time")),
                data.get("location", existing.get("location")),
                data.get("category", existing.get("category", "other")),
                data.get("notes", existing.get("notes")),
                event_id,
            ),
        )
        await db.commit()
        return True


async def get_documents_for_user(user_id: int) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT d.*, COUNT(e.id) AS event_count
            FROM documents d
            LEFT JOIN events e ON e.document_id = d.id
            WHERE d.user_id = ?
            GROUP BY d.id
            ORDER BY d.uploaded_at DESC
            """,
            (user_id,),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def get_document_by_id(document_id: int, user_id: int) -> dict | None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM documents WHERE id = ? AND user_id = ?",
            (document_id, user_id),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def delete_document(document_id: int, user_id: int) -> dict | None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM documents WHERE id = ? AND user_id = ?",
            (document_id, user_id),
        )
        row = await cursor.fetchone()
        if not row:
            return None

        doc = dict(row)
        await db.execute("DELETE FROM events WHERE document_id = ?", (document_id,))
        await db.execute(
            "DELETE FROM documents WHERE id = ? AND user_id = ?",
            (document_id, user_id),
        )
        await db.commit()
        return doc


async def delete_event(event_id: int, user_id: int) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            """
            DELETE FROM events
            WHERE id = ?
              AND (
                document_id IN (SELECT id FROM documents WHERE user_id = ?)
                OR (document_id IS NULL AND user_id = ?)
              )
            """,
            (event_id, user_id, user_id),
        )
        await db.commit()
        return cursor.rowcount > 0