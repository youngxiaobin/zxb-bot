import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { getClient, useProjection } from "../src/agent";

export default function ApprovalsScreen() {
  const projection = useProjection();
  const [error, setError] = useState<string | null>(null);
  const ready = projection.sensitiveReady;

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
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text>审批只显示工具、目标和参数。拒绝不会写入文件。</Text>
      {error ? <Text style={{ color: "#7a2e22" }}>{error}</Text> : null}
      {projection.approvals.length === 0 ? <Text>没有待处理审批。</Text> : null}
      {projection.approvals.map((approval) => {
        const ended = !ready || approval.status !== "pending";
        return (
          <View
            key={approval.id}
            style={{
              padding: 12,
              borderWidth: 1,
              borderColor: "#ececef",
              borderRadius: 14,
              gap: 6,
            }}
          >
            <Text>{approval.toolName}</Text>
            <Text>目标 {approval.resource}</Text>
            <Text>
              {approval.status} · 版本 {approval.version}
            </Text>
            <Text>{JSON.stringify(approval.params)}</Text>
            <Pressable
              disabled={ended}
              onPress={() =>
                void decide(
                  approval.id,
                  "approve",
                  approval.version,
                  approval.paramsHash,
                )
              }
            >
              <Text style={{ color: ended ? "#8e8e93" : "#1c1c1e" }}>
                批准{ended ? "（这项审批已经结束或当前离线）" : ""}
              </Text>
            </Pressable>
            <Pressable
              disabled={ended}
              onPress={() =>
                void decide(
                  approval.id,
                  "reject",
                  approval.version,
                  approval.paramsHash,
                )
              }
            >
              <Text style={{ color: ended ? "#8e8e93" : "#9a3b2f" }}>
                拒绝{ended ? "（这项审批已经结束或当前离线）" : ""}
              </Text>
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}
