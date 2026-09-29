//! An issue's description as the agent gets it. Trackers like ONES hand back
//! rich-text HTML whose content is often mostly screenshots; sent as is, the
//! agent reads markup and a link it cannot open (a presigned URL that lapses
//! within the hour). Here the HTML becomes plain text, and each `<img>` is
//! downloaded and attached where it stood.

use std::time::Duration;

use agent_client_protocol::schema::v1 as acp;
use base64::Engine as _;

/// Per image; a description's screenshots are well under this.
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_IMAGES: usize = 10;
const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, PartialEq)]
pub enum Part {
    Text(String),
    /// An image's `src`, entities decoded.
    Image(String),
}

/// Whether the description carries images worth fetching.
pub fn has_images(body: &str) -> bool {
    is_html(body) && body.to_ascii_lowercase().contains("<img")
}

fn is_html(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    ["</p>", "</div>", "</li>", "<br", "<img", "</figure>", "</h"]
        .iter()
        .any(|t| lower.contains(t))
}

/// `body` as text and images, in order. Plain text (Jira's v2 description)
/// comes back as one text part, untouched but for trimming.
pub fn parse(body: &str) -> Vec<Part> {
    if !is_html(body) {
        let t = body.trim();
        return if t.is_empty() {
            Vec::new()
        } else {
            vec![Part::Text(t.to_string())]
        };
    }
    let mut parts = Vec::new();
    let mut text = String::new();
    let mut pre = 0usize;
    let mut rest = body;
    while let Some(lt) = rest.find('<') {
        push_text(&mut text, &rest[..lt], pre > 0);
        let Some(gt) = rest[lt..].find('>') else {
            rest = &rest[lt..];
            break;
        };
        let tag = &rest[lt + 1..lt + gt];
        rest = &rest[lt + gt + 1..];
        let closing = tag.starts_with('/');
        let name: String = tag
            .trim_start_matches('/')
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        match name.as_str() {
            "img" => {
                if let Some(src) = attr(tag, "src").filter(|s| !s.is_empty()) {
                    flush(&mut parts, &mut text);
                    parts.push(Part::Image(src));
                }
            }
            "br" => text.push('\n'),
            "li" if !closing => text.push_str("\n- "),
            "pre" => {
                pre = if closing {
                    pre.saturating_sub(1)
                } else {
                    pre + 1
                };
                text.push('\n');
            }
            "li" => {}
            "p" | "div" | "figure" | "figcaption" | "blockquote" | "ul" | "ol" | "tr" | "table"
            | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => text.push('\n'),
            "td" | "th" if closing => text.push('\t'),
            _ => {}
        }
    }
    push_text(&mut text, rest, pre > 0);
    flush(&mut parts, &mut text);
    parts
}

fn push_text(out: &mut String, raw: &str, pre: bool) {
    let decoded = decode_entities(raw);
    if pre {
        out.push_str(&decoded);
    } else {
        // Source whitespace is layout, not content: one space at most, and
        // none opening a line.
        for c in decoded.chars() {
            if c.is_whitespace() {
                if !(out.is_empty() || out.ends_with(['\n', ' ', '\t'])) {
                    out.push(' ');
                }
            } else {
                out.push(c);
            }
        }
    }
}

/// Close the text run: trim lines, drop repeated blank lines.
fn flush(parts: &mut Vec<Part>, text: &mut String) {
    let mut out = String::new();
    let mut blank = 0;
    for line in text.lines().map(str::trim_end) {
        let line = if line.trim().is_empty() { "" } else { line };
        if line.is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    let out = out.trim();
    if !out.is_empty() {
        parts.push(Part::Text(out.to_string()));
    }
    text.clear();
}

/// A tag's attribute value, entities decoded. Matches `src=` but not
/// `data-src=`.
fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let pat = format!("{name}=");
    let mut from = 0;
    while let Some(i) = lower[from..].find(&pat) {
        let at = from + i;
        from = at + pat.len();
        if at > 0 && !lower.as_bytes()[at - 1].is_ascii_whitespace() {
            continue;
        }
        let v = &tag[from..];
        let raw = match v.chars().next() {
            Some(q @ ('"' | '\'')) => v[1..].split(q).next().unwrap_or(""),
            _ => v
                .split(|c: char| c.is_whitespace() || c == '>')
                .next()
                .unwrap_or(""),
        };
        return Some(decode_entities(raw.trim_end_matches('/')));
    }
    None
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let decoded = rest[1..].find(';').filter(|&n| n <= 10).and_then(|n| {
            let ent = &rest[1..1 + n];
            let c = match ent {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                _ => ent
                    .strip_prefix("#x")
                    .or_else(|| ent.strip_prefix("#X"))
                    .and_then(|h| u32::from_str_radix(h, 16).ok())
                    .or_else(|| ent.strip_prefix('#').and_then(|d| d.parse().ok()))
                    .and_then(char::from_u32),
            }?;
            Some((c, n + 2))
        });
        match decoded {
            Some((c, len)) => {
                out.push(c);
                rest = &rest[len..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// `parts` as prompt blocks, after `lead`. With `images`, each image is
/// downloaded (`base` resolves a relative `src`) and attached in place; an
/// image left out — not supported, over the limit, or failed — is named by
/// its link instead.
pub async fn blocks(
    lead: String,
    parts: Vec<Part>,
    base: &str,
    images: bool,
) -> Vec<acp::ContentBlock> {
    let client = reqwest::Client::builder().timeout(TIMEOUT).build().ok();
    let mut blocks = Vec::new();
    let mut text = lead;
    let mut attached = 0;
    for part in parts {
        match part {
            Part::Text(t) => {
                text.push_str("\n\n");
                text.push_str(&t);
            }
            Part::Image(src) => {
                let src = resolve(base, &src);
                let image = match &client {
                    Some(c) if images && attached < MAX_IMAGES => fetch_image(c, &src).await,
                    _ => Err("not attached".into()),
                };
                match image {
                    Ok(img) => {
                        attached += 1;
                        text.push_str(&format!("\n\n[image {attached}, attached below]"));
                        blocks.push(acp::ContentBlock::Text(acp::TextContent::new(
                            std::mem::take(&mut text),
                        )));
                        blocks.push(acp::ContentBlock::Image(img));
                    }
                    Err(e) => {
                        tracing::debug!(target: "atlas::integrations", "image {src}: {e}");
                        // A data: URL is the image itself; its bytes are no
                        // use to the agent as text.
                        if src.starts_with("data:") {
                            text.push_str("\n\n[image could not be attached]");
                        } else {
                            text.push_str(&format!("\n\n[image: {src}]"));
                        }
                    }
                }
            }
        }
    }
    if !text.trim().is_empty() {
        blocks.push(acp::ContentBlock::Text(acp::TextContent::new(text)));
    }
    blocks
}

fn resolve(base: &str, src: &str) -> String {
    url::Url::parse(base)
        .and_then(|b| b.join(src))
        .map(|u| u.to_string())
        .unwrap_or_else(|_| src.to_string())
}

async fn fetch_image(client: &reqwest::Client, src: &str) -> Result<acp::ImageContent, String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    if let Some(data) = src.strip_prefix("data:") {
        let (meta, payload) = data.split_once(',').ok_or("malformed data URL")?;
        let mime = meta
            .strip_suffix(";base64")
            .ok_or("data URL is not base64")?;
        if !mime.starts_with("image/") {
            return Err(format!("not an image: {mime}"));
        }
        let bytes = b64.decode(payload).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err("too large".into());
        }
        return Ok(acp::ImageContent::new(b64.encode(bytes), mime));
    }
    let resp = client.get(src).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            v.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
        .unwrap_or_default();
    if !mime.starts_with("image/") {
        return Err(format!("not an image: {mime}"));
    }
    if resp
        .content_length()
        .is_some_and(|n| n as usize > MAX_IMAGE_BYTES)
    {
        return Err("too large".into());
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("too large".into());
    }
    Ok(acp::ImageContent::new(b64.encode(&bytes), mime).uri(src.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> Part {
        Part::Text(s.into())
    }

    #[test]
    fn plain_text_passes_through() {
        assert_eq!(
            parse("  Fix <login> & co\n\nsteps  "),
            vec![t("Fix <login> & co\n\nsteps")]
        );
        assert_eq!(parse(" \n "), vec![]);
    }

    #[test]
    fn ones_html() {
        let body = r#"<figure class="ones-image-figure">
<div class="image-wrapper"><img data-mime="image/png" data-src="no" src="http://h/a.png?X=1&amp;Y=2" /></div>

<figcaption></figcaption>
</figure>

<p>1、先选文件夹，
再生成（见图一)<br />
2、默认&nbsp;权限&lt;读&gt;&#20840;</p>

<p>&nbsp;</p>"#;
        assert_eq!(
            parse(body),
            vec![
                Part::Image("http://h/a.png?X=1&Y=2".into()),
                t("1、先选文件夹， 再生成（见图一)\n2、默认 权限<读>全"),
            ]
        );
    }

    #[test]
    fn lists_and_pre() {
        let body = "<p>Steps</p><ul><li>one</li><li>two</li></ul><pre>a\n  b</pre>";
        assert_eq!(parse(body), vec![t("Steps\n\n- one\n- two\n\na\n  b")]);
    }

    #[test]
    fn attrs() {
        assert_eq!(attr("img SRC='x y'", "src").as_deref(), Some("x y"));
        assert_eq!(attr("img src=a.png/", "src").as_deref(), Some("a.png"));
        assert_eq!(attr("img data-src=\"x\"", "src"), None);
        assert_eq!(decode_entities("a &bogus b &amp;"), "a &bogus b &");
    }

    #[test]
    fn relative_src() {
        assert_eq!(
            resolve("https://o.example/project/#/t", "/f/1.png"),
            "https://o.example/f/1.png"
        );
        assert_eq!(resolve("", "http://h/a.png"), "http://h/a.png");
    }
}
