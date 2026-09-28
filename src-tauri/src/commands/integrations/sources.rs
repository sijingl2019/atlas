//! Fetching issues from each tracker. The HTTP layer is thin; the response
//! parsing is split out so it can be tested against fixtures.

use serde_json::{json, Value};

use super::{Issue, JiraDeployment, Source};

const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

/// `secret` is the Jira API token / PAT, the ONES password, or whatever a
/// custom source's `{{secret}}` placeholders stand for.
pub async fn fetch_issues(source: &Source, secret: &str) -> Result<Vec<Issue>, String> {
    match source {
        Source::Jira {
            base_url,
            deployment,
            email,
            jql,
        } => {
            let base = base_url.trim_end_matches('/');
            // v2 on both: its `description` is plain text, v3's is ADF.
            let path = match deployment {
                JiraDeployment::Cloud => "rest/api/2/search/jql",
                JiraDeployment::Server => "rest/api/2/search",
            };
            let req = client()?.get(format!("{base}/{path}")).query(&[
                ("jql", jql.as_str()),
                ("fields", "summary,description"),
                ("maxResults", "50"),
            ]);
            let req = match deployment {
                JiraDeployment::Cloud => req.basic_auth(email, Some(secret)),
                JiraDeployment::Server => req.bearer_auth(secret),
            };
            Ok(parse_jira(&send_json(req).await?, base))
        }
        Source::Ones {
            base_url,
            team_uuid,
            email,
            filter,
            order_by,
        } => {
            let base = base_url.trim_end_matches('/');
            let http = client()?;
            let login = send_json(
                http.post(format!("{base}/project/api/project/auth/login"))
                    .json(&json!({ "email": email, "password": secret })),
            )
            .await?;
            let user = str_at(&login, "user.uuid");
            let token = str_at(&login, "user.token");
            if user.is_empty() || token.is_empty() {
                return Err("ONES login returned no user token".into());
            }
            let team = if team_uuid.is_empty() {
                str_at(&login, "teams.0.uuid")
            } else {
                team_uuid.clone()
            };
            let filter: Value = serde_json::from_str(&filter.replace("{{me}}", &user))
                .map_err(|e| format!("filter is not valid JSON: {e}"))?;
            // Shaped like the ONES web client's own request: the filter and
            // order apply to `tasks`, and `filterGroup` is a list of OR'd
            // filters — one object is taken as a list of one.
            let filter_group = if filter.is_array() {
                filter
            } else {
                Value::Array(vec![filter])
            };
            let order_by: Value = if order_by.trim().is_empty() {
                json!({ "createTime": "ASC" })
            } else {
                serde_json::from_str(order_by)
                    .map_err(|e| format!("order by is not valid JSON: {e}"))?
            };
            let body = json!({
                "query": ONES_QUERY,
                "variables": {
                    "groupBy": { "tasks": {} },
                    "filterGroup": filter_group,
                    "orderBy": order_by,
                    "pagination": { "limit": 50, "preciseCount": false },
                },
            });
            let resp = send_json(
                http.post(format!(
                    "{base}/project/api/project/team/{team}/items/graphql"
                ))
                .header("Ones-User-Id", &user)
                .header("Ones-Auth-Token", &token)
                .header("Referer", base)
                .json(&body),
            )
            .await?;
            Ok(parse_ones(&resp, base, &team))
        }
        Source::Custom {
            url,
            method,
            headers,
            body,
            items_path,
            id_path,
            title_path,
            body_path,
            url_path,
        } => {
            let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
                .map_err(|_| format!("bad HTTP method: {method}"))?;
            let mut req = client()?.request(method, url);
            for (k, v) in headers {
                req = req.header(k, v.replace("{{secret}}", secret));
            }
            if !body.trim().is_empty() {
                req = req
                    .header("Content-Type", "application/json")
                    .body(body.replace("{{secret}}", secret));
            }
            let resp = send_json(req).await?;
            parse_custom(&resp, items_path, id_path, title_path, body_path, url_path)
        }
    }
}

/// Variables are left undeclared, as the ONES web client sends them.
const ONES_QUERY: &str = "{ buckets(groupBy: $groupBy, pagination: $pagination) { key tasks(filterGroup: $filterGroup, orderBy: $orderBy, limit: 50) { uuid number name description } } }";

async fn send_json(req: reqwest::RequestBuilder) -> Result<Value, String> {
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let snippet: String = text.chars().take(300).collect();
        return Err(format!("HTTP {status}: {snippet}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("response is not JSON: {e}"))
}

/// Resolve a dot path (`a.b.0.c`) into `v`. Empty path = `v` itself.
pub fn at<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .filter(|s| !s.is_empty())
        .try_fold(v, |cur, seg| match cur {
            Value::Array(a) => seg.parse::<usize>().ok().and_then(|i| a.get(i)),
            _ => cur.get(seg),
        })
}

/// The value at `path` as text: strings as-is, numbers printed, else empty.
fn str_at(v: &Value, path: &str) -> String {
    match at(v, path) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn parse_jira(resp: &Value, base: &str) -> Vec<Issue> {
    resp.get("issues")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|i| {
            let key = str_at(i, "key");
            (!key.is_empty()).then(|| Issue {
                url: format!("{base}/browse/{key}"),
                title: str_at(i, "fields.summary"),
                body: str_at(i, "fields.description"),
                key,
            })
        })
        .collect()
}

fn parse_ones(resp: &Value, base: &str, team: &str) -> Vec<Issue> {
    at(resp, "data.buckets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|b| {
            b.get("tasks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|t| {
            let uuid = str_at(t, "uuid");
            (!uuid.is_empty()).then(|| Issue {
                key: format!("#{}", str_at(t, "number")),
                title: str_at(t, "name"),
                body: str_at(t, "description"),
                url: format!("{base}/project/#/team/{team}/task/{uuid}"),
            })
        })
        .collect()
}

fn parse_custom(
    resp: &Value,
    items_path: &str,
    id_path: &str,
    title_path: &str,
    body_path: &str,
    url_path: &str,
) -> Result<Vec<Issue>, String> {
    let items = at(resp, items_path)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("no array at `{items_path}`"))?;
    Ok(items
        .iter()
        .filter_map(|i| {
            let key = str_at(i, id_path);
            (!key.is_empty()).then(|| Issue {
                title: str_at(i, title_path),
                body: str_at(i, body_path),
                url: str_at(i, url_path),
                key,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dot_paths() {
        let v = json!({ "a": { "b": [ { "c": 1 }, { "c": "two" } ] } });
        assert_eq!(at(&v, "a.b.1.c"), Some(&json!("two")));
        assert_eq!(at(&v, ""), Some(&v));
        assert_eq!(at(&v, "a.x"), None);
        assert_eq!(at(&v, "a.b.9"), None);
        assert_eq!(at(&v, "a.b.x"), None);
        assert_eq!(str_at(&v, "a.b.0.c"), "1");
    }

    #[test]
    fn jira() {
        let v = json!({ "issues": [
            { "key": "PROJ-1", "fields": { "summary": "Fix login", "description": "It breaks" } },
            { "key": "PROJ-2", "fields": { "summary": "Add export", "description": null } },
        ]});
        let got = parse_jira(&v, "https://x.atlassian.net");
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].title, "Fix login");
        assert_eq!(got[0].url, "https://x.atlassian.net/browse/PROJ-1");
        assert_eq!(got[1].body, "");
    }

    #[test]
    fn ones() {
        let v = json!({ "data": { "buckets": [ { "key": "tasks", "tasks": [
            { "uuid": "U1", "number": 42, "name": "Crash on save", "description": "<p>x</p>" },
        ]}]}});
        let got = parse_ones(&v, "https://ones.example.com", "T");
        assert_eq!(
            got,
            vec![Issue {
                key: "#42".into(),
                title: "Crash on save".into(),
                body: "<p>x</p>".into(),
                url: "https://ones.example.com/project/#/team/T/task/U1".into(),
            }]
        );
    }

    #[test]
    fn custom() {
        let v = json!({ "data": { "items": [
            { "id": 7, "t": "Title", "d": { "text": "Body" } },
            { "t": "no id, dropped" },
        ]}});
        let got = parse_custom(&v, "data.items", "id", "t", "d.text", "").unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].key.as_str(), got[0].body.as_str()), ("7", "Body"));
        assert!(parse_custom(&v, "nope", "id", "t", "", "").is_err());
        // Top-level array.
        let list = json!([{ "id": "a", "t": "A" }]);
        assert_eq!(
            parse_custom(&list, "", "id", "t", "", "").unwrap()[0].key,
            "a"
        );
    }
}
