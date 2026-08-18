import { SERVER_URL } from "../config";

// ---------------------------------------------------------------------------
// WebSocket client service
// ---------------------------------------------------------------------------

let ws = null;
let onMessage = null;
let onStatusChange = null;
let reconnectTimer = null;
let shouldReconnect = true;

/**
 * Register a callback for incoming server messages.
 * @param {(msg: object) => void} handler
 */
export function setMessageHandler(handler) {
  onMessage = handler;
}

/**
 * Register a callback for connection status changes.
 * @param {(connected: boolean) => void} handler
 */
export function setStatusHandler(handler) {
  onStatusChange = handler;
}

/**
 * Connect to the WebSocket server.
 * Automatically attempts to reconnect on disconnect.
 */
export function connect() {
  // Prevent duplicate connections.
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  shouldReconnect = true;
  clearTimeout(reconnectTimer);

  try {
    ws = new WebSocket(SERVER_URL);
  } catch (err) {
    console.warn("[WS] Failed to create WebSocket:", err.message);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[WS] Connected to", SERVER_URL);
    if (onStatusChange) onStatusChange(true);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (onMessage) onMessage(msg);
    } catch (err) {
      console.warn("[WS] Failed to parse message:", err.message);
    }
  };

  ws.onclose = () => {
    console.log("[WS] Disconnected");
    if (onStatusChange) onStatusChange(false);
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.warn("[WS] Error:", err.message);
    // onclose will fire after this, which handles reconnect.
  };
}

/** Send a JSON message to the server. Returns true if sent successfully. */
export function sendMessage(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

/** Disconnect and stop reconnecting. */
export function disconnect() {
  shouldReconnect = false;
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.close();
    ws = null;
  }
}

/** @returns {boolean} Whether the WebSocket is currently connected. */
export function isConnected() {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function scheduleReconnect() {
  if (!shouldReconnect) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    console.log("[WS] Attempting reconnect...");
    connect();
  }, 5000); // Reconnect every 5 seconds.
}
