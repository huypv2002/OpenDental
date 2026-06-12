from __future__ import annotations

import argparse
import platform
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any


APP_DIR = Path(__file__).resolve().parent
SNAPSHOT_DIR = APP_DIR / "phone_link_snapshots"
LATEST_LOG = APP_DIR / "phone_link_snapshot_latest.log"
PHONE_LINK_TITLE_RE = r".*(Phone Link|Liên kết Điện thoại|Messages).*"


def normalize_text(value: str) -> str:
    return " ".join(str(value or "").split()).lower()


def read_edit_value(control: Any) -> str:
    for getter in (
        lambda: control.get_value(),
        lambda: control.iface_value.CurrentValue,
        lambda: control.legacy_properties().get("Value", ""),
        lambda: control.window_text(),
    ):
        try:
            text = str(getter() or "").strip()
            if text:
                return text
        except Exception:
            continue
    return ""


def safe(getter: Any) -> Any:
    try:
        return getter()
    except Exception as exc:  # noqa: BLE001 - diagnostic output should keep going
        return f"<err: {exc!r}>"


def collect_phone_link_windows() -> tuple[list[Any], list[str]]:
    from pywinauto import Desktop

    lines: list[str] = []
    desktop = Desktop(backend="uia")
    roots: list[Any] = []
    seen: set[Any] = set()

    try:
        candidates = desktop.windows(title_re=PHONE_LINK_TITLE_RE)
    except Exception as exc:  # noqa: BLE001
        lines.append(f"[error] could not enumerate Phone Link windows: {exc!r}")
        candidates = []

    for window in candidates:
        handle = getattr(getattr(window, "element_info", None), "handle", None)
        if handle in seen:
            continue
        seen.add(handle)
        roots.append(window)

        pid = safe(lambda w=window: w.process_id())
        if isinstance(pid, int):
            try:
                for sibling in desktop.windows(process=pid):
                    sibling_handle = getattr(getattr(sibling, "element_info", None), "handle", None)
                    if sibling_handle in seen:
                        continue
                    seen.add(sibling_handle)
                    roots.append(sibling)
            except Exception as exc:  # noqa: BLE001
                lines.append(f"[warn] could not enumerate sibling windows for pid={pid}: {exc!r}")

    return roots, lines


def dump_controls(search_text: str = "") -> Path:
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = SNAPSHOT_DIR / f"phone_link_snapshot_{timestamp}.log"
    normalized_search = normalize_text(search_text)
    found_search = False

    lines: list[str] = [
        f"===== Phone Link snapshot {datetime.now().isoformat(timespec='seconds')} =====",
        f"search_text = {search_text!r}",
        "",
    ]

    roots, collect_lines = collect_phone_link_windows()
    lines.extend(collect_lines)
    lines.append(f"[windows] {len(roots)} Phone Link/Messages top-level window(s) found")

    if not roots:
        lines.append("[hint] Open Phone Link first, then run snapshot-phone-link-elements.bat again.")

    preview_lines: list[str] = []
    focused_lines: list[str] = []

    for win_index, window in enumerate(roots):
        lines.append("")
        lines.append(f"########## TOP-LEVEL WINDOW #{win_index} ##########")
        lines.append(f"window_text = {safe(lambda w=window: w.window_text())!r}")
        lines.append(f"rectangle   = {safe(lambda w=window: w.rectangle())}")
        lines.append(f"process_id  = {safe(lambda w=window: w.process_id())!r}")

        descendants = safe(lambda w=window: w.descendants())
        if not isinstance(descendants, list):
            lines.append(f"[error] could not enumerate descendants: {descendants!r}")
            continue

        lines.append(f"[count] {len(descendants)} descendant controls")
        for index, control in enumerate(descendants):
            info = getattr(control, "element_info", None)
            name = str(safe(lambda c=control: c.element_info.name) or "")
            window_text = str(safe(lambda c=control: c.window_text()) or "")
            edit_value = read_edit_value(control)
            control_type = str(safe(lambda i=info: getattr(i, "control_type", "")) or "")
            automation_id = str(safe(lambda i=info: getattr(i, "automation_id", "")) or "")
            class_name = str(safe(lambda i=info: getattr(i, "class_name", "")) or "")
            has_focus = safe(lambda c=control: c.has_keyboard_focus())
            rectangle = safe(lambda c=control: c.rectangle())

            combined = "\n".join([name, window_text, edit_value])
            if normalized_search and normalized_search in normalize_text(combined):
                found_search = True

            if "message preview" in normalize_text(combined):
                preview_lines.append(f"#{win_index}.{index} {combined[:800]!r}")
            if has_focus is True:
                focused_lines.append(f"#{win_index}.{index} name={name!r} value={edit_value!r}")

            lines.append(f"--- #{win_index}.{index} ---")
            lines.append(f"name           = {name!r}")
            lines.append(f"window_text    = {window_text!r}")
            lines.append(f"control_type   = {control_type!r}")
            lines.append(f"automation_id  = {automation_id!r}")
            lines.append(f"class_name     = {class_name!r}")
            lines.append(f"rectangle      = {rectangle}")
            lines.append(f"has_focus      = {has_focus}")
            lines.append(f"is_enabled     = {safe(lambda c=control: c.is_enabled())}")
            lines.append(f"is_visible     = {safe(lambda c=control: c.is_visible())}")
            lines.append(f"edit_value     = {edit_value!r}")

    lines.append("")
    lines.append("########## SUMMARY ##########")
    lines.append(f"search_found = {found_search}")
    lines.append(f"message_preview_count = {len(preview_lines)}")
    for preview in preview_lines[:80]:
        lines.append(f"preview = {preview}")
    lines.append(f"focused_control_count = {len(focused_lines)}")
    for focused in focused_lines[:20]:
        lines.append(f"focused = {focused}")

    text = "\n".join(lines) + "\n"
    output_path.write_text(text, encoding="utf-8")
    LATEST_LOG.write_text(text, encoding="utf-8")
    return output_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Snapshot Phone Link UIA elements for SMS diagnostics.")
    parser.add_argument("--search", default="", help="Optional phone, patient name, or message/template snippet to search.")
    args = parser.parse_args()

    if platform.system() != "Windows":
        print("Phone Link element snapshot only runs on Windows.", file=sys.stderr)
        return 2

    try:
        output_path = dump_controls(args.search)
    except ImportError:
        print("pywinauto is not installed. Run: pip install -r requirements.txt", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001
        print(f"Snapshot failed: {exc!r}", file=sys.stderr)
        return 1

    print("")
    print("Snapshot saved:")
    print(str(output_path))
    print("")
    print("Latest copy:")
    print(str(LATEST_LOG))
    if args.search:
        found = "unknown"
        try:
            found = str(bool(re.search(r"^search_found = True$", LATEST_LOG.read_text(encoding="utf-8"), re.MULTILINE)))
        except Exception:
            pass
        print(f"Search found: {found}")
    time.sleep(0.2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
