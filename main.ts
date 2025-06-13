const PROXY_SERVER = "dev.my-project-h842.diploi.app"; 

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const path = url.pathname;
  const target = PROXY_SERVER + path;

  const res = await fetch(target, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });

  return res;
}
