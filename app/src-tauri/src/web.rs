//! Web tools: `web_search` and `web_fetch`.
//!
//! This is BELEN's first network use beyond the model provider and the update
//! feed, and only once the user switches Web on (Settings → Chat → Tools), so
//! the boundary is drawn here rather than left to the model's judgement:
//!  - search talks to one fixed host, with the user's own key;
//!  - fetch goes to public http(s) addresses only — never this computer, the
//!    local network, or link-local metadata services — and every redirect hop
//!    is checked again, with DNS pinned to the address that was checked;
//!  - a page comes back as plain text, bounded. Nothing in it is executed.

use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

use futures_util::StreamExt;

use crate::tools::ToolError;

const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
const SEARCH_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Redirects followed before giving up; each one is checked like the first.
const MAX_REDIRECTS: usize = 3;
const MAX_URL_CHARS: usize = 2_048;
const MAX_RAW_BYTES: usize = 1024 * 1024;
/// The text budget a page starts with; lowered until the whole result fits
/// what the tool loop hands back to the model uncut.
const TEXT_BUDGET: usize = 12_000;
const RESULT_BUDGET: usize = 15_500;
const MAX_LINKS: usize = 25;
const USER_AGENT: &str = concat!(
    "BELEN/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/mrlfarano/belen)"
);
const ACCEPT: &str = "text/html, text/*;q=0.9, application/xhtml+xml, application/json;q=0.8, application/xml;q=0.6, */*;q=0.1";

const SEARCH_ENDPOINT: &str = "https://api.tavily.com/search";
/// Key-store name of the search key — the same name Settings saves it under.
const SEARCH_KEY: &str = "search-tavily";
const NO_KEY: &str = "there is no search key yet — add a Tavily key in Settings → Chat → Tools";

pub fn handles(tool: &str) -> bool {
    matches!(tool, "web_search" | "web_fetch")
}

/// Runs one web tool. The policy gate has already let this call through.
pub async fn exec(tool: &str, args_raw: &str) -> Result<(String, bool), ToolError> {
    let args: serde_json::Value = serde_json::from_str(args_raw)
        .map_err(|_| ToolError::Failed("arguments are not valid JSON".into()))?;
    match tool {
        "web_fetch" => fetch(&args).await,
        "web_search" => search(&args).await,
        _ => Err(ToolError::Denied("tool not allowed".into())),
    }
}

/// Shared client settings: nothing follows a redirect on its own.
fn client_builder(timeout: Duration) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(USER_AGENT)
}

// ---------------------------------------------------------------------------
// web_fetch
// ---------------------------------------------------------------------------

async fn fetch(args: &serde_json::Value) -> Result<(String, bool), ToolError> {
    let Some(raw) = args["url"].as_str() else {
        return Err(ToolError::Failed("missing required argument: url".into()));
    };
    let mut current = raw.to_string();

    for _ in 0..=MAX_REDIRECTS {
        let (url, addrs) = public_address(&current).await?;
        // The request resolves the name only to the addresses that just
        // passed the check: it cannot answer the check with one address and
        // the connection with another.
        let client = client_builder(FETCH_TIMEOUT)
            .resolve_to_addrs(url.host_str().unwrap_or_default(), &addrs)
            .build()
            .map_err(|e| ToolError::Failed(format!("the HTTP client could not be built: {e}")))?;

        let response = client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, ACCEPT)
            .send()
            .await
            .map_err(|e| ToolError::Failed(format!("the page could not be reached: {e}")))?;
        let status = response.status();

        // Redirects are followed by hand: the next address is vetted from
        // scratch, exactly like the first.
        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| {
                    ToolError::Failed(format!(
                        "the page redirects without saying where (HTTP {status})"
                    ))
                })?;
            current = url
                .join(location)
                .map_err(|e| {
                    ToolError::Failed(format!("the redirect target is not a valid address: {e}"))
                })?
                .to_string();
            continue;
        }
        if !status.is_success() {
            return Err(ToolError::Failed(format!("the page did not load (HTTP {status})")));
        }
        return read_page(response, &url).await;
    }
    Err(ToolError::Failed(format!("more than {MAX_REDIRECTS} redirects")))
}

/// Vets one address on the blocking pool: resolving a name must not stall the
/// runtime.
async fn public_address(raw: &str) -> Result<(reqwest::Url, Vec<SocketAddr>), ToolError> {
    let raw = raw.to_string();
    tokio::task::spawn_blocking(move || vet(&raw))
        .await
        .map_err(|e| ToolError::Failed(format!("the address could not be checked: {e}")))?
}

/// Parses the address and checks every IP its host maps to. The addresses are
/// returned so the request can be pinned to exactly the ones that passed.
fn vet(raw: &str) -> Result<(reqwest::Url, Vec<SocketAddr>), ToolError> {
    if raw.chars().count() > MAX_URL_CHARS {
        return Err(ToolError::Failed("the address is too long".into()));
    }
    let url = reqwest::Url::parse(raw)
        .map_err(|_| ToolError::Failed("that is not a valid address".into()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ToolError::Failed(format!(
            "only http and https pages can be read, not {}",
            url.scheme()
        )));
    }
    let host = url
        .host_str()
        .ok_or_else(|| ToolError::Failed("the address has no host".into()))?
        .to_string();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| ToolError::Failed("the address has no port".into()))?;

    // A literal address stands for itself; a name is only as public as every
    // address it resolves to. (An IPv6 host arrives in brackets.)
    let literal = host.trim_start_matches('[').trim_end_matches(']');
    let addrs = match literal.parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, port)],
        Err(_) => (literal, port)
            .to_socket_addrs()
            .map_err(|_| ToolError::Failed(format!("{host} does not resolve to an address")))?
            .collect(),
    };
    if addrs.is_empty() {
        return Err(ToolError::Failed(format!("{host} does not resolve to an address")));
    }
    for addr in &addrs {
        if let Some(why) = non_public(addr.ip()) {
            return Err(ToolError::Denied(format!(
                "{host} is {why}; only public pages can be read"
            )));
        }
    }
    Ok((url, addrs))
}

/// Why an address is not a public one, or `None` if it is.
fn non_public(ip: IpAddr) -> Option<&'static str> {
    // An IPv4 address wearing an IPv6 coat is judged by what it carries.
    if let IpAddr::V6(v6) = ip {
        if let Some(v4) = v6.to_ipv4_mapped() {
            return non_public(IpAddr::V4(v4));
        }
    }
    match ip {
        IpAddr::V4(v4) => {
            if v4.is_loopback() {
                Some("this computer")
            } else if v4.is_private() {
                Some("on a private network")
            } else if v4.is_link_local() {
                Some("a link-local address")
            } else if v4.is_multicast() {
                Some("a multicast address")
            } else if v4.is_broadcast() {
                Some("a broadcast address")
            } else if v4.is_unspecified() || v4.is_documentation() {
                Some("not a real public address")
            } else {
                let [a, b, c, _] = v4.octets();
                if a == 0 {
                    Some("this network")
                } else if a == 100 && (64..=127).contains(&b) {
                    Some("a shared address")
                } else if a == 198 && (b == 18 || b == 19) {
                    Some("a benchmarking address")
                } else if a == 192 && b == 0 && c == 0 {
                    Some("a reserved address")
                } else if a >= 240 {
                    Some("a reserved address")
                } else {
                    None
                }
            }
        }
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            if v6.is_loopback() {
                Some("this computer")
            } else if v6.is_unspecified() {
                Some("not a real public address")
            } else if v6.is_multicast() {
                Some("a multicast address")
            } else if first & 0xfe00 == 0xfc00 {
                Some("on a private network")
            } else if first & 0xffc0 == 0xfe80 {
                Some("a link-local address")
            } else {
                None
            }
        }
    }
}

async fn read_page(response: reqwest::Response, url: &reqwest::Url) -> Result<(String, bool), ToolError> {
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
        .unwrap_or_default();
    let readable = mime.is_empty()
        || mime.starts_with("text/")
        || matches!(
            mime.as_str(),
            "application/json" | "application/xml" | "application/xhtml+xml" | "application/yaml"
        );
    if !readable {
        return Err(ToolError::Failed(format!(
            "that is a {mime} file, not a page to read"
        )));
    }

    let mut raw = Vec::new();
    let mut stream = response.bytes_stream();
    let mut oversized = false;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|e| ToolError::Failed(format!("the page stopped loading: {e}")))?;
        let room = MAX_RAW_BYTES - raw.len();
        if chunk.len() > room {
            raw.extend_from_slice(&chunk[..room]);
            oversized = true;
            break;
        }
        raw.extend_from_slice(&chunk);
    }
    if raw.contains(&0) {
        return Err(ToolError::Failed(
            "that is a binary file, not a page to read".into(),
        ));
    }

    let page = html_to_text(&String::from_utf8_lossy(&raw));
    // Only links that still lead somewhere public and readable.
    let links: Vec<(String, String)> = page
        .links
        .iter()
        .filter_map(|(label, href)| {
            let absolute = url.join(href).ok()?;
            let http = matches!(absolute.scheme(), "http" | "https");
            http.then(|| (label.clone(), absolute.to_string()))
        })
        .take(MAX_LINKS)
        .collect();

    // Give the text as much room as fits, then step down until the whole
    // result is under what the tool loop passes on without cutting it.
    let mut budget = TEXT_BUDGET;
    loop {
        let (text, text_cut) = clip(page.text.trim(), budget);
        let content = serde_json::json!({
            "url": url.as_str(),
            "title": clip(&page.title, 300).0,
            "text": text,
            "links": links
                .iter()
                .map(|(label, href)| serde_json::json!({ "text": label, "href": href }))
                .collect::<Vec<_>>(),
        })
        .to_string();
        if content.chars().count() <= RESULT_BUDGET || budget <= 1_000 {
            let truncated = oversized || text_cut || links.len() < page.links.len();
            return Ok((content, truncated));
        }
        budget -= 1_000;
    }
}

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

async fn search(args: &serde_json::Value) -> Result<(String, bool), ToolError> {
    let Some(query) = args["query"].as_str() else {
        return Err(ToolError::Failed("missing required argument: query".into()));
    };
    let key = tokio::task::spawn_blocking(|| crate::keys::get(SEARCH_KEY))
        .await
        .map_err(|e| ToolError::Failed(format!("the search key could not be read: {e}")))?
        .map_err(|e| ToolError::Failed(format!("the search key could not be read: {e}")))?;
    let key = match key {
        Some(bytes) => Some(String::from_utf8(bytes).map_err(|_| {
            ToolError::Failed("the search key could not be read: it is not text".into())
        })?),
        None => None,
    };
    search_with(key, query, max_results(args)).await
}

fn max_results(args: &serde_json::Value) -> u64 {
    args["maxResults"].as_u64().unwrap_or(5).clamp(1, 10)
}

async fn search_with(
    key: Option<String>,
    query: &str,
    max_results: u64,
) -> Result<(String, bool), ToolError> {
    let key = match key {
        // Settings writes an empty string when the key is cleared.
        Some(key) if !key.trim().is_empty() => key,
        _ => return Err(ToolError::Failed(NO_KEY.into())),
    };
    let client = client_builder(SEARCH_TIMEOUT)
        .build()
        .map_err(|e| ToolError::Failed(format!("the HTTP client could not be built: {e}")))?;
    let response = client
        .post(SEARCH_ENDPOINT)
        .bearer_auth(key)
        .json(&serde_json::json!({
            "query": query,
            "max_results": max_results,
            "search_depth": "basic",
            "include_answer": false,
        }))
        .send()
        .await
        .map_err(|e| ToolError::Failed(format!("the search could not be reached: {e}")))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| ToolError::Failed(format!("the search answer could not be read: {e}")))?;
    if !status.is_success() {
        return Err(ToolError::Failed(format!("the search did not answer (HTTP {status})")));
    }
    Ok((results(query, max_results, &body)?, false))
}

/// One Tavily answer → the fields the model reads, within its result budget.
fn results(query: &str, max_results: u64, body: &str) -> Result<String, ToolError> {
    let json: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| ToolError::Failed("the search answer was not understood".into()))?;
    let hits: Vec<serde_json::Value> = json["results"]
        .as_array()
        .map(|list| {
            list.iter()
                .take(max_results as usize)
                .map(|hit| {
                    serde_json::json!({
                        "title": clip(hit["title"].as_str().unwrap_or(""), 200).0,
                        "url": clip(hit["url"].as_str().unwrap_or(""), 500).0,
                        "snippet": clip(hit["content"].as_str().unwrap_or(""), 400).0,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(serde_json::json!({ "query": query, "results": hits }).to_string())
}

// ---------------------------------------------------------------------------
// HTML → text
// ---------------------------------------------------------------------------

#[derive(Debug, Default, PartialEq, Eq)]
struct Page {
    title: String,
    text: String,
    /// Link label → href as written in the page (often relative).
    links: Vec<(String, String)>,
}

/// Elements whose content is never page text.
const SKIP: [&str; 6] = ["script", "style", "noscript", "template", "svg", "iframe"];

/// Elements that start a new line, whether opened or closed.
const BLOCK: [&str; 42] = [
    "address", "article", "aside", "blockquote", "body", "br", "caption", "center", "dd",
    "details", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1",
    "h2", "h3", "h4", "h5", "h6", "header", "hr", "html", "legend", "li", "main", "nav", "ol",
    "option", "p", "pre", "section", "summary", "table", "td", "th", "tr", "ul",
];

/// A small tag walker: enough of HTML to read a page, not to render one.
/// Inline tags keep words together ("po<b>si</b>tion" stays one word), block
/// tags start lines, scripts and styles vanish, and anchors are collected.
fn html_to_text(html: &str) -> Page {
    // One lowercase copy to search in; ASCII case-folding keeps every offset.
    let lower = html.to_ascii_lowercase();
    let mut page = Page::default();
    let mut text = String::new();
    let mut gap = false;
    let mut open_link: Option<(String, usize)> = None;
    let mut i = 0;

    while i < html.len() {
        if html.as_bytes()[i] != b'<' {
            let end = html[i..].find('<').map_or(html.len(), |at| i + at);
            push_words(&mut text, &mut gap, &html[i..end]);
            i = end;
            continue;
        }
        if lower[i..].starts_with("<!--") {
            i += lower[i..].find("-->").map_or(html.len() - i, |at| at + 3);
            continue;
        }
        let Some(greater) = lower[i..].find('>') else {
            break;
        };
        let (closing, name, attrs) = split_tag(&html[i + 1..i + greater]);
        i += greater + 1;

        match name.as_str() {
            "title" if !closing => {
                page.title = decode_entities(take_until(html, &lower, &mut i, "title"))
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
            }
            _ if !closing && SKIP.contains(&name.as_str()) => {
                let _ = take_until(html, &lower, &mut i, &name);
            }
            "a" if !closing => {
                // A link nested in a link restarts it; the rare case costs
                // one mislabelled link, never text.
                open_link = attribute(attrs, "href")
                    .map(|href| decode_entities(&href))
                    .filter(|href| !href.is_empty())
                    .map(|href| (href, text.len()));
            }
            "a" => {
                if let Some((href, start)) = open_link.take() {
                    let label = text[start..].trim();
                    if !label.is_empty() && page.links.len() < MAX_LINKS * 2 {
                        page.links.push((clip(label, 80).0, href));
                    }
                }
            }
            _ if BLOCK.contains(&name.as_str()) => {
                if !text.is_empty() && !text.ends_with('\n') {
                    text.push('\n');
                }
            }
            _ => {}
        }
    }

    page.text = tidy(&text);
    page
}

/// `href="x" id=y` → whether it closes, the name (lowercased), the attributes.
fn split_tag(tag: &str) -> (bool, String, &str) {
    let tag = tag.trim();
    let (closing, tag) = match tag.strip_prefix('/') {
        Some(rest) => (true, rest),
        None => (false, tag),
    };
    let name_end = tag
        .find(|c: char| c.is_ascii_whitespace() || c == '/' || c == '>')
        .unwrap_or(tag.len());
    (closing, tag[..name_end].to_ascii_lowercase(), &tag[name_end..])
}

/// The value of an attribute, whatever quote style (or none) it uses.
fn attribute(attrs: &str, name: &str) -> Option<String> {
    // ASCII lowercasing keeps offsets aligned with `attrs`.
    let lower = attrs.to_ascii_lowercase();
    let mut from = 0;
    while let Some(at) = lower[from..].find(name) {
        let at = from + at;
        let bytes = lower.as_bytes();
        let standalone =
            at == 0 || bytes[at - 1].is_ascii_whitespace() || bytes[at - 1] == b'/';
        let after = &lower[at + name.len()..];
        if standalone && after.trim_start().starts_with('=') {
            let equals = at + name.len() + after.find('=').unwrap_or(0);
            let value = attrs[equals + 1..].trim_start();
            let quote = value.chars().next()?;
            if quote == '"' || quote == '\'' {
                let end = value[1..].find(quote)?;
                return Some(value[1..1 + end].to_string());
            }
            let end = value.find(char::is_whitespace).unwrap_or(value.len());
            return Some(value[..end].to_string());
        }
        from = at + 1;
    }
    None
}

/// The text up to the next `</name>` (any case), stepping past that tag.
fn take_until<'a>(html: &'a str, lower: &str, i: &mut usize, name: &str) -> &'a str {
    let close = find_close(lower, *i, name);
    let stop = close.unwrap_or(html.len());
    let end = match close {
        Some(at) => lower[at..].find('>').map_or(html.len(), |greater| at + greater + 1),
        None => html.len(),
    };
    let inner = &html[*i..stop];
    *i = end;
    inner
}

/// Where the next `</name` begins a tag, or `None`.
fn find_close(lower: &str, from: usize, name: &str) -> Option<usize> {
    let needle = format!("</{name}");
    let mut search = from;
    while let Some(at) = lower[search..].find(&needle) {
        let start = search + at;
        let next = lower.as_bytes().get(start + needle.len()).copied();
        let ends_tag = match next {
            None => true,
            Some(b) => b == b'>' || b == b'/' || b.is_ascii_whitespace(),
        };
        if ends_tag {
            return Some(start);
        }
        search = start + 1;
    }
    None
}

fn push_words(out: &mut String, gap: &mut bool, raw: &str) {
    let decoded = decode_entities(raw);
    let leading = decoded.starts_with(char::is_whitespace);
    for (index, word) in decoded.split(char::is_whitespace).enumerate() {
        if word.is_empty() {
            continue;
        }
        let due = index > 0 || *gap || leading;
        if due && !out.is_empty() && !out.ends_with('\n') {
            out.push(' ');
        }
        out.push_str(word);
    }
    if !decoded.is_empty() {
        *gap = decoded.ends_with(char::is_whitespace);
    }
}

/// The entities that carry meaning in prose. Anything else stays as written.
/// The entities worth decoding: the ones that carry meaning in prose and the
/// accented letters non-English prose leans on. Anything else stays as written.
const NAMED_ENTITIES: &[(&str, char)] = &[
    ("amp", '&'),
    ("lt", '<'),
    ("gt", '>'),
    ("quot", '"'),
    ("apos", '\''),
    ("nbsp", ' '),
    ("mdash", '—'),
    ("ndash", '–'),
    ("hellip", '…'),
    ("lsquo", '‘'),
    ("rsquo", '’'),
    ("ldquo", '“'),
    ("rdquo", '”'),
    ("laquo", '«'),
    ("raquo", '»'),
    ("copy", '©'),
    ("reg", '®'),
    ("trade", '™'),
    ("deg", '°'),
    ("middot", '·'),
    ("bull", '•'),
    ("times", '×'),
    ("euro", '€'),
    ("pound", '£'),
    ("rarr", '→'),
    ("larr", '←'),
    ("ne", '≠'),
    ("le", '≤'),
    ("ge", '≥'),
    ("aacute", 'á'),
    ("agrave", 'à'),
    ("acirc", 'â'),
    ("auml", 'ä'),
    ("atilde", 'ã'),
    ("aring", 'å'),
    ("aelig", 'æ'),
    ("ccedil", 'ç'),
    ("eacute", 'é'),
    ("egrave", 'è'),
    ("ecirc", 'ê'),
    ("euml", 'ë'),
    ("iacute", 'í'),
    ("igrave", 'ì'),
    ("icirc", 'î'),
    ("iuml", 'ï'),
    ("ntilde", 'ñ'),
    ("oacute", 'ó'),
    ("ograve", 'ò'),
    ("ocirc", 'ô'),
    ("otilde", 'õ'),
    ("ouml", 'ö'),
    ("oslash", 'ø'),
    ("uacute", 'ú'),
    ("ugrave", 'ù'),
    ("ucirc", 'û'),
    ("uuml", 'ü'),
    ("yacute", 'ý'),
    ("yuml", 'ÿ'),
    ("szlig", 'ß'),
    ("Aacute", 'Á'),
    ("Eacute", 'É'),
    ("Iacute", 'Í'),
    ("Oacute", 'Ó'),
    ("Uacute", 'Ú'),
    ("Ntilde", 'Ñ'),
    ("Auml", 'Ä'),
    ("Ouml", 'Ö'),
    ("Uuml", 'Ü'),
];

fn decode_entities(raw: &str) -> String {
    if !raw.contains('&') {
        return raw.to_string();
    }
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let semi = rest
            .char_indices()
            .take(12)
            .find(|(_, c)| *c == ';')
            .map(|(i, _)| i);
        let decoded = semi.and_then(|end| match &rest[1..end] {
            "#39" => Some('\''),
            number if number.starts_with("#x") || number.starts_with("#X") => {
                u32::from_str_radix(&number[2..], 16).ok().and_then(char::from_u32)
            }
            number if number.starts_with('#') => {
                number[1..].parse::<u32>().ok().and_then(char::from_u32)
            }
            named => NAMED_ENTITIES
                .iter()
                .find(|(name, _)| *name == named)
                .map(|(_, c)| *c),
        });
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[semi.unwrap_or(0) + 1..];
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

/// One blank line at most between paragraphs, nothing at either end.
fn tidy(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blank = false;
    for line in text.lines().map(str::trim) {
        if line.is_empty() {
            blank = !out.is_empty();
            continue;
        }
        if blank {
            out.push('\n');
        }
        out.push_str(line);
        out.push('\n');
        blank = false;
    }
    out.trim().to_string()
}

/// Cuts at a character boundary and says whether it cut.
fn clip(text: &str, max: usize) -> (String, bool) {
    if text.chars().count() <= max {
        (text.to_string(), false)
    } else {
        (text.chars().take(max).collect(), true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_computer_and_the_local_network_are_refused() {
        for raw in [
            "http://127.0.0.1/",
            "http://127.8.8.8:8080/admin",
            "http://192.168.50.4:8888/",
            "http://10.0.0.1/",
            "http://172.16.3.4/",
            "http://172.31.255.255/",
            // The cloud metadata service.
            "http://169.254.169.254/latest/meta-data/",
            "http://100.64.0.1/",
            "http://0.0.0.0/",
            "http://198.18.0.1/",
            "http://[::1]/",
            "http://[fd00::1]/",
            "http://[fe80::1]/",
            // IPv4 in an IPv6 coat.
            "http://[::ffff:127.0.0.1]/",
            "http://[::ffff:192.168.1.1]/",
        ] {
            assert!(matches!(vet(raw), Err(ToolError::Denied(_))), "{raw} must be denied");
        }
    }

    #[test]
    fn a_refusal_says_where_the_address_sits() {
        let why = |raw: &str| match vet(raw).err().expect("must be refused") {
            ToolError::Denied(reason) | ToolError::Failed(reason) => reason,
        };
        assert!(why("http://192.168.50.4:8888/").contains("on a private network"));
        assert!(why("http://127.0.0.1/").contains("this computer"));
        assert!(why("http://169.254.169.254/").contains("link-local"));
        // The reason names the host, never the path — no query secrets ride along.
        assert_eq!(why("http://10.0.0.1/?token=secret"), "10.0.0.1 is on a private network; only public pages can be read");
    }

    #[test]
    fn public_literal_addresses_pass() {
        for raw in [
            "http://93.184.216.34/",
            "https://1.1.1.1/dns-query",
            "http://[2606:2800:220:1:248:1893:25c8:1946]/",
            "https://8.8.8.8:8443/a/b?c=d#e",
        ] {
            let (url, addrs) = vet(raw).unwrap_or_else(|e| panic!("{raw} must pass: {e:?}"));
            assert!(!addrs.is_empty(), "{raw} carries its address");
            // The address that was checked is the address that will be used.
            let checked = addrs[0].ip().to_string();
            assert_eq!(Some(checked.as_str()), url.host_str().map(|h| h.trim_matches(['[', ']'])), "{raw}");
        }
    }

    #[test]
    fn a_name_is_only_as_public_as_every_address_it_resolves_to() {
        // Needs a resolver; skipped where there is none rather than failed.
        if vet("https://example.com/").is_err() {
            return;
        }
        let check = |host: &str, ips: &[&str]| {
            for ip in ips {
                if let Some(why) = non_public(ip.parse::<IpAddr>().unwrap()) {
                    return format!("{host} is {why}");
                }
            }
            "public".to_string()
        };
        assert_eq!(
            check("example.com", &["93.184.216.34", "10.0.0.5"]),
            "example.com is on a private network"
        );
        assert_eq!(check("example.com", &["8.8.8.8", "1.1.1.1"]), "public");
    }

    #[test]
    fn the_rest_of_the_reserved_ranges_are_known() {
        for (ip, why) in [
            ("8.8.8.8", None),
            ("240.0.0.1", Some("a reserved address")),
            ("192.0.0.8", Some("a reserved address")),
            ("224.0.0.1", Some("a multicast address")),
            ("255.255.255.255", Some("a broadcast address")),
            ("198.51.100.1", Some("not a real public address")),
            ("ff02::1", Some("a multicast address")),
            ("::", Some("not a real public address")),
            ("fc00::1", Some("on a private network")),
            ("2606:4700::1111", None),
        ] {
            assert_eq!(non_public(ip.parse().unwrap()), why, "{ip}");
        }
    }

    #[test]
    fn schemes_other_than_http_and_broken_addresses_are_refused() {
        for raw in ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/"] {
            assert!(matches!(vet(raw), Err(ToolError::Failed(_))), "{raw}");
        }
        for raw in ["not a url", "http://", "https:///path"] {
            assert!(vet(raw).is_err(), "{raw}");
        }
        assert!(vet(&format!("http://93.184.216.34/{}", "a".repeat(3_000))).is_err());
    }

    #[tokio::test]
    async fn a_refused_address_never_becomes_a_request() {
        let out = exec("web_fetch", r#"{"url":"http://192.168.50.4:8888/"}"#).await;
        assert!(matches!(out, Err(ToolError::Denied(_))));
        assert!(exec("web_fetch", r#"{"url":"ftp://example.com/"}"#).await.is_err());
        assert!(matches!(
            exec("web_fetch", "{not json").await,
            Err(ToolError::Failed(_))
        ));
        assert!(matches!(exec("web_fetch", "{}").await, Err(ToolError::Failed(_))));
    }

    #[tokio::test]
    async fn only_the_two_web_tools_run() {
        assert!(handles("web_search") && handles("web_fetch"));
        assert!(!handles("run_command"));
        assert!(matches!(exec("run_command", "{}").await, Err(ToolError::Denied(_))));
        assert!(matches!(exec("web_search", "{}").await, Err(ToolError::Failed(_))));
    }

    #[tokio::test]
    async fn without_a_key_search_says_so_and_touches_no_network() {
        for key in [None, Some(String::new()), Some("   ".to_string())] {
            let err = search_with(key, "rust", 5).await.err().expect("needs a key");
            let ToolError::Failed(reason) = err else { panic!("not a policy refusal") };
            assert!(reason.contains("no search key"), "{reason}");
        }
    }

    #[test]
    fn a_search_answer_keeps_only_what_the_model_reads() {
        let body = serde_json::json!({ "query": "rust", "results": [
            { "title": "Rust lang", "url": "https://www.rust-lang.org/", "content": "A language empowering everyone.", "score": 0.9, "raw_content": "<html>huge</html>" },
            { "title": "", "url": "https://example.org/x", "content": "Second." },
            { "title": "Third", "url": "https://example.org/y", "content": "Third." },
        ]})
        .to_string();
        let out = results("rust", 2, &body).unwrap();
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(value["query"], "rust");
        let hits = value["results"].as_array().unwrap();
        assert_eq!(hits.len(), 2, "the requested count is a cap");
        assert_eq!(
            hits[0],
            serde_json::json!({ "title": "Rust lang", "url": "https://www.rust-lang.org/", "snippet": "A language empowering everyone." })
        );
        assert_eq!(hits[1]["title"], "", "a missing title is empty, not null");

        let long = serde_json::json!({ "results": [{ "title": "t".repeat(500), "url": "u", "content": "c" }] }).to_string();
        let value: serde_json::Value = serde_json::from_str(&results("q", 10, &long).unwrap()).unwrap();
        assert_eq!(value["results"][0]["title"].as_str().unwrap().chars().count(), 200);
        assert!(results("q", 5, "not json").is_err());
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&results("q", 5, "{}").unwrap()).unwrap()["results"],
            serde_json::json!([]),
            "an answer without results is an empty list, not an error"
        );
        assert_eq!(max_results(&serde_json::json!({})), 5);
        assert_eq!(max_results(&serde_json::json!({ "maxResults": 99 })), 10);
        assert_eq!(max_results(&serde_json::json!({ "maxResults": 0 })), 1);
        assert_eq!(max_results(&serde_json::json!({ "maxResults": "3" })), 5);
    }

    // Two hashes: the sample contains `"#top"`, which would end an r#"…"#.
    const SAMPLE: &str = r##"<!doctype html>
<html><head><meta charset="utf-8">
<title> Rust &amp; the &lt;borrow&gt; checker &#183; a guide </title>
<style>body { color: red; /* > */ }</style>
<script>if (1 < 2) { document.write("<p>injected</p>"); }</script>
</head>
<body>
  <h1>Chapter&nbsp;one</h1>
  <p>Owns it <b>po<i>si</i>tion</b> &mdash; or borrows it.  A &copy; 2026.
     caf&eacute; &#x2713; &#8364;7 &unknown; &amp; more</p>
  <!-- a comment <p>hidden</p> -->
  <nav><a href="/docs" class='x'>Docs</a> | <a HREF=https://example.org/a?b=1&amp;c=2>Other</a>
     <a href="mailto:x@y.z">Mail</a> <a href="#top">Top</a> <a href="">Empty</a></nav>
  <ul><li>one<li>two</li></ul>
  <svg><text>vector</text></svg>
  <iframe src="x">fallback</iframe>
  <div>tail</div>
</body></html>"##;

    #[test]
    fn a_page_becomes_text_title_and_links() {
        let page = html_to_text(SAMPLE);
        assert_eq!(page.title, "Rust & the <borrow> checker · a guide");
        assert_eq!(
            page.text,
            "Chapter one\n\
             Owns it position — or borrows it. A © 2026. café ✓ €7 &unknown; & more\n\
             Docs | Other Mail Top Empty\n\
             one\n\
             two\n\
             tail"
        );
        assert_eq!(
            page.links,
            vec![
                ("Docs".to_string(), "/docs".to_string()),
                ("Other".to_string(), "https://example.org/a?b=1&c=2".to_string()),
                ("Mail".to_string(), "mailto:x@y.z".to_string()),
                ("Top".to_string(), "#top".to_string()),
            ],
            "an empty href is text, not a link"
        );
    }

    #[test]
    fn empty_broken_and_tricky_markup_are_survivable() {
        assert_eq!(html_to_text(""), Page::default());
        assert_eq!(html_to_text("<p>unclosed <b>bold").text, "unclosed bold");
        assert_eq!(html_to_text("<script>never closed <p>x</p>").text, "");
        assert_eq!(html_to_text("<p>a<b>b</b>c</p>").text, "abc");
        assert_eq!(html_to_text("a<br>b<hr>c").text, "a\nb\nc");
        assert_eq!(html_to_text("<SCRIPT>x</SCRIPT><P>y</P>").text, "y");
        // A close tag split inside a string literal does not end the script early.
        assert_eq!(
            html_to_text("<script>var s='</scr' + 'ipt>';</script>after").text,
            "after"
        );

        let links = html_to_text("<a href=http://x.y>plain</a><A HREF='/q'>cap</A>").links;
        assert_eq!(links, vec![("plain".to_string(), "http://x.y".to_string()), ("cap".to_string(), "/q".to_string())]);
        // A link whose label runs over several words is one link.
        assert_eq!(
            html_to_text("<a href='/a'>two words</a>").links,
            vec![("two words".to_string(), "/a".to_string())]
        );
    }

    #[test]
    fn entities_decode_and_leave_the_unknown_alone() {
        assert_eq!(decode_entities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;"), "a & b <c> \"d\" 'e'");
        assert_eq!(decode_entities("&#65;&#x42;&#X43; &nbsp;end"), "ABC  end");
        assert_eq!(decode_entities("&mdash;&copy;&rarr;"), "—©→");
        assert_eq!(decode_entities("&nope; & fish &amp &lt 3 &#x110000;"), "&nope; & fish &amp &lt 3 &#x110000;");
        assert_eq!(decode_entities("no entities here"), "no entities here");
    }

    #[test]
    fn attributes_are_found_whatever_their_quotes() {
        assert_eq!(attribute("href=\"/a?b=1\" id=x", "href").as_deref(), Some("/a?b=1"));
        assert_eq!(attribute("class='y' data-href='/no' href = '/yes'", "href").as_deref(), Some("/yes"));
        assert_eq!(attribute("href=http://x.y", "href").as_deref(), Some("http://x.y"));
        assert_eq!(attribute("data-href=\"/no\"", "href"), None);
        assert_eq!(attribute("href =", "href"), None);
        assert_eq!(attribute("", "href"), None);
    }

    #[test]
    fn text_is_cut_at_a_character_boundary_and_keeps_one_blank_line() {
        assert_eq!(clip("héllo wörld", 5), ("héllo".to_string(), true));
        assert_eq!(clip("short", 10), ("short".to_string(), false));
        assert_eq!(tidy("\n\n  a  \n\n\n\n b \n\n"), "a\n\nb");
        assert_eq!(tidy("   \n \n"), "");
    }
}
