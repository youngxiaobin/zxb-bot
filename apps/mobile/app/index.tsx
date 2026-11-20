import { useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import { markdownToPlain } from "@pa/sdk";
import { getClient, useProjection } from "../src/agent";
import { SettingsSheet } from "../src/SettingsSheet";

const PRESETS = [
  {
    id: "fixture_research",
    name: "资料研究员",
    letter: "资",
    color: "#2f9e8f",
    hint: "预设 · 只在一次委托里运行",
  },
  {
    id: "outline_planner",
    name: "提纲规划",
    letter: "纲",
    color: "#e2a15a",
    hint: "预设 · 只在一次委托里运行",
  },
];

export default function SessionsScreen() {
  const projection = useProjection();
  const [search, setSearch] = useState("");
  const [settings, setSettings] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const query = search.trim().toLowerCase();
  const connected = projection.connection === "live";
  const sessions = projection.sessions.filter((session) => {
    const preview = previewOf(projection.messages[session.id]);
    return (
      !query ||
      session.title.toLowerCase().includes(query) ||
      preview.toLowerCase().includes(query)
    );
  });

  async function createSession(): Promise<void> {
    const client = getClient();
    if (!client || !connected) return;
    setNotice(null);
    try {
      const opened = await client.openSession("新的委托");
      const sessionId = String(
        (opened.result as { sessionId: string }).sessionId,
      );
      await client.resync();
      router.push(`/chat/${sessionId}`);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "无法创建会话");
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.brand}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>z</Text>
        </View>
        <Text style={styles.name}>zxb bot</Text>
      </View>
      <View style={styles.tools}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="搜索"
          accessibilityLabel="搜索会话"
          style={styles.search}
        />
        <Pressable
          accessibilityLabel="新会话"
          disabled={!connected}
          onPress={() => void createSession()}
          style={styles.plus}
        >
          <Text>+</Text>
        </Pressable>
      </View>
      {!connected ? (
        <Text style={styles.muted}>连接后才能新建会话。</Text>
      ) : null}
      {notice ? <Text style={styles.error}>{notice}</Text> : null}
      <ScrollView contentContainerStyle={styles.list}>
        {sessions.length === 0 ? (
          <Text style={styles.muted}>没有匹配的会话。</Text>
        ) : null}
        {sessions.map((session) => (
          <Pressable
            key={session.id}
            style={styles.row}
            onPress={() => router.push(`/chat/${session.id}`)}
          >
            <View style={styles.small}>
              <Text style={styles.smallText}>z</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text>{session.title}</Text>
              <Text style={styles.muted} numberOfLines={1}>
                {previewOf(projection.messages[session.id]) || "zxb bot"}
              </Text>
            </View>
          </Pressable>
        ))}
        <Text style={styles.section}>预设专员</Text>
        {PRESETS.filter((item) => !query || item.name.includes(query)).map(
          (item) => (
            <Pressable
              key={item.id}
              style={styles.row}
              onPress={() => router.push(`/chat/preset-${item.id}`)}
            >
              <View style={[styles.small, { backgroundColor: item.color }]}>
                <Text style={styles.smallText}>{item.letter}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text>{item.name}</Text>
                <Text style={styles.muted} numberOfLines={1}>
                  {item.hint}
                </Text>
              </View>
            </Pressable>
          ),
        )}
      </ScrollView>
      <Pressable
        style={styles.me}
        accessibilityLabel="打开连接设置"
        onPress={() => setSettings(true)}
      >
        <View style={styles.user}>
          <Text style={styles.smallText}>我</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text>我的</Text>
          <Text style={styles.muted}>{connected ? "已连接" : "未连接"}</Text>
        </View>
        <View style={[styles.dot, connected ? styles.dotOn : null]} />
      </Pressable>
      <SettingsSheet open={settings} onClose={() => setSettings(false)} />
    </View>
  );
}

function previewOf(messages: { content: string }[] | undefined): string {
  const last = messages?.[messages.length - 1];
  return last ? markdownToPlain(last.content) : "";
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f2f2f4", padding: 16 },
  brand: { alignItems: "center", gap: 8, paddingVertical: 12 },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 22,
    backgroundColor: "#1c1c1e",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "white", fontSize: 28, fontWeight: "700" },
  name: { fontWeight: "700" },
  tools: { flexDirection: "row", gap: 8, alignItems: "center" },
  search: {
    flex: 1,
    backgroundColor: "#e6e6e8",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  plus: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  list: { gap: 8, paddingVertical: 12 },
  row: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    paddingVertical: 6,
  },
  small: {
    width: 28,
    height: 28,
    borderRadius: 10,
    backgroundColor: "#1c1c1e",
    alignItems: "center",
    justifyContent: "center",
  },
  smallText: { color: "white", fontSize: 12, fontWeight: "700" },
  user: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#8d8d92",
    alignItems: "center",
    justifyContent: "center",
  },
  muted: { color: "#8e8e93", fontSize: 12 },
  section: { color: "#8e8e93", fontSize: 11, marginTop: 12 },
  me: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#c7c7cc" },
  dotOn: { backgroundColor: "#34c759" },
  error: { color: "#7a2e22" },
});
