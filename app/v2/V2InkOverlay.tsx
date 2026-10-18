"use client";

import {
  useCallback, useEffect, useRef, useState,
  type PointerEvent, type ReactNode,
} from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addInkPoint, inkArrowHead, isValidInkShape, normalizedInkPoint,
  type InkKind, type InkPoint, type InkShape,
} from "@/lib/v2/ink";

type Props = {
  client: SupabaseClient;
  roomId: string;
  chunkIndex: number;
  userId: string;
  enabled: boolean;
  children: ReactNode;
};

type RawInk = InkShape & { created_at: string };

const toolNames: { kind: InkKind; label: string }[] = [
  { kind: "ellipse", label: "画圈" },
  { kind: "arrow", label: "箭头" },
  { kind: "stroke", label: "自由画" },
];

function validInkRow(raw: unknown): raw is RawInk {
  if (!raw || typeof raw !== "object") return false;
  const row = raw as Record<string, unknown>;
  return typeof row.id === "string" &&
    typeof row.author_id === "string" &&
    typeof row.created_at === "string" &&
    (row.visibility === "private" || row.visibility === "shared") &&
    Array.isArray(row.points) &&
    isValidInkShape({
      kind: row.kind as InkKind,
      points: row.points as InkPoint[],
    });
}

function InkPath({ shape, color, opacity = 0.85 }: {
  shape: Pick<InkShape, "kind" | "points">;
  color: string;
  opacity?: number;
}) {
  if (!isValidInkShape(shape)) return null;
  const first = shape.points[0];
  const last = shape.points.at(-1) ?? first;
  if (shape.kind === "ellipse") {
    return <ellipse cx={(first.x + last.x) / 2}
      cy={(first.y + last.y) / 2}
      rx={Math.abs(last.x - first.x) / 2}
      ry={Math.abs(last.y - first.y) / 2}
      stroke={color} strokeWidth={4} fill="none" opacity={opacity}/>;
  }
  if (shape.kind === "arrow") {
    return <g stroke={color} strokeWidth={4} strokeLinecap="round"
      strokeLinejoin="round" fill="none" opacity={opacity}>
      <line x1={first.x} y1={first.y} x2={last.x} y2={last.y}/>
      <polyline points={inkArrowHead(first,last)}/>
    </g>;
  }
  return <polyline
    points={shape.points.map((p) => p.x + "," + p.y).join(" ")}
    fill="none" stroke={color} strokeWidth={4}
    strokeLinecap="round" strokeLinejoin="round"
    opacity={opacity}/>;
}

/**
 * Drawing happens only in an explicit pen tool. In reading mode the SVG layer
 * ignores pointers so normal text selection and scrolling keep working.
 */
export function V2InkOverlay({
  client, roomId, chunkIndex, userId, enabled, children,
}: Props) {
  const [mode, setMode] = useState<InkKind | "read">("read");
  const [visibility, setVisibility] = useState<"private" | "shared">("private");
  const [saved, setSaved] = useState<RawInk[]>([]);
  const [draft, setDraft] = useState<InkPoint[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const surfaceRef = useRef<SVGSVGElement>(null);
  const activePointer = useRef<number | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await client.from("reading_ink_v2")
      .select("id,author_id,kind,points,visibility,created_at")
      .eq("room_id",roomId).eq("chunk_index",chunkIndex)
      .order("created_at",{ascending:true}).limit(150);
    if (error) {
      setNotice("获取手绘批注失败，请检查独立测试库权限。");
      return;
    }
    setSaved((data ?? []).filter(validInkRow));
  }, [client,roomId,chunkIndex]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void load(); },0);
    return () => window.clearTimeout(timeout);
  },[load]);

  function pointerPoint(event: PointerEvent<SVGSVGElement>): InkPoint | null {
    const svg = surfaceRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    try {
      return normalizedInkPoint(
        event.clientX,event.clientY,rect.left,rect.top,rect.width,rect.height,
      );
    } catch {
      return null;
    }
  }

  function start(event: PointerEvent<SVGSVGElement>) {
    if (!enabled || mode === "read" || busy || activePointer.current !== null) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = pointerPoint(event);
    if (!point) return;
    event.preventDefault();
    activePointer.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraft(mode === "stroke" ? [point] : [point,point]);
  }

  function move(event: PointerEvent<SVGSVGElement>) {
    if (activePointer.current !== event.pointerId || mode === "read") return;
    const point = pointerPoint(event);
    if (!point) return;
    event.preventDefault();
    if (mode === "stroke") {
      setDraft((previous) => addInkPoint(previous,point));
    } else {
      setDraft((previous) => previous.length ? [previous[0],point] : previous);
    }
  }

  function finish(event: PointerEvent<SVGSVGElement>) {
    if (activePointer.current !== event.pointerId) return;
    move(event);
    activePointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function cancel() {
    activePointer.current = null;
    setDraft([]);
    setNotice("已取消本次绘图，服务器没有保存。");
  }

  async function save() {
    if (mode === "read" || busy || !isValidInkShape({ kind: mode, points: draft })) {
      return;
    }
    setBusy(true);
    const { error } = await client.from("reading_ink_v2").insert({
      room_id: roomId,chunk_index: chunkIndex,author_id: userId,
      kind: mode,points: draft,visibility,
    });
    if (error) {
      setNotice("保存失败：可能是权限不足、书房已关闭或已达到每人每段 60 条笔迹上限。");
    } else {
      setDraft([]);
      setMode("read");
      setNotice("笔迹已保存。私人笔迹仅自己可见；共享笔迹双方可见。");
      await load();
    }
    setBusy(false);
  }

  const drawing = enabled && mode !== "read" && !busy;

  return (
    <div>
      {enabled && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-[#817668]">手绘：</span>
          <button className="rounded-lg border px-2.5 py-1.5 text-xs"
            type="button" aria-pressed={mode === "read"}
            disabled={busy}
            onClick={() => { setMode("read"); setDraft([]); }}>
            阅读/选字
          </button>
          {toolNames.map((tool) => (
            <button key={tool.kind} type="button" disabled={busy}
              className="rounded-lg border px-2.5 py-1.5 text-xs"
              aria-pressed={mode === tool.kind}
              style={{background: mode === tool.kind ? "#dce8f8" : "transparent"}}
              onClick={() => { setMode(tool.kind);setDraft([]);setNotice(""); }}>
              {tool.label}
            </button>
          ))}
          <button className="rounded-lg border px-2.5 py-1.5 text-xs"
            type="button" disabled={busy} onClick={() => { void load(); }}>
            刷新笔迹
          </button>
          {mode !== "read" && (
            <div className="flex w-full flex-wrap items-center gap-2">
              <label className="text-xs">可见范围
                <select className="ml-2 rounded-lg border bg-white px-2 py-1"
                  value={visibility}
                  disabled={busy}
                  onChange={(event) =>
                    setVisibility(event.target.value as "private" | "shared")}>
                  <option value="private">仅自己</option>
                  <option value="shared">双方共享</option>
                </select>
              </label>
              <button className="rounded-lg border px-2.5 py-1.5 text-xs"
                type="button" disabled={busy || !isValidInkShape({kind:mode,points:draft})}
                onClick={() => { void save(); }}>保存笔迹</button>
              <button className="rounded-lg border px-2.5 py-1.5 text-xs"
                type="button" disabled={busy || draft.length === 0}
                onClick={() => setDraft([])}>清除未保存</button>
              <span className="text-xs text-[#817668]">
                绘图时暂时关闭文本选中，保存后恢复。
              </span>
            </div>
          )}
        </div>
      )}
      <div className="relative">
        {children}
        {enabled && <svg ref={surfaceRef}
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 1000 1000" preserveAspectRatio="none"
          aria-label={drawing ? "手绘画布，请用鼠标或手指描绘" : "已保存的手绘批注"}
          style={{
            touchAction: drawing ? "none" : "auto",
            pointerEvents: drawing ? "auto" : "none",
            cursor: drawing ? "crosshair" : "default",
          }}
          onPointerDown={start} onPointerMove={move}
          onPointerUp={finish} onPointerCancel={cancel}>
          {saved.map((shape) => <InkPath key={shape.id} shape={shape}
            color={shape.author_id === userId ? "#2563eb" : "#be456b"}/>)}
          {mode !== "read" && draft.length > 1 && (
            <InkPath shape={{kind:mode,points:draft}} color="#2563eb" opacity={0.65}/>
          )}
        </svg>}
      </div>
      {notice && enabled && <p role="status" className="mt-2 text-xs text-[#76563a]">{notice}</p>}
      {enabled && saved.length > 0 && (
        <p className="mt-1 text-xs text-[#817668]">
          当前可见 {saved.length} 条笔迹。蓝色是自己的，玫红色是共读伙伴的。
        </p>
      )}
    </div>
  );
}
