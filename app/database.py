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
) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            """
            INSERT INTO documents (user_id, filename, file_type, uploaded_at, raw_text, summary)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (user_id, filename, file_type, uploaded_at, raw_text, summary),
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
            SELECT e.*, d.filename
            FROM events e
            INNER JOIN documents d ON e.document_id = d.id
            WHERE d.user_id = ?
            ORDER BY e.event_date ASC
            """,
            (user_id,),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def get_documents_for_user(user_id: int) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM documents WHERE user_id = ? ORDER BY uploaded_at DESC",
            (user_id,),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def delete_event(event_id: int, user_id: int) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            """
            DELETE FROM events
            WHERE id = ?
              AND document_id IN (SELECT id FROM documents WHERE user_id = ?)
            """,
            (event_id, user_id),
        )
        await db.commit()
        return cursor.rowcount > 0