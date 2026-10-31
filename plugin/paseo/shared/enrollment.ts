import type { Enrollment, Result, Scan } from "./rpc.ts";
import { scanAll } from "./memory.ts";
export type EnrollState = { phase: "prompt" | "scanning" | "review" | "joining" | "pending_confirm" | "joined" | "error"; items: Scan["items"]; message: string };
export type EnrollmentAPI = {
  scan(args: {project: string; cursor?: string}): Promise<Result<Scan>>;
  join(args: {project: string; instance_id: string; scan_token?: string; force?: boolean}): Promise<Result<Enrollment>>;
  status(args: {project: string}): Promise<Result<Enrollment>>;
  deletePrompt(args: {project: string; instance_id: string; id: number}): Promise<Result<{status: "deleted"}>>;
};
export function enrollmentFlow(binding: {project: string; instance_id: string}, api: EnrollmentAPI, changed: (state: EnrollState) => void) {
  let state: EnrollState = { phase: "prompt", items: [], message: "" };
  let active = true, busy = false;
  const update = (patch: Partial<EnrollState>) => { if (active) { state = { ...state, ...patch }; changed(state); } };
  const error = (value: {code: string; message: string}) => update({phase:"error",message:`${value.code}: ${value.message}`});
  const run = async (action: () => Promise<void>) => {
    if (!active || busy) return;busy = true;
    try { await action(); } catch { if (state.phase === "joining") update({phase:"pending_confirm",message:"rpc_unavailable: 写入结果待确认"});else error({code:"rpc_unavailable",message:"请求失败，请重新尝试"}); }
    finally { busy = false; }
  };
  const confirm = async (pending: boolean) => {
    let result: Result<Enrollment>;
    try { result = await api.status({project:binding.project}); }
    catch { if (pending) update({phase:"pending_confirm",message:"rpc_unavailable: 结果仍待确认"});else error({code:"rpc_unavailable",message:"无法读取加入状态"});return; }
    if (!active) return;
    if (!result.ok) {if (pending) update({phase:"pending_confirm",message:`${result.error.code}: 结果仍待确认`});else error(result.error);return;}
    if (result.data.instance_id !== binding.instance_id || result.data.project !== binding.project) {error({code:"instance_mismatch",message:"项目或数据库实例已变化，请重新载入"});return;}
    update(result.data.enrolled ? {phase:"joined",items:[],message:"本机已加入，等待同步"} : pending ? {phase:"pending_confirm",message:"尚未确认加入；请稍后重新确认，不会自动重发"} : {phase:"prompt",message:""});
  };
  const scan = async (): Promise<Scan | undefined> => {
    update({phase:"scanning"});const result = await scanAll(binding.project,api.scan);if (!active) return;
    if (!result.ok) {error(result.error);return;}
    update({items:result.data.items});return result.data;
  };
  const join = async (token?: string, force = false) => {
    update({phase:"joining",message:""});
    let result: Result<Enrollment>;
    try { result = await api.join({...binding,...(force ? {force:true} : {scan_token:token})}); }
    catch {update({phase:"pending_confirm",message:"rpc_unavailable: 写入结果待确认"});await confirm(true);return;}
    if (!active) return;
    if (result.ok) {
      if (result.data.instance_id !== binding.instance_id || result.data.project !== binding.project) {error({code:"instance_mismatch",message:"项目或数据库实例已变化"});return;}
      if (!result.data.enrolled) {error({code:"enrollment_unconfirmed",message:"服务未确认加入状态"});return;}
      update({phase:"joined",items:[],message:"本机已加入，等待同步"});return;
    }
    if (result.error.kind === "outcome_unknown") {update({phase:"pending_confirm",message:result.error.message});await confirm(true);return;}
    if (result.error.code === "scan_stale") {
      update({message:"scan_stale: 扫描之后又有新的 prompt，请重新确认"});
      const fresh = await scan();if (fresh) update({phase:"review",message:"scan_stale: 已重新扫描，请重新确认是否加入"});return;
    }
    error(result.error);
  };
  return {
    get state() {return state;},
    initialize: () => run(async()=>{update({phase:"scanning"});await confirm(false);}),
    begin: (joinWithFindings = false) => run(async()=>{const found=await scan();if (!found) return;if (!found.items.length || joinWithFindings) await join(found.scan_token);else update({phase:"review",message:""});}),
    force: () => run(async()=>{if(state.phase==="review")await join(undefined,true);}),
    confirm: () => run(async()=>{update({phase:"scanning"});await confirm(true);}),
    remove: (id: number) => run(async()=>{
      if (state.phase!=="review")return;
      update({phase:"scanning"});
      const result=await api.deletePrompt({...binding,id});if(!active)return;
      if(!result.ok){error(result.error);return;}
      const fresh=await scan();if(fresh)update({phase:"review",message:"已删除，请重新扫描后加入或选择仍然加入"});
    }),
    cancel() {if (!busy)update({phase:"prompt",items:[],message:""});},
    dispose() {active=false;},
  };
}

export type EnrollmentFlow = ReturnType<typeof enrollmentFlow>;
