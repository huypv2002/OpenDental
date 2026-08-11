from __future__ import annotations

import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


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

    def log_patient_result(self, patient, message, status, error="", phone=None):
        EVENTS.append(("patient-log", patient["PatNum"], phone, status, error, message))

    def log_campaign_result(self, patient, message, status, error="", phone=None):
        EVENTS.append(("campaign-log", patient["PatNum"], phone, status, error, message))

    def fetch_patients(self, query="", limit=500, offset=0):
        EVENTS.append(("fetch-patients", query, limit, offset))
        return [
            {"PatNum": offset + index, "FName": f"Patient{index}", "LName": "Search", "Phone": "(281) 111-1111"}
            for index in range(limit)
        ]


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
    def test_fd2_workstation_detection_uses_windows_computer_name(self):
        with patch.dict(app.os.environ, {"COMPUTERNAME": "FD2"}, clear=False):
            self.assertTrue(app.is_fd2_workstation())
        with patch.dict(app.os.environ, {"COMPUTERNAME": "FD2-FrontDesk"}, clear=False):
            self.assertTrue(app.is_fd2_workstation())
        with patch.dict(app.os.environ, {"COMPUTERNAME": "R5"}, clear=False):
            self.assertFalse(app.is_fd2_workstation())

    def test_legacy_patient_with_wireless_and_work_phone_uses_wireless_once(self):
        row = appointment(1001, 501, "First", "Patient", "(281) 111-1111")
        row["PhoneTargets"] = [
            {"source": "Wireless", "phone": "(281) 111-1111", "status": ""},
            {"source": "Work Phone", "phone": "(281) 222-2222", "status": ""},
        ]

        self.assertEqual(
            app.sendable_phone_targets(row),
            [{"source": "Wireless", "phone": "(281) 111-1111", "status": ""}],
        )

    def test_patient_without_wireless_is_skipped_instead_of_using_work_phone(self):
        row = {
            "PatNum": 501,
            "WkPhone": "(281) 222-2222",
            "Phone": "(281) 222-2222",
            "PhoneTargets": [{"source": "Work Phone", "phone": "(281) 222-2222", "status": ""}],
        }

        self.assertEqual(app.wireless_phone_value(row), "")
        self.assertEqual(app.sendable_phone_targets(row), [])

    def test_patient_today_context_is_merged_from_appointment_feed(self):
        patients = [{"PatNum": 501, "FName": "First", "AptNum": None, "AptDateTime": None}]
        appointments = [
            {"PatNum": 501, "AptNum": 1001, "AptDateTime": "2026-08-09 16:30:00"},
            {"PatNum": 501, "AptNum": 1002, "AptDateTime": "2026-08-09 17:00:00"},
        ]

        merged = app.merge_patient_appointment_context(patients, appointments)

        self.assertEqual(merged[0]["AptNum"], 1001)
        self.assertEqual(merged[0]["AptDateTime"], "2026-08-09 16:30:00")
        self.assertEqual(merged[0]["_ReminderOffsetDays"], 0)
        self.assertIsNone(patients[0]["AptDateTime"])

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

    def test_first_appointment_failure_continues_with_second_appointment(self):
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
                ("send", "(281) 222-2222"),
                ("log", 1002, "(281) 222-2222", "needs-review"),
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

    def test_same_day_template_renders_appointment_date_and_time(self):
        row = appointment(1001, 501, "First", "Patient", "(281) 111-1111")
        row["AptDateTime"] = f"{app.clinic_today().isoformat()} 16:30:00"
        row["_ReminderOffsetDays"] = 0

        message = app.render_message(
            self.config,
            row,
            "Appointment {relative_day}, {weekday}, {date_full} at {time_lower}.",
        )

        self.assertIn("Appointment today,", message)
        self.assertIn("4:30 pm.", message)
        self.assertNotIn("{date_full}", message)
        self.assertNotIn("{time_lower}", message)

    def test_template_datetime_placeholder_detection(self):
        self.assertTrue(app.template_uses_appointment_datetime("Today at {time_lower} on {date_full}."))
        self.assertFalse(app.template_uses_appointment_datetime("Hello {first_name}."))

    def test_manual_patient_rows_ignore_old_status_and_log_sent(self):
        row = appointment(1001, 501, "Manual", "Patient", "(281) 111-1111", status="needs-review")
        row["_PatientManual"] = True

        worker = app.SendWorker(self.config, [row])
        worker.run()

        self.assertEqual(
            EVENTS,
            [
                ("send", "(281) 111-1111", "Reminder for Manual at 9:00 am."),
                ("patient-log", 501, "(281) 111-1111", "sent", "", "Reminder for Manual at 9:00 am."),
            ],
        )

    def test_manual_patient_fd2_mode_fills_one_draft_without_logging(self):
        first = appointment(1001, 501, "Manual", "Patient", "(281) 111-1111", status="needs-review")
        second = appointment(1002, 502, "Second", "Patient", "(281) 222-2222")
        first["_PatientManual"] = True
        second["_PatientManual"] = True

        old_fd2_log_path = app.FD2_DEBUG_LOG_PATH
        with tempfile.TemporaryDirectory() as temp_dir:
            app.FD2_DEBUG_LOG_PATH = Path(temp_dir) / "fd2-debug.log"
            try:
                worker = app.SendWorker(self.config, [first, second], fd2_mode=True)
                worker.run()
            finally:
                app.FD2_DEBUG_LOG_PATH = old_fd2_log_path

        self.assertEqual(
            EVENTS,
            [("send", "(281) 111-1111", "Reminder for Manual at 9:00 am.")],
        )

    def test_manual_patient_fd2_failure_does_not_write_failed_log(self):
        FakePhoneLinkSender.fail_on_phone = "(281) 111-1111"
        row = appointment(1001, 501, "Manual", "Patient", "(281) 111-1111", status="needs-review")
        row["_PatientManual"] = True

        old_fd2_log_path = app.FD2_DEBUG_LOG_PATH
        with tempfile.TemporaryDirectory() as temp_dir:
            app.FD2_DEBUG_LOG_PATH = Path(temp_dir) / "fd2-debug.log"
            try:
                worker = app.SendWorker(self.config, [row], fd2_mode=True)
                worker.run()
            finally:
                app.FD2_DEBUG_LOG_PATH = old_fd2_log_path

        self.assertEqual(
            EVENTS,
            [("send", "(281) 111-1111", "Reminder for Manual at 9:00 am.")],
        )

    def test_manual_patient_worker_searches_one_page_with_has_more_marker(self):
        captured = []
        worker = app.LoadManualPatientsWorker(self.config, "smith", limit=2, offset=4)
        worker.loaded.connect(lambda patients, logs, query, offset, has_more: captured.append((patients, logs, query, offset, has_more)))

        worker.run()

        self.assertEqual(EVENTS, [("fetch-patients", "smith", 3, 4)])
        self.assertEqual(captured[0][2:], ("smith", 4, True))
        self.assertEqual([patient["PatNum"] for patient in captured[0][0]], [4, 5])

    def test_hash_patient_search_matches_only_patient_number(self):
        row = {"PatNum": 501, "FName": "Manual", "LName": "Patient", "Phone": "(281) 111-1111"}
        values = [app.patient_name(row), row.get("Phone"), row.get("PatNum")]

        self.assertTrue(app.row_matches_patient_search(row, "281", values))
        self.assertFalse(app.row_matches_patient_search(row, "#281", values))
        self.assertTrue(app.row_matches_patient_search(row, "#501", values))

    def test_manual_patient_worker_strips_hash_for_bridge_but_keeps_ui_query(self):
        captured = []
        worker = app.LoadManualPatientsWorker(self.config, "#281", limit=2, offset=0)
        worker.loaded.connect(lambda patients, logs, query, offset, has_more: captured.append((patients, logs, query, offset, has_more)))

        worker.run()

        self.assertEqual(EVENTS, [("fetch-patients", "281", 3, 0)])
        self.assertEqual(captured[0][2], "#281")

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
    def test_phone_link_window_lookup_retries_and_returns_real_wrapper(self):
        calls = []

        class FakeWindow:
            element_info = types.SimpleNamespace(handle=123)

            def rectangle(self):
                return types.SimpleNamespace(left=100, top=100, right=1100, bottom=800)

            def window_text(self):
                return "Phone Link"

            def is_visible(self):
                return True

        window = FakeWindow()

        class FakeDesktop:
            def windows(self, **kwargs):
                calls.append(kwargs)
                return [] if len(calls) == 1 else [window]

        with patch.object(app.time, "sleep", lambda _seconds: None):
            result = app.PhoneLinkSender.wait_for_phone_link_window(timeout=1.0, desktop=FakeDesktop())

        self.assertIs(result, window)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["title_re"], app.PHONE_LINK_TITLE_RE)

    def test_standard_message_box_lookup_accepts_real_uia_wrapper(self):
        class FakeControl:
            element_info = types.SimpleNamespace(name="Send a message", control_type="Edit")

            def rectangle(self):
                return types.SimpleNamespace(left=500, top=700, right=900, bottom=750)

            def window_text(self):
                return "Send a message"

        message_box = FakeControl()

        class FakeWrapper:
            def rectangle(self):
                return types.SimpleNamespace(left=100, top=100, right=1000, bottom=800)

            def descendants(self):
                return [message_box]

        result = app.PhoneLinkSender.find_message_box(FakeWrapper())

        self.assertIsNotNone(result)
        self.assertIs(result[0], message_box)

    def test_fd2_detailed_element_log_identifies_exact_input_without_value_text(self):
        class FakeControl:
            element_info = types.SimpleNamespace(
                name="Send a message",
                control_type="Edit",
                automation_id="InputTextBox",
                class_name="TextBox",
            )

            def rectangle(self):
                return types.SimpleNamespace(left=500, top=700, right=900, bottom=760)

            def is_visible(self):
                return True

            def is_enabled(self):
                return True

            def has_keyboard_focus(self):
                return True

            def get_value(self):
                return "Private patient message"

        detail = app.PhoneLinkSender.describe_control_detailed(
            FakeControl(),
            types.SimpleNamespace(left=100, top=100, right=1000, bottom=800),
        )

        self.assertIn("auto_id='InputTextBox'", detail)
        self.assertIn("type='Edit'", detail)
        self.assertIn("focused=True", detail)
        self.assertIn("message_input=True", detail)
        self.assertIn("value_chars=23", detail)
        self.assertIn("pid=?", detail)
        self.assertIn("runtime_id='?'", detail)
        self.assertNotIn("Private patient message", detail)

    def test_fd2_element_log_redacts_recipient_from_accessible_name(self):
        class FakeControl:
            element_info = types.SimpleNamespace(
                name="Send a message, New conversation with 1234567892.",
                control_type="Edit",
                automation_id="InputTextBox",
                class_name="TextBox",
            )

            def rectangle(self):
                return types.SimpleNamespace(left=500, top=700, right=900, bottom=760)

            def get_value(self):
                return ""

        detail = app.PhoneLinkSender.describe_control_detailed(FakeControl())

        self.assertIn("New conversation with <redacted-recipient>", detail)
        self.assertNotIn("1234567892", detail)

    def test_fd2_keyboard_fallback_stops_on_real_message_input(self):
        events = []
        old_slow_keys = app.PhoneLinkSender.slow_keys
        old_focused = app.PhoneLinkSender.focused_control_fd2

        class FakeWindow:
            def set_focus(self):
                events.append("window-focus")

        class FakeControl:
            def __init__(self, control_type, automation_id):
                self.element_info = types.SimpleNamespace(
                    name="",
                    control_type=control_type,
                    automation_id=automation_id,
                    class_name="TextBox" if control_type == "Edit" else "Button",
                )

        focused_controls = iter([
            FakeControl("Button", "AttachButton"),
            FakeControl("Edit", "InputTextBox"),
        ])

        try:
            app.PhoneLinkSender.slow_keys = staticmethod(lambda keys, delay=None: events.append(keys))
            app.PhoneLinkSender.focused_control_fd2 = staticmethod(lambda _window: next(focused_controls))

            result = app.PhoneLinkSender.keyboard_focus_message_box_fd2(FakeWindow())

            self.assertEqual(result.element_info.automation_id, "InputTextBox")
            self.assertEqual(events, ["window-focus", "{TAB}", "{TAB}"])
        finally:
            app.PhoneLinkSender.slow_keys = staticmethod(old_slow_keys)
            app.PhoneLinkSender.focused_control_fd2 = staticmethod(old_focused)

    def test_fd2_compose_click_prefers_real_input_over_lower_text_label(self):
        events = []
        old_candidates = app.PhoneLinkSender.message_box_candidates_fd2
        old_click_center = app.PhoneLinkSender.click_control_center
        old_sleep = app.time.sleep
        old_pywinauto = sys.modules.get("pywinauto")

        class FakeControl:
            def __init__(self, name, control_type, automation_id, top):
                self.element_info = types.SimpleNamespace(
                    name=name,
                    control_type=control_type,
                    automation_id=automation_id,
                    class_name="TextBox" if control_type == "Edit" else "TextBlock",
                )
                self.top = top

            def has_keyboard_focus(self):
                return self.element_info.control_type == "Edit"

        label = FakeControl("Send a message", "Text", "MessagePlaceholder", 760)
        input_box = FakeControl("", "Edit", "InputTextBox", 720)

        try:
            app.PhoneLinkSender.message_box_candidates_fd2 = staticmethod(lambda _window: [label, input_box])
            app.PhoneLinkSender.click_control_center = staticmethod(
                lambda control: events.append(control.element_info.automation_id) or (500, control.top)
            )
            app.time.sleep = lambda _seconds: None
            sys.modules["pywinauto"] = types.SimpleNamespace(mouse=types.SimpleNamespace(click=lambda **_kwargs: None))

            coords = app.PhoneLinkSender.click_fd2_compose_coords(object())

            self.assertEqual(events, ["InputTextBox"])
            self.assertEqual(coords, (500, 720))
        finally:
            app.PhoneLinkSender.message_box_candidates_fd2 = staticmethod(old_candidates)
            app.PhoneLinkSender.click_control_center = staticmethod(old_click_center)
            app.time.sleep = old_sleep
            if old_pywinauto is None:
                sys.modules.pop("pywinauto", None)
            else:
                sys.modules["pywinauto"] = old_pywinauto

    def test_coordinate_fallback_runs_only_after_initial_paste_verification_fails(self):
        events = []
        original_copy = app.pyperclip.copy
        original_slow_keys = app.PhoneLinkSender.slow_keys
        original_wait = app.PhoneLinkSender.wait_for_value
        original_click = app.PhoneLinkSender.click_message_box_coords
        verification_results = iter([False, True])

        try:
            app.pyperclip.copy = lambda text: events.append(("copy", text))
            app.PhoneLinkSender.slow_keys = staticmethod(
                lambda keys, delay=None: events.append(("key", keys))
            )
            app.PhoneLinkSender.wait_for_value = staticmethod(
                lambda *_args, **_kwargs: next(verification_results)
            )
            app.PhoneLinkSender.click_message_box_coords = staticmethod(
                lambda _window: events.append(("coordinate-fallback",))
            )

            app.PhoneLinkSender.paste_message_with_fallback(object(), object(), "Test message")

            self.assertEqual(
                events,
                [
                    ("copy", "Test message"),
                    ("key", "^v"),
                    ("coordinate-fallback",),
                    ("key", "^a"),
                    ("key", "{BACKSPACE}"),
                    ("copy", "Test message"),
                    ("key", "^v"),
                ],
            )
        finally:
            app.pyperclip.copy = original_copy
            app.PhoneLinkSender.slow_keys = staticmethod(original_slow_keys)
            app.PhoneLinkSender.wait_for_value = staticmethod(original_wait)
            app.PhoneLinkSender.click_message_box_coords = staticmethod(original_click)

    def test_standard_message_box_lookup_refreshes_before_second_paste_attempt(self):
        sender = app.PhoneLinkSender(dry_run=False)
        first_window = object()
        refreshed_window = object()
        field = object()
        events = []

        with patch.object(
            app.PhoneLinkSender,
            "focus_message_box",
            side_effect=[RuntimeError("stale element"), field],
        ), patch.object(
            app.PhoneLinkSender,
            "wait_for_phone_link_window",
            return_value=refreshed_window,
        ) as wait_window, patch.object(
            app.PhoneLinkSender,
            "click_control",
            side_effect=lambda control: events.append(("click", control)),
        ), patch.object(
            app.PhoneLinkSender,
            "slow_keys",
            side_effect=lambda keys, delay=None: events.append(("key", keys, delay)),
        ), patch.object(
            app.PhoneLinkSender,
            "paste_message_with_fallback",
            side_effect=lambda window, control, message: events.append(("paste", window, control, message)),
        ):
            result = sender.paste_message_standard_resilient(first_window, "Test message")

        self.assertIs(result, refreshed_window)
        wait_window.assert_called_once_with(timeout=8.0)
        self.assertEqual(
            events,
            [
                ("click", field),
                ("key", "^a", 0.2),
                ("key", "{BACKSPACE}", 0.2),
                ("paste", refreshed_window, field, "Test message"),
            ],
        )

    def test_real_send_continues_when_phone_link_keeps_stale_message_value(self):
        events = []
        old_platform_system = app.platform.system
        old_sleep = app.time.sleep
        old_copy = app.pyperclip.copy
        old_open = app.PhoneLinkSender.open_phone_link
        old_close = app.PhoneLinkSender.close_phone_link
        old_wait_window = app.PhoneLinkSender.wait_for_phone_link_window
        old_pywinauto = sys.modules.get("pywinauto")
        old_keyboard = sys.modules.get("pywinauto.keyboard")
        clipboard = {"value": ""}
        focused = {"control": None}

        class FakeRect:
            def __init__(self, top, bottom, left=100, right=900):
                self.top = top
                self.bottom = bottom
                self.left = left
                self.right = right

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

        fake_mouse = types.SimpleNamespace(
            click=lambda button, coords: events.append(("mouse-click", button, coords))
        )
        fake_pywinauto = types.SimpleNamespace(
            Desktop=FakeDesktop,
            Application=FakeApplication,
            mouse=fake_mouse,
        )
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
            app.PhoneLinkSender.wait_for_phone_link_window = staticmethod(
                lambda timeout=0, **_kwargs: events.append(("wait-window", timeout)) or window
            )
            sys.modules["pywinauto"] = fake_pywinauto
            sys.modules["pywinauto.keyboard"] = fake_keyboard

            app.PhoneLinkSender(dry_run=False).send_sms("(281) 111-1111", "Test message")

            self.assertEqual(
                events,
                [
                    ("close", False),
                    ("open",),
                    ("wait-window", 20.0),
                    ("focus",),
                    ("key", "{ESC}"),
                    ("key", "^n"),
                    ("wait-window", 4.0),
                    ("copy", "(281) 111-1111"),
                    ("key", "^v"),
                    ("key", "{ENTER}"),
                    ("wait-window", 8.0),
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
            app.PhoneLinkSender.wait_for_phone_link_window = staticmethod(old_wait_window)
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
