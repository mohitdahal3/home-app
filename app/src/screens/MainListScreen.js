import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ScrollView,
} from "react-native";
import { StatusBar } from "expo-status-bar";

import AddItemModal from "../components/AddItemModal";
import * as db from "../db/database";
import * as ws from "../services/websocket";

/**
 * Main List Screen
 *
 * - Horizontal tab bar: "Group" + one tab per user from the server.
 * - Scrollable item list with checkbox & delete.
 * - Floating "+" button to add items.
 * - Access control: personal lists are read-only unless you own them.
 */
export default function MainListScreen({
  currentUser,
  users,
  items,
  onItemsChanged,
  connected,
}) {
  const tabs = ["Group", ...users];
  const [activeTab, setActiveTab] = useState("Group");
  const [showAddModal, setShowAddModal] = useState(false);

  // Determine the listType key for the active tab.
  const activeListType = activeTab === "Group" ? "group" : activeTab;

  // Access control: can this user interact with the active list?
  const canEdit = activeTab === "Group" || activeTab === currentUser;

  // Filter items for the active tab.
  const filteredItems = items.filter((item) => item.listType === activeListType);

  // ---- Actions ----

  const handleAdd = useCallback(
    (text) => {
      // 1. Write to local DB instantly.
      db.addItem(text, activeListType, currentUser);

      // 2. Log to the Action Diary.
      db.logAction("ADD", { text, listType: activeListType });

      // 3. Try to flush diary to server.
      flushDiary();

      // 4. Refresh the screen.
      onItemsChanged();
    },
    [activeListType, currentUser, onItemsChanged]
  );

  const handleCheck = useCallback(
    (item) => {
      if (!canEdit) return;

      const newChecked = item.checked ? 0 : 1;

      if (newChecked) {
        db.checkItem(item.id, currentUser);
        db.logAction("CHECK", { text: item.text, itemId: item.id, listType: item.listType });
      } else {
        // Unchecking — re-add the item (server treats it as a new ADD).
        db.uncheckItem(item.id);
        // We don't log an uncheck action since the server doesn't support it yet.
        // The next sync will reconcile.
      }

      flushDiary();
      onItemsChanged();
    },
    [canEdit, currentUser, onItemsChanged]
  );

  const handleDelete = useCallback(
    (item) => {
      if (!canEdit) return;

      db.deleteItem(item.id);
      db.logAction("DELETE", { text: item.text, itemId: item.id, listType: item.listType });
      flushDiary();
      onItemsChanged();
    },
    [canEdit, onItemsChanged]
  );

  // ---- Sync ----

  const flushDiary = () => {
    const pending = db.getPendingActions();
    if (pending.length === 0) return;

    const sent = ws.sendMessage({
      type: "DIARY",
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
    // If not sent, actions stay queued for next connection.
  };

  // ---- Render helpers ----

  const renderItem = useCallback(
    ({ item }) => (
      <View
        className={`flex-row items-center bg-white rounded-xl mx-4 mb-2.5 px-4 py-3.5 ${
          item.checked ? "opacity-50" : ""
        }`}
        style={{
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.05,
          shadowRadius: 3,
          elevation: 1,
        }}
      >
        {/* Checkbox */}
        {canEdit ? (
          <TouchableOpacity
            onPress={() => handleCheck(item)}
            className={`w-6 h-6 rounded-md border-2 items-center justify-center mr-3 ${
              item.checked
                ? "bg-emerald-500 border-emerald-500"
                : "border-slate-300"
            }`}
            activeOpacity={0.7}
          >
            {item.checked ? (
              <Text className="text-white text-xs font-bold">✓</Text>
            ) : null}
          </TouchableOpacity>
        ) : (
          // Read-only indicator for non-owners
          <View
            className={`w-6 h-6 rounded-md border-2 items-center justify-center mr-3 ${
              item.checked
                ? "bg-emerald-500 border-emerald-500"
                : "border-slate-200 bg-slate-50"
            }`}
          >
            {item.checked ? (
              <Text className="text-white text-xs font-bold">✓</Text>
            ) : null}
          </View>
        )}

        {/* Item text */}
        <Text
          className={`flex-1 text-base ${
            item.checked
              ? "text-slate-400 line-through"
              : "text-slate-800"
          }`}
          numberOfLines={2}
        >
          {item.text}
        </Text>

        {/* Delete button — only for list owners */}
        {canEdit ? (
          <TouchableOpacity
            onPress={() => handleDelete(item)}
            className="ml-2 w-8 h-8 rounded-lg bg-red-50 items-center justify-center"
            activeOpacity={0.7}
          >
            <Text className="text-red-400 text-base font-bold">×</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    ),
    [canEdit, handleCheck, handleDelete]
  );

  return (
    <View className="flex-1 bg-slate-50">
      <StatusBar style="dark" />

      {/* ---- Header ---- */}
      <View className="bg-white pt-14 pb-3 px-5 border-b border-slate-100">
        <Text className="text-3xl font-bold text-brand-600 tracking-tight">
          Home
        </Text>
        <View className="flex-row items-center justify-between">
          <Text className="text-sm text-slate-400">Our Shopping List</Text>
          {/* Connection indicator */}
          <View className="flex-row items-center">
            <View
              className={`w-2 h-2 rounded-full mr-1.5 ${
                connected ? "bg-emerald-400" : "bg-red-400"
              }`}
            />
            <Text className="text-xs text-slate-400">
              {connected ? "Synced" : "Offline"}
            </Text>
          </View>
        </View>
      </View>

      {/* ---- Tab Bar ---- */}
      <View className="bg-white border-b border-slate-100">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 10 }}
        >
          {tabs.map((tab) => {
            const isActive = tab === activeTab;
            return (
              <TouchableOpacity
                key={tab}
                onPress={() => setActiveTab(tab)}
                className={`px-4 py-2 rounded-full mr-2 ${
                  isActive ? "bg-brand-600" : "bg-slate-100"
                }`}
                activeOpacity={0.7}
              >
                <Text
                  className={`text-sm font-medium ${
                    isActive ? "text-white" : "text-slate-500"
                  }`}
                >
                  {tab}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* ---- Item List ---- */}
      <FlatList
        data={filteredItems}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={{ paddingTop: 12, paddingBottom: 100 }}
        ListEmptyComponent={
          <View className="items-center mt-20">
            <Text className="text-5xl mb-3">🛒</Text>
            <Text className="text-slate-400 text-base">
              {canEdit
                ? "No items yet. Tap + to add one!"
                : `${activeTab}'s list is empty.`}
            </Text>
          </View>
        }
      />

      {/* ---- Floating Add Button (only if user can edit this list) ---- */}
      {canEdit ? (
        <TouchableOpacity
          onPress={() => setShowAddModal(true)}
          className="absolute bottom-8 right-6 w-14 h-14 rounded-full bg-brand-600 items-center justify-center"
          activeOpacity={0.8}
          style={{
            shadowColor: "#4F46E5",
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.3,
            shadowRadius: 8,
            elevation: 6,
          }}
        >
          <Text className="text-white text-3xl font-light" style={{ marginTop: -2 }}>
            +
          </Text>
        </TouchableOpacity>
      ) : null}

      {/* ---- Add Item Modal ---- */}
      <AddItemModal
        visible={showAddModal}
        onClose={() => setShowAddModal(false)}
        onAdd={handleAdd}
      />
    </View>
  );
}
