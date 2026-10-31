import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { preferences } from "../shared/settings.ts";
export function Settings({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const [draft, setDraft] = useState(undefined as string | undefined);
  return <View style={{ padding: layout.compact ? 12 : 20, gap: 12 }}>
    <Text style={{ color: theme.colors.foreground }}>本宿主 engram 地址（仅 loopback HTTP）</Text>
    <TextInput accessibilityLabel="engram 地址" value={draft ?? (settings.status === "ready" ? settings.values.baseUrl : "")} onChangeText={setDraft} autoCapitalize="none" style={{ color: theme.colors.foreground, borderColor: theme.colors.border, borderWidth: 1, padding: 8 }} />
    <Pressable accessibilityRole="button" disabled={settings.status !== "ready" || settings.saving} onPress={async () => {
      if (settings.status === "ready" && await settings.save({ ...settings.values, baseUrl: draft ?? settings.values.baseUrl }, settings.revision)) setDraft(undefined);
    }}><Text style={{ color: theme.colors.accent }}>保存本宿主设置</Text></Pressable>
    {settings.saveError ? <Text style={{ color: theme.colors.statusDanger }}>保存失败，请重新载入设置后重试</Text> : null}
    <Pressable accessibilityRole="button" onPress={() => void settings.reload()}><Text style={{ color: theme.colors.accent }}>重新载入设置</Text></Pressable>
  </View>;
}
