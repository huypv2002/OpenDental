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
FLAGS_DIR = APP_DIR / "assets" / "flags"
CONFIG_PATH = APP_DIR / "sms_config.json"
BRIDGE_ENV_PATH = APP_DIR.parent / ".env"
CLINIC_TIME_ZONE_NOTE = "Use this app on the clinic server set to Houston/Central time."
DEFAULT_RECALL_CODES = "D1110,D1120,D4341,D4342"
SECOND_APPOINTMENT_REMINDER_DAYS_AHEAD = 8
SCHEDULE_SEND_GRACE_MINUTES = 30
DEFAULT_RECALL_TEMPLATES = {
    "US": (
        "Good morning {salutation}, this is Luk Dental. Your 6-month cleaning recall is due. "
        "Please call {clinic_phone} or book online at https://lukdental.us/dental-appointment/ "
        "to schedule your appointment. Thank you and have a great day."
    ),
    "ES": (
        "Buenos días {salutation}, le habla Luk Dental. Ya llegó el momento de su limpieza "
        "de 6 meses. Por favor llame al {clinic_phone} o haga su cita en "
        "https://lukdental.us/dental-appointment/. Gracias y que tenga un excelente día."
    ),
    "VI": (
        "Good morning {vi_salutation}, nha khoa Luk Dental xin nhắc lịch cleaning 6 tháng "
        "của {vi_title} đã đến. {vi_title_cap} vui lòng gọi {clinic_phone} hoặc đặt lịch tại "
        "https://lukdental.us/dental-appointment/. Thank you and have a great day."
    ),
}
DEFAULT_RECALL_TEMPLATE = DEFAULT_RECALL_TEMPLATES["US"]
OUTDATED_DEFAULT_RECALL_TEMPLATES = {
    "US": [
        (
            "Good morning {first_name}, this is Luk Dental. Your 6-month cleaning recall is due. "
            "Please call {clinic_phone} or book online at https://lukdental.us/dental-appointment/ "
            "to schedule your appointment. Thank you and have a great day."
        ),
    ],
    "ES": [
        (
            "Buenos días {first_name}, le habla Luk Dental. Ya llegó el momento de su limpieza "
            "de 6 meses. Por favor llame al {clinic_phone} o haga su cita en "
            "https://lukdental.us/dental-appointment/. Gracias y que tenga un excelente día."
        ),
    ],
    "VI": [
        (
            "Good morning anh/chị {first_name}, nha khoa Luk Dental xin nhắc lịch cleaning 6 tháng "
            "của anh/chị đã đến. Anh/chị vui lòng gọi {clinic_phone} hoặc đặt lịch tại "
            "https://lukdental.us/dental-appointment/. Thank you and have a great day."
        ),
    ],
}


def clinic_now() -> datetime:
    return datetime.now()


def clinic_today() -> date:
    return clinic_now().date()


def clinic_qdate(days_ahead: int = 0) -> QDate:
    today = clinic_today()
    return QDate(today.year, today.month, today.day).addDays(days_ahead)


DEFAULT_SMS_TEMPLATES = {
    "US": (
        "Good morning {salutation}, I'm Nhan Nguyen from Luk Dental. I just remind you "
        "of your appointment {relative_day}, {weekday}, {date_full} at {time_lower}. "
        "Thank you and have a great day."
    ),
    "ES": (
        "Buenos días {salutation}, soy Nhan Nguyen de Luk Dental. Le recuerdo "
        "su cita {relative_day_es}, {weekday}, {date_full} a las {time_lower}. "
        "Gracias y que tenga un excelente día."
    ),
    "VI": (
        "Good morning {vi_salutation}, nha khoa Luk Dental xin nhắc lịch hẹn cho {vi_title} "
        "vào {relative_day_vi}. {weekday_vi}, {date_short} lúc {time_lower}. "
        "Thank you and have a great day."
    ),
}

OUTDATED_DEFAULT_SMS_TEMPLATES = {
    "US": [
        (
            "Good morning {first_name}, I'm Nhan Nguyen from Luk Dental. I just remind you "
            "of your appointment {relative_day}, {weekday}, {date_full} at {time_lower}. "
            "Thank you and have a great day."
        ),
        (
            "Good morning {first_name}, I'm Nhan Nguyen from Luk Dental. I just remind you "
            "of your appointment tomorrow, {weekday}, {date_full} at {time_lower}. "
            "Thank you and have a great day."
        ),
        (
            "Good morning {salutation}, I'm Nhan Nguyen from Luk Dental. I just remind you "
            "of your appointment tomorrow, {weekday}, {date_full} at {time_lower}. "
            "Thank you and have a great day."
        ),
    ],
    "ES": [
        (
            "Buenos días {first_name}, soy Nhan Nguyen de Luk Dental. Le recuerdo "
            "su cita {relative_day_es}, {weekday}, {date_full} a las {time_lower}. "
            "Gracias y que tenga un excelente día."
        ),
        (
            "Buenos días {first_name}, soy Nhan Nguyen de Luk Dental. Le recuerdo "
            "su cita de mañana, {weekday}, {date_full} a las {time_lower}. "
            "Gracias y que tenga un excelente día."
        ),
    ],
    "VI": [
        (
            "Good morning anh/chị, nha khoa Luk Dental xin nhắc lịch hẹn cho anh/chị "
            "vào {relative_day_vi}. {weekday_vi}, {date_short} lúc {time_lower}. "
            "Thank you and have a great day anh/chị."
        ),
        (
            "Good morning anh/chị, nha khoa Luk Dental xin nhắc lịch hẹn cho anh/chị "
            "vào ngày mai. {weekday_vi}, {date_short} lúc {time_lower}. "
            "Thank you and have a great day anh/chị."
        ),
        (
            "Good morning {salutation}, nha khoa Luk Dental xin nhắc lịch hẹn cho {salutation} "
            "vào ngày mai. {weekday_vi}, {date_short} lúc {time_lower}. "
            "Thank you and have a great day."
        ),
        (
            "Good morning {salutation}, nha khoa Luk Dental xin nhắc lịch hẹn cho {salutation} "
            "vào {relative_day_vi}. {weekday_vi}, {date_short} lúc {time_lower}. "
            "Thank you and have a great day."
        ),
    ],
}

DEFAULT_TEMPLATE_COUNTRIES = {
    "US": "US",
    "ES": "ES",
    "VI": "VI",
}

LEGACY_SMS_TEMPLATES = {
    "US": (
        "Hi {first_name}, this is {clinic_name} reminding you of your appointment "
        "on {date} at {time}. Please call {clinic_phone} if you need to change anything."
    ),
    "VI": (
        "Xin chao {first_name}, {clinic_name} xin nhac lich hen cua ban vao {date} luc {time}. "
        "Vui long goi {clinic_phone} neu can thay doi."
    ),
    "ES": (
        "Hola {first_name}, le recordamos su cita con {clinic_name} el {date} a las {time}. "
        "Llame al {clinic_phone} si necesita cambiar algo."
    ),
}


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
    sms_templates: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_SMS_TEMPLATES))
    sms_template_countries: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_TEMPLATE_COUNTRIES))
    recall_codes: str = DEFAULT_RECALL_CODES
    recall_months: int = 6
    recall_template: str = DEFAULT_RECALL_TEMPLATE
    recall_templates: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_RECALL_TEMPLATES))
    recall_template_countries: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_TEMPLATE_COUNTRIES))
    template_schema_version: int = 2
    sms_template: str = (
        "Hi {first_name}, this is {clinic_name} reminding you of your appointment "
        "on {date} at {time}. Please call {clinic_phone} if you need to change anything."
    )

    @classmethod
    def load(cls) -> "AppConfig":
        if CONFIG_PATH.exists():
            with CONFIG_PATH.open("r", encoding="utf-8") as file:
                raw = json.load(file)
            defaults = asdict(cls())
            known = {key: value for key, value in raw.items() if key in defaults}
            cfg = cls(**{**defaults, **known})
            cfg.dry_run = False
            if not cfg.sms_templates:
                cfg.sms_templates = dict(DEFAULT_SMS_TEMPLATES)
            if not cfg.sms_template_countries:
                cfg.sms_template_countries = dict(DEFAULT_TEMPLATE_COUNTRIES)
            if not cfg.recall_templates:
                cfg.recall_templates = dict(DEFAULT_RECALL_TEMPLATES)
            if not cfg.recall_template_countries:
                cfg.recall_template_countries = dict(DEFAULT_TEMPLATE_COUNTRIES)
            if raw.get("recall_template") and not raw.get("recall_templates"):
                cfg.recall_templates["US"] = str(raw["recall_template"])
                cfg.recall_template_countries["US"] = "US"
            if "sms_template" in raw and raw.get("sms_template") and not raw.get("sms_templates"):
                cfg.sms_templates["US"] = str(raw["sms_template"])
                cfg.sms_template_countries["US"] = "US"
            migrated = False
            if cfg.scheduled_send_time == "09:00":
                cfg.scheduled_send_time = "11:00"
                migrated = True
            for key, legacy_text in LEGACY_SMS_TEMPLATES.items():
                if cfg.sms_templates.get(key) == legacy_text:
                    cfg.sms_templates[key] = DEFAULT_SMS_TEMPLATES[key]
                    migrated = True
            for key, outdated_texts in OUTDATED_DEFAULT_SMS_TEMPLATES.items():
                if cfg.sms_templates.get(key) in outdated_texts:
                    cfg.sms_templates[key] = DEFAULT_SMS_TEMPLATES[key]
                    migrated = True
            for key, outdated_texts in OUTDATED_DEFAULT_RECALL_TEMPLATES.items():
                if cfg.recall_templates.get(key) in outdated_texts:
                    cfg.recall_templates[key] = DEFAULT_RECALL_TEMPLATES[key]
                    migrated = True
            if int(raw.get("template_schema_version") or 0) < 2:
                for key, text in DEFAULT_SMS_TEMPLATES.items():
                    cfg.sms_templates[key] = text
                    cfg.sms_template_countries[key] = DEFAULT_TEMPLATE_COUNTRIES[key]
                for key, text in DEFAULT_RECALL_TEMPLATES.items():
                    cfg.recall_templates[key] = text
                    cfg.recall_template_countries[key] = DEFAULT_TEMPLATE_COUNTRIES[key]
                cfg.template_schema_version = 2
                migrated = True
            for key in cfg.sms_templates:
                cfg.sms_template_countries.setdefault(key, infer_template_country(key))
            for key in cfg.recall_templates:
                cfg.recall_template_countries.setdefault(key, infer_template_country(key))
            if "US" not in cfg.sms_templates:
                cfg.sms_templates["US"] = DEFAULT_SMS_TEMPLATES["US"]
                cfg.sms_template_countries["US"] = "US"
                migrated = True
            if "US" not in cfg.recall_templates:
                cfg.recall_templates["US"] = DEFAULT_RECALL_TEMPLATES["US"]
                cfg.recall_template_countries["US"] = "US"
                migrated = True
            cfg.default_template_key = "US"
            cfg.sms_template = default_template(cfg)
            cfg.recall_template = cfg.recall_templates.get("US", DEFAULT_RECALL_TEMPLATE)
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
        CONFIG_PATH.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")


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
                failed += 1
                if not appointment.get("_Recall"):
                    repo.log_result(appointment, message, "failed", "Missing patient phone number.")
                self.progress.emit(f"Failed: {patient} has no phone number.")
                continue
            for target in targets:
                phone = target.get("phone", "")
                source = target.get("source") or "Phone"
                try:
                    sender.send_sms(phone, message)
                    status = "dry-run" if self.config.dry_run else "sent"
                    if appointment.get("_Recall"):
                        repo.log_recall_result(appointment, message, status, phone=phone)
                    else:
                        repo.log_result(appointment, message, status, phone=phone)
                    sent += 1
                    self.progress.emit(f"{status.upper()}: {patient} {source} -> {phone}")
                except Exception as exc:  # noqa: BLE001 - show UI-friendly automation errors
                    failed += 1
                    if appointment.get("_Recall"):
                        repo.log_recall_result(appointment, message, "failed", str(exc), phone=phone)
                    else:
                        repo.log_result(appointment, message, "failed", str(exc), phone=phone)
                    self.progress.emit(f"Failed: {patient} {source} -> {exc}")
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
        return max(0, (parse_datetime(row.get("AptDateTime")).date() - date.today()).days)
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


def vietnamese_title(row: dict[str, Any]) -> str:
    age = patient_age(row)
    gender = patient_gender(row)
    if age is not None and age <= 25:
        return "em"
    if age is not None and age <= 45:
        return "bạn"
    if age is not None and age <= 60:
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
    return next(iter(config.sms_templates.values()), config.sms_template)


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


def template_key_for_language_keys(keys: Any, language: str | None) -> str:
    available = {str(key).upper() for key in keys}
    text = str(language or "").strip().lower()
    if "spanish" in text or text in {"es", "spa", "espanol", "español"}:
        preferred = "ES"
    elif "vietnam" in text or text in {"vi", "vn", "vie", "tieng viet", "tiếng việt"}:
        preferred = "VI"
    else:
        preferred = "US"
    return preferred if preferred in available else "US"


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
        first_name=first_name,
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
        last_proc_date=display_date(row.get("LastProcDate")),
        procedure_codes=row.get("ProcedureCodes", ""),
    )


class SmsReminderWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.config = AppConfig.load()
        self.repo = BridgeClient(self.config)
        self.appointments: list[dict[str, Any]] = []
        self.recall_patients: list[dict[str, Any]] = []
        self.worker: SendWorker | None = None
        self.active_send_kind = "appointments"
        self.load_worker: LoadAppointmentsWorker | None = None
        self.recall_load_worker: LoadRecallWorker | None = None
        self.queued_load = False
        self.send_after_load = False
        self.monitor_send_queue: list[date] = []
        self.monitor_batch_active = False
        self.monitor_batch_failed = False
        self.active_schedule_key = ""
        self.monitoring_active = False
        self.row_template_combos: dict[int, QComboBox] = {}
        self.recall_template_combos: dict[int, QComboBox] = {}
        self.activity_messages: list[str] = []
        self.suppress_auto_load = False
        self.settings = QSettings("LUK Dental", "SMS Reminder Tool")
        self._restoring_column_widths: set[str] = set()

        self.setWindowTitle("LUK Dental SMS Reminder Tool")
        self.resize(1540, 920)
        self.setStyleSheet(APP_STYLES)

        self.tabs = QTabWidget()
        self.tabs.setObjectName("AppTabs")
        self.setCentralWidget(self.tabs)
        self.setStatusBar(QStatusBar())
        self.tabs.addTab(self.build_dashboard_tab(), "Dashboard")
        self.tabs.addTab(self.build_monitoring_tab(), "Monitoring")
        self.tabs.addTab(self.build_recall_tab(), "Recall")
        self.tabs.addTab(self.build_templates_tab(), "Templates")
        self.tabs.addTab(self.build_settings_tab(), "Settings")
        self.tabs.addTab(self.build_logs_tab(), "Logs")

        self.load_debounce = QTimer(self)
        self.load_debounce.setSingleShot(True)
        self.load_debounce.setInterval(250)
        self.load_debounce.timeout.connect(self.load_appointments)

        self.scheduler_timer = QTimer(self)
        self.scheduler_timer.timeout.connect(self.check_schedule)
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
        layout.setContentsMargins(18, 14, 18, 14)
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

    def build_dashboard_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(24, 22, 24, 22)
        layout.setSpacing(16)

        hero = self.card("HeroCard")
        hero_layout = QHBoxLayout(hero)
        hero_layout.setContentsMargins(24, 22, 24, 22)
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
        controls.setContentsMargins(18, 14, 18, 14)
        controls.setSpacing(12)
        controls.addWidget(QLabel("Reminder date"))
        self.date_edit = QDateEdit(clinic_qdate(self.config.reminder_days_ahead))
        self.date_edit.setCalendarPopup(True)
        self.date_edit.setDisplayFormat("MM/dd/yyyy")
        self.date_edit.setMinimumWidth(150)
        self.date_edit.setMinimumHeight(42)
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
        self.appointment_table = QTableWidget(0, 11)
        self.appointment_table.setHorizontalHeaderLabels(
            ["Status", "Time", "Patient", "Phone", "Email", "Apt #", "Pat #", "Reminder", "Sent", "Last sent", "Template"]
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
        }
        self.configure_resizable_columns(self.appointment_table, "dashboard/appointment_column_widths", column_widths)
        self.appointment_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.appointment_table.setSelectionMode(QTableWidget.ExtendedSelection)
        self.appointment_table.verticalHeader().setVisible(False)
        self.appointment_table.setAlternatingRowColors(True)
        self.appointment_table.setShowGrid(False)
        self.appointment_table.verticalHeader().setDefaultSectionSize(46)
        self.appointment_table.verticalHeader().setMinimumSectionSize(44)
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
        layout.setContentsMargins(24, 22, 24, 22)
        layout.setSpacing(16)

        heading = QLabel("Reminder settings")
        heading.setObjectName("HeroTitle")
        layout.addWidget(heading)

        bridge_box = QGroupBox("Bridge API")
        bridge_form = QFormLayout(bridge_box)
        bridge_form.setContentsMargins(20, 20, 20, 20)
        bridge_form.setSpacing(12)
        self.bridge_url = QLineEdit(self.config.bridge_url)
        self.bridge_url.setPlaceholderText("http://SERVER-IP:3008")
        self.api_token = QLineEdit(self.config.api_token)
        self.api_token.setEchoMode(QLineEdit.Password)
        bridge_form.addRow("Bridge URL", self.bridge_url)
        bridge_form.addRow("API token", self.api_token)

        sms_box = QGroupBox("SMS and schedule")
        sms_form = QFormLayout(sms_box)
        sms_form.setContentsMargins(20, 20, 20, 20)
        sms_form.setSpacing(12)
        self.clinic_name = QLineEdit(self.config.clinic_name)
        self.clinic_phone = QLineEdit(self.config.clinic_phone)
        self.days_ahead = QSpinBox()
        self.days_ahead.setRange(0, 30)
        self.days_ahead.setValue(self.config.reminder_days_ahead)
        self.schedule_time = QTimeEdit(QTime.fromString(self.config.scheduled_send_time, "HH:mm"))
        self.schedule_time.setDisplayFormat("HH:mm")
        self.statuses = QLineEdit(",".join(str(item) for item in self.config.appointment_statuses))
        sms_form.addRow("Clinic name", self.clinic_name)
        sms_form.addRow("Clinic phone", self.clinic_phone)
        sms_form.addRow("Reminder days ahead", self.days_ahead)
        sms_form.addRow("Daily send time", self.schedule_time)
        sms_form.addRow("Appointment statuses", self.statuses)
        sms_form.addRow("Send mode", QLabel("REAL SMS only. Dry-run mode is disabled."))

        buttons = QHBoxLayout()
        self.test_bridge_button = QPushButton("Test bridge connection")
        self.test_bridge_button.clicked.connect(self.test_bridge_connection)
        self.save_button = QPushButton("Save settings")
        self.save_button.setObjectName("PrimaryButton")
        self.save_button.clicked.connect(self.save_settings)
        buttons.addStretch()
        buttons.addWidget(self.test_bridge_button)
        buttons.addWidget(self.save_button)

        layout.addWidget(bridge_box)
        layout.addWidget(sms_box)
        layout.addLayout(buttons)
        layout.addStretch()
        return page

    def build_monitoring_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(24, 22, 24, 22)
        layout.setSpacing(16)

        hero = self.card("HeroCard")
        hero_layout = QVBoxLayout(hero)
        hero_layout.setContentsMargins(24, 22, 24, 22)
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

        monitor_card = self.card()
        monitor_layout = QGridLayout(monitor_card)
        monitor_layout.setContentsMargins(22, 20, 22, 22)
        monitor_layout.setHorizontalSpacing(18)
        monitor_layout.setVerticalSpacing(14)

        self.monitor_status_value = QLabel("Stopped")
        self.monitor_status_value.setObjectName("MonitorStatus")
        self.monitor_date_value = QLabel("")
        self.monitor_date_value.setObjectName("Muted")
        self.monitor_time_value = QLabel("")
        self.monitor_time_value.setObjectName("Muted")
        self.monitor_note_value = QLabel("")
        self.monitor_note_value.setObjectName("Muted")
        self.monitor_note_value.setWordWrap(True)

        monitor_layout.addWidget(QLabel("Status"), 0, 0)
        monitor_layout.addWidget(self.monitor_status_value, 0, 1)
        monitor_layout.addWidget(QLabel("Reminder target"), 1, 0)
        monitor_layout.addWidget(self.monitor_date_value, 1, 1)
        monitor_layout.addWidget(QLabel("Send time"), 2, 0)
        monitor_layout.addWidget(self.monitor_time_value, 2, 1)
        monitor_layout.addWidget(QLabel("Behavior"), 3, 0, Qt.AlignTop)
        monitor_layout.addWidget(self.monitor_note_value, 3, 1)

        action_row = QHBoxLayout()
        self.start_monitoring_button = QPushButton("Start Monitoring")
        self.start_monitoring_button.setObjectName("PrimaryButton")
        self.start_monitoring_button.clicked.connect(self.start_monitoring)
        self.stop_monitoring_button = QPushButton("Stop Monitoring")
        self.stop_monitoring_button.clicked.connect(self.stop_monitoring)
        action_row.addStretch()
        action_row.addWidget(self.stop_monitoring_button)
        action_row.addWidget(self.start_monitoring_button)
        monitor_layout.addLayout(action_row, 4, 0, 1, 2)

        layout.addWidget(monitor_card)
        layout.addStretch()
        return page

    def build_recall_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(24, 22, 24, 22)
        layout.setSpacing(16)

        hero = self.card("HeroCard")
        hero_layout = QVBoxLayout(hero)
        hero_layout.setContentsMargins(24, 22, 24, 22)
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
        controls.setContentsMargins(18, 14, 18, 14)
        controls.setSpacing(12)
        controls.addWidget(QLabel("Recall after"))
        self.recall_months = QSpinBox()
        self.recall_months.setRange(1, 60)
        self.recall_months.setValue(self.config.recall_months)
        self.recall_months.setSuffix(" months")
        self.recall_months.setMinimumHeight(42)
        controls.addWidget(self.recall_months)
        controls.addWidget(QLabel("Procedure codes"))
        self.recall_codes = QLineEdit(self.config.recall_codes)
        self.recall_codes.setPlaceholderText(DEFAULT_RECALL_CODES)
        self.recall_codes.setMinimumWidth(260)
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

        table_card = self.card()
        table_layout = QVBoxLayout(table_card)
        table_layout.setContentsMargins(0, 0, 0, 0)
        self.recall_table = QTableWidget(0, 10)
        self.recall_table.setHorizontalHeaderLabels(
            ["Last code visit", "Patient", "Phone", "Email", "Language", "Codes", "Sent", "Last sent", "Pat #", "Template"]
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
            },
        )
        self.recall_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.recall_table.setSelectionMode(QTableWidget.ExtendedSelection)
        self.recall_table.verticalHeader().setVisible(False)
        self.recall_table.setAlternatingRowColors(True)
        self.recall_table.setShowGrid(False)
        self.recall_table.verticalHeader().setDefaultSectionSize(46)
        table_layout.addWidget(self.recall_table)
        layout.addWidget(table_card, 1)
        return page

    def build_templates_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(24, 22, 24, 22)
        layout.setSpacing(16)

        hero = self.card("HeroCard")
        hero_layout = QVBoxLayout(hero)
        hero_layout.setContentsMargins(24, 22, 24, 22)
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
        template_layout.setContentsMargins(22, 20, 22, 22)
        template_layout.setHorizontalSpacing(14)
        template_layout.setVerticalSpacing(14)
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
        helper = QLabel("Placeholders: {salutation}, {vi_title}, {vi_salutation}, {first_name}, {last_name}, {patient_name}, {age}, {date}, {time}, {clinic_name}, {clinic_phone}, {phone}, {apt_num}, {pat_num}")
        helper.setObjectName("Muted")
        helper.setWordWrap(True)
        template_layout.addWidget(helper, 3, 1, 1, 3)
        template_actions = QHBoxLayout()
        template_actions.addStretch()
        template_actions.addWidget(self.add_template_button)
        template_actions.addWidget(self.delete_template_button)
        template_actions.addWidget(self.save_template_button)
        template_layout.addLayout(template_actions, 4, 1, 1, 3)
        layout.addWidget(template_card)
        layout.addStretch()
        self.refresh_template_controls()
        return page

    def build_logs_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(24, 22, 24, 22)
        layout.setSpacing(16)
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
        self.config.sms_templates[key] = default_template(self.config)
        self.config.sms_template_countries[key] = infer_template_country(key)
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
        if old_key != new_key:
            self.config.sms_templates.pop(old_key, None)
            self.config.sms_template_countries.pop(old_key, None)
        self.config.sms_templates[new_key] = text
        self.config.sms_template_countries[new_key] = country
        self.config.default_template_key = "US"
        self.config.sms_template = default_template(self.config)
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
        if len(self.config.sms_templates) <= 1:
            QMessageBox.warning(self, "Cannot delete", "At least one template is required.")
            return
        confirm = QMessageBox.question(self, "Delete template?", f"Delete template {key}?")
        if confirm != QMessageBox.Yes:
            return
        self.config.sms_templates.pop(key, None)
        self.config.sms_template_countries.pop(key, None)
        if "US" not in self.config.sms_templates:
            self.config.sms_templates["US"] = DEFAULT_SMS_TEMPLATES["US"]
            self.config.sms_template_countries["US"] = "US"
        self.config.default_template_key = "US"
        self.config.sms_template = default_template(self.config)
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
            self.config.recall_templates[key] = self.config.recall_templates.get("US", DEFAULT_RECALL_TEMPLATE)
            self.config.recall_template_countries[key] = infer_template_country(key)
            self.config.recall_template = self.config.recall_templates.get("US", DEFAULT_RECALL_TEMPLATE)
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
            if old_key != new_key:
                self.config.recall_templates.pop(old_key, None)
                self.config.recall_template_countries.pop(old_key, None)
            self.config.recall_templates[new_key] = body
            self.config.recall_template_countries[new_key] = country
            if "US" not in self.config.recall_templates:
                self.config.recall_templates["US"] = DEFAULT_RECALL_TEMPLATES["US"]
                self.config.recall_template_countries["US"] = "US"
            self.config.recall_template = self.config.recall_templates.get("US", DEFAULT_RECALL_TEMPLATE)
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
            self.config.recall_templates.pop(key, None)
            self.config.recall_template_countries.pop(key, None)
            self.config.recall_template = self.config.recall_templates.get("US", DEFAULT_RECALL_TEMPLATE)
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

    def save_settings(self, silent: bool = False) -> None:
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
        if hasattr(self, "recall_codes"):
            self.config.recall_codes = self.recall_codes.text().strip() or DEFAULT_RECALL_CODES
        if hasattr(self, "recall_months"):
            self.config.recall_months = self.recall_months.value()
        self.config.default_template_key = "US"
        self.config.sms_template = default_template(self.config)
        self.config.recall_template = self.config.recall_templates.get("US", DEFAULT_RECALL_TEMPLATE)
        self.config.save()
        self.repo = BridgeClient(self.config)
        self.update_dry_run_badge()
        self.update_monitoring_status()
        self.refresh_template_controls()
        self.refresh_table_template_combos()
        if not silent:
            self.statusBar().showMessage("Settings saved.", 4000)

    def test_bridge_connection(self) -> None:
        self.save_settings()
        try:
            self.repo.health_check()
            QMessageBox.information(self, "Bridge OK", "Connected to the Open Dental bridge.")
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "Bridge error", str(exc))

    def load_appointments(self) -> None:
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
        row["_TemplateText"] = self.config.recall_templates.get(key, DEFAULT_RECALL_TEMPLATE)
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

    def render_recall_patients(self) -> None:
        self.recall_template_combos = {}
        self.recall_table.setRowCount(len(self.recall_patients))
        for row_index, row in enumerate(self.recall_patients):
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
            ]
            for col, value in enumerate(values):
                if col == 9:
                    combo = QComboBox()
                    self.populate_recall_template_combo(combo, row.get("_TemplateKey") or recall_template_key_for_language(self.config, row.get("Language")))
                    self.recall_table.setCellWidget(row_index, col, combo)
                    self.recall_template_combos[row_index] = combo
                    continue
                item = QTableWidgetItem(str(value or ""))
                if col in {6, 8}:
                    item.setTextAlignment(Qt.AlignCenter)
                if int(row.get("RecallSentCount") or 0) >= 2:
                    item.setForeground(QColor("#9aa3ad"))
                self.recall_table.setItem(row_index, col, item)

    def selected_recall_patients(self) -> list[dict[str, Any]]:
        rows = sorted({index.row() for index in self.recall_table.selectedIndexes()})
        selected: list[dict[str, Any]] = []
        for row in rows:
            patient = dict(self.recall_patients[row])
            combo = self.recall_template_combos.get(row)
            key = str(combo.currentData() or patient.get("_TemplateKey") or "US") if combo else str(patient.get("_TemplateKey") or "US")
            patient["_TemplateKey"] = key
            patient["_TemplateText"] = self.config.recall_templates.get(key) or DEFAULT_RECALL_TEMPLATE
            patient["_TemplateCountry"] = str(self.config.recall_template_countries.get(key) or infer_template_country(key)).upper()
            selected.append(patient)
        return selected

    def preview_recall_selected(self) -> None:
        self.save_settings(silent=True)
        selected = self.selected_recall_patients()
        if not selected:
            QMessageBox.information(self, "No selection", "Please select one recall patient.")
            return
        patient = selected[0]
        message = render_message(self.config, patient, patient.get("_TemplateText") or DEFAULT_RECALL_TEMPLATE)
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
        message = render_message(self.config, patient, patient.get("_TemplateText") or DEFAULT_RECALL_TEMPLATE)
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
            ]
            for col, value in enumerate(values):
                if col == 10:
                    combo = QComboBox()
                    self.populate_template_combo(combo, template_key_for_language(self.config, row.get("Language")))
                    self.appointment_table.setCellWidget(row_index, col, combo)
                    self.row_template_combos[row_index] = combo
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

    def refresh_table_template_combos(self) -> None:
        for combo in self.row_template_combos.values():
            current = str(combo.currentData() or self.config.default_template_key)
            self.populate_template_combo(combo, current)
        for combo in getattr(self, "recall_template_combos", {}).values():
            current = str(combo.currentData() or "US")
            self.populate_recall_template_combo(combo, current)

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
            self.settings.remove("last_successful_schedule_run")
            self.active_schedule_key = ""
            self.append_activity(f"Cleared dry-run logs: reminders={reminder_count}, recall={recall_count}.")
            self.append_activity("Reset today's schedule marker so monitoring can run again.")
            QMessageBox.information(
                self,
                "Dry-run logs cleared",
                f"Removed {reminder_count} appointment reminder dry-run log(s) and {recall_count} recall dry-run log(s).",
            )
            self.load_appointments()
            if hasattr(self, "recall_table"):
                self.load_recall_patients()
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
        sms_count = sum(
            len([
                target for target in appointment.get("PhoneTargets", [])
                if digits_only(target.get("phone", "")) and target.get("status") not in {"sent", "dry-run"}
            ]) or (1 if "PhoneTargets" not in appointment and digits_only(appointment.get("Phone", "")) else 0)
            for appointment in appointments
        )
        if sms_count == 0:
            if not silent:
                QMessageBox.information(self, "Nothing to send", "There are no pending phone numbers for this selection.")
            else:
                self.append_activity("No pending phone numbers for this target date.")
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
        self.active_send_kind = "recall" if appointments and appointments[0].get("_Recall") else "appointments"
        self.worker = SendWorker(self.config, appointments)
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
        self.start_monitoring_button.setEnabled(not self.monitoring_active)
        self.stop_monitoring_button.setEnabled(self.monitoring_active)

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
  font-size: 14px;
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
  padding: 16px 24px 14px 24px;
  font-weight: 700;
  border: 0;
  min-width: 112px;
}
QTabBar::tab:selected {
  color: #1359d8;
  border-bottom: 4px solid #23c7e8;
}
#HeroCard {
  border: 1px solid #e2edf3;
  border-radius: 14px;
  background: #ffffff;
}
#Card, #StatCard, QGroupBox {
  border: 1px solid #e2edf3;
  border-radius: 14px;
  background: #ffffff;
}
QGroupBox {
  margin-top: 14px;
  padding-top: 18px;
  font-size: 16px;
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
  font-size: 13px;
  font-weight: 900;
  letter-spacing: 1px;
}
#HeroTitle {
  color: #1f2933;
  font-size: 28px;
  font-weight: 900;
}
#HeroSubtitle {
  color: #647381;
  font-size: 14px;
}
#SectionTitle {
  color: #2f3742;
  font-size: 16px;
  font-weight: 800;
}
#Muted {
  color: #68717d;
}
#StatCard {
  min-height: 86px;
}
#StatValue {
  color: #1359d8;
  font-size: 30px;
  font-weight: 900;
}
#StatLabel {
  color: #68717d;
  font-size: 13px;
  font-weight: 700;
}
QPushButton {
  border: 1px solid #d8e2ea;
  border-radius: 20px;
  padding: 10px 20px;
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
#Badge {
  padding: 9px 16px;
  border-radius: 17px;
  background: #e8f2ff;
  color: #155bd8;
  font-weight: 900;
}
#Badge[mode="real"] {
  background: #fff1f0;
  color: #b42318;
}
#MonitorStatus {
  padding: 9px 14px;
  border-radius: 16px;
  background: #fff7ed;
  color: #b45309;
  font-size: 18px;
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
  border-radius: 10px;
  min-height: 22px;
  padding: 10px 12px;
  background: #ffffff;
  color: #202833;
  selection-background-color: #155bd8;
  selection-color: #ffffff;
}
QComboBox {
  border: 1px solid #d5dfe8;
  border-radius: 10px;
  min-height: 22px;
  padding: 9px 36px 9px 12px;
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
  width: 30px;
  border: 0;
  border-left: 1px solid #edf3f7;
  border-top-right-radius: 10px;
  border-bottom-right-radius: 10px;
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
  border-radius: 7px;
  padding: 4px 26px 4px 8px;
  min-height: 18px;
  background: #ffffff;
}
#TemplateCombo::drop-down {
  width: 22px;
}
#LoadingOverlay {
  background: rgba(247, 251, 253, 218);
  border: 1px solid #d8e7f0;
  border-radius: 14px;
}
#LoadingText {
  color: #1359d8;
  background: #ffffff;
  border: 1px solid #d8e7f0;
  border-radius: 18px;
  padding: 12px 22px;
  font-size: 16px;
  font-weight: 900;
}
QLineEdit:focus, QSpinBox:focus, QDateEdit:focus, QTimeEdit:focus, QTextEdit:focus, QPlainTextEdit:focus {
  border: 2px solid #23c7e8;
}
QTableWidget {
  border: 0;
  border-radius: 14px;
  background: #ffffff;
  alternate-background-color: #f8fcff;
  selection-background-color: #e4f2ff;
  selection-color: #0f3f9c;
}
QHeaderView::section {
  background: #edf9fd;
  color: #2f3742;
  padding: 12px;
  border: 0;
  font-weight: 800;
}
QTableWidget::item {
  padding: 8px;
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
    font = QFont("Segoe UI", 10)
    app.setFont(font)
    window = SmsReminderWindow()
    window.show()
    if "--start-monitoring" in sys.argv:
        QTimer.singleShot(1500, window.start_monitoring)
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
