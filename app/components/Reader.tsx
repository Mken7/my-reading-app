"use client";

import { useMemo, useRef, useEffect, useCallback, useState } from "react";
import type { Highlight, Note, RoomPen, UserProfile, OnlineUser } from "./types";
import type { LineStyle } from "@/lib/supabase";
import { buildTextRuns, LINE_STYLE_OPTIONS } from "./utils";
import { renderHighlightedText } from "./HighlightedText";
import { OnlineUsers } from "./OnlineUsers";
import { NoteCard } from "./NoteCard";
import { MobileNotePopover } from "./MobileNotePopover";
import { GAP_BETWEEN_CARDS, stackCardTops } from "./utils";

type Props = {
  profile: UserProfile;
  roomPen: RoomPen;
  bookTitle: string;
  bookText: string;
  bookLoading: boolean;
  highlights: Highlight[];
  notes: Note[];
  roomJoinCode: string;
  onlineUsers: OnlineUser[];
  cardTops: Record<string, number>;
  notesMinHeight: number;
  replyDrafts: Record<string, string>;
  codeCopied: boolean;
  cloudLoading: boolean;
  onCopyJoinCode: () => void;
  onLeaveRoom: () => void;
  onReplyDraftChange: (noteId: string, value: string) => void;
  onSubmitReply: (noteId: string) => void;
  onDeleteNote: (noteId: string) => void;
  onDeleteReply: (noteId: string, replyId: string) => void;
  onMouseUp: () => void;
  bookRef: React.RefObject<HTMLDivElement | null>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  notesColumnRef: React.RefObject<HTMLDivElement | null>;
  markRefs: React.RefObject<Map<string, HTMLSpanElement>>;
  cardRefs: React.RefObject<Map<string, HTMLDivElement>>;
  setCardTops: (tops: Record<string, number>) => void;
  setNotesMinHeight: (h: number) => void;
};

export function Reader({
  profile,
  roomPen,
  bookTitle,
  bookText,
  bookLoading,
  highlights,
  notes,
  roomJoinCode,
  onlineUsers,
  cardTops,
  notesMinHeight,
  replyDrafts,
  codeCopied,
  cloudLoading,
  onCopyJoinCode,
  onLeaveRoom,
  onReplyDraftChange,
  onSubmitReply,
  onDeleteNote,
  onDeleteReply,
  onMouseUp,
  bookRef,
  scrollRef,
  notesColumnRef,
  markRefs,
  cardRefs,
  setCardTops,
  setNotesMinHeight,
}: Props) {
  const textRuns = useMemo(
    () => buildTextRuns(bookText, highlights),
    [bookText, highlights],
  );

  // 手机端：点击高亮弹出便签
  const [mobileNotePopover, setMobileNotePopover] = useState<{
    note: Note;
    anchorEl: HTMLElement;
  } | null>(null);

  const handleHighlightClick = useCallback(
    (e: React.MouseEvent, noteId: string) => {
      // 只在手机端触发
      if (window.innerWidth >= 1024) return;
      const note = notes.find((n) => n.id === noteId);
      if (!note) return;
      const el = markRefs.current?.get(note.highlightId);
      if (!el) return;
      e.stopPropagation();
      setMobileNotePopover({ note, anchorEl: el });
    },
    [notes],
  );

  const relayoutCards = useCallback(() => {
    const column = notesColumnRef.current;
    const book = bookRef.current;
    if (!column || !book) return;

    const columnRect = column.getBoundingClientRect();

    const anchors = notes.map((note) => {
      const span = markRefs.current?.get(note.highlightId);
      let anchorY = 0;
      if (span) {
        const r = span.getBoundingClientRect();
        anchorY = r.top - columnRect.top;
      }
      return { id: note.id, anchorY };
    });

    const heights: Record<string, number> = {};
    cardRefs.current?.forEach((el, id) => {
      heights[id] = el.getBoundingClientRect().height;
    });

    setCardTops(stackCardTops(anchors, heights, GAP_BETWEEN_CARDS));
  }, [notes, bookRef, notesColumnRef, markRefs, cardRefs, setCardTops]);

  useEffect(() => {
    relayoutCards();
  }, [relayoutCards, bookText, highlights, textRuns, notes]);

  useEffect(() => {
    const ro = new ResizeObserver(() => {
      if (bookRef.current) {
        setNotesMinHeight(bookRef.current.offsetHeight);
      }
      relayoutCards();
    });
    if (bookRef.current) ro.observe(bookRef.current);
    if (notesColumnRef.current) ro.observe(notesColumnRef.current);
    cardRefs.current?.forEach((el) => ro.observe(el));

    return () => ro.disconnect();
  }, [relayoutCards, notes, bookRef, notesColumnRef, cardRefs, setNotesMinHeight]);

  return (
    <>
      {/* 顶部工具栏 */}
      <div className={`pointer-events-none fixed right-4 top-4 z-[55] sm:right-6 sm:top-6`}>
        <div className="pointer-events-auto flex flex-col items-end gap-2">
          {onlineUsers.length > 0 && <OnlineUsers users={onlineUsers} />}

          <div className="rounded-2xl border border-[#e0d9cc] bg-white/90 px-4 py-3 shadow-lg backdrop-blur-md">
            <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-[#9a9288]">
              房间邀请码
            </p>
            <p className="mt-1 font-mono text-2xl font-semibold tracking-[0.25em] text-[#2c2825]">
              {roomJoinCode || "------"}
            </p>
            <button
              type="button"
              onClick={onCopyJoinCode}
              className="mt-2 w-full rounded-lg bg-[#2c2825] px-3 py-1.5 text-xs text-white"
            >
              {codeCopied ? "已复制" : "复制邀请码"}
            </button>
          </div>
          <button
            type="button"
            onClick={onLeaveRoom}
            className="rounded-full border border-[#e0d9cc] bg-white/80 px-3 py-1.5 text-xs text-[#6b6560] shadow-sm hover:bg-white"
          >
            返回大厅
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="book-scroll h-full overflow-y-auto overflow-x-hidden"
      >
        <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-4 pb-10 pt-24 sm:px-6 lg:flex-row lg:gap-0 lg:px-10">
          {/* 书籍正文 */}
          <section className="min-w-0 w-full flex-1 lg:flex-[1.65] lg:pr-12">
            <header className="mb-10 border-b border-[#ddd5c8]/80 pb-6">
              <p className="text-[11px] font-medium uppercase tracking-[0.28em] text-[#9a9288]">
                S. · 共读房间
              </p>
              <h1 className="mt-2 font-serif text-3xl text-[#2c2825] sm:text-4xl">
                {bookLoading ? "加载중…" : bookTitle}
              </h1>
              {roomPen && (
                <p className="mt-2 text-xs text-[#6b6560]">
                  你的笔迹：
                  <span style={{ color: roomPen.color }} className="font-medium">
                    {roomPen.color}
                  </span>
                  {" · "}
                  {
                    LINE_STYLE_OPTIONS.find((o) => o.value === roomPen.lineStyle)
                      ?.label
                  }
                </p>
              )}
            </header>

            <div
              ref={bookRef}
              className="book-content w-full max-w-full break-words whitespace-pre-wrap font-serif text-[17px] leading-[1.85] text-[#2c2825] select-text"
              style={{ WebkitTouchCallout: "none" }}
              onMouseUp={onMouseUp}
            >
              {bookLoading ? (
                <p className="text-sm text-[#9a9288]">正在加载正文…</p>
              ) : highlights.length === 0 ? (
                bookText
              ) : (
                textRuns.map((run) => {
                  if (run.activeHighlights.length === 0) {
                    return (
                      <span key={`plain-${run.start}`} className="select-text">
                        {run.text}
                      </span>
                    );
                  }
                  return (
                    <span
                      key={`mark-${run.start}-${run.end}-${run.highlightIds.join("-")}`}
                      className="select-text"
                      ref={(el) => {
                        if (markRefs.current) {
                          for (const id of run.highlightIds) {
                            if (el) markRefs.current.set(id, el);
                            else markRefs.current.delete(id);
                          }
                        }
                      }}
                    >
                      {renderHighlightedText(run.text, run.activeHighlights, handleHighlightClick)}
                    </span>
                  );
                })
              )}
            </div>
          </section>

          {/* 边缘笔记栏 */}
          <aside className="min-w-0 w-full flex-1 border-t border-[#ddd5c8]/60 pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
            <p className="mb-6 text-[11px] font-medium uppercase tracking-[0.22em] text-[#9a9288]">
              边缘笔记
            </p>

            <div
              ref={notesColumnRef}
              className="relative w-full"
              style={{
                minHeight:
                  typeof window !== "undefined" && window.innerWidth < 1024
                    ? "auto"
                    : notesMinHeight || "100%",
              }}
            >
              {cloudLoading && (
                <p className="text-sm text-[#9a9288]">正在同步云端笔记…</p>
              )}
              {!cloudLoading && notes.length === 0 && (
                <p className="text-sm text-[#9a9288]">
                  划选左侧文字，写下第一条笔记。
                </p>
              )}

              {notes.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  profile={profile}
                  cardTop={cardTops[note.id] ?? 0}
                  replyDraft={replyDrafts[note.id] ?? ""}
                  onReplyDraftChange={onReplyDraftChange}
                  onSubmitReply={onSubmitReply}
                  onDeleteNote={onDeleteNote}
                  onDeleteReply={onDeleteReply}
                  cardRef={(el) => {
                    if (el) cardRefs.current?.set(note.id, el);
                    else cardRefs.current?.delete(note.id);
                  }}
                />
              ))}
            </div>
          </aside>
        </div>
      </div>

      {/* 手机端：点击高亮弹出的便签卡片 */}
      {mobileNotePopover && (
        <MobileNotePopover
          note={mobileNotePopover.note}
          profile={profile}
          anchorEl={mobileNotePopover.anchorEl}
          onClose={() => setMobileNotePopover(null)}
          replyDraft={replyDrafts[mobileNotePopover.note.id] ?? ""}
          onReplyDraftChange={onReplyDraftChange}
          onSubmitReply={onSubmitReply}
          onDeleteNote={onDeleteNote}
          onDeleteReply={onDeleteReply}
        />
      )}
    </>
  );
}
