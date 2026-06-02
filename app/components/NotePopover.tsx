"use client";

import type { PopoverState } from "./types";

type Props = {
  popover: PopoverState;
  draft: string;
  submitting: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
};

export function NotePopover({
  popover,
  draft,
  submitting,
  onDraftChange,
  onSubmit,
  onClose,
}: Props) {
  const isMobile =
    typeof window !== "undefined" && window.innerWidth < 640;

  return (
    <>
      {/* 背景遮罩 */}
      <div
        className="fixed inset-0 z-[90] bg-black/10 sm:bg-transparent transition-colors"
        aria-hidden
        onMouseDown={onClose}
        onTouchStart={onClose}
      />

      {/* 弹窗 */}
      <div
        className="fixed z-[100] flex w-full flex-col bottom-0 left-0 rounded-t-3xl border-t border-[#e0d9cc] bg-white/95 p-5 shadow-[0_-10px_40px_rgba(0,0,0,0.12)] backdrop-blur-lg transition-all sm:w-[24rem] sm:bottom-auto sm:left-auto sm:-translate-x-1/2 sm:-translate-y-full sm:rounded-2xl sm:border sm:p-4 sm:shadow-xl"
        style={
          isMobile
            ? {}
            : { left: popover.x, top: popover.y - 12 }
        }
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        {/* 手机端拉手 */}
        <div className="mx-auto mb-4 h-1 w-12 rounded-full bg-[#e0d9cc] sm:hidden" />

        <p className="mb-4 line-clamp-3 border-l-2 border-[#e0d9cc] pl-3 text-sm leading-relaxed text-[#9a9288]">
          「{popover.text}」
        </p>

        <textarea
          autoFocus
          rows={3}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder="写下边缘笔记…"
          className="w-full resize-none rounded-xl border border-[#e8e2d6] bg-[#faf8f4] px-4 py-3 text-sm outline-none transition-colors focus:border-[#2c2825]/30 focus:bg-white"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit();
          }}
        />

        <div className="mt-4 flex justify-end gap-3 pb-safe sm:pb-0">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-sm font-medium text-[#6b6560] transition-colors hover:bg-[#faf8f4]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!draft.trim() || submitting}
            className="rounded-xl bg-[#2c2825] px-6 py-2 text-sm font-medium text-white transition-colors disabled:opacity-40"
          >
            {submitting ? "保存中…" : "提交"}
          </button>
        </div>
      </div>
    </>
  );
}
