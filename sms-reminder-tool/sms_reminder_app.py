from __future__ import annotations

import json
import os
import platform
import re
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import pyperclip
import requests
from dotenv import load_dotenv
from PySide6.QtCore import QDate, QSize, QSettings, QThread, QTime, QTimer, Signal, Qt
from PySide6.QtGui import QColor, QFont, QIcon
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDateEdit,
    QDialog,
    QFormLayout,
    QFrame,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QPlainTextEdit,
    QSpinBox,
    QStatusBar,
    QTabWidget,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QTimeEdit,
    QInputDialog,
    QVBoxLayout,
    QWidget,
)


APP_DIR = Path(__file__).resolve().parent
APP_ICON_PATH = APP_DIR / "tooth.ico"
FLAGS_DIR = APP_DIR / "assets" / "flags"
CONFIG_PATH = APP_DIR / "sms_config.json"
SCHEDULER_ON_PATH = APP_DIR / "scheduler-on.bat"
BRIDGE_ENV_PATH = APP_DIR.parent / ".env"
CLINIC_TIME_ZONE_NOTE = "Use this app on the clinic server set to Houston/Central time."
DEFAULT_RECALL_CODES = "D1110,D1120,D4341,D4342"
DEFAULT_TREATMENT_DAYS = 21
SECOND_APPOINTMENT_REMINDER_DAYS_AHEAD = 8
SCHEDULE_SEND_GRACE_MINUTES = 30
LAZY_TABLE_BATCH_SIZE = 50
HOLIDAY_EVENTS = [
    "New Year's Day",
    "Martin Luther King Jr. Day",
    "Valentine's Day",
    "Presidents' Day",
    "Easter",
    "Mother's Day",
    "Memorial Day",
    "Father's Day",
    "Independence Day",
    "Labor Day",
    "Halloween",
    "Veterans Day",
    "Thanksgiving",
    "Christmas",
    "New Year Promotion",
]
SCHEDULER_TIME_FIELDS = [
    ("ENABLE_LOGIN_TIME", "Enable auto-login"),
    ("RESTART_TIME", "Restart Windows"),
    ("START_TOOL_TIME", "Open Phone Link and tool"),
    ("LOCK_TIME", "Disable auto-login and lock"),
]
DEFAULT_SCHEDULER_TIMES = {
    "ENABLE_LOGIN_TIME": "08:59",
    "RESTART_TIME": "09:00",
    "START_TOOL_TIME": "10:55",
    "LOCK_TIME": "11:05",
}


def qtime_from_hhmm(value: str, fallback: str = "00:00") -> QTime:
    time_value = QTime.fromString(str(value or "").strip(), "HH:mm")
    if time_value.isValid():
        return time_value
    return QTime.fromString(fallback, "HH:mm")


def read_scheduler_bat_times() -> dict[str, str]:
    if not SCHEDULER_ON_PATH.exists():
        raise FileNotFoundError(f"Missing scheduler file: {SCHEDULER_ON_PATH}")
    text = SCHEDULER_ON_PATH.read_text(encoding="utf-8")
    times = dict(DEFAULT_SCHEDULER_TIMES)
    for name, _label in SCHEDULER_TIME_FIELDS:
        pattern = re.compile(rf'(?m)^set[ \t]+"{re.escape(name)}=(\d{{1,2}}:\d{{2}})"[ \t]*$')
        match = pattern.search(text)
        if match:
            times[name] = match.group(1)
    return times


def write_scheduler_bat_times(times: dict[str, str]) -> None:
    if not SCHEDULER_ON_PATH.exists():
        raise FileNotFoundError(f"Missing scheduler file: {SCHEDULER_ON_PATH}")
    text = SCHEDULER_ON_PATH.read_text(encoding="utf-8")
    for name, _label in SCHEDULER_TIME_FIELDS:
        time_value = str(times.get(name) or DEFAULT_SCHEDULER_TIMES[name]).strip()
        if not QTime.fromString(time_value, "HH:mm").isValid():
            raise ValueError(f"{name} must use HH:MM format.")
        pattern = re.compile(rf'(?m)^set[ \t]+"{re.escape(name)}=\d{{1,2}}:\d{{2}}"[ \t]*$')
        replacement = f'set "{name}={time_value}"'
        text, count = pattern.subn(replacement, text, count=1)
        if count == 0:
            raise ValueError(f"Could not find {name} in {SCHEDULER_ON_PATH.name}.")
    SCHEDULER_ON_PATH.write_text(text, encoding="utf-8")


def clinic_now() -> datetime:
    return datetime.now()


def clinic_today() -> date:
    return clinic_now().date()


def clinic_qdate(days_ahead: int = 0) -> QDate:
    today = clinic_today()
    return QDate(today.year, today.month, today.day).addDays(days_ahead)


def digits_only(value: str) -> str:
    digits = re.sub(r"\D+", "", value or "")
    return digits[1:] if len(digits) == 11 and digits.startswith("1") else digits


def format_us_phone(value: str) -> str:
    digits = digits_only(value)
    if len(digits) != 10:
        return str(value or "").strip()
    return f"({digits[:3]}) {digits[3:6]}-{digits[6:]}"


def display_date(value: date | datetime | str | None) -> str:
    if not value:
        return ""
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date):
        return value.strftime("%m/%d/%Y")
    try:
        return datetime.fromisoformat(str(value)[:10]).strftime("%m/%d/%Y")
    except ValueError:
        return str(value)


def parse_datetime(value: datetime | str | None) -> datetime:
    if isinstance(value, datetime):
        return value
    if not value:
        raise ValueError("Missing appointment datetime.")
    text = str(value).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return datetime.strptime(str(value)[:19], "%Y-%m-%d %H:%M:%S")


def display_time(value: datetime | str | None) -> str:
    if not value:
        return ""
    if isinstance(value, datetime):
        return value.strftime("%I:%M %p").lstrip("0")
    text = str(value)
    try:
        return parse_datetime(text).strftime("%I:%M %p").lstrip("0")
    except ValueError:
        pass
    try:
        return datetime.strptime(text[:5], "%H:%M").strftime("%I:%M %p").lstrip("0")
    except ValueError:
        return text


def weekday_en(value: datetime | str | None) -> str:
    try:
        return parse_datetime(value).strftime("%A")
    except ValueError:
        return ""


def weekday_vi(value: datetime | str | None) -> str:
    labels = {
        0: "Thứ 2",
        1: "Thứ 3",
        2: "Thứ 4",
        3: "Thứ 5",
        4: "Thứ 6",
        5: "Thứ 7",
        6: "Chủ nhật",
    }
    try:
        return labels.get(parse_datetime(value).weekday(), "")
    except ValueError:
        return ""


def display_date_short(value: datetime | str | None) -> str:
    try:
        return parse_datetime(value).strftime("%m/%d")
    except ValueError:
        return ""


@dataclass
class AppConfig:
    bridge_url: str = "http://127.0.0.1:3008"
    api_token: str = ""
    clinic_name: str = "LUK Dental"
    clinic_phone: str = "281-760-1357"
    reminder_days_ahead: int = 1
    scheduled_send_time: str = "11:00"
    appointment_statuses: list[int] = field(default_factory=lambda: [1])
    fallback_duration_minutes: int = 30
    dry_run: bool = False
    scheduler_enabled: bool = True
    default_template_key: str = "US"
    sms_templates: dict[str, str] = field(default_factory=dict)
    sms_template_countries: dict[str, str] = field(default_factory=dict)
    recall_codes: str = DEFAULT_RECALL_CODES
    recall_months: int = 6
    recall_template: str = ""
    recall_templates: dict[str, str] = field(default_factory=dict)
    recall_template_countries: dict[str, str] = field(default_factory=dict)
    treatment_days: int = DEFAULT_TREATMENT_DAYS
    treatment_codes: str = ""
    treatment_statuses: str = "1"
    treatment_templates: dict[str, str] = field(default_factory=dict)
    treatment_template_countries: dict[str, str] = field(default_factory=dict)
    review_link: str = ""
    review_templates: dict[str, str] = field(default_factory=dict)
    review_template_countries: dict[str, str] = field(default_factory=dict)
    holiday_templates: dict[str, str] = field(default_factory=dict)
    holiday_template_countries: dict[str, str] = field(default_factory=dict)
    holiday_events: list[str] = field(default_factory=lambda: list(HOLIDAY_EVENTS))
    holiday_campaigns: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def load(cls) -> "AppConfig":
        if CONFIG_PATH.exists():
            with CONFIG_PATH.open("r", encoding="utf-8") as file:
                raw = json.load(file)
            defaults = asdict(cls())
            template_keys = {
                "sms_templates", "sms_template_countries", "recall_templates", "recall_template_countries",
                "treatment_templates", "treatment_template_countries",
                "review_templates", "review_template_countries", "review_link", "sms_template", "recall_template",
                "holiday_templates", "holiday_template_countries", "holiday_events", "holiday_campaigns", "default_template_key", "template_schema_version",
            }
            known = {key: value for key, value in raw.items() if key in defaults and key not in template_keys}
            cfg = cls(**{**defaults, **known})
            cfg.dry_run = False
            migrated = any(key in raw for key in template_keys)
            if cfg.scheduled_send_time == "09:00":
                cfg.scheduled_send_time = "11:00"
                migrated = True
            cfg.default_template_key = "US"
            if migrated:
                cfg.save()
            return cfg
        if BRIDGE_ENV_PATH.exists():
            load_dotenv(BRIDGE_ENV_PATH)
        defaults = cls()
        cfg = cls(
            bridge_url=os.getenv("BRIDGE_URL", defaults.bridge_url),
            api_token=os.getenv("API_TOKEN", defaults.api_token),
            clinic_name=os.getenv("CLINIC_NAME", defaults.clinic_name),
        )
        cfg.dry_run = False
        cfg.save()
        return cfg

    def save(self) -> None:
        data = asdict(self)
        # Templates are stored in the bridge database, not in local JSON.
        for key in (
            "sms_templates", "sms_template_countries", "recall_templates", "recall_template_countries",
            "treatment_templates", "treatment_template_countries",
            "review_templates", "review_template_countries", "review_link", "sms_template", "recall_template",
            "holiday_templates", "holiday_template_countries", "holiday_events", "holiday_campaigns", "default_template_key", "template_schema_version",
        ):
            data.pop(key, None)
        CONFIG_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")


class BridgeClient:
    def __init__(self, config: AppConfig):
        self.config = config

    def endpoint(self, path: str) -> str:
        return urljoin(self.config.bridge_url.rstrip("/") + "/", path.lstrip("/"))

    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.config.api_token}"}

    def request(self, method: str, path: str, **kwargs) -> dict[str, Any]:
        if not self.config.bridge_url.strip():
            raise RuntimeError("Bridge URL is required.")
        if not self.config.api_token.strip():
            raise RuntimeError("Bridge API token is required.")
        response = requests.request(
            method,
            self.endpoint(path),
            headers=self.headers(),
            timeout=20,
            **kwargs,
        )
        try:
            payload = response.json()
        except ValueError as exc:
            raise RuntimeError(f"Bridge returned non-JSON response: HTTP {response.status_code}") from exc
        if not response.ok or not payload.get("ok"):
            raise RuntimeError(payload.get("error") or f"Bridge request failed: HTTP {response.status_code}")
        return payload.get("data") or {}

    def health_check(self) -> None:
        self.request("GET", "/health")

    def fetch_appointments(self, target_date: date) -> list[dict[str, Any]]:
        data = self.request(
            "GET",
            "/api/sms-reminders/appointments",
            params={
                "date": target_date.isoformat(),
                "statuses": ",".join(str(item) for item in self.config.appointment_statuses or [1]),
            },
        )
        return data.get("appointments") or []

    def fetch_recall_candidates(self, months: int, codes: str) -> list[dict[str, Any]]:
        data = self.request(
            "GET",
            "/api/sms-reminders/recall-candidates",
            params={
                "months": months,
                "codes": codes,
                "statuses": ",".join(str(item) for item in self.config.appointment_statuses or [1]),
                "limit": 500,
            },
        )
        return data.get("patients") or []

    def fetch_treatment_candidates(self, days: int, codes: str, treatment_statuses: str) -> list[dict[str, Any]]:
        data = self.request(
            "GET",
            "/api/sms-reminders/treatment-candidates",
            params={
                "beforeDays": days,
                "codes": codes,
                "treatmentStatuses": treatment_statuses,
                "statuses": ",".join(str(item) for item in self.config.appointment_statuses or [1]),
                "limit": 500,
            },
        )
        return data.get("patients") or []

    def fetch_patients(self, query: str = "", limit: int = 300) -> list[dict[str, Any]]:
        data = self.request(
            "GET",
            "/api/admin/patients",
            params={"q": query.strip(), "limit": limit},
        )
        return data.get("patients") or []

    def fetch_birthday_candidates(self, target_date: date) -> list[dict[str, Any]]:
        data = self.request(
            "GET",
            "/api/sms-reminders/birthday-candidates",
            params={"date": target_date.isoformat(), "limit": 500},
        )
        return data.get("patients") or []

    def log_result(self, appointment: dict[str, Any], message: str, status: str, error: str = "", phone: str | None = None) -> None:
        apt_time = parse_datetime(appointment.get("AptDateTime"))
        self.request(
            "POST",
            "/api/sms-reminders/log",
            json={
                "aptNum": appointment["AptNum"],
                "patNum": appointment["PatNum"],
                "phone": phone or appointment.get("Phone", ""),
                "reminderForDate": apt_time.date().isoformat(),
                "reminderOffsetDays": reminder_offset_days(appointment),
                "message": message,
                "status": status,
                "errorMessage": error,
            },
        )

    def log_recall_result(self, patient: dict[str, Any], message: str, status: str, error: str = "", phone: str | None = None) -> None:
        self.request(
            "POST",
            "/api/sms-reminders/recall-log",
            json={
                "patNum": patient["PatNum"],
                "phone": phone or patient.get("Phone", ""),
                "procedureCodes": patient.get("ProcedureCodes", ""),
                "lastProcDate": patient.get("LastProcDate", ""),
                "message": message,
                "status": status,
                "errorMessage": error,
            },
        )

    def log_treatment_result(self, patient: dict[str, Any], message: str, status: str, error: str = "", phone: str | None = None) -> None:
        self.request(
            "POST",
            "/api/sms-reminders/treatment-log",
            json={
                "patNum": patient["PatNum"],
                "phone": phone or patient.get("Phone", ""),
                "procedureCodes": patient.get("ProcedureCodes", ""),
                "lastPendingProcDate": patient.get("LastPendingProcDate") or patient.get("LastProcDate", ""),
                "message": message,
                "status": status,
                "errorMessage": error,
            },
        )

    def log_campaign_result(self, patient: dict[str, Any], message: str, status: str, error: str = "", phone: str | None = None) -> None:
        self.request(
            "POST",
            "/api/sms-reminders/campaign-log",
            json={
                "campaignType": patient.get("_CampaignType", ""),
                "campaignName": patient.get("_CampaignName", ""),
                "patNum": patient.get("PatNum") or 0,
                "phone": phone or patient.get("Phone", ""),
                "templateKey": patient.get("_TemplateKey", ""),
                "message": message,
                "status": status,
                "errorMessage": error,
            },
        )

    def fetch_recent_logs(self, limit: int = 200) -> list[dict[str, Any]]:
        data = self.request("GET", "/api/sms-reminders/logs", params={"limit": limit})
        return data.get("logs") or []

    def clear_dry_run_logs(self) -> dict[str, Any]:
        return self.request("POST", "/api/sms-reminders/clear-dry-run")

    def reset_reminder_log(self, appointment: dict[str, Any], phone: str) -> dict[str, Any]:
        apt_time = parse_datetime(appointment.get("AptDateTime"))
        return self.request(
            "POST",
            "/api/sms-reminders/reset-log",
            json={
                "aptNum": appointment["AptNum"],
                "phone": phone,
                "reminderForDate": apt_time.date().isoformat(),
                "reminderOffsetDays": reminder_offset_days(appointment),
            },
        )


    # Template management via bridge API
    def fetch_templates(self) -> dict[str, Any]:
        return self.request("GET", "/api/sms-templates")

    def init_default_templates(self) -> dict[str, Any]:
        return self.request("GET", "/api/sms-templates/init")

    def fetch_sms_settings(self) -> dict[str, Any]:
        return self.request("GET", "/api/sms-settings")

    def save_sms_setting(self, setting_key: str, setting_value: str) -> dict[str, Any]:
        return self.request("PUT", "/api/sms-settings", json={
            "settingKey": setting_key,
            "settingValue": setting_value,
        })

    def add_template(self, template_key: str, category: str, country: str, template_text: str) -> dict[str, Any]:
        return self.request("POST", "/api/sms-templates", json={
            "templateKey": template_key,
            "category": category,
            "country": country,
            "templateText": template_text,
        })

    def save_template(self, template_key: str, category: str, country: str, template_text: str) -> dict[str, Any]:
        return self.request("PUT", "/api/sms-templates", json={
            "templateKey": template_key,
            "category": category,
            "country": country,
            "templateText": template_text,
        })

    def delete_template(self, template_key: str, category: str) -> dict[str, Any]:
        return self.request("DELETE", "/api/sms-templates", json={
            "templateKey": template_key,
            "category": category,
        })



class PhoneLinkSender:
    STEP_DELAY_SECONDS = 1.25
    COMPOSE_DELAY_SECONDS = 2.0
    SEND_SETTLE_SECONDS = 2.0

    def __init__(self, dry_run: bool = True):
        self.dry_run = dry_run

    @staticmethod
    def open_phone_link() -> None:
        if platform.system() != "Windows":
            raise RuntimeError("Phone Link can only be opened on the Windows clinic server.")
        subprocess.Popen(
            ["explorer.exe", r"shell:AppsFolder\Microsoft.YourPhone_8wekyb3d8bbwe!App"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    @staticmethod
    def slow_keys(keys: str, delay: float | None = None) -> None:
        from pywinauto.keyboard import send_keys

        send_keys(keys)
        time.sleep(PhoneLinkSender.STEP_DELAY_SECONDS if delay is None else delay)

    def focus_new_message(self, window: Any) -> None:
        window.set_focus()
        time.sleep(self.STEP_DELAY_SECONDS)
        # Escape clears transient focus such as a selected recipient chip or an open flyout.
        self.slow_keys("{ESC}", 0.75)
        self.slow_keys("^n", self.COMPOSE_DELAY_SECONDS)

    def send_sms(self, phone: str, message: str) -> None:
        if self.dry_run:
            time.sleep(0.25)
            return
        if platform.system() != "Windows":
            raise RuntimeError("Phone Link automation only runs on Windows.")
        if not digits_only(phone):
            raise RuntimeError("Missing valid phone number.")

        try:
            from pywinauto import Desktop, Application
        except ImportError as exc:
            raise RuntimeError("pywinauto is not installed. Run: pip install -r requirements.txt") from exc

        self.open_phone_link()
        time.sleep(4)

        desktop = Desktop(backend="uia")
        window = desktop.window(title_re=".*(Phone Link|Liên kết Điện thoại|Messages).*")
        if not window.exists(timeout=10):
            app = Application(backend="uia").connect(title_re=".*Phone Link.*", timeout=10)
            window = app.top_window()

        self.focus_new_message(window)
        pyperclip.copy(phone)
        self.slow_keys("^v")
        self.slow_keys("{ENTER}", 2.0)
        self.slow_keys("{TAB 2}", 1.25)
        pyperclip.copy(message)
        self.slow_keys("^v", 1.25)
        self.slow_keys("{ENTER}", self.SEND_SETTLE_SECONDS)

    def compose_sms(self, phone: str, message: str) -> None:
        if platform.system() != "Windows":
            raise RuntimeError("Phone Link automation only runs on Windows.")
        if not digits_only(phone):
            raise RuntimeError("Missing valid phone number.")

        try:
            from pywinauto import Desktop, Application
        except ImportError as exc:
            raise RuntimeError("pywinauto is not installed. Run: pip install -r requirements.txt") from exc

        self.open_phone_link()
        time.sleep(4)

        desktop = Desktop(backend="uia")
        window = desktop.window(title_re=".*(Phone Link|Liên kết Điện thoại|Messages).*")
        if not window.exists(timeout=10):
            app = Application(backend="uia").connect(title_re=".*Phone Link.*", timeout=10)
            window = app.top_window()

        self.focus_new_message(window)
        pyperclip.copy(phone)
        self.slow_keys("^v")
        self.slow_keys("{ENTER}", 2.0)
        self.slow_keys("{TAB 2}", 1.25)
        pyperclip.copy(message)
        self.slow_keys("^v", 1.25)


class OpenDentalPatientViewer:
    STEP_DELAY_SECONDS = 0.45

    @staticmethod
    def slow_keys(keys: str, delay: float | None = None) -> None:
        from pywinauto.keyboard import send_keys

        send_keys(keys)
        time.sleep(OpenDentalPatientViewer.STEP_DELAY_SECONDS if delay is None else delay)

    @staticmethod
    def type_text(text: str, delay: float | None = None) -> None:
        from pywinauto.keyboard import send_keys

        send_keys(str(text), with_spaces=True)
        time.sleep(OpenDentalPatientViewer.STEP_DELAY_SECONDS if delay is None else delay)

    @staticmethod
    def format_birthdate(value: Any) -> str:
        text = str(value or "").strip()
        if not text:
            return ""
        for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m-%d-%Y"):
            try:
                return datetime.strptime(text[:10], fmt).strftime("%m/%d/%Y")
            except ValueError:
                continue
        return text

    @staticmethod
    def open_open_dental() -> None:
        if platform.system() != "Windows":
            raise RuntimeError("Open Dental automation only runs on the Windows clinic workstation.")
        shortcut_candidates = [
            Path(r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Open Dental.lnk"),
            Path(r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Open Dental\Open Dental.lnk"),
            Path.home() / "Desktop" / "Open Dental.lnk",
            Path(r"C:\Users\Public\Desktop\Open Dental.lnk"),
        ]
        for shortcut in shortcut_candidates:
            if shortcut.exists():
                os.startfile(str(shortcut))  # type: ignore[attr-defined]
                return
        subprocess.Popen(
            ["cmd", "/c", "start", "", "Open Dental"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            shell=False,
        )

    @staticmethod
    def open_patient(first_name: str, last_name: str, birthdate: str, pat_num: str = "") -> None:
        if platform.system() != "Windows":
            raise RuntimeError("Open Dental automation only runs on the Windows clinic workstation.")
        first_name = first_name.strip()
        last_name = last_name.strip()
        pat_num = str(pat_num or "").strip()
        birthdate = OpenDentalPatientViewer.format_birthdate(birthdate)
        if not first_name or not last_name or not birthdate:
            raise RuntimeError("Missing first name, last name, or date of birth for Open Dental lookup.")

        try:
            from pywinauto import Desktop, Application, mouse
        except ImportError as exc:
            raise RuntimeError("pywinauto is not installed. Run: pip install -r requirements.txt") from exc

        desktop = Desktop(backend="uia")
        window = desktop.window(title_re=r".*Open Dental.*")
        if not window.exists(timeout=2):
            OpenDentalPatientViewer.open_open_dental()
            window = desktop.window(title_re=r".*Open Dental.*")
        if not window.exists(timeout=20):
            app = Application(backend="uia").connect(title_re=r".*Open Dental.*", timeout=20)
            window = app.top_window()

        window.set_focus()
        time.sleep(0.5)
        OpenDentalPatientViewer.slow_keys("^p", 1.2)

        # Select Patient opens with focus already in Last Name.
        OpenDentalPatientViewer.type_text(last_name, 0.12)
        OpenDentalPatientViewer.slow_keys("{TAB}", 0.12)
        OpenDentalPatientViewer.type_text(first_name, 0.12)
        OpenDentalPatientViewer.slow_keys("{TAB 6}", 0.12)
        if pat_num:
            OpenDentalPatientViewer.type_text(pat_num, 0.12)
        OpenDentalPatientViewer.slow_keys("{TAB 2}", 0.12)
        OpenDentalPatientViewer.type_text(birthdate, 0.45)
        OpenDentalPatientViewer.slow_keys("{ENTER}", 0.9)
        time.sleep(0.8)

        main = desktop.window(title_re=r".*Open Dental.*")
        if main.exists(timeout=5):
            main.set_focus()
            main_rect = main.rectangle()
            mouse.click(button="left", coords=(main_rect.left + 48, main_rect.top + 134))


class OpenDentalViewWorker(QThread):
    succeeded = Signal(str)
    failed = Signal(str)

    def __init__(self, first_name: str, last_name: str, birthdate: str, pat_num: str):
        super().__init__()
        self.first_name = first_name
        self.last_name = last_name
        self.birthdate = birthdate
        self.pat_num = pat_num

    def run(self) -> None:
        patient = f"{self.first_name} {self.last_name}".strip()
        try:
            OpenDentalPatientViewer.open_patient(self.first_name, self.last_name, self.birthdate, self.pat_num)
        except Exception as exc:  # noqa: BLE001 - surface Open Dental automation failures in UI
            self.failed.emit(f"{patient}: {exc}")
            return
        self.succeeded.emit(patient)


class SendWorker(QThread):
    progress = Signal(str)
    finished = Signal(int, int)

    def __init__(self, config: AppConfig, appointments: list[dict[str, Any]]):
        super().__init__()
        self.config = config
        self.appointments = appointments

    def run(self) -> None:
        repo = BridgeClient(self.config)
        sender = PhoneLinkSender(self.config.dry_run)
        sent = 0
        failed = 0
        skipped = 0
        for appointment in self.appointments:
            message = render_message(self.config, appointment, appointment.get("_TemplateText") or default_template(self.config))
            patient = patient_name(appointment)
            targets = [
                target for target in appointment.get("PhoneTargets", [])
                if digits_only(target.get("phone", "")) and target.get("status") not in {"sent", "dry-run"}
            ]
            if "PhoneTargets" not in appointment and not targets and digits_only(appointment.get("Phone", "")):
                targets = [{"source": appointment.get("PhoneSource") or "Phone", "phone": appointment.get("Phone", "")}]
            if not targets:
                skipped += 1
                self.progress.emit(f"Skipped: {patient} has no valid phone number.")
                continue
            for target in targets:
                phone = target.get("phone", "")
                source = target.get("source") or "Phone"
                try:
                    sender.send_sms(phone, message)
                    status = "dry-run" if self.config.dry_run else "sent"
                    if appointment.get("_Treatment"):
                        repo.log_treatment_result(appointment, message, status, phone=phone)
                    elif appointment.get("_Recall"):
                        repo.log_recall_result(appointment, message, status, phone=phone)
                    else:
                        repo.log_result(appointment, message, status, phone=phone)
                    sent += 1
                    self.progress.emit(f"{status.upper()}: {patient} {source} -> {phone}")
                except Exception as exc:  # noqa: BLE001 - show UI-friendly automation errors
                    failed += 1
                    if appointment.get("_Treatment"):
                        repo.log_treatment_result(appointment, message, "failed", str(exc), phone=phone)
                    elif appointment.get("_Recall"):
                        repo.log_recall_result(appointment, message, "failed", str(exc), phone=phone)
                    else:
                        repo.log_result(appointment, message, "failed", str(exc), phone=phone)
                    self.progress.emit(f"Failed: {patient} {source} -> {exc}")
        if skipped:
            self.progress.emit(f"Skipped {skipped} row(s) with no valid phone number.")
        self.finished.emit(sent, failed)


class CampaignSendWorker(QThread):
    progress = Signal(str)
    finished = Signal(int, int)

    def __init__(self, config: AppConfig, recipients: list[dict[str, Any]]):
        super().__init__()
        self.config = config
        self.recipients = recipients

    def run(self) -> None:
        repo = BridgeClient(self.config)
        sender = PhoneLinkSender(self.config.dry_run)
        sent = 0
        failed = 0
        skipped = 0
        for patient in self.recipients:
            message = render_message(self.config, patient, patient.get("_TemplateText") or "")
            name = patient_name(patient)
            targets = [
                target for target in patient.get("PhoneTargets", [])
                if digits_only(target.get("phone", ""))
            ]
            if not targets and digits_only(patient.get("Phone", "")):
                targets = [{"source": patient.get("PhoneSource") or "Phone", "phone": patient.get("Phone", "")}]
            if not targets:
                skipped += 1
                self.progress.emit(f"Skipped campaign SMS: {name} has no valid phone number.")
                continue
            for target in targets:
                phone = target.get("phone", "")
                source = target.get("source") or "Phone"
                try:
                    sender.send_sms(phone, message)
                    status = "dry-run" if self.config.dry_run else "sent"
                    repo.log_campaign_result(patient, message, status, phone=phone)
                    sent += 1
                    self.progress.emit(f"{status.upper()} CAMPAIGN: {name} {source} -> {phone}")
                except Exception as exc:  # noqa: BLE001
                    failed += 1
                    repo.log_campaign_result(patient, message, "failed", str(exc), phone=phone)
                    self.progress.emit(f"Failed campaign SMS: {name} {source} -> {exc}")
        if skipped:
            self.progress.emit(f"Skipped {skipped} campaign row(s) with no valid phone number.")
        self.finished.emit(sent, failed)


class LoadAppointmentsWorker(QThread):
    loaded = Signal(object, list, list)
    failed = Signal(object, str)

    def __init__(self, config: AppConfig, target_date: date):
        super().__init__()
        self.config = config
        self.target_date = target_date

    def run(self) -> None:
        try:
            repo = BridgeClient(self.config)
            appointments = repo.fetch_appointments(self.target_date)
            logs = repo.fetch_recent_logs()
            self.loaded.emit(self.target_date, appointments, logs)
        except Exception as exc:  # noqa: BLE001 - surface bridge/network errors in the UI
            self.failed.emit(self.target_date, str(exc))


class LoadRecallWorker(QThread):
    loaded = Signal(list)
    failed = Signal(str)

    def __init__(self, config: AppConfig, months: int, codes: str):
        super().__init__()
        self.config = config
        self.months = months
        self.codes = codes

    def run(self) -> None:
        try:
            repo = BridgeClient(self.config)
            self.loaded.emit(repo.fetch_recall_candidates(self.months, self.codes))
        except Exception as exc:  # noqa: BLE001 - surface bridge/network errors in the UI
            self.failed.emit(str(exc))


class LoadTreatmentWorker(QThread):
    loaded = Signal(list)
    failed = Signal(str)

    def __init__(self, config: AppConfig, days: int, codes: str, treatment_statuses: str):
        super().__init__()
        self.config = config
        self.days = days
        self.codes = codes
        self.treatment_statuses = treatment_statuses

    def run(self) -> None:
        try:
            repo = BridgeClient(self.config)
            self.loaded.emit(repo.fetch_treatment_candidates(self.days, self.codes, self.treatment_statuses))
        except Exception as exc:  # noqa: BLE001 - surface bridge/network errors in the UI
            self.failed.emit(str(exc))


class LoadPatientsWorker(QThread):
    loaded = Signal(list)
    failed = Signal(str)

    def __init__(self, config: AppConfig, query: str):
        super().__init__()
        self.config = config
        self.query = query

    def run(self) -> None:
        try:
            repo = BridgeClient(self.config)
            self.loaded.emit(repo.fetch_patients(self.query))
        except Exception as exc:  # noqa: BLE001 - surface bridge/network errors in the UI
            self.failed.emit(str(exc))


class LoadBirthdayPatientsWorker(QThread):
    loaded = Signal(list)
    failed = Signal(str)

    def __init__(self, config: AppConfig, target_date: date):
        super().__init__()
        self.config = config
        self.target_date = target_date

    def run(self) -> None:
        try:
            repo = BridgeClient(self.config)
            self.loaded.emit(repo.fetch_birthday_candidates(self.target_date))
        except Exception as exc:  # noqa: BLE001 - surface bridge/network errors in the UI
            self.failed.emit(str(exc))


def reminder_log_key(row: dict[str, Any], phone: str | None = None) -> tuple[str, str, str, str]:
    try:
        reminder_date = parse_datetime(row.get("AptDateTime")).date().isoformat()
    except ValueError:
        reminder_date = str(row.get("ReminderForDate") or "")[:10]
    return (
        str(row.get("AptNum") or ""),
        reminder_date,
        digits_only(phone or row.get("Phone", "")),
        str(reminder_offset_days(row)),
    )


def reminder_offset_days(row: dict[str, Any]) -> int:
    for key in ("_ReminderOffsetDays", "ReminderOffsetDays"):
        try:
            value = int(row.get(key))
            if value >= 0:
                return value
        except (TypeError, ValueError):
            pass
    try:
        return max(0, (parse_datetime(row.get("AptDateTime")).date() - clinic_today()).days)
    except ValueError:
        return 1


def relative_day_labels(days: int) -> tuple[str, str, str]:
    if days == 1:
        return "tomorrow", "de mañana", "ngày mai"
    if days <= 0:
        return "today", "de hoy", "hôm nay"
    return f"in {days} days", f"en {days} días", f"{days} ngày nữa"


def patient_name(row: dict[str, Any]) -> str:
    return " ".join(str(row.get(key) or "").strip() for key in ("FName", "LName")).strip() or f"Patient #{row.get('PatNum', '')}"


def patient_age(row: dict[str, Any]) -> int | None:
    try:
        birthdate = datetime.fromisoformat(str(row.get("Birthdate"))[:10]).date()
    except (TypeError, ValueError):
        return None
    today = clinic_today()
    return today.year - birthdate.year - ((today.month, today.day) < (birthdate.month, birthdate.day))


def patient_gender(row: dict[str, Any]) -> str:
    value = row.get("Gender")
    raw = "" if value is None else str(value).strip().lower()
    if raw in {"0", "male", "m"}:
        return "male"
    if raw in {"1", "female", "f"}:
        return "female"
    return "unknown"


def patient_salutation(row: dict[str, Any], country: str = "US") -> str:
    first_name = str(row.get("FName") or "").strip()
    last_name = str(row.get("LName") or "").strip()
    fallback = first_name or patient_name(row)
    age = patient_age(row)
    gender = patient_gender(row)
    country = country.upper()

    if country in {"VI", "VN"}:
        title = vietnamese_title(row)
        return f"{title} {first_name}".strip()

    # Non-Vietnamese templates use only Mr./Ms. and do not vary by age.
    if gender == "male":
        return f"Mr. {last_name or first_name}".strip()
    if gender == "female":
        return f"Ms. {last_name or first_name}".strip()
    return fallback


def patient_formal_first_name(row: dict[str, Any]) -> str:
    first_name = str(row.get("FName") or "").strip()
    fallback = first_name or patient_name(row)
    gender = patient_gender(row)
    if gender == "male":
        return f"Mr. {fallback}".strip()
    if gender == "female":
        return f"Ms. {fallback}".strip()
    return fallback


def vietnamese_title(row: dict[str, Any]) -> str:
    age = patient_age(row)
    gender = patient_gender(row)
    if age is not None and age <= 25:
        return "em"
    if age is not None and age <= 45:
        return "bạn"
    if age is not None and age <= 65:
        if gender == "male":
            return "anh"
        if gender == "female":
            return "chị"
        return "anh/chị"
    if gender == "male":
        return "chú"
    if gender == "female":
        return "cô"
    return "cô/chú"


def vietnamese_salutation(row: dict[str, Any]) -> str:
    first_name = str(row.get("FName") or "").strip()
    return f"{vietnamese_title(row)} {first_name}".strip()


def default_template(config: AppConfig) -> str:
    if config.default_template_key in config.sms_templates:
        return config.sms_templates[config.default_template_key]
    return next(iter(config.sms_templates.values()), "")


def template_label(key: str) -> str:
    labels = {
        "US": "US - English",
        "ES": "Spanish",
        "VI": "Vietnamese",
    }
    return labels.get(key, key)


def infer_template_country(key: str) -> str:
    normalized = key.upper().strip()
    if normalized.startswith("VN"):
        return "VI"
    for country in ("US", "ES", "VI"):
        if normalized == country or normalized.startswith(f"{country}_") or normalized.startswith(f"{country}-"):
            return country
    return normalized[:2] if len(normalized) >= 2 else normalized


def template_country(config: AppConfig, key: str) -> str:
    return str(config.sms_template_countries.get(key) or infer_template_country(key)).upper()


def template_key_for_language(config: AppConfig, language: str | None) -> str:
    return template_key_for_language_keys(config.sms_templates.keys(), language)


def recall_template_key_for_language(config: AppConfig, language: str | None) -> str:
    return template_key_for_language_keys(config.recall_templates.keys(), language)


def treatment_template_key_for_language(config: AppConfig, language: str | None) -> str:
    return template_key_for_language_keys(config.treatment_templates.keys(), language)


def review_template_key_for_language(config: AppConfig, language: str | None) -> str:
    return template_key_for_language_keys(config.review_templates.keys(), language)


def holiday_template_key_for_language(config: AppConfig, language: str | None, campaign_type: str = "holiday") -> str:
    preferred = template_key_for_language_keys(config.holiday_templates.keys(), language)
    suffix = "_BIRTHDAY" if campaign_type == "birthday" else "_HOLIDAY"
    candidate = f"{infer_template_country(preferred)}{suffix}"
    if candidate in {str(key).upper() for key in config.holiday_templates.keys()}:
        return candidate
    return preferred


def template_key_for_language_keys(keys: Any, language: str | None) -> str:
    available = {str(key).upper() for key in keys}
    text = str(language or "").strip().lower()
    if "spanish" in text or text in {"es", "spa", "espanol", "español"}:
        preferred = "ES"
    elif "vietnam" in text or text in {"vi", "vn", "vie", "tieng viet", "tiếng việt"}:
        preferred = "VI"
    else:
        preferred = "US"
    if preferred in available:
        return preferred
    for key in sorted(available):
        if key.startswith(f"{preferred}_") or key.startswith(f"{preferred}-"):
            return key
    return "US"


def template_flag_path(key: str) -> Path | None:
    flags = {
        "US": "us.svg",
        "ES": "es.svg",
        "VI": "vn.svg",
        "VN": "vn.svg",
    }
    file_name = flags.get(key.upper())
    if not file_name:
        return None
    path = FLAGS_DIR / file_name
    return path if path.exists() else None


def template_icon(key_or_country: str) -> QIcon:
    path = template_flag_path(key_or_country)
    return QIcon(str(path)) if path else QIcon()


def render_message(config: AppConfig, row: dict[str, Any], template: str) -> str:
    apt_time = row.get("AptDateTime")
    first_name = str(row.get("FName") or "").strip() or "there"
    formatted_time = display_time(apt_time)
    relative_day, relative_day_es, relative_day_vi = relative_day_labels(reminder_offset_days(row))
    country = str(row.get("_TemplateCountry") or template_country(config, row.get("_TemplateKey") or config.default_template_key)).upper()
    return template.format(
        clinic_name=config.clinic_name,
        clinic_phone=config.clinic_phone,
        review_link=config.review_link,
        holiday_name=row.get("_HolidayName") or row.get("_CampaignName") or "",
        campaign_name=row.get("_CampaignName") or "",
        first_name=first_name,
        formal_first_name=patient_formal_first_name(row),
        last_name=str(row.get("LName") or "").strip(),
        patient_name=patient_name(row),
        salutation=patient_salutation(row, country),
        vi_title=vietnamese_title(row),
        vi_title_cap=vietnamese_title(row).capitalize(),
        vi_salutation=vietnamese_salutation(row),
        age=patient_age(row) or "",
        date=display_date(apt_time),
        date_full=display_date(apt_time),
        date_short=display_date_short(apt_time),
        weekday=weekday_en(apt_time),
        weekday_vi=weekday_vi(apt_time),
        relative_day=relative_day,
        relative_day_es=relative_day_es,
        relative_day_vi=relative_day_vi,
        time=formatted_time,
        time_lower=formatted_time.lower(),
        phone=row.get("Phone", ""),
        apt_num=row.get("AptNum", ""),
        pat_num=row.get("PatNum", ""),
        last_proc_date=display_date(row.get("LastProcDate") or row.get("LastPendingProcDate")),
        last_pending_proc_date=display_date(row.get("LastPendingProcDate") or row.get("LastProcDate")),
        procedure_codes=row.get("ProcedureCodes", ""),
        procedure_descriptions=row.get("ProcedureDescriptions", ""),
    )


class SmsReminderWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.config = AppConfig.load()
        self.repo = BridgeClient(self.config)
        self.appointments: list[dict[str, Any]] = []
        self.recall_patients: list[dict[str, Any]] = []
        self.treatment_patients: list[dict[str, Any]] = []
        self.review_patients: list[dict[str, Any]] = []
        self.holiday_patients: list[dict[str, Any]] = []
        self.worker: SendWorker | None = None
        self.active_send_kind = "appointments"
        self.load_worker: LoadAppointmentsWorker | None = None
        self.recall_load_worker: LoadRecallWorker | None = None
        self.treatment_load_worker: LoadTreatmentWorker | None = None
        self.review_load_worker: LoadPatientsWorker | None = None
        self.holiday_load_worker: QThread | None = None
        self.queued_load = False
        self.send_after_load = False
        self.monitor_send_queue: list[date] = []
        self.monitor_batch_active = False
        self.monitor_batch_failed = False
        self.active_schedule_key = ""
        self.monitoring_active = False
        self.holiday_monitoring_active = False
        self.holiday_monitor_batch_active = False
        self.holiday_monitor_batch_failed = False
        self.holiday_campaign_queue: list[dict[str, Any]] = []
        self.holiday_active_campaign_id = ""
        self.holiday_active_schedule_key = ""
        self.treatment_monitoring_active = False
        self.treatment_monitor_batch_active = False
        self.treatment_active_schedule_key = ""
        self.row_template_combos: dict[int, QComboBox] = {}
        self.recall_template_combos: dict[int, QComboBox] = {}
        self.treatment_template_combos: dict[int, QComboBox] = {}
        self.review_template_combos: dict[int, QComboBox] = {}
        self.holiday_template_combos: dict[int, QComboBox] = {}
        self.activity_messages: list[str] = []
        self.suppress_auto_load = False
        self.settings = QSettings("LUK Dental", "SMS Reminder Tool")
        self._restoring_column_widths: set[str] = set()
        self.lazy_table_state: dict[str, dict[str, Any]] = {}
        self.view_worker: OpenDentalViewWorker | None = None
        self.active_view_button: QPushButton | None = None
        self.active_campaign_recipient_keys: set[tuple[str, str, str, str, str, str]] = set()
        if self.config.bridge_url and self.config.api_token:
            self.load_templates_from_bridge()

        self.setWindowTitle("LUK Dental SMS Reminder Tool")
        if APP_ICON_PATH.exists():
            self.setWindowIcon(QIcon(str(APP_ICON_PATH)))
        self.resize(1680, 980)
        self.setStyleSheet(APP_STYLES)

        self.tabs = QTabWidget()
        self.tabs.setObjectName("AppTabs")
        self.setCentralWidget(self.tabs)
        self.setStatusBar(QStatusBar())
        self.tabs.addTab(self.build_dashboard_tab(), "Dashboard")
        self.tabs.addTab(self.build_monitoring_tab(), "Monitoring")
        self.tabs.addTab(self.build_recall_tab(), "Recall")
        self.tabs.addTab(self.build_treatment_tab(), "Treatment")
        self.tabs.addTab(self.build_review_google_tab(), "Review Google")
        self.tabs.addTab(self.build_holiday_birthday_tab(), "Holiday & Birthday")
        self.tabs.addTab(self.build_templates_tab(), "Templates")
        self.tabs.addTab(self.build_settings_tab(), "Settings")
        self.tabs.addTab(self.build_logs_tab(), "Logs")
        self.tabs.currentChanged.connect(lambda _index: QTimer.singleShot(0, self.fill_configured_tables))

        self.load_debounce = QTimer(self)
        self.load_debounce.setSingleShot(True)
        self.load_debounce.setInterval(250)
        self.load_debounce.timeout.connect(self.load_appointments)

        self.scheduler_timer = QTimer(self)
        self.scheduler_timer.timeout.connect(self.check_schedule)
        self.scheduler_timer.timeout.connect(self.check_holiday_schedule)
        self.scheduler_timer.timeout.connect(self.check_treatment_schedule)
        self.scheduler_timer.start(60_000)
        self.update_dry_run_badge()
        self.update_monitoring_status()
        self.statusBar().showMessage("Open Monitoring and click Start Monitoring to begin automatic reminders.", 6000)
        if self.config.bridge_url and self.config.api_token:
            QTimer.singleShot(300, self.load_appointments)

    def card(self, object_name: str = "Card") -> QFrame:
        frame = QFrame()
        frame.setObjectName(object_name)
        return frame

    def load_templates_from_bridge(self) -> None:
        try:
            data = self.repo.fetch_templates()
            tmpl = data.get("templates") or data or {}
            countries = data.get("countries") or {}
            if not (tmpl.get("appointment") and tmpl.get("recall") and tmpl.get("treatment") and tmpl.get("review_google") and tmpl.get("holiday_birthday")):
                self.repo.init_default_templates()
                data = self.repo.fetch_templates()
                tmpl = data.get("templates") or data or {}
                countries = data.get("countries") or {}
            settings_data = self.repo.fetch_sms_settings()
            sms_settings = settings_data.get("settings") or {}

            self.config.sms_templates = tmpl.get("appointment") or {}
            self.config.sms_template_countries = countries.get("appointment") or {}
            self.config.recall_templates = tmpl.get("recall") or {}
            self.config.recall_template_countries = countries.get("recall") or {}
            self.config.treatment_templates = tmpl.get("treatment") or {}
            self.config.treatment_template_countries = countries.get("treatment") or {}
            self.config.review_templates = tmpl.get("review_google") or {}
            self.config.review_template_countries = countries.get("review_google") or {}
            self.config.holiday_templates = tmpl.get("holiday_birthday") or {}
            self.config.holiday_template_countries = countries.get("holiday_birthday") or {}
            self.config.review_link = str(sms_settings.get("review_link") or "")
            self.config.holiday_events = self.parse_holiday_events_setting(sms_settings.get("holiday_events"))
            self.config.holiday_campaigns = self.parse_holiday_campaigns_setting(sms_settings.get("holiday_campaigns"))
            self.config.sms_template = default_template(self.config)
            self.config.recall_template = self.config.recall_templates.get("US", "")
        except Exception:
            self.config.sms_templates = {}
            self.config.sms_template_countries = {}
            self.config.recall_templates = {}
            self.config.recall_template_countries = {}
            self.config.treatment_templates = {}
            self.config.treatment_template_countries = {}
            self.config.review_templates = {}
            self.config.review_template_countries = {}
            self.config.holiday_templates = {}
            self.config.holiday_template_countries = {}
            self.config.review_link = ""
            self.config.holiday_events = list(HOLIDAY_EVENTS)
            self.config.holiday_campaigns = []

    def parse_holiday_events_setting(self, raw_value: Any) -> list[str]:
        events: list[str] = []
        if raw_value:
            try:
                parsed = json.loads(str(raw_value))
                if isinstance(parsed, list):
                    events = [str(item).strip() for item in parsed if str(item).strip()]
            except (TypeError, ValueError, json.JSONDecodeError):
                events = []
        if not events:
            events = list(HOLIDAY_EVENTS)
        return self.unique_holiday_events(events)

    def unique_holiday_events(self, events: list[str]) -> list[str]:
        result: list[str] = []
        seen: set[str] = set()
        for event in events:
            name = str(event or "").strip()
            key = name.lower()
            if not name or key in seen:
                continue
            seen.add(key)
            result.append(name)
        return result

    def save_holiday_events_to_bridge(self) -> None:
        self.config.holiday_events = self.unique_holiday_events(self.config.holiday_events)
        self.repo.save_sms_setting("holiday_events", json.dumps(self.config.holiday_events, ensure_ascii=False))

    def parse_holiday_campaigns_setting(self, raw_value: Any) -> list[dict[str, Any]]:
        if not raw_value:
            return []
        try:
            parsed = json.loads(str(raw_value))
        except (TypeError, ValueError, json.JSONDecodeError):
            return []
        if not isinstance(parsed, list):
            return []
        campaigns: list[dict[str, Any]] = []
        for campaign in parsed:
            if not isinstance(campaign, dict):
                continue
            recipients = campaign.get("recipients")
            if not isinstance(recipients, list):
                recipients = []
            campaign_type = str(campaign.get("type") or "").strip().lower()
            if campaign_type not in {"holiday", "birthday"}:
                continue
            campaigns.append({
                "id": str(campaign.get("id") or f"{campaign_type}-{int(time.time())}"),
                "type": campaign_type,
                "name": str(campaign.get("name") or ("Birthday" if campaign_type == "birthday" else "Holiday")).strip(),
                "run_date": str(campaign.get("run_date") or "").strip(),
                "enabled": bool(campaign.get("enabled", True)),
                "last_sent_date": str(campaign.get("last_sent_date") or "").strip(),
                "recipients": [item for item in recipients if isinstance(item, dict)],
            })
        return campaigns

    def save_holiday_campaigns_to_bridge(self) -> None:
        self.repo.save_sms_setting("holiday_campaigns", json.dumps(self.config.holiday_campaigns, ensure_ascii=False))

    def resizeEvent(self, event) -> None:  # noqa: N802 - Qt override name
        super().resizeEvent(event)
        self.update_loading_overlay_geometry()
        self.fill_configured_tables()

    def update_loading_overlay_geometry(self) -> None:
        if not hasattr(self, "loading_overlay") or not hasattr(self, "appointment_table"):
            return
        self.loading_overlay.setGeometry(self.appointment_table.geometry())
        self.loading_overlay.raise_()

    def set_table_loading(self, is_loading: bool) -> None:
        if not hasattr(self, "loading_overlay"):
            return
        self.update_loading_overlay_geometry()
        self.loading_overlay.setVisible(is_loading)
        if is_loading:
            self.loading_overlay.raise_()

    def stat_card(self, label: str) -> tuple[QFrame, QLabel]:
        frame = self.card("StatCard")
        layout = QVBoxLayout(frame)
        layout.setContentsMargins(14, 10, 14, 10)
        value = QLabel("0")
        value.setObjectName("StatValue")
        caption = QLabel(label)
        caption.setObjectName("StatLabel")
        layout.addWidget(value)
        layout.addWidget(caption)
        return frame, value

    def configure_resizable_columns(self, table: QTableWidget, settings_key: str, default_widths: dict[int, int]) -> None:
        header = table.horizontalHeader()
        header.setSectionResizeMode(QHeaderView.Interactive)
        header.setStretchLastSection(False)
        saved = self.settings.value(settings_key, "")
        widths = dict(default_widths)
        if saved:
            try:
                loaded = json.loads(str(saved))
                widths.update({int(key): int(value) for key, value in loaded.items()})
            except (TypeError, ValueError, json.JSONDecodeError):
                pass
        self._restoring_column_widths.add(settings_key)
        for col in range(table.columnCount()):
            table.setColumnWidth(col, max(48, int(widths.get(col, 120))))
        self._restoring_column_widths.discard(settings_key)
        header.sectionResized.connect(lambda *_args, t=table, key=settings_key: self.save_column_widths(t, key))
        QTimer.singleShot(0, lambda t=table, key=settings_key: self.fill_table_width(t, key))

    def save_column_widths(self, table: QTableWidget, settings_key: str) -> None:
        if settings_key in self._restoring_column_widths:
            return
        widths = {str(col): table.columnWidth(col) for col in range(table.columnCount())}
        self.settings.setValue(settings_key, json.dumps(widths))

    def fill_configured_tables(self) -> None:
        if hasattr(self, "appointment_table"):
            self.fill_table_width(self.appointment_table, "dashboard/appointment_column_widths")
        if hasattr(self, "recall_table"):
            self.fill_table_width(self.recall_table, "recall/patient_column_widths")
        if hasattr(self, "treatment_table"):
            self.fill_table_width(self.treatment_table, "treatment/patient_column_widths")
        if hasattr(self, "review_table"):
            self.fill_table_width(self.review_table, "review_google/patient_column_widths")
        if hasattr(self, "holiday_table"):
            self.fill_table_width(self.holiday_table, "holiday_birthday/patient_column_widths")

    def fill_table_width(self, table: QTableWidget, settings_key: str) -> None:
        viewport_width = table.viewport().width()
        if viewport_width <= 0 or table.columnCount() == 0:
            return
        widths = [table.columnWidth(col) for col in range(table.columnCount())]
        total_width = sum(widths)
        extra = viewport_width - total_width - 2
        if extra <= 0 or total_width <= 0:
            return
        self._restoring_column_widths.add(settings_key)
        remaining = extra
        for col, width in enumerate(widths):
            add = remaining if col == len(widths) - 1 else int(extra * (width / total_width))
            table.setColumnWidth(col, width + add)
            remaining -= add
        self._restoring_column_widths.discard(settings_key)

    def lazy_rows_for_table(self, key: str, rows: list[dict[str, Any]], query: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        state = self.lazy_table_state.setdefault(key, {"query": query, "limit": LAZY_TABLE_BATCH_SIZE})
        if state.get("query") != query:
            state["query"] = query
            state["limit"] = LAZY_TABLE_BATCH_SIZE
        limit = max(LAZY_TABLE_BATCH_SIZE, int(state.get("limit") or LAZY_TABLE_BATCH_SIZE))
        return rows[: min(len(rows), limit)], rows

    def maybe_load_more_lazy_rows(self, table: QTableWidget, key: str, render_callback: Any) -> None:
        state = self.lazy_table_state.get(key)
        filtered_rows = list(table.property("_filtered_patients") or [])
        if not state or not filtered_rows:
            return
        current_limit = int(state.get("limit") or LAZY_TABLE_BATCH_SIZE)
        if current_limit >= len(filtered_rows):
            return
        scrollbar = table.verticalScrollBar()
        if scrollbar.value() < max(0, scrollbar.maximum() - 4):
            return
        state["limit"] = min(len(filtered_rows), current_limit + LAZY_TABLE_BATCH_SIZE)
        render_callback()

    def build_dashboard_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(10)

        hero = self.card("HeroCard")
        hero_layout = QHBoxLayout(hero)
        hero_layout.setContentsMargins(18, 14, 18, 14)
        brand = QVBoxLayout()
        eyebrow = QLabel("LUK DENTAL")
        eyebrow.setObjectName("Eyebrow")
        title = QLabel("SMS appointment reminders")
        title.setObjectName("HeroTitle")
        subtitle = QLabel("Review tomorrow's Open Dental appointments from the bridge, send reminder texts, and keep an audit log.")
        subtitle.setObjectName("HeroSubtitle")
        brand.addWidget(eyebrow)
        brand.addWidget(title)
        brand.addWidget(subtitle)
        hero_layout.addLayout(brand)
        hero_layout.addStretch()
        self.dry_run_badge = QLabel("")
        self.dry_run_badge.setObjectName("Badge")
        hero_layout.addWidget(self.dry_run_badge)
        layout.addWidget(hero)

        stats = QHBoxLayout()
        self.total_stat_card, self.total_stat = self.stat_card("Appointments loaded")
        self.pending_stat_card, self.pending_stat = self.stat_card("Pending reminders")
        self.sent_stat_card, self.sent_stat = self.stat_card("Already sent")
        self.missing_phone_stat_card, self.missing_phone_stat = self.stat_card("Missing phone")
        stats.addWidget(self.total_stat_card)
        stats.addWidget(self.pending_stat_card)
        stats.addWidget(self.sent_stat_card)
        stats.addWidget(self.missing_phone_stat_card)
        layout.addLayout(stats)

        controls_card = self.card()
        controls = QHBoxLayout(controls_card)
        controls.setContentsMargins(14, 10, 14, 10)
        controls.setSpacing(8)
        controls.addWidget(QLabel("Reminder date"))
        self.date_edit = QDateEdit(clinic_qdate(self.config.reminder_days_ahead))
        self.date_edit.setCalendarPopup(True)
        self.date_edit.setDisplayFormat("MM/dd/yyyy")
        self.date_edit.setMinimumWidth(128)
        self.date_edit.setMinimumHeight(34)
        self.date_edit.dateChanged.connect(self.load_appointments_for_selected_date)
        self.send_selected_button = QPushButton("Send selected")
        self.send_selected_button.clicked.connect(self.send_selected)
        self.send_all_button = QPushButton("Send all not sent")
        self.send_all_button.setObjectName("PrimaryButton")
        self.send_all_button.clicked.connect(self.send_all_not_sent)
        controls.addWidget(self.date_edit)
        controls.addStretch()
        controls.addWidget(QLabel(CLINIC_TIME_ZONE_NOTE))
        self.preview_button = QPushButton("Preview selected")
        self.preview_button.clicked.connect(self.preview_selected)
        self.open_phone_button = QPushButton("Open Phone Link")
        self.open_phone_button.clicked.connect(self.open_phone_link)
        self.test_sms_button = QPushButton("Send test SMS now")
        self.test_sms_button.clicked.connect(self.send_test_sms_now)
        self.clear_dry_run_button = QPushButton("Clear dry-run logs")
        self.clear_dry_run_button.clicked.connect(self.clear_dry_run_logs)
        self.reset_selected_button = QPushButton("Reset selected to not sent")
        self.reset_selected_button.clicked.connect(self.reset_selected_to_not_sent)
        controls.addWidget(self.preview_button)
        controls.addWidget(self.open_phone_button)
        controls.addWidget(self.test_sms_button)
        controls.addWidget(self.clear_dry_run_button)
        controls.addWidget(self.reset_selected_button)
        controls.addWidget(self.send_selected_button)
        controls.addWidget(self.send_all_button)
        layout.addWidget(controls_card)

        search_card = self.card()
        search_layout = QHBoxLayout(search_card)
        search_layout.setContentsMargins(18, 12, 18, 12)
        search_layout.addWidget(QLabel("Search"))
        self.search_edit = QLineEdit()
        self.search_edit.setPlaceholderText("Patient, phone, email, appointment #...")
        self.search_edit.textChanged.connect(self.apply_appointment_filter)
        search_layout.addWidget(self.search_edit)
        layout.addWidget(search_card)

        table_card = self.card()
        table_layout = QVBoxLayout(table_card)
        table_layout.setContentsMargins(0, 0, 0, 0)
        self.appointment_table = QTableWidget(0, 12)
        self.appointment_table.setHorizontalHeaderLabels(
            ["Status", "Time", "Patient", "Phone", "Email", "Apt #", "Pat #", "Reminder", "Sent", "Last sent", "Template", "View"]
        )
        column_widths = {
            0: 120,  # Status
            1: 110,  # Time
            2: 120,  # Patient
            3: 340,  # Phone
            4: 170,  # Email
            5: 90,   # Apt #
            6: 90,   # Pat #
            7: 110,  # Reminder
            8: 70,   # Sent
            9: 140,  # Last sent
            10: 190, # Template
            11: 90,  # View
        }
        self.configure_resizable_columns(self.appointment_table, "dashboard/appointment_column_widths", column_widths)
        self.appointment_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.appointment_table.setSelectionMode(QTableWidget.ExtendedSelection)
        self.appointment_table.verticalHeader().setVisible(False)
        self.appointment_table.setAlternatingRowColors(True)
        self.appointment_table.setShowGrid(False)
        self.appointment_table.verticalHeader().setDefaultSectionSize(38)
        self.appointment_table.verticalHeader().setMinimumSectionSize(34)
        table_layout.addWidget(self.appointment_table)
        self.loading_overlay = QFrame(table_card)
        self.loading_overlay.setObjectName("LoadingOverlay")
        loading_layout = QVBoxLayout(self.loading_overlay)
        loading_layout.setContentsMargins(0, 0, 0, 0)
        loading_layout.setAlignment(Qt.AlignCenter)
        loading_text = QLabel("Loading appointments...")
        loading_text.setObjectName("LoadingText")
        loading_text.setAlignment(Qt.AlignCenter)
        loading_layout.addWidget(loading_text)
        self.loading_overlay.hide()
        layout.addWidget(table_card, 1)
        return page

    def build_settings_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(10)

        hero = self.card("HeroCard")
        hero_layout = QVBoxLayout(hero)
        hero_layout.setContentsMargins(18, 14, 18, 14)
        eyebrow = QLabel("SETTINGS")
        eyebrow.setObjectName("Eyebrow")
        heading = QLabel("Reminder settings")
        heading.setObjectName("HeroTitle")
        subtitle = QLabel("Manage bridge connection, SMS defaults, and Windows Task Scheduler BAT timing.")
        subtitle.setObjectName("HeroSubtitle")
        hero_layout.addWidget(eyebrow)
        hero_layout.addWidget(heading)
        hero_layout.addWidget(subtitle)
        layout.addWidget(hero)

        cards = QGridLayout()
        cards.setHorizontalSpacing(16)
        cards.setVerticalSpacing(16)

        bridge_card = self.card()
        bridge_layout = QVBoxLayout(bridge_card)
        bridge_layout.setContentsMargins(16, 14, 16, 14)
        bridge_layout.setSpacing(10)
        bridge_title = QLabel("Bridge API")
        bridge_title.setObjectName("SectionTitle")
        bridge_layout.addWidget(bridge_title)
        bridge_form = QFormLayout()
        bridge_form.setContentsMargins(0, 0, 0, 0)
        bridge_form.setSpacing(8)
        self.bridge_url = QLineEdit(self.config.bridge_url)
        self.bridge_url.setPlaceholderText("http://SERVER-IP:3008")
        self.api_token = QLineEdit(self.config.api_token)
        self.api_token.setEchoMode(QLineEdit.Password)
        bridge_form.addRow("Bridge URL", self.bridge_url)
        bridge_form.addRow("API token", self.api_token)
        bridge_layout.addLayout(bridge_form)
        bridge_layout.addStretch()

        sms_card = self.card()
        sms_layout = QVBoxLayout(sms_card)
        sms_layout.setContentsMargins(16, 14, 16, 14)
        sms_layout.setSpacing(10)
        sms_title = QLabel("SMS and schedule")
        sms_title.setObjectName("SectionTitle")
        sms_layout.addWidget(sms_title)
        sms_form = QFormLayout()
        sms_form.setContentsMargins(0, 0, 0, 0)
        sms_form.setSpacing(8)
        self.clinic_name = QLineEdit(self.config.clinic_name)
        self.clinic_phone = QLineEdit(self.config.clinic_phone)
        self.days_ahead = QSpinBox()
        self.days_ahead.setRange(0, 30)
        self.days_ahead.setValue(self.config.reminder_days_ahead)
        self.schedule_time = QTimeEdit(QTime.fromString(self.config.scheduled_send_time, "HH:mm"))
        self.schedule_time.setDisplayFormat("HH:mm")
        self.statuses = QLineEdit(",".join(str(item) for item in self.config.appointment_statuses))
        self.review_link = QLineEdit(self.config.review_link)
        self.review_link.setPlaceholderText("Google review URL")
        sms_form.addRow("Clinic name", self.clinic_name)
        sms_form.addRow("Clinic phone", self.clinic_phone)
        sms_form.addRow("Google review link", self.review_link)
        sms_form.addRow("Reminder days ahead", self.days_ahead)
        sms_form.addRow("Daily send time", self.schedule_time)
        sms_form.addRow("Appointment statuses", self.statuses)
        sms_form.addRow("Send mode", QLabel("REAL SMS only. Dry-run mode is disabled."))
        sms_layout.addLayout(sms_form)
        sms_layout.addStretch()

        scheduler_card = self.card()
        scheduler_layout = QGridLayout(scheduler_card)
        scheduler_layout.setContentsMargins(16, 14, 16, 14)
        scheduler_layout.setHorizontalSpacing(14)
        scheduler_layout.setVerticalSpacing(10)
        scheduler_title = QLabel("Windows scheduler BAT")
        scheduler_title.setObjectName("SectionTitle")
        scheduler_layout.addWidget(scheduler_title, 0, 0, 1, 4)
        self.scheduler_bat_status = QLabel(str(SCHEDULER_ON_PATH))
        self.scheduler_bat_status.setObjectName("Muted")
        self.scheduler_bat_status.setWordWrap(True)
        scheduler_layout.addWidget(QLabel("File"), 1, 0)
        scheduler_layout.addWidget(self.scheduler_bat_status, 1, 1, 1, 3)
        self.scheduler_time_edits: dict[str, QTimeEdit] = {}
        scheduler_times = self.safe_read_scheduler_bat_times()
        for index, (name, label) in enumerate(SCHEDULER_TIME_FIELDS):
            time_edit = QTimeEdit(qtime_from_hhmm(scheduler_times.get(name), DEFAULT_SCHEDULER_TIMES[name]))
            time_edit.setDisplayFormat("HH:mm")
            time_edit.setMinimumWidth(110)
            self.scheduler_time_edits[name] = time_edit
            row = 2 + index // 2
            col = (index % 2) * 2
            scheduler_layout.addWidget(QLabel(label), row, col)
            scheduler_layout.addWidget(time_edit, row, col + 1)
        scheduler_note = QLabel("Reads and rewrites the four SET time lines in scheduler-on.bat. After changing these times, run scheduler-on.bat as Administrator again so Windows Task Scheduler receives the new schedule.")
        scheduler_note.setObjectName("Muted")
        scheduler_note.setWordWrap(True)
        scheduler_layout.addWidget(QLabel("Note"), 4, 0, Qt.AlignTop)
        scheduler_layout.addWidget(scheduler_note, 4, 1, 1, 3)

        scheduler_actions = QHBoxLayout()
        reload_scheduler_button = QPushButton("Reload BAT times")
        reload_scheduler_button.clicked.connect(self.reload_scheduler_bat_times)
        save_scheduler_button = QPushButton("Save BAT times")
        save_scheduler_button.clicked.connect(lambda: self.save_scheduler_bat_times(silent=False))
        scheduler_actions.addStretch()
        scheduler_actions.addWidget(reload_scheduler_button)
        scheduler_actions.addWidget(save_scheduler_button)
        scheduler_layout.addLayout(scheduler_actions, 5, 0, 1, 4)
        scheduler_layout.setColumnStretch(1, 1)
        scheduler_layout.setColumnStretch(3, 1)

        buttons = QHBoxLayout()
        self.test_bridge_button = QPushButton("Test bridge connection")
        self.test_bridge_button.clicked.connect(self.test_bridge_connection)
        self.save_button = QPushButton("Save settings")
        self.save_button.setObjectName("PrimaryButton")
        self.save_button.clicked.connect(self.save_settings_clicked)
        buttons.addStretch()
        buttons.addWidget(self.test_bridge_button)
        buttons.addWidget(self.save_button)

        cards.addWidget(bridge_card, 0, 0)
        cards.addWidget(sms_card, 0, 1)
        cards.addWidget(scheduler_card, 1, 0, 1, 2)
        cards.setColumnStretch(0, 1)
        cards.setColumnStretch(1, 1)
        layout.addLayout(cards)
        layout.addLayout(buttons)
        layout.addStretch()
        return page

    def build_monitoring_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(10)

        hero = self.card("HeroCard")
        hero_layout = QVBoxLayout(hero)
        hero_layout.setContentsMargins(18, 14, 18, 14)
        eyebrow = QLabel("AUTOMATION")
        eyebrow.setObjectName("Eyebrow")
        title = QLabel("Daily SMS monitoring")
        title.setObjectName("HeroTitle")
        subtitle = QLabel("Start monitoring when Phone Link is ready. The app will load tomorrow's appointments and send pending reminders at the configured time.")
        subtitle.setObjectName("HeroSubtitle")
        hero_layout.addWidget(eyebrow)
        hero_layout.addWidget(title)
        hero_layout.addWidget(subtitle)
        layout.addWidget(hero)

        panels = QGridLayout()
        panels.setHorizontalSpacing(16)
        panels.setVerticalSpacing(16)

        monitor_card = self.card()
        monitor_layout = QGridLayout(monitor_card)
        monitor_layout.setContentsMargins(16, 14, 16, 14)
        monitor_layout.setHorizontalSpacing(12)
        monitor_layout.setVerticalSpacing(8)
        monitor_title = QLabel("Appointment reminder")
        monitor_title.setObjectName("SectionTitle")
        monitor_subtitle = QLabel("Daily reminders for tomorrow and 8-day appointment targets.")
        monitor_subtitle.setObjectName("Muted")
        monitor_subtitle.setWordWrap(True)

        self.monitor_status_value = QLabel("Stopped")
        self.monitor_status_value.setObjectName("MonitorStatus")
        self.monitor_date_value = QLabel("")
        self.monitor_date_value.setObjectName("Muted")
        self.monitor_time_value = QLabel("")
        self.monitor_time_value.setObjectName("Muted")
        self.monitor_note_value = QLabel("")
        self.monitor_note_value.setObjectName("Muted")
        self.monitor_note_value.setWordWrap(True)

        monitor_layout.addWidget(monitor_title, 0, 0, 1, 2)
        monitor_layout.addWidget(monitor_subtitle, 1, 0, 1, 2)
        monitor_layout.addWidget(QLabel("Status"), 2, 0)
        monitor_layout.addWidget(self.monitor_status_value, 2, 1)
        monitor_layout.addWidget(QLabel("Reminder target"), 3, 0)
        monitor_layout.addWidget(self.monitor_date_value, 3, 1)
        monitor_layout.addWidget(QLabel("Send time"), 4, 0)
        monitor_layout.addWidget(self.monitor_time_value, 4, 1)
        monitor_layout.addWidget(QLabel("Behavior"), 5, 0, Qt.AlignTop)
        monitor_layout.addWidget(self.monitor_note_value, 5, 1)

        action_row = QHBoxLayout()
        self.start_monitoring_button = QPushButton("Start Monitoring")
        self.start_monitoring_button.setObjectName("PrimaryButton")
        self.start_monitoring_button.clicked.connect(self.start_monitoring)
        self.stop_monitoring_button = QPushButton("Stop Monitoring")
        self.stop_monitoring_button.clicked.connect(self.stop_monitoring)
        action_row.addStretch()
        action_row.addWidget(self.stop_monitoring_button)
        action_row.addWidget(self.start_monitoring_button)
        monitor_layout.addLayout(action_row, 6, 0, 1, 2)

        holiday_card = self.card()
        holiday_layout = QGridLayout(holiday_card)
        holiday_layout.setContentsMargins(16, 14, 16, 14)
        holiday_layout.setHorizontalSpacing(12)
        holiday_layout.setVerticalSpacing(8)
        holiday_title = QLabel("Holiday & Birthday")
        holiday_title.setObjectName("SectionTitle")
        holiday_subtitle = QLabel("Separate monitoring for saved Holiday and Birthday campaign automations.")
        holiday_subtitle.setObjectName("Muted")
        holiday_subtitle.setWordWrap(True)
        self.monitor_holiday_status_value = QLabel("Waiting")
        self.monitor_holiday_status_value.setObjectName("MonitorStatus")
        self.monitor_holiday_saved_value = QLabel("")
        self.monitor_holiday_saved_value.setObjectName("Muted")
        self.monitor_birthday_saved_value = QLabel("")
        self.monitor_birthday_saved_value.setObjectName("Muted")
        self.monitor_holiday_due_value = QLabel("")
        self.monitor_holiday_due_value.setObjectName("Muted")
        self.monitor_holiday_note_value = QLabel("")
        self.monitor_holiday_note_value.setObjectName("Muted")
        self.monitor_holiday_note_value.setWordWrap(True)
        holiday_layout.addWidget(holiday_title, 0, 0, 1, 2)
        holiday_layout.addWidget(holiday_subtitle, 1, 0, 1, 2)
        holiday_layout.addWidget(QLabel("Status"), 2, 0)
        holiday_layout.addWidget(self.monitor_holiday_status_value, 2, 1)
        holiday_layout.addWidget(QLabel("Holiday saved"), 3, 0)
        holiday_layout.addWidget(self.monitor_holiday_saved_value, 3, 1)
        holiday_layout.addWidget(QLabel("Birthday saved"), 4, 0)
        holiday_layout.addWidget(self.monitor_birthday_saved_value, 4, 1)
        holiday_layout.addWidget(QLabel("Due today"), 5, 0)
        holiday_layout.addWidget(self.monitor_holiday_due_value, 5, 1)
        holiday_layout.addWidget(QLabel("Behavior"), 6, 0, Qt.AlignTop)
        holiday_layout.addWidget(self.monitor_holiday_note_value, 6, 1)
        holiday_action_row = QHBoxLayout()
        self.start_holiday_monitoring_button = QPushButton("Start Holiday/Birthday")
        self.start_holiday_monitoring_button.setObjectName("PrimaryButton")
        self.start_holiday_monitoring_button.clicked.connect(self.start_holiday_monitoring)
        self.stop_holiday_monitoring_button = QPushButton("Stop")
        self.stop_holiday_monitoring_button.clicked.connect(self.stop_holiday_monitoring)
        holiday_action_row.addStretch()
        holiday_action_row.addWidget(self.stop_holiday_monitoring_button)
        holiday_action_row.addWidget(self.start_holiday_monitoring_button)
        holiday_layout.addLayout(holiday_action_row, 7, 0, 1, 2)

        treatment_card = self.card()
        treatment_layout = QGridLayout(treatment_card)
        treatment_layout.setContentsMargins(16, 14, 16, 14)
        treatment_layout.setHorizontalSpacing(12)
        treatment_layout.setVerticalSpacing(8)
        treatment_title = QLabel("Treatment")
        treatment_title.setObjectName("SectionTitle")
        treatment_subtitle = QLabel("Separate monitoring for overdue planned procedure codes.")
        treatment_subtitle.setObjectName("Muted")
        treatment_subtitle.setWordWrap(True)
        self.monitor_treatment_status_value = QLabel("Stopped")
        self.monitor_treatment_status_value.setObjectName("MonitorStatus")
        self.monitor_treatment_due_value = QLabel("")
        self.monitor_treatment_due_value.setObjectName("Muted")
        self.monitor_treatment_time_value = QLabel("")
        self.monitor_treatment_time_value.setObjectName("Muted")
        self.monitor_treatment_note_value = QLabel("")
        self.monitor_treatment_note_value.setObjectName("Muted")
        self.monitor_treatment_note_value.setWordWrap(True)
        treatment_layout.addWidget(treatment_title, 0, 0, 1, 2)
        treatment_layout.addWidget(treatment_subtitle, 1, 0, 1, 2)
        treatment_layout.addWidget(QLabel("Status"), 2, 0)
        treatment_layout.addWidget(self.monitor_treatment_status_value, 2, 1)
        treatment_layout.addWidget(QLabel("Miss window"), 3, 0)
        treatment_layout.addWidget(self.monitor_treatment_due_value, 3, 1)
        treatment_layout.addWidget(QLabel("Send time"), 4, 0)
        treatment_layout.addWidget(self.monitor_treatment_time_value, 4, 1)
        treatment_layout.addWidget(QLabel("Behavior"), 5, 0, Qt.AlignTop)
        treatment_layout.addWidget(self.monitor_treatment_note_value, 5, 1)
        treatment_action_row = QHBoxLayout()
        self.start_treatment_monitoring_button = QPushButton("Start Treatment")
        self.start_treatment_monitoring_button.setObjectName("PrimaryButton")
        self.start_treatment_monitoring_button.clicked.connect(self.start_treatment_monitoring)
        self.stop_treatment_monitoring_button = QPushButton("Stop")
        self.stop_treatment_monitoring_button.clicked.connect(self.stop_treatment_monitoring)
        treatment_action_row.addStretch()
        treatment_action_row.addWidget(self.stop_treatment_monitoring_button)
        treatment_action_row.addWidget(self.start_treatment_monitoring_button)
        treatment_layout.addLayout(treatment_action_row, 6, 0, 1, 2)
        treatment_layout.setRowStretch(7, 1)

        panels.addWidget(monitor_card, 0, 0)
        panels.addWidget(holiday_card, 0, 1)
        panels.addWidget(treatment_card, 0, 2)
        panels.setColumnStretch(0, 1)
        panels.setColumnStretch(1, 1)
        panels.setColumnStretch(2, 1)
        layout.addLayout(panels)
        layout.addStretch()
        return page

    def build_recall_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(10)

        hero = self.card("HeroCard")
        hero_layout = QVBoxLayout(hero)
        hero_layout.setContentsMargins(18, 14, 18, 14)
        eyebrow = QLabel("RECALL")
        eyebrow.setObjectName("Eyebrow")
        title = QLabel("Cleaning recall SMS")
        title.setObjectName("HeroTitle")
        subtitle = QLabel("Find patients with D1110, D1120, D4341, or D4342 treatment who have not returned after the recall window.")
        subtitle.setObjectName("HeroSubtitle")
        hero_layout.addWidget(eyebrow)
        hero_layout.addWidget(title)
        hero_layout.addWidget(subtitle)
        layout.addWidget(hero)

        controls_card = self.card()
        controls = QHBoxLayout(controls_card)
        controls.setContentsMargins(14, 10, 14, 10)
        controls.setSpacing(8)
        controls.addWidget(QLabel("Recall after"))
        self.recall_months = QSpinBox()
        self.recall_months.setRange(1, 60)
        self.recall_months.setValue(self.config.recall_months)
        self.recall_months.setSuffix(" months")
        self.recall_months.setMinimumHeight(34)
        controls.addWidget(self.recall_months)
        controls.addWidget(QLabel("Procedure codes"))
        self.recall_codes = QLineEdit(self.config.recall_codes)
        self.recall_codes.setPlaceholderText(DEFAULT_RECALL_CODES)
        self.recall_codes.setMinimumWidth(220)
        controls.addWidget(self.recall_codes)
        self.load_recall_button = QPushButton("Load recall list")
        self.load_recall_button.clicked.connect(self.load_recall_patients)
        self.preview_recall_button = QPushButton("Preview selected")
        self.preview_recall_button.clicked.connect(self.preview_recall_selected)
        self.manage_recall_templates_button = QPushButton("Recall templates")
        self.manage_recall_templates_button.clicked.connect(self.open_recall_templates_popup)
        self.fill_recall_button = QPushButton("Fill selected template")
        self.fill_recall_button.setObjectName("PrimaryButton")
        self.fill_recall_button.clicked.connect(self.fill_selected_recall_template)
        controls.addStretch()
        controls.addWidget(self.load_recall_button)
        controls.addWidget(self.manage_recall_templates_button)
        controls.addWidget(self.preview_recall_button)
        controls.addWidget(self.fill_recall_button)
        layout.addWidget(controls_card)

        search_card = self.card()
        search_layout = QHBoxLayout(search_card)
        search_layout.setContentsMargins(18, 12, 18, 12)
        search_layout.addWidget(QLabel("Search"))
        self.recall_search = QLineEdit()
        self.recall_search.setPlaceholderText("Patient, phone, email, code, patient #...")
        self.recall_search.textChanged.connect(lambda _text: self.render_recall_patients())
        search_layout.addWidget(self.recall_search, 1)
        layout.addWidget(search_card)

        table_card = self.card()
        table_layout = QVBoxLayout(table_card)
        table_layout.setContentsMargins(0, 0, 0, 0)
        self.recall_table = QTableWidget(0, 11)
        self.recall_table.setHorizontalHeaderLabels(
            ["Last code visit", "Patient", "Phone", "Email", "Language", "Codes", "Sent", "Last sent", "Pat #", "Template", "View"]
        )
        self.configure_resizable_columns(
            self.recall_table,
            "recall/patient_column_widths",
            {
                0: 130,
                1: 190,
                2: 300,
                3: 150,
                4: 100,
                5: 140,
                6: 70,
                7: 140,
                8: 90,
                9: 190,
                10: 90,
            },
        )
        self.recall_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.recall_table.setSelectionMode(QTableWidget.ExtendedSelection)
        self.recall_table.verticalHeader().setVisible(False)
        self.recall_table.setAlternatingRowColors(True)
        self.recall_table.setShowGrid(False)
        self.recall_table.verticalHeader().setDefaultSectionSize(38)
        self.recall_table.verticalScrollBar().valueChanged.connect(
            lambda _value: self.maybe_load_more_lazy_rows(self.recall_table, "recall", self.render_recall_patients)
        )
        table_layout.addWidget(self.recall_table)
        layout.addWidget(table_card, 1)
        return page

    def build_treatment_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(10)

        hero = self.card("HeroCard")
        hero_layout = QVBoxLayout(hero)
        hero_layout.setContentsMargins(18, 14, 18, 14)
        eyebrow = QLabel("TREATMENT")
        eyebrow.setObjectName("Eyebrow")
        title = QLabel("Pending treatment SMS")
        title.setObjectName("HeroTitle")
        subtitle = QLabel("Find patients with planned procedure codes dated before the configured miss window and no future appointment.")
        subtitle.setObjectName("HeroSubtitle")
        hero_layout.addWidget(eyebrow)
        hero_layout.addWidget(title)
        hero_layout.addWidget(subtitle)
        layout.addWidget(hero)

        controls_card = self.card()
        controls = QVBoxLayout(controls_card)
        controls.setContentsMargins(14, 10, 14, 10)
        controls.setSpacing(8)

        filter_row = QHBoxLayout()
        filter_row.setSpacing(8)
        filter_row.addWidget(QLabel("Procedure date before"))
        self.treatment_days = QSpinBox()
        self.treatment_days.setRange(1, 365)
        self.treatment_days.setValue(self.config.treatment_days)
        self.treatment_days.setSuffix(" days")
        self.treatment_days.setMinimumHeight(34)
        self.treatment_days.setFixedWidth(132)
        filter_row.addWidget(self.treatment_days)
        filter_row.addWidget(QLabel("Procedure codes"))
        self.treatment_codes = QLineEdit(self.config.treatment_codes)
        self.treatment_codes.setPlaceholderText("Optional, e.g. D3310,D2392. Blank = all planned codes")
        self.treatment_codes.setMinimumWidth(200)
        filter_row.addWidget(self.treatment_codes, 1)
        filter_row.addWidget(QLabel("Proc status"))
        self.treatment_statuses = QLineEdit(self.config.treatment_statuses)
        self.treatment_statuses.setPlaceholderText("1")
        self.treatment_statuses.setFixedWidth(84)
        filter_row.addWidget(self.treatment_statuses)
        controls.addLayout(filter_row)

        self.load_treatment_button = QPushButton("Load treatment list")
        self.load_treatment_button.clicked.connect(self.load_treatment_patients)
        self.manage_treatment_templates_button = QPushButton("Treatment templates")
        self.manage_treatment_templates_button.clicked.connect(self.open_treatment_templates_popup)
        self.preview_treatment_button = QPushButton("Preview selected")
        self.preview_treatment_button.clicked.connect(self.preview_treatment_selected)
        self.send_treatment_selected_button = QPushButton("Send selected")
        self.send_treatment_selected_button.setObjectName("PrimaryButton")
        self.send_treatment_selected_button.clicked.connect(self.send_selected_treatment_sms)
        action_row = QHBoxLayout()
        action_row.addStretch()
        action_row.addWidget(self.load_treatment_button)
        action_row.addWidget(self.manage_treatment_templates_button)
        action_row.addWidget(self.preview_treatment_button)
        action_row.addWidget(self.send_treatment_selected_button)
        controls.addLayout(action_row)
        layout.addWidget(controls_card)

        search_card = self.card()
        search_layout = QHBoxLayout(search_card)
        search_layout.setContentsMargins(18, 12, 18, 12)
        search_layout.addWidget(QLabel("Search"))
        self.treatment_search = QLineEdit()
        self.treatment_search.setPlaceholderText("Patient, phone, email, pending code, patient #...")
        self.treatment_search.textChanged.connect(lambda _text: self.render_treatment_patients())
        search_layout.addWidget(self.treatment_search, 1)
        layout.addWidget(search_card)

        table_card = self.card()
        table_layout = QVBoxLayout(table_card)
        table_layout.setContentsMargins(0, 0, 0, 0)
        self.treatment_table = QTableWidget(0, 11)
        self.treatment_table.setHorizontalHeaderLabels(
            ["Procedure date", "Patient", "Phone", "Email", "Language", "Pending codes", "Sent", "Last sent", "Pat #", "Template", "View"]
        )
        self.configure_resizable_columns(
            self.treatment_table,
            "treatment/patient_column_widths",
            {
                0: 130,
                1: 190,
                2: 300,
                3: 150,
                4: 100,
                5: 180,
                6: 70,
                7: 140,
                8: 90,
                9: 220,
                10: 90,
            },
        )
        self.treatment_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.treatment_table.setSelectionMode(QTableWidget.ExtendedSelection)
        self.treatment_table.verticalHeader().setVisible(False)
        self.treatment_table.setAlternatingRowColors(True)
        self.treatment_table.setShowGrid(False)
        self.treatment_table.verticalHeader().setDefaultSectionSize(38)
        self.treatment_table.verticalScrollBar().valueChanged.connect(
            lambda _value: self.maybe_load_more_lazy_rows(self.treatment_table, "treatment", self.render_treatment_patients)
        )
        table_layout.addWidget(self.treatment_table)
        layout.addWidget(table_card, 1)
        return page

    def build_review_google_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(10)

        hero = self.card("HeroCard")
        hero_layout = QVBoxLayout(hero)
        hero_layout.setContentsMargins(18, 14, 18, 14)
        eyebrow = QLabel("GOOGLE REVIEW")
        eyebrow.setObjectName("Eyebrow")
        title = QLabel("Manual Google review SMS")
        title.setObjectName("HeroTitle")
        subtitle = QLabel("Search patients, choose a review template, then fill Phone Link manually. This tab never auto-sends SMS.")
        subtitle.setObjectName("HeroSubtitle")
        hero_layout.addWidget(eyebrow)
        hero_layout.addWidget(title)
        hero_layout.addWidget(subtitle)
        layout.addWidget(hero)

        controls_card = self.card()
        controls = QHBoxLayout(controls_card)
        controls.setContentsMargins(14, 10, 14, 10)
        controls.setSpacing(8)
        controls.addWidget(QLabel("Patient filter"))
        self.review_search = QLineEdit()
        self.review_search.setPlaceholderText("Patient, phone, email, patient #...")
        self.review_search.textChanged.connect(lambda _text: self.render_review_patients())
        self.review_search.returnPressed.connect(self.load_review_patients)
        controls.addWidget(self.review_search, 1)
        self.load_review_button = QPushButton("Load patients")
        self.load_review_button.clicked.connect(self.load_review_patients)
        self.manage_review_templates_button = QPushButton("Review templates")
        self.manage_review_templates_button.clicked.connect(self.open_review_templates_popup)
        self.preview_review_button = QPushButton("Preview selected")
        self.preview_review_button.clicked.connect(self.preview_review_selected)
        self.fill_review_button = QPushButton("Fill selected template")
        self.fill_review_button.setObjectName("PrimaryButton")
        self.fill_review_button.clicked.connect(self.fill_selected_review_template)
        controls.addWidget(self.load_review_button)
        controls.addWidget(self.manage_review_templates_button)
        controls.addWidget(self.preview_review_button)
        controls.addWidget(self.fill_review_button)
        layout.addWidget(controls_card)

        table_card = self.card()
        table_layout = QVBoxLayout(table_card)
        table_layout.setContentsMargins(0, 0, 0, 0)
        self.review_table = QTableWidget(0, 8)
        self.review_table.setHorizontalHeaderLabels(["Patient", "Phone", "Email", "Language", "Last visit", "Pat #", "Template", "View"])
        self.configure_resizable_columns(
            self.review_table,
            "review_google/patient_column_widths",
            {
                0: 220,
                1: 320,
                2: 220,
                3: 120,
                4: 130,
                5: 90,
                6: 190,
                7: 90,
            },
        )
        self.review_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.review_table.setSelectionMode(QTableWidget.ExtendedSelection)
        self.review_table.verticalHeader().setVisible(False)
        self.review_table.setAlternatingRowColors(True)
        self.review_table.setShowGrid(False)
        self.review_table.verticalHeader().setDefaultSectionSize(38)
        self.review_table.verticalScrollBar().valueChanged.connect(
            lambda _value: self.maybe_load_more_lazy_rows(self.review_table, "review_google", self.render_review_patients)
        )
        table_layout.addWidget(self.review_table)
        layout.addWidget(table_card, 1)
        return page

    def build_holiday_birthday_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(10)

        hero = self.card("HeroCard")
        hero_layout = QVBoxLayout(hero)
        hero_layout.setContentsMargins(18, 14, 18, 14)
        eyebrow = QLabel("HOLIDAY & BIRTHDAY")
        eyebrow.setObjectName("Eyebrow")
        title = QLabel("Holiday promotion and birthday SMS")
        title.setObjectName("HeroTitle")
        subtitle = QLabel("Build a custom patient list first, then send the selected holiday or birthday template through Phone Link automation.")
        subtitle.setObjectName("HeroSubtitle")
        hero_layout.addWidget(eyebrow)
        hero_layout.addWidget(title)
        hero_layout.addWidget(subtitle)
        layout.addWidget(hero)

        controls_card = self.card()
        controls = QGridLayout(controls_card)
        controls.setContentsMargins(14, 10, 14, 10)
        controls.setHorizontalSpacing(12)
        controls.setVerticalSpacing(12)

        self.holiday_campaign_type = QComboBox()
        self.holiday_campaign_type.addItem("Holiday promotion", "holiday")
        self.holiday_campaign_type.addItem("Birthday", "birthday")
        self.holiday_campaign_type.currentIndexChanged.connect(self.update_holiday_campaign_controls)
        self.holiday_event = QComboBox()
        self.refresh_holiday_event_combo()
        self.add_holiday_event_button = QPushButton("Add holiday")
        self.add_holiday_event_button.clicked.connect(self.add_holiday_event)
        self.edit_holiday_event_button = QPushButton("Edit holiday")
        self.edit_holiday_event_button.clicked.connect(self.edit_holiday_event)
        self.delete_holiday_event_button = QPushButton("Delete holiday")
        self.delete_holiday_event_button.clicked.connect(self.delete_holiday_event)
        self.holiday_birthday_date = QDateEdit(clinic_qdate())
        self.holiday_birthday_date.setCalendarPopup(True)
        self.holiday_birthday_date.setDisplayFormat("MM/dd/yyyy")
        self.holiday_date_label = QLabel("Send date")
        self.holiday_search = QLineEdit()
        self.holiday_search.setPlaceholderText("Patient, phone, email, patient #...")
        self.holiday_search.textChanged.connect(lambda _text: self.render_holiday_patients())
        self.holiday_search.returnPressed.connect(self.load_holiday_patients)
        self.load_holiday_button = QPushButton("Load / filter patients")
        self.load_holiday_button.clicked.connect(self.load_holiday_patients)
        self.add_custom_holiday_button = QPushButton("Add custom")
        self.add_custom_holiday_button.clicked.connect(self.add_custom_holiday_patient)
        self.remove_holiday_button = QPushButton("Remove selected")
        self.remove_holiday_button.clicked.connect(self.remove_selected_holiday_patients)
        self.manage_holiday_templates_button = QPushButton("Templates")
        self.manage_holiday_templates_button.clicked.connect(self.open_holiday_templates_popup)
        self.preview_holiday_button = QPushButton("Preview selected")
        self.preview_holiday_button.clicked.connect(self.preview_holiday_selected)
        self.save_holiday_automation_button = QPushButton("Save automation")
        self.save_holiday_automation_button.clicked.connect(self.save_current_holiday_automation)
        self.manage_holiday_automation_button = QPushButton("Saved automations")
        self.manage_holiday_automation_button.clicked.connect(self.open_saved_holiday_automations)
        self.send_holiday_selected_button = QPushButton("Send selected")
        self.send_holiday_selected_button.clicked.connect(self.send_selected_holiday_sms)
        self.send_holiday_all_button = QPushButton("Send all in list")
        self.send_holiday_all_button.setObjectName("PrimaryButton")
        self.send_holiday_all_button.clicked.connect(self.send_all_holiday_sms)

        controls.addWidget(QLabel("Campaign"), 0, 0)
        controls.addWidget(self.holiday_campaign_type, 0, 1)
        controls.addWidget(QLabel("Holiday"), 0, 2)
        controls.addWidget(self.holiday_event, 0, 3)
        holiday_actions = QHBoxLayout()
        holiday_actions.addWidget(self.add_holiday_event_button)
        holiday_actions.addWidget(self.edit_holiday_event_button)
        holiday_actions.addWidget(self.delete_holiday_event_button)
        controls.addLayout(holiday_actions, 0, 4, 1, 2)
        controls.addWidget(self.holiday_date_label, 1, 0)
        controls.addWidget(self.holiday_birthday_date, 1, 1)
        controls.addWidget(QLabel("Patient filter"), 1, 2)
        controls.addWidget(self.holiday_search, 1, 3, 1, 2)
        controls.addWidget(self.load_holiday_button, 1, 5)
        action_row = QHBoxLayout()
        action_row.addWidget(self.add_custom_holiday_button)
        action_row.addWidget(self.remove_holiday_button)
        action_row.addWidget(self.manage_holiday_templates_button)
        action_row.addWidget(self.save_holiday_automation_button)
        action_row.addWidget(self.manage_holiday_automation_button)
        action_row.addStretch()
        action_row.addWidget(self.preview_holiday_button)
        action_row.addWidget(self.send_holiday_selected_button)
        action_row.addWidget(self.send_holiday_all_button)
        controls.addLayout(action_row, 2, 0, 1, 6)
        layout.addWidget(controls_card)

        table_card = self.card()
        table_layout = QVBoxLayout(table_card)
        table_layout.setContentsMargins(0, 0, 0, 0)
        self.holiday_table = QTableWidget(0, 10)
        self.holiday_table.setHorizontalHeaderLabels(["Patient", "Phone", "Email", "Language", "Birthdate", "Pat #", "Campaign", "Template", "Status", "View"])
        self.configure_resizable_columns(
            self.holiday_table,
            "holiday_birthday/patient_column_widths",
            {
                0: 220,
                1: 300,
                2: 190,
                3: 100,
                4: 120,
                5: 80,
                6: 160,
                7: 190,
                8: 120,
                9: 90,
            },
        )
        self.holiday_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.holiday_table.setSelectionMode(QTableWidget.ExtendedSelection)
        self.holiday_table.verticalHeader().setVisible(False)
        self.holiday_table.setAlternatingRowColors(True)
        self.holiday_table.setShowGrid(False)
        self.holiday_table.verticalHeader().setDefaultSectionSize(38)
        self.holiday_table.verticalScrollBar().valueChanged.connect(
            lambda _value: self.maybe_load_more_lazy_rows(self.holiday_table, "holiday_birthday", self.render_holiday_patients)
        )
        table_layout.addWidget(self.holiday_table)
        layout.addWidget(table_card, 1)
        self.update_holiday_campaign_controls()
        return page

    def build_templates_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(10)

        hero = self.card("HeroCard")
        hero_layout = QVBoxLayout(hero)
        hero_layout.setContentsMargins(18, 14, 18, 14)
        eyebrow = QLabel("MESSAGE LIBRARY")
        eyebrow.setObjectName("Eyebrow")
        title = QLabel("SMS templates")
        title.setObjectName("HeroTitle")
        subtitle = QLabel("Manage country/language templates. Each appointment can choose a template before sending.")
        subtitle.setObjectName("HeroSubtitle")
        hero_layout.addWidget(eyebrow)
        hero_layout.addWidget(title)
        hero_layout.addWidget(subtitle)
        layout.addWidget(hero)

        template_card = self.card()
        template_layout = QGridLayout(template_card)
        template_layout.setContentsMargins(16, 14, 16, 14)
        template_layout.setHorizontalSpacing(14)
        template_layout.setVerticalSpacing(8)
        self.template_select = QComboBox()
        self.template_name = QLineEdit()
        self.template_country_select = QComboBox()
        for country in ("US", "VI", "ES"):
            self.template_country_select.addItem(template_icon(country), country, country)
        self.template_country_select.setIconSize(QSize(30, 22))
        self.template_text = QTextEdit()
        self.template_text.setMinimumHeight(220)
        self.default_template_select = QComboBox()
        self.default_template_select.setEnabled(False)
        self.default_template_select.setToolTip("Default template is fixed to US.")
        self.add_template_button = QPushButton("Add template")
        self.save_template_button = QPushButton("Save template")
        self.save_template_button.setObjectName("PrimaryButton")
        self.delete_template_button = QPushButton("Delete template")
        self.template_select.currentTextChanged.connect(self.load_template_into_editor)
        self.add_template_button.clicked.connect(self.add_template)
        self.save_template_button.clicked.connect(self.save_template)
        self.delete_template_button.clicked.connect(self.delete_template)
        template_layout.addWidget(QLabel("Edit template"), 0, 0)
        template_layout.addWidget(self.template_select, 0, 1)
        template_layout.addWidget(QLabel("Default template"), 0, 2)
        template_layout.addWidget(self.default_template_select, 0, 3)
        template_layout.addWidget(QLabel("Template key"), 1, 0)
        template_layout.addWidget(self.template_name, 1, 1)
        template_layout.addWidget(QLabel("Country flag"), 1, 2)
        template_layout.addWidget(self.template_country_select, 1, 3)
        template_layout.addWidget(QLabel("Message"), 2, 0, Qt.AlignTop)
        template_layout.addWidget(self.template_text, 2, 1, 1, 3)
        helper = QLabel("Placeholders: {formal_first_name}, {salutation}, {vi_title}, {vi_salutation}, {first_name}, {last_name}, {patient_name}, {age}, {date}, {time}, {clinic_name}, {clinic_phone}, {phone}, {apt_num}, {pat_num}")
        helper.setObjectName("Muted")
        helper.setWordWrap(True)
        template_layout.addWidget(helper, 3, 1, 1, 3)
        template_actions = QHBoxLayout()
        template_actions.addStretch()
        self.reload_templates_button = QPushButton("Reload from Bridge")
        template_actions.addWidget(self.reload_templates_button)
        template_actions.addWidget(self.add_template_button)
        template_actions.addWidget(self.delete_template_button)
        template_actions.addWidget(self.save_template_button)
        template_layout.addLayout(template_actions, 4, 1, 1, 3)
        self.reload_templates_button.clicked.connect(self.reload_templates_from_bridge)
        layout.addWidget(template_card)
        layout.addStretch()
        self.refresh_template_controls()
        return page

    def build_logs_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(10)
        row = QHBoxLayout()
        title = QLabel("Reminder send log")
        title.setObjectName("HeroTitle")
        refresh = QPushButton("Refresh logs")
        refresh.clicked.connect(self.load_logs)
        row.addWidget(title)
        row.addStretch()
        row.addWidget(refresh)
        layout.addLayout(row)
        logs_card = self.card()
        logs_layout = QVBoxLayout(logs_card)
        logs_layout.setContentsMargins(0, 0, 0, 0)
        self.logs_table = QTableWidget(0, 8)
        self.logs_table.setHorizontalHeaderLabels(["ID", "Apt #", "Pat #", "Phone", "Date", "Status", "Sent at", "Error"])
        self.logs_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.logs_table.verticalHeader().setVisible(False)
        self.logs_table.setAlternatingRowColors(True)
        self.logs_table.setShowGrid(False)
        logs_layout.addWidget(self.logs_table)
        layout.addWidget(logs_card)
        return page

    def reload_templates_from_bridge(self) -> None:
        self.load_templates_from_bridge()
        if hasattr(self, "review_link"):
            self.review_link.setText(self.config.review_link)
        if hasattr(self, "holiday_event"):
            self.refresh_holiday_event_combo()
        self.refresh_template_controls()
        self.refresh_table_template_combos()
        QMessageBox.information(self, "Templates reloaded", "Templates have been reloaded from the bridge database.")
        self.statusBar().showMessage("Templates reloaded from bridge.", 4000)

    def refresh_template_controls(self) -> None:
        if not hasattr(self, "template_select"):
            return
        current = self.template_select.currentData() or self.config.default_template_key
        self.template_select.blockSignals(True)
        self.default_template_select.blockSignals(True)
        self.template_select.clear()
        self.default_template_select.clear()
        self.template_select.setIconSize(QSize(30, 22))
        self.default_template_select.setIconSize(QSize(30, 22))
        for key in sorted(self.config.sms_templates):
            label = template_label(key)
            icon = template_icon(template_country(self.config, key))
            self.template_select.addItem(icon, label, key)
            self.default_template_select.addItem(icon, label, key)
        select_index = max(0, self.template_select.findData(current))
        self.config.default_template_key = "US"
        default_index = max(0, self.default_template_select.findData("US"))
        self.template_select.setCurrentIndex(select_index)
        self.default_template_select.setCurrentIndex(default_index)
        self.template_select.blockSignals(False)
        self.default_template_select.blockSignals(False)
        self.load_template_into_editor()

    def current_template_key(self) -> str:
        if not hasattr(self, "template_select"):
            return self.config.default_template_key
        return str(self.template_select.currentData() or self.template_select.currentText() or self.config.default_template_key).strip()

    def load_template_into_editor(self) -> None:
        key = self.current_template_key()
        self.template_name.setText(key)
        if hasattr(self, "template_country_select"):
            country = template_country(self.config, key)
            index = self.template_country_select.findData(country)
            self.template_country_select.setCurrentIndex(index if index >= 0 else 0)
        self.template_text.setPlainText(self.config.sms_templates.get(key, ""))

    def add_template(self) -> None:
        key, ok = QInputDialog.getText(self, "Add template", "Template key, for example US_REMINDER_2 or VI_FOLLOWUP:")
        if not ok:
            return
        key = key.strip().upper()
        if not key:
            return
        if key in self.config.sms_templates:
            QMessageBox.information(self, "Template exists", "That template already exists.")
            return
        country = infer_template_country(key)
        template_text = self.config.sms_templates.get("US") or next(iter(self.config.sms_templates.values()), "")
        try:
            self.repo.add_template(key, "appointment", country, template_text)
            self.load_templates_from_bridge()
        except Exception as exc:
            QMessageBox.critical(self, "Failed to add template", str(exc))
            return
        self.config.save()
        self.refresh_template_controls()
        index = self.template_select.findData(key)
        if index >= 0:
            self.template_select.setCurrentIndex(index)
        self.refresh_table_template_combos()
        QMessageBox.information(self, "Template added", f"Template {key} was added successfully.")

    def save_template(self) -> None:
        old_key = self.current_template_key()
        new_key = self.template_name.text().strip().upper()
        country = str(self.template_country_select.currentData() or infer_template_country(new_key)).upper()
        text = self.template_text.toPlainText().strip()
        if not new_key or not text:
            QMessageBox.warning(self, "Template required", "Template key and message are required.")
            return
        try:
            if old_key != new_key and old_key in self.config.sms_templates:
                self.repo.delete_template(old_key, "appointment")
            self.repo.save_template(new_key, "appointment", country, text)
            self.load_templates_from_bridge()
        except Exception as exc:
            QMessageBox.critical(self, "Failed to save template", str(exc))
            return
        self.config.save()
        self.refresh_template_controls()
        index = self.template_select.findData(new_key)
        if index >= 0:
            self.template_select.setCurrentIndex(index)
        self.refresh_table_template_combos()
        QMessageBox.information(self, "Template saved", f"Template {new_key} was saved successfully.")
        self.statusBar().showMessage("Template saved.", 3000)

    def delete_template(self) -> None:
        key = self.current_template_key()
        if len(self.config.sms_templates) <= 1 or key == "US":
            QMessageBox.warning(self, "Cannot delete", "The default US appointment template must remain available.")
            return
        confirm = QMessageBox.question(self, "Delete template?", f"Delete template {key}?")
        if confirm != QMessageBox.Yes:
            return
        try:
            self.repo.delete_template(key, "appointment")
            self.load_templates_from_bridge()
            if "US" not in self.config.sms_templates:
                self.repo.init_default_templates()
                self.load_templates_from_bridge()
        except Exception as exc:
            QMessageBox.critical(self, "Failed to delete template", str(exc))
            return
        self.config.save()
        self.refresh_template_controls()
        self.refresh_table_template_combos()
        QMessageBox.information(self, "Template deleted", f"Template {key} was deleted successfully.")
        self.statusBar().showMessage("Template deleted.", 3000)

    def open_recall_templates_popup(self) -> None:
        dialog = QDialog(self)
        dialog.setWindowTitle("Recall SMS templates")
        dialog.resize(900, 620)
        layout = QVBoxLayout(dialog)
        layout.setContentsMargins(20, 18, 20, 20)
        layout.setSpacing(14)

        title = QLabel("Recall SMS templates")
        title.setObjectName("HeroTitle")
        layout.addWidget(title)

        form_card = self.card()
        form = QGridLayout(form_card)
        form.setContentsMargins(18, 16, 18, 18)
        form.setHorizontalSpacing(14)
        form.setVerticalSpacing(14)

        select = QComboBox()
        select.setIconSize(QSize(30, 22))
        name = QLineEdit()
        country_select = QComboBox()
        for country in ("US", "VI", "ES"):
            country_select.addItem(template_icon(country), country, country)
        country_select.setIconSize(QSize(30, 22))
        text = QTextEdit()
        text.setMinimumHeight(280)

        def refresh(selected_key: str | None = None) -> None:
            current = selected_key or str(select.currentData() or "US")
            select.blockSignals(True)
            select.clear()
            for key in sorted(self.config.recall_templates):
                country = str(self.config.recall_template_countries.get(key) or infer_template_country(key)).upper()
                select.addItem(template_icon(country), template_label(key), key)
            index = select.findData(current)
            if index < 0:
                index = max(0, select.findData("US"))
            select.setCurrentIndex(index)
            select.blockSignals(False)
            load_current()

        def current_key() -> str:
            return str(select.currentData() or select.currentText() or "US").strip().upper()

        def load_current(*_args: Any) -> None:
            key = current_key()
            name.setText(key)
            country = str(self.config.recall_template_countries.get(key) or infer_template_country(key)).upper()
            country_index = country_select.findData(country)
            country_select.setCurrentIndex(country_index if country_index >= 0 else 0)
            text.setPlainText(self.config.recall_templates.get(key, ""))

        def add_template() -> None:
            key, ok = QInputDialog.getText(dialog, "Add recall template", "Template key, for example US_RECALL_2 or VI_RECALL:")
            if not ok:
                return
            key = key.strip().upper()
            if not key:
                return
            if key in self.config.recall_templates:
                QMessageBox.information(dialog, "Template exists", "That recall template already exists.")
                return
            country = infer_template_country(key)
            default_text = self.config.recall_templates.get("US") or next(iter(self.config.recall_templates.values()), "")
            try:
                self.repo.add_template(key, "recall", country, default_text)
                self.load_templates_from_bridge()
            except Exception as exc:
                QMessageBox.critical(dialog, "Failed to add recall template", str(exc))
                return
            self.config.save()
            refresh(key)
            self.refresh_table_template_combos()
            QMessageBox.information(dialog, "Template added", f"Recall template {key} was added successfully.")

        def save_template() -> None:
            old_key = current_key()
            new_key = name.text().strip().upper()
            body = text.toPlainText().strip()
            country = str(country_select.currentData() or infer_template_country(new_key)).upper()
            if not new_key or not body:
                QMessageBox.warning(dialog, "Template required", "Template key and message are required.")
                return
            try:
                if old_key != new_key and old_key in self.config.recall_templates and old_key != "US":
                    self.repo.delete_template(old_key, "recall")
                self.repo.save_template(new_key, "recall", country, body)
                self.load_templates_from_bridge()
            except Exception as exc:
                QMessageBox.critical(dialog, "Failed to save recall template", str(exc))
                return
            self.config.save()
            refresh(new_key)
            self.refresh_table_template_combos()
            QMessageBox.information(dialog, "Template saved", f"Recall template {new_key} was saved successfully.")

        def delete_template() -> None:
            key = current_key()
            if len(self.config.recall_templates) <= 1 or key == "US":
                QMessageBox.warning(dialog, "Cannot delete", "The default US recall template must remain available.")
                return
            confirm = QMessageBox.question(dialog, "Delete recall template?", f"Delete recall template {key}?")
            if confirm != QMessageBox.Yes:
                return
            try:
                self.repo.delete_template(key, "recall")
                self.load_templates_from_bridge()
            except Exception as exc:
                QMessageBox.critical(dialog, "Failed to delete recall template", str(exc))
                return
            self.config.save()
            refresh("US")
            self.refresh_table_template_combos()
            QMessageBox.information(dialog, "Template deleted", f"Recall template {key} was deleted successfully.")

        select.currentTextChanged.connect(load_current)
        form.addWidget(QLabel("Edit template"), 0, 0)
        form.addWidget(select, 0, 1)
        form.addWidget(QLabel("Template key"), 1, 0)
        form.addWidget(name, 1, 1)
        form.addWidget(QLabel("Country flag"), 1, 2)
        form.addWidget(country_select, 1, 3)
        form.addWidget(QLabel("Message"), 2, 0, Qt.AlignTop)
        form.addWidget(text, 2, 1, 1, 3)
        helper = QLabel("Placeholders: {salutation}, {vi_title}, {vi_salutation}, {first_name}, {last_name}, {patient_name}, {age}, {last_proc_date}, {procedure_codes}, {clinic_phone}")
        helper.setObjectName("Muted")
        helper.setWordWrap(True)
        form.addWidget(helper, 3, 1, 1, 3)
        layout.addWidget(form_card, 1)

        actions = QHBoxLayout()
        add_button = QPushButton("Add template")
        delete_button = QPushButton("Delete template")
        save_button = QPushButton("Save template")
        save_button.setObjectName("PrimaryButton")
        close_button = QPushButton("Close")
        add_button.clicked.connect(add_template)
        delete_button.clicked.connect(delete_template)
        save_button.clicked.connect(save_template)
        close_button.clicked.connect(dialog.accept)
        actions.addStretch()
        actions.addWidget(add_button)
        actions.addWidget(delete_button)
        actions.addWidget(save_button)
        actions.addWidget(close_button)
        layout.addLayout(actions)
        refresh("US")
        dialog.exec()

    def open_treatment_templates_popup(self) -> None:
        dialog = QDialog(self)
        dialog.setWindowTitle("Treatment SMS templates")
        dialog.resize(900, 620)
        layout = QVBoxLayout(dialog)
        layout.setContentsMargins(20, 18, 20, 20)
        layout.setSpacing(14)

        title = QLabel("Treatment SMS templates")
        title.setObjectName("HeroTitle")
        layout.addWidget(title)

        form_card = self.card()
        form = QGridLayout(form_card)
        form.setContentsMargins(18, 16, 18, 18)
        form.setHorizontalSpacing(14)
        form.setVerticalSpacing(14)

        select = QComboBox()
        select.setIconSize(QSize(30, 22))
        name = QLineEdit()
        country_select = QComboBox()
        for country in ("US", "VI", "ES"):
            country_select.addItem(template_icon(country), country, country)
        country_select.setIconSize(QSize(30, 22))
        text = QTextEdit()
        text.setMinimumHeight(280)

        def refresh(selected_key: str | None = None) -> None:
            current = selected_key or str(select.currentData() or "US")
            select.blockSignals(True)
            select.clear()
            for key in sorted(self.config.treatment_templates):
                country = str(self.config.treatment_template_countries.get(key) or infer_template_country(key)).upper()
                select.addItem(template_icon(country), template_label(key), key)
            index = select.findData(current)
            if index < 0:
                index = max(0, select.findData("US"))
            select.setCurrentIndex(index if index >= 0 else 0)
            select.blockSignals(False)
            load_current()

        def current_key() -> str:
            return str(select.currentData() or select.currentText() or "US").strip().upper()

        def load_current(*_args: Any) -> None:
            key = current_key()
            name.setText(key)
            country = str(self.config.treatment_template_countries.get(key) or infer_template_country(key)).upper()
            country_index = country_select.findData(country)
            country_select.setCurrentIndex(country_index if country_index >= 0 else 0)
            text.setPlainText(self.config.treatment_templates.get(key, ""))

        def add_template() -> None:
            key, ok = QInputDialog.getText(dialog, "Add treatment template", "Template key, for example US_TREATMENT_2 or VI_TREATMENT:")
            if not ok:
                return
            key = key.strip().upper()
            if not key:
                return
            if key in self.config.treatment_templates:
                QMessageBox.information(dialog, "Template exists", "That treatment template already exists.")
                return
            country = infer_template_country(key)
            default_text = self.config.treatment_templates.get("US") or next(iter(self.config.treatment_templates.values()), "")
            try:
                self.repo.add_template(key, "treatment", country, default_text)
                self.load_templates_from_bridge()
            except Exception as exc:
                QMessageBox.critical(dialog, "Failed to add treatment template", str(exc))
                return
            refresh(key)
            self.refresh_table_template_combos()
            QMessageBox.information(dialog, "Template added", f"Treatment template {key} was added successfully.")

        def save_template() -> None:
            old_key = current_key()
            new_key = name.text().strip().upper()
            body = text.toPlainText().strip()
            country = str(country_select.currentData() or infer_template_country(new_key)).upper()
            if not new_key or not body:
                QMessageBox.warning(dialog, "Template required", "Template key and message are required.")
                return
            try:
                if old_key != new_key and old_key in self.config.treatment_templates and old_key != "US":
                    self.repo.delete_template(old_key, "treatment")
                self.repo.save_template(new_key, "treatment", country, body)
                self.load_templates_from_bridge()
            except Exception as exc:
                QMessageBox.critical(dialog, "Failed to save treatment template", str(exc))
                return
            refresh(new_key)
            self.refresh_table_template_combos()
            QMessageBox.information(dialog, "Template saved", f"Treatment template {new_key} was saved successfully.")

        def delete_template() -> None:
            key = current_key()
            if len(self.config.treatment_templates) <= 1 or key == "US":
                QMessageBox.warning(dialog, "Cannot delete", "The default US treatment template must remain available.")
                return
            confirm = QMessageBox.question(dialog, "Delete treatment template?", f"Delete treatment template {key}?")
            if confirm != QMessageBox.Yes:
                return
            try:
                self.repo.delete_template(key, "treatment")
                self.load_templates_from_bridge()
            except Exception as exc:
                QMessageBox.critical(dialog, "Failed to delete treatment template", str(exc))
                return
            refresh("US")
            self.refresh_table_template_combos()
            QMessageBox.information(dialog, "Template deleted", f"Treatment template {key} was deleted successfully.")

        select.currentTextChanged.connect(load_current)
        form.addWidget(QLabel("Edit template"), 0, 0)
        form.addWidget(select, 0, 1)
        form.addWidget(QLabel("Template key"), 1, 0)
        form.addWidget(name, 1, 1)
        form.addWidget(QLabel("Country flag"), 1, 2)
        form.addWidget(country_select, 1, 3)
        form.addWidget(QLabel("Message"), 2, 0, Qt.AlignTop)
        form.addWidget(text, 2, 1, 1, 3)
        helper = QLabel("Placeholders: {salutation}, {vi_title}, {vi_salutation}, {first_name}, {last_name}, {patient_name}, {age}, {last_pending_proc_date}, {procedure_codes}, {procedure_descriptions}, {clinic_phone}")
        helper.setObjectName("Muted")
        helper.setWordWrap(True)
        form.addWidget(helper, 3, 1, 1, 3)
        layout.addWidget(form_card, 1)

        actions = QHBoxLayout()
        add_button = QPushButton("Add template")
        delete_button = QPushButton("Delete template")
        save_button = QPushButton("Save template")
        save_button.setObjectName("PrimaryButton")
        close_button = QPushButton("Close")
        add_button.clicked.connect(add_template)
        delete_button.clicked.connect(delete_template)
        save_button.clicked.connect(save_template)
        close_button.clicked.connect(dialog.accept)
        actions.addStretch()
        actions.addWidget(add_button)
        actions.addWidget(delete_button)
        actions.addWidget(save_button)
        actions.addWidget(close_button)
        layout.addLayout(actions)
        refresh("US")
        dialog.exec()

    def open_review_templates_popup(self) -> None:
        dialog = QDialog(self)
        dialog.setWindowTitle("Google review SMS templates")
        dialog.resize(900, 620)
        layout = QVBoxLayout(dialog)
        layout.setContentsMargins(20, 18, 20, 20)
        layout.setSpacing(14)

        title = QLabel("Google review SMS templates")
        title.setObjectName("HeroTitle")
        layout.addWidget(title)

        form_card = self.card()
        form = QGridLayout(form_card)
        form.setContentsMargins(18, 16, 18, 18)
        form.setHorizontalSpacing(14)
        form.setVerticalSpacing(14)

        select = QComboBox()
        select.setIconSize(QSize(30, 22))
        name = QLineEdit()
        country_select = QComboBox()
        for country in ("US", "VI", "ES"):
            country_select.addItem(template_icon(country), country, country)
        country_select.setIconSize(QSize(30, 22))
        text = QTextEdit()
        text.setMinimumHeight(280)

        def refresh(selected_key: str | None = None) -> None:
            current = selected_key or str(select.currentData() or "US")
            select.blockSignals(True)
            select.clear()
            for key in sorted(self.config.review_templates):
                country = str(self.config.review_template_countries.get(key) or infer_template_country(key)).upper()
                select.addItem(template_icon(country), template_label(key), key)
            index = select.findData(current)
            if index < 0:
                index = max(0, select.findData("US"))
            select.setCurrentIndex(index)
            select.blockSignals(False)
            load_current()

        def current_key() -> str:
            return str(select.currentData() or select.currentText() or "US").strip().upper()

        def load_current(*_args: Any) -> None:
            key = current_key()
            name.setText(key)
            country = str(self.config.review_template_countries.get(key) or infer_template_country(key)).upper()
            country_index = country_select.findData(country)
            country_select.setCurrentIndex(country_index if country_index >= 0 else 0)
            text.setPlainText(self.config.review_templates.get(key, ""))

        def add_template() -> None:
            key, ok = QInputDialog.getText(dialog, "Add review template", "Template key, for example US_REVIEW_2 or VI_REVIEW:")
            if not ok:
                return
            key = key.strip().upper()
            if not key:
                return
            if key in self.config.review_templates:
                QMessageBox.information(dialog, "Template exists", "That Google review template already exists.")
                return
            country = infer_template_country(key)
            default_text = self.config.review_templates.get("US") or next(iter(self.config.review_templates.values()), "")
            try:
                self.repo.add_template(key, "review_google", country, default_text)
                self.load_templates_from_bridge()
            except Exception as exc:
                QMessageBox.critical(dialog, "Failed to add review template", str(exc))
                return
            refresh(key)
            self.refresh_table_template_combos()
            QMessageBox.information(dialog, "Template added", f"Google review template {key} was added successfully.")

        def save_template() -> None:
            old_key = current_key()
            new_key = name.text().strip().upper()
            body = text.toPlainText().strip()
            country = str(country_select.currentData() or infer_template_country(new_key)).upper()
            if not new_key or not body:
                QMessageBox.warning(dialog, "Template required", "Template key and message are required.")
                return
            try:
                if old_key != new_key and old_key in self.config.review_templates and old_key != "US":
                    self.repo.delete_template(old_key, "review_google")
                self.repo.save_template(new_key, "review_google", country, body)
                self.load_templates_from_bridge()
            except Exception as exc:
                QMessageBox.critical(dialog, "Failed to save review template", str(exc))
                return
            refresh(new_key)
            self.refresh_table_template_combos()
            QMessageBox.information(dialog, "Template saved", f"Google review template {new_key} was saved successfully.")

        def delete_template() -> None:
            key = current_key()
            if len(self.config.review_templates) <= 1 or key == "US":
                QMessageBox.warning(dialog, "Cannot delete", "The default US Google review template must remain available.")
                return
            confirm = QMessageBox.question(dialog, "Delete review template?", f"Delete Google review template {key}?")
            if confirm != QMessageBox.Yes:
                return
            try:
                self.repo.delete_template(key, "review_google")
                self.load_templates_from_bridge()
            except Exception as exc:
                QMessageBox.critical(dialog, "Failed to delete review template", str(exc))
                return
            refresh("US")
            self.refresh_table_template_combos()
            QMessageBox.information(dialog, "Template deleted", f"Google review template {key} was deleted successfully.")

        select.currentTextChanged.connect(load_current)
        form.addWidget(QLabel("Edit template"), 0, 0)
        form.addWidget(select, 0, 1)
        form.addWidget(QLabel("Template key"), 1, 0)
        form.addWidget(name, 1, 1)
        form.addWidget(QLabel("Country flag"), 1, 2)
        form.addWidget(country_select, 1, 3)
        form.addWidget(QLabel("Message"), 2, 0, Qt.AlignTop)
        form.addWidget(text, 2, 1, 1, 3)
        helper = QLabel("Placeholders: {salutation}, {vi_title}, {vi_salutation}, {first_name}, {last_name}, {patient_name}, {age}, {clinic_phone}, {review_link}")
        helper.setObjectName("Muted")
        helper.setWordWrap(True)
        form.addWidget(helper, 3, 1, 1, 3)
        layout.addWidget(form_card, 1)

        actions = QHBoxLayout()
        add_button = QPushButton("Add template")
        delete_button = QPushButton("Delete template")
        save_button = QPushButton("Save template")
        save_button.setObjectName("PrimaryButton")
        close_button = QPushButton("Close")
        add_button.clicked.connect(add_template)
        delete_button.clicked.connect(delete_template)
        save_button.clicked.connect(save_template)
        close_button.clicked.connect(dialog.accept)
        actions.addStretch()
        actions.addWidget(add_button)
        actions.addWidget(delete_button)
        actions.addWidget(save_button)
        actions.addWidget(close_button)
        layout.addLayout(actions)
        refresh("US")
        dialog.exec()

    def open_holiday_templates_popup(self) -> None:
        dialog = QDialog(self)
        dialog.setWindowTitle("Holiday & Birthday SMS templates")
        dialog.resize(940, 640)
        layout = QVBoxLayout(dialog)
        layout.setContentsMargins(20, 18, 20, 20)
        layout.setSpacing(14)

        title = QLabel("Holiday & Birthday SMS templates")
        title.setObjectName("HeroTitle")
        layout.addWidget(title)

        form_card = self.card()
        form = QGridLayout(form_card)
        form.setContentsMargins(18, 16, 18, 18)
        form.setHorizontalSpacing(14)
        form.setVerticalSpacing(14)

        select = QComboBox()
        select.setIconSize(QSize(30, 22))
        name = QLineEdit()
        country_select = QComboBox()
        for country in ("US", "VI", "ES"):
            country_select.addItem(template_icon(country), country, country)
        country_select.setIconSize(QSize(30, 22))
        text = QTextEdit()
        text.setMinimumHeight(300)

        def refresh(selected_key: str | None = None) -> None:
            current = selected_key or str(select.currentData() or "US_HOLIDAY")
            select.blockSignals(True)
            select.clear()
            for key in sorted(self.config.holiday_templates):
                country = str(self.config.holiday_template_countries.get(key) or infer_template_country(key)).upper()
                select.addItem(template_icon(country), template_label(key), key)
            index = select.findData(current)
            if index < 0:
                index = max(0, select.findData("US_HOLIDAY"))
            select.setCurrentIndex(index)
            select.blockSignals(False)
            load_current()

        def current_key() -> str:
            return str(select.currentData() or select.currentText() or "US_HOLIDAY").strip().upper()

        def load_current(*_args: Any) -> None:
            key = current_key()
            name.setText(key)
            country = str(self.config.holiday_template_countries.get(key) or infer_template_country(key)).upper()
            country_index = country_select.findData(country)
            country_select.setCurrentIndex(country_index if country_index >= 0 else 0)
            text.setPlainText(self.config.holiday_templates.get(key, ""))

        def add_template() -> None:
            key, ok = QInputDialog.getText(dialog, "Add campaign template", "Template key, for example US_HOLIDAY_2, VI_BIRTHDAY_2, or ES_HOLIDAY:")
            if not ok:
                return
            key = key.strip().upper()
            if not key:
                return
            if key in self.config.holiday_templates:
                QMessageBox.information(dialog, "Template exists", "That Holiday & Birthday template already exists.")
                return
            country = infer_template_country(key)
            fallback_key = f"{country}_BIRTHDAY" if "BIRTHDAY" in key else f"{country}_HOLIDAY"
            default_text = (
                self.config.holiday_templates.get(fallback_key)
                or self.config.holiday_templates.get("US_HOLIDAY")
                or next(iter(self.config.holiday_templates.values()), "")
            )
            try:
                self.repo.add_template(key, "holiday_birthday", country, default_text)
                self.load_templates_from_bridge()
            except Exception as exc:
                QMessageBox.critical(dialog, "Failed to add campaign template", str(exc))
                return
            self.config.save()
            refresh(key)
            self.refresh_table_template_combos()
            QMessageBox.information(dialog, "Template added", f"Campaign template {key} was added successfully.")

        def save_template() -> None:
            old_key = current_key()
            new_key = name.text().strip().upper()
            body = text.toPlainText().strip()
            country = str(country_select.currentData() or infer_template_country(new_key)).upper()
            if not new_key or not body:
                QMessageBox.warning(dialog, "Template required", "Template key and message are required.")
                return
            try:
                if old_key != new_key and old_key in self.config.holiday_templates and old_key not in {"US_HOLIDAY", "US_BIRTHDAY"}:
                    self.repo.delete_template(old_key, "holiday_birthday")
                self.repo.save_template(new_key, "holiday_birthday", country, body)
                self.load_templates_from_bridge()
            except Exception as exc:
                QMessageBox.critical(dialog, "Failed to save campaign template", str(exc))
                return
            self.config.save()
            refresh(new_key)
            self.refresh_table_template_combos()
            QMessageBox.information(dialog, "Template saved", f"Campaign template {new_key} was saved successfully.")

        def delete_template() -> None:
            key = current_key()
            if len(self.config.holiday_templates) <= 1 or key in {"US_HOLIDAY", "US_BIRTHDAY"}:
                QMessageBox.warning(dialog, "Cannot delete", "Default US holiday and birthday templates must remain available.")
                return
            confirm = QMessageBox.question(dialog, "Delete campaign template?", f"Delete Holiday & Birthday template {key}?")
            if confirm != QMessageBox.Yes:
                return
            try:
                self.repo.delete_template(key, "holiday_birthday")
                self.load_templates_from_bridge()
            except Exception as exc:
                QMessageBox.critical(dialog, "Failed to delete campaign template", str(exc))
                return
            self.config.save()
            refresh("US_HOLIDAY")
            self.refresh_table_template_combos()
            QMessageBox.information(dialog, "Template deleted", f"Campaign template {key} was deleted successfully.")

        select.currentTextChanged.connect(load_current)
        form.addWidget(QLabel("Edit template"), 0, 0)
        form.addWidget(select, 0, 1)
        form.addWidget(QLabel("Template key"), 1, 0)
        form.addWidget(name, 1, 1)
        form.addWidget(QLabel("Country flag"), 1, 2)
        form.addWidget(country_select, 1, 3)
        form.addWidget(QLabel("Message"), 2, 0, Qt.AlignTop)
        form.addWidget(text, 2, 1, 1, 3)
        helper = QLabel("Placeholders: {formal_first_name}, {salutation}, {vi_title}, {vi_salutation}, {first_name}, {last_name}, {patient_name}, {age}, {clinic_phone}, {holiday_name}, {campaign_name}, {review_link}")
        helper.setObjectName("Muted")
        helper.setWordWrap(True)
        form.addWidget(helper, 3, 1, 1, 3)
        layout.addWidget(form_card, 1)

        actions = QHBoxLayout()
        add_button = QPushButton("Add template")
        delete_button = QPushButton("Delete template")
        save_button = QPushButton("Save template")
        save_button.setObjectName("PrimaryButton")
        close_button = QPushButton("Close")
        add_button.clicked.connect(add_template)
        delete_button.clicked.connect(delete_template)
        save_button.clicked.connect(save_template)
        close_button.clicked.connect(dialog.accept)
        actions.addStretch()
        actions.addWidget(add_button)
        actions.addWidget(delete_button)
        actions.addWidget(save_button)
        actions.addWidget(close_button)
        layout.addLayout(actions)
        refresh("US_HOLIDAY")
        dialog.exec()

    def safe_read_scheduler_bat_times(self) -> dict[str, str]:
        try:
            return read_scheduler_bat_times()
        except Exception:
            return dict(DEFAULT_SCHEDULER_TIMES)

    def reload_scheduler_bat_times(self) -> None:
        try:
            times = read_scheduler_bat_times()
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "Scheduler BAT error", str(exc))
            return
        for name, _label in SCHEDULER_TIME_FIELDS:
            if name in self.scheduler_time_edits:
                self.scheduler_time_edits[name].setTime(qtime_from_hhmm(times.get(name), DEFAULT_SCHEDULER_TIMES[name]))
        self.statusBar().showMessage("Scheduler BAT times reloaded.", 4000)

    def save_scheduler_bat_times(self, silent: bool = False, notify: bool = True) -> bool:
        if not hasattr(self, "scheduler_time_edits"):
            return True
        times = {
            name: self.scheduler_time_edits[name].time().toString("HH:mm")
            for name, _label in SCHEDULER_TIME_FIELDS
            if name in self.scheduler_time_edits
        }
        try:
            write_scheduler_bat_times(times)
        except Exception as exc:  # noqa: BLE001
            if not silent:
                QMessageBox.critical(self, "Scheduler BAT save failed", str(exc))
            return False
        if not silent:
            self.statusBar().showMessage("Scheduler BAT times saved.", 4000)
            if notify:
                QMessageBox.information(
                    self,
                    "Scheduler BAT saved",
                    "scheduler-on.bat was updated.\n\nRun scheduler-on.bat as Administrator again to recreate Windows scheduled tasks with the new times.",
                )
        return True

    def save_settings_clicked(self) -> None:
        self.save_settings(silent=False, notify=True)

    def save_settings(self, silent: bool = False, notify: bool = False) -> None:
        try:
            statuses = [int(part.strip()) for part in self.statuses.text().split(",") if part.strip()]
        except ValueError:
            QMessageBox.warning(self, "Invalid statuses", "Appointment statuses must be comma-separated numbers.")
            return
        self.config.bridge_url = self.bridge_url.text().strip().rstrip("/")
        self.config.api_token = self.api_token.text().strip()
        self.config.clinic_name = self.clinic_name.text().strip()
        self.config.clinic_phone = self.clinic_phone.text().strip()
        self.config.reminder_days_ahead = self.days_ahead.value()
        self.config.scheduled_send_time = self.schedule_time.time().toString("HH:mm")
        self.config.appointment_statuses = statuses or [1]
        self.config.dry_run = False
        if hasattr(self, "review_link"):
            self.config.review_link = self.review_link.text().strip()
        if hasattr(self, "recall_codes"):
            self.config.recall_codes = self.recall_codes.text().strip() or DEFAULT_RECALL_CODES
        if hasattr(self, "recall_months"):
            self.config.recall_months = self.recall_months.value()
        if hasattr(self, "treatment_days"):
            self.config.treatment_days = self.treatment_days.value()
        if hasattr(self, "treatment_codes"):
            self.config.treatment_codes = self.treatment_codes.text().strip()
        if hasattr(self, "treatment_statuses"):
            self.config.treatment_statuses = self.treatment_statuses.text().strip() or "1"
        self.config.default_template_key = "US"
        self.config.sms_template = default_template(self.config)
        self.config.recall_template = self.config.recall_templates.get("US", "")
        self.config.save()
        if not self.save_scheduler_bat_times(silent=silent, notify=False):
            return
        self.repo = BridgeClient(self.config)
        if hasattr(self, "review_link"):
            try:
                self.repo.save_sms_setting("review_link", self.config.review_link)
            except Exception as exc:
                if not silent:
                    QMessageBox.warning(self, "Review link not saved", str(exc))
        self.update_dry_run_badge()
        self.update_monitoring_status()
        self.refresh_template_controls()
        self.refresh_table_template_combos()
        if not silent:
            self.statusBar().showMessage("Settings saved.", 4000)
            if notify:
                QMessageBox.information(self, "Settings saved", "Settings and scheduler BAT times were saved.")

    def test_bridge_connection(self) -> None:
        self.save_settings(silent=True)
        try:
            self.repo.health_check()
            QMessageBox.information(self, "Bridge OK", "Connected to the Open Dental bridge.")
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "Bridge error", str(exc))

    def load_appointments(self) -> None:
        self.load_templates_from_bridge()
        self.save_settings(silent=True)
        target = self.date_edit.date().toPython()
        if self.load_worker and self.load_worker.isRunning():
            self.queued_load = True
            self.statusBar().showMessage("Finishing current load before refreshing selected date...", 3000)
            return
        config_snapshot = AppConfig(**asdict(self.config))
        self.load_worker = LoadAppointmentsWorker(config_snapshot, target)
        self.load_worker.loaded.connect(self.appointments_loaded)
        self.load_worker.failed.connect(self.appointments_load_failed)
        self.load_worker.finished.connect(self.appointments_load_finished)
        self.statusBar().showMessage(f"Loading appointments for {display_date(target)}...", 4000)
        self.set_table_loading(True)
        self.load_worker.start()

    def appointments_loaded(self, target: date, appointments: list[dict[str, Any]], logs: list[dict[str, Any]]) -> None:
        self.appointments = self.expand_appointment_phone_targets(appointments, logs)
        self.render_appointments()
        self.render_logs(logs)
        self.update_dry_run_badge()
        self.statusBar().showMessage(f"Loaded {len(self.appointments)} appointments for {display_date(target)}.", 4000)
        if self.send_after_load:
            self.send_after_load = False
            started = self.send_all_not_sent(silent=True, confirm_real=False)
            if not started and self.monitor_batch_active:
                self.process_next_monitor_target()

    def appointments_load_failed(self, _target: date, message: str) -> None:
        if self.monitor_batch_active:
            self.monitor_batch_failed = True
            self.send_after_load = False
            self.append_activity(f"Scheduled load failed: {message}")
            self.process_next_monitor_target()
            return
        QMessageBox.critical(self, "Load error", message)

    def appointments_load_finished(self) -> None:
        self.set_table_loading(False)
        if self.queued_load:
            self.queued_load = False
            self.load_debounce.start(50)
            return
        if self.monitoring_active and not self.monitor_batch_active:
            QTimer.singleShot(0, self.check_schedule)

    def load_appointments_for_selected_date(self, *_args: Any) -> None:
        if self.suppress_auto_load:
            return
        if not self.config.bridge_url or not self.config.api_token:
            return
        self.statusBar().showMessage("Preparing selected date...", 1200)
        self.load_debounce.start()

    def expand_appointment_phone_targets(self, appointments: list[dict[str, Any]], logs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        log_map = {reminder_log_key(row): row for row in logs}
        expanded: list[dict[str, Any]] = []
        for appointment in appointments:
            phone_targets: list[tuple[str, str]] = []
            for source, value in (
                ("Wireless", appointment.get("WirelessPhoneFormatted") or appointment.get("WirelessPhone")),
                ("Work Phone", appointment.get("WorkPhoneFormatted") or appointment.get("WkPhone")),
            ):
                phone = format_us_phone(str(value or ""))
                digits = digits_only(phone)
                if digits and digits not in {digits_only(item[1]) for item in phone_targets}:
                    phone_targets.append((source, phone))
            if not phone_targets:
                fallback = appointment.get("Phone") or appointment.get("HomePhoneFormatted") or appointment.get("HmPhone")
                phone_targets.append(("Phone", format_us_phone(str(fallback or ""))))
            row = dict(appointment)
            row["_ReminderOffsetDays"] = reminder_offset_days(row)
            row_targets: list[dict[str, str]] = []
            for source, phone in phone_targets:
                log = log_map.get(reminder_log_key(row, phone))
                if log:
                    status = log.get("Status") or ""
                    sent_at = log.get("SentAt") or ""
                    error = log.get("ErrorMessage") or ""
                else:
                    status = ""
                    sent_at = ""
                    error = ""
                row_targets.append({
                    "source": source,
                    "phone": phone,
                    "status": status,
                    "sent_at": sent_at,
                    "error": error,
                })
            row["PhoneTargets"] = row_targets
            row["Phone"] = self.phone_targets_display(row_targets)
            row["PhoneSource"] = ", ".join(target["source"] for target in row_targets if target.get("phone"))
            target_statuses = [target.get("status", "") for target in row_targets if digits_only(target.get("phone", ""))]
            if target_statuses and all(status in {"sent", "dry-run"} for status in target_statuses):
                row["ReminderStatus"] = "sent" if any(status == "sent" for status in target_statuses) else "dry-run"
            elif any(status in {"sent", "dry-run"} for status in target_statuses):
                row["ReminderStatus"] = "partial"
            elif any(status == "failed" for status in target_statuses):
                row["ReminderStatus"] = "failed"
            else:
                row["ReminderStatus"] = ""
            sent_targets = [target for target in row_targets if target.get("status") == "sent"]
            sent_times = [target.get("sent_at", "") for target in sent_targets if target.get("sent_at")]
            row["ReminderSentCount"] = len(sent_targets)
            row["ReminderLastSentAt"] = max(sent_times) if sent_times else ""
            row["ReminderSentAt"] = ", ".join(target.get("sent_at", "") for target in row_targets if target.get("sent_at"))
            row["ReminderError"] = "; ".join(target.get("error", "") for target in row_targets if target.get("error"))
            expanded.append(row)
        return expanded

    def phone_targets_display(self, targets: list[dict[str, str]]) -> str:
        parts = [
            f"{target.get('source')}: {target.get('phone')}"
            for target in targets
            if digits_only(target.get("phone", ""))
        ]
        return " | ".join(parts)

    def normalize_patient_phone_targets(self, patient: dict[str, Any]) -> dict[str, Any]:
        phone_targets: list[tuple[str, str]] = []
        for source, value in (
            ("Wireless", patient.get("WirelessPhoneFormatted") or patient.get("WirelessPhone")),
            ("Work Phone", patient.get("WorkPhoneFormatted") or patient.get("WkPhone")),
        ):
            phone = format_us_phone(str(value or ""))
            digits = digits_only(phone)
            if digits and digits not in {digits_only(item[1]) for item in phone_targets}:
                phone_targets.append((source, phone))
        if not phone_targets:
            fallback = patient.get("Phone") or patient.get("HomePhoneFormatted") or patient.get("HmPhone")
            phone_targets.append(("Phone", format_us_phone(str(fallback or ""))))
        row = dict(patient)
        row_targets = [
            {"source": source, "phone": phone, "status": ""}
            for source, phone in phone_targets
            if digits_only(phone)
        ]
        row["PhoneTargets"] = row_targets
        row["Phone"] = self.phone_targets_display(row_targets)
        row["PhoneSource"] = ", ".join(target["source"] for target in row_targets)
        row["_Recall"] = True
        key = recall_template_key_for_language(self.config, row.get("Language"))
        row["_TemplateKey"] = key
        row["_TemplateText"] = self.config.recall_templates.get(key, "")
        return row

    def normalize_review_patient_phone_targets(self, patient: dict[str, Any]) -> dict[str, Any]:
        row = self.normalize_patient_phone_targets(patient)
        row.pop("_Recall", None)
        key = review_template_key_for_language(self.config, row.get("Language"))
        row["_TemplateKey"] = key
        row["_TemplateText"] = self.config.review_templates.get(key, "")
        row["_TemplateCountry"] = str(self.config.review_template_countries.get(key) or infer_template_country(key)).upper()
        return row

    def normalize_holiday_patient(self, patient: dict[str, Any]) -> dict[str, Any]:
        row = self.normalize_patient_phone_targets(patient)
        row.pop("_Recall", None)
        campaign_type = str(self.holiday_campaign_type.currentData() or "holiday") if hasattr(self, "holiday_campaign_type") else "holiday"
        campaign_name = (
            self.holiday_birthday_date.date().toString("MM/dd/yyyy")
            if campaign_type == "birthday" and hasattr(self, "holiday_birthday_date")
            else str(self.holiday_event.currentData() or self.holiday_event.currentText() or "Holiday")
        )
        key = holiday_template_key_for_language(self.config, row.get("Language"), campaign_type)
        row["_CampaignType"] = campaign_type
        row["_CampaignName"] = campaign_name
        row["_HolidayName"] = campaign_name
        row["_TemplateKey"] = key
        row["_TemplateText"] = self.config.holiday_templates.get(key, "")
        row["_TemplateCountry"] = str(self.config.holiday_template_countries.get(key) or infer_template_country(key)).upper()
        row["_CampaignStatus"] = ""
        return row

    def load_recall_patients(self) -> None:
        if self.recall_load_worker and self.recall_load_worker.isRunning():
            QMessageBox.information(self, "Loading", "Recall list is already loading.")
            return
        self.save_settings()
        self.load_recall_button.setEnabled(False)
        self.statusBar().showMessage("Loading recall candidates...", 4000)
        self.recall_load_worker = LoadRecallWorker(self.config, self.config.recall_months, self.config.recall_codes)
        self.recall_load_worker.loaded.connect(self.recall_patients_loaded)
        self.recall_load_worker.failed.connect(self.recall_patients_failed)
        self.recall_load_worker.finished.connect(lambda: self.load_recall_button.setEnabled(True))
        self.recall_load_worker.start()

    def recall_patients_loaded(self, patients: list[dict[str, Any]]) -> None:
        self.recall_patients = [self.normalize_patient_phone_targets(patient) for patient in patients]
        self.render_recall_patients()
        self.statusBar().showMessage(f"Loaded {len(self.recall_patients)} recall patients.", 4000)

    def recall_patients_failed(self, message: str) -> None:
        QMessageBox.critical(self, "Recall load error", message)

    def load_treatment_patients(self) -> None:
        if self.treatment_load_worker and self.treatment_load_worker.isRunning():
            QMessageBox.information(self, "Loading", "Treatment list is already loading.")
            return
        self.save_settings()
        self.load_treatment_button.setEnabled(False)
        self.statusBar().showMessage("Loading pending treatment candidates...", 4000)
        self.treatment_load_worker = LoadTreatmentWorker(
            self.config,
            self.config.treatment_days,
            self.config.treatment_codes,
            self.config.treatment_statuses,
        )
        self.treatment_load_worker.loaded.connect(self.treatment_patients_loaded)
        self.treatment_load_worker.failed.connect(self.treatment_patients_failed)
        self.treatment_load_worker.finished.connect(lambda: self.load_treatment_button.setEnabled(True))
        self.treatment_load_worker.start()

    def treatment_patients_loaded(self, patients: list[dict[str, Any]]) -> None:
        self.treatment_patients = [self.normalize_patient_phone_targets(patient) for patient in patients]
        self.render_treatment_patients()
        self.statusBar().showMessage(f"Loaded {len(self.treatment_patients)} treatment patients.", 4000)

    def treatment_patients_failed(self, message: str) -> None:
        QMessageBox.critical(self, "Treatment load error", message)

    def load_review_patients(self) -> None:
        if self.review_load_worker and self.review_load_worker.isRunning():
            QMessageBox.information(self, "Loading", "Review patient list is already loading.")
            return
        self.save_settings(silent=True)
        self.load_review_button.setEnabled(False)
        query = self.review_search.text().strip() if hasattr(self, "review_search") else ""
        self.statusBar().showMessage("Loading patients for Google review SMS...", 4000)
        self.review_load_worker = LoadPatientsWorker(self.config, query)
        self.review_load_worker.loaded.connect(self.review_patients_loaded)
        self.review_load_worker.failed.connect(self.review_patients_failed)
        self.review_load_worker.finished.connect(lambda: self.load_review_button.setEnabled(True))
        self.review_load_worker.start()

    def review_patients_loaded(self, patients: list[dict[str, Any]]) -> None:
        self.review_patients = [self.normalize_review_patient_phone_targets(patient) for patient in patients]
        self.render_review_patients()
        self.statusBar().showMessage(f"Loaded {len(self.review_patients)} patients for Google review SMS.", 4000)

    def review_patients_failed(self, message: str) -> None:
        QMessageBox.critical(self, "Review patient load error", message)

    def load_holiday_patients(self) -> None:
        if self.holiday_load_worker and self.holiday_load_worker.isRunning():
            QMessageBox.information(self, "Loading", "Holiday/Birthday patient list is already loading.")
            return
        self.save_settings(silent=True)
        self.load_holiday_button.setEnabled(False)
        campaign_type = str(self.holiday_campaign_type.currentData() or "holiday")
        if campaign_type == "birthday":
            target = self.holiday_birthday_date.date().toPython()
            self.holiday_load_worker = LoadBirthdayPatientsWorker(self.config, target)
            self.statusBar().showMessage(f"Loading birthday patients for {display_date(target)}...", 4000)
        else:
            query = self.holiday_search.text().strip() if hasattr(self, "holiday_search") else ""
            self.holiday_load_worker = LoadPatientsWorker(self.config, query)
            self.statusBar().showMessage("Loading holiday promotion patients...", 4000)
        self.holiday_load_worker.loaded.connect(self.holiday_patients_loaded)
        self.holiday_load_worker.failed.connect(self.holiday_patients_failed)
        self.holiday_load_worker.finished.connect(lambda: self.load_holiday_button.setEnabled(True))
        self.holiday_load_worker.start()

    def holiday_patients_loaded(self, patients: list[dict[str, Any]]) -> None:
        self.holiday_patients = [self.normalize_holiday_patient(patient) for patient in patients]
        self.render_holiday_patients()
        self.statusBar().showMessage(f"Loaded {len(self.holiday_patients)} campaign patients.", 4000)

    def holiday_patients_failed(self, message: str) -> None:
        QMessageBox.critical(self, "Holiday/Birthday load error", message)

    def update_holiday_campaign_controls(self) -> None:
        if not hasattr(self, "holiday_campaign_type"):
            return
        campaign_type = str(self.holiday_campaign_type.currentData() or "holiday")
        is_birthday = campaign_type == "birthday"
        self.holiday_event.setEnabled(not is_birthday)
        if hasattr(self, "add_holiday_event_button"):
            self.add_holiday_event_button.setEnabled(not is_birthday)
        if hasattr(self, "edit_holiday_event_button"):
            self.edit_holiday_event_button.setEnabled(not is_birthday and self.holiday_event.count() > 0)
        if hasattr(self, "delete_holiday_event_button"):
            self.delete_holiday_event_button.setEnabled(not is_birthday and self.holiday_event.count() > 0)
        if hasattr(self, "holiday_birthday_date"):
            self.holiday_birthday_date.setEnabled(True)
        if hasattr(self, "holiday_date_label"):
            self.holiday_date_label.setText("Birthday date" if is_birthday else "Send date")
        if hasattr(self, "holiday_search"):
            self.holiday_search.setPlaceholderText(
                "Optional patient filter after birthday load..."
                if is_birthday
                else "Patient, phone, email, patient #..."
            )

    def refresh_holiday_event_combo(self, selected_event: str | None = None) -> None:
        if not hasattr(self, "holiday_event"):
            return
        current = selected_event or str(self.holiday_event.currentData() or self.holiday_event.currentText() or "")
        self.config.holiday_events = self.unique_holiday_events(self.config.holiday_events or list(HOLIDAY_EVENTS))
        self.holiday_event.blockSignals(True)
        self.holiday_event.clear()
        for event in self.config.holiday_events:
            self.holiday_event.addItem(event, event)
        index = self.holiday_event.findData(current)
        if index < 0:
            index = 0
        self.holiday_event.setCurrentIndex(index if self.holiday_event.count() else -1)
        self.holiday_event.blockSignals(False)
        self.update_holiday_campaign_controls()

    def current_holiday_event(self) -> str:
        if not hasattr(self, "holiday_event"):
            return ""
        return str(self.holiday_event.currentData() or self.holiday_event.currentText() or "").strip()

    def add_holiday_event(self) -> None:
        name, ok = QInputDialog.getText(self, "Add holiday", "Holiday name:")
        if not ok:
            return
        name = name.strip()
        if not name:
            return
        if name.lower() in {event.lower() for event in self.config.holiday_events}:
            QMessageBox.information(self, "Holiday exists", "That holiday is already in the list.")
            return
        self.config.holiday_events.append(name)
        try:
            self.save_holiday_events_to_bridge()
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "Failed to save holiday", str(exc))
            return
        self.refresh_holiday_event_combo(name)
        QMessageBox.information(self, "Holiday added", f"{name} was added.")

    def edit_holiday_event(self) -> None:
        old_name = self.current_holiday_event()
        if not old_name:
            QMessageBox.information(self, "No holiday", "Please choose a holiday to edit.")
            return
        new_name, ok = QInputDialog.getText(self, "Edit holiday", "Holiday name:", text=old_name)
        if not ok:
            return
        new_name = new_name.strip()
        if not new_name:
            return
        if new_name.lower() != old_name.lower() and new_name.lower() in {event.lower() for event in self.config.holiday_events}:
            QMessageBox.information(self, "Holiday exists", "That holiday is already in the list.")
            return
        self.config.holiday_events = [
            new_name if event == old_name else event
            for event in self.config.holiday_events
        ]
        try:
            self.save_holiday_events_to_bridge()
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "Failed to save holiday", str(exc))
            return
        self.refresh_holiday_event_combo(new_name)
        self.holiday_patients = [self.normalize_holiday_patient(patient) for patient in self.holiday_patients]
        self.render_holiday_patients()
        QMessageBox.information(self, "Holiday saved", f"{old_name} was updated to {new_name}.")

    def delete_holiday_event(self) -> None:
        name = self.current_holiday_event()
        if not name:
            QMessageBox.information(self, "No holiday", "Please choose a holiday to delete.")
            return
        confirm = QMessageBox.question(self, "Delete holiday?", f"Delete {name} from the holiday list?")
        if confirm != QMessageBox.Yes:
            return
        self.config.holiday_events = [event for event in self.config.holiday_events if event != name]
        if not self.config.holiday_events:
            self.config.holiday_events = list(HOLIDAY_EVENTS)
        try:
            self.save_holiday_events_to_bridge()
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "Failed to delete holiday", str(exc))
            return
        self.refresh_holiday_event_combo()
        self.holiday_patients = [self.normalize_holiday_patient(patient) for patient in self.holiday_patients]
        self.render_holiday_patients()
        QMessageBox.information(self, "Holiday deleted", f"{name} was deleted.")

    def render_recall_patients(self) -> None:
        self.recall_template_combos = {}
        query = self.recall_search.text().strip().lower() if hasattr(self, "recall_search") else ""
        filtered_rows = [row for row in self.recall_patients if self.patient_matches_query(row, query, ("LastProcDate", "ProcedureCodes", "RecallSentCount", "LastRecallSentAt"))]
        visible_rows, filtered_rows = self.lazy_rows_for_table("recall", filtered_rows, query)
        self.recall_table.setUpdatesEnabled(False)
        self.recall_table.setRowCount(len(visible_rows))
        self.recall_table.setProperty("_visible_patients", visible_rows)
        self.recall_table.setProperty("_filtered_patients", filtered_rows)
        for row_index, row in enumerate(visible_rows):
            values = [
                display_date(row.get("LastProcDate")),
                patient_name(row),
                row.get("Phone", ""),
                row.get("Email", ""),
                row.get("Language", ""),
                row.get("ProcedureCodes", ""),
                row.get("RecallSentCount", 0),
                row.get("LastRecallSentAt", ""),
                row.get("PatNum", ""),
                "",
                "",
            ]
            for col, value in enumerate(values):
                if col == 9:
                    combo = QComboBox()
                    self.populate_recall_template_combo(combo, row.get("_TemplateKey") or recall_template_key_for_language(self.config, row.get("Language")))
                    self.recall_table.setCellWidget(row_index, col, combo)
                    self.recall_template_combos[row_index] = combo
                    continue
                if col == 10:
                    self.recall_table.setCellWidget(row_index, col, self.make_open_dental_view_button(row))
                    continue
                item = QTableWidgetItem(str(value or ""))
                if col in {6, 8}:
                    item.setTextAlignment(Qt.AlignCenter)
                if int(row.get("RecallSentCount") or 0) >= 2:
                    item.setForeground(QColor("#9aa3ad"))
                self.recall_table.setItem(row_index, col, item)
        self.recall_table.setUpdatesEnabled(True)
        QTimer.singleShot(0, lambda: self.fill_table_width(self.recall_table, "recall/patient_column_widths"))

    def render_treatment_patients(self) -> None:
        self.treatment_template_combos = {}
        query = self.treatment_search.text().strip().lower() if hasattr(self, "treatment_search") else ""
        filtered_rows = [
            row for row in self.treatment_patients
            if self.patient_matches_query(row, query, ("LastPendingProcDate", "LastProcDate", "ProcedureCodes", "ProcedureDescriptions", "TreatmentSentCount", "LastTreatmentSentAt"))
        ]
        visible_rows, filtered_rows = self.lazy_rows_for_table("treatment", filtered_rows, query)
        self.treatment_table.setUpdatesEnabled(False)
        self.treatment_table.setRowCount(len(visible_rows))
        self.treatment_table.setProperty("_visible_patients", visible_rows)
        self.treatment_table.setProperty("_filtered_patients", filtered_rows)
        for row_index, row in enumerate(visible_rows):
            values = [
                display_date(row.get("LastPendingProcDate") or row.get("LastProcDate")),
                patient_name(row),
                row.get("Phone", ""),
                row.get("Email", ""),
                row.get("Language", ""),
                row.get("ProcedureCodes", ""),
                row.get("TreatmentSentCount", 0),
                row.get("LastTreatmentSentAt", ""),
                row.get("PatNum", ""),
                "",
                "",
            ]
            for col, value in enumerate(values):
                if col == 9:
                    combo = QComboBox()
                    self.populate_treatment_template_combo(combo, row.get("_TemplateKey") or treatment_template_key_for_language(self.config, row.get("Language")))
                    self.treatment_table.setCellWidget(row_index, col, combo)
                    self.treatment_template_combos[row_index] = combo
                    continue
                if col == 10:
                    self.treatment_table.setCellWidget(row_index, col, self.make_open_dental_view_button(row))
                    continue
                item = QTableWidgetItem(str(value or ""))
                if col in {6, 8}:
                    item.setTextAlignment(Qt.AlignCenter)
                self.treatment_table.setItem(row_index, col, item)
        self.treatment_table.setUpdatesEnabled(True)
        QTimer.singleShot(0, lambda: self.fill_table_width(self.treatment_table, "treatment/patient_column_widths"))

    def render_review_patients(self) -> None:
        self.review_template_combos = {}
        query = self.review_search.text().strip().lower() if hasattr(self, "review_search") else ""
        filtered_rows = [row for row in self.review_patients if self.patient_matches_query(row, query, ("LastAppointment", "DateTimeLastAppt"))]
        visible_rows, filtered_rows = self.lazy_rows_for_table("review_google", filtered_rows, query)
        self.review_table.setUpdatesEnabled(False)
        self.review_table.setRowCount(len(visible_rows))
        self.review_table.setProperty("_visible_patients", visible_rows)
        self.review_table.setProperty("_filtered_patients", filtered_rows)
        for row_index, row in enumerate(visible_rows):
            values = [
                patient_name(row),
                row.get("Phone", ""),
                row.get("Email", ""),
                row.get("Language", ""),
                display_date(row.get("LastAppointment") or row.get("DateTimeLastAppt")),
                row.get("PatNum", ""),
                "",
                "",
            ]
            for col, value in enumerate(values):
                if col == 6:
                    combo = QComboBox()
                    self.populate_review_template_combo(combo, row.get("_TemplateKey") or review_template_key_for_language(self.config, row.get("Language")))
                    self.review_table.setCellWidget(row_index, col, combo)
                    self.review_template_combos[row_index] = combo
                    continue
                if col == 7:
                    self.review_table.setCellWidget(row_index, col, self.make_open_dental_view_button(row))
                    continue
                item = QTableWidgetItem(str(value or ""))
                if col == 5:
                    item.setTextAlignment(Qt.AlignCenter)
                self.review_table.setItem(row_index, col, item)
        self.review_table.setUpdatesEnabled(True)
        QTimer.singleShot(0, lambda: self.fill_table_width(self.review_table, "review_google/patient_column_widths"))

    def render_holiday_patients(self) -> None:
        self.holiday_template_combos = {}
        query = self.holiday_search.text().strip().lower() if hasattr(self, "holiday_search") else ""
        filtered_rows: list[dict[str, Any]] = []
        for row in self.holiday_patients:
            haystack = " ".join(
                str(value or "")
                for value in (
                    patient_name(row),
                    row.get("Phone"),
                    row.get("Email"),
                    row.get("Language"),
                    row.get("Birthdate"),
                    row.get("PatNum"),
                    row.get("_CampaignName"),
                )
            ).lower()
            if query and query not in haystack:
                continue
            filtered_rows.append(row)

        visible_rows, filtered_rows = self.lazy_rows_for_table("holiday_birthday", filtered_rows, query)
        self.holiday_table.setUpdatesEnabled(False)
        self.holiday_table.setRowCount(len(visible_rows))
        self.holiday_table.setProperty("_visible_patients", visible_rows)
        self.holiday_table.setProperty("_filtered_patients", filtered_rows)
        for row_index, row in enumerate(visible_rows):
            values = [
                patient_name(row),
                row.get("Phone", ""),
                row.get("Email", ""),
                row.get("Language", ""),
                display_date(row.get("Birthdate")),
                row.get("PatNum", ""),
                row.get("_CampaignName", ""),
                "",
                row.get("_CampaignStatus", ""),
                "",
            ]
            for col, value in enumerate(values):
                if col == 7:
                    combo = QComboBox()
                    self.populate_holiday_template_combo(
                        combo,
                        row.get("_TemplateKey") or holiday_template_key_for_language(
                            self.config,
                            row.get("Language"),
                            row.get("_CampaignType") or "holiday",
                        ),
                    )
                    self.holiday_table.setCellWidget(row_index, col, combo)
                    self.holiday_template_combos[row_index] = combo
                    continue
                if col == 9:
                    self.holiday_table.setCellWidget(row_index, col, self.make_open_dental_view_button(row))
                    continue
                item = QTableWidgetItem(str(value or ""))
                if col in {5, 8}:
                    item.setTextAlignment(Qt.AlignCenter)
                self.holiday_table.setItem(row_index, col, item)
        self.holiday_table.setUpdatesEnabled(True)
        QTimer.singleShot(0, lambda: self.fill_table_width(self.holiday_table, "holiday_birthday/patient_column_widths"))

    def holiday_visible_patients(self) -> list[dict[str, Any]]:
        return list(self.holiday_table.property("_visible_patients") or [])

    def campaign_recipient_key(self, row: dict[str, Any]) -> tuple[str, str, str, str, str, str]:
        phones = [
            digits_only(target.get("phone", ""))
            for target in row.get("PhoneTargets", [])
            if digits_only(target.get("phone", ""))
        ]
        if not phones and digits_only(row.get("Phone", "")):
            phones = [digits_only(row.get("Phone", ""))]
        phone_key = ",".join(sorted(set(phones)))
        return (
            str(row.get("_CampaignType") or "").strip().lower(),
            str(row.get("_CampaignName") or row.get("_HolidayName") or "").strip().lower(),
            str(row.get("PatNum") or row.get("PatientNumber") or "").strip(),
            phone_key,
            str(row.get("Birthdate") or row.get("DOB") or "").strip(),
            patient_name(row).strip().lower(),
        )

    def patient_matches_query(self, row: dict[str, Any], query: str, extra_fields: tuple[str, ...] = ()) -> bool:
        if not query:
            return True
        values = [
            patient_name(row),
            row.get("Phone"),
            row.get("WirelessPhone"),
            row.get("WkPhone"),
            row.get("HmPhone"),
            row.get("Email"),
            row.get("Language"),
            row.get("Birthdate"),
            row.get("PatNum"),
            row.get("Gender"),
            row.get("_CampaignName"),
            row.get("_TemplateKey"),
        ]
        values.extend(row.get(field) for field in extra_fields)
        haystack = " ".join(str(value or "") for value in values).lower()
        return query in haystack

    def make_open_dental_view_button(self, row: dict[str, Any]) -> QPushButton:
        button = QPushButton("View")
        button.setObjectName("SmallActionButton")
        button.clicked.connect(lambda _checked=False, patient=dict(row), view_button=button: self.view_patient_in_open_dental(patient, view_button))
        return button

    def view_patient_in_open_dental(self, row: dict[str, Any], button: QPushButton | None = None) -> None:
        if self.view_worker and self.view_worker.isRunning():
            QMessageBox.information(self, "Open Dental view is running", "Please wait for the current Open Dental lookup to finish.")
            return
        first_name = str(row.get("FName") or "").strip()
        last_name = str(row.get("LName") or "").strip()
        if not first_name or not last_name:
            full_name = str(row.get("PatientName") or row.get("Name") or patient_name(row)).strip()
            parts = full_name.split(" ", 1)
            if not first_name and parts and not parts[0].startswith("Patient #"):
                first_name = parts[0]
            if not last_name and len(parts) > 1:
                last_name = parts[1]
        birthdate = str(row.get("Birthdate") or row.get("DOB") or "").strip()
        pat_num = str(row.get("PatNum") or row.get("PatientNumber") or "").strip()
        if not first_name or not last_name or not birthdate:
            QMessageBox.warning(
                self,
                "Missing patient info",
                "This row needs first name, last name, and date of birth before it can be opened in Open Dental.",
            )
            return
        if button:
            button.setEnabled(False)
            button.setText("Opening...")
            self.active_view_button = button

        worker = OpenDentalViewWorker(first_name, last_name, birthdate, pat_num)
        self.view_worker = worker
        self.statusBar().showMessage(f"Opening Open Dental patient lookup for {first_name} {last_name}...")

        def on_success(patient: str) -> None:
            self.append_activity(f"Opened Open Dental patient lookup for {patient}.")
            self.statusBar().showMessage(f"Opened Open Dental patient lookup for {patient}.", 5000)

        def on_failed(message: str) -> None:
            self.append_activity(f"Open Dental view failed for {message}")
            QMessageBox.warning(self, "Open Dental view failed", message)

        def on_finished() -> None:
            if self.active_view_button:
                self.active_view_button.setText("View")
                self.active_view_button.setEnabled(True)
            self.active_view_button = None
            self.view_worker = None

        worker.succeeded.connect(on_success)
        worker.failed.connect(on_failed)
        worker.finished.connect(on_finished)
        worker.start()

    def recall_visible_patients(self) -> list[dict[str, Any]]:
        return list(self.recall_table.property("_visible_patients") or [])

    def treatment_visible_patients(self) -> list[dict[str, Any]]:
        return list(self.treatment_table.property("_visible_patients") or [])

    def review_visible_patients(self) -> list[dict[str, Any]]:
        return list(self.review_table.property("_visible_patients") or [])

    def selected_recall_patients(self) -> list[dict[str, Any]]:
        rows = sorted({index.row() for index in self.recall_table.selectedIndexes()})
        visible = self.recall_visible_patients()
        selected: list[dict[str, Any]] = []
        for row in rows:
            if row < 0 or row >= len(visible):
                continue
            patient = dict(visible[row])
            combo = self.recall_template_combos.get(row)
            key = str(combo.currentData() or patient.get("_TemplateKey") or "US") if combo else str(patient.get("_TemplateKey") or "US")
            patient["_TemplateKey"] = key
            patient["_TemplateText"] = self.config.recall_templates.get(key) or ""
            patient["_TemplateCountry"] = str(self.config.recall_template_countries.get(key) or infer_template_country(key)).upper()
            selected.append(patient)
        return selected

    def selected_treatment_patients(self) -> list[dict[str, Any]]:
        rows = sorted({index.row() for index in self.treatment_table.selectedIndexes()})
        current_row = self.treatment_table.currentRow()
        if current_row >= 0:
            rows.append(current_row)
        visible = self.treatment_visible_patients()
        selected: list[dict[str, Any]] = []
        for row in sorted(set(rows)):
            if row < 0 or row >= len(visible):
                continue
            patient = dict(visible[row])
            combo = self.treatment_template_combos.get(row)
            key = str(combo.currentData() or patient.get("_TemplateKey") or "US") if combo else str(patient.get("_TemplateKey") or "US")
            patient["_TemplateKey"] = key
            patient["_TemplateText"] = self.config.treatment_templates.get(key) or ""
            patient["_TemplateCountry"] = str(self.config.treatment_template_countries.get(key) or infer_template_country(key)).upper()
            patient["_Treatment"] = True
            selected.append(patient)
        return selected

    def selected_review_patients(self) -> list[dict[str, Any]]:
        rows = sorted({index.row() for index in self.review_table.selectedIndexes()})
        visible = self.review_visible_patients()
        selected: list[dict[str, Any]] = []
        for row in rows:
            if row < 0 or row >= len(visible):
                continue
            patient = dict(visible[row])
            combo = self.review_template_combos.get(row)
            key = str(combo.currentData() or patient.get("_TemplateKey") or "US") if combo else str(patient.get("_TemplateKey") or "US")
            patient["_TemplateKey"] = key
            patient["_TemplateText"] = self.config.review_templates.get(key) or ""
            patient["_TemplateCountry"] = str(self.config.review_template_countries.get(key) or infer_template_country(key)).upper()
            selected.append(patient)
        return selected

    def selected_holiday_patients(self) -> list[dict[str, Any]]:
        rows = {index.row() for index in self.holiday_table.selectedIndexes()}
        current_row = self.holiday_table.currentRow()
        if not rows and current_row >= 0:
            rows.add(current_row)
        visible = self.holiday_visible_patients()
        selected: list[dict[str, Any]] = []
        for row_index in sorted(rows):
            if row_index < 0 or row_index >= len(visible):
                continue
            patient = dict(visible[row_index])
            for col, key in (
                (0, "_PatientName"),
                (1, "Phone"),
                (2, "Email"),
                (3, "Language"),
                (4, "Birthdate"),
                (5, "PatNum"),
                (6, "_CampaignName"),
                (8, "_CampaignStatus"),
            ):
                item = self.holiday_table.item(row_index, col)
                if item:
                    patient[key] = item.text().strip()
            name_parts = str(patient.pop("_PatientName", "")).strip().split(" ", 1)
            if name_parts and name_parts[0]:
                patient["FName"] = name_parts[0]
            if len(name_parts) > 1:
                patient["LName"] = name_parts[1]
            combo = self.holiday_template_combos.get(row_index)
            campaign_type = str(patient.get("_CampaignType") or self.holiday_campaign_type.currentData() or "holiday")
            key = (
                str(combo.currentData() or patient.get("_TemplateKey") or "")
                if combo
                else str(patient.get("_TemplateKey") or "")
            )
            if not key:
                key = holiday_template_key_for_language(self.config, patient.get("Language"), campaign_type)
            patient["_TemplateKey"] = key
            patient["_TemplateText"] = self.config.holiday_templates.get(key) or ""
            patient["_TemplateCountry"] = str(self.config.holiday_template_countries.get(key) or infer_template_country(key)).upper()
            patient["_CampaignType"] = campaign_type
            patient["_HolidayName"] = patient.get("_CampaignName") or patient.get("_HolidayName") or ""
            existing_targets = [
                {"source": target.get("source") or "Phone", "phone": target.get("phone", ""), "status": ""}
                for target in patient.get("PhoneTargets", [])
                if digits_only(target.get("phone", ""))
            ]
            phone_text = str(patient.get("Phone") or "")
            if existing_targets and ("|" in phone_text or self.phone_targets_display(existing_targets) == phone_text):
                patient["PhoneTargets"] = existing_targets
            else:
                phone = format_us_phone(phone_text)
                patient["PhoneTargets"] = [{"source": "Phone", "phone": phone, "status": ""}] if digits_only(phone) else []
            selected.append(patient)
        return selected

    def add_custom_holiday_patient(self) -> None:
        dialog = QDialog(self)
        dialog.setWindowTitle("Add custom campaign patient")
        dialog.resize(520, 420)
        layout = QVBoxLayout(dialog)
        form_card = self.card()
        form = QFormLayout(form_card)
        first_name = QLineEdit()
        last_name = QLineEdit()
        phone = QLineEdit()
        email = QLineEdit()
        language = QComboBox()
        language.addItems(["English", "Spanish", "Vietnamese"])
        birthdate = QLineEdit()
        birthdate.setPlaceholderText("YYYY-MM-DD or MM/DD/YYYY")
        pat_num = QLineEdit()
        form.addRow("First name", first_name)
        form.addRow("Last name", last_name)
        form.addRow("Phone", phone)
        form.addRow("Email", email)
        form.addRow("Language", language)
        form.addRow("Birthdate", birthdate)
        form.addRow("Pat #", pat_num)
        layout.addWidget(form_card)
        actions = QHBoxLayout()
        cancel = QPushButton("Cancel")
        add = QPushButton("Add patient")
        add.setObjectName("PrimaryButton")
        cancel.clicked.connect(dialog.reject)
        add.clicked.connect(dialog.accept)
        actions.addStretch()
        actions.addWidget(cancel)
        actions.addWidget(add)
        layout.addLayout(actions)
        if dialog.exec() != QDialog.Accepted:
            return
        if not digits_only(phone.text()):
            QMessageBox.warning(self, "Missing phone", "Please enter a valid phone number for this custom patient.")
            return
        row = {
            "FName": first_name.text().strip(),
            "LName": last_name.text().strip(),
            "Phone": format_us_phone(phone.text()),
            "PhoneTargets": [{"source": "Phone", "phone": format_us_phone(phone.text()), "status": ""}],
            "Email": email.text().strip(),
            "Language": language.currentText(),
            "Birthdate": birthdate.text().strip(),
            "PatNum": pat_num.text().strip() or 0,
        }
        self.holiday_patients.append(self.normalize_holiday_patient(row))
        self.render_holiday_patients()

    def holiday_campaign_recipients_from_visible_rows(self) -> list[dict[str, Any]]:
        self.holiday_table.clearSelection()
        for row in range(self.holiday_table.rowCount()):
            self.holiday_table.selectRow(row)
        recipients = self.selected_holiday_patients()
        self.holiday_table.clearSelection()
        safe_recipients: list[dict[str, Any]] = []
        for patient in recipients:
            safe_recipients.append({
                "PatNum": patient.get("PatNum") or 0,
                "FName": patient.get("FName") or "",
                "LName": patient.get("LName") or "",
                "Phone": patient.get("Phone") or "",
                "PhoneTargets": patient.get("PhoneTargets") or [],
                "Email": patient.get("Email") or "",
                "Language": patient.get("Language") or "",
                "Gender": patient.get("Gender") or "",
                "Birthdate": patient.get("Birthdate") or "",
                "_TemplateKey": patient.get("_TemplateKey") or "",
            })
        return safe_recipients

    def save_current_holiday_automation(self) -> None:
        recipients = self.holiday_campaign_recipients_from_visible_rows()
        if not recipients:
            QMessageBox.information(self, "No recipients", "Please load or add patients before saving automation.")
            return
        campaign_type = str(self.holiday_campaign_type.currentData() or "holiday")
        run_date = self.holiday_birthday_date.date().toPython().isoformat()
        name = (
            "Birthday"
            if campaign_type == "birthday"
            else self.current_holiday_event() or "Holiday"
        )
        confirm = QMessageBox.question(
            self,
            "Save campaign automation?",
            f"Save {len(recipients)} recipient(s) for {name} on {display_date(run_date)}?\n\n"
            "When Monitoring is running at the daily send time, this campaign will be sent automatically on that date.",
        )
        if confirm != QMessageBox.Yes:
            return
        campaign = {
            "id": f"{campaign_type}-{run_date}-{int(time.time())}",
            "type": campaign_type,
            "name": name,
            "run_date": run_date,
            "enabled": True,
            "last_sent_date": "",
            "recipients": recipients,
        }
        self.config.holiday_campaigns.append(campaign)
        try:
            self.save_holiday_campaigns_to_bridge()
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "Failed to save automation", str(exc))
            return
        self.append_activity(f"Saved campaign automation: {name} on {display_date(run_date)} ({len(recipients)} recipient(s)).")
        self.update_monitoring_status()
        QMessageBox.information(self, "Automation saved", "Campaign automation was saved. Keep Monitoring running for automatic sending.")

    def open_saved_holiday_automations(self) -> None:
        self.load_templates_from_bridge()
        dialog = QDialog(self)
        dialog.setWindowTitle("Saved Holiday & Birthday automations")
        dialog.resize(820, 520)
        layout = QVBoxLayout(dialog)
        layout.setContentsMargins(18, 16, 18, 18)
        title = QLabel("Saved campaign automations")
        title.setObjectName("HeroTitle")
        layout.addWidget(title)
        table = QTableWidget(0, 6)
        table.setHorizontalHeaderLabels(["Enabled", "Type", "Campaign", "Run date", "Recipients", "Last sent"])
        table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        table.verticalHeader().setVisible(False)
        table.setSelectionBehavior(QTableWidget.SelectRows)
        table.setSelectionMode(QTableWidget.SingleSelection)
        table.setAlternatingRowColors(True)
        layout.addWidget(table, 1)

        def render() -> None:
            table.setRowCount(len(self.config.holiday_campaigns))
            for row_index, campaign in enumerate(self.config.holiday_campaigns):
                values = [
                    "Yes" if campaign.get("enabled", True) else "No",
                    str(campaign.get("type") or ""),
                    str(campaign.get("name") or ""),
                    display_date(campaign.get("run_date") or ""),
                    str(len(campaign.get("recipients") or [])),
                    display_date(campaign.get("last_sent_date") or ""),
                ]
                for col, value in enumerate(values):
                    item = QTableWidgetItem(value)
                    if col in {0, 4}:
                        item.setTextAlignment(Qt.AlignCenter)
                    table.setItem(row_index, col, item)

        def selected_campaign_index() -> int:
            row = table.currentRow()
            return row if 0 <= row < len(self.config.holiday_campaigns) else -1

        def toggle_enabled() -> None:
            row = selected_campaign_index()
            if row < 0:
                QMessageBox.information(dialog, "No selection", "Please select one campaign.")
                return
            self.config.holiday_campaigns[row]["enabled"] = not bool(self.config.holiday_campaigns[row].get("enabled", True))
            try:
                self.save_holiday_campaigns_to_bridge()
            except Exception as exc:  # noqa: BLE001
                QMessageBox.critical(dialog, "Failed to save automation", str(exc))
                return
            self.update_monitoring_status()
            render()

        def delete_campaign() -> None:
            row = selected_campaign_index()
            if row < 0:
                QMessageBox.information(dialog, "No selection", "Please select one campaign.")
                return
            campaign = self.config.holiday_campaigns[row]
            confirm = QMessageBox.question(dialog, "Delete automation?", f"Delete automation for {campaign.get('name')}?")
            if confirm != QMessageBox.Yes:
                return
            self.config.holiday_campaigns.pop(row)
            try:
                self.save_holiday_campaigns_to_bridge()
            except Exception as exc:  # noqa: BLE001
                QMessageBox.critical(dialog, "Failed to delete automation", str(exc))
                return
            self.update_monitoring_status()
            render()

        actions = QHBoxLayout()
        toggle = QPushButton("Enable / disable")
        delete = QPushButton("Delete")
        close = QPushButton("Close")
        toggle.clicked.connect(toggle_enabled)
        delete.clicked.connect(delete_campaign)
        close.clicked.connect(dialog.accept)
        actions.addStretch()
        actions.addWidget(toggle)
        actions.addWidget(delete)
        actions.addWidget(close)
        layout.addLayout(actions)
        render()
        dialog.exec()

    def remove_selected_holiday_patients(self) -> None:
        rows = sorted({index.row() for index in self.holiday_table.selectedIndexes()}, reverse=True)
        if not rows:
            QMessageBox.information(self, "No selection", "Please select one or more campaign patients to remove.")
            return
        visible = self.holiday_visible_patients()
        remove_ids = {id(visible[row]) for row in rows if 0 <= row < len(visible)}
        self.holiday_patients = [patient for patient in self.holiday_patients if id(patient) not in remove_ids]
        self.render_holiday_patients()

    def preview_recall_selected(self) -> None:
        self.save_settings(silent=True)
        selected = self.selected_recall_patients()
        if not selected:
            QMessageBox.information(self, "No selection", "Please select one recall patient.")
            return
        patient = selected[0]
        message = render_message(self.config, patient, patient.get("_TemplateText") or "")
        QMessageBox.information(
            self,
            "Recall SMS preview",
            f"To: {patient_name(patient)}\nPhone: {patient.get('Phone', '')}\nSent count: {patient.get('RecallSentCount', 0)}\n\n{message}",
        )

    def fill_selected_recall_template(self) -> None:
        self.save_settings(silent=True)
        selected = self.selected_recall_patients()
        if not selected:
            QMessageBox.information(self, "No selection", "Please select one recall patient.")
            return
        if len(selected) != 1:
            QMessageBox.information(self, "One patient only", "Please select one patient at a time for manual recall SMS.")
            return
        patient = selected[0]
        if int(patient.get("RecallSentCount") or 0) >= 2:
            confirm = QMessageBox.question(
                self,
                "Recall already sent",
                "This patient already has 2 or more recall messages logged.\n\nContinue filling the SMS anyway?",
            )
            if confirm != QMessageBox.Yes:
                return
        targets = [
            target for target in patient.get("PhoneTargets", [])
            if digits_only(target.get("phone", ""))
        ]
        if not targets:
            QMessageBox.warning(self, "Missing phone", "This patient does not have a valid phone number.")
            return
        target = targets[0]
        if len(targets) > 1:
            options = [f"{item.get('source')}: {item.get('phone')}" for item in targets]
            chosen, ok = QInputDialog.getItem(self, "Choose phone", "Send to:", options, 0, False)
            if not ok:
                return
            index = options.index(chosen)
            target = targets[index]
        message = render_message(self.config, patient, patient.get("_TemplateText") or "")
        try:
            PhoneLinkSender(dry_run=False).compose_sms(target.get("phone", ""), message)
            self.append_activity(f"FILLED RECALL: {patient_name(patient)} {target.get('source')} -> {target.get('phone')}")
            mark_sent = QMessageBox.question(
                self,
                "Template filled",
                "The recall SMS was filled in Phone Link.\n\n"
                "After you review and click Send manually in Phone Link, mark this recall as sent?",
            )
            if mark_sent == QMessageBox.Yes:
                self.repo.log_recall_result(patient, message, "sent", phone=target.get("phone", ""))
                self.append_activity(f"MARKED SENT: {patient_name(patient)} {target.get('source')} -> {target.get('phone')}")
                self.load_recall_patients()
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "Phone Link error", str(exc))

    def preview_treatment_selected(self) -> None:
        self.save_settings(silent=True)
        selected = self.selected_treatment_patients()
        if not selected:
            QMessageBox.information(self, "No selection", "Please select one treatment patient.")
            return
        patient = selected[0]
        message = render_message(self.config, patient, patient.get("_TemplateText") or "")
        QMessageBox.information(
            self,
            "Treatment SMS preview",
            f"To: {patient_name(patient)}\nPhone: {patient.get('Phone', '')}\nProcedure date: {display_date(patient.get('LastPendingProcDate') or patient.get('LastProcDate'))}\nCodes: {patient.get('ProcedureCodes', '')}\n\n{message}",
        )

    def send_selected_treatment_sms(self) -> None:
        selected = self.selected_treatment_patients()
        if not selected:
            QMessageBox.information(self, "No selection", "Please select at least one treatment patient.")
            return
        self.start_send(selected)

    def preview_review_selected(self) -> None:
        self.save_settings(silent=True)
        selected = self.selected_review_patients()
        if not selected:
            QMessageBox.information(self, "No selection", "Please select one patient.")
            return
        patient = selected[0]
        message = render_message(self.config, patient, patient.get("_TemplateText") or "")
        QMessageBox.information(
            self,
            "Google review SMS preview",
            f"To: {patient_name(patient)}\nPhone: {patient.get('Phone', '')}\n\n{message}",
        )

    def fill_selected_review_template(self) -> None:
        self.save_settings(silent=True)
        selected = self.selected_review_patients()
        if not selected:
            QMessageBox.information(self, "No selection", "Please select one patient.")
            return
        if len(selected) != 1:
            QMessageBox.information(self, "One patient only", "Please select one patient at a time for manual Google review SMS.")
            return
        patient = selected[0]
        targets = [
            target for target in patient.get("PhoneTargets", [])
            if digits_only(target.get("phone", ""))
        ]
        if not targets:
            QMessageBox.warning(self, "Missing phone", "This patient does not have a valid phone number.")
            return
        target = targets[0]
        if len(targets) > 1:
            options = [f"{item.get('source')}: {item.get('phone')}" for item in targets]
            chosen, ok = QInputDialog.getItem(self, "Choose phone", "Fill to:", options, 0, False)
            if not ok:
                return
            target = targets[options.index(chosen)]
        message = render_message(self.config, patient, patient.get("_TemplateText") or "")
        if not message.strip():
            QMessageBox.warning(self, "Missing template", "Please choose a Google review template first.")
            return
        try:
            PhoneLinkSender(dry_run=False).compose_sms(target.get("phone", ""), message)
            self.append_activity(f"FILLED REVIEW: {patient_name(patient)} {target.get('source')} -> {target.get('phone')}")
            QMessageBox.information(
                self,
                "Template filled",
                "The Google review SMS was filled in Phone Link.\n\nPlease review it and click Send manually.",
            )
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "Phone Link error", str(exc))

    def preview_holiday_selected(self) -> None:
        self.save_settings(silent=True)
        selected = self.selected_holiday_patients()
        if not selected:
            QMessageBox.information(self, "No selection", "Please select one campaign patient.")
            return
        patient = selected[0]
        message = render_message(self.config, patient, patient.get("_TemplateText") or "")
        QMessageBox.information(
            self,
            "Holiday & Birthday SMS preview",
            f"To: {patient_name(patient)}\nPhone: {patient.get('Phone', '')}\nCampaign: {patient.get('_CampaignName', '')}\n\n{message}",
        )

    def send_selected_holiday_sms(self) -> None:
        selected = self.selected_holiday_patients()
        if not selected:
            QMessageBox.information(self, "No selection", "Please select at least one campaign patient.")
            return
        self.start_holiday_send(selected)

    def send_all_holiday_sms(self) -> None:
        filtered = list(self.holiday_table.property("_filtered_patients") or self.holiday_visible_patients())
        if not filtered:
            QMessageBox.information(self, "Nothing to send", "There are no patients in the Holiday & Birthday list.")
            return
        state = self.lazy_table_state.setdefault("holiday_birthday", {"query": "", "limit": LAZY_TABLE_BATCH_SIZE})
        if int(state.get("limit") or LAZY_TABLE_BATCH_SIZE) < len(filtered):
            state["limit"] = len(filtered)
            self.render_holiday_patients()
        rows_to_select = []
        self.holiday_table.clearSelection()
        for row in range(self.holiday_table.rowCount()):
            rows_to_select.append(row)
            self.holiday_table.selectRow(row)
        selected = self.selected_holiday_patients()
        self.holiday_table.clearSelection()
        if not selected:
            QMessageBox.information(self, "Nothing to send", "There are no valid campaign recipients.")
            return
        self.start_holiday_send(selected)

    def render_appointments(self) -> None:
        self.row_template_combos = {}
        self.appointment_table.setRowCount(len(self.appointments))
        sent_count = 0
        missing_phone_count = 0
        for row_index, row in enumerate(self.appointments):
            reminder = row.get("ReminderStatus") or "not sent"
            if reminder in {"sent", "dry-run"}:
                sent_count += 1
            if not digits_only(row.get("Phone", "")):
                missing_phone_count += 1
            values = [
                status_label(row.get("AptStatus")),
                display_time(row.get("AptDateTime")),
                patient_name(row),
                row.get("Phone", ""),
                row.get("Email", ""),
                row.get("AptNum", ""),
                row.get("PatNum", ""),
                reminder,
                row.get("ReminderSentCount", 0),
                row.get("ReminderLastSentAt", ""),
                "",
                "",
            ]
            for col, value in enumerate(values):
                if col == 10:
                    combo = QComboBox()
                    self.populate_template_combo(combo, template_key_for_language(self.config, row.get("Language")))
                    self.appointment_table.setCellWidget(row_index, col, combo)
                    self.row_template_combos[row_index] = combo
                    continue
                if col == 11:
                    self.appointment_table.setCellWidget(row_index, col, self.make_open_dental_view_button(row))
                    continue
                item = QTableWidgetItem(str(value or ""))
                if col in {5, 6, 8}:
                    item.setTextAlignment(Qt.AlignCenter)
                if reminder in {"sent", "dry-run"}:
                    item.setForeground(QColor("#7a8794"))
                elif not digits_only(row.get("Phone", "")):
                    item.setForeground(QColor("#b42318"))
                self.appointment_table.setItem(row_index, col, item)
        pending_count = max(0, len(self.appointments) - sent_count)
        self.total_stat.setText(str(len(self.appointments)))
        self.pending_stat.setText(str(pending_count))
        self.sent_stat.setText(str(sent_count))
        self.missing_phone_stat.setText(str(missing_phone_count))
        self.apply_appointment_filter()
        QTimer.singleShot(0, lambda: self.fill_table_width(self.appointment_table, "dashboard/appointment_column_widths"))

    def populate_template_combo(self, combo: QComboBox, selected_key: str | None = None) -> None:
        combo.blockSignals(True)
        combo.clear()
        combo.setObjectName("TemplateCombo")
        combo.setFixedHeight(34)
        combo.setMinimumWidth(168)
        combo.setIconSize(QSize(30, 20))
        combo.setToolTip("Choose SMS template")
        for key in sorted(self.config.sms_templates):
            combo.addItem(template_icon(template_country(self.config, key)), template_label(key), key)
            combo.setItemData(combo.count() - 1, template_label(key), Qt.ToolTipRole)
        selected = selected_key or self.config.default_template_key
        index = combo.findData(selected)
        if index < 0:
            index = combo.findData(self.config.default_template_key)
        combo.setCurrentIndex(index if index >= 0 else 0)
        combo.blockSignals(False)

    def populate_recall_template_combo(self, combo: QComboBox, selected_key: str | None = None) -> None:
        combo.blockSignals(True)
        combo.clear()
        combo.setObjectName("TemplateCombo")
        combo.setFixedHeight(34)
        combo.setMinimumWidth(168)
        combo.setIconSize(QSize(30, 20))
        combo.setToolTip("Choose recall SMS template")
        for key in sorted(self.config.recall_templates):
            country = str(self.config.recall_template_countries.get(key) or infer_template_country(key)).upper()
            combo.addItem(template_icon(country), template_label(key), key)
            combo.setItemData(combo.count() - 1, template_label(key), Qt.ToolTipRole)
        selected = selected_key or "US"
        index = combo.findData(selected)
        if index < 0:
            index = combo.findData("US")
        combo.setCurrentIndex(index if index >= 0 else 0)
        combo.blockSignals(False)

    def populate_treatment_template_combo(self, combo: QComboBox, selected_key: str | None = None) -> None:
        combo.blockSignals(True)
        combo.clear()
        combo.setObjectName("TemplateCombo")
        combo.setFixedHeight(34)
        combo.setMinimumWidth(168)
        combo.setIconSize(QSize(30, 20))
        combo.setToolTip("Choose treatment SMS template")
        for key in sorted(self.config.treatment_templates):
            country = str(self.config.treatment_template_countries.get(key) or infer_template_country(key)).upper()
            combo.addItem(template_icon(country), template_label(key), key)
            combo.setItemData(combo.count() - 1, template_label(key), Qt.ToolTipRole)
        selected = selected_key or "US"
        index = combo.findData(selected)
        if index < 0:
            index = combo.findData("US")
        combo.setCurrentIndex(index if index >= 0 else 0)
        combo.blockSignals(False)

    def populate_review_template_combo(self, combo: QComboBox, selected_key: str | None = None) -> None:
        combo.blockSignals(True)
        combo.clear()
        combo.setObjectName("TemplateCombo")
        combo.setFixedHeight(34)
        combo.setMinimumWidth(168)
        combo.setIconSize(QSize(30, 20))
        combo.setToolTip("Choose Google review SMS template")
        for key in sorted(self.config.review_templates):
            country = str(self.config.review_template_countries.get(key) or infer_template_country(key)).upper()
            combo.addItem(template_icon(country), template_label(key), key)
            combo.setItemData(combo.count() - 1, template_label(key), Qt.ToolTipRole)
        selected = selected_key or "US"
        index = combo.findData(selected)
        if index < 0:
            index = combo.findData("US")
        combo.setCurrentIndex(index if index >= 0 else 0)
        combo.blockSignals(False)

    def populate_holiday_template_combo(self, combo: QComboBox, selected_key: str | None = None) -> None:
        combo.blockSignals(True)
        combo.clear()
        combo.setObjectName("TemplateCombo")
        combo.setFixedHeight(34)
        combo.setMinimumWidth(178)
        combo.setIconSize(QSize(30, 20))
        combo.setToolTip("Choose Holiday & Birthday SMS template")
        for key in sorted(self.config.holiday_templates):
            country = str(self.config.holiday_template_countries.get(key) or infer_template_country(key)).upper()
            combo.addItem(template_icon(country), template_label(key), key)
            combo.setItemData(combo.count() - 1, template_label(key), Qt.ToolTipRole)
        selected = selected_key or "US_HOLIDAY"
        index = combo.findData(selected)
        if index < 0:
            index = combo.findData("US_HOLIDAY")
        combo.setCurrentIndex(index if index >= 0 else 0)
        combo.blockSignals(False)

    def refresh_table_template_combos(self) -> None:
        for combo in self.row_template_combos.values():
            current = str(combo.currentData() or self.config.default_template_key)
            self.populate_template_combo(combo, current)
        for combo in getattr(self, "recall_template_combos", {}).values():
            current = str(combo.currentData() or "US")
            self.populate_recall_template_combo(combo, current)
        for combo in getattr(self, "treatment_template_combos", {}).values():
            current = str(combo.currentData() or "US")
            self.populate_treatment_template_combo(combo, current)
        for combo in getattr(self, "review_template_combos", {}).values():
            current = str(combo.currentData() or "US")
            self.populate_review_template_combo(combo, current)
        for combo in getattr(self, "holiday_template_combos", {}).values():
            current = str(combo.currentData() or "US_HOLIDAY")
            self.populate_holiday_template_combo(combo, current)

    def appointment_with_template(self, row_index: int) -> dict[str, Any]:
        appointment = dict(self.appointments[row_index])
        combo = self.row_template_combos.get(row_index)
        key = str(combo.currentData() or self.config.default_template_key) if combo else self.config.default_template_key
        appointment["_TemplateKey"] = key
        appointment["_TemplateText"] = self.config.sms_templates.get(key) or default_template(self.config)
        appointment["_TemplateCountry"] = template_country(self.config, key)
        return appointment

    def apply_appointment_filter(self) -> None:
        if not hasattr(self, "appointment_table"):
            return
        query = self.search_edit.text().strip().lower() if hasattr(self, "search_edit") else ""
        for row_index, appointment in enumerate(self.appointments):
            haystack = " ".join(
                str(value or "")
                for value in (
                    status_label(appointment.get("AptStatus")),
                    display_time(appointment.get("AptDateTime")),
                    patient_name(appointment),
                    appointment.get("Phone"),
                    appointment.get("PhoneSource"),
                    appointment.get("Email"),
                    appointment.get("Language"),
                    appointment.get("AptNum"),
                    appointment.get("PatNum"),
                    appointment.get("ReminderStatus") or "not sent",
                    appointment.get("ReminderSentCount"),
                    appointment.get("ReminderLastSentAt"),
                    self.config.default_template_key,
                )
            ).lower()
            self.appointment_table.setRowHidden(row_index, bool(query and query not in haystack))

    def selected_appointments(self) -> list[dict[str, Any]]:
        rows = {index.row() for index in self.appointment_table.selectedIndexes()}
        current_row = self.appointment_table.currentRow()
        if current_row >= 0:
            rows.add(current_row)
        focus_widget = QApplication.focusWidget()
        for row, combo in self.row_template_combos.items():
            if focus_widget is combo or (focus_widget and combo.isAncestorOf(focus_widget)):
                rows.add(row)
        rows = {row for row in rows if 0 <= row < len(self.appointments) and not self.appointment_table.isRowHidden(row)}
        return [self.appointment_with_template(row) for row in sorted(rows)]

    def send_selected(self) -> None:
        selected = self.selected_appointments()
        if not selected:
            QMessageBox.information(self, "No selection", "Please select at least one appointment.")
            return
        self.start_send(selected)

    def reset_selected_to_not_sent(self) -> None:
        selected = self.selected_appointments()
        if not selected:
            QMessageBox.information(self, "No selection", "Please select at least one appointment to reset.")
            return
        confirm = QMessageBox.question(
            self,
            "Reset selected SMS status?",
            "This will remove sent/failed SMS logs for the selected appointment row(s), so they can be sent again.\n\nContinue?",
        )
        if confirm != QMessageBox.Yes:
            return
        reset_count = 0
        try:
            for appointment in selected:
                targets = [
                    target for target in appointment.get("PhoneTargets", [])
                    if digits_only(target.get("phone", "")) and target.get("status")
                ]
                if not targets and digits_only(appointment.get("Phone", "")):
                    targets = [{"phone": appointment.get("Phone", "")}]
                for target in targets:
                    result = self.repo.reset_reminder_log(appointment, target.get("phone", ""))
                    reset_count += int(result.get("deleted") or 0)
            self.settings.remove("last_successful_schedule_run")
            self.active_schedule_key = ""
            self.append_activity(f"Reset selected SMS logs: {reset_count} row(s).")
            QMessageBox.information(self, "Reset complete", f"Reset {reset_count} SMS log row(s).")
            self.load_appointments()
        except Exception as exc:  # noqa: BLE001
            self.append_activity(f"Reset selected failed: {exc}")
            QMessageBox.critical(self, "Reset failed", str(exc))

    def preview_selected(self) -> None:
        selected = self.selected_appointments()
        if not selected:
            QMessageBox.information(self, "No selection", "Please select one appointment to preview.")
            return
        appointment = selected[0]
        message = render_message(self.config, appointment, appointment.get("_TemplateText") or default_template(self.config))
        dialog = QDialog(self)
        dialog.setWindowTitle("SMS preview and activity")
        dialog.resize(920, 680)
        dialog_layout = QVBoxLayout(dialog)
        dialog_layout.setContentsMargins(20, 18, 20, 20)
        dialog_layout.setSpacing(14)

        title = QLabel("SMS preview")
        title.setObjectName("HeroTitle")
        dialog_layout.addWidget(title)

        preview_card = self.card()
        preview_layout = QVBoxLayout(preview_card)
        preview_layout.setContentsMargins(18, 16, 18, 18)
        preview_title = QLabel(f"To: {patient_name(appointment)}  |  Phone: {appointment.get('Phone', '')}")
        preview_title.setObjectName("SectionTitle")
        preview_text = QPlainTextEdit()
        preview_text.setPlainText(message)
        preview_text.setReadOnly(True)
        preview_text.setMinimumHeight(120)
        preview_layout.addWidget(preview_title)
        preview_layout.addWidget(preview_text)
        dialog_layout.addWidget(preview_card)

        info_row = QHBoxLayout()
        default_card = self.card()
        default_layout = QVBoxLayout(default_card)
        default_layout.setContentsMargins(18, 16, 18, 18)
        default_title = QLabel("Default template")
        default_title.setObjectName("SectionTitle")
        default_text = QPlainTextEdit()
        default_text.setPlainText(default_template(self.config))
        default_text.setReadOnly(True)
        default_text.setMinimumHeight(180)
        default_layout.addWidget(default_title)
        default_layout.addWidget(default_text)

        activity_card = self.card()
        activity_layout = QVBoxLayout(activity_card)
        activity_layout.setContentsMargins(18, 16, 18, 18)
        activity_title = QLabel("Activity")
        activity_title.setObjectName("SectionTitle")
        activity_text = QPlainTextEdit()
        activity_text.setPlainText("\n".join(self.activity_messages[-200:]))
        activity_text.setReadOnly(True)
        activity_text.setMinimumHeight(180)
        activity_layout.addWidget(activity_title)
        activity_layout.addWidget(activity_text)

        info_row.addWidget(default_card)
        info_row.addWidget(activity_card)
        dialog_layout.addLayout(info_row, 1)

        close_row = QHBoxLayout()
        close_row.addStretch()
        close_button = QPushButton("Close")
        close_button.clicked.connect(dialog.accept)
        close_row.addWidget(close_button)
        dialog_layout.addLayout(close_row)
        dialog.exec()

    def open_phone_link(self) -> None:
        try:
            PhoneLinkSender.open_phone_link()
            self.append_activity("Phone Link opened. Please confirm the phone is connected before sending real SMS.")
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "Phone Link", str(exc))

    def send_test_sms_now(self) -> None:
        phone, ok = QInputDialog.getText(self, "Send test SMS", "Phone number:")
        if not ok:
            return
        phone = phone.strip()
        if not digits_only(phone):
            QMessageBox.warning(self, "Invalid phone", "Please enter a valid phone number.")
            return
        message, ok = QInputDialog.getMultiLineText(
            self,
            "Send test SMS",
            "Message:",
            f"Test message from {self.config.clinic_name}. Please ignore.",
        )
        if not ok:
            return
        message = message.strip()
        if not message:
            QMessageBox.warning(self, "Missing message", "Please enter a message.")
            return
        confirm = QMessageBox.question(
            self,
            "Send real test SMS?",
            f"This will send a real SMS through Phone Link to {phone}.\n\nContinue?",
        )
        if confirm != QMessageBox.Yes:
            return
        try:
            PhoneLinkSender(dry_run=False).send_sms(phone, message)
            self.append_activity(f"TEST SENT: {phone}")
            QMessageBox.information(self, "Test SMS", "Test SMS was sent through Phone Link.")
        except Exception as exc:  # noqa: BLE001
            self.append_activity(f"TEST FAILED: {phone} -> {exc}")
            QMessageBox.critical(self, "Test SMS failed", str(exc))

    def clear_dry_run_logs(self) -> None:
        confirm = QMessageBox.question(
            self,
            "Clear dry-run logs?",
            "This removes dry-run reminder logs from the bridge database so those appointments can be sent as real SMS.\n\nContinue?",
        )
        if confirm != QMessageBox.Yes:
            return
        try:
            result = self.repo.clear_dry_run_logs()
            reminder_count = int(result.get("reminderDryRunDeleted") or 0)
            recall_count = int(result.get("recallDryRunDeleted") or 0)
            treatment_count = int(result.get("treatmentDryRunDeleted") or 0)
            self.settings.remove("last_successful_schedule_run")
            self.settings.remove("last_successful_treatment_schedule_run")
            self.active_schedule_key = ""
            self.treatment_active_schedule_key = ""
            self.append_activity(f"Cleared dry-run logs: reminders={reminder_count}, recall={recall_count}, treatment={treatment_count}.")
            self.append_activity("Reset today's schedule marker so monitoring can run again.")
            QMessageBox.information(
                self,
                "Dry-run logs cleared",
                f"Removed {reminder_count} appointment reminder dry-run log(s), {recall_count} recall dry-run log(s), and {treatment_count} treatment dry-run log(s).",
            )
            self.load_appointments()
            if hasattr(self, "recall_table"):
                self.load_recall_patients()
            if hasattr(self, "treatment_table"):
                self.load_treatment_patients()
        except Exception as exc:  # noqa: BLE001
            self.append_activity(f"Clear dry-run failed: {exc}")
            QMessageBox.critical(self, "Clear dry-run failed", str(exc))

    def send_all_not_sent(self, silent: bool = False, confirm_real: bool = True) -> bool:
        pending = [
            self.appointment_with_template(row_index)
            for row_index, row in enumerate(self.appointments)
            if row.get("ReminderStatus") not in {"sent", "dry-run"}
        ]
        if not pending:
            if not silent:
                QMessageBox.information(self, "Nothing to send", "There are no pending reminders for this date.")
            else:
                self.append_activity("No pending reminders for this target date.")
            return False
        return self.start_send(pending, confirm_real=confirm_real, silent=silent)

    def start_send(self, appointments: list[dict[str, Any]], confirm_real: bool = True, silent: bool = False) -> bool:
        if self.worker and self.worker.isRunning():
            if not silent:
                QMessageBox.information(self, "Sending", "A send job is already running.")
            return False
        missing_phone_count = sum(
            1 for appointment in appointments
            if not any(digits_only(target.get("phone", "")) for target in appointment.get("PhoneTargets", []))
            and not digits_only(appointment.get("Phone", ""))
        )
        sms_count = sum(
            len([
                target for target in appointment.get("PhoneTargets", [])
                if digits_only(target.get("phone", "")) and target.get("status") not in {"sent", "dry-run"}
            ]) or (1 if "PhoneTargets" not in appointment and digits_only(appointment.get("Phone", "")) else 0)
            for appointment in appointments
        )
        if sms_count == 0:
            if not silent:
                detail = (
                    f"\n\nSkipped {missing_phone_count} row(s) with no valid phone number."
                    if missing_phone_count else ""
                )
                QMessageBox.information(self, "Nothing to send", "There are no pending phone numbers for this selection." + detail)
            else:
                self.append_activity("No pending phone numbers for this target date.")
                if missing_phone_count:
                    self.append_activity(f"Skipped {missing_phone_count} row(s) with no valid phone number.")
            return False
        if not self.config.dry_run and confirm_real:
            confirm = QMessageBox.question(
                self,
                "Send real SMS?",
                f"Send {sms_count} real SMS messages through Phone Link?",
            )
            if confirm != QMessageBox.Yes:
                return False
        self.save_settings()
        self.set_send_enabled(False)
        if appointments and appointments[0].get("_Treatment"):
            self.active_send_kind = "treatment"
        elif appointments and appointments[0].get("_Recall"):
            self.active_send_kind = "recall"
        else:
            self.active_send_kind = "appointments"
        self.worker = SendWorker(self.config, appointments)
        self.worker.progress.connect(self.append_activity)
        self.worker.finished.connect(self.send_finished)
        self.worker.start()
        return True

    def start_holiday_send(self, patients: list[dict[str, Any]]) -> bool:
        if self.worker and self.worker.isRunning():
            QMessageBox.information(self, "Sending", "A send job is already running.")
            return False
        missing_phone_count = sum(
            1 for patient in patients
            if not any(digits_only(target.get("phone", "")) for target in patient.get("PhoneTargets", []))
            and not digits_only(patient.get("Phone", ""))
        )
        sms_count = sum(
            len([target for target in patient.get("PhoneTargets", []) if digits_only(target.get("phone", ""))])
            or (1 if digits_only(patient.get("Phone", "")) else 0)
            for patient in patients
        )
        if sms_count == 0:
            detail = (
                f"\n\nSkipped {missing_phone_count} row(s) with no valid phone number."
                if missing_phone_count else ""
            )
            QMessageBox.information(self, "Nothing to send", "There are no valid phone numbers in this campaign selection." + detail)
            return False
        missing_templates = [patient_name(patient) for patient in patients if not str(patient.get("_TemplateText") or "").strip()]
        if missing_templates:
            QMessageBox.warning(
                self,
                "Missing template",
                "Some selected patients do not have a campaign template. Please choose a Holiday & Birthday template first.",
            )
            return False
        if not self.config.dry_run:
            confirm = QMessageBox.question(
                self,
                "Send campaign SMS?",
                f"Send {sms_count} real Holiday & Birthday SMS message(s) through Phone Link?",
            )
            if confirm != QMessageBox.Yes:
                return False
        self.save_settings(silent=True)
        self.set_send_enabled(False)
        self.active_send_kind = "campaign"
        self.active_campaign_recipient_keys = {self.campaign_recipient_key(patient) for patient in patients}
        self.worker = CampaignSendWorker(self.config, patients)
        self.worker.progress.connect(self.append_activity)
        self.worker.finished.connect(self.send_finished)
        self.worker.start()
        return True

    def set_send_enabled(self, enabled: bool) -> None:
        self.send_selected_button.setEnabled(enabled)
        self.send_all_button.setEnabled(enabled)
        self.preview_button.setEnabled(enabled)
        self.open_phone_button.setEnabled(enabled)
        self.test_sms_button.setEnabled(enabled)
        if hasattr(self, "clear_dry_run_button"):
            self.clear_dry_run_button.setEnabled(enabled)
        if hasattr(self, "reset_selected_button"):
            self.reset_selected_button.setEnabled(enabled)
        if hasattr(self, "fill_recall_button"):
            self.fill_recall_button.setEnabled(enabled)
        if hasattr(self, "preview_recall_button"):
            self.preview_recall_button.setEnabled(enabled)
        if hasattr(self, "send_treatment_selected_button"):
            self.send_treatment_selected_button.setEnabled(enabled)
        if hasattr(self, "preview_treatment_button"):
            self.preview_treatment_button.setEnabled(enabled)
        if hasattr(self, "load_treatment_button"):
            self.load_treatment_button.setEnabled(enabled)
        if hasattr(self, "preview_holiday_button"):
            self.preview_holiday_button.setEnabled(enabled)
        if hasattr(self, "send_holiday_selected_button"):
            self.send_holiday_selected_button.setEnabled(enabled)
        if hasattr(self, "send_holiday_all_button"):
            self.send_holiday_all_button.setEnabled(enabled)
        if hasattr(self, "save_holiday_automation_button"):
            self.save_holiday_automation_button.setEnabled(enabled)
        if hasattr(self, "manage_holiday_automation_button"):
            self.manage_holiday_automation_button.setEnabled(enabled)

    def append_activity(self, message: str) -> None:
        entry = f"[{clinic_now().strftime('%H:%M:%S')}] {message}"
        self.activity_messages.append(entry)
        self.activity_messages = self.activity_messages[-500:]

    def send_finished(self, sent: int, failed: int) -> None:
        self.set_send_enabled(True)
        self.append_activity(f"Done. Sent/dry-run: {sent}. Failed: {failed}.")
        if self.monitor_batch_active and failed:
            self.monitor_batch_failed = True
        if self.active_send_kind == "recall":
            self.load_recall_patients()
        elif self.active_send_kind == "treatment":
            self.load_treatment_patients()
        elif self.active_send_kind == "treatment-monitor":
            if failed:
                self.treatment_monitor_batch_active = False
                self.treatment_active_schedule_key = ""
            else:
                if self.treatment_active_schedule_key:
                    self.settings.setValue("last_successful_treatment_schedule_run", self.treatment_active_schedule_key)
                self.treatment_monitor_batch_active = False
            self.update_monitoring_status()
            self.load_treatment_patients()
        elif self.active_send_kind in {"campaign", "campaign-monitor"}:
            status_text = "sent" if failed == 0 else "check log"
            visible_patients = self.holiday_visible_patients()
            for row_index, patient in enumerate(visible_patients):
                if self.campaign_recipient_key(patient) not in self.active_campaign_recipient_keys:
                    continue
                patient["_CampaignStatus"] = status_text
                item = self.holiday_table.item(row_index, 8)
                if item:
                    item.setText(status_text)
            for patient in self.holiday_patients:
                if self.campaign_recipient_key(patient) in self.active_campaign_recipient_keys:
                    patient["_CampaignStatus"] = status_text
            self.active_campaign_recipient_keys = set()
            if self.active_send_kind == "campaign-monitor":
                if failed:
                    self.holiday_monitor_batch_failed = True
                    self.holiday_active_campaign_id = ""
                else:
                    self.mark_active_campaign_sent()
                if self.holiday_monitor_batch_active:
                    self.process_next_holiday_campaign()
        elif self.monitor_batch_active:
            self.process_next_monitor_target()
        else:
            self.load_appointments()

    def load_logs(self) -> None:
        try:
            logs = self.repo.fetch_recent_logs()
        except Exception:
            return
        self.render_logs(logs)

    def render_logs(self, logs: list[dict[str, Any]]) -> None:
        self.logs_table.setRowCount(len(logs))
        for row_index, row in enumerate(logs):
            values = [
                row.get("ReminderLogNum"),
                row.get("AptNum"),
                row.get("PatNum"),
                row.get("Phone"),
                display_date(row.get("ReminderForDate")),
                row.get("Status"),
                row.get("SentAt") or "",
                row.get("ErrorMessage") or "",
            ]
            for col, value in enumerate(values):
                self.logs_table.setItem(row_index, col, QTableWidgetItem(str(value or "")))

    def update_dry_run_badge(self) -> None:
        self.dry_run_badge.setText("DRY RUN" if self.config.dry_run else "REAL SMS")
        self.dry_run_badge.setProperty("mode", "dry" if self.config.dry_run else "real")
        self.dry_run_badge.style().unpolish(self.dry_run_badge)
        self.dry_run_badge.style().polish(self.dry_run_badge)

    def update_monitoring_status(self) -> None:
        if not hasattr(self, "monitor_status_value"):
            return
        targets = self.monitor_target_dates()
        self.monitor_status_value.setText("Running" if self.monitoring_active else "Stopped")
        self.monitor_status_value.setProperty("running", "true" if self.monitoring_active else "false")
        self.monitor_status_value.style().unpolish(self.monitor_status_value)
        self.monitor_status_value.style().polish(self.monitor_status_value)
        self.monitor_date_value.setText(
            ", ".join(f"{display_date(target)} ({(target - clinic_today()).days} days ahead)" for target in targets)
        )
        self.monitor_time_value.setText(self.config.scheduled_send_time)
        self.monitor_note_value.setText(
            "When monitoring is running, the app waits for the daily send time. "
            "At that time it sends pending SMS reminders for tomorrow's patients and patients with appointments 8 days away. "
            f"It will only send within {SCHEDULE_SEND_GRACE_MINUTES} minutes after the configured time."
        )
        if hasattr(self, "monitor_holiday_status_value"):
            campaigns = self.config.holiday_campaigns or []
            today_key = clinic_today().isoformat()
            holiday_count = sum(1 for campaign in campaigns if str(campaign.get("type") or "holiday") == "holiday")
            birthday_count = sum(1 for campaign in campaigns if str(campaign.get("type") or "") == "birthday")
            due_count = sum(
                1
                for campaign in campaigns
                if campaign.get("enabled", True)
                and str(campaign.get("run_date") or "") == today_key
                and str(campaign.get("last_sent_date") or "") != today_key
            )
            self.monitor_holiday_status_value.setText("Running" if self.holiday_monitoring_active else "Stopped")
            self.monitor_holiday_status_value.setProperty("running", "true" if self.holiday_monitoring_active else "false")
            self.monitor_holiday_status_value.style().unpolish(self.monitor_holiday_status_value)
            self.monitor_holiday_status_value.style().polish(self.monitor_holiday_status_value)
            self.monitor_holiday_saved_value.setText(f"{holiday_count} automation(s)")
            self.monitor_birthday_saved_value.setText(f"{birthday_count} automation(s)")
            self.monitor_holiday_due_value.setText(f"{due_count} due today")
            self.monitor_holiday_note_value.setText(
                "Holiday and birthday campaigns are saved separately from the Holiday & Birthday tab. "
                "This panel has its own Start/Stop state and sends saved Holiday/Birthday campaigns only on their configured send date."
            )
        self.start_monitoring_button.setEnabled(not self.monitoring_active)
        self.stop_monitoring_button.setEnabled(self.monitoring_active)
        if hasattr(self, "start_holiday_monitoring_button"):
            self.start_holiday_monitoring_button.setEnabled(not self.holiday_monitoring_active)
            self.stop_holiday_monitoring_button.setEnabled(self.holiday_monitoring_active)
        if hasattr(self, "monitor_treatment_status_value"):
            self.monitor_treatment_status_value.setText("Running" if self.treatment_monitoring_active else "Stopped")
            self.monitor_treatment_status_value.setProperty("running", "true" if self.treatment_monitoring_active else "false")
            self.monitor_treatment_status_value.style().unpolish(self.monitor_treatment_status_value)
            self.monitor_treatment_status_value.style().polish(self.monitor_treatment_status_value)
            self.monitor_treatment_due_value.setText(f"Pending procedure date is {self.config.treatment_days}+ days before today")
            self.monitor_treatment_time_value.setText(self.config.scheduled_send_time)
            self.monitor_treatment_note_value.setText(
                "Treatment monitoring uses its own Start/Stop state. At the configured send time, it loads unfinished planned procedure codes dated before the miss window and sends treatment templates."
            )
            self.start_treatment_monitoring_button.setEnabled(not self.treatment_monitoring_active)
            self.stop_treatment_monitoring_button.setEnabled(self.treatment_monitoring_active)

    def monitor_target_dates(self) -> list[date]:
        today = clinic_qdate()
        offsets = [self.config.reminder_days_ahead, SECOND_APPOINTMENT_REMINDER_DAYS_AHEAD]
        targets: list[date] = []
        seen: set[str] = set()
        for offset in offsets:
            target = today.addDays(offset).toPython()
            key = target.isoformat()
            if key not in seen:
                targets.append(target)
                seen.add(key)
        return targets

    def start_monitoring(self) -> None:
        self.save_settings(silent=True)
        if not self.config.bridge_url or not self.config.api_token:
            QMessageBox.warning(self, "Bridge settings required", "Please set Bridge URL and API token in Settings first.")
            return
        self.monitoring_active = True
        self.update_monitoring_status()
        self.tabs.setCurrentWidget(self.tabs.widget(0))
        try:
            self.suppress_auto_load = True
            target = self.monitor_target_dates()[0]
            self.date_edit.setDate(QDate(target.year, target.month, target.day))
        finally:
            self.suppress_auto_load = False
        self.append_activity("Monitoring started. Loading first reminder target appointments.")
        self.load_appointments()

    def reset_schedule_marker_for_manual_start(self) -> None:
        # Kept for older settings migrations/debugging. Monitoring start should not clear
        # today's completed marker automatically, otherwise restarting the tool after
        # the send time can trigger duplicate SMS.
        now = clinic_now()
        target_time = self.config.scheduled_send_time
        try:
            schedule_hour, schedule_minute = [int(part) for part in target_time.split(":", 1)]
        except ValueError:
            return
        scheduled_today = now.replace(hour=schedule_hour, minute=schedule_minute, second=0, microsecond=0)
        if now < scheduled_today or now > scheduled_today + timedelta(minutes=SCHEDULE_SEND_GRACE_MINUTES):
            return
        now_key = f"{now.strftime('%Y-%m-%d')} {target_time}"
        if self.settings.value("last_successful_schedule_run", "") == now_key:
            self.settings.remove("last_successful_schedule_run")
            self.active_schedule_key = ""
            self.append_activity("Manual monitoring start reset today's completed marker; sent logs still prevent duplicate SMS.")

    def stop_monitoring(self) -> None:
        self.monitoring_active = False
        self.send_after_load = False
        self.monitor_send_queue = []
        self.monitor_batch_active = False
        self.monitor_batch_failed = False
        self.active_schedule_key = ""
        self.update_monitoring_status()
        self.append_activity("Monitoring stopped.")
        self.statusBar().showMessage("Monitoring stopped.", 4000)

    def start_holiday_monitoring(self) -> None:
        self.save_settings(silent=True)
        if not self.config.bridge_url or not self.config.api_token:
            QMessageBox.warning(self, "Bridge settings required", "Please set Bridge URL and API token in Settings first.")
            return
        self.holiday_monitoring_active = True
        self.holiday_monitor_batch_active = False
        self.holiday_monitor_batch_failed = False
        self.holiday_campaign_queue = []
        self.holiday_active_campaign_id = ""
        self.holiday_active_schedule_key = ""
        self.update_monitoring_status()
        self.append_activity("Holiday/Birthday monitoring started.")
        self.statusBar().showMessage("Holiday/Birthday monitoring started.", 4000)

    def stop_holiday_monitoring(self) -> None:
        self.holiday_monitoring_active = False
        self.holiday_monitor_batch_active = False
        self.holiday_monitor_batch_failed = False
        self.holiday_campaign_queue = []
        self.holiday_active_campaign_id = ""
        self.holiday_active_schedule_key = ""
        self.update_monitoring_status()
        self.append_activity("Holiday/Birthday monitoring stopped.")
        self.statusBar().showMessage("Holiday/Birthday monitoring stopped.", 4000)

    def start_treatment_monitoring(self) -> None:
        self.save_settings(silent=True)
        if not self.config.bridge_url or not self.config.api_token:
            QMessageBox.warning(self, "Bridge settings required", "Please set Bridge URL and API token in Settings first.")
            return
        self.treatment_monitoring_active = True
        self.treatment_monitor_batch_active = False
        self.treatment_active_schedule_key = ""
        self.update_monitoring_status()
        self.append_activity("Treatment monitoring started.")
        self.statusBar().showMessage("Treatment monitoring started.", 4000)
        if hasattr(self, "treatment_table"):
            self.load_treatment_patients()

    def stop_treatment_monitoring(self) -> None:
        self.treatment_monitoring_active = False
        self.treatment_monitor_batch_active = False
        self.treatment_active_schedule_key = ""
        self.update_monitoring_status()
        self.append_activity("Treatment monitoring stopped.")
        self.statusBar().showMessage("Treatment monitoring stopped.", 4000)

    def check_schedule(self) -> None:
        if not self.monitoring_active:
            return
        if self.monitor_batch_active:
            return
        if self.worker and self.worker.isRunning():
            return
        if self.load_worker and self.load_worker.isRunning():
            return
        now = clinic_now()
        target_time = self.config.scheduled_send_time
        try:
            schedule_hour, schedule_minute = [int(part) for part in target_time.split(":", 1)]
        except ValueError:
            self.append_activity(f"Invalid scheduled send time: {target_time}")
            return
        scheduled_today = now.replace(hour=schedule_hour, minute=schedule_minute, second=0, microsecond=0)
        if now < scheduled_today:
            return
        send_window_ends = scheduled_today + timedelta(minutes=SCHEDULE_SEND_GRACE_MINUTES)
        if now > send_window_ends:
            return
        now_key = f"{now.strftime('%Y-%m-%d')} {target_time}"
        last_run = self.settings.value("last_successful_schedule_run", "")
        if last_run == now_key:
            return
        if self.active_schedule_key == now_key:
            return
        self.active_schedule_key = now_key
        self.start_monitoring_batch()

    def check_holiday_schedule(self) -> None:
        if not self.holiday_monitoring_active:
            return
        if self.holiday_monitor_batch_active:
            return
        if self.worker and self.worker.isRunning():
            return
        now = clinic_now()
        target_time = self.config.scheduled_send_time
        try:
            schedule_hour, schedule_minute = [int(part) for part in target_time.split(":", 1)]
        except ValueError:
            self.append_activity(f"Invalid scheduled send time: {target_time}")
            return
        scheduled_today = now.replace(hour=schedule_hour, minute=schedule_minute, second=0, microsecond=0)
        if now < scheduled_today:
            return
        if now > scheduled_today + timedelta(minutes=SCHEDULE_SEND_GRACE_MINUTES):
            return
        now_key = f"{now.strftime('%Y-%m-%d')} {target_time}"
        if self.settings.value("last_successful_holiday_schedule_run", "") == now_key:
            return
        if self.holiday_active_schedule_key == now_key:
            return
        self.holiday_active_schedule_key = now_key
        self.start_holiday_monitoring_batch()

    def check_treatment_schedule(self) -> None:
        if not self.treatment_monitoring_active:
            return
        if self.treatment_monitor_batch_active:
            return
        if self.worker and self.worker.isRunning():
            return
        if self.treatment_load_worker and self.treatment_load_worker.isRunning():
            return
        now = clinic_now()
        target_time = self.config.scheduled_send_time
        try:
            schedule_hour, schedule_minute = [int(part) for part in target_time.split(":", 1)]
        except ValueError:
            self.append_activity(f"Invalid scheduled send time: {target_time}")
            return
        scheduled_today = now.replace(hour=schedule_hour, minute=schedule_minute, second=0, microsecond=0)
        if now < scheduled_today:
            return
        if now > scheduled_today + timedelta(minutes=SCHEDULE_SEND_GRACE_MINUTES):
            return
        now_key = f"{now.strftime('%Y-%m-%d')} {target_time}"
        if self.settings.value("last_successful_treatment_schedule_run", "") == now_key:
            return
        if self.treatment_active_schedule_key == now_key:
            return
        self.treatment_active_schedule_key = now_key
        self.start_treatment_monitoring_batch()

    def start_treatment_monitoring_batch(self) -> None:
        self.treatment_monitor_batch_active = True
        self.append_activity("Scheduled treatment monitoring started.")
        try:
            patients = self.repo.fetch_treatment_candidates(
                self.config.treatment_days,
                self.config.treatment_codes,
                self.config.treatment_statuses,
            )
        except Exception as exc:  # noqa: BLE001
            self.treatment_monitor_batch_active = False
            self.treatment_active_schedule_key = ""
            self.append_activity(f"Treatment monitoring load failed: {exc}")
            return
        prepared: list[dict[str, Any]] = []
        missing_phone_count = 0
        missing_template_count = 0
        for patient in patients:
            row = self.normalize_patient_phone_targets(patient)
            key = treatment_template_key_for_language(self.config, row.get("Language"))
            row["_TemplateKey"] = key
            row["_TemplateText"] = self.config.treatment_templates.get(key) or ""
            row["_TemplateCountry"] = str(self.config.treatment_template_countries.get(key) or infer_template_country(key)).upper()
            row["_Treatment"] = True
            if not row.get("PhoneTargets"):
                missing_phone_count += 1
                self.append_activity(f"Skipped treatment SMS: {patient_name(row)} has no valid phone number.")
                continue
            if not row.get("_TemplateText"):
                missing_template_count += 1
                self.append_activity(f"Skipped treatment SMS: {patient_name(row)} has no template.")
                continue
            if row.get("_TemplateText") and row.get("PhoneTargets"):
                prepared.append(row)
        if missing_phone_count:
            self.append_activity(f"Treatment monitoring skipped {missing_phone_count} patient(s) with no valid phone number.")
        if missing_template_count:
            self.append_activity(f"Treatment monitoring skipped {missing_template_count} patient(s) with no template.")
        self.treatment_patients = prepared
        if hasattr(self, "treatment_table"):
            self.render_treatment_patients()
        if not prepared:
            self.treatment_monitor_batch_active = False
            if self.treatment_active_schedule_key:
                self.settings.setValue("last_successful_treatment_schedule_run", self.treatment_active_schedule_key)
            self.append_activity("Treatment monitoring found no pending patients to send.")
            self.update_monitoring_status()
            return
        self.active_send_kind = "treatment-monitor"
        self.set_send_enabled(False)
        self.worker = SendWorker(self.config, prepared)
        self.worker.progress.connect(self.append_activity)
        self.worker.finished.connect(self.send_finished)
        self.worker.start()

    def start_monitoring_batch(self) -> None:
        self.monitor_send_queue = self.monitor_target_dates()
        self.monitor_batch_active = True
        self.monitor_batch_failed = False
        self.append_activity(
            "Scheduled monitoring started for "
            + ", ".join(display_date(target) for target in self.monitor_send_queue)
            + "."
        )
        self.process_next_monitor_target()

    def start_holiday_monitoring_batch(self) -> None:
        self.holiday_campaign_queue = self.due_holiday_campaigns()
        self.holiday_monitor_batch_active = True
        self.holiday_monitor_batch_failed = False
        if self.holiday_campaign_queue:
            self.append_activity(f"Queued {len(self.holiday_campaign_queue)} Holiday/Birthday campaign automation(s).")
        else:
            self.append_activity("Holiday/Birthday monitoring found no campaign due today.")
        self.process_next_holiday_campaign()

    def due_holiday_campaigns(self) -> list[dict[str, Any]]:
        self.load_templates_from_bridge()
        today_key = clinic_today().isoformat()
        due: list[dict[str, Any]] = []
        for campaign in self.config.holiday_campaigns:
            if not campaign.get("enabled", True):
                continue
            if str(campaign.get("run_date") or "") != today_key:
                continue
            if str(campaign.get("last_sent_date") or "") == today_key:
                continue
            prepared_recipients = [self.prepare_campaign_recipient(campaign, patient) for patient in campaign.get("recipients") or []]
            missing_phone = [patient for patient in prepared_recipients if not patient.get("PhoneTargets")]
            missing_template = [patient for patient in prepared_recipients if patient.get("PhoneTargets") and not patient.get("_TemplateText")]
            for patient in missing_phone:
                self.append_activity(f"Skipped campaign SMS: {campaign.get('name')} / {patient_name(patient)} has no valid phone number.")
            for patient in missing_template:
                self.append_activity(f"Skipped campaign SMS: {campaign.get('name')} / {patient_name(patient)} has no template.")
            if missing_phone:
                self.append_activity(f"Campaign {campaign.get('name')} skipped {len(missing_phone)} recipient(s) with no valid phone number.")
            if missing_template:
                self.append_activity(f"Campaign {campaign.get('name')} skipped {len(missing_template)} recipient(s) with no template.")
            recipients = [patient for patient in prepared_recipients if patient.get("_TemplateText") and patient.get("PhoneTargets")]
            if not recipients:
                self.append_activity(f"Skipped campaign {campaign.get('name')}: no valid recipients/templates.")
                continue
            due_campaign = dict(campaign)
            due_campaign["recipients"] = recipients
            due.append(due_campaign)
        return due

    def prepare_campaign_recipient(self, campaign: dict[str, Any], patient: dict[str, Any]) -> dict[str, Any]:
        row = dict(patient)
        campaign_type = str(campaign.get("type") or row.get("_CampaignType") or "holiday")
        key = str(row.get("_TemplateKey") or holiday_template_key_for_language(self.config, row.get("Language"), campaign_type))
        row["_CampaignType"] = campaign_type
        row["_CampaignName"] = str(campaign.get("name") or row.get("_CampaignName") or "")
        row["_HolidayName"] = row["_CampaignName"]
        row["_TemplateKey"] = key
        row["_TemplateText"] = self.config.holiday_templates.get(key, "")
        row["_TemplateCountry"] = str(self.config.holiday_template_countries.get(key) or infer_template_country(key)).upper()
        targets = [
            {"source": target.get("source") or "Phone", "phone": target.get("phone", ""), "status": ""}
            for target in row.get("PhoneTargets", [])
            if digits_only(target.get("phone", ""))
        ]
        if not targets and digits_only(row.get("Phone", "")):
            targets = [{"source": "Phone", "phone": format_us_phone(row.get("Phone", "")), "status": ""}]
        row["PhoneTargets"] = targets
        row["Phone"] = self.phone_targets_display(targets)
        return row

    def mark_active_campaign_sent(self) -> None:
        if not self.holiday_active_campaign_id:
            return
        today_key = clinic_today().isoformat()
        for campaign in self.config.holiday_campaigns:
            if str(campaign.get("id") or "") == self.holiday_active_campaign_id:
                campaign["last_sent_date"] = today_key
                break
        try:
            self.save_holiday_campaigns_to_bridge()
        except Exception as exc:  # noqa: BLE001
            self.holiday_monitor_batch_failed = True
            self.append_activity(f"Campaign sent but failed to update saved automation: {exc}")
        self.holiday_active_campaign_id = ""

    def process_next_holiday_campaign(self) -> None:
        if not self.holiday_monitor_batch_active:
            return
        if self.holiday_campaign_queue:
            campaign = self.holiday_campaign_queue.pop(0)
            self.holiday_active_campaign_id = str(campaign.get("id") or "")
            self.active_send_kind = "campaign-monitor"
            self.active_campaign_recipient_keys = {
                self.campaign_recipient_key(patient)
                for patient in campaign.get("recipients") or []
            }
            self.set_send_enabled(False)
            self.append_activity(
                f"Sending campaign automation: {campaign.get('name')} ({len(campaign.get('recipients') or [])} recipient(s))."
            )
            self.worker = CampaignSendWorker(self.config, campaign.get("recipients") or [])
            self.worker.progress.connect(self.append_activity)
            self.worker.finished.connect(self.send_finished)
            self.worker.start()
            return
        self.holiday_monitor_batch_active = False
        if self.holiday_monitor_batch_failed:
            self.append_activity("Holiday/Birthday monitoring finished with errors. It will retry on the next scheduler check.")
            self.statusBar().showMessage("Holiday/Birthday monitoring finished with errors.", 5000)
            self.holiday_active_schedule_key = ""
        else:
            if self.holiday_active_schedule_key:
                self.settings.setValue("last_successful_holiday_schedule_run", self.holiday_active_schedule_key)
            self.append_activity("Holiday/Birthday monitoring finished.")
            self.statusBar().showMessage("Holiday/Birthday monitoring finished.", 5000)
        self.update_monitoring_status()

    def process_next_monitor_target(self) -> None:
        if not self.monitor_batch_active:
            return
        if not self.monitor_send_queue:
            self.monitor_batch_active = False
            if self.monitor_batch_failed:
                self.append_activity("Scheduled monitoring finished with errors. It will retry on the next scheduler check.")
                self.statusBar().showMessage("Scheduled monitoring finished with errors.", 5000)
                self.active_schedule_key = ""
            else:
                if self.active_schedule_key:
                    self.settings.setValue("last_successful_schedule_run", self.active_schedule_key)
                self.append_activity("Scheduled monitoring finished.")
                self.statusBar().showMessage("Scheduled monitoring finished.", 5000)
            return
        target = self.monitor_send_queue.pop(0)
        try:
            self.suppress_auto_load = True
            self.date_edit.setDate(QDate(target.year, target.month, target.day))
        finally:
            self.suppress_auto_load = False
        self.append_activity(f"Loading scheduled reminder target {display_date(target)}.")
        self.send_after_load = True
        self.load_appointments()


def status_label(status: Any) -> str:
    labels = {
        0: "None",
        1: "Scheduled",
        2: "Complete",
        3: "UnschedList",
        4: "ASAP",
        5: "Broken",
        6: "Planned",
        7: "PtNote",
        8: "PtNoteCompleted",
    }
    try:
        return labels.get(int(status), str(status))
    except (TypeError, ValueError):
        return str(status or "")


APP_STYLES = """
QMainWindow, QWidget {
  background: #f7fbfd;
  color: #202833;
  font-family: "Google Sans", "Segoe UI", Arial, sans-serif;
  font-size: 12px;
}
QMainWindow {
  background: #f7fbfd;
}
QLabel {
  background: transparent;
}
#AppTabs::pane {
  border: 0;
  background: transparent;
}
QTabWidget::tab-bar {
  alignment: left;
}
QTabBar {
  background: #ffffff;
  border-bottom: 1px solid #e5edf3;
}
QTabBar::tab {
  background: transparent;
  color: #617181;
  padding: 10px 16px 9px 16px;
  font-weight: 700;
  border: 0;
  min-width: 88px;
}
QTabBar::tab:selected {
  color: #1359d8;
  border-bottom: 3px solid #23c7e8;
}
#HeroCard {
  border: 1px solid #e2edf3;
  border-radius: 8px;
  background: #ffffff;
}
#Card, #StatCard, QGroupBox {
  border: 1px solid #e2edf3;
  border-radius: 8px;
  background: #ffffff;
}
QGroupBox {
  margin-top: 10px;
  padding-top: 12px;
  font-size: 13px;
  font-weight: 800;
  color: #1c2936;
}
QGroupBox::title {
  subcontrol-origin: margin;
  left: 18px;
  padding: 0 8px;
}
#Eyebrow {
  color: #1359d8;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 1px;
}
#HeroTitle {
  color: #1f2933;
  font-size: 22px;
  font-weight: 900;
}
#HeroSubtitle {
  color: #647381;
  font-size: 12px;
}
#SectionTitle {
  color: #2f3742;
  font-size: 13px;
  font-weight: 800;
}
#Muted {
  color: #68717d;
}
#StatCard {
  min-height: 66px;
}
#StatValue {
  color: #1359d8;
  font-size: 23px;
  font-weight: 900;
}
#StatLabel {
  color: #68717d;
  font-size: 11px;
  font-weight: 700;
}
QPushButton {
  border: 1px solid #d8e2ea;
  border-radius: 7px;
  padding: 7px 13px;
  background: #ffffff;
  font-weight: 700;
  color: #26323f;
}
QPushButton:hover {
  background: #f0fbff;
  border-color: #25c3e6;
}
QPushButton:pressed {
  background: #e6f7fd;
}
#PrimaryButton {
  background: #155bd8;
  border-color: #155bd8;
  color: #ffffff;
}
#PrimaryButton:hover {
  background: #0f4fc4;
  border-color: #0f4fc4;
}
#SmallActionButton {
  min-width: 54px;
  padding: 5px 9px;
  border-radius: 7px;
  border: 1px solid #b9cfe0;
  background: #ffffff;
  color: #155bd8;
  font-size: 12px;
  font-weight: 900;
}
#SmallActionButton:hover {
  background: #edf9fd;
  border-color: #23c7e8;
}
#Badge {
  padding: 6px 11px;
  border-radius: 8px;
  background: #e8f2ff;
  color: #155bd8;
  font-weight: 900;
}
#Badge[mode="real"] {
  background: #fff1f0;
  color: #b42318;
}
#MonitorStatus {
  padding: 6px 10px;
  border-radius: 8px;
  background: #fff7ed;
  color: #b45309;
  font-size: 14px;
  font-weight: 900;
}
#MonitorStatus[running="true"] {
  background: #e8f8ef;
  color: #0f7b3a;
}
#MonitorStatus[running="false"] {
  background: #fff7ed;
  color: #b45309;
}
QLineEdit, QSpinBox, QDateEdit, QTimeEdit, QTextEdit, QPlainTextEdit {
  border: 1px solid #d5dfe8;
  border-radius: 7px;
  min-height: 18px;
  padding: 6px 9px;
  background: #ffffff;
  color: #202833;
  selection-background-color: #155bd8;
  selection-color: #ffffff;
}
QSpinBox {
  padding-right: 26px;
}
QSpinBox::up-button {
  subcontrol-origin: border;
  subcontrol-position: top right;
  width: 22px;
  border-left: 1px solid #edf3f7;
  border-top-right-radius: 7px;
  background: #f8fcff;
}
QSpinBox::down-button {
  subcontrol-origin: border;
  subcontrol-position: bottom right;
  width: 22px;
  border-left: 1px solid #edf3f7;
  border-bottom-right-radius: 7px;
  background: #f8fcff;
}
QSpinBox::up-button:hover, QSpinBox::down-button:hover {
  background: #eaf7fd;
}
QComboBox {
  border: 1px solid #d5dfe8;
  border-radius: 7px;
  min-height: 18px;
  padding: 6px 30px 6px 9px;
  background: #ffffff;
  color: #202833;
}
QComboBox:focus {
  border: 2px solid #23c7e8;
}
QComboBox:disabled {
  border-color: #d7dee6;
  background: #eef3f7;
  color: #7a8794;
}
QComboBox:disabled::drop-down {
  background: #e6edf3;
  border-left-color: #d7dee6;
}
QComboBox::drop-down, QDateEdit::drop-down, QTimeEdit::drop-down {
  subcontrol-origin: padding;
  subcontrol-position: top right;
  width: 24px;
  border: 0;
  border-left: 1px solid #edf3f7;
  border-top-right-radius: 7px;
  border-bottom-right-radius: 7px;
  background: #f8fcff;
}
QComboBox QAbstractItemView {
  border: 1px solid #d5dfe8;
  border-radius: 8px;
  background: #ffffff;
  selection-background-color: #e4f2ff;
  selection-color: #1359d8;
  padding: 6px;
  outline: 0;
}
#TemplateCombo {
  border-radius: 6px;
  padding: 3px 24px 3px 7px;
  min-height: 16px;
  background: #ffffff;
}
#TemplateCombo::drop-down {
  width: 22px;
}
#LoadingOverlay {
  background: rgba(247, 251, 253, 218);
  border: 1px solid #d8e7f0;
  border-radius: 8px;
}
#LoadingText {
  color: #1359d8;
  background: #ffffff;
  border: 1px solid #d8e7f0;
  border-radius: 8px;
  padding: 9px 16px;
  font-size: 13px;
  font-weight: 900;
}
QLineEdit:focus, QSpinBox:focus, QDateEdit:focus, QTimeEdit:focus, QTextEdit:focus, QPlainTextEdit:focus {
  border: 2px solid #23c7e8;
}
QTableWidget {
  border: 0;
  border-radius: 8px;
  background: #ffffff;
  alternate-background-color: #f8fcff;
  selection-background-color: #e4f2ff;
  selection-color: #0f3f9c;
}
QHeaderView::section {
  background: #edf9fd;
  color: #2f3742;
  padding: 8px;
  border: 0;
  font-weight: 800;
}
QTableWidget::item {
  padding: 5px;
  border-bottom: 1px solid #edf3f7;
}
QSplitter::handle {
  background: transparent;
  height: 10px;
}
QStatusBar {
  background: #ffffff;
  color: #68717d;
  border-top: 1px solid #dce8ef;
}
"""


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("LUK Dental SMS Reminder Tool")
    if APP_ICON_PATH.exists():
        app.setWindowIcon(QIcon(str(APP_ICON_PATH)))
    font = QFont("Segoe UI", 9)
    app.setFont(font)
    window = SmsReminderWindow()
    window.showMaximized()
    if "--start-monitoring" in sys.argv:
        QTimer.singleShot(1500, window.start_monitoring)
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
