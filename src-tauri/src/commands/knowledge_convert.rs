//! Native Rust MarkItDown conversion for the memory corpus, never the editor.
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use markitdown::{model::ConversionOptions, MarkItDown};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const CONVERTER_VERSION: &str = "markitdown-rs-0.1.11-v1";
const MAX_INPUT_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
struct CachedConversion {
    fingerprint: String,
    result: Result<String, String>,
}

pub(super) async fn convert(project: &str, source: &Path) -> Result<String, String> {
    let project = project.to_string();
    let source = source.to_path_buf();
    tokio::task::spawn_blocking(move || convert_cached(&project, &source))
        .await
        .map_err(|e| format!("Knowledge conversion task failed: {e}"))?
}

fn convert_cached(project: &str, source: &Path) -> Result<String, String> {
    let metadata = fs::metadata(source).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_INPUT_BYTES {
        return Err("MarkItDown input exceeds 64 MiB".into());
    }
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .unwrap_or_default()
        .as_nanos();
    let fingerprint = format!("{CONVERTER_VERSION}:{}:{modified}", metadata.len());
    let key = format!("{:x}", Sha256::digest(source.to_string_lossy().as_bytes()));
    let cache_dir = Path::new(project).join(".atlas/cache/knowledge-markdown");
    let cache_path = cache_dir.join(format!("{key}.json"));
    if let Ok(raw) = fs::read(&cache_path) {
        if let Ok(cached) = serde_json::from_slice::<CachedConversion>(&raw) {
            if cached.fingerprint == fingerprint {
                return cached.result;
            }
        }
    }

    let bytes = fs::read(source).map_err(|e| e.to_string())?;
    // The upstream converters contain parser unwraps. A malformed attachment
    // must not take down indexing for the rest of the knowledge base.
    let result = std::panic::catch_unwind(|| convert_bytes(source, &bytes))
        .unwrap_or_else(|_| Err("MarkItDown could not parse the document".into()));
    let cached = CachedConversion {
        fingerprint,
        result: result.clone(),
    };
    if fs::create_dir_all(&cache_dir).is_ok() {
        if let Ok(raw) = serde_json::to_vec(&cached) {
            let tmp = cache_dir.join(format!("{key}-{}.tmp", uuid::Uuid::new_v4()));
            if fs::write(&tmp, raw).is_ok() {
                let _ = fs::rename(&tmp, &cache_path);
                let _ = fs::remove_file(&tmp);
            }
        }
    }
    result
}

fn convert_bytes(source: &Path, bytes: &[u8]) -> Result<String, String> {
    let extension = source
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let converter = MarkItDown::new();
    let options = ConversionOptions {
        // Explicit extensions keep Office documents from being detected as ZIPs.
        file_extension: Some(format!(".{extension}")),
        url: None,
        llm_client: None,
        llm_model: None,
    };
    // Use the in-memory API: upstream's path-based ZIP converter extracts files
    // using archive names, while convert_bytes never writes archive members.
    let converted = converter
        .convert_bytes(bytes, Some(options))
        .map_err(|e| e.to_string())?;
    let markdown = match converted {
        Some(result) => result.text_content,
        None if matches!(
            extension.as_str(),
            "txt" | "text" | "log" | "json" | "yaml" | "yml" | "toml" | "md" | "markdown" | ""
        ) =>
        {
            String::from_utf8(bytes.to_vec()).map_err(|e| e.to_string())?
        }
        None => return Err("MarkItDown does not support this file or could not parse it".into()),
    };
    if markdown.trim().is_empty() {
        return Err("MarkItDown returned no text".into());
    }
    Ok(markdown.chars().take(2_000_000).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_csv_html_and_plain_text_without_external_runtimes() {
        let csv = convert_bytes(Path::new("数据.CSV"), b"name,value\nAtlas,42").unwrap();
        assert!(csv.contains("Atlas,42"));
        let html = convert_bytes(
            Path::new("page.html"),
            b"<h1>Atlas</h1><p>Searchable body</p>",
        )
        .unwrap();
        assert!(html.contains("Atlas"));
        assert!(pulldown_cmark::Parser::new(&html).any(|event| matches!(
            event,
            pulldown_cmark::Event::Start(pulldown_cmark::Tag::Heading {
                level: pulldown_cmark::HeadingLevel::H1,
                ..
            })
        )));
        assert!(html.contains("Searchable body"));
        assert_eq!(
            convert_bytes(Path::new("note.txt"), b"plain text").unwrap(),
            "plain text"
        );
        assert!(convert_bytes(Path::new("broken.jpg"), &[0xff, 0xd8]).is_err());
    }

    #[test]
    fn converts_office_documents_and_pdf_bytes() {
        let docx = convert_bytes(
            Path::new("sample.docx"),
            include_bytes!("../../tests/fixtures/knowledge/sample.docx"),
        )
        .unwrap();
        assert!(docx.contains("Atlas document content"));
        let pdf = convert_bytes(
            Path::new("sample.pdf"),
            include_bytes!("../../tests/fixtures/knowledge/sample.pdf"),
        )
        .unwrap();
        assert!(pdf.contains("Atlas PDF content"));
    }

    #[test]
    fn caches_results_and_invalidates_modified_sources() {
        let root = std::env::temp_dir().join(format!("atlas-convert-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source file.csv");
        fs::write(&source, "name,value\nAtlas,42").unwrap();
        let project = root.to_str().unwrap();
        let first = convert_cached(project, &source).unwrap();
        let cache = fs::read_dir(root.join(".atlas/cache/knowledge-markdown"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let before = fs::metadata(&cache).unwrap().modified().unwrap();
        assert_eq!(convert_cached(project, &source).unwrap(), first);
        assert_eq!(fs::metadata(&cache).unwrap().modified().unwrap(), before);
        fs::write(&source, "name,value\nUpdated,12345").unwrap();
        assert!(convert_cached(project, &source)
            .unwrap()
            .contains("Updated,12345"));
        fs::write(&cache, "corrupt cache").unwrap();
        assert!(convert_cached(project, &source)
            .unwrap()
            .contains("Updated,12345"));
        fs::remove_dir_all(root).unwrap();
    }
}
