/**
 * Shared TUI components for both build and design loops.
 *
 * Extracted from the build loop's Dashboard.tsx to enable reuse
 * in the design loop's two-pane layout.
 */

// Hooks
export {
  useTerminalSize,
  useKeyboardAvailable,
  useCtrlC,
  useFocusCycle,
  useScrollKeys,
  useAutoTail,
  useMenuKey,
  debugKey,
  type MenuKey,
} from "./hooks.tsx";

// Components
export {
  Frame,
  Pane,
  Controls,
  type PaneProps,
} from "./components.tsx";

// Header
export {
  Header,
  type HeaderProps,
} from "./header.tsx";

// Usage pane
export {
  UsagePane,
  type UsagePaneProps,
} from "./usage.tsx";
