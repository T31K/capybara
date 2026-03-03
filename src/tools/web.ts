import type { Tool } from "./index.js";

export const webSearchTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web using DuckDuckGo. Returns titles, URLs, and snippets for the top results.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
          max_results: {
            type: "number",
            description: "Maximum number of results to return (optional, default: 5)",
          },
        },
        required: ["query"],
      },
    },
  },

  async execute(args) {
    const query = args.query as string;
    const maxResults = (args.max_results as number | undefined) ?? 5;

    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    let html: string;
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ai-cli/0.1.0)",
          Accept: "text/html",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return `Error: HTTP ${res.status} from DuckDuckGo`;
      html = await res.text();
    } catch (err) {
      return `Error fetching search results: ${(err as Error).message}`;
    }

    const results = parseDDGResults(html, maxResults);
    if (results.length === 0) return `No results found for: ${query}`;

    const lines = [`Search results for: ${query}`, ""];
    results.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title}`);
      lines.push(`   ${r.url}`);
      if (r.snippet) lines.push(`   ${r.snippet}`);
      lines.push("");
    });

    return lines.join("\n").trim();
  },
};

function parseDDGResults(html: string, max: number): { title: string; url: string; snippet: string }[] {
  const results: { title: string; url: string; snippet: string }[] = [];

  // Match result blocks
  const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const titles: { url: string; title: string }[] = [];
  let m: RegExpExecArray | null;

  while ((m = resultRegex.exec(html)) !== null && titles.length < max) {
    const href = m[1];
    const title = stripTags(m[2]).trim();
    // DDG wraps URLs — extract actual URL from uddg param or use directly
    const urlMatch = href.match(/uddg=([^&]+)/);
    const url = urlMatch ? decodeURIComponent(urlMatch[1]) : href;
    if (url.startsWith("http") && title) {
      titles.push({ url, title });
    }
  }

  const snippets: string[] = [];
  while ((m = snippetRegex.exec(html)) !== null) {
    snippets.push(stripTags(m[1]).trim());
  }

  for (let i = 0; i < titles.length; i++) {
    results.push({ ...titles[i], snippet: snippets[i] ?? "" });
  }

  return results;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export const fetchUrlTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "Fetch the text content of a URL (documentation, GitHub files, web pages). Returns the raw text of the page.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch",
          },
        },
        required: ["url"],
      },
    },
  },

  async execute(args) {
    const url = args.url as string;

    try {
      new URL(url); // validate URL
    } catch {
      return `Error: Invalid URL "${url}"`;
    }

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "ai-cli/0.1.0 (agentic CLI tool)",
          Accept: "text/html,text/plain,application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        return `Error: HTTP ${response.status} ${response.statusText} for ${url}`;
      }

      const contentType = response.headers.get("content-type") ?? "";
      const text = await response.text();

      if (contentType.includes("application/json")) {
        try {
          const json = JSON.parse(text);
          return `URL: ${url}\nContent-Type: ${contentType}\n\n${JSON.stringify(json, null, 2).slice(0, 20_000)}`;
        } catch {
          // fall through to raw text
        }
      }

      // Strip HTML tags for cleaner output
      const stripped = contentType.includes("text/html")
        ? stripHtml(text)
        : text;

      return `URL: ${url}\n\n${stripped.slice(0, 20_000)}${stripped.length > 20_000 ? "\n... (truncated)" : ""}`;
    } catch (err) {
      return `Error fetching ${url}: ${(err as Error).message}`;
    }
  },
};

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}
