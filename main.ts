// proxy.ts
const PUBLIC_PROXY = "https://abc123xyz.ngrok.io";  // Replace with your ngrok URL

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const search = url.search;

  const targetUrl = `${PUBLIC_PROXY}${path}${search}`;

  try {
    const res = await fetch(targetUrl, {
      method: req.method,
      headers: filterHeaders(req.headers),
      body: req.body,
    });

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: filterHeaders(res.headers),
    });
  } catch (err) {
    console.error("Proxy error:", err);
    return new Response("Error proxying request", { status: 500 });
  }
}

// Filter out forbidden headers
function filterHeaders(headers: Headers): HeadersInit {
  const filtered: Record<string, string> = {};
  const forbidden = ["host", "origin", "referer"];

  for (const [key, value] of headers.entries()) {
    if (!forbidden.includes(key.toLowerCase())) {
      filtered[key] = value;
    }
  }

  return filtered;
}
