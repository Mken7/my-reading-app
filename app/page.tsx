"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  supabase,
  type DbNoteRow,
  type DbRoomMemberRow,
  type LineStyle,
} from "@/lib/supabase";
import type {
  UserProfile,
  BookshelfEntry,
  RoomPen,
  Highlight,
  Note,
  PopoverState,
  OnlineUser,
  ToastState,
} from "./components/types";
import {
  normalizeColor,
  generateUserId,
  generateJoinCode,
  penComboKey,
  buildStyleMapFromMembers,
  mapRowsToState,
  getOffsetWithin,
  rangesOverlap,
  parseReplies,
  titleFromFileName,
  canRenameProfile,
} from "./components/utils";
import {
  loadUserProfile,
  saveUserProfile,
  loadMyBooks,
  saveMyBooks,
  addToMyBooks,
  removeFromMyBooksStorage,
  saveActiveBookId,
  loadActiveBookId,
  removeActiveBookId,
  saveScrollPosition,
  loadScrollPosition,
} from "./components/storage";
import { IdentityGate } from "./components/IdentityGate";
import { RenameModal } from "./components/RenameModal";
import { PenModal } from "./components/PenModal";
import { Lobby } from "./components/Lobby";
import { Reader } from "./components/Reader";
import { NotePopover } from "./components/NotePopover";
import { Toast } from "./components/Toast";

const DEFAULT_PEN_COLOR = "#2563eb";

function ReadingApp() {
  const [authChecked, setAuthChecked] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);

  const [myBooks, setMyBooks] = useState<BookshelfEntry[]>([]);
  const [showRenameModal, setShowRenameModal] = useState(false);

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

  const [viewMode, setViewMode] = useState<"scroll" | "page">("scroll");
  const [restoredScroll, setRestoredScroll] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [toast, setToast] = useState<ToastState>({
    message: "",
    visible: false,
  });

  const bookRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const notesColumnRef = useRef<HTMLDivElement>(null);
  const markRefs = useRef<Map<string, HTMLSpanElement>>(new Map());
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bookTextRef = useRef(bookText);
  const bookIdRef = useRef(activeBookId);
  const memberStyleMapRef = useRef(memberStyleMap);
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

  // 初始化：加载本地存储
  useEffect(() => {
    const saved = loadUserProfile();
    if (saved) setProfile(saved);
    setMyBooks(loadMyBooks());
    setAuthChecked(true);
  }, []);

  const refreshMyBooks = useCallback(() => {
    setMyBooks(loadMyBooks());
  }, []);

  // 身份提交
  const handleIdentitySubmit = useCallback(
    (name: string) => {
      const newProfile: UserProfile = {
        userId: generateUserId(),
        name,
        lastNameChangeDate: null,
      };
      saveUserProfile(newProfile);
      setProfile(newProfile);
      showToast(`欢迎回来，${name}`);
    },
    [showToast],
  );

  // 改名
  const handleRenameSave = useCallback(
    (newName: string) => {
      if (!profile) return;
      const updated: UserProfile = {
        ...profile,
        name: newName,
        lastNameChangeDate: new Date().toISOString(),
      };
      saveUserProfile(updated);
      setProfile(updated);
      setShowRenameModal(false);
      showToast("名字修改成功");
    },
    [profile, showToast],
  );

  // 关闭 Popover
  const closePopover = useCallback(() => {
    setPopover(null);
    setDraft("");
    window.getSelection()?.removeAllRanges();
  }, []);

  // 处理文字选择
  const processTextSelection = useCallback(() => {
    const selectedText = window.getSelection()?.toString().trim();
    if (!selectedText || selectedText.length === 0) return;

    if (!profile || !activeBookId || !roomPen) return;
    const root = bookRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.isCollapsed || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;

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
      text: selectedText,
    });
    setDraft("");
  }, [highlights, profile, activeBookId, roomPen, showToast]);

  const handleMouseUp = useCallback(() => {
    processTextSelection();
  }, [processTextSelection]);

  // 手机端触摸选择
  useEffect(() => {
    if (!activeBookId || bookLoading) return;
    const el = bookRef.current;
    if (!el) return;

    const isTouchDevice =
      "ontouchstart" in window || navigator.maxTouchPoints > 0;
    if (!isTouchDevice) return;

    const onTouchEnd = () => {
      setTimeout(() => {
        processTextSelection();
      }, 10);
    };

    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [activeBookId, bookLoading, processTextSelection]);

  // 进入房间
  const finalizeEnterRoom = useCallback(
    (bookId: string, pen: RoomPen, members: DbRoomMemberRow[]) => {
      saveActiveBookId(bookId);
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

  // 恢复会话
  useEffect(() => {
    if (!authChecked || !profile || sessionRestoredRef.current) return;
    sessionRestoredRef.current = true;
    const saved = loadActiveBookId();
    if (saved) void beginEnterRoom(saved);
  }, [authChecked, profile, beginEnterRoom]);

  const occupiedPenKeys = useMemo(
    () =>
      new Set(roomMembers.map((m) => penComboKey(m.color, m.line_style))),
    [roomMembers],
  );

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
    removeActiveBookId();
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

  // 提交笔记
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

  // 提交回复
  const submitReply = useCallback(
    async (noteId: string) => {
      const text = replyDrafts[noteId]?.trim();
      if (!text || !profile || !roomPen) return;

      const note = notes.find((n) => n.id === noteId);
      if (!note) return;

      const newReply = {
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
    },
    [replyDrafts, profile, roomPen, notes, showToast],
  );

  // 删除笔记
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
      showToast("笔记已从时空抹去");
    },
    [showToast],
  );

  // 删除回复
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
          n.id === noteId ? { ...n, replies: updatedReplies } : n,
        ),
      );
      showToast("回复已撤回");
    },
    [notes, showToast],
  );

  // Realtime 同步
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
    },
    [],
  );

  const applyNoteUpdateFromRealtime = useCallback((row: DbNoteRow) => {
    const rowId = String(row.id);

    setNotes((prev) => {
      const exists = prev.find((n) => String(n.id) === rowId);
      if (!exists) return prev;

      const updatedReplies =
        row.replies !== undefined ? parseReplies(row.replies) : exists.replies;

      return prev.map((n) =>
        String(n.id) === rowId ? { ...n, replies: updatedReplies } : n,
      );
    });
  }, []);

  // Presence（在线用户）
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
        const users: OnlineUser[] = [];
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

  // 加载书籍和笔记 + Realtime 订阅
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
            setHighlights((prev) =>
              prev.filter((h) => String(h.id) !== deletedId),
            );
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
    closePopover,
    applyNoteInsertFromRealtime,
    applyNoteUpdateFromRealtime,
  ]);

  // 加入房间
  const handleJoinRoom = useCallback(
    async (code: string) => {
      const { data, error } = await supabase
        .from("books")
        .select("id, title, join_code")
        .eq("join_code", code)
        .maybeSingle();

      if (error || !data?.id) {
        setJoinError("邀请码无效，请检查后重试");
        return;
      }

      setJoinError("");
      await beginEnterRoom(String(data.id), {
        title: data.title ?? "未命名书籍",
        joinCode: (data.join_code ?? code).toUpperCase(),
      });
    },
    [beginEnterRoom],
  );

  // 导入 TXT
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

  // 滚动恢复
  useEffect(() => {
    if (!bookLoading && activeBookId && !restoredScroll) {
      const saved = loadScrollPosition(activeBookId);
      if (saved && scrollRef.current) {
        scrollRef.current.scrollTop = saved;
      }
      setRestoredScroll(true);
    }
  }, [bookLoading, activeBookId, restoredScroll]);

  // 滚动保存
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    let timeoutId: number;
    const onScroll = () => {
      if (activeBookId) {
        if (timeoutId) window.clearTimeout(timeoutId);
        timeoutId = window.setTimeout(() => {
          saveScrollPosition(activeBookId, scrollEl.scrollTop);
        }, 300);
      }
    };

    scrollEl.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
    };
  }, [activeBookId]);

  // Escape 关闭 Popover
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
      {showIdentityGate && <IdentityGate onSubmit={handleIdentitySubmit} />}

      {showPenModal && profile && (
        <PenModal
          penColor={penColor}
          penLineStyle={penLineStyle}
          penSubmitting={penSubmitting}
          penSelectionConflict={penSelectionConflict}
          roomMembers={roomMembers}
          occupiedPenKeys={occupiedPenKeys}
          onChangeColor={setPenColor}
          onChangeLineStyle={setPenLineStyle}
          onConfirm={confirmPenSelection}
        />
      )}

      {showRenameModal && profile && (
        <RenameModal
          profile={profile}
          onSave={handleRenameSave}
          onClose={() => setShowRenameModal(false)}
        />
      )}

      {showLobby && (
        <Lobby
          profile={profile}
          myBooks={myBooks}
          importing={importing}
          joinError={joinError}
          onOpenRename={() => setShowRenameModal(true)}
          onImportTxt={handleImportTxt}
          onJoinRoom={handleJoinRoom}
          onEnterBook={(bookId) => void beginEnterRoom(bookId)}
          onRemoveBook={handleRemoveFromBookshelf}
          fileInputRef={fileInputRef}
        />
      )}

      {showReader && (
        <Reader
          viewMode={viewMode}
          onToggleViewMode={() => setViewMode((v) => (v === "scroll" ? "page" : "scroll"))}
          profile={profile}
          roomPen={roomPen}
          bookTitle={bookTitle}
          bookText={bookText}
          bookLoading={bookLoading}
          highlights={highlights}
          notes={notes}
          roomJoinCode={roomJoinCode}
          onlineUsers={onlineUsers}
          cardTops={cardTops}
          notesMinHeight={notesMinHeight}
          replyDrafts={replyDrafts}
          codeCopied={codeCopied}
          cloudLoading={cloudLoading}
          onCopyJoinCode={copyJoinCode}
          onLeaveRoom={leaveRoom}
          onReplyDraftChange={(noteId, value) =>
            setReplyDrafts((prev) => ({ ...prev, [noteId]: value }))
          }
          onSubmitReply={submitReply}
          onDeleteNote={handleDeleteNote}
          onDeleteReply={handleDeleteReply}
          onMouseUp={handleMouseUp}
          bookRef={bookRef}
          scrollRef={scrollRef}
          notesColumnRef={notesColumnRef}
          markRefs={markRefs}
          cardRefs={cardRefs}
          setCardTops={setCardTops}
          setNotesMinHeight={setNotesMinHeight}
        />
      )}

      {popover && profile && activeBookId && roomPen && (
        <NotePopover
          popover={popover}
          draft={draft}
          submitting={submitting}
          onDraftChange={setDraft}
          onSubmit={submitNote}
          onClose={closePopover}
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,text/plain"
        className="hidden"
        onChange={handleImportTxt}
      />

      <Toast toast={toast} />
    </div>
  );
}

export default function Home() {
  return <ReadingApp />;
}
