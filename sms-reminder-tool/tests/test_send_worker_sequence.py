from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path


APP_PATH = Path(__file__).resolve().parents[1] / "sms_reminder_app.py"


def load_app_module():
    sys.modules.setdefault("pyperclip", types.SimpleNamespace(copy=lambda _text: None))
    sys.modules.setdefault("dotenv", types.SimpleNamespace(load_dotenv=lambda *_args, **_kwargs: None))
    spec = importlib.util.spec_from_file_location("sms_reminder_app_for_tests", APP_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


app = load_app_module()
EVENTS: list[tuple] = []


class FakeRepo:
    def __init__(self, _config):
        pass

    def log_result(self, appointment, message, status, error="", phone=None):
        EVENTS.append(("log", appointment["AptNum"], phone, status, error, message))

    def log_recall_result(self, patient, message, status, error="", phone=None):
        EVENTS.append(("recall-log", patient["PatNum"], phone, status, error, message))

    def log_treatment_result(self, patient, message, status, error="", phone=None):
        EVENTS.append(("treatment-log", patient["PatNum"], phone, status, error, message))


class FakePhoneLinkSender:
    fail_on_phone = ""

    def __init__(self, dry_run=False):
        self.dry_run = dry_run

    def send_sms(self, phone, message):
        EVENTS.append(("send", phone, message))
        if phone == self.fail_on_phone:
            raise RuntimeError("simulated Phone Link failure")

    def compose_sms(self, phone, message):
        EVENTS.append(("compose", phone, message))


def appointment(apt_num: int, pat_num: int, first: str, last: str, phone: str, status: str = "") -> dict:
    return {
        "AptNum": apt_num,
        "PatNum": pat_num,
        "AptDateTime": "2026-06-08 09:00:00",
        "FName": first,
        "LName": last,
        "Phone": phone,
        "Language": "US",
        "PhoneTargets": [{"source": "Wireless", "phone": phone, "status": status}],
        "_TemplateText": "Reminder for {first_name} at {time_lower}.",
        "_TemplateKey": "US",
        "_TemplateCountry": "US",
    }


class SendWorkerSequenceTest(unittest.TestCase):
    def setUp(self):
        self.original_repo = app.BridgeClient
        self.original_sender = app.PhoneLinkSender
        app.BridgeClient = FakeRepo
        app.PhoneLinkSender = FakePhoneLinkSender
        EVENTS.clear()
        FakePhoneLinkSender.fail_on_phone = ""
        self.config = app.AppConfig(
            api_token="test-token",
            dry_run=False,
            sms_templates={"US": "Reminder for {first_name} at {time_lower}."},
            sms_template_countries={"US": "US"},
        )

    def tearDown(self):
        app.BridgeClient = self.original_repo
        app.PhoneLinkSender = self.original_sender

    def test_each_appointment_is_logged_only_after_its_own_send_attempt(self):
        worker = app.SendWorker(
            self.config,
            [
                appointment(1001, 501, "First", "Patient", "(281) 111-1111"),
                appointment(1002, 502, "Second", "Patient", "(281) 222-2222"),
            ],
        )

        worker.run()

        sequence = [event[:4] if event[0] == "log" else event[:2] for event in EVENTS]
        self.assertEqual(
            sequence,
            [
                ("send", "(281) 111-1111"),
                ("log", 1001, "(281) 111-1111", "needs-review"),
                ("send", "(281) 222-2222"),
                ("log", 1002, "(281) 222-2222", "needs-review"),
            ],
        )
        log_statuses = [event[3] for event in EVENTS if event[0] == "log"]
        self.assertEqual(log_statuses, ["needs-review", "needs-review"])
        self.assertNotIn("sent", log_statuses)

    def test_second_appointment_failure_does_not_mark_it_sent(self):
        FakePhoneLinkSender.fail_on_phone = "(281) 222-2222"
        worker = app.SendWorker(
            self.config,
            [
                appointment(1001, 501, "First", "Patient", "(281) 111-1111"),
                appointment(1002, 502, "Second", "Patient", "(281) 222-2222"),
            ],
        )

        worker.run()

        self.assertEqual(
            [event[:4] if event[0] == "log" else event[:2] for event in EVENTS],
            [
                ("send", "(281) 111-1111"),
                ("log", 1001, "(281) 111-1111", "needs-review"),
                ("send", "(281) 222-2222"),
                ("log", 1002, "(281) 222-2222", "failed"),
            ],
        )
        failed_log = [event for event in EVENTS if event[0] == "log" and event[1] == 1002][0]
        self.assertNotEqual(failed_log[3], "sent")

    def test_first_appointment_failure_stops_before_second_appointment(self):
        FakePhoneLinkSender.fail_on_phone = "(281) 111-1111"
        worker = app.SendWorker(
            self.config,
            [
                appointment(1001, 501, "First", "Patient", "(281) 111-1111"),
                appointment(1002, 502, "Second", "Patient", "(281) 222-2222"),
            ],
        )

        worker.run()

        self.assertEqual(
            [event[:4] if event[0] == "log" else event[:2] for event in EVENTS],
            [
                ("send", "(281) 111-1111"),
                ("log", 1001, "(281) 111-1111", "failed"),
            ],
        )

    def test_needs_review_rows_are_skipped_without_blocking_later_pending_rows(self):
        worker = app.SendWorker(
            self.config,
            [
                appointment(1001, 501, "First", "Patient", "(281) 111-1111", status="needs-review"),
                appointment(1002, 502, "Second", "Patient", "(281) 222-2222"),
            ],
        )

        worker.run()

        self.assertEqual(
            EVENTS,
            [
                ("send", "(281) 222-2222", "Reminder for Second at 9:00 am."),
                ("log", 1002, "(281) 222-2222", "needs-review", "", "Reminder for Second at 9:00 am."),
            ],
        )

    def test_compose_worker_fills_template_without_sending_or_logging(self):
        row = appointment(1001, 501, "First", "Patient", "(281) 111-1111")
        row["_TemplateText"] = "Custom reminder for {first_name}."

        worker = app.ComposeReminderWorker(self.config, row)
        worker.run()

        self.assertEqual(
            EVENTS,
            [("compose", "(281) 111-1111", "Custom reminder for First.")],
        )


class PhoneLinkSenderSequenceTest(unittest.TestCase):
    def test_real_send_continues_when_phone_link_keeps_stale_message_value(self):
        events = []
        old_platform_system = app.platform.system
        old_sleep = app.time.sleep
        old_copy = app.pyperclip.copy
        old_open = app.PhoneLinkSender.open_phone_link
        old_close = app.PhoneLinkSender.close_phone_link
        old_pywinauto = sys.modules.get("pywinauto")
        old_keyboard = sys.modules.get("pywinauto.keyboard")
        clipboard = {"value": ""}
        focused = {"control": None}

        class FakeRect:
            def __init__(self, top, bottom):
                self.top = top
                self.bottom = bottom

        class FakeEdit:
            def __init__(self, name, top):
                self.element_info = types.SimpleNamespace(name=name, control_type="Text")
                self._rect = FakeRect(top, top + 40)
                self.value = ""

            def rectangle(self):
                return self._rect

            def click_input(self):
                focused["control"] = self
                events.append(("click", self.element_info.name))

            def get_value(self):
                return self.value

        search_box = FakeEdit("Search messages", 180)
        message_box = FakeEdit("Send a message", 700)

        class FakeWindow:
            def exists(self, timeout=0):
                return True

            def set_focus(self):
                events.append(("focus",))

            def wrapper_object(self):
                return self

            def rectangle(self):
                return FakeRect(100, 800)

            def descendants(self, control_type=None):
                self.assert_control_type = control_type
                return [search_box, message_box]

        window = FakeWindow()

        class FakeDesktop:
            def __init__(self, backend=None):
                self.backend = backend

            def window(self, title_re=None):
                events.append(("window", title_re))
                return window

        class FakeApplication:
            def __init__(self, backend=None):
                self.backend = backend

        def fake_send_keys(keys):
            events.append(("key", keys))
            control = focused["control"]
            if keys == "^v" and control is not None:
                control.value = clipboard["value"]

        fake_pywinauto = types.SimpleNamespace(Desktop=FakeDesktop, Application=FakeApplication)
        fake_keyboard = types.SimpleNamespace(send_keys=fake_send_keys)

        try:
            app.platform.system = lambda: "Windows"
            app.time.sleep = lambda _seconds: None
            def fake_copy(text):
                clipboard["value"] = text
                events.append(("copy", text))

            app.pyperclip.copy = fake_copy
            app.PhoneLinkSender.open_phone_link = staticmethod(lambda: events.append(("open",)))
            def fake_close(target=None):
                events.append(("close", target is window))
                return True

            app.PhoneLinkSender.close_phone_link = staticmethod(fake_close)
            sys.modules["pywinauto"] = fake_pywinauto
            sys.modules["pywinauto.keyboard"] = fake_keyboard

            app.PhoneLinkSender(dry_run=False).send_sms("(281) 111-1111", "Test message")

            self.assertEqual(
                events,
                [
                    ("close", False),
                    ("open",),
                    ("window", ".*(Phone Link|Liên kết Điện thoại|Messages).*"),
                    ("focus",),
                    ("key", "{ESC}"),
                    ("key", "^n"),
                    ("copy", "(281) 111-1111"),
                    ("key", "^v"),
                    ("key", "{ENTER}"),
                    ("click", "Send a message"),
                    ("click", "Send a message"),
                    ("copy", "Test message"),
                    ("key", "^v"),
                    ("key", "{ENTER}"),
                    ("close", True),
                ],
            )
            self.assertEqual(message_box.value, "Test message")
        finally:
            app.platform.system = old_platform_system
            app.time.sleep = old_sleep
            app.pyperclip.copy = old_copy
            app.PhoneLinkSender.open_phone_link = old_open
            app.PhoneLinkSender.close_phone_link = old_close
            if old_pywinauto is None:
                sys.modules.pop("pywinauto", None)
            else:
                sys.modules["pywinauto"] = old_pywinauto
            if old_keyboard is None:
                sys.modules.pop("pywinauto.keyboard", None)
            else:
                sys.modules["pywinauto.keyboard"] = old_keyboard


if __name__ == "__main__":
    unittest.main()
