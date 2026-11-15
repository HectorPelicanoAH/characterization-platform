import React, { useState } from "react";
import { Moon, Sun } from "lucide-react";

export function ThemeToggle() {
  const [dark, setDark] = useState(document.documentElement.dataset.theme === "dark");
  function toggle() {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("characterize-theme", next);
    setDark(!dark);
  }
  return <button type="button" className="theme-toggle" aria-label="Dark mode" aria-pressed={dark} title={dark ? "Switch to light mode" : "Switch to dark mode"} onClick={toggle}>
    {dark ? <Sun size={17}/> : <Moon size={17}/>}
  </button>;
}
