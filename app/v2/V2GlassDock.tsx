"use client";

import { useEffect, useId, useRef, useState } from "react";

type GlassTool = "catalog" | "bookmark" | "annotations" | "companion" | "settings";

type Props = {
  onCatalog: () => void;
  onBookmark: () => void;
  onAnnotations: () => void;
  onCompanion: () => void;
  onSettings: () => void;
  annotationsShown: boolean;
  activePanel: "catalog" | "companion" | "settings" | null;
  disabled?: boolean;
};

function ToolIcon({ name }: { name: GlassTool | "book" | "close" }) {
  const common = {
    width: 21, height: 21, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.65,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };
  if (name === "catalog") {
    return <svg {...common}><path d="M4 5.5c3-1.6 5.4-1.6 8 0v14c-2.6-1.6-5-1.6-8 0zM12 5.5c2.6-1.6 5-1.6 8 0v14c-3-1.6-5.4-1.6-8 0z"/></svg>;
  }
  if (name === "bookmark") {
    return <svg {...common}><path d="M6 4.5h12v16l-6-4-6 4z"/></svg>;
  }
  if (name === "annotations") {
    return <svg {...common}><path d="m5 19 4.1-.8L19 8.3 15.7 5 5.8 14.9 5 19ZM13.9 6.8l3.3 3.3M5 22h14"/></svg>;
  }
  if (name === "companion") {
    return <svg {...common}><circle cx="9" cy="8" r="3"/><path d="M3.5 20v-2c0-3.2 2.2-5 5.5-5s5.5 1.8 5.5 5v2zM16 5a3 3 0 0 1 0 6m2 2c2 1 2.5 2.5 2.5 5v2"/></svg>;
  }
  if (name === "settings") {
    return <svg {...common}><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.1" fill="#fff"/><circle cx="16" cy="17" r="2.1" fill="#fff"/></svg>;
  }
  if (name === "close") {
    return <svg {...common}><path d="m6 9 6 6 6-6"/></svg>;
  }
  return <svg {...common}><path d="M12 6c-2.6-1.8-5.2-1.8-8 0v12c2.8-1.8 5.4-1.8 8 0 2.6-1.8 5.2-1.8 8 0V6c-2.8-1.8-5.4-1.8-8 0zm0 0v12"/></svg>;
}

/** One dock for the active V2 reader; nothing relies on paid UI packages. */
export function V2GlassDock({
  onCatalog, onBookmark, onAnnotations, onCompanion, onSettings,
  annotationsShown, activePanel, disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const dockRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    firstItemRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !dockRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const tools = [
    { key: "catalog" as const, label: "目录", action: onCatalog },
    { key: "bookmark" as const, label: "书签", action: onBookmark },
    {
      key: "annotations" as const, label: annotationsShown ? "隐藏批注" : "显示批注",
      action: onAnnotations,
    },
    { key: "companion" as const, label: "共读", action: onCompanion },
    { key: "settings" as const, label: "设置", action: onSettings },
  ];

  return (
    <div className="v2-glass-dock" ref={dockRef}>
      {open && (
        <nav id={regionId} className="v2-glass-panel" aria-label="阅读工具">
          <div className="v2-glass-panel-title">阅读控制</div>
          <div className="v2-glass-tools">
            {tools.map((tool, index) => (
              <button key={tool.key} type="button"
                ref={index === 0 ? firstItemRef : undefined}
                className="v2-glass-tool"
                disabled={disabled}
                aria-pressed={
                  tool.key === "annotations" ? annotationsShown :
                  tool.key !== "bookmark" && activePanel === tool.key
                }
                onClick={() => { tool.action(); setOpen(false); triggerRef.current?.focus(); }}>
                <ToolIcon name={tool.key}/>
                <span>{tool.label}</span>
              </button>
            ))}
            <button type="button" className="v2-glass-tool v2-glass-collapse"
              onClick={() => { setOpen(false); triggerRef.current?.focus(); }}>
              <ToolIcon name="close"/>
              <span>收起</span>
            </button>
          </div>
        </nav>
      )}
      <button ref={triggerRef} type="button" className="v2-glass-orb"
        aria-label={open ? "收起阅读工具" : "展开阅读工具"}
        aria-controls={regionId} aria-expanded={open}
        onClick={() => setOpen((value) => !value)}>
        <ToolIcon name={open ? "close" : "book"}/>
      </button>
    </div>
  );
}
