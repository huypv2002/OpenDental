from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


APP_DIR = str(Path(__file__).resolve().parents[1])
if APP_DIR not in sys.path:
    sys.path.insert(0, APP_DIR)

import uia_backend


class FakeControl:
    def __init__(self, name: str, handle: int, *, visible: bool = True):
        self.Name = name
        self.NativeWindowHandle = handle
        self.IsOffscreen = not visible
        self.IsEnabled = True
        self.BoundingRectangle = types.SimpleNamespace(left=10, top=20, right=810, bottom=620)
        self.ProcessId = 123
        self.ControlTypeName = "WindowControl"
        self.AutomationId = ""
        self.ClassName = "ApplicationFrameWindow"
        self.FrameworkId = "XAML"


class UIAutomationBackendTest(unittest.TestCase):
    def test_key_syntax_is_converted_for_uiautomation(self):
        events = []
        fake_auto = types.SimpleNamespace(
            SendKeys=lambda text, **kwargs: events.append((text, kwargs)),
        )

        with patch.dict(sys.modules, {"uiautomation": fake_auto}):
            uia_backend.uia_send_keys("^v")
            uia_backend.uia_send_keys("{ENTER}")

        self.assertEqual([event[0] for event in events], ["{Ctrl}v", "{Enter}"])

    def test_desktop_filters_top_level_windows_by_regex_and_visibility(self):
        phone_link = FakeControl("Phone Link", 101)
        hidden_phone_link = FakeControl("Phone Link hidden", 102, visible=False)
        browser = FakeControl("Browser", 103)
        root = types.SimpleNamespace(GetChildren=lambda: [browser, hidden_phone_link, phone_link])
        fake_auto = types.SimpleNamespace(GetRootControl=lambda: root)

        with patch.dict(sys.modules, {"uiautomation": fake_auto}):
            windows = uia_backend.UIADesktop().windows(title_re=r"(?i).*Phone Link.*")

        self.assertEqual(len(windows), 1)
        self.assertEqual(windows[0].window_text(), "Phone Link")

    def test_worker_decorator_initializes_uiautomation_in_current_thread(self):
        events = []

        class FakeInitializer:
            def __enter__(self):
                events.append("enter")

            def __exit__(self, exc_type, exc, traceback):
                del exc_type, exc, traceback
                events.append("exit")

        fake_auto = types.SimpleNamespace(UIAutomationInitializerInThread=FakeInitializer)

        @uia_backend.uia_threaded
        def work() -> str:
            events.append("work")
            return "done"

        with patch.object(uia_backend.platform, "system", lambda: "Windows"):
            with patch.dict(sys.modules, {"uiautomation": fake_auto}):
                result = work()

        self.assertEqual(result, "done")
        self.assertEqual(events, ["enter", "work", "exit"])


if __name__ == "__main__":
    unittest.main()
