"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  supabase,
  type DbNoteReply,
  type DbNoteRow,
  type DbRoomMemberRow,
  type LineStyle,
} from "@/lib/supabase";

/* ─── 本地存储类型 ─── */

type UserProfile = {
  userId: string;
  name: string;
  lastNameChangeDate: string | null;
};

type BookshelfEntry = {
  bookId: string;
  title: string;
  joinCode: string;
  addedAt: number;
};

type RoomPen = {
  color: string;
  lineStyle: LineStyle;
};

type Highlight = {
  id: string;
  startOffset: number;
  endOffset: number;
  text: string;
  userName: string;
  userColor: string;
  lineStyle: LineStyle;
};

type Note = {
  id: string;
  highlightId: string;
  author: string;
  userColor: string;
  lineStyle: LineStyle;
  content: string;
  createdAt: number;
  replies: DbNoteReply[];
};

type PopoverState = {
  x: number;
  y: number;
  startOffset: number;
  endOffset: number;
  text: string;
};

const USER_PROFILE_KEY = "userProfile";
const MY_BOOKS_KEY = "myBooks";
const ACTIVE_BOOK_KEY = "activeBookId";
const DEFAULT_PEN_COLOR = "#2563eb";
const JOIN_CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const GAP_BETWEEN_CARDS = 10;
const RENAME_COOLDOWN_DAYS = 365;

const LINE_STYLE_OPTIONS: { value: LineStyle; label: string }[] = [
  { value: "wavy", label: "波浪" },
  { value: "solid", label: "直线" },
  { value: "dashed", label: "虚线" },
];

/* ─── 工具函数 ─── */

function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.txt$/i, "").trim() || "未命名书籍";
}

function normalizeColor(color: string | null | undefined): string {
  if (!color?.trim()) return DEFAULT_PEN_COLOR;
  return color.trim();
}

function generateJoinCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += JOIN_CODE_CHARS[Math.floor(Math.random() * JOIN_CODE_CHARS.length)]!;
  }
  return code;
}

function normalizeJoinCodeInput(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 6);
}

function generateUserId(): string {
  return crypto.randomUUID();
}

function penComboKey(color: string, lineStyle: LineStyle): string {
  return `${normalizeColor(color).toLowerCase()}:${lineStyle}`;
}

function loadUserProfile(): UserProfile | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(USER_PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UserProfile>;
    if (!parsed.userId || !parsed.name?.trim()) return null;
    return {
      userId: parsed.userId,
      name: parsed.name.trim(),
      lastNameChangeDate: parsed.lastNameChangeDate ?? null,
    };
  } catch {
    return null;
  }
}

function saveUserProfile(profile: UserProfile) {
  localStorage.setItem(USER_PROFILE_KEY, JSON.stringify(profile));
}

function loadMyBooks(): BookshelfEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(MY_BOOKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as BookshelfEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveMyBooks(books: BookshelfEntry[]) {
  localStorage.setItem(MY_BOOKS_KEY, JSON.stringify(books));
}

function addToMyBooks(entry: Omit<BookshelfEntry, "addedAt">) {
  const books = loadMyBooks().filter((b) => b.bookId !== entry.bookId);
  books.unshift({ ...entry, addedAt: Date.now() });
  saveMyBooks(books);
}

function removeFromMyBooksStorage(bookId: string): BookshelfEntry[] {
  const books = loadMyBooks().filter((b) => b.bookId !== bookId);
  saveMyBooks(books);
  return books;
}

function canRenameProfile(profile: UserProfile): boolean {
  if (!profile.lastNameChangeDate) return true;
  const last = new Date(profile.lastNameChangeDate).getTime();
  const elapsed = Date.now() - last;
  return elapsed >= RENAME_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
}

function daysUntilRenameAllowed(profile: UserProfile): number {
  if (!profile.lastNameChangeDate) return 0;
  const last = new Date(profile.lastNameChangeDate).getTime();
  const next = last + RENAME_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((next - Date.now()) / (24 * 60 * 60 * 1000)));
}

function parseReplies(raw: unknown): DbNoteReply[] {
  if (raw == null) return [];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as DbNoteReply[]) : [];
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw as DbNoteReply[];
}

function rangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && aEnd > bStart;
}

function buildStyleMapFromMembers(
  members: DbRoomMemberRow[],
): Map<string, { color: string; lineStyle: LineStyle }> {
  const map = new Map<string, { color: string; lineStyle: LineStyle }>();
  for (const m of members) {
    map.set(m.user_name, {
      color: normalizeColor(m.color),
      lineStyle: m.line_style,
    });
  }
  return map;
}

function mapRowsToState(
  rows: DbNoteRow[],
  bookText: string,
  styleByUserName: Map<string, { color: string; lineStyle: LineStyle }>,
): { highlights: Highlight[]; notes: Note[] } {
  const highlights: Highlight[] = [];
  const notes: Note[] = [];

  for (const row of rows) {
    const id = String(row.id);
    const startOffset = row.start_index;
    const endOffset = row.end_index;
    const style = styleByUserName.get(row.user_name);
    const userColor = normalizeColor(row.user_color ?? style?.color);
    
    const lineStyle = (row as any).line_style ?? style?.lineStyle ?? "wavy";
    
    const quote =
      row.quote?.trim() ||
      bookText.slice(startOffset, endOffset) ||
      "";

    highlights.push({
      id,
      startOffset,
      endOffset,
      text: quote,
      userName: row.user_name,
      userColor,
      lineStyle,
    });

    notes.push({
      id,
      highlightId: id,
      author: row.user_name,
      userColor,
      lineStyle,
      content: row.content,
      createdAt: new Date(row.created_at).getTime(),
      replies: parseReplies(row.replies),
    });
  }

  return { highlights, notes };
}

type TextRun = {
  start: number;
  end: number;
  text: string;
  highlightIds: string[];
  activeHighlights: Highlight[];
};

function buildTextRuns(text: string, highlights: Highlight[]): TextRun[] {
  if (!text.length) return [];

  const boundaries = new Set<number>([0, text.length]);
  for (const h of highlights) {
    boundaries.add(Math.max(0, Math.min(h.startOffset, text.length)));
    boundaries.add(Math.max(0, Math.min(h.endOffset, text.length)));
  }

  const points = [...boundaries].sort((a, b) => a - b);
  const runs: TextRun[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]!;
    const end = points[i + 1]!;
    if (start >= end) continue;

    const activeHighlights = highlights.filter(
      (h) => h.startOffset < end && h.endOffset > start,
    );

    runs.push({
      start,
      end,
      text: text.slice(start, end),
      highlightIds: activeHighlights.map((h) => h.id),
      activeHighlights,
    });
  }

  return runs;
}

function textDecorationForStyle(style: LineStyle): string {
  switch (style) {
    case "solid":
      return "underline solid";
    case "dashed":
      return "underline dashed";
    default:
      return "underline wavy";
  }
}

function renderHighlightedText(
  text: string,
  activeHighlights: Highlight[],
): ReactNode {
  if (activeHighlights.length === 0) return text;

  return activeHighlights.reduceRight<ReactNode>((child, h, index) => {
    return (
      <span
        key={h.id}
        style={{
          textDecoration: textDecorationForStyle(h.lineStyle),
          textDecorationColor: h.userColor,
          textDecorationThickness: "2px",
          textUnderlineOffset: `${4 + index * 5}px`,
          background: "transparent",
        }}
      >
        {child}
      </span>
    );
  }, text);
}

function getOffsetWithin(root: HTMLElement, node: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}

function stackCardTops(
  items: { id: string; anchorY: number }[],
  heights: Record<string, number>,
  gap: number,
): Record<string, number> {
  const sorted = [...items].sort((a, b) => a.anchorY - b.anchorY);
  const tops: Record<string, number> = {};
  const occupied: { top: number; bottom: number }[] = [];

  for (const item of sorted) {
    const h = heights[item.id] ?? 72;
    let top = item.anchorY;

    const collides = (t: number) =>
      occupied.some((o) => t < o.bottom && t + h > o.top);

    while (collides(top)) {
      const blockers = occupied.filter((o) => top < o.bottom && top + h > o.top);
      top = Math.max(...blockers.map((o) => o.bottom)) + gap;
    }

    tops[item.id] = top;
    occupied.push({ top, bottom: top + h });
    occupied.sort((a, b) => a.top - b.top);
  }

  return tops;
}

/* ─── 主组件 ─── */

function ReadingApp() {
  const [authChecked, setAuthChecked] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [identityName, setIdentityName] = useState("");

  const [myBooks, setMyBooks] = useState<BookshelfEntry[]>([]);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameMessage, setRenameMessage] = useState("");

  const [activeBookId, setActiveBookId] = useState<string | null>(null);
  const [pendingBookId, setPendingBookId] = useState<string | null>(null);
  const [roomPen, setRoomPen] = useState<RoomPen | null>(null);
  const [showPenModal, setShowPenModal] = useState(false);
  const [roomMembers, setRoomMembers] = useState<DbRoomMemberRow[]>([]);
  const [penColor, setPenColor] = useState(DEFAULT_PEN_COLOR);
  const [penLineStyle, setPenLineStyle] = useState<LineStyle>("wavy");
  const [penSubmitting, setPenSubmitting] = useState(false);
  const [memberStyleMap, setMemberStyleMap] = useState<
    Map<string, { color: string; lineStyle: LineStyle }>
  >(new Map());

  const [roomJoinCode, setRoomJoinCode] = useState("");
  const [lobbyJoinInput, setLobbyJoinInput] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState("");
  const [codeCopied, setCodeCopied] = useState(false);

  const [bookTitle, setBookTitle] = useState("");
  const [bookText, setBookText] = useState("");
  const [bookLoading, setBookLoading] = useState(false);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [draft, setDraft] = useState("");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [cardTops, setCardTops] = useState<Record<string, number>>({});
  const [notesMinHeight, setNotesMinHeight] = useState(0);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [importing, setImporting] = useState(false);
  
  // 新增状态
  const [restoredScroll, setRestoredScroll] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState<{ userId: string; name: string; color: string }[]>([]);
  const [toast, setToast] = useState<{ message: string; visible: boolean }>({ message: "", visible: false });

  const bookRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const notesColumnRef = useRef<HTMLDivElement>(null);
  const markRefs = useRef<Map<string, HTMLSpanElement>>(new Map());
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bookTextRef = useRef(bookText);
  const bookIdRef = useRef(activeBookId);
  const memberStyleMapRef = useRef(memberStyleMap);
  const relayoutCardsRef = useRef<() => void>(() => {});
  const sessionRestoredRef = useRef(false);
  const toastTimeoutRef = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    if (toastTimeoutRef.current) window.clearTimeout(toastTimeoutRef.current);
    setToast({ message: msg, visible: true });
    toastTimeoutRef.current = window.setTimeout(() => {
      setToast((prev) => ({ ...prev, visible: false }));
    }, 3000);
  }, []);

  useEffect(() => {
    bookTextRef.current = bookText;
  }, [bookText]);

  useEffect(() => {
    bookIdRef.current = activeBookId;
  }, [activeBookId]);

  useEffect(() => {
    memberStyleMapRef.current = memberStyleMap;
  }, [memberStyleMap]);

  useEffect(() => {
    const saved = loadUserProfile();
    if (saved) setProfile(saved);
    setMyBooks(loadMyBooks());
    setAuthChecked(true);
  }, []);

  const refreshMyBooks = useCallback(() => {
    setMyBooks(loadMyBooks());
  }, []);

  const handleIdentitySubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const name = identityName.trim();
      if (!name) return;
      const newProfile: UserProfile = {
        userId: generateUserId(),
        name,
        lastNameChangeDate: null,
      };
      saveUserProfile(newProfile);
      setProfile(newProfile);
      showToast(`欢迎回来，${name}`);
    },
    [identityName, showToast],
  );

  const openRenameModal = useCallback(() => {
    if (!profile) return;
    setRenameDraft(profile.name);
    setRenameMessage("");
    setShowRenameModal(true);
  }, [profile]);

  const handleRenameSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!profile) return;
      const nextName = renameDraft.trim();
      if (!nextName) return;

      if (!canRenameProfile(profile)) {
        setRenameMessage(
          `每年只能修改一次名字。还需等待约 ${daysUntilRenameAllowed(profile)} 天。`,
        );
        return;
      }

      const updated: UserProfile = {
        ...profile,
        name: nextName,
        lastNameChangeDate: new Date().toISOString(),
      };
      saveUserProfile(updated);
      setProfile(updated);
      setShowRenameModal(false);
      setRenameMessage("");
      showToast("名字修改成功");
    },
    [profile, renameDraft, showToast],
  );

  const textRuns = useMemo(
    () => buildTextRuns(bookText, highlights),
    [bookText, highlights],
  );

  const relayoutCards = useCallback(() => {
    const column = notesColumnRef.current;
    const book = bookRef.current;
    if (!column || !book) return;

    const columnRect = column.getBoundingClientRect();

    const anchors = notes.map((note) => {
      const span = markRefs.current.get(note.highlightId);
      let anchorY = 0;
      if (span) {
        const r = span.getBoundingClientRect();
        anchorY = r.top - columnRect.top;
      }
      return { id: note.id, anchorY };
    });

    const heights: Record<string, number> = {};
    cardRefs.current.forEach((el, id) => {
      heights[id] = el.getBoundingClientRect().height;
    });

    setCardTops(stackCardTops(anchors, heights, GAP_BETWEEN_CARDS));
  }, [notes]);

  relayoutCardsRef.current = relayoutCards;

  const scheduleRelayout = useCallback(() => {
    requestAnimationFrame(() => {
      relayoutCardsRef.current();
      requestAnimationFrame(() => relayoutCardsRef.current());
    });
  }, []);

  const scheduleRelayoutDelayed = useCallback(() => {
    window.setTimeout(() => {
      relayoutCardsRef.current();
    }, 100);
  }, []);

  useLayoutEffect(() => {
    relayoutCards();
  }, [relayoutCards, bookText, highlights, textRuns, notes]);

  useEffect(() => {
    if (!bookLoading && activeBookId && !restoredScroll) {
      const savedScroll = localStorage.getItem(`scroll_${activeBookId}`);
      if (savedScroll && scrollRef.current) {
        scrollRef.current.scrollTop = Number(savedScroll);
      }
      setRestoredScroll(true);
    }
  }, [bookLoading, activeBookId, restoredScroll]);

  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    let timeoutId: number;
    const onScroll = () => {
      if (activeBookId) {
        if (timeoutId) window.clearTimeout(timeoutId);
        timeoutId = window.setTimeout(() => {
          localStorage.setItem(`scroll_${activeBookId}`, String(scrollEl.scrollTop));
        }, 300);
      }
      relayoutCards();
    };

    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", relayoutCards);

    const ro = new ResizeObserver(() => {
      if (bookRef.current) {
        setNotesMinHeight(bookRef.current.offsetHeight);
      }
      relayoutCards();
    });
    if (bookRef.current) ro.observe(bookRef.current);
    if (notesColumnRef.current) ro.observe(notesColumnRef.current);
    cardRefs.current.forEach((el) => ro.observe(el));

    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", relayoutCards);
      ro.disconnect();
    };
  }, [relayoutCards, notes, activeBookId]);

  const closePopover = useCallback(() => {
    setPopover(null);
    setDraft("");
    window.getSelection()?.removeAllRanges();
  }, []);

  const finalizeEnterRoom = useCallback(
    (bookId: string, pen: RoomPen, members: DbRoomMemberRow[]) => {
      sessionStorage.setItem(ACTIVE_BOOK_KEY, bookId);
      setActiveBookId(bookId);
      setRoomPen(pen);
      setMemberStyleMap(buildStyleMapFromMembers(members));
      setPendingBookId(null);
      setShowPenModal(false);
      setPenSubmitting(false);
      showToast("已连接到共读时空");
    },
    [showToast],
  );

  const beginEnterRoom = useCallback(
    async (
      bookId: string,
      bookshelfMeta?: { title: string; joinCode: string },
    ) => {
      if (!profile) return;

      if (bookshelfMeta) {
        addToMyBooks({
          bookId,
          title: bookshelfMeta.title,
          joinCode: bookshelfMeta.joinCode,
        });
        refreshMyBooks();
      }

      setPendingBookId(bookId);
      setJoinError("");
      setRestoredScroll(false); 

      const { data: members, error } = await supabase
        .from("room_members")
        .select("*")
        .eq("book_id", bookId);

      if (error) {
        console.error("room_members fetch failed:", error);
        setPendingBookId(null);
        return;
      }

      const list = (members ?? []) as DbRoomMemberRow[];
      setRoomMembers(list);

      const existing = list.find((m) => m.user_id === profile.userId);
      if (existing) {
        finalizeEnterRoom(
          bookId,
          {
            color: normalizeColor(existing.color),
            lineStyle: existing.line_style,
          },
          list,
        );
        return;
      }

      const occupied = new Set(
        list.map((m) => penComboKey(m.color, m.line_style)),
      );
      let defaultColor = DEFAULT_PEN_COLOR;
      let defaultStyle: LineStyle = "wavy";
      for (const style of ["wavy", "solid", "dashed"] as LineStyle[]) {
        const palette = [
          "#2563eb",
          "#dc2626",
          "#16a34a",
          "#9333ea",
          "#ea580c",
          "#0891b2",
        ];
        const found = palette.find((c) => !occupied.has(penComboKey(c, style)));
        if (found) {
          defaultColor = found;
          defaultStyle = style;
          break;
        }
      }

      setPenColor(defaultColor);
      setPenLineStyle(defaultStyle);
      setShowPenModal(true);
    },
    [profile, finalizeEnterRoom, refreshMyBooks],
  );

  useEffect(() => {
    if (!authChecked || !profile || sessionRestoredRef.current) return;
    sessionRestoredRef.current = true;
    const saved = sessionStorage.getItem(ACTIVE_BOOK_KEY);
    if (saved) void beginEnterRoom(saved);
  }, [authChecked, profile, beginEnterRoom]);

  const occupiedPenKeys = useMemo(() => {
    return new Set(
      roomMembers.map((m) => penComboKey(m.color, m.line_style)),
    );
  }, [roomMembers]);

  const penSelectionConflict = occupiedPenKeys.has(
    penComboKey(penColor, penLineStyle),
  );

  const confirmPenSelection = useCallback(async () => {
    if (!profile || !pendingBookId || penSelectionConflict || penSubmitting) {
      return;
    }

    setPenSubmitting(true);

    const { error } = await supabase.from("room_members").insert({
      book_id: pendingBookId,
      user_id: profile.userId,
      user_name: profile.name,
      color: penColor,
      line_style: penLineStyle,
    });

    if (error) {
      console.error("room_members insert failed:", error);
      setPenSubmitting(false);
      return;
    }

    const newMember: DbRoomMemberRow = {
      book_id: pendingBookId,
      user_id: profile.userId,
      user_name: profile.name,
      color: penColor,
      line_style: penLineStyle,
    };

    const updatedMembers = [...roomMembers, newMember];
    setRoomMembers(updatedMembers);
    finalizeEnterRoom(
      pendingBookId,
      { color: penColor, lineStyle: penLineStyle },
      updatedMembers,
    );
  }, [
    profile,
    pendingBookId,
    penSelectionConflict,
    penSubmitting,
    penColor,
    penLineStyle,
    roomMembers,
    finalizeEnterRoom,
  ]);

  const leaveRoom = useCallback(() => {
    sessionStorage.removeItem(ACTIVE_BOOK_KEY);
    setActiveBookId(null);
    setPendingBookId(null);
    setRoomPen(null);
    setRoomJoinCode("");
    setBookTitle("");
    setBookText("");
    setHighlights([]);
    setNotes([]);
    setCardTops({});
    setRoomMembers([]);
    setOnlineUsers([]);
    setShowPenModal(false);
    closePopover();
  }, [closePopover]);

  const handleRemoveFromBookshelf = useCallback(
    async (bookId: string) => {
      if (!profile) return;

      const { error } = await supabase
        .from("room_members")
        .delete()
        .match({ book_id: bookId, user_id: profile.userId });

      if (error) {
        console.error("room_members delete failed:", error);
        showToast("移除失败，请重试");
        return;
      }

      setMyBooks(removeFromMyBooksStorage(bookId));
      showToast("已从书架移除");

      if (activeBookId === bookId) {
        leaveRoom();
      }
    },
    [profile, activeBookId, leaveRoom, showToast],
  );

  const copyJoinCode = useCallback(async () => {
    if (!roomJoinCode) return;
    try {
      await navigator.clipboard.writeText(roomJoinCode);
      setCodeCopied(true);
      showToast("邀请码已复制到剪贴板");
      window.setTimeout(() => setCodeCopied(false), 2000);
    } catch {
      showToast("复制失败");
    }
  }, [roomJoinCode, showToast]);

  const handleMouseUp = useCallback(() => {
    if (!profile || !activeBookId || !roomPen) return;
    const root = bookRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.isCollapsed || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;

    const selected = range.toString().trim();
    if (!selected) return;

    const startOffset = getOffsetWithin(
      root,
      range.startContainer,
      range.startOffset,
    );
    const endOffset = getOffsetWithin(
      root,
      range.endContainer,
      range.endOffset,
    );

    const overlapsExisting = highlights.some((h) =>
      rangesOverlap(startOffset, endOffset, h.startOffset, h.endOffset),
    );
    if (overlapsExisting) {
      window.getSelection()?.removeAllRanges();
      showToast("此处已有专属笔记，请在右侧参与盖楼哦！");
      return;
    }

    const rect = range.getBoundingClientRect();
    setPopover({
      x: rect.left + rect.width / 2,
      y: rect.top,
      startOffset,
      endOffset,
      text: selected,
    });
    setDraft("");
  }, [highlights, profile, activeBookId, roomPen, showToast]);

  const submitNote = useCallback(async () => {
    if (
      !popover ||
      !draft.trim() ||
      submitting ||
      !profile ||
      !activeBookId ||
      !roomPen
    ) {
      return;
    }

    setSubmitting(true);
    const content = draft.trim();

    const { data, error } = await supabase
      .from("notes")
      .insert({
        book_id: activeBookId,
        start_index: popover.startOffset,
        end_index: popover.endOffset,
        user_name: profile.name,
        user_color: roomPen.color,
        line_style: roomPen.lineStyle,
        content,
        quote: popover.text,
        replies: [],
      })
      .select()
      .single();

    setSubmitting(false);

    if (error || !data) {
      console.error("Supabase insert failed:", error);
      showToast("笔记保存失败");
      return;
    }

    const row = data as DbNoteRow;
    const styleMap = new Map(memberStyleMapRef.current);
    styleMap.set(profile.name, {
      color: roomPen.color,
      lineStyle: roomPen.lineStyle,
    });
    const mapped = mapRowsToState([row], bookText, styleMap);
    setMemberStyleMap(styleMap);
    setHighlights((prev) => [...prev, ...mapped.highlights]);
    setNotes((prev) => [...prev, ...mapped.notes]);
    closePopover();
    showToast("笔记成功记录在边缘");
  }, [
    popover,
    draft,
    closePopover,
    submitting,
    bookText,
    profile,
    activeBookId,
    roomPen,
    showToast,
  ]);

  const submitReply = useCallback(
    async (noteId: string) => {
      const text = replyDrafts[noteId]?.trim();
      if (!text || !profile || !roomPen) return;

      const note = notes.find((n) => n.id === noteId);
      if (!note) return;

      const newReply: DbNoteReply = {
        id: crypto.randomUUID(),
        user_id: profile.userId,
        user_name: profile.name,
        user_color: roomPen.color,
        content: text,
        created_at: new Date().toISOString(),
      };

      const updatedReplies = [...note.replies, newReply];

      const { error } = await supabase
        .from("notes")
        .update({ replies: updatedReplies })
        .eq("id", noteId);

      if (error) {
        console.error("Reply update failed:", error);
        showToast("回复发送失败");
        return;
      }

      setNotes((prev) =>
        prev.map((n) =>
          n.id === noteId ? { ...n, replies: updatedReplies } : n,
        ),
      );
      setReplyDrafts((prev) => ({ ...prev, [noteId]: "" }));
      scheduleRelayoutDelayed();
    },
    [replyDrafts, profile, roomPen, notes, scheduleRelayoutDelayed, showToast],
  );

  const handleDeleteNote = useCallback(
    async (noteId: string) => {
      if (!confirm("确定要撕掉这张边缘笔记吗？所有回复也会被一并销毁。")) return;

      const { error } = await supabase.from("notes").delete().eq("id", noteId);
      if (error) {
        console.error("Delete note failed:", error);
        showToast("删除失败");
        return;
      }

      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      setHighlights((prev) => prev.filter((h) => h.id !== noteId));
      scheduleRelayoutDelayed();
      showToast("笔记已从时空抹去");
    },
    [scheduleRelayoutDelayed, showToast]
  );

  const handleDeleteReply = useCallback(
    async (noteId: string, replyId: string) => {
      if (!confirm("确定要撤回这条回复吗？")) return;

      const note = notes.find((n) => n.id === noteId);
      if (!note) return;

      const updatedReplies = note.replies.filter((r) => r.id !== replyId);

      const { error } = await supabase
        .from("notes")
        .update({ replies: updatedReplies })
        .eq("id", noteId);

      if (error) {
        console.error("Delete reply failed:", error);
        showToast("撤回失败");
        return;
      }

      setNotes((prev) =>
        prev.map((n) =>
          n.id === noteId ? { ...n, replies: updatedReplies } : n
        )
      );
      scheduleRelayoutDelayed();
      showToast("回复已撤回");
    },
    [notes, scheduleRelayoutDelayed, showToast]
  );

  const applyNoteInsertFromRealtime = useCallback(
    (row: DbNoteRow) => {
      const rowId = String(row.id);
      const styleMap = memberStyleMapRef.current;
      const mapped = mapRowsToState([row], bookTextRef.current, styleMap);
      const note = mapped.notes[0];
      const highlight = mapped.highlights[0];
      if (!note || !highlight) return;

      setHighlights((prev) => {
        if (prev.some((h) => h.id === rowId)) return prev;
        return [...prev, highlight];
      });

      setNotes((prev) => {
        if (prev.some((n) => n.id === rowId)) return prev;
        return [...prev, note];
      });

      scheduleRelayout();
    },
    [scheduleRelayout],
  );

  const applyNoteUpdateFromRealtime = useCallback(
    (row: DbNoteRow) => {
      const rowId = String(row.id);

      setNotes((prev) => {
        const exists = prev.find((n) => String(n.id) === rowId);
        if (!exists) return prev; 

        const updatedReplies =
          row.replies !== undefined ? parseReplies(row.replies) : exists.replies;

        return prev.map((n) =>
          String(n.id) === rowId ? { ...n, replies: updatedReplies } : n
        );
      });

      scheduleRelayoutDelayed();
    },
    [scheduleRelayoutDelayed]
  );

  // 实时在线Presence监听
  useEffect(() => {
    if (!activeBookId || !profile || !roomPen) {
      setOnlineUsers([]);
      return;
    }

    const presenceChannel = supabase.channel(`presence-${activeBookId}`, {
      config: { presence: { key: profile.userId } },
    });

    presenceChannel
      .on("presence", { event: "sync" }, () => {
        const state = presenceChannel.presenceState();
        const users: { userId: string; name: string; color: string }[] = [];
        for (const key in state) {
          const presences = state[key] as any[];
          if (presences && presences.length > 0) {
            users.push({
              userId: key,
              name: presences[0].name,
              color: presences[0].color,
            });
          }
        }
        setOnlineUsers(users);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await presenceChannel.track({
            name: profile.name,
            color: roomPen.color,
          });
        }
      });

    return () => {
      void supabase.removeChannel(presenceChannel);
    };
  }, [activeBookId, profile, roomPen]);

  useEffect(() => {
    if (!activeBookId || !profile || !roomPen) {
      if (!activeBookId) {
        setHighlights([]);
        setNotes([]);
      }
      setCloudLoading(false);
      return;
    }

    let cancelled = false;

    async function loadBookAndNotes() {
      setBookLoading(true);
      setCloudLoading(true);
      closePopover();

      const { data: book, error: bookError } = await supabase
        .from("books")
        .select("id, title, content, join_code")
        .eq("id", activeBookId)
        .single();

      if (cancelled) return;

      if (bookError || !book) {
        console.error("Supabase book fetch failed:", bookError);
        setBookLoading(false);
        setCloudLoading(false);
        return;
      }

      const content = book.content ?? "";
      setBookTitle(book.title ?? "未命名书籍");
      setRoomJoinCode((book.join_code ?? "").toUpperCase());
      setBookText(content);
      bookTextRef.current = content;

      const { data: members } = await supabase
        .from("room_members")
        .select("*")
        .eq("book_id", activeBookId);

      const styleMap = buildStyleMapFromMembers(
        (members ?? []) as DbRoomMemberRow[],
      );
      if (!cancelled) setMemberStyleMap(styleMap);

      const { data: noteRows, error: notesError } = await supabase
        .from("notes")
        .select("*")
        .eq("book_id", activeBookId)
        .order("created_at", { ascending: true });

      if (cancelled) return;

      if (notesError) {
        console.error("Supabase notes fetch failed:", notesError);
        setHighlights([]);
        setNotes([]);
      } else {
        const mapped = mapRowsToState(
          (noteRows ?? []) as DbNoteRow[],
          content,
          styleMap,
        );
        setHighlights(mapped.highlights);
        setNotes(mapped.notes);
      }

      setBookLoading(false);
      setCloudLoading(false);
    }

    void loadBookAndNotes();

    const channel = supabase
      .channel(`notes-sync-${activeBookId}`)
      .on(
        "postgres_changes",
        {
          event: "*", 
          schema: "public",
          table: "notes",
        },
        (payload) => {
          const row = payload.new as DbNoteRow | undefined;
          
          if (payload.eventType === "INSERT" && row?.id) {
            if (String(row.book_id) !== bookIdRef.current) return;
            applyNoteInsertFromRealtime(row);
          } else if (payload.eventType === "UPDATE" && row?.id) {
            applyNoteUpdateFromRealtime(row);
          } else if (payload.eventType === "DELETE") {
            const deletedId = String(payload.old?.id);
            if (!deletedId) return;
            setNotes((prev) => prev.filter((n) => String(n.id) !== deletedId));
            setHighlights((prev) => prev.filter((h) => String(h.id) !== deletedId));
            scheduleRelayoutDelayed();
          }
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [
    activeBookId,
    profile,
    roomPen,
    scheduleRelayoutDelayed,
    closePopover,
    applyNoteInsertFromRealtime,
    applyNoteUpdateFromRealtime,
  ]);

  const handleJoinRoom = useCallback(async () => {
    const code = normalizeJoinCodeInput(lobbyJoinInput);
    if (code.length !== 6) {
      setJoinError("请输入 6 位邀请码");
      return;
    }

    setJoining(true);
    setJoinError("");

    const { data, error = null } = await supabase
      .from("books")
      .select("id, title, join_code")
      .eq("join_code", code)
      .maybeSingle();

    setJoining(false);

    if (error || !data?.id) {
      setJoinError("邀请码无效，请检查后重试");
      return;
    }

    setLobbyJoinInput("");
    await beginEnterRoom(String(data.id), {
      title: data.title ?? "未命名书籍",
      joinCode: (data.join_code ?? code).toUpperCase(),
    });
  }, [lobbyJoinInput, beginEnterRoom]);

  const handleImportTxt = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || importing) return;

      setImporting(true);
      const reader = new FileReader();

      reader.onload = async () => {
        const content = String(reader.result ?? "");
        const title = titleFromFileName(file.name);

        let inserted: { id: string; join_code: string } | null = null;

        for (let attempt = 0; attempt < 5; attempt++) {
          const join_code = generateJoinCode();
          const { data, error } = await supabase
            .from("books")
            .insert({ title, content, join_code })
            .select("id, join_code")
            .single();

          if (!error && data?.id) {
            inserted = { id: String(data.id), join_code: data.join_code };
            break;
          }
        }

        setImporting(false);
        e.target.value = "";

        if (!inserted) {
          console.error("Supabase book insert failed after retries");
          showToast("上传失败，请重试");
          return;
        }

        await beginEnterRoom(inserted.id, {
          title,
          joinCode: inserted.join_code.toUpperCase(),
        });
      };

      reader.onerror = () => {
        setImporting(false);
        e.target.value = "";
        showToast("TXT 读取失败");
      };

      reader.readAsText(file, "UTF-8");
    },
    [importing, beginEnterRoom, showToast],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePopover();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closePopover]);

  const showIdentityGate = authChecked && !profile;
  const showLobby = authChecked && profile && !activeBookId && !showPenModal;
  const showReader = authChecked && profile && !!activeBookId && !!roomPen;

  return (
    <div
      className="relative h-screen w-full overflow-hidden"
      style={{
        background:
          "linear-gradient(165deg, #f7f3eb 0%, #efe9dd 45%, #e9e2d4 100%)",
      }}
    >
      {/* 首次身份：仅名字 */}
      {showIdentityGate && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#f3efe6]/95 px-6 backdrop-blur-md">
          <form
            onSubmit={handleIdentitySubmit}
            className="w-full max-w-md rounded-3xl border border-[#e0d9cc] bg-white/90 p-8 shadow-2xl shadow-black/10"
          >
            <p className="text-[11px] font-medium uppercase tracking-[0.28em] text-[#9a9288]">
              S. · 时空共读
            </p>
            <h2 className="mt-3 font-serif text-2xl text-[#2c2825]">
              建立你的全局身份
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-[#6b6560]">
              输入名字即可开始。进入房间后将选择专属笔迹。
            </p>
            <label className="mt-8 block text-xs font-medium text-[#6b6560]">
              名字
              <input
                type="text"
                value={identityName}
                onChange={(e) => setIdentityName(e.target.value)}
                placeholder="你的名字"
                maxLength={24}
                autoFocus
                className="mt-1.5 w-full rounded-xl border border-[#e8e2d6] bg-[#faf8f4] px-4 py-3 text-sm text-[#2c2825] outline-none focus:border-[#2c2825]/30"
              />
            </label>
            <button
              type="submit"
              disabled={!identityName.trim()}
              className="mt-8 w-full rounded-xl bg-[#2c2825] py-3 text-sm font-medium text-white transition hover:bg-[#3d3834] disabled:opacity-40"
            >
              进入图书馆
            </button>
          </form>
        </div>
      )}

      {/* 选笔弹窗 */}
      {showPenModal && profile && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-[#2c2825]/25 px-6 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-3xl border border-[#e0d9cc] bg-white/95 p-8 shadow-2xl">
            <h2 className="font-serif text-xl text-[#2c2825]">选择你的专属笔迹</h2>
            <p className="mt-2 text-sm text-[#6b6560]">
              颜色与线条组合在本房间内互斥，选定后不可更改。
            </p>

            <label className="mt-6 block text-xs font-medium text-[#6b6560]">
              划线颜色
              <div className="mt-2 flex items-center gap-4">
                <input
                  type="color"
                  value={penColor}
                  onChange={(e) => setPenColor(e.target.value)}
                  className="h-12 w-14 cursor-pointer rounded-lg border border-[#e8e2d6] p-1"
                />
                <span className="text-sm font-medium" style={{ color: penColor }}>
                  {penColor}
                </span>
              </div>
            </label>

            <p className="mt-5 text-xs font-medium text-[#6b6560]">线条样式</p>
            <div className="mt-2 flex gap-2">
              {LINE_STYLE_OPTIONS.map((opt) => {
                const key = penComboKey(penColor, opt.value);
                const taken = occupiedPenKeys.has(key);
                const selected = penLineStyle === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={taken && !selected}
                    onClick={() => setPenLineStyle(opt.value)}
                    className={`flex-1 rounded-xl border py-2.5 text-sm transition ${
                      selected
                        ? "border-[#2c2825] bg-[#2c2825] text-white"
                        : taken
                          ? "cursor-not-allowed border-[#e8e2d6] bg-[#f0ebe3] text-[#b5aea4] line-through"
                          : "border-[#e8e2d6] bg-white text-[#2c2825] hover:bg-[#faf8f4]"
                    }`}
                  >
                    {opt.label}
                    {taken && !selected ? " · 已占" : ""}
                  </button>
                );
              })}
            </div>

            {penSelectionConflict && (
              <p className="mt-4 text-center text-xs text-red-600">
                该笔迹已被专属，请选择其他搭配
              </p>
            )}

            {roomMembers.length > 0 && (
              <div className="mt-4 rounded-xl bg-[#faf8f4] p-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-[#9a9288]">
                  已入房成员
                </p>
                <ul className="mt-2 space-y-1">
                  {roomMembers.map((m) => (
                    <li
                      key={`${m.user_id}-${m.color}-${m.line_style}`}
                      className="flex items-center gap-2 text-xs text-[#6b6560]"
                    >
                      <span
                        className="inline-block h-0.5 w-6"
                        style={{
                          backgroundColor: m.color,
                          borderBottom:
                            m.line_style === "dashed"
                              ? `2px dashed ${m.color}`
                              : `2px ${m.line_style === "solid" ? "solid" : "wavy"} ${m.color}`,
                        }}
                      />
                      {m.user_name} ·{" "}
                      {LINE_STYLE_OPTIONS.find((o) => o.value === m.line_style)
                        ?.label ?? m.line_style}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <button
              type="button"
              onClick={() => void confirmPenSelection()}
              disabled={penSelectionConflict || penSubmitting}
              className="mt-6 w-full rounded-xl bg-[#2c2825] py-3 text-sm font-medium text-white transition hover:bg-[#3d3834] disabled:opacity-40"
            >
              {penSubmitting ? "正在入房…" : "确认笔迹并进入"}
            </button>
          </div>
        </div>
      )}

      {/* 改名弹窗 */}
      {showRenameModal && profile && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[#2c2825]/20 px-6 backdrop-blur-sm">
          <form
            onSubmit={handleRenameSubmit}
            className="w-full max-w-sm rounded-2xl border border-[#e0d9cc] bg-white p-6 shadow-xl"
          >
            <h3 className="font-serif text-lg text-[#2c2825]">修改名字</h3>
            <p className="mt-1 text-xs text-[#9a9288]">每年仅可修改一次</p>
            <input
              type="text"
              value={renameDraft}
              onChange={(e) => {
                setRenameDraft(e.target.value);
                setRenameMessage("");
              }}
              maxLength={24}
              className="mt-4 w-full rounded-xl border border-[#e8e2d6] px-4 py-2.5 text-sm outline-none focus:border-[#2c2825]/30"
            />
            {renameMessage && (
              <p className="mt-2 text-xs text-amber-700">{renameMessage}</p>
            )}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={openRenameModal}
                className="flex-1 rounded-xl border border-[#e8e2d6] py-2 text-sm"
              >
                取消
              </button>
              <button
                type="submit"
                className="flex-1 rounded-xl bg-[#2c2825] py-2 text-sm text-white"
              >
                保存
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 共读大厅 */}
      {showLobby && (
        <div
          className={`flex h-full ${showIdentityGate ? "pointer-events-none opacity-40" : ""}`}
        >
          <aside className="hidden w-52 shrink-0 border-r border-[#e0d9cc]/80 bg-white/40 p-6 lg:block">
            <p className="text-[10px] font-medium uppercase tracking-widest text-[#9a9288]">
              账户
            </p>
            <p className="mt-2 font-medium text-[#2c2825]">{profile?.name}</p>
            <button
              type="button"
              onClick={openRenameModal}
              className="mt-4 w-full rounded-lg border border-[#e8e2d6] py-2 text-xs text-[#6b6560] transition hover:bg-white"
            >
              修改名字
            </button>
          </aside>

          <div className="flex-1 overflow-y-auto px-6 py-10">
            <div className="mx-auto max-w-3xl">
              <p className="text-center text-[11px] font-medium uppercase tracking-[0.28em] text-[#9a9288]">
                S. · 云端图书馆
              </p>
              <h1 className="mt-4 text-center font-serif text-3xl text-[#2c2825]">
                共读大厅
              </h1>

              <div className="mt-8 grid gap-6 sm:grid-cols-2">
                <section className="rounded-3xl border border-[#e0d9cc] bg-white/85 p-6 shadow-md">
                  <h2 className="font-serif text-lg">上传私人书籍</h2>
                  <p className="mt-2 text-sm text-[#6b6560]">
                    创建新房间并生成 6 位邀请码
                  </p>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={importing}
                    className="mt-5 w-full rounded-xl bg-[#2c2825] py-3 text-sm text-white disabled:opacity-50"
                  >
                    {importing ? "上传中…" : "选择 TXT"}
                  </button>
                </section>

                <section className="rounded-3xl border border-[#e0d9cc] bg-white/85 p-6 shadow-md">
                  <h2 className="font-serif text-lg">邀请码加入</h2>
                  <input
                    type="text"
                    value={lobbyJoinInput}
                    onChange={(e) => {
                      setLobbyJoinInput(normalizeJoinCodeInput(e.target.value));
                      setJoinError("");
                    }}
                    placeholder="6 位邀请码"
                    maxLength={6}
                    className="mt-4 w-full rounded-xl border border-[#e8e2d6] bg-[#faf8f4] px-4 py-3 text-center font-mono text-lg tracking-[0.3em] outline-none"
                  />
                  {joinError && (
                    <p className="mt-2 text-center text-xs text-red-600">
                      {joinError}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleJoinRoom()}
                    disabled={joining || lobbyJoinInput.length !== 6}
                    className="mt-3 w-full rounded-xl border border-[#e0d9cc] py-3 text-sm disabled:opacity-40"
                  >
                    {joining ? "加入中…" : "加入共读"}
                  </button>
                </section>
              </div>

              <div className="mt-12">
                <h2 className="font-serif text-xl text-[#2c2825]">我的书架</h2>
                {myBooks.length === 0 ? (
                  <p className="mt-4 text-sm text-[#9a9288]">
                    上传或加入房间后，书籍会出现在这里。
                  </p>
                ) : (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {myBooks.map((book) => (
                      <div
                        key={book.bookId}
                        className="relative rounded-2xl border border-[#e0d9cc] bg-white/80 shadow-sm transition hover:border-[#2c2825]/20 hover:shadow-md"
                      >
                        <button
                          type="button"
                          aria-label={`从书架移除《${book.title}》`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleRemoveFromBookshelf(book.bookId);
                          }}
                          className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full text-sm leading-none text-[#b5aea4] transition hover:bg-[#f0ebe3] hover:text-[#2c2825]"
                        >
                          ×
                        </button>
                        <button
                          type="button"
                          onClick={() => void beginEnterRoom(book.bookId)}
                          className="w-full rounded-2xl p-4 pt-7 text-left"
                        >
                          <p className="pr-6 font-medium text-[#2c2825]">
                            {book.title}
                          </p>
                          <p className="mt-2 font-mono text-sm tracking-widest text-[#6b6560]">
                            {book.joinCode}
                          </p>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={openRenameModal}
                className="mt-8 w-full rounded-lg border border-[#e8e2d6] py-2 text-xs text-[#6b6560] lg:hidden"
              >
                修改名字
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 阅读器 */}
      {showReader && (
        <>
          <div className="pointer-events-none fixed right-4 top-4 z-[55] sm:right-6 sm:top-6">
            <div className="pointer-events-auto flex flex-col items-end gap-2">
              
              {/* Figma 实时在线头像 */}
              {onlineUsers.length > 0 && (
                <div className="mb-2 flex -space-x-2 mr-2">
                  {onlineUsers.map((u) => (
                    <div
                      key={u.userId}
                      title={`${u.name} 正在共读`}
                      className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white text-xs font-bold text-white shadow-sm transition-transform hover:-translate-y-1"
                      style={{ backgroundColor: u.color }}
                    >
                      {u.name.slice(0, 1).toUpperCase()}
                    </div>
                  ))}
                </div>
              )}

              <div className="rounded-2xl border border-[#e0d9cc] bg-white/90 px-4 py-3 shadow-lg backdrop-blur-md">
                <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-[#9a9288]">
                  房间邀请码
                </p>
                <p className="mt-1 font-mono text-2xl font-semibold tracking-[0.25em] text-[#2c2825]">
                  {roomJoinCode || "------"}
                </p>
                <button
                  type="button"
                  onClick={() => void copyJoinCode()}
                  className="mt-2 w-full rounded-lg bg-[#2c2825] px-3 py-1.5 text-xs text-white"
                >
                  {codeCopied ? "已复制" : "复制邀请码"}
                </button>
              </div>
              <button
                type="button"
                onClick={leaveRoom}
                className="rounded-full border border-[#e0d9cc] bg-white/80 px-3 py-1.5 text-xs text-[#6b6560] shadow-sm hover:bg-white"
              >
                返回大厅
              </button>
            </div>
          </div>

          <div
            ref={scrollRef}
            className={`h-full overflow-y-auto overflow-x-hidden ${showIdentityGate ? "pointer-events-none opacity-40" : ""}`}
          >
            <div className="mx-auto flex min-h-full max-w-6xl gap-0 px-6 pb-10 pt-20 sm:px-10 sm:pt-24 lg:px-14">
              <section className="min-w-0 flex-[1.65] pr-8 sm:pr-12 lg:pr-16">
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
                  className="book-content whitespace-pre-wrap font-serif text-[17px] leading-[1.85] text-[#2c2825]"
                  onMouseUp={handleMouseUp}
                >
                  {bookLoading ? (
                    <p className="text-sm text-[#9a9288]">正在加载正文…</p>
                  ) : (
                    textRuns.map((run) => {
                      if (run.activeHighlights.length === 0) {
                        return <span key={`plain-${run.start}`}>{run.text}</span>;
                      }
                      return (
                        <span
                          key={`mark-${run.start}-${run.end}-${run.highlightIds.join("-")}`}
                          ref={(el) => {
                            for (const id of run.highlightIds) {
                              if (el) markRefs.current.set(id, el);
                              else markRefs.current.delete(id);
                            }
                          }}
                        >
                          {renderHighlightedText(run.text, run.activeHighlights)}
                        </span>
                      );
                    })
                  )}
                </div>
              </section>

              <aside className="relative min-w-0 flex-1 border-l border-[#ddd5c8]/60 pl-6 sm:pl-8">
                <p className="mb-6 text-[11px] font-medium uppercase tracking-[0.22em] text-[#9a9288]">
                  边缘笔记
                </p>

                <div
                  ref={notesColumnRef}
                  className="relative w-full"
                  style={{ minHeight: notesMinHeight || "100%" }}
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
                    <div
                      key={note.id}
                      ref={(el) => {
                        if (el) cardRefs.current.set(note.id, el);
                        else cardRefs.current.delete(note.id);
                      }}
                      className="absolute left-0 right-0 w-full transition-[top] duration-200 ease-out"
                      style={{ top: cardTops[note.id] ?? 0 }}
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
                              onClick={() => void handleDeleteNote(note.id)}
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
                                      onClick={() => void handleDeleteReply(note.id, reply.id)}
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
                          value={replyDrafts[note.id] ?? ""}
                          onChange={(e) =>
                            setReplyDrafts((prev) => ({
                              ...prev,
                              [note.id]: e.target.value,
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void submitReply(note.id);
                            }
                          }}
                          placeholder="回复… 回车发送"
                          className="mt-3 w-full rounded-lg border border-[#e8e2d6] bg-[#faf8f4]/80 px-2.5 py-1.5 text-xs outline-none focus:border-[#2c2825]/20"
                        />
                      </article>
                    </div>
                  ))}
                </div>
              </aside>
            </div>
          </div>
        </>
      )}

      {popover && profile && activeBookId && roomPen && (
        <>
          <div
            className="fixed inset-0 z-40"
            aria-hidden
            onMouseDown={closePopover}
          />
          <div
            className="fixed z-50 w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-full rounded-2xl border border-[#e0d9cc] bg-white/95 p-3 shadow-xl backdrop-blur-md"
            style={{ left: popover.x, top: popover.y - 12 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <p className="mb-2 line-clamp-2 text-xs text-[#9a9288]">
              「{popover.text}」
            </p>
            <textarea
              autoFocus
              rows={3}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="写下边缘笔记…"
              className="w-full resize-none rounded-lg border border-[#e8e2d6] bg-[#faf8f4] px-3 py-2 text-sm outline-none"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submitNote();
              }}
            />
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={closePopover}
                className="rounded-lg px-3 py-1.5 text-xs text-[#6b6560]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void submitNote()}
                disabled={!draft.trim() || submitting}
                className="rounded-lg bg-[#2c2825] px-3 py-1.5 text-xs text-white disabled:opacity-40"
              >
                {submitting ? "保存中…" : "提交"}
              </button>
            </div>
          </div>
        </>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,text/plain"
        className="hidden"
        onChange={handleImportTxt}
      />
      
      {/* 极简高级 Toast 提示框 */}
      <div
        className={`fixed bottom-10 left-1/2 z-[100] flex -translate-x-1/2 items-center justify-center rounded-full bg-[#2c2825] px-6 py-3 text-sm font-medium text-white shadow-xl backdrop-blur-md transition-all duration-300 ease-out ${
          toast.visible ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0 pointer-events-none"
        }`}
      >
        {toast.message}
      </div>
    </div>
  );
}

export default function Home() {
  return <ReadingApp />;
}