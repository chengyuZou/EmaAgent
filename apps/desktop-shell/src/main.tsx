/**
 * Tauri Desktop Shell 入口。
 */

import React from "react";
import ReactDOM from "react-dom/client";
import { ChatPage } from "./features/chat/ChatPage.js";

function App() {
  return <ChatPage />;
}

function bootstrapApp(): void {
  const root = document.getElementById("root");
  if (!root) throw new Error("Root element not found");
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

bootstrapApp();
