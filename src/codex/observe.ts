import { statePaths } from "../paths.ts";
import { readPool, type ManagedAccount } from "../accounts/store.ts";
import { record } from "../accounts/storage.ts";
import { refreshUsage } from "../accounts/usage.ts";
import { activeCounts, readLeases } from "../service/leases.ts";
import { CODEX_OBSERVATION_SCHEMA_VERSION, type CodexAccountView, type CodexLane, type CodexLaneWindow, type CodexObservation, type CodexWindowRole, MAIN_LANE_ID, SPARK_LANE_ID, laneHeadroomPercent } from "./types.ts";

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

interface WireWindow {
  kind: CodexWindowRole;
  label: string;
  windowSeconds: number | null;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  resetAfterSeconds: number | null;
  limitName: string | null;
  meteredFeature: string | null;
}

function parseWireWindow(value: unknown): WireWindow | null {
  if (typeof value !== "object" || value === null) return null;
  const window = value as Record<string, unknown>;
  const kind = window.kind;
  if (kind !== "primary" && kind !== "secondary" && kind !== "code_review" && kind !== "other") return null;
  const usedPercent = finiteOrNull(window.usedPercent);
  const remainingPercent = finiteOrNull(window.remainingPercent);
  if (usedPercent === null || remainingPercent === null) return null;
  return {
    kind,
    label: stringOrNull(window.label) ?? "window",
    windowSeconds: finiteOrNull(window.windowSeconds),
    usedPercent,
    remainingPercent,
    resetsAt: stringOrNull(window.resetsAt),
    resetAfterSeconds: finiteOrNull(window.resetAfterSeconds),
    limitName: stringOrNull(window.limitName),
    meteredFeature: stringOrNull(window.meteredFeature),
  };
}

function toLaneWindow(window: WireWindow): CodexLaneWindow {
  return {
    role: window.kind,
    label: window.label,
    windowSeconds: window.windowSeconds,
    usedPercent: window.usedPercent,
    remainingPercent: window.remainingPercent,
    resetsAt: window.resetsAt,
    resetAfterSeconds: window.resetAfterSeconds,
    limitName: window.limitName,
    meteredFeature: window.meteredFeature,
  };
}

/**
 * Groups measurement windows into lanes. Identity comes from the lane fields
 * the provider reports; spark detection is the CodexBar
 * convention (lowercased substring "spark") so label drift keeps matching.
 */
export function groupLanes(windows: readonly unknown[]): CodexLane[] {
  const main: CodexLaneWindow[] = [];
  const codeReview: CodexLaneWindow[] = [];
  const labeled = new Map<string, { title: string; windows: CodexLaneWindow[] }>();
  const unlabeled: CodexLaneWindow[] = [];

  for (const candidate of windows) {
    const wire = parseWireWindow(candidate);
    if (wire === null) continue;
    const window = toLaneWindow(wire);
    if (wire.kind === "primary" || wire.kind === "secondary") {
      main.push(window);
      continue;
    }
    if (wire.kind === "code_review") {
      codeReview.push(window);
      continue;
    }
    const identity = wire.limitName ?? wire.meteredFeature;
    if (identity === null) {
      unlabeled.push(window);
      continue;
    }
    const laneId = identity.toLowerCase().includes("spark") ? SPARK_LANE_ID : `codex-${slug(identity)}`;
    const title = wire.limitName ?? wire.meteredFeature ?? "Additional";
    const lane = labeled.get(laneId) ?? { title, windows: [] };
    lane.windows.push(window);
    labeled.set(laneId, lane);
  }

  const lanes: CodexLane[] = [];
  if (main.length > 0) lanes.push({ id: MAIN_LANE_ID, title: "Main", binding: true, windows: main });
  for (const [id, lane] of labeled) {
    lanes.push({ id, title: lane.title, binding: false, windows: lane.windows });
  }
  if (codeReview.length > 0) lanes.push({ id: "code-review", title: "Code Review", binding: false, windows: codeReview });
  if (unlabeled.length > 0) lanes.push({ id: "codex-extra", title: "Additional", binding: false, windows: unlabeled });
  return lanes;
}


export function parseCodexUsage(value:unknown,measuredAtMs:number):{lanes:CodexLane[];planType:string|null;limitReached:boolean|null;resetCreditsAvailable:number|null;resetCreditExpirations?:Array<string|null>}{
 const raw=record(value)??{};
 const windows:unknown[]=[];
 const append=(input:unknown,kind:CodexWindowRole,lane?:Record<string,unknown>)=>{
  const w=record(input);if(!w||typeof w.used_percent!=='number'||!Number.isFinite(w.used_percent)||w.used_percent<0)return;
  const seconds=finiteOrNull(w.limit_window_seconds);
  const after=finiteOrNull(w.reset_after_seconds);
  let resetMs=typeof w.reset_at==='number'?w.reset_at*1000:null;
  if(resetMs===null||!Number.isFinite(resetMs)||resetMs<=0||resetMs>measuredAtMs+2*365*86400_000)resetMs=after!==null&&after>=0&&after<2*365*86400?measuredAtMs+after*1000:null;
  windows.push({kind,label:seconds===18000?'5h':seconds===604800?'weekly':seconds===86400?'daily':seconds?`${seconds}s`:'window',windowSeconds:seconds,usedPercent:w.used_percent,remainingPercent:Math.max(0,100-w.used_percent),resetsAt:resetMs===null?null:new Date(resetMs).toISOString(),resetAfterSeconds:after,limitName:lane?.limit_name,meteredFeature:lane?.metered_feature});
 };
 const main=record(raw.rate_limit);
 append(main?.primary_window,'primary');append(main?.secondary_window,'secondary');
 const review=record(raw.code_review_rate_limit);append(review?.primary_window,'code_review');append(review?.secondary_window,'code_review');
 for(const candidate of Array.isArray(raw.additional_rate_limits)?raw.additional_rate_limits:[]){
  const lane=record(candidate);if(!lane)continue;const limits=record(lane.rate_limit);const feature=String(lane.metered_feature??lane.limit_name??'').toLowerCase();const kind=feature.includes('code_review')||feature.includes('code-review')?'code_review':'other';
  // Do not silently select a partially malformed two-window lane.
  const first=record(limits?.primary_window),second=record(limits?.secondary_window);
  if((first&&typeof first.used_percent!=='number')||(second&&typeof second.used_percent!=='number'))continue;
  append(first,kind,lane);append(second,kind,lane);
 }
 const credits=record(raw.rate_limit_reset_credit_details)??record(raw.rate_limit_reset_credits);
 const expirations=Array.isArray(credits?.credits)?credits.credits.map(c=>record(c)?.expires_at):undefined;
 const validExpirations=expirations?.every(x=>x==null||(typeof x==='string'&&Number.isFinite(Date.parse(x))));
 return {lanes:groupLanes(windows),planType:stringOrNull(raw.plan_type),limitReached:typeof main?.limit_reached==='boolean'?main.limit_reached:null,resetCreditsAvailable:nonNegativeIntegerOrNull(credits?.available_count),...(validExpirations?{resetCreditExpirations:expirations!.map(x=>x==null?null:new Date(x as string).toISOString())}:{})};
}

/** Native plans can report one weekly primary window and no secondary window. */
export function hasCodexBindingWindows(
  value: unknown,
  lanes: readonly CodexLane[],
): boolean {
  const limits = record(record(value)?.rate_limit);
  const main = lanes.find((lane) => lane.id === MAIN_LANE_ID);
  if (!limits || !main?.windows.some((window) => window.role === "primary"))
    return false;
  // Missing/null is optional; a present malformed window must still fail closed.
  return limits.secondary_window == null ||
    main.windows.some((window) => window.role === "secondary");
}

export function buildCodexObservation(accounts:readonly ManagedAccount[],nowMs:number,counts:Map<string,number>=new Map()):CodexObservation{
 const views:CodexAccountView[]=accounts.filter(a=>a.provider==='codex').map(a=>{
  const data=parseCodexUsage(a.usage?.value,a.usage?.measured_at_ms??nowMs);
  const main=data.lanes.find(l=>l.id==='main');
  const complete=hasCodexBindingWindows(a.usage?.value,data.lanes);
  const fresh=a.usage!==null&&a.usage.measured_at_ms<=nowMs+1000&&nowMs-a.usage.measured_at_ms<=300_000;
  const healthy=a.enabled&&a.auth_error===null;
  const trusted=!!complete&&fresh&&a.usage_error===null;
  const headroom=trusted&&main?laneHeadroomPercent(main):null;
  const exclusions:string[]=[];
  if(!a.enabled)exclusions.push('manually_disabled');if(a.auth_error)exclusions.push('relogin_required');if(!trusted)exclusions.push('usage_unknown');if(data.limitReached||headroom===0)exclusions.push('quota_exhausted');
  return {accountKey:a.key,providerAccountId:a.account_id,email:a.email,label:a.label,ordinal:a.ordinal-1,enabled:a.enabled,present:true,authStatus:a.auth_error??'ok',reloginRequired:a.auth_error!==null,identityConflict:a.auth_error==='identity-mismatch',manuallyDisabled:!a.enabled,usageStatus:a.auth_error?'quarantined':a.usage_error?'error':!a.usage?'unknown':fresh?'ok':'stale',decisionGrade:trusted,...data,measurementSource:a.usage?(fresh&&a.usage_error===null?'current':'last-good'):null,measuredAtMs:a.usage?.measured_at_ms??null,eligible:healthy&&trusted&&headroom!==null&&headroom>0&&!data.limitReached,exclusions,headroomPercent:headroom,activeLeases:counts.get(a.key)??0,quotaBlockedUntilMs:a.quota_blocks,quotaBlockedAtMs:a.quota_blocked_at_ms,nextPollAt:new Date(a.next_poll_at_ms).toISOString(),lastError:a.usage_error?{code:a.usage_error.code,httpStatus:a.usage_error.status,summary:null}:null};
 });
 return {schema_version:CODEX_OBSERVATION_SCHEMA_VERSION,observed_at_ms:nowMs,health:'ok',dependency:null,recommendation:null,accounts:views,notes:[]};
}
export interface ObserveCodexOptions{env?:Record<string,string|undefined>;noFetch?:boolean}
export async function observeCodex(options:ObserveCodexOptions={}):Promise<CodexObservation>{
 const env=options.env??process.env,paths=statePaths(env);
 const accounts=options.noFetch?readPool(paths).accounts:await refreshUsage(paths,'codex',env);
 return buildCodexObservation(accounts,Date.now(),activeCounts(readLeases(paths)));
}
