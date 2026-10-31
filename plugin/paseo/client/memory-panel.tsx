import { useRpc, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { rpc, type Enrollment, type Result } from "../shared/rpc.ts";
import { deletionWarning, memoryController, memoryRows, promptRows, scanAll, selectProject, type MemoryRow } from "../shared/memory.ts";

import {SyncActions} from "./sync-actions.tsx";
import type {WorkspaceSync} from "../shared/sync-model.ts";

type Tab = "search" | "recent" | "prompts";
export function MemoryPanel({ workspaceId, host, theme, layout, openStatus, openMemory, model }: PluginWorkspacePanelProps & {openStatus:()=>void;openMemory:()=>void;model:WorkspaceSync}) {
  const directory = useWorkspace(workspaceId, w => w.directory);
  const resolve = useRpc(rpc.resolve);
  const search = useRpc(rpc.search), recent = useRpc(rpc.recent), prompts = useRpc(rpc.prompts), scan = useRpc(rpc.scan), get = useRpc(rpc.get);
  const deleteMemory = useRpc(rpc.deleteMemory), deletePrompt = useRpc(rpc.deletePrompt);
  const [v2,setV2]=useState(false);
  const [blocked,setBlocked]=useState(false);
  const [project, setProject] = useState(""); const [choices, setChoices] = useState<string[]>([]);
  const [scope, setScope] = useState<Enrollment>(); const [tab, setTab] = useState<Tab>("recent");
  const [query, setQuery] = useState(""); const [onlySecrets, setOnlySecrets] = useState(false);
  const [rows, setRows] = useState<MemoryRow[]>([]); const [detail, setDetail] = useState("");
  const [confirmation, setConfirmation] = useState<{ row: MemoryRow; scope: Enrollment }>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const context = `${host.id}:${directory}:${project}`;
  const current = useRef(context); current.current = context;
  const sequence = useRef(0);
  const scopeOwner = useRef("");
  const controller = useMemo(() => memoryController({ deleteMemory, deletePrompt }), [deleteMemory, deletePrompt]);
  controller.bind(scopeOwner.current === context ? scope : undefined);
  useEffect(() => {
    let active = true; setProject(""); setChoices([]); setRows([]); setScope(undefined); setDetail(""); setConfirmation(undefined);setError("");
    if (directory) void resolve({ cwd: directory }).then(result => {
      if (!active) return;
      if (!result.ok) { setError(`${result.error.code}: ${result.error.message}`); return; }
      const selection = selectProject(result.data);setProject(selection.project);setChoices(selection.choices);
    }).catch(() => { if (active) setError("rpc_unavailable: 无法解析项目"); });
    return () => { active = false; };
  }, [directory, host.id, resolve]);
  useEffect(() => {
    const id = ++sequence.current;
    setScope(undefined);setRows([]);setConfirmation(undefined);setDetail("");
    if (!project) {setBusy(false);return;}
    setBusy(true);setError("");
    const load = async () => {
      const state = await model.project(project);
      if (id !== sequence.current) return;
      if (state.kind!=="ready") {setError(state.kind==="error"?`${state.error.code}: ${state.error.message}`:"项目状态不可用");return;}
      if (state.enrollment.project !== project) {setError("project_mismatch: 项目已变化");return;}
      scopeOwner.current = context;setScope(state.enrollment);setV2(state.v2);setBlocked(state.blocked);
      let result: Result<MemoryRow[]>;
      if (tab === "prompts" && onlySecrets) {
        const value = await scanAll(project, scan);
        result = value.ok ? { ok: true, data: value.data.items.map(row => ({ id: row.id, kind: "prompt", title: `${row.created_at} · ${row.session_id} · ${row.reason}`, text: row.masked_context })) } : value;
      } else if (tab === "prompts") {
        const value = await prompts({ project });result = value.ok ? { ok: true, data: promptRows(value.data) } : value;
      } else {
        const value = tab === "search" && query.trim() ? await search({ project, query: query.trim() }) : await recent({ project });
        result = value.ok ? { ok: true, data: memoryRows(value.data) } : value;
      }
      if (id !== sequence.current) return;
      if (result.ok) setRows(result.data);else setError(`${result.error.code}: ${result.error.message}`);
    };
    void load().catch(() => { if (id === sequence.current) setError("rpc_unavailable: 无法读取记忆"); }).finally(() => { if (id === sequence.current) setBusy(false); });
    return () => { sequence.current++; };
    // Search is explicit through refresh; typing must not dispatch requests.
  }, [project, host.id, directory, tab, onlySecrets, refresh, model, prompts, scan, search, recent]);
  useEffect(()=>model.subscribe(()=>{
    if(!project)return;
    const snapshot=model.projectSnapshot(project);
    if(snapshot?.kind==="ready" && snapshot.enrollment.project===project){setScope(snapshot.enrollment);setV2(snapshot.v2);setBlocked(snapshot.blocked);}
  }),[model,workspaceId,project]);
  const c = theme.colors;
  const button = (label: string, action: () => void, disabled = busy) => <Pressable key={label} accessibilityRole="button" disabled={disabled} onPress={action} style={{ padding: 8, opacity: disabled ? 0.5 : 1 }}><Text style={{ color: c.accent }}>{label}</Text></Pressable>;
  return <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: layout.compact ? 12 : 24, gap: 12 }}>
    <Text style={{ color: c.foreground, fontSize: 20 }}>{project || "选择项目"} @ {host.label}</Text>
    {choices.map(choice => button(choice, () => {setProject(choice);model.select(workspaceId,choice);}))}
    <Text style={{ color: c.foregroundMuted }}>{scope ? scope.enrolled ? "本机已加入同步" : "本机尚未加入同步" : "正在确定加入状态"}</Text>
    {scope && scopeOwner.current===context?<SyncActions key={`${host.id}:${scope.instance_id}:${scope.project}`} model={model} enrollment={scope} v2={v2} blocked={blocked} theme={theme} layout={layout} host={host} openMemory={openMemory} openStatus={openStatus}/>:null}
    <View style={{ flexDirection: layout.compact ? "column" : "row", gap: 8 }}>
      {button("搜索", () => setTab("search"))}{button("最近记忆", () => setTab("recent"))}{button("最近 prompt", () => setTab("prompts"))}
    </View>
    {tab === "search" && <View>
      <TextInput accessibilityLabel="搜索记忆" value={query} onChangeText={setQuery} style={{ color: c.foreground, borderColor: c.border, borderWidth: 1, padding: 8 }} />
      {button("执行搜索", () => setRefresh(value => value + 1))}
    </View>}
    {tab === "prompts" && button(onlySecrets ? "显示全部 prompt" : "只看疑似含密码", () => setOnlySecrets(value => !value))}
    {error ? <Text style={{ color: c.statusDanger }}>{error}</Text> : null}
    {busy ? <Text style={{ color: c.foregroundMuted }}>正在处理…</Text> : null}
    {!busy && !rows.length ? <Text style={{ color: c.foregroundMuted }}>没有记录</Text> : null}
    {rows.map(row => <View key={`${row.kind}:${row.id}`} style={{ padding: 12, borderWidth: 1, borderColor: c.border, gap: 6 }}>
      <Text style={{ color: c.foreground }}>{row.title}</Text><Text style={{ color: c.foregroundMuted }}>{row.text}</Text>
      {row.kind === "memory" && button(`查看 #${row.id}`, () => {
        const origin = current.current;setBusy(true);
        void get({ project, id: row.id }).then(value => { if (origin !== current.current) return;if (value.ok) setDetail(value.data.content ?? "");else setError(`${value.error.code}: ${value.error.message}`); }).catch(() => { if (origin === current.current) setError("rpc_unavailable: 查看失败"); }).finally(() => { if (origin === current.current) setBusy(false); });
      })}
      {button(`删除 #${row.id}`, () => { if (scope) setConfirmation({ row, scope }); }, busy || !scope)}
    </View>)}
    {detail ? <Text style={{ color: c.foreground }}>{detail}</Text> : null}
    {confirmation && <View style={{ borderWidth: 1, borderColor: c.statusWarning, padding: 12 }}>
      <Text style={{ color: c.foreground }}>{deletionWarning(confirmation.scope.enrolled)}</Text>
      {button("确认删除", () => {
        const origin = current.current;setBusy(true);setError("");
        void controller.remove(confirmation.row, confirmation.scope).then(value => {if (origin !== current.current) return;if (value.ok) {setConfirmation(undefined);setRefresh(v => v + 1);}else setError(`${value.error.code}: ${value.error.message}`);}).catch(() => { if (origin === current.current) setError("rpc_unavailable: 删除结果待确认，请重新载入"); }).finally(() => {if (origin === current.current) setBusy(false);});
      })}
      {button("取消", () => setConfirmation(undefined))}
    </View>}
  </ScrollView>;
}
