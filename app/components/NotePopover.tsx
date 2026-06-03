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
      {/* 背景遮罩：让后面的文字稍微变暗，突出悬浮窗 */}
      <div
        className="fixed inset-0 z-[90] bg-black/10 sm:bg-transparent transition-colors"
        aria-hidden
        onMouseDown={onClose}
        onTouchStart={onClose}
      />

      {/* 弹窗核心：加入了苹果风的悬浮与毛玻璃属性 */}
      <div
        className="fixed z-[100] flex flex-col bottom-6 left-4 right-4 rounded-[2rem] bg-[#f9f9f9]/85 p-5 shadow-2xl backdrop-blur-xl border border-white/60 transition-all sm:w-[24rem] sm:bottom-auto sm:left-auto sm:right-auto sm:-translate-x-1/2 sm:-translate-y-full sm:rounded-2xl sm:border-[#e0d9cc] sm:bg-white/95 sm:p-4 sm:shadow-xl"
        style={
          isMobile
            ? {}
            : { left: popover.x, top: popover.y - 12 }
        }
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        {/* 引用的原文：更细腻的文字颜色和边距 */}
        <p className="mb-4 line-clamp-3 border-l-[3px] border-black/10 pl-3 text-[14px] leading-relaxed text-[#8a8278]">
          「{popover.text}」
        </p>

        {/* 输入框：苹果 iOS 原生风格的无边框浅灰内嵌输入框 */}
        <textarea
          autoFocus
          rows={3}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder="写下你的时空笔记…"
          className="w-full resize-none rounded-2xl bg-black/5 px-4 py-3.5 text-[15px] text-[#2c2825] outline-none transition-colors focus:bg-black/10 placeholder:text-black/30"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit();
          }}
        />

        {/* 底部按钮：全圆角胶囊样式 */}
        <div className="mt-4 flex justify-end gap-2 pb-safe sm:pb-0">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-5 py-2.5 text-sm font-medium text-[#6b6560] transition-colors hover:bg-black/5 active:bg-black/10"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!draft.trim() || submitting}
            className="rounded-full bg-[#2c2825] px-6 py-2.5 text-sm font-medium text-white transition-all active:scale-95 disabled:opacity-40"
          >
            {submitting ? "保存中…" : "提交笔记"}
          </button>
        </div>
      </div>
    </>
  );
}