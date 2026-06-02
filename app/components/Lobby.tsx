"use client";

import { useState } from "react";
import type { BookshelfEntry, UserProfile } from "./types";
import { normalizeJoinCodeInput } from "./utils";

type Props = {
  profile: UserProfile;
  myBooks: BookshelfEntry[];
  importing: boolean;
  joinError: string;
  onOpenRename: () => void;
  onImportTxt: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onJoinRoom: (code: string) => void;
  onEnterBook: (bookId: string) => void;
  onRemoveBook: (bookId: string) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
};

export function Lobby({
  profile,
  myBooks,
  importing,
  joinError,
  onOpenRename,
  onImportTxt,
  onJoinRoom,
  onEnterBook,
  onRemoveBook,
  fileInputRef,
}: Props) {
  const [lobbyJoinInput, setLobbyJoinInput] = useState("");
  const [joining, setJoining] = useState(false);

  const handleJoinRoom = async () => {
    const code = normalizeJoinCodeInput(lobbyJoinInput);
    if (code.length !== 6) {
      return;
    }
    setJoining(true);
    await onJoinRoom(code);
    setJoining(false);
    setLobbyJoinInput("");
  };

  return (
    <div className="flex h-full">
      <aside className="hidden w-52 shrink-0 border-r border-[#e0d9cc]/80 bg-white/40 p-6 lg:block">
        <p className="text-[10px] font-medium uppercase tracking-widest text-[#9a9288]">
          账户
        </p>
        <p className="mt-2 font-medium text-[#2c2825]">{profile.name}</p>
        <button
          type="button"
          onClick={onOpenRename}
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
                        onRemoveBook(book.bookId);
                      }}
                      className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full text-sm leading-none text-[#b5aea4] transition hover:bg-[#f0ebe3] hover:text-[#2c2825]"
                    >
                      ×
                    </button>
                    <button
                      type="button"
                      onClick={() => onEnterBook(book.bookId)}
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
            onClick={onOpenRename}
            className="mt-8 w-full rounded-lg border border-[#e8e2d6] py-2 text-xs text-[#6b6560] lg:hidden"
          >
            修改名字
          </button>
        </div>
      </div>
    </div>
  );
}
