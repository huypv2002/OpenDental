from __future__ import annotations

import platform
import re
from contextlib import contextmanager
from functools import wraps
from types import SimpleNamespace
from typing import Any, Iterator


def load_uiautomation() -> Any:
    try:
        import uiautomation as auto
    except ImportError as exc:
        raise RuntimeError("uiautomation is not installed. Run: pip install -r requirements.txt") from exc
    return auto


@contextmanager
def uiautomation_thread() -> Iterator[None]:
    if platform.system() != "Windows":
        yield
        return
    auto = load_uiautomation()
    with auto.UIAutomationInitializerInThread():
        yield


def uia_threaded(function: Any) -> Any:
    @wraps(function)
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        with uiautomation_thread():
            return function(*args, **kwargs)

    return wrapped


def _control_type_name(control: Any) -> str:
    value = str(control.ControlTypeName or "")
    return value[:-7] if value.endswith("Control") else value


class UIAElementInfo:
    def __init__(self, control: Any):
        self._control = control

    @property
    def name(self) -> str:
        return str(self._control.Name or "")

    @property
    def control_type(self) -> str:
        return _control_type_name(self._control)

    @property
    def automation_id(self) -> str:
        return str(self._control.AutomationId or "")

    @property
    def class_name(self) -> str:
        return str(self._control.ClassName or "")

    @property
    def process_id(self) -> int:
        return int(self._control.ProcessId or 0)

    @property
    def framework_id(self) -> str:
        return str(self._control.FrameworkId or "")

    @property
    def control_id(self) -> str:
        return self.automation_id

    @property
    def handle(self) -> int:
        return int(self._control.NativeWindowHandle or 0)

    @property
    def runtime_id(self) -> list[int]:
        try:
            return list(self._control.GetRuntimeId() or [])
        except Exception:
            return []


class UIAControlAdapter:
    def __init__(self, control: Any):
        self.control = control
        self.element_info = UIAElementInfo(control)

    def wrapper_object(self) -> "UIAControlAdapter":
        return self

    def rectangle(self) -> Any:
        return self.control.BoundingRectangle

    def window_text(self) -> str:
        return str(self.control.Name or "")

    def automation_id(self) -> str:
        return str(self.control.AutomationId or "")

    def class_name(self) -> str:
        return str(self.control.ClassName or "")

    def process_id(self) -> int:
        return int(self.control.ProcessId or 0)

    def descendants(self, control_type: str | None = None) -> list["UIAControlAdapter"]:
        auto = load_uiautomation()
        result: list[UIAControlAdapter] = []
        for child, _depth in auto.WalkControl(self.control, includeTop=False):
            adapter = UIAControlAdapter(child)
            if control_type and adapter.element_info.control_type != control_type:
                continue
            result.append(adapter)
        return result

    def set_focus(self) -> None:
        if hasattr(self.control, "SetActive"):
            try:
                if self.control.SetActive(waitTime=0):
                    return
            except Exception:
                pass
        if not self.control.SetFocus():
            raise RuntimeError(f"Could not focus UIAutomation control {self.window_text()!r}.")

    def click_input(self) -> None:
        self.control.Click(waitTime=0)

    def has_keyboard_focus(self) -> bool:
        return bool(self.control.HasKeyboardFocus)

    def is_visible(self) -> bool:
        rect = self.rectangle()
        return not bool(self.control.IsOffscreen) and rect.right > rect.left and rect.bottom > rect.top

    def is_enabled(self) -> bool:
        return bool(self.control.IsEnabled)

    def get_value(self) -> str:
        try:
            pattern = self.control.GetValuePattern()
            return str(pattern.Value or "") if pattern else ""
        except Exception:
            return ""

    def legacy_properties(self) -> dict[str, str]:
        return {"Value": self.get_value()}

    def exists(self, timeout: float = 0) -> bool:
        try:
            return bool(self.control.Exists(maxSearchSeconds=max(0, timeout), printIfNotExist=False))
        except Exception:
            return False

    def close(self) -> None:
        try:
            pattern = self.control.GetWindowPattern()
            if pattern:
                pattern.Close()
                return
        except Exception:
            pass
        self.set_focus()
        uia_send_keys("%{F4}")


class UIAWindowSpecification:
    def __init__(self, desktop: "UIADesktop", title_re: str):
        self.desktop = desktop
        self.title_re = title_re
        self._wrapper: UIAControlAdapter | None = None

    def _find(self, timeout: float = 10.0) -> UIAControlAdapter:
        import time

        deadline = time.monotonic() + max(0.1, timeout)
        while time.monotonic() < deadline:
            windows = self.desktop.windows(title_re=self.title_re)
            if windows:
                self._wrapper = windows[0]
                return self._wrapper
            time.sleep(0.25)
        raise LookupError({"title_re": self.title_re, "backend": "uiautomation"})

    def exists(self, timeout: float = 0) -> bool:
        try:
            self._find(max(0.1, timeout))
            return True
        except LookupError:
            return False

    def wrapper_object(self) -> UIAControlAdapter:
        return self._find()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._find(), name)


class UIADesktop:
    def __init__(self, backend: str = "uia"):
        del backend

    def windows(
        self,
        title_re: str = ".*",
        visible_only: bool = True,
        enabled_only: bool = False,
        process: int | None = None,
    ) -> list[UIAControlAdapter]:
        auto = load_uiautomation()
        pattern = re.compile(title_re)
        result: list[UIAControlAdapter] = []
        for control in auto.GetRootControl().GetChildren():
            adapter = UIAControlAdapter(control)
            try:
                if process is not None and adapter.process_id() != process:
                    continue
                if not pattern.match(adapter.window_text()):
                    continue
                if visible_only and not adapter.is_visible():
                    continue
                if enabled_only and not adapter.is_enabled():
                    continue
                result.append(adapter)
            except Exception:
                continue
        return result

    def window(self, title_re: str) -> UIAWindowSpecification:
        return UIAWindowSpecification(self, title_re)


_KEY_MAP = {
    "^a": "{Ctrl}a",
    "^n": "{Ctrl}n",
    "^p": "{Ctrl}p",
    "^v": "{Ctrl}v",
    "+{TAB}": "{Shift}{Tab}",
    "%{F4}": "{Alt}{F4}",
    "{BACKSPACE}": "{Backspace}",
    "{ENTER}": "{Enter}",
    "{ESC}": "{Esc}",
    "{TAB}": "{Tab}",
    "{TAB 2}": "{Tab 2}",
    "{TAB 6}": "{Tab 6}",
}


def uia_send_keys(keys: str, *, text_mode: bool = False) -> None:
    auto = load_uiautomation()
    value = str(keys) if text_mode else _KEY_MAP.get(str(keys), str(keys))
    auto.SendKeys(value, interval=0.01, waitTime=0, charMode=True)


def uia_click(x: int, y: int) -> None:
    auto = load_uiautomation()
    auto.Click(int(x), int(y), waitTime=0)


def focused_control() -> UIAControlAdapter | None:
    auto = load_uiautomation()
    control = auto.GetFocusedControl()
    return UIAControlAdapter(control) if control else None


def backend_details() -> SimpleNamespace:
    auto = load_uiautomation()
    return SimpleNamespace(name="uiautomation", version=getattr(auto, "VERSION", "unknown"))
