"use client";

import type { Note } from "./types";
import type { UserProfile } from "./types";

type Props = {
  note: Note;
  profile: UserProfile | null;
  cardTop: number;
  replyDraft: string;
  onReplyDraftChange: (noteId: string, value: string) => void;
  onSubmitReply: (noteId: string) => void;
  onDeleteNote: (noteId: string) => void;
  onDeleteReply: (noteId: string, replyId: string) => void;
  cardRef?: (el: HTMLDivElement | null) => void;
};

export function NoteCard({
  note,
  profile,
  cardTop,
  replyDraft,
  onReplyDraftChange,
  onSubmitReply,
  onDeleteNote,
  onDeleteReply,
  cardRef,
}: Props) {
  const isMobile =
    typeof window !== "undefined" && window.innerWidth < 1024;

  return (
    <div
      ref={cardRef}
      className={`${isMobile ? "relative mb-4" : "absolute left-0 right-0"} w-full transition-[top] duration-200 ease-out`}
      style={isMobile ? {} : { top: cardTop ?? 0 }}
    >
      <article
        className="group rounded-xl border bg-white/70 px-4 py-3 shadow-sm backdrop-blur-sm"
        style={{ borderColor: `${note.userColor}55` }}
      >
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <span
              className="text-xs font-semibold"
              style={{ color: note.userColor }}
            >
              {note.author}
            </span>
            <span className="text-[10px] text-[#b5aea4]">
              {new Date(note.createdAt).toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
          {profile?.name === note.author && (
            <button
              onClick={() => onDeleteNote(note.id)}
              className="text-[10px] text-[#b5aea4] opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
              title="撕掉这张笔记"
            >
              删除
            </button>
          )}
        </div>
        <p className="text-sm leading-relaxed text-[#3d3834]">
          {note.content}
        </p>

        {note.replies.length > 0 && (
          <div
            className="mt-3 space-y-2 border-t pt-3"
            style={{ borderColor: `${note.userColor}33` }}
          >
            {note.replies.map((reply) => (
              <div key={reply.id} className="group/reply text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className="font-semibold"
                    style={{ color: reply.user_color }}
                  >
                    {reply.user_name}
                  </span>
                  {profile?.userId === reply.user_id && (
                    <button
                      onClick={() => onDeleteReply(note.id, reply.id)}
                      className="text-[10px] text-[#b5aea4] opacity-0 transition-opacity hover:text-red-500 group-hover/reply:opacity-100"
                      title="撤回回复"
                    >
                      撤回
                    </button>
                  )}
                </div>
                <p className="mt-0.5 leading-relaxed text-[#3d3834]">
                  {reply.content}
                </p>
              </div>
            ))}
          </div>
        )}

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
          placeholder="回复… 回车发送"
          className="mt-3 w-full rounded-lg border border-[#e8e2d6] bg-[#faf8f4]/80 px-2.5 py-1.5 text-xs outline-none focus:border-[#2c2825]/20"
        />
      </article>
    </div>
  );
}
