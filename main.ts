import { exists } from "https://deno.land/std/fs/exists.ts";  // You can remove this import if not used elsewhere

// === Configuration ===
const envUUID = Deno.env.get('UUID') || 'e5185305-1984-4084-81e0-f77271159c62';
if (!envUUID || !isValidUUID(envUUID)) {
  throw new Error("UUID must be set via environment variable and must be valid.");
}
const userID = envUUID;
const proxyIP = Deno.env.get('PROXYIP') || '';
const credit = Deno.env.get('CREDIT') || 'DenoBy-ModsBots';

console.log(`Using UUID from environment: ${userID}`);
console.log(Deno.version);

Deno.serve(async (request: Request) => {
  const upgrade = request.headers.get('upgrade') || '';
  if (upgrade.toLowerCase() != 'websocket') {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/': {
        const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Welcome to Deno Proxy</title>
</head>
<body style="text-align:center;padding:40px;">
    <h1>🚀 Deno Proxy Online!</h1>
    <p>Your VLESS over WebSocket proxy is running.</p>
    <a href="/${userID}" style="font-size:1.2em; padding:10px 20px; background:#007bff; color:white; border-radius:5px; text-decoration:none;">Get My VLESS Config</a>
</body>
</html>`;
        return new Response(htmlContent, {
          headers: { 'Content-Type': 'text/html' },
        });
      }
      case `/${userID}`: {
        const hostName = url.hostname;
        const port = url.port || 443;
        const vlessMain = `vless://${userID}@${hostName}:${port}?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${credit}`;
        const clashMetaConfig = `
- type: vless
  name: ${hostName}
  server: ${hostName}
  port: ${port}
  uuid: ${userID}
  network: ws
  tls: true
  sni: ${hostName}
  client-fingerprint: chrome
  udp: false
  ws-opts:
    path: "/?ed=2048"
    headers:
      host: ${hostName}
`;
        const htmlConfigContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>VLESS Configuration</title>
</head>
<body style="padding:20px;font-family:sans-serif;">
    <h1>🔑 Your VLESS Configuration</h1>
    <h2>VLESS URI:</h2>
    <pre>${vlessMain}</pre>
    <h2>Clash-Meta Config:</h2>
    <pre>${clashMetaConfig.trim()}</pre>
</body>
</html>`;
        return new Response(htmlConfigContent, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      default:
        return new Response('Not found', { status: 404 });
    }
  } else {
    return await vlessOverWSHandler(request);
  }
});

async function vlessOverWSHandler(request: Request) {
  const { socket, response } = Deno.upgradeWebSocket(request, {
    perMessageDeflate: true, // Enable compression
  });

  let address = '';
  let portWithRandomLog = '';
  let heartbeatInterval: number;

  const log = (info: string) => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`);
  };

  // Heartbeat ping to keep connection alive
  socket.onopen = () => {
    heartbeatInterval = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(new TextEncoder().encode(JSON.stringify({ type: "ping" })));
      }
    }, 30_000); // Send every 30s
  };

  socket.onclose = () => {
    clearInterval(heartbeatInterval);
    log("WebSocket closed");
  };

  const readableWebSocketStream = makeReadableWebSocketStream(socket, request.headers.get('sec-websocket-protocol') || '', log);
  let remoteSocketWrapper: { value: any } = { value: null };
  let udpStreamWrite: any = null;
  let isDns = false;

  readableWebSocketStream.pipeTo(new WritableStream({
    async write(chunk) {
      if (isDns && udpStreamWrite) {
        return udpStreamWrite(chunk);
      }

      if (remoteSocketWrapper.value) {
        const writer = remoteSocketWrapper.value.writable.getWriter();
        await writer.write(new Uint8Array(chunk));
        writer.releaseLock();
        return;
      }

      const {
        hasError,
        message,
        addressRemote = '',
        portRemote = 443,
        rawDataIndex,
        vlessVersion = new Uint8Array([0, 0]),
        isUDP,
      } = processVlessHeader(chunk, userID);

      address = addressRemote;
      portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp' : 'tcp'}`;

      if (hasError) {
        throw new Error(message);
      }

      if (isUDP && portRemote !== 53) {
        throw new Error('UDP proxy only enabled for DNS on port 53');
      }

      const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
      const rawClientData = chunk.slice(rawDataIndex);

      if (isUDP) {
        const { write } = await handleUDPOutBound(socket, vlessResponseHeader, log);
        udpStreamWrite = write;
        udpStreamWrite(rawClientData);
        return;
      }

      handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, rawClientData, socket, vlessResponseHeader, log);
    },
  })).catch((err) => {
    log(`WebSocket pipe error: ${err.message}`);
  });

  return response;
}

function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

function processVlessHeader(vlessBuffer: ArrayBuffer, userID: string) {
  if (vlessBuffer.byteLength < 24) {
    return { hasError: true, message: 'invalid data' };
  }

  const version = new Uint8Array(vlessBuffer.slice(0, 1));
  const uuid = stringify(new Uint8Array(vlessBuffer.slice(1, 17)));

  if (uuid !== userID) {
    return { hasError: true, message: 'invalid user' };
  }

  const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
  const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

  let isUDP = false;
  if (command === 2) {
    isUDP = true;
  } else if (command !== 1) {
    return { hasError: true, message: `unsupported command: ${command}` };
  }

  const portIndex = 18 + optLength + 1;
  const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);

  const addressIndex = portIndex + 2;
  const addressType = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1))[0];

  let addressValue = '';
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;

  switch (addressType) {
    case 1:
      addressLength = 4;
      const bytes = new Uint8Array(vlessBuffer, addressValueIndex, addressLength);
      addressValue = `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
      break;
    case 2:
      addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    case 3:
      addressLength = 16;
      const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      const ipv6 = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16));
      }
      addressValue = ipv6.join(':');
      break;
    default:
      return { hasError: true, message: `invalid address type: ${addressType}` };
  }

  return {
    hasError: false,
    addressRemote: addressValue,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlessVersion: version,
    isUDP,
  };
}

function stringify(arr: Uint8Array, offset = 0): string {
  const hex = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-').toLowerCase();
}

function base64ToArrayBuffer(base64Str: string) {
  try {
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decode = atob(base64Str);
    const buffer = Uint8Array.from(decode, c => c.charCodeAt(0));
    return { earlyData: buffer.buffer, error: null };
  } catch (e) {
    return { error: e };
  }
}

function makeReadableWebSocketStream(webSocket: WebSocket, earlyDataHeader: string, log: (info: string) => void) {
  const stream = new ReadableStream({
    start(controller) {
      webSocket.onmessage = (event) => controller.enqueue(event.data);
      webSocket.onclose = () => controller.close();
      webSocket.onerror = (err) => controller.error(err);

      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) controller.error(error);
      if (earlyData) controller.enqueue(earlyData);
    },
    cancel() {
      safeCloseWebSocket(webSocket);
    },
  });
  return stream;
}

async function handleTCPOutBound(
  remoteSocket: { value: any },
  addressRemote: string,
  portRemote: number,
  rawClientData: Uint8Array,
  webSocket: WebSocket,
  vlessResponseHeader: Uint8Array,
  log: (info: string) => void
) {
  const tcpSocket = await Deno.connect({ hostname: addressRemote, port: portRemote });
  remoteSocket.value = tcpSocket;
  await tcpSocket.write(new Uint8Array(rawClientData));

  tcpSocket.readable.pipeTo(new WritableStream({
    highWaterMark: 32768,
    size: 16384,
    write(chunk) {
      if (webSocket.readyState === WebSocket.OPEN) {
        if (vlessResponseHeader.byteLength > 0) {
          webSocket.send(new Uint8Array([...vlessResponseHeader, ...chunk]));
          vlessResponseHeader = new Uint8Array(0);
        } else {
          webSocket.send(chunk);
        }
      }
    },
    close() {
      safeCloseWebSocket(webSocket);
    },
  }));
}

async function handleUDPOutBound(webSocket: WebSocket, vlessResponseHeader: Uint8Array, log: (info: string) => void) {
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength;) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength));
        index = index + 2 + udpPakcetLength;
        controller.enqueue(udpData);
      }
    },
  });

  transformStream.readable.pipeTo(new WritableStream({
    async write(chunk) {
      const resp = await fetchWithTimeout('https://1.1.1.1/dns-query',  {
        method: 'POST',
        headers: { 'content-type': 'application/dns-message' },
        body: chunk,
      }, 15000);

      const dnsQueryResult = await resp.arrayBuffer();
      const udpSizeBuffer = new Uint8Array([(dnsQueryResult.byteLength >> 8) & 0xff, dnsQueryResult.byteLength & 0xff]);

      if (webSocket.readyState === WebSocket.OPEN) {
        webSocket.send(new Uint8Array([...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)]));
      }
    },
  }));

  const writer = transformStream.writable.getWriter();
  return {
    write(chunk: Uint8Array) {
      writer.write(chunk);
    },
  };
}

function safeCloseWebSocket(socket: WebSocket) {
  try {
    if (socket.readyState === 1 || socket.readyState === 2) socket.close();
  } catch (e) {
    console.error("Failed to safely close WebSocket:", e);
  }
}

async function fetchWithTimeout(url: string, options: RequestInit, timeout = 10_000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}
