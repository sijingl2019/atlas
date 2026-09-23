use serde::{Deserialize, Serialize};

/// How an indexed document is split before embedding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ChunkMode {
    /// Split Markdown-ish text on blank lines, then merge small paragraphs.
    #[default]
    Paragraph,
    /// Keep the whole document as one vector.
    Whole,
}

/// One embeddable chunk produced from a [`crate::CorpusDoc`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub id: String,
    pub parent_id: String,
    pub chunk_index: usize,
    pub text: String,
    pub content_hash: String,
}

const TARGET_CHARS: usize = 400;
const OVERLAP_CHARS: usize = 48;

/// Split an embedded `title\n\nbody` document into stable chunks.
///
/// The title is kept in every chunk so short queries still have document-level
/// signal. Paragraph mode deliberately uses character counts rather than model
/// token counts: the local embedder truncates long inputs itself, and a small
/// deterministic rule is easier to test and keep stable across model changes.
pub fn chunk_document(
    id: &str,
    embedded_text: &str,
    content_hash: &str,
    mode: ChunkMode,
) -> Vec<Chunk> {
    if mode == ChunkMode::Whole {
        return vec![Chunk {
            id: id.to_string(),
            parent_id: id.to_string(),
            chunk_index: 0,
            text: embedded_text.to_string(),
            content_hash: content_hash.to_string(),
        }];
    }

    // Normalize line endings before splitting: Markdown files commonly use
    // CRLF on Windows, and the title/body and blank-line boundaries both rely
    // on `\n\n`.
    let normalized = embedded_text.replace("\r\n", "\n").replace('\r', "\n");
    let (title, body) = crate::docstore::split_embedded(&normalized);
    if body.trim().is_empty() {
        return vec![Chunk {
            id: id.to_string(),
            parent_id: id.to_string(),
            chunk_index: 0,
            text: embedded_text.to_string(),
            content_hash: content_hash.to_string(),
        }];
    }

    let paragraphs = body
        .split("\n\n")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>();
    let mut chunks: Vec<Chunk> = Vec::new();
    let mut current = String::new();

    let flush = |current: &mut String, chunks: &mut Vec<Chunk>| {
        let text = current.trim();
        if text.is_empty() {
            current.clear();
            return;
        }
        let chunk_text = if title.is_empty() {
            text.to_string()
        } else {
            format!("{title}\n\n{text}")
        };
        let chunk_index = chunks.len();
        let digest = hash_hex(&chunk_text);
        let mut chunk_id = format!("{id}#{digest}");
        // Identical paragraphs in one document must still get distinct ids.
        let mut suffix = 2usize;
        while chunks.iter().any(|c| c.id == chunk_id) {
            chunk_id = format!("{id}#{digest}-{suffix}");
            suffix += 1;
        }
        chunks.push(Chunk {
            id: chunk_id,
            parent_id: id.to_string(),
            chunk_index,
            content_hash: hash_hex(&chunk_text),
            text: chunk_text,
        });
        current.clear();
    };

    for paragraph in paragraphs {
        let parts = split_long_paragraph(paragraph);
        for part in parts {
            if current.is_empty() {
                current.push_str(&part);
                continue;
            }
            let joined_len = current.chars().count() + 2 + part.chars().count();
            if joined_len <= TARGET_CHARS {
                current.push_str("\n\n");
                current.push_str(&part);
            } else {
                flush(&mut current, &mut chunks);
                if let Some(tail) = overlap_tail(&chunks, &part) {
                    current.push_str(&tail);
                    if !current.is_empty() {
                        current.push_str("\n\n");
                    }
                }
                current.push_str(&part);
            }
        }
    }
    flush(&mut current, &mut chunks);

    // A document whose body contains only whitespace should still be indexed.
    if chunks.is_empty() {
        chunks.push(Chunk {
            id: id.to_string(),
            parent_id: id.to_string(),
            chunk_index: 0,
            text: embedded_text.to_string(),
            content_hash: content_hash.to_string(),
        });
    }
    chunks
}

/// Split a single oversized paragraph at sentence boundaries, falling back to
/// a hard character cut when no sentence punctuation exists.
fn split_long_paragraph(paragraph: &str) -> Vec<String> {
    if paragraph.chars().count() <= TARGET_CHARS {
        return vec![paragraph.to_string()];
    }

    let mut out = Vec::new();
    let mut current = String::new();
    let mut sentence_start = 0usize;
    let chars = paragraph.char_indices().collect::<Vec<_>>();
    for (i, (byte_idx, ch)) in chars.iter().enumerate() {
        current.push(*ch);
        let is_end = matches!(ch, '。' | '！' | '？' | '；' | '.' | '!' | '?' | ';');
        // A CJK sentence ending is normally followed immediately by the next
        // character (no space), so treat non-ASCII as a sentence boundary too.
        let next_is_boundary = chars
            .get(i + 1)
            .map(|(_, next)| next.is_whitespace() || !next.is_ascii())
            .unwrap_or(true);
        if is_end && next_is_boundary {
            sentence_start = *byte_idx + ch.len_utf8();
        }
        if current.chars().count() >= TARGET_CHARS {
            let cut = if sentence_start > 0 {
                sentence_start
            } else {
                *byte_idx + ch.len_utf8()
            };
            let piece = paragraph[..cut].trim();
            if !piece.is_empty() {
                out.push(piece.to_string());
            }
            current = paragraph[cut..].to_string();
            sentence_start = 0;
        }
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_string());
    }
    out
}

/// Return a short tail from the previous chunk to preserve context at
/// paragraph boundaries. The overlap is intentionally small: it improves
/// recall around split sentences without duplicating large blocks.
fn overlap_tail(chunks: &[Chunk], next_part: &str) -> Option<String> {
    let previous = chunks.last()?;
    let body = previous
        .text
        .split_once("\n\n")
        .map(|(_, body)| body)
        .unwrap_or(previous.text.as_str());
    let tail = body
        .chars()
        .rev()
        .take(OVERLAP_CHARS)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    if tail.trim().is_empty() || next_part.starts_with(tail.trim()) {
        None
    } else {
        Some(tail)
    }
}

fn hash_hex(text: &str) -> String {
    // FNV-1a is stable across process restarts and platforms. Chunk ids are
    // internal manifest keys; the content hash only needs change detection, not
    // cryptographic collision resistance.
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whole_mode_returns_one_chunk() {
        let chunks = chunk_document("kb:a", "Title\n\nBody", "h", ChunkMode::Whole);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].id, "kb:a");
        assert_eq!(chunks[0].content_hash, "h");
    }

    #[test]
    fn paragraph_mode_splits_blank_lines_and_keeps_title() {
        let chunks = chunk_document(
            "kb:a",
            "Title\n\nFirst paragraph.\n\nSecond paragraph.",
            "h",
            ChunkMode::Paragraph,
        );
        assert!(!chunks.is_empty());
        assert!(chunks.iter().all(|c| c.text.starts_with("Title\n\n")));
        assert!(chunks.iter().all(|c| c.parent_id == "kb:a"));
        assert!(chunks.iter().all(|c| c.chunk_index < chunks.len()));
    }

    #[test]
    fn paragraph_mode_is_deterministic() {
        let text = "Title\n\nAlpha paragraph.\n\nBeta paragraph.";
        let a = chunk_document("kb:a", text, "h", ChunkMode::Paragraph);
        let b = chunk_document("kb:a", text, "h", ChunkMode::Paragraph);
        assert_eq!(a, b);
    }

    #[test]
    fn paragraph_mode_handles_crlf_blank_lines() {
        let chunks = chunk_document(
            "kb:a",
            "Title\r\n\r\nFirst paragraph.\r\n\r\nSecond paragraph.",
            "h",
            ChunkMode::Paragraph,
        );
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0]
            .text
            .contains("First paragraph.\n\nSecond paragraph."));
        assert!(!chunks[0].text.contains('\r'));
    }

    #[test]
    fn long_cjk_paragraph_splits_at_sentence_boundary() {
        let first = format!("{}?", "?".repeat(200));
        let second = format!("{}?", "?".repeat(250));
        let text = format!("Title\n\n{first}{second}");
        let chunks = chunk_document("kb:a", &text, "h", ChunkMode::Paragraph);
        assert!(chunks.len() >= 2);
        assert!(chunks[0].text.ends_with('?'));
    }
}
