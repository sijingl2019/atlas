//! Resolve Obsidian link destinations against canonical knowledge IDs.

pub fn target(raw: &str) -> String {
    let clean = raw.replace("\\|", "|");
    clean
        .split('|')
        .next()
        .unwrap_or("")
        .split('#')
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

pub fn resolve(raw: &str, from: &str, ids: &[String], root: &str) -> Option<String> {
    let target = target(raw);
    let target = target.strip_suffix(".md").unwrap_or(&target);
    if target.is_empty() {
        return Some(from.to_string());
    }
    let allowed = |id: &str| root.is_empty() || id.starts_with(&format!("{root}/"));
    let dir = from.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    let normalize = |path: String| -> Option<String> {
        let mut parts = Vec::new();
        for part in path.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop()?;
                }
                _ => parts.push(part),
            }
        }
        Some(parts.join("/"))
    };
    for candidate in [
        format!("{dir}/{target}"),
        format!("{root}/{target}"),
        target.to_string(),
    ] {
        if let Some(id) = normalize(candidate) {
            if allowed(&id) && ids.contains(&id) {
                return Some(id);
            }
        }
    }
    let suffix = format!("/{target}");
    let mut matches = ids
        .iter()
        .filter(|id| allowed(id) && (id.as_str() == target || id.ends_with(&suffix)));
    let first = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(first.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolves_sibling_alias_heading_and_extension() {
        let ids = vec!["Vault/Hello/Base".into(), "Vault/Other/Base".into()];
        for link in ["Base", "Base.md", "Base#Heading|Alias", "Base\\|Alias"] {
            assert_eq!(
                resolve(link, "Vault/Hello/Advance", &ids, "Vault"),
                Some(ids[0].clone())
            );
        }
        assert_eq!(target("image.jpg\\|100x145"), "image.jpg");
        assert_eq!(resolve("Base", "Vault/Third/Note", &ids, "Vault"), None);
        assert_eq!(
            resolve(
                "../../Other/Secret",
                "Vault/Hello/Note",
                &["Other/Secret".into()],
                "Vault"
            ),
            None
        );
    }
}
