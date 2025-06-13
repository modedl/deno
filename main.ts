// Replace with your public proxy (e.g., ngrok URL)
const PUBLIC_PROXY = "dev.my-project-h842.diploi.app"; 

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

Deno.serve(async (req) => {
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
});
