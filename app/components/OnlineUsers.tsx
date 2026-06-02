import type { OnlineUser } from "./types";

type Props = {
  users: OnlineUser[];
};

export function OnlineUsers({ users }: Props) {
  if (users.length === 0) return null;

  return (
    <div className="mb-2 flex -space-x-2 mr-2">
      {users.map((u) => (
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
  );
}
