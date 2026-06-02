import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
    // 🚨 终极核武器：强行允许各种跨域和传输协议，打破浏览器的静默拦截墙！
    transport: WebSocket
  }
});

export type LineStyle = "wavy" | "solid" | "dashed";

/** Supabase `books` 表行结构 */
export type DbBookRow = {
  id: string;
  title: string;
  content: string;
  join_code: string;
};

/** 笔记回复（存于 notes.replies jsonb） */
export type DbNoteReply = {
  id: string;
  user_id: string;
  user_name: string;
  user_color: string;
  content: string;
  created_at: string;
};

/** Supabase `notes` 表行结构 */
export type DbNoteRow = {
  id: string;
  book_id: string;
  start_index: number;
  end_index: number;
  user_name: string;
  user_color: string;
  content: string;
  quote: string;
  replies: DbNoteReply[] | null;
  created_at: string;
};

/** Supabase `room_members` 表行结构 */
export type DbRoomMemberRow = {
  id?: string;
  book_id: string;
  user_id: string;
  user_name: string;
  color: string;
  line_style: LineStyle;
};
