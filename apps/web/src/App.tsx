import { NavLink, Route, Routes } from "react-router-dom";
import { Bot, FileText, FlaskConical, History } from "lucide-react";
import { cn } from "./lib/utils";
import { TenantSwitcher } from "./components/TenantSwitcher";
import ChatPage from "./features/chat/ChatPage";
import DocumentsPage from "./features/documents/DocumentsPage";
import EvalPage from "./features/eval/EvalPage";
import HistoryPage from "./features/history/HistoryPage";

const nav = [
  { to: "/", label: "检索问答", icon: Bot, end: true },
  { to: "/documents", label: "知识库", icon: FileText, end: false },
  { to: "/history", label: "检索历史", icon: History, end: false },
  { to: "/eval", label: "评估", icon: FlaskConical, end: false },
];

export default function App() {
  return (
    <div className="flex h-screen bg-zinc-50 text-zinc-900">
      <aside className="flex w-56 flex-col border-r bg-white">
        <div className="px-5 py-4 font-semibold">learn-rag</div>
        <nav className="flex flex-1 flex-col gap-1 px-3">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium",
                  isActive
                    ? "bg-zinc-900 text-white"
                    : "text-zinc-600 hover:bg-zinc-100",
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <TenantSwitcher />
      </aside>

      <main className="flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<ChatPage />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/eval" element={<EvalPage />} />
        </Routes>
      </main>
    </div>
  );
}