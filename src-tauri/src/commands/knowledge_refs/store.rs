//! `.atlas/knowledge-refs.db` — which conversations referenced which notes.
//!
//! Its own database rather than a table in `sessions.db`: capture is opt-in
//! and most projects have no `sessions.db`, while this has to work everywhere.
//!
//! One row per *event* (`source_key`), so a live sighting and the backfill
//! that later re-reads the same history land on the same row — `INSERT OR
//! IGNORE` is what makes the two paths safe to overlap. Hit counts are
//! `COUNT(*)` over those rows.
//!
//! Created lazily, by the first reference: a project that never uses its
//! Knowledge Base never gets the file.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;

use super::extract::Ref;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS ref_event (
    session_id TEXT NOT NULL,
    entry_id   TEXT NOT NULL,
    kind       TEXT NOT NULL,
    source_key TEXT NOT NULL,
    at         TEXT NOT NULL,
    PRIMARY KEY (session_id, entry_id, kind, source_key)
);
CREATE INDEX IF NOT EXISTS idx_ref_event_entry ON ref_event (entry_id);
CREATE TABLE IF NOT EXISTS unresolved (
    session_id TEXT NOT NULL,
    title      TEXT NOT NULL,
    source_key TEXT NOT NULL,
    PRIMARY KEY (session_id, title, source_key)
);
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

const BACKFILL_VERSION_KEY: &str = "backfill_version";

pub fn db_path(project_path: &str) -> PathBuf {
    Path::new(project_path)
        .join(".atlas")
        .join("knowledge-refs.db")
}

/// One (note, kind) a session referenced.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRefRow {
    pub entry_id: String,
    pub kind: String,
    pub hits: i64,
    pub last_at: String,
}

/// One (session, kind) that referenced a note.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EntryRefRow {
    pub session_id: String,
    pub kind: String,
    pub hits: i64,
    pub last_at: String,
}

pub struct RefStore {
    conn: Connection,
}

impl RefStore {
    /// Open the project's store. With `create == false` a missing database is
    /// `Ok(None)` — a read must never be what plants the file.
    pub fn open(project_path: &str, create: bool) -> Result<Option<Self>, String> {
        let path = db_path(project_path);
        if !create && !path.exists() {
            return Ok(None);
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        if create {
            flags |= OpenFlags::SQLITE_OPEN_CREATE;
        }
        let conn = Connection::open_with_flags(&path, flags)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        Self::init(conn).map(Some)
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self::init(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn init(conn: Connection) -> Result<Self, String> {
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        Ok(Self { conn })
    }

    /// Record `refs` for a session. Returns how many were new.
    pub fn insert(&mut self, session_id: &str, refs: &[Ref], at: &str) -> Result<usize, String> {
        if refs.is_empty() {
            return Ok(0);
        }
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let mut added = 0;
        {
            let mut stmt = tx
                .prepare_cached(
                    "INSERT OR IGNORE INTO ref_event (session_id, entry_id, kind, source_key, at) \
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )
                .map_err(|e| e.to_string())?;
            for r in refs {
                added += stmt
                    .execute(params![
                        session_id,
                        r.entry_id,
                        r.kind.as_str(),
                        r.source_key,
                        at
                    ])
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(added)
    }

    /// Record `memory_search` titles that no longer name exactly one note.
    pub fn insert_unresolved(
        &mut self,
        session_id: &str,
        titles: &[String],
        source_key: &str,
    ) -> Result<usize, String> {
        let mut added = 0;
        for title in titles {
            added += self
                .conn
                .execute(
                    "INSERT OR IGNORE INTO unresolved (session_id, title, source_key) VALUES (?1, ?2, ?3)",
                    params![session_id, title, source_key],
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(added)
    }

    pub fn for_session(&self, session_id: &str) -> Result<Vec<SessionRefRow>, String> {
        let mut stmt = self
            .conn
            .prepare_cached(
                "SELECT entry_id, kind, COUNT(*), MAX(at) FROM ref_event \
                 WHERE session_id = ?1 GROUP BY entry_id, kind ORDER BY MIN(at), entry_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![session_id], |row| {
                Ok(SessionRefRow {
                    entry_id: row.get(0)?,
                    kind: row.get(1)?,
                    hits: row.get(2)?,
                    last_at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    /// How many distinct titles in this session's search results could not be
    /// pinned to a note.
    pub fn unresolved_count(&self, session_id: &str) -> Result<i64, String> {
        self.conn
            .query_row(
                "SELECT COUNT(DISTINCT title) FROM unresolved WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())
    }

    pub fn for_entry(&self, entry_id: &str) -> Result<Vec<EntryRefRow>, String> {
        let mut stmt = self
            .conn
            .prepare_cached(
                "SELECT session_id, kind, COUNT(*), MAX(at) FROM ref_event \
                 WHERE entry_id = ?1 GROUP BY session_id, kind ORDER BY MAX(at) DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![entry_id], |row| {
                Ok(EntryRefRow {
                    session_id: row.get(0)?,
                    kind: row.get(1)?,
                    hits: row.get(2)?,
                    last_at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    pub fn backfill_version(&self) -> Result<Option<i64>, String> {
        self.conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                params![BACKFILL_VERSION_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map(|v| v.and_then(|s| s.parse().ok()))
            .map_err(|e| e.to_string())
    }

    pub fn set_backfill_version(&self, version: i64) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![BACKFILL_VERSION_KEY, version.to_string()],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::knowledge_refs::extract::RefKind;

    fn r(entry: &str, kind: RefKind, key: &str) -> Ref {
        Ref {
            entry_id: entry.into(),
            kind,
            source_key: key.into(),
        }
    }

    #[test]
    fn the_same_event_seen_twice_counts_once() {
        let mut store = RefStore::in_memory();
        let refs = [r("a", RefKind::Read, "call:1")];
        assert_eq!(
            store.insert("s1", &refs, "2026-01-01T00:00:00Z").unwrap(),
            1
        );
        assert_eq!(
            store.insert("s1", &refs, "2026-01-02T00:00:00Z").unwrap(),
            0
        );
        let rows = store.for_session("s1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].hits, 1);
    }

    #[test]
    fn distinct_events_add_hits_per_kind() {
        let mut store = RefStore::in_memory();
        store
            .insert(
                "s1",
                &[
                    r("a", RefKind::Retrieved, "search:1"),
                    r("a", RefKind::Retrieved, "search:2"),
                    r("a", RefKind::Read, "call:1"),
                ],
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
        let rows = store.for_session("s1").unwrap();
        let retrieved = rows.iter().find(|x| x.kind == "retrieved").unwrap();
        assert_eq!(retrieved.hits, 2);
        assert_eq!(rows.iter().find(|x| x.kind == "read").unwrap().hits, 1);
    }

    #[test]
    fn a_note_lists_every_session_that_used_it_newest_first() {
        let mut store = RefStore::in_memory();
        store
            .insert(
                "old",
                &[r("a", RefKind::Mention, "m:1")],
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
        store
            .insert(
                "new",
                &[r("a", RefKind::Read, "call:9")],
                "2026-02-01T00:00:00Z",
            )
            .unwrap();
        store
            .insert(
                "other",
                &[r("b", RefKind::Read, "call:3")],
                "2026-03-01T00:00:00Z",
            )
            .unwrap();
        let sessions: Vec<_> = store
            .for_entry("a")
            .unwrap()
            .into_iter()
            .map(|x| x.session_id)
            .collect();
        assert_eq!(sessions, vec!["new", "old"]);
    }

    #[test]
    fn unresolved_titles_count_distinct_per_session() {
        let mut store = RefStore::in_memory();
        store
            .insert_unresolved("s1", &["x".into(), "y".into()], "search:1")
            .unwrap();
        store
            .insert_unresolved("s1", &["x".into()], "search:2")
            .unwrap();
        assert_eq!(store.unresolved_count("s1").unwrap(), 2);
        assert_eq!(store.unresolved_count("s2").unwrap(), 0);
    }

    #[test]
    fn the_backfill_version_round_trips() {
        let store = RefStore::in_memory();
        assert_eq!(store.backfill_version().unwrap(), None);
        store.set_backfill_version(3).unwrap();
        store.set_backfill_version(4).unwrap();
        assert_eq!(store.backfill_version().unwrap(), Some(4));
    }

    #[test]
    fn a_read_never_creates_the_database() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        assert!(RefStore::open(&project, false).unwrap().is_none());
        assert!(!db_path(&project).exists());
        assert!(RefStore::open(&project, true).unwrap().is_some());
        assert!(db_path(&project).exists());
    }
}
