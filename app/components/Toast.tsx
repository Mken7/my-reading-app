import type { ToastState } from "./types";

export function Toast({ toast }: { toast: ToastState }) {
  return (
    <div
      className={`fixed bottom-10 left-1/2 z-[100] flex -translate-x-1/2 items-center justify-center rounded-full bg-[#2c2825] px-6 py-3 text-sm font-medium text-white shadow-xl backdrop-blur-md transition-all duration-300 ease-out ${
        toast.visible
          ? "translate-y-0 opacity-100"
          : "translate-y-8 opacity-0 pointer-events-none"
      }`}
    >
      {toast.message}
    </div>
  );
}
