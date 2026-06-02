"use client";

import { useState } from "react";

type Props = {
  onSubmit: (name: string) => void;
};

export function IdentityGate({ onSubmit }: Props) {
  const [identityName, setIdentityName] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = identityName.trim();
    if (!name) return;
    onSubmit(name);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#f3efe6]/95 px-6 backdrop-blur-md">
      <form
        onSubmit={handleSubmit}
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
  );
}
