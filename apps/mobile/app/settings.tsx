import { useState } from "react";
import { View } from "react-native";
import { SettingsSheet } from "../src/SettingsSheet";

export default function SettingsScreen() {
  const [open, setOpen] = useState(true);
  return (
    <View style={{ flex: 1, backgroundColor: "#f2f2f4" }}>
      <SettingsSheet open={open} onClose={() => setOpen(false)} />
    </View>
  );
}
