"use client";

import { useMemo, useEffect, useCallback, useState } from "react";
import type { Highlight, Note, RoomPen, UserProfile, OnlineUser } from "./types";
import { buildTextRuns, LINE_STYLE_OPTIONS } from "./utils";
import { renderHighlightedText } from "./HighlightedText";
import { OnlineUsers } from "./OnlineUsers";
import { NoteCard } from "./NoteCard";
import { MobileNotePopover } from "./MobileNotePopover";
import { GAP_BETWEEN_CARDS, stackCardTops } from "./utils";

type Props = {
  viewMode: "scroll" | "page";
  onToggleViewMode: () => void;
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
  viewMode,
  onToggleViewMode,
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

  const [mobileNotePopover, setMobileNotePopover] = useState<{
    note: Note;
    anchorEl: HTMLElement;
  } | null>(null);

  const [readProgress, setReadProgress] = useState(0);
  const [pageInfo, setPageInfo] = useState({ current: 1, total: 1 });
  const [menuOpen, setMenuOpen] = useState(false);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    let progress = 0;
    let current = 1;
    let total = 1;

    if (viewMode === "page") {
      const maxScroll = target.scrollWidth - target.clientWidth;
      progress = maxScroll > 0 ? (target.scrollLeft / maxScroll) * 100 : 0;
      total = Math.max(1, Math.ceil(target.scrollWidth / target.clientWidth));
      current = Math.min(Math.floor(target.scrollLeft / target.clientWidth) + 1, total);
    } else {
      const maxScroll = target.scrollHeight - target.clientHeight;
      progress = maxScroll > 0 ? (target.scrollTop / maxScroll) * 100 : 0;
      total = Math.max(1, Math.ceil(target.scrollHeight / target.clientHeight));
      current = Math.min(Math.floor(target.scrollTop / target.clientHeight) + 1, total);
    }

    setReadProgress(Math.max(0, Math.min(100, Math.round(progress))));
    setPageInfo({ current, total });
  }, [viewMode]);

  const handleHighlightClick = useCallback(
    (e: React.MouseEvent, noteId: string) => {
      if (window.innerWidth >= 1024) return;
      const note = notes.find((n) => n.id === noteId);
      if (!note) return;
      const el = markRefs.current?.get(note.highlightId);
      if (!el) return;
      e.stopPropagation();
      setMobileNotePopover({ note, anchorEl: el });
    },
    [notes, markRefs],
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

  // 手机端 touch 委托
  useEffect(() => {
    const bookEl = bookRef.current;
    if (!bookEl) return;

    const onTouchEnd = (e: TouchEvent) => {
      setTimeout(() => {
        const target = e.target as HTMLElement;
        const highlightSpan = target.closest("[data-highlight-id]") as HTMLElement | null;
        if (!highlightSpan) return;
        const highlightId = highlightSpan.dataset.highlightId;
        if (!highlightId) return;
        const mockEvent = { currentTarget: highlightSpan } as unknown as React.MouseEvent;
        handleHighlightClick(mockEvent, highlightId);
      }, 50);
    };

    bookEl.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => bookEl.removeEventListener("touchend", onTouchEnd);
  }, [bookRef, handleHighlightClick]);

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

  // 点击菜单外关闭
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = () => setMenuOpen(false);
    window.addEventListener("touchstart", onDown, { passive: true });
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("touchstart", onDown);
      window.removeEventListener("mousedown", onDown);
    };
  }, [menuOpen]);

  const progressText = viewMode === "page"
    ? `${pageInfo.current} / ${pageInfo.total} 页`
    : `阅读进度 · ${readProgress}%`;

  return (
    <>
      {/* 在线用户 - 独立显示在右上 */}
      <div className="fixed right-4 top-4 z-[55] pointer-events-none">
        <div className="pointer-events-auto">
          {onlineUsers.length > 0 && <OnlineUsers users={onlineUsers} />}
        </div>
      </div>

      <div
        ref={scrollRef}
        className="book-scroll h-full overflow-y-auto overflow-x-hidden"
        onScroll={viewMode === "scroll" ? handleScroll : undefined}
      >
        <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-4 pb-24 pt-24 sm:px-6 lg:flex-row lg:gap-0 lg:px-10">
          {/* 书籍正文 */}
          <section className="min-w-0 w-full flex-1 lg:flex-[1.65] lg:pr-12">
            <header className="mb-10 border-b border-[#ddd5c8]/80 pb-6">
              <p className="text-[11px] font-medium uppercase tracking-[0.28em] text-[#9a9288]">
                S. · 共读房间
              </p>
              <h1 className="mt-2 font-serif text-3xl text-[#2c2825] sm:text-4xl">
                {bookLoading ? "加载中…" : bookTitle}
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
              className={`book-content w-full max-w-full break-words whitespace-pre-wrap font-serif text-[17px] leading-[1.85] text-[#2c2825] select-text transition-all duration-300 ${viewMode === "page" ? "page-snap-container" : ""}`}
              style={{ WebkitTouchCallout: "none" }}
              onMouseUp={onMouseUp}
              onScroll={viewMode === "page" ? handleScroll : undefined}
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

      {/* === 苹果风格悬浮菜单 === */}
      <div className="fixed bottom-6 left-1/2 z-[90] -translate-x-1/2">
        {/* 展开的菜单面板 */}
        {menuOpen && (
          <div
            className="mb-3 rounded-2xl border border-[#e0d9cc]/60 bg-white/95 shadow-xl backdrop-blur-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 进度 */}
            <div className="border-b border-[#e0d9cc]/40 px-5 py-3 text-center">
              <p className="text-[13px] font-medium text-[#2c2825]">{progressText}</p>
              <div className="mt-1.5 h-1 w-full rounded-full bg-[#e8e2d6]">
                <div
                  className="h-full rounded-full bg-[#2c2825] transition-all duration-300"
                  style={{ width: `${Math.min(100, readProgress)}%` }}
                />
              </div>
            </div>

            {/* 邀请码 */}
            <div className="border-b border-[#e0d9cc]/40 px-5 py-3">
              <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[#9a9288]">
                邀请码
              </p>
              <div className="mt-1 flex items-center gap-2">
                <span className="font-mono text-lg font-semibold tracking-[0.2em] text-[#2c2825]">
                  {roomJoinCode || "------"}
                </span>
                <button
                  type="button"
                  onClick={onCopyJoinCode}
                  className="rounded-lg bg-[#2c2825] px-2.5 py-1 text-[11px] text-white"
                >
                  {codeCopied ? "已复制" : "复制"}
                </button>
              </div>
            </div>

            {/* 功能按钮 */}
            <div className="flex items-center gap-1 px-2 py-2">
              <button
                type="button"
                onClick={onToggleViewMode}
                className="flex-1 rounded-xl px-3 py-2 text-[12px] font-medium text-[#2c2825] hover:bg-[#e8e2d6]/60 transition-colors"
              >
                {viewMode === "scroll" ? "📖 翻页" : "📜 滚动"}
              </button>
              <button
                type="button"
                onClick={onLeaveRoom}
                className="flex-1 rounded-xl px-3 py-2 text-[12px] font-medium text-[#6b6560] hover:bg-[#e8e2d6]/60 transition-colors"
              >
                🚪 退出
              </button>
            </div>
          </div>
        )}

        {/* 悬浮按钮 */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className="flex items-center gap-2 rounded-full border border-[#e0d9cc]/60 bg-white/95 px-5 py-2.5 shadow-lg backdrop-blur-xl hover:bg-white active:scale-95 transition-all"
        >
          <span className="text-sm font-medium text-[#2c2825]">
            {menuOpen ? "✕" : "⋯"}
          </span>
          <span className="text-[11px] text-[#8a8278]">{progressText}</span>
        </button>
      </div>
    </>
  );
}
