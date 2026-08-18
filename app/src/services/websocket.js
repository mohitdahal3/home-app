import { SERVER_URL } from "../config";

// ---------------------------------------------------------------------------
// WebSocket client service
//
// Handles connection lifecycle, automatic reconnection with exponential
// backoff + jitter, and message routing.
// ---------------------------------------------------------------------------

let ws = null;
let onMessage = null;
let onStatusChange = null;
let reconnectTimer = null;
let shouldReconnect = true;

// Exponential backoff state.
let reconnectAttempts = 0;
const BASE_DELAY = 1000;   // 1 second
const MAX_DELAY = 30000;   // 30 seconds cap

/**
 * Calculate the next reconnect delay using exponential backoff with jitter.
 * Sequence: 1s → 2s → 4s → 8s → 16s → 30s (capped).
 * Adds 0–20% random jitter to prevent thundering herd when the server
 * restarts and all 4 phones try to reconnect simultaneously.
 */
function getReconnectDelay() {
  const exponential = Math.min(BASE_DELAY * Math.pow(2, reconnectAttempts), MAX_DELAY);
  const jitter = exponential * 0.2 * Math.random();
  return Math.round(exponential + jitter);
}

/**
 * Register a callback for incoming server messages.
 * Replaces any previously registered handler (no listener accumulation).
 * @param {(msg: object) => void} handler
 */
export function setMessageHandler(handler) {
  onMessage = handler;
}

/**
 * Register a callback for connection status changes.
 * Replaces any previously registered handler (no listener accumulation).
 * @param {(connected: boolean) => void} handler
 */
export function setStatusHandler(handler) {
  onStatusChange = handler;
}

/**
 * Connect to the WebSocket server.
 * Automatically attempts to reconnect on disconnect with exponential backoff.
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
    reconnectAttempts = 0; // Reset backoff on successful connection.
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

/**
 * Disconnect and stop reconnecting.
 * Also resets backoff counter so the next connect() starts fresh.
 */
export function disconnect() {
  shouldReconnect = false;
  clearTimeout(reconnectTimer);
  reconnectAttempts = 0;
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

  const delay = getReconnectDelay();
  reconnectAttempts++;

  console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    connect();
  }, delay);
}
