"use client";

import {
  useCallback, useEffect, useRef, useState,
  type PointerEvent, type ReactNode, type RefObject,
} from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addInkPoint, inkArrowHead, isValidInkShape, normalizedInkPoint,
  type InkKind, type InkPoint, type InkShape,
} from "@/lib/v2/ink";
import {
  locateTextOffset, paddedTextRect, validTextAnchor,
  type PlainRect, type TextAnchor,
} from "@/lib/v2/textAnchor";
import { singleLineInkBounds, type InkAnchorLayout } from "@/lib/v2/inkReflow";

type Props = {
  client: SupabaseClient;
  roomId: string;
  chunkIndex: number;
  userId: string;
  enabled: boolean;
  children: ReactNode;
  selectedText: TextAnchor | null;
  textRootRef: RefObject<HTMLDivElement | null>;
};

type RawInk = InkShape & {
  created_at: string;
  anchor_start: number | null;
  anchor_end: number | null;
  anchor_layout: InkAnchorLayout;
};

type PositionedInk = { shape: RawInk; bounds: PlainRect };

const toolNames: { kind: InkKind; label: string }[] = [
  { kind: "ellipse", label: "画圈" },
  { kind: "arrow", label: "箭头" },
  { kind: "stroke", label: "自由画" },
];

function validInkRow(raw: unknown): raw is RawInk {
  if (!raw || typeof raw !== "object") return false;
  const row = raw as Record<string, unknown>;
  const start = row.anchor_start;
  const end = row.anchor_end;
  return (row.anchor_layout === "bounding_v1" ||
    row.anchor_layout === "single_line_v2") &&
    (row.anchor_layout !== "single_line_v2" || start !== null) &&
    typeof row.id === "string" &&
    typeof row.author_id === "string" &&
    typeof row.created_at === "string" &&
    (row.visibility === "private" || row.visibility === "shared") &&
    ((start === null && end === null) ||
      (typeof start === "number" && typeof end === "number" &&
        validTextAnchor({ start, end }, 3000))) &&
    Array.isArray(row.points) &&
    isValidInkShape({
      kind: row.kind as InkKind,
      points: row.points as InkPoint[],
    });
}

/**
 * Recover a real DOM Range from Unicode codepoints, even when React splits the
 * immutable text into multiple highlighted spans and includes emoji.
 */
function textBounds(
  container: HTMLElement,
  textRoot: HTMLElement,
  anchor: TextAnchor | null,
  singleLineOnly = false,
): PlainRect | null {
  const rootRect = textRoot.getBoundingClientRect();
  const parentRect = container.getBoundingClientRect();
  if (!anchor) {
    return {
      left: rootRect.left - parentRect.left,
      top: rootRect.top - parentRect.top,
      width: rootRect.width,
      height: rootRect.height,
    };
  }

  const walker = document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node: Node | null = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) nodes.push(node as Text);
    node = walker.nextNode();
  }
  const segments = nodes.map((text) => text.data);
  const total = segments.reduce((sum, item) => sum + Array.from(item).length, 0);
  if (!validTextAnchor(anchor, total)) return null;
  const first = locateTextOffset(segments, anchor.start);
  const last = locateTextOffset(segments, anchor.end);
  if (!first || !last) return null;

  const range = document.createRange();
  range.setStart(nodes[first.segmentIndex], first.utf16Offset);
  range.setEnd(nodes[last.segmentIndex], last.utf16Offset);
  if (singleLineOnly) {
    return singleLineInkBounds(Array.from(range.getClientRects()), parentRect);
  }
  const rect = range.getBoundingClientRect();
  return paddedTextRect(rect, parentRect);
}

function InkPath({ shape, color, opacity = 0.85 }: {
  shape: Pick<InkShape, "kind" | "points">;
  color: string;
  opacity?: number;
}) {
  if (!isValidInkShape(shape)) return null;
  const first = shape.points[0];
  const last = shape.points.at(-1) ?? first;
  const line = {
    stroke: color,
    strokeWidth: 2.5,
    vectorEffect: "non-scaling-stroke" as const,
  };
  if (shape.kind === "ellipse") {
    return <ellipse cx={(first.x + last.x) / 2}
      cy={(first.y + last.y) / 2}
      rx={Math.abs(last.x - first.x) / 2}
      ry={Math.abs(last.y - first.y) / 2}
      {...line} fill="none" opacity={opacity}/>;
  }
  if (shape.kind === "arrow") {
    return <g fill="none" strokeLinecap="round"
      strokeLinejoin="round" opacity={opacity}>
      <line x1={first.x} y1={first.y} x2={last.x} y2={last.y}
        {...line}/>
      <polyline points={inkArrowHead(first,last)} {...line}/>
    </g>;
  }
  return <polyline
    points={shape.points.map((point) => point.x + "," + point.y).join(" ")}
    fill="none" strokeLinecap="round" strokeLinejoin="round"
    {...line} opacity={opacity}/>;
}

/**
 * Anchored ink is painted relative to the selected text bounding box, which
 * is recalculated on reflow. Existing old rows with NULL anchors remain
 * paragraph-relative; nothing is deleted or rewritten during migration.
 */
export function V2InkOverlay({
  client, roomId, chunkIndex, userId, enabled, children,
  selectedText, textRootRef,
}: Props) {
  const [mode, setMode] = useState<InkKind | "read">("read");
  const [visibility, setVisibility] = useState<"private" | "shared">("private");
  const [saved, setSaved] = useState<RawInk[]>([]);
  const [positioned, setPositioned] = useState<PositionedInk[]>([]);
  const [hiddenByWrap,setHiddenByWrap] = useState(0);
  const [activeAnchor, setActiveAnchor] = useState<TextAnchor | null>(null);
  const [draftBounds, setDraftBounds] = useState<PlainRect | null>(null);
  const [draft, setDraft] = useState<InkPoint[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [pendingHide, setPendingHide] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<SVGSVGElement>(null);
  const activePointer = useRef<number | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await client.from("reading_ink_v2")
      .select("id,author_id,kind,points,visibility,created_at,anchor_start,anchor_end,anchor_layout")
      .eq("room_id",roomId).eq("chunk_index",chunkIndex)
      .order("created_at",{ascending:true}).limit(150);
    if (error) {
      setNotice("获取手绘批注失败，请检查独立测试库权限。");
      return;
    }
    setSaved((data ?? []).filter(validInkRow));
  }, [client,roomId,chunkIndex]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  useEffect(() => {
    const container = containerRef.current;
    const root = textRootRef.current;
    if (!container || !root) return;
    let animation = 0;
    const measure = () => {
      let wrapped=0;
      const next = saved.flatMap((shape) => {
        const anchor = shape.anchor_start === null || shape.anchor_end === null
          ? null
          : { start: shape.anchor_start, end: shape.anchor_end };
        const bounds = textBounds(
          container, root, anchor, shape.anchor_layout === "single_line_v2",
        );
        if (!bounds && shape.anchor_layout === "single_line_v2") wrapped++;
        return bounds ? [{ shape, bounds }] : [];
      });
      setPositioned(next);
      setHiddenByWrap(wrapped);
      setDraftBounds(activeAnchor ?
        textBounds(container,root,activeAnchor,true) : null);
    };
    const schedule = () => {
      window.cancelAnimationFrame(animation);
      animation = window.requestAnimationFrame(measure);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    observer.observe(container);
    window.addEventListener("resize",schedule);
    return () => {
      window.cancelAnimationFrame(animation);
      observer.disconnect();
      window.removeEventListener("resize",schedule);
    };
  }, [saved, activeAnchor, textRootRef]);

  function pointerPoint(event: PointerEvent<SVGSVGElement>): InkPoint | null {
    const surface = surfaceRef.current;
    if (!surface) return null;
    const rect = surface.getBoundingClientRect();
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

  function chooseTool(kind: InkKind) {
    const container=containerRef.current;
    const root=textRootRef.current;
    if (!selectedText || !container || !root) {
      setNotice("请先在正文选中要圈注的文字，再选择绘图工具。");
      return;
    }
    if (!textBounds(container,root,selectedText,true)) {
      setNotice("该选区跨越多行。请只选中同一行文字绘图，避免换行导致图形变形。");
      return;
    }
    setActiveAnchor({ ...selectedText });
    setMode(kind);
    setDraft([]);
    setNotice("");
  }

  function preset(kind:"ellipse" | "arrow") {
    const container=containerRef.current;
    const root=textRootRef.current;
    if(!selectedText || !container || !root ||
       !textBounds(container,root,selectedText,true)){
      setNotice("快捷绘图需要先选中同一行上的文字。");
      return;
    }
    setActiveAnchor({...selectedText});
    setMode(kind);
    setDraft(kind === "ellipse"
      ? [{x:50,y:100},{x:950,y:900}]
      : [{x:70,y:780},{x:930,y:200}]);
    setNotice("已生成可撤销的未保存图形。请核对私人/共享范围后点击保存。");
  }

  async function save() {
    if (!enabled || mode === "read" || busy || !activeAnchor ||
        !isValidInkShape({ kind: mode, points: draft })) return;
    const container=containerRef.current;
    const root=textRootRef.current;
    if(!container || !root ||
       !textBounds(container,root,activeAnchor,true)){
      setNotice("文字换行已改变或绘图目标不存在：无法保存此图形。请恢复单行布局后再试。");
      return;
    }
    setBusy(true);
    const { error } = await client.from("reading_ink_v2").insert({
      room_id: roomId,chunk_index: chunkIndex,author_id: userId,
      kind: mode,points: draft,visibility,
      anchor_start: activeAnchor.start,anchor_end: activeAnchor.end,
      anchor_layout: "single_line_v2",
    });
    if (error) {
      setNotice("保存失败：可能是权限不足、文字选区失效或已达到笔迹上限。");
    } else {
      setDraft([]);
      setMode("read");
      setActiveAnchor(null);
      setNotice("笔迹已绑定选中文字；调整字号时将重新定位。");
      await load();
    }
    setBusy(false);
  }

  async function hideMyInk(id: string) {
    if (busy || pendingHide !== id ||
        !saved.some((item) => item.id === id && item.author_id === userId)) return;
    setBusy(true);
    const { data, error } = await client.rpc("v2_hide_ink", {
      target_room: roomId, target_ink: id,
    });
    setPendingHide(null);
    if (error || data !== true) {
      setNotice("撤销失败：请确认自己是笔迹作者，且书房仍可编辑。");
    } else {
      setNotice("这条笔迹已从双方阅读界面隐藏，并留下撤销审计记录。");
      await load();
    }
    setBusy(false);
  }

  const drawing = enabled && mode !== "read" && !busy && draftBounds !== null;
  const svgStyle = (bounds: PlainRect) => ({
    position: "absolute" as const,
    left: bounds.left, top: bounds.top,
    width: bounds.width, height: bounds.height,
    overflow: "visible" as const,
    pointerEvents: "none" as const,
  });

  return (
    <div>
      {enabled && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-[#817668]">手绘：</span>
          <button className="rounded-lg border px-2.5 py-1.5 text-xs"
            type="button" aria-pressed={mode === "read"}
            disabled={busy}
            onClick={() => { setMode("read"); setActiveAnchor(null); setDraft([]); }}>
            阅读/选字
          </button>
          {toolNames.map((tool) => (
            <button key={tool.kind} type="button" disabled={busy || !selectedText}
              className="rounded-lg border px-2.5 py-1.5 text-xs"
              aria-pressed={mode === tool.kind}
              style={{background: mode === tool.kind ? "#dce8f8" : "transparent"}}
              onClick={() => chooseTool(tool.kind)}>
              {tool.label}
            </button>
          ))}
          <button className="rounded-lg border px-2.5 py-1.5 text-xs"
            type="button" disabled={busy || !selectedText}
            onClick={() => preset("ellipse")}>
            快速圈注（键盘可用）
          </button>
          <button className="rounded-lg border px-2.5 py-1.5 text-xs"
            type="button" disabled={busy || !selectedText}
            onClick={() => preset("arrow")}>
            快速箭头（键盘可用）
          </button>
          <button className="rounded-lg border px-2.5 py-1.5 text-xs"
            type="button" disabled={busy} onClick={() => { void load(); }}>
            刷新笔迹
          </button>
          <span className="w-full text-xs text-[#817668]">
            {selectedText
              ? "请选中同一行文字绘图；遇到跨行重排时，新笔迹暂时隐藏而非拉伸。"
              : "先选中一处文字，再选择手绘工具。旧笔迹仍可显示。"}
          </span>
          {mode !== "read" && (
            <div className="flex w-full flex-wrap items-center gap-2">
              <label className="text-xs">可见范围
                <select className="ml-2 rounded-lg border bg-white px-2 py-1"
                  value={visibility} disabled={busy}
                  onChange={(event) =>
                    setVisibility(event.target.value as "private" | "shared")}>
                  <option value="private">仅自己</option>
                  <option value="shared">双方共享</option>
                </select>
              </label>
              <button className="rounded-lg border px-2.5 py-1.5 text-xs"
                type="button"
                disabled={busy || !draftBounds || !isValidInkShape({kind:mode,points:draft})}
                onClick={() => { void save(); }}>保存笔迹</button>
              <button className="rounded-lg border px-2.5 py-1.5 text-xs"
                type="button" disabled={busy || draft.length === 0}
                onClick={() => setDraft([])}>清除未保存</button>
              <span className="text-xs text-[#817668]">
                手绘位置以选中的文字为基准重新布局。
              </span>
            </div>
          )}
        </div>
      )}
      <div ref={containerRef} className="relative">
        {children}
        {enabled && positioned.map(({shape,bounds}) => (
          <svg key={shape.id} viewBox="0 0 1000 1000"
            preserveAspectRatio="none" aria-hidden="true"
            style={svgStyle(bounds)}>
            <InkPath shape={shape}
              color={shape.author_id === userId ? "#2563eb" : "#be456b"}/>
          </svg>
        ))}
        {drawing && draftBounds && (
          <svg ref={surfaceRef}
            className="absolute"
            viewBox="0 0 1000 1000" preserveAspectRatio="none"
            role="img" aria-label="选中文字上的手绘画布"
            style={{
              ...svgStyle(draftBounds),
              touchAction: "none",
              pointerEvents: "auto",
              cursor: "crosshair",
            }}
            onPointerDown={start} onPointerMove={move}
            onPointerUp={finish} onPointerCancel={cancel}>
            {draft.length > 1 && (
              <InkPath shape={{kind:mode,points:draft}}
                color="#2563eb" opacity={0.65}/>
            )}
          </svg>
        )}
      </div>
      {notice && enabled && <p role="status" className="mt-2 text-xs text-[#76563a]">{notice}</p>}
      {enabled && hiddenByWrap > 0 && (
        <p role="status" className="mt-2 text-xs text-[#76563a]">
          有 {hiddenByWrap} 条单行笔迹的文字现在跨行换行，已暂时隐藏图形以防失真。
          调整字号或屏幕宽度使原文字回到同一行即可重新显示。
          管理列表中的原记录不会被删除。
        </p>
      )}
      {enabled && saved.length > 0 && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-[#817668]">
            当前可见 {saved.length} 条笔迹。蓝色是自己的，玫红色是伙伴的。
            旧版笔迹仍按整段比例显示。
          </p>
          {saved.some((item) => item.author_id === userId) && (
            <details>
              <summary className="cursor-pointer text-xs">
                管理我保存的笔迹
              </summary>
              <div className="mt-2 space-y-2">
                {saved.filter((item) => item.author_id === userId)
                  .map((item, index) => (
                    <div key={item.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-[#e4dbce] p-2">
                      <span className="mr-auto text-xs">
                        笔迹 {index + 1} · {item.kind === "ellipse" ? "圆圈" :
                          item.kind === "arrow" ? "箭头" : "曲线"} ·
                        {item.visibility === "private" ? "私人" : "双方共享"}
                      </span>
                      {pendingHide === item.id ? (
                        <>
                          <button className="rounded-lg border px-2 py-1 text-xs"
                            type="button" disabled={busy}
                            onClick={() => { void hideMyInk(item.id); }}>
                            确认撤销
                          </button>
                          <button className="rounded-lg border px-2 py-1 text-xs"
                            type="button" disabled={busy}
                            onClick={() => setPendingHide(null)}>
                            取消
                          </button>
                        </>
                      ) : (
                        <button className="rounded-lg border px-2 py-1 text-xs"
                          type="button" disabled={busy}
                          onClick={() => setPendingHide(item.id)}>
                          撤销我的笔迹
                        </button>
                      )}
                    </div>
                  ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
