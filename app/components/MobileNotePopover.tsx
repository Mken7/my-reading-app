"use client";

import { useEffect, useRef, useState } from "react";
import type { Note, UserProfile } from "./types";

type Props = {
  note: Note;
  profile: UserProfile | null;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  replyDraft: string;
  onReplyDraftChange: (noteId: string, value: string) => void;
  onSubmitReply: (noteId: string) => void;
  onDeleteNote: (noteId: string) => void;
  onDeleteReply: (noteId: string, replyId: string) => void;
};

export function MobileNotePopover({
  note,
  profile,
  anchorEl,
  onClose,
  replyDraft,
  onReplyDraftChange,
  onSubmitReply,
  onDeleteNote,
  onDeleteReply,
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [linePoints, setLinePoints] = useState("");

  useEffect(() => {
    if (!anchorEl || !cardRef.current) return;

    const updatePosition = () => {
      const anchorRect = anchorEl.getBoundingClientRect();
      const card = cardRef.current;
      if (!card) return;

      const cardW = Math.min(280, window.innerWidth - 32);
      const cardH = card.scrollHeight;

      // 卡片放在正文右侧空白处
      let left = anchorRect.right + 12;
      let top = anchorRect.top - 10;

      // 确保不超出屏幕右侧
      if (left + cardW > window.innerWidth - 16) {
        left = window.innerWidth - cardW - 16;
      }

      // 确保不超出屏幕底部
      if (top + cardH > window.innerHeight - 16) {
        top = window.innerHeight - cardH - 16;
      }

      // 确保不超出屏幕顶部
      if (top < 16) top = 16;

      setPosition({ top, left });

      // 计算引导线（从锚点到卡片）
      const anchorCenterX = anchorRect.left + anchorRect.width / 2;
      const anchorCenterY = anchorRect.top + anchorRect.height / 2;
      const cardCenterX = left + cardW / 2;
      const cardTop = top;

      // 贝塞尔曲线控制点
      const midY = (anchorCenterY + cardTop) / 2;
      setLinePoints(
        `M ${anchorCenterX} ${anchorCenterY} C ${anchorCenterX} ${midY}, ${cardCenterX} ${midY}, ${cardCenterX} ${cardTop}`,
      );
    };

    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);

    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [anchorEl]);

  return (
    <>
      {/* 遮罩 */}
      <div
        className="fixed inset-0 z-[80] bg-black/10"
        onClick={onClose}
      />

      {/* SVG 引导线 */}
      <svg
        className="fixed inset-0 z-[81] pointer-events-none"
        style={{ width: "100%", height: "100%" }}
      >
        <path
          d={linePoints}
          fill="none"
          stroke={note.userColor}
          strokeWidth="1.5"
          strokeDasharray="4 3"
          opacity="0.6"
        />
        {/* 起点小圆点 */}
        {anchorEl && linePoints && (
          <circle
            cx={anchorEl.getBoundingClientRect().left + anchorEl.getBoundingClientRect().width / 2}
            cy={anchorEl.getBoundingClientRect().top + anchorEl.getBoundingClientRect().height / 2}
            r="3"
            fill={note.userColor}
            opacity="0.8"
          />
        )}
      </svg>

      {/* 便签卡片 */}
      <div
        ref={cardRef}
        className="fixed z-[82] w-[70vw] max-w-[280px] rounded-xl border-2 bg-white/95 shadow-xl backdrop-blur-md"
        style={{
          top: position.top,
          left: position.left,
          borderColor: `${note.userColor}88`,
        }}
      >
        {/* 便签头部 */}
        <div
          className="flex items-center justify-between rounded-t-xl px-3 py-2"
          style={{ backgroundColor: `${note.userColor}15` }}
        >
          <div className="flex items-baseline gap-2">
            <span
              className="text-xs font-semibold"
              style={{ color: note.userColor }}
            >
              {note.author}
            </span>
            <span className="text-[9px] text-[#b5aea4]">
              {new Date(note.createdAt).toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
          <div className="flex gap-2">
            {profile?.name === note.author && (
              <button
                onClick={() => onDeleteNote(note.id)}
                className="text-[9px] text-[#b5aea4] hover:text-red-500"
              >
                删除
              </button>
            )}
            <button
              onClick={onClose}
              className="text-sm leading-none text-[#b5aea4] hover:text-[#2c2825]"
            >
              ×
            </button>
          </div>
        </div>

        {/* 引用文本 */}
        <p className="border-l-2 border-[#e0d9cc] mx-3 mt-2 pl-2 text-[10px] leading-relaxed text-[#9a9288] line-clamp-2">
          「{note.content.length > 60 ? note.content.slice(0, 60) + "…" : note.content}」
        </p>

        {/* 笔记内容 */}
        <p className="px-3 py-2 text-sm leading-relaxed text-[#3d3834]">
          {note.content}
        </p>

        {/* 回复列表 */}
        {note.replies.length > 0 && (
          <div className="mx-3 mb-2 space-y-1.5 border-t pt-2" style={{ borderColor: `${note.userColor}22` }}>
            {note.replies.map((reply) => (
              <div key={reply.id} className="flex items-start justify-between gap-1">
                <div className="text-[11px]">
                  <span className="font-semibold" style={{ color: reply.user_color }}>
                    {reply.user_name}
                  </span>
                  <span className="ml-1 text-[#3d3834]">{reply.content}</span>
                </div>
                {profile?.userId === reply.user_id && (
                  <button
                    onClick={() => onDeleteReply(note.id, reply.id)}
                    className="shrink-0 text-[9px] text-[#b5aea4] hover:text-red-500"
                  >
                    撤回
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 回复输入 */}
        <div className="border-t border-[#e8e2d6] px-3 py-2">
          <input
            type="text"
            value={replyDraft}
            onChange={(e) => onReplyDraftChange(note.id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSubmitReply(note.id);
              }
            }}
            placeholder="回复…"
            className="w-full rounded-lg border border-[#e8e2d6] bg-[#faf8f4] px-2.5 py-1.5 text-xs outline-none focus:border-[#2c2825]/20"
          />
        </div>
      </div>
    </>
  );
}
