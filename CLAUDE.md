# Project: Home (Shared Grocery List App)

## Overview
"Home" is a collaborative, offline-first React Native mobile app for roommates to share a grocery list.
The server runs locally on a specific roommate's Ubuntu laptop. Because this laptop moves networks, goes to sleep, and switches operating systems, the app relies on a "Local-First / Action Diary" syncing architecture.

## Tech Stack
* **Client/App:** React Native with Expo (target: iOS and Android).
* **App UI/Styling:** NativeWind (Tailwind CSS for React Native).
* **App Database:** Expo SQLite (`expo-sqlite` modern API).
* **Backend Server:** Node.js using WebSockets (`ws`).
* **Server Host:** A self-hosted Ubuntu Linux partition on a laptop. Do NOT write scripts or paths for Windows.
* **Networking:** The Node.js server is exposed to the internet via a Cloudflare Tunnel daemon (`cloudflared`) configured as a systemd service.

## Core Sync Architecture (The "Action Diary")
Because the server is often asleep or offline, the app must never wait for a server response.
1.  **Local First:** When a user opens the app, they see the list stored in their local SQLite database.
2.  **The Diary:** When a user adds an item or checks an item, the app saves it locally instantly AND logs an "Action" (e.g., `ACTION: ADD, ITEM: "Apples", TIMESTAMP: 1718293910`) into a local queue table.
3.  **The Tunnel:** The app attempts to connect to the Node.js WebSocket server via the Cloudflare Tunnel URL. 
4.  **The Merge:** When connection is successful, the app flushes its Action Diary queue to the server. The server reads diaries from all connected users, orders them by exact timestamps, and executes them to determine the "True" list.
5.  **Duplicate Handling:** If the server processes the diary and sees two users added the exact same string (e.g., "Milk" and "Milk") while offline, the server merges them. It only creates ONE item in the central database with a single unique ID. 
6.  **The Broadcast:** The server sends the new, merged "True" list back to all connected phones, overriding their local views.

## Authentication & User Permissions
* **No sign-up screens, no emails, no passwords.**
* **CSV-Driven Users:** The server uses a hardcoded CSV file (`users.csv`) containing `username,passcode`. If a user is removed from the CSV, their button/tab disappears from the app, but their historical data remains in the database.
* **Persistent Session:** The app has a minimalist login screen. Users enter their passcode, the app sends it to the server, and the server validates it against the CSV. Once validated, the app saves the user session locally so they never have to log in again.
* **Access Control Rules:**
    * **Group List:** Visible to ALL roommates. Editable/Interactable by ALL roommates.
    * **Personal Lists:** Visible to ALL roommates. BUT the checkbox, delete button, and Add (+) button are ONLY interactable if the logged-in user matches the owner of that list.

## UI/UX Guidelines & Screen Flow
* Keep it clean, minimal, and fast.
1.  **Login Screen:**
    * Header: "Home"
    * Subheader: "Our Shopping list"
    * Text: "For 737 Bryson #522"
    * Input: "Login Code:"
    * Button: "Login"
2.  **Main List Screen:**
    * Header: "Home"
    * Subheader: "Our Shopping list"
    * **List Context Selector (Tabs):** A horizontal row of tabs dynamically generated from the active server user list (e.g., `Group | Mohit | Samir | Sapan | Prashant`). Tapping a tab swaps the list instantly without changing pages.
    * **Scrollview List:** Shows items with a `<checkbox>`, `Item Name`, and a `<delete button>`.
    * **Add Button (+):** Floating action button to add items.
    * **UI Enforcement:** Checkbox, delete button, and Add (+) button are disabled and hidden if a user is viewing another roommate's personal list.