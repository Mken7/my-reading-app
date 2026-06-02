"use client";

import { useState } from "react";
import type { UserProfile } from "./types";
import { canRenameProfile, daysUntilRenameAllowed } from "./utils";

type Props = {
  profile: UserProfile;
  onSave: (newName: string) => void;
  onClose: () => void;
};

export function RenameModal({ profile, onSave, onClose }: Props) {
  const [renameDraft, setRenameDraft] = useState(profile.name);
  const [renameMessage, setRenameMessage] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const nextName = renameDraft.trim();
    if (!nextName) return;

    if (!canRenameProfile(profile.lastNameChangeDate)) {
      setRenameMessage(
        `每年只能修改一次名字。还需等待约 ${daysUntilRenameAllowed(profile.lastNameChangeDate)} 天。`,
      );
      return;
    }

    onSave(nextName);
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[#2c2825]/20 px-6 backdrop-blur-sm">
      <form
        onSubmit={handleSubmit}
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
            onClick={onClose}
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
  );
}
