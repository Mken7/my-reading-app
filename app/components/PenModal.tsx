"use client";

import type { DbRoomMemberRow, LineStyle } from "@/lib/supabase";
import { LINE_STYLE_OPTIONS, penComboKey } from "./utils";

type Props = {
  penColor: string;
  penLineStyle: LineStyle;
  penSubmitting: boolean;
  penSelectionConflict: boolean;
  roomMembers: DbRoomMemberRow[];
  occupiedPenKeys: Set<string>;
  onChangeColor: (color: string) => void;
  onChangeLineStyle: (style: LineStyle) => void;
  onConfirm: () => void;
};

export function PenModal({
  penColor,
  penLineStyle,
  penSubmitting,
  penSelectionConflict,
  roomMembers,
  occupiedPenKeys,
  onChangeColor,
  onChangeLineStyle,
  onConfirm,
}: Props) {
  return (
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
              onChange={(e) => onChangeColor(e.target.value)}
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
                onClick={() => onChangeLineStyle(opt.value)}
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
          onClick={onConfirm}
          disabled={penSelectionConflict || penSubmitting}
          className="mt-6 w-full rounded-xl bg-[#2c2825] py-3 text-sm font-medium text-white transition hover:bg-[#3d3834] disabled:opacity-40"
        >
          {penSubmitting ? "正在入房…" : "确认笔迹并进入"}
        </button>
      </div>
    </div>
  );
}
