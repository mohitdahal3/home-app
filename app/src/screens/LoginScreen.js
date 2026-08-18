import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { StatusBar } from "expo-status-bar";

import * as ws from "../services/websocket";

/**
 * Login Screen
 *
 * Layout from CLAUDE.md:
 *   Header:    "Home"
 *   Subheader: "Our Shopping list"
 *   Text:      "For 737 Bryson #522"
 *   Input:     "Login Code:"
 *   Button:    "Login"
 */
export default function LoginScreen({ onLoginSuccess }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = () => {
    const trimmed = code.trim();
    if (!trimmed) {
      setError("Please enter your login code.");
      return;
    }

    setError("");
    setLoading(true);

    // Set up a one-time message handler for the auth response.
    ws.setMessageHandler((msg) => {
      if (msg.type === "AUTH_OK") {
        setLoading(false);
        onLoginSuccess(msg.username, trimmed, msg.users || []);
      } else if (msg.type === "AUTH_FAIL") {
        setLoading(false);
        setError(msg.message || "Invalid login code.");
      }
    });

    // Connect and authenticate.
    ws.setStatusHandler((connected) => {
      if (connected) {
        ws.sendMessage({ type: "AUTH", passcode: trimmed });
      }
    });

    ws.connect();

    // Timeout if server is unreachable.
    setTimeout(() => {
      if (loading) {
        setLoading(false);
        setError("Could not reach the server. Try again later.");
      }
    }, 10000);
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      className="flex-1 bg-white"
    >
      <StatusBar style="dark" />

      <View className="flex-1 justify-center items-center px-10">
        {/* ---- Branding ---- */}
        <Text className="text-6xl font-bold text-brand-600 mb-1 tracking-tight">
          Home
        </Text>
        <Text className="text-lg text-slate-500 mb-1">
          Our Shopping List
        </Text>
        <Text className="text-sm text-slate-400 mb-12">
          For 737 Bryson #522
        </Text>

        {/* ---- Login Form ---- */}
        <View className="w-full max-w-xs">
          <Text className="text-sm font-medium text-slate-600 mb-2 ml-1">
            Login Code:
          </Text>
          <TextInput
            className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3.5 text-base text-slate-800"
            placeholder="Enter your code"
            placeholderTextColor="#94A3B8"
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            autoFocus
            editable={!loading}
          />

          {error ? (
            <Text className="text-red-500 text-sm mt-2 ml-1">{error}</Text>
          ) : null}

          <TouchableOpacity
            className={`w-full mt-5 rounded-xl py-3.5 items-center ${
              loading ? "bg-brand-300" : "bg-brand-600"
            }`}
            onPress={handleLogin}
            disabled={loading}
            activeOpacity={0.8}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text className="text-white text-base font-semibold">
                Login
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
