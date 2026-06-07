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


if __name__ == "__main__":
    unittest.main()
