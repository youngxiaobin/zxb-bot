import { useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  connectWithPair,
  connectWithToken,
  disconnectGateway,
  useProjection,
} from "./agent";

const connectionCopy = {
  idle: "未连接",
  connecting: "正在连接",
  live: "已连接",
  reconnecting: "正在重连",
  offline: "离线",
  unauthorized: "未授权",
} as const;

export function SettingsSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const projection = useProjection();
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:47471");
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tokenTaken = useRef("");

  async function saveToken(): Promise<void> {
    const current = token;
    tokenTaken.current = current;
    setToken("");
    setBusy(true);
    setError(null);
    try {
      if (current.trim().length < 8) {
        setError("请填写设备令牌，或展开本机配对。");
        return;
      }
      await connectWithToken(baseUrl, current);
      tokenTaken.current = "";
      onClose();
    } catch (cause) {
      tokenTaken.current = "";
      setError(cause instanceof Error ? cause.message : "连接失败");
    } finally {
      setBusy(false);
    }
  }

  async function pair(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await connectWithPair(baseUrl, code);
      setCode("");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "配对失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      visible={open}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.modal}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.head}>
              <View style={styles.me}>
                <Text style={styles.meText}>我</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>我的</Text>
                <Text style={styles.muted}>
                  {connectionCopy[projection.connection]}
                </Text>
              </View>
              <Pressable onPress={onClose} accessibilityLabel="关闭">
                <Text>×</Text>
              </Pressable>
            </View>
            <Text style={styles.heading}>连接设置</Text>
            <Text style={styles.muted}>Gateway 地址</Text>
            <TextInput
              value={baseUrl}
              onChangeText={setBaseUrl}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Gateway 地址"
              style={styles.input}
            />
            <Text style={styles.muted}>设备令牌</Text>
            <TextInput
              value={token}
              onChangeText={setToken}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="设备令牌"
              style={styles.input}
            />
            <Pressable
              style={styles.primary}
              disabled={busy}
              onPress={() => void saveToken()}
            >
              <Text style={styles.primaryText} numberOfLines={1}>
                保存并重新连接
              </Text>
            </Pressable>
            <Pressable
              style={styles.secondary}
              disabled={projection.connection !== "live" || busy}
              onPress={() =>
                void disconnectGateway().then(() =>
                  setError("已断开。令牌已从安全存储清除。"),
                )
              }
            >
              <Text style={styles.center}>断开连接</Text>
            </Pressable>
            <Pressable onPress={() => setPairing((value) => !value)}>
              <Text style={styles.center}>
                {pairing ? "收起本机配对" : "本机配对"}
              </Text>
            </Pressable>
            {pairing ? (
              <>
                <Text style={styles.muted}>
                  手机不能在网关上签发配对码。请在运行网关的电脑上执行
                  pairing-code，再把一次性配对码填到这里。
                </Text>
                <TextInput
                  value={code}
                  onChangeText={setCode}
                  autoCapitalize="characters"
                  accessibilityLabel="一次性配对码"
                  style={styles.input}
                />
                <Pressable
                  style={styles.primary}
                  disabled={busy || !code.trim()}
                  onPress={() => void pair()}
                >
                  <Text style={styles.primaryText}>配对并连接</Text>
                </Pressable>
              </>
            ) : null}
            <Text style={styles.muted}>
              令牌写入本机已有的安全存储，不会出现在界面日志里。回到前台时会重新加载快照。
            </Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modal: { flex: 1, justifyContent: "flex-end" },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.2)",
  },
  sheet: {
    backgroundColor: "white",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    maxHeight: "78%",
  },
  content: { padding: 16, gap: 8 },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  me: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#8d8d92",
    alignItems: "center",
    justifyContent: "center",
  },
  meText: { color: "white", fontWeight: "700" },
  title: { fontWeight: "700" },
  heading: { fontSize: 16, fontWeight: "700", marginTop: 8 },
  muted: { color: "#8e8e93", fontSize: 12 },
  input: {
    borderWidth: 1,
    borderColor: "#e6e6e8",
    borderRadius: 10,
    padding: 10,
  },
  primary: { backgroundColor: "#1c1c1e", borderRadius: 999, padding: 12 },
  primaryText: { color: "white", textAlign: "center" },
  secondary: { backgroundColor: "#f2f2f4", borderRadius: 999, padding: 12 },
  center: { textAlign: "center" },
  error: { color: "#7a2e22" },
});
