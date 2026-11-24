use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

fn db_path() -> Result<PathBuf, String> {
    Ok(crate::keys::data_root()?.join("belen.db"))
}

fn open() -> Result<Connection, String> {
    let conn = Connection::open(db_path()?).map_err(|e| e.to_string())?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS rooms (
            id TEXT PRIMARY KEY,
            json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;

    // v2: composite (room_id, id) keys and a room-scoped FTS index. Older dev
    // databases are rebuilt; the room JSON in `rooms` is preserved.
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(0);
    if version < 2 {
        conn.execute_batch(
            "DROP TABLE IF EXISTS blocks_fts;
             DROP TABLE IF EXISTS blocks;
             PRAGMA user_version = 2;",
        )
        .map_err(|e| e.to_string())?;
    }

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS blocks (
            room_id TEXT NOT NULL,
            id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            kind TEXT NOT NULL,
            text TEXT,
            PRIMARY KEY (room_id, id)
        );
        CREATE INDEX IF NOT EXISTS blocks_room ON blocks(room_id, seq);
        CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
            id UNINDEXED,
            room_id UNINDEXED,
            text
        );",
    )
    .map_err(|e| e.to_string())?;

    Ok(conn)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn save_room(room_id: &str, json: &str) -> Result<(), String> {
    let mut conn = open()?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO rooms (id, json, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
        params![room_id, json, now_ms()],
    )
    .map_err(|e| e.to_string())?;

    // FTS rows are scoped by room; deleting by current block ids misses rows
    // whose ids were replaced by another room.
    tx.execute(
        "DELETE FROM blocks_fts WHERE room_id = ?1",
        params![room_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM blocks WHERE room_id = ?1", params![room_id])
        .map_err(|e| e.to_string())?;

    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let empty = Vec::new();
    let order = value["order"].as_array().unwrap_or(&empty);
    let by_id = value["byId"].as_object();

    for (seq, id) in order.iter().enumerate() {
        let Some(id) = id.as_str() else { continue };
        let Some(block) = by_id.and_then(|m| m.get(id)) else {
            continue;
        };
        let kind = block["kind"].as_str().unwrap_or("text");
        let text = block["text"].as_str().unwrap_or("");

        tx.execute(
            "INSERT OR REPLACE INTO blocks (room_id, id, seq, kind, text) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![room_id, id, seq as i64, kind, text],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO blocks_fts (id, room_id, text) VALUES (?1, ?2, ?3)",
            params![id, room_id, text],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())
}

pub fn load_room(room_id: &str) -> Result<Option<String>, String> {
    let conn = open()?;
    let mut stmt = conn
        .prepare("SELECT json FROM rooms WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![room_id]).map_err(|e| e.to_string())?;

    match rows.next().map_err(|e| e.to_string())? {
        Some(row) => Ok(Some(row.get(0).map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

#[derive(serde::Serialize)]
pub struct SearchHit {
    pub id: String,
    pub snippet: String,
}

pub fn search(query: &str) -> Result<Vec<SearchHit>, String> {
    let terms: Vec<String> = query
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"", t.replace('"', "")))
        .collect();

    if terms.is_empty() {
        return Ok(Vec::new());
    }

    let conn = open()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, snippet(blocks_fts, 2, '<<', '>>', '…', 12)
             FROM blocks_fts WHERE blocks_fts MATCH ?1 LIMIT 20",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![terms.join(" ")], |row| {
            Ok(SearchHit {
                id: row.get(0)?,
                snippet: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}
