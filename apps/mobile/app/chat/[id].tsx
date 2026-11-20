import { useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { getClient, useProjection } from "../../src/agent";
import { MarkdownText } from "../../src/text";
import { SettingsSheet } from "../../src/SettingsSheet";

const PRESET_COPY: Record<string, string> = {
  "preset-fixture_research":
    "资料研究员是预设专员，只在 zxb bot 的一次委托里运行，不能单独发送消息。",
  "preset-outline_planner":
    "提纲规划是预设专员，只在 zxb bot 的一次委托里运行，不能单独发送消息。",
};

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const projection = useProjection();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const sessionId = String(id ?? "");
  const presetCopy = PRESET_COPY[sessionId];
  const messages = projection.messages[sessionId] ?? [];
  const ready = projection.sensitiveReady;
  const run = Object.values(projection.runs).find(
    (item) => item.sessionId === sessionId && item.kind === "root",
  );
  const tools = Object.values(projection.tools).filter(
    (tool) => tool.rootRunId === run?.id || tool.runId === run?.id,
  );
  const approvals = projection.approvals.filter(
    (item) => item.sessionId === sessionId,
  );
  const sendReason = presetCopy
    ? "预设专员不能单独接收消息"
    : !ready
      ? "连接后才能发送"
      : !text.trim()
        ? "请先输入内容"
        : "";

  async function send(): Promise<void> {
    const client = getClient();
    if (!client || sendReason) return;
    setError(null);
    try {
      await client.submit({ sessionId, text, providerMode: mode });
      setText("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发送失败");
    }
  }

  async function decide(
    approvalId: string,
    decision: "approve" | "reject",
    version: number,
    paramsHash: string,
  ) {
    const client = getClient();
    if (!client || !ready) {
      setError("离线时不能审批，请求不会排队。");
      return;
    }
    try {
      await client.decide({
        approvalId,
        decision,
        expectedVersion: version,
        paramsHash,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "审批失败");
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.top}>
        <Pressable accessibilityLabel="返回" onPress={() => router.back()}>
          <Text>返回</Text>
        </Pressable>
        <View style={styles.capsule}>
          <Text style={styles.z}>z</Text>
          <Text>
            {" "}
            zxb bot · {mode === "demo" ? "演示 · 不是大模型" : "实况"}
          </Text>
        </View>
        <Pressable
          accessibilityLabel="打开连接设置"
          onPress={() => setSettings(true)}
        >
          <Text>我</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.transcript}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {presetCopy ? <Text style={styles.card}>{presetCopy}</Text> : null}
        {!presetCopy && messages.length === 0 ? (
          <Text style={styles.muted}>这个会话还没有可见消息。</Text>
        ) : null}
        {messages.map((message) => (
          <View key={message.id} style={styles.bubble}>
            <MarkdownText source={message.content} />
          </View>
        ))}
        {run && projection.ephemeralByRun[run.id] ? (
          <Text>预览，尚未入库：{projection.ephemeralByRun[run.id]}</Text>
        ) : null}
        {tools.map((tool) => (
          <Text key={tool.id} style={styles.card}>
            {tool.toolName} · {tool.resource} · {tool.status}
          </Text>
        ))}
        {approvals.map((approval) => (
          <View key={approval.id} style={styles.card}>
            <Text>{approval.toolName}</Text>
            <Text style={styles.muted}>
              {approval.status} · 版本 {approval.version}
            </Text>
            <Text>目标 {approval.resource}</Text>
            {detailId === approval.id ? (
              <Text>{JSON.stringify(approval.params)}</Text>
            ) : null}
            <Pressable
              disabled={!ready || approval.status !== "pending"}
              onPress={() =>
                void decide(
                  approval.id,
                  "approve",
                  approval.version,
                  approval.paramsHash,
                )
              }
            >
              <Text>批准</Text>
            </Pressable>
            <Pressable
              disabled={!ready || approval.status !== "pending"}
              onPress={() =>
                void decide(
                  approval.id,
                  "reject",
                  approval.version,
                  approval.paramsHash,
                )
              }
            >
              <Text>拒绝</Text>
            </Pressable>
            <Pressable
              onPress={() =>
                setDetailId(detailId === approval.id ? null : approval.id)
              }
            >
              <Text>{detailId === approval.id ? "收起详情" : "审批详情"}</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
      {menu ? (
        <View style={styles.menu}>
          <Pressable
            onPress={() => {
              setMode("demo");
              setMenu(false);
            }}
          >
            <Text>演示（确定性脚本，不是大模型）</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setMode("live");
              setMenu(false);
            }}
          >
            <Text>实况（使用网关上的供应商配置）</Text>
          </Pressable>
          <Pressable
            disabled={!ready || !run}
            onPress={() => {
              setMenu(false);
              const client = getClient();
              if (!client || !run) return;
              void client.cancel(run.id);
            }}
          >
            <Text>
              取消当前运行
              {!ready || !run ? "（没有可取消的运行，或当前离线）" : ""}
            </Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.composer}>
        <Pressable
          accessibilityLabel="更多操作"
          onPress={() => setMenu((open) => !open)}
        >
          <Text>+</Text>
        </Pressable>
        <TextInput
          value={text}
          onChangeText={setText}
          editable={!presetCopy}
          placeholder="输入你的回答，或聊点别的"
          accessibilityLabel="委托内容"
          style={styles.input}
        />
        <Pressable
          accessibilityLabel="发送"
          disabled={Boolean(sendReason)}
          onPress={() => void send()}
          style={styles.send}
        >
          <Text style={{ color: "white" }}>发送</Text>
        </Pressable>
      </View>
      {sendReason ? <Text style={styles.muted}>{sendReason}</Text> : null}
      <SettingsSheet open={settings} onClose={() => setSettings(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "white" },
  top: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 12,
  },
  capsule: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#ececef",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  z: {
    backgroundColor: "#1c1c1e",
    color: "white",
    overflow: "hidden",
    borderRadius: 8,
    paddingHorizontal: 5,
  },
  transcript: { padding: 16, gap: 10 },
  bubble: { backgroundColor: "#f4f4f5", borderRadius: 16, padding: 12 },
  card: {
    borderWidth: 1,
    borderColor: "#ececef",
    borderRadius: 14,
    padding: 10,
  },
  muted: { color: "#8e8e93", fontSize: 12, paddingHorizontal: 16 },
  error: { color: "#7a2e22" },
  menu: {
    marginHorizontal: 16,
    padding: 8,
    borderWidth: 1,
    borderColor: "#ececef",
    borderRadius: 12,
    gap: 8,
  },
  composer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    margin: 12,
    borderWidth: 1,
    borderColor: "#e6e6e8",
    borderRadius: 24,
    padding: 8,
  },
  input: { flex: 1 },
  send: {
    backgroundColor: "#1c1c1e",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
});
