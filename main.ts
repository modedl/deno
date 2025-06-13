// relay.ts

const BACKEND_URL = "wss://argo.modsbots.com";

export default {
  fetch: (req) => {
    const upgrade = req.headers.get("upgrade") || "";
    if (upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    // Create a WebSocket pair: [client (to browser), backend (to us)]
    const [client, remote] = Deno.upgradeWebSocket(req);

    // Connect to your real backend server
    const backendSocket = new WebSocket(BACKEND_URL);

    // Pipe messages from client -> backend
    remote.onmessage = (event) => {
      if (backendSocket.readyState === WebSocket.OPEN) {
        backendSocket.send(event.data);
      } else {
        console.error("Backend WebSocket not open. Dropping message.");
      }
    };

    // Pipe messages from backend -> client
    backendSocket.onmessage = (event) => {
      if (remote.readyState === WebSocket.OPEN) {
        remote.send(event.data);
      } else {
        console.error("Client WebSocket not open. Dropping message.");
      }
    };

    // Handle backend close
    backendSocket.onclose = () => {
      if (remote.readyState === WebSocket.OPEN) {
        remote.close();
      }
    };

    // Handle backend error
    backendSocket.onerror = (err) => {
      console.error("Error with backend WebSocket:", err);
      remote.close();
    };

    // Optional: Handle client close
    remote.onclose = () => {
      if (backendSocket.readyState === WebSocket.OPEN) {
        backendSocket.close();
      }
    };

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  },
};
