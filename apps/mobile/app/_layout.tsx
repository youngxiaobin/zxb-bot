import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

export default function Layout() {
  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerTitle: "zxb bot",
          headerTintColor: "#1c1c1e",
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen name="index" options={{ title: "zxb bot" }} />
        <Stack.Screen
          name="chat/[id]"
          options={{ title: "对话", headerShown: false }}
        />
        <Stack.Screen name="approvals" options={{ title: "审批" }} />
        <Stack.Screen name="settings" options={{ title: "连接设置" }} />
      </Stack>
    </>
  );
}
