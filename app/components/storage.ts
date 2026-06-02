import type { UserProfile, BookshelfEntry } from "./types";

const USER_PROFILE_KEY = "userProfile";
const MY_BOOKS_KEY = "myBooks";
const ACTIVE_BOOK_KEY = "activeBookId";

export function loadUserProfile(): UserProfile | null {
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

export function saveUserProfile(profile: UserProfile) {
  localStorage.setItem(USER_PROFILE_KEY, JSON.stringify(profile));
}

export function loadMyBooks(): BookshelfEntry[] {
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

export function saveMyBooks(books: BookshelfEntry[]) {
  localStorage.setItem(MY_BOOKS_KEY, JSON.stringify(books));
}

export function addToMyBooks(entry: Omit<BookshelfEntry, "addedAt">) {
  const books = loadMyBooks().filter((b) => b.bookId !== entry.bookId);
  books.unshift({ ...entry, addedAt: Date.now() });
  saveMyBooks(books);
}

export function removeFromMyBooksStorage(bookId: string): BookshelfEntry[] {
  const books = loadMyBooks().filter((b) => b.bookId !== bookId);
  saveMyBooks(books);
  return books;
}

export function saveActiveBookId(bookId: string) {
  sessionStorage.setItem(ACTIVE_BOOK_KEY, bookId);
}

export function loadActiveBookId(): string | null {
  return sessionStorage.getItem(ACTIVE_BOOK_KEY);
}

export function removeActiveBookId() {
  sessionStorage.removeItem(ACTIVE_BOOK_KEY);
}

export function saveScrollPosition(bookId: string, scrollTop: number) {
  localStorage.setItem(`scroll_${bookId}`, String(scrollTop));
}

export function loadScrollPosition(bookId: string): number | null {
  const saved = localStorage.getItem(`scroll_${bookId}`);
  return saved ? Number(saved) : null;
}
