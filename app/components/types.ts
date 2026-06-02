import type { DbNoteReply, LineStyle } from "@/lib/supabase";

/* ─── 本地存储类型 ─── */

export type UserProfile = {
  userId: string;
  name: string;
  lastNameChangeDate: string | null;
};

export type BookshelfEntry = {
  bookId: string;
  title: string;
  joinCode: string;
  addedAt: number;
};

export type RoomPen = {
  color: string;
  lineStyle: LineStyle;
};

export type Highlight = {
  id: string;
  startOffset: number;
  endOffset: number;
  text: string;
  userName: string;
  userColor: string;
  lineStyle: LineStyle;
};

export type Note = {
  id: string;
  highlightId: string;
  author: string;
  userColor: string;
  lineStyle: LineStyle;
  content: string;
  createdAt: number;
  replies: DbNoteReply[];
};

export type PopoverState = {
  x: number;
  y: number;
  startOffset: number;
  endOffset: number;
  text: string;
};

export type TextRun = {
  start: number;
  end: number;
  text: string;
  highlightIds: string[];
  activeHighlights: Highlight[];
};

export type OnlineUser = {
  userId: string;
  name: string;
  color: string;
};

export type ToastState = {
  message: string;
  visible: boolean;
};
