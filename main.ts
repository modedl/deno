import { exists } from "https://deno.land/std/fs/exists.ts"; 

// === Configuration ===
const ENV = {
  UUID: Deno.env.get("UUID") || "d342d11ed4244583b36e524ab1f0afa4",
  PROXY_IP: Deno.env.get("PROXY_IP") || "1.1.1.1",
  CREDIT: Deno.env.get("CREDIT") || "VlessProxy-Deno",
};

const CONFIG_FILE = "config.json";
const WS_OPEN_STATE = 1;

// === UUID Logic ===
type Config = { uuid?: string };

function isValidUUID(uuid: string): boolean {
  const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return regex.test(uuid);
}

async function loadConfig(): Promise<string> {
  if (ENV.UUID && isValidUUID(ENV.UUID)) {
    console.log(`Using UUID from env: ${ENV.UUID}`);
    return ENV.UUID;
  }

  if (await exists(CONFIG_FILE)) {
    try {
      const data = JSON.parse(await Deno.readTextFile(CONFIG_FILE)) as Config;
      if (data.uuid && isValidUUID(data.uuid)) {
        console.log(`Loaded UUID from config: ${data.uuid}`);
        return data.uuid;
      }
    } catch (e) {
      console.error("Error reading config:", e.message);
    }
  }

  const newUUID = crypto.randomUUID();
  await Deno.writeTextFile(CONFIG_FILE, JSON.stringify({ uuid: newUUID }, null, 2));
  console.log(`Generated and saved new UUID: ${newUUID}`);
  return newUUID;
}

// === HTTP Server & Routes ===
async function serveRoot(req: Request): Promise<Response> {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Deno VLESS Proxy</title></head>
<body style="font-family:sans-serif;text-align:center;margin-top:50px;">
  <h1>🚀 Deno VLESS Proxy</h1>
  <p>Your VLESS over WebSocket proxy is running.</p>
  <a href="/${userID}"><button style="padding:10px 20px;font-size:1.2em;">Get VLESS Config</button></a>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

async function serveConfig(req: Request, userID: string): Promise<Response> {
  const url = new URL(req.url);
  const host = url.hostname;
  const vlessURI = `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2048#${ENV.CREDIT}`;
  const clashConfig = `- type: vless\n  name: ${host}\n  server: ${host}\n  port: 443\n  uuid: ${userID}\n  network: ws\n  tls: true\n  sni: ${host}\n  client-fingerprint: chrome\n  ws-opts:\n    path: "/?ed=2048"\n    headers:\n      host: ${host}`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>VLESS Config</title></head>
<body style="font-family:sans-serif;padding:20px;">
  <h1>🔑 VLESS Configuration</h1>
  <h2>VLESS URI:</h2>
  <pre>${vlessURI}</pre>
  <h2>Clash-Meta Config:</h2>
  <pre>${clashConfig}</pre>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// === WebSocket Handler ===
async function handleWebSocket(req: Request, userID: string): Promise<Response> {
  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.onOpen = () => {
    console.log("WebSocket opened");
    handleConnection(socket, userID).catch((err) => {
      console.error("Error in connection:", err.message);
      socket.close();
    });
  };

  return response;
}

async function handleConnection(socket: WebSocket, userID: string): Promise<void> {
  const stream = makeReadableWebSocketStream(socket);
  const reader = stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const buffer = value.buffer;
    const headerResult = parseVlessHeader(buffer, userID);
    if (headerResult.hasError) {
      console.error(headerResult.message);
      socket.close();
      return;
    }

    const { addressRemote, portRemote, rawDataIndex } = headerResult;
    const data = buffer.slice(rawDataIndex);

    // Connect to remote target
    const conn = await Deno.connect({ hostname: addressRemote, port: portRemote });
    conn.write(new Uint8Array(data));

    // Pipe remote back to client
    const writer = socket.send.bind(socket);
    conn.readable.pipeTo(
      new WritableStream({
        write(chunk) {
          writer(chunk);
        },
      })
    );
  }
}

// === VLESS Header Parser ===
function parseVlessHeader(buffer: ArrayBuffer, userID: string) {
  if (buffer.byteLength < 24) {
    return { hasError: true, message: "Invalid header size" };
  }

  const view = new DataView(buffer, 0, 24);
  const uuidBytes = new Uint8Array(buffer, 1, 16);
  const uuid = stringifyUUID(uuidBytes);

  if (uuid !== userID) {
    return { hasError: true, message: "Invalid user ID" };
  }

  const command = new Uint8Array(buffer, 18, 1)[0];
  if (command !== 1) {
    return { hasError: true, message: "Only TCP supported" };
  }

  const portView = new DataView(buffer, 19, 2);
  const portRemote = portView.getUint16(0);

  const addrType = new Uint8Array(buffer, 21, 1)[0];
  let addressRemote = "";
  let offset = 22;

  switch (addrType) {
    case 1:
      const ip = new Uint8Array(buffer, offset, 4);
      addressRemote = ip.join(".");
      offset += 4;
      break;
    case 2:
      const len = new Uint8Array(buffer, offset, 1)[0];
      offset += 1;
      addressRemote = new TextDecoder().decode(new Uint8Array(buffer, offset, len));
      offset += len;
      break;
    default:
      return { hasError: true, message: "Unsupported address type" };
  }

  return {
    hasError: false,
    addressRemote,
    portRemote,
    rawDataIndex: offset,
  };
}

function stringifyUUID(arr: Uint8Array): string {
  const hex = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

// === WebSocket Stream Utility ===
function makeReadableWebSocketStream(socket: WebSocket): ReadableStream<Uint8Array> {
  const controller = new AbortController();

  return new ReadableStream({
    start(controller) {
      socket.onmessage = (msg) => controller.enqueue(new Uint8Array(msg.data as ArrayBuffer));
      socket.onclose = () => controller.close();
      socket.onerror = (err) => {
        console.error("WebSocket error:", err.message);
        controller.error(err);
      };
    },
    cancel() {
      socket.close();
      controller.signal.addEventListener("abort", () => {});
    },
  });
}

// === Main Server Logic ===
const userID = await loadConfig();

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const upgrade = req.headers.get("upgrade") || "";

  if (upgrade.toLowerCase() === "websocket") {
    return handleWebSocket(req, userID);
  }

  switch (url.pathname) {
    case "/":
      return serveRoot(req);
    case `/${userID}`:
      return serveConfig(req, userID);
    default:
      return new Response("Not Found", { status: 404 });
  }
});
