import { CURSOR_MARKER, matchesKey, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { fit } from "./layout.ts";
export class ControlInput implements Component, Focusable {
  focused = true; text = "";
  constructor(private submit: (value: string) => void) {}
  render(width: number): string[] { const cursor = this.focused ? `${CURSOR_MARKER}\x1b[7m \x1b[27m` : ""; if (width <= 1) return [cursor]; if (width === 2) return [`>${cursor}`]; const available = Math.max(0, width - 3); const chars = [...this.text]; while (visibleWidth(chars.join("")) > available && chars.length) chars.shift(); return [fit(`> ${chars.join("")}${cursor}`, width)]; }
  handleInput(data: string): void { if (matchesKey(data, "escape")) { this.text = ""; return; } if (matchesKey(data, "enter")) { const value = this.text.trim(); this.text = ""; if (value) this.submit(value); return; } if (matchesKey(data, "backspace")) { this.text = [...this.text].slice(0, -1).join(""); return; } if (!data.startsWith("\x1b") && [...data].every((char) => char >= " ")) this.text += data; }
  setText(value: string): void { this.text = value; }
  cancel(): void { this.text = ""; }
  invalidate(): void {}
}
