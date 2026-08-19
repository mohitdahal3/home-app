import "./global.css";

import React, { useState, useEffect, useCallback } from "react";
import { View, ActivityIndicator, AppState } from "react-native";

import * as db from "./src/db/database";
import * as ws from "./src/services/websocket";

import LoginScreen from "./src/screens/LoginScreen";
import MainListScreen from "./src/screens/MainListScreen";

/**
 * Root component.
 *
 * Manages:
 *  - Database initialization
 *  - Session persistence (auto-login via SQLite)
 *  - WebSocket lifecycle and message routing
 *  - Top-level screen switching (Login ↔ Main)
 */
export default function App() {
  const [ready, setReady] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [passcode, setPasscode] = useState(null);
  const [users, setUsers] = useState([]);
  const [items, setItems] = useState([]);
  const [connected, setConnected] = useState(false);

  // ------------------------------------------------------------------
  // 1. Initialize database & check for saved session
  // ------------------------------------------------------------------
  useEffect(() => {
    db.initDB();

    const session = db.getSession();
    if (session) {
      setCurrentUser(session.username);
      setPasscode(session.passcode);

      // Load cached data so the user sees something immediately.
      const cachedUsers = db.getCachedUsers();
      if (cachedUsers.length > 0) setUsers(cachedUsers);

      const cachedItems = db.getItems();
      if (cachedItems.length > 0) setItems(cachedItems);
    }

    setReady(true);
  }, []);

  // ------------------------------------------------------------------
  // 2. Connect to server once we have credentials
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!passcode) return;

    // Set up message handler BEFORE connecting.
    ws.setMessageHandler((msg) => {
      switch (msg.type) {
        case "AUTH_OK":
          // Server confirmed our credentials.
          if (msg.users && msg.users.length > 0) {
            setUsers(msg.users);
            db.saveUsers(msg.users);
          }
          // Flush any queued offline actions.
          flushDiary();
          break;

        case "AUTH_FAIL":
          // Saved session is invalid (passcode was changed on server).
          db.clearSession();
          setCurrentUser(null);
          setPasscode(null);
          ws.disconnect();
          break;

        case "SYNC":
          // Server sent the authoritative master list.
          if (msg.list) {
            db.replaceAllItems(msg.list);
            setItems(db.getItems());
          }
          if (msg.users && msg.users.length > 0) {
            setUsers(msg.users);
            db.saveUsers(msg.users);
          }
          break;

        case "ERROR":
          console.warn("[Server Error]", msg.message);
          break;
      }
    });

    ws.setStatusHandler((isConnected) => {
      setConnected(isConnected);
      if (isConnected) {
        // Authenticate on every new connection.
        ws.sendMessage({ type: "AUTH", passcode });
      }
    });

    setConnected(ws.isConnected());
    ws.connect();

    return () => {
      ws.disconnect();
    };
  }, [passcode]);

  // ------------------------------------------------------------------
  // 3. Flush the Action Diary to the server
  // ------------------------------------------------------------------
  const flushDiary = useCallback(() => {
    const pending = db.getPendingActions();
    if (pending.length === 0) return;

    const sent = ws.sendMessage({
      type: "DIARY",
      clientTime: Date.now(), // Server uses this for clock drift correction.
      actions: pending.map((a) => ({
        type: a.type,
        text: a.text,
        itemId: a.itemId,
        listType: a.listType,
        timestamp: a.timestamp,
      })),
    });

    if (sent) {
      db.clearActionQueue();
    }
  }, []);

  // ------------------------------------------------------------------
  // 3.5 Auto-update when app comes to foreground
  // ------------------------------------------------------------------
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextAppState) => {
      if (nextAppState === "active") {
        if (ws.isConnected()) {
          ws.sendMessage({ type: "REQUEST_SYNC" });
          flushDiary();
        } else if (passcode) {
          ws.connect();
        }
      }
    });

    return () => {
      subscription.remove();
    };
  }, [passcode, flushDiary]);

  // ------------------------------------------------------------------
  // 4. Callback for child screens to trigger a re-read from local DB
  // ------------------------------------------------------------------
  const refreshItems = useCallback(() => {
    setItems(db.getItems());

    // Also try to flush diary in case we have connectivity now.
    flushDiary();
  }, [flushDiary]);

  // ------------------------------------------------------------------
  // 5. Login success handler
  // ------------------------------------------------------------------
  const handleLoginSuccess = useCallback(
    (username, code, serverUsers) => {
      db.saveSession(username, code);
      setCurrentUser(username);
      setPasscode(code);

      if (serverUsers && serverUsers.length > 0) {
        setUsers(serverUsers);
        db.saveUsers(serverUsers);
      }

      // Load items after login.
      setItems(db.getItems());
    },
    []
  );

  // ------------------------------------------------------------------
  // 6. Logout handler
  // ------------------------------------------------------------------
  const handleLogout = useCallback(() => {
    ws.disconnect();
    db.clearSession();
    setCurrentUser(null);
    setPasscode(null);
    setUsers([]);
    setItems([]);
    setConnected(false);
  }, []);

  // ------------------------------------------------------------------
  // 7. Manual refresh (pull-to-refresh) — request sync from server
  // ------------------------------------------------------------------
  const handleManualRefresh = useCallback(() => {
    // Request the latest snapshot from the server.
    ws.sendMessage({ type: "REQUEST_SYNC" });

    // Also flush any pending diary entries.
    flushDiary();
  }, [flushDiary]);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  // Show a brief loading state while the DB initializes.
  if (!ready) {
    return (
      <View className="flex-1 bg-white items-center justify-center">
        <ActivityIndicator size="large" color="#6366F1" />
      </View>
    );
  }

  // No session → Login screen.
  if (!currentUser) {
    return <LoginScreen onLoginSuccess={handleLoginSuccess} />;
  }

  // Logged in → Main list screen.
  return (
    <MainListScreen
      currentUser={currentUser}
      users={users}
      items={items}
      onItemsChanged={refreshItems}
      onLogout={handleLogout}
      onManualRefresh={handleManualRefresh}
      connected={connected}
    />
  );
}
