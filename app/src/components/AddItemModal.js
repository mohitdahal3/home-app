import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  KeyboardAvoidingView,
  Platform,
} from "react-native";

/**
 * A simple modal for adding a new grocery item.
 * Wrapped in KeyboardAvoidingView so the keyboard never covers the input.
 */
export default function AddItemModal({ visible, onClose, onAdd }) {
  const [text, setText] = useState("");

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setText("");
    onClose();
  };

  const handleCancel = () => {
    setText("");
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleCancel}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        className="flex-1"
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={handleCancel}
          className="flex-1 bg-black/40 justify-center items-center px-8"
        >
          {/* Stop inner taps from closing the modal */}
          <TouchableOpacity
            activeOpacity={1}
            onPress={() => {}}
            className="w-full bg-white rounded-2xl p-6"
          >
            <Text className="text-lg font-semibold text-slate-800 mb-4">
              Add Item
            </Text>

            <TextInput
              className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-base text-slate-800"
              placeholder="e.g. Milk, Eggs, Bread..."
              placeholderTextColor="#94A3B8"
              value={text}
              onChangeText={setText}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleSubmit}
            />

            <View className="flex-row mt-5 gap-3">
              <TouchableOpacity
                onPress={handleCancel}
                className="flex-1 py-3 rounded-xl bg-slate-100 items-center"
                activeOpacity={0.7}
              >
                <Text className="text-slate-600 font-medium">Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleSubmit}
                className="flex-1 py-3 rounded-xl bg-brand-600 items-center"
                activeOpacity={0.8}
              >
                <Text className="text-white font-semibold">Add</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}
