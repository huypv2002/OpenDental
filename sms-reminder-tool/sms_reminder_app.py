from __future__ import annotations

import json
import os
import platform
import re
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import pyperclip
import requests
from dotenv import load_dotenv
from PySide6.QtCore import QDate, QSettings, QThread, QTime, QTimer, Signal, Qt
from PySide6.QtGui import QColor, QFont
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDateEdit,
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
    QSplitter,
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
CONFIG_PATH = APP_DIR / "sms_config.json"
BRIDGE_ENV_PATH = APP_DIR.parent / ".env"
CLINIC_TIME_ZONE_NOTE = "Use this app on the clinic server set to Houston/Central time."


DEFAULT_SMS_TEMPLATES = {
    "US": (
        "Hi {first_name}, this is {clinic_name} reminding you of your appointment "
        "on {date} at {time}. Please call {clinic_phone} if you need to change anything."
    ),
    "ES": (
        "Hola {first_name}, le recordamos su cita con {clinic_name} el {date} a las {time}. "
        "Llame al {clinic_phone} si necesita cambiar algo."
    ),
    "VI": (
        "Xin chao {first_name}, {clinic_name} xin nhac lich hen cua ban vao {date} luc {time}. "
        "Vui long goi {clinic_phone} neu can thay doi."
    ),
}


def digits_only(value: str) -> str:
    digits = re.sub(r"\D+", "", value or "")
    return digits[1:] if len(digits) == 11 and digits.startswith("1") else digits


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


@dataclass
class AppConfig:
    bridge_url: str = "http://127.0.0.1:3008"
    api_token: str = ""
    clinic_name: str = "LUK Dental"
    clinic_phone: str = "281-760-1357"
    reminder_days_ahead: int = 1
    scheduled_send_time: str = "09:00"
    appointment_statuses: list[int] = field(default_factory=lambda: [1])
    fallback_duration_minutes: int = 30
    dry_run: bool = True
    scheduler_enabled: bool = True
    default_template_key: str = "US"
    sms_templates: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_SMS_TEMPLATES))
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
            if not cfg.sms_templates:
                cfg.sms_templates = dict(DEFAULT_SMS_TEMPLATES)
            if "sms_template" in raw and raw.get("sms_template") and not raw.get("sms_templates"):
                cfg.sms_templates["US"] = str(raw["sms_template"])
            if cfg.default_template_key not in cfg.sms_templates:
                cfg.default_template_key = next(iter(cfg.sms_templates), "US")
            return cfg
        if BRIDGE_ENV_PATH.exists():
            load_dotenv(BRIDGE_ENV_PATH)
        defaults = cls()
        cfg = cls(
            bridge_url=os.getenv("BRIDGE_URL", defaults.bridge_url),
            api_token=os.getenv("API_TOKEN", defaults.api_token),
            clinic_name=os.getenv("CLINIC_NAME", defaults.clinic_name),
        )
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

    def log_result(self, appointment: dict[str, Any], message: str, status: str, error: str = "") -> None:
        apt_time = parse_datetime(appointment.get("AptDateTime"))
        self.request(
            "POST",
            "/api/sms-reminders/log",
            json={
                "aptNum": appointment["AptNum"],
                "patNum": appointment["PatNum"],
                "phone": appointment.get("Phone", ""),
                "reminderForDate": apt_time.date().isoformat(),
                "message": message,
                "status": status,
                "errorMessage": error,
            },
        )

    def fetch_recent_logs(self, limit: int = 200) -> list[dict[str, Any]]:
        data = self.request("GET", "/api/sms-reminders/logs", params={"limit": limit})
        return data.get("logs") or []


class PhoneLinkSender:
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
            from pywinauto.keyboard import send_keys
        except ImportError as exc:
            raise RuntimeError("pywinauto is not installed. Run: pip install -r requirements.txt") from exc

        self.open_phone_link()
        time.sleep(3)

        desktop = Desktop(backend="uia")
        window = desktop.window(title_re=".*(Phone Link|Liên kết Điện thoại|Messages).*")
        if not window.exists(timeout=10):
            app = Application(backend="uia").connect(title_re=".*Phone Link.*", timeout=10)
            window = app.top_window()

        window.set_focus()
        send_keys("^n")
        time.sleep(1)
        pyperclip.copy(phone)
        send_keys("^v")
        send_keys("{ENTER}")
        time.sleep(1.25)
        send_keys("{TAB 2}")
        time.sleep(0.5)
        pyperclip.copy(message)
        send_keys("^v")
        send_keys("{ENTER}")
        time.sleep(0.5)


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
            phone = appointment.get("Phone", "")
            if not digits_only(phone):
                failed += 1
                repo.log_result(appointment, message, "failed", "Missing patient phone number.")
                self.progress.emit(f"Failed: {patient} has no phone number.")
                continue
            try:
                sender.send_sms(phone, message)
                status = "dry-run" if self.config.dry_run else "sent"
                repo.log_result(appointment, message, status)
                sent += 1
                self.progress.emit(f"{status.upper()}: {patient} -> {phone}")
            except Exception as exc:  # noqa: BLE001 - show UI-friendly automation errors
                failed += 1
                repo.log_result(appointment, message, "failed", str(exc))
                self.progress.emit(f"Failed: {patient} -> {exc}")
        self.finished.emit(sent, failed)


def patient_name(row: dict[str, Any]) -> str:
    return " ".join(str(row.get(key) or "").strip() for key in ("FName", "LName")).strip() or f"Patient #{row.get('PatNum', '')}"


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


def render_message(config: AppConfig, row: dict[str, Any], template: str) -> str:
    apt_time = row.get("AptDateTime")
    first_name = str(row.get("FName") or "").strip() or "there"
    return template.format(
        clinic_name=config.clinic_name,
        clinic_phone=config.clinic_phone,
        first_name=first_name,
        last_name=str(row.get("LName") or "").strip(),
        patient_name=patient_name(row),
        date=display_date(apt_time),
        time=display_time(apt_time),
        phone=row.get("Phone", ""),
        apt_num=row.get("AptNum", ""),
        pat_num=row.get("PatNum", ""),
    )


class SmsReminderWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.config = AppConfig.load()
        self.repo = BridgeClient(self.config)
        self.appointments: list[dict[str, Any]] = []
        self.worker: SendWorker | None = None
        self.row_template_combos: dict[int, QComboBox] = {}
        self.suppress_auto_load = False
        self.settings = QSettings("LUK Dental", "SMS Reminder Tool")

        self.setWindowTitle("LUK Dental SMS Reminder Tool")
        self.resize(1540, 920)
        self.setStyleSheet(APP_STYLES)

        self.tabs = QTabWidget()
        self.tabs.setObjectName("AppTabs")
        self.setCentralWidget(self.tabs)
        self.setStatusBar(QStatusBar())
        self.tabs.addTab(self.build_dashboard_tab(), "Dashboard")
        self.tabs.addTab(self.build_templates_tab(), "Templates")
        self.tabs.addTab(self.build_settings_tab(), "Settings")
        self.tabs.addTab(self.build_logs_tab(), "Logs")

        self.scheduler_timer = QTimer(self)
        self.scheduler_timer.timeout.connect(self.check_schedule)
        self.scheduler_timer.start(60_000)
        self.update_dry_run_badge()
        if self.config.bridge_url and self.config.api_token:
            self.load_appointments()
        else:
            self.statusBar().showMessage("Set Bridge URL and API token in Settings before loading appointments.", 6000)

    def card(self, object_name: str = "Card") -> QFrame:
        frame = QFrame()
        frame.setObjectName(object_name)
        return frame

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
        self.date_edit = QDateEdit(QDate.currentDate().addDays(self.config.reminder_days_ahead))
        self.date_edit.setCalendarPopup(True)
        self.date_edit.setDisplayFormat("MM/dd/yyyy")
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
        controls.addWidget(self.preview_button)
        controls.addWidget(self.open_phone_button)
        controls.addWidget(self.test_sms_button)
        controls.addWidget(self.send_selected_button)
        controls.addWidget(self.send_all_button)
        layout.addWidget(controls_card)

        search_card = self.card()
        search_layout = QHBoxLayout(search_card)
        search_layout.setContentsMargins(18, 12, 18, 12)
        search_layout.addWidget(QLabel("Search"))
        self.search_edit = QLineEdit()
        self.search_edit.setPlaceholderText("Patient, phone, email, appointment #, procedure...")
        self.search_edit.textChanged.connect(self.apply_appointment_filter)
        search_layout.addWidget(self.search_edit)
        layout.addWidget(search_card)

        splitter = QSplitter(Qt.Vertical)
        splitter.setObjectName("MainSplitter")
        table_card = self.card()
        table_layout = QVBoxLayout(table_card)
        table_layout.setContentsMargins(0, 0, 0, 0)
        self.appointment_table = QTableWidget(0, 10)
        self.appointment_table.setHorizontalHeaderLabels(
            ["Status", "Time", "Patient", "Phone", "Email", "Apt #", "Pat #", "Reminder", "Template", "Procedure"]
        )
        self.appointment_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.appointment_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.appointment_table.setSelectionMode(QTableWidget.ExtendedSelection)
        self.appointment_table.verticalHeader().setVisible(False)
        self.appointment_table.setAlternatingRowColors(True)
        self.appointment_table.setShowGrid(False)
        table_layout.addWidget(self.appointment_table)
        splitter.addWidget(table_card)

        bottom = QWidget()
        bottom_layout = QGridLayout(bottom)
        bottom_layout.setContentsMargins(0, 0, 0, 0)
        bottom_layout.setHorizontalSpacing(16)
        template_card = self.card()
        template_layout = QVBoxLayout(template_card)
        template_layout.setContentsMargins(18, 16, 18, 18)
        template_title = QLabel("Default SMS template preview")
        template_title.setObjectName("SectionTitle")
        self.template_edit = QTextEdit()
        self.template_edit.setPlainText(default_template(self.config))
        self.template_edit.setMinimumHeight(110)
        self.template_edit.setReadOnly(True)
        template_layout.addWidget(template_title)
        template_layout.addWidget(self.template_edit)
        activity_card = self.card()
        activity_layout = QVBoxLayout(activity_card)
        activity_layout.setContentsMargins(18, 16, 18, 18)
        activity_title = QLabel("Activity")
        activity_title.setObjectName("SectionTitle")
        self.activity_log = QPlainTextEdit()
        self.activity_log.setReadOnly(True)
        activity_layout.addWidget(activity_title)
        activity_layout.addWidget(self.activity_log)
        bottom_layout.addWidget(template_card, 0, 0)
        bottom_layout.addWidget(activity_card, 0, 1)
        splitter.addWidget(bottom)
        splitter.setSizes([440, 220])
        layout.addWidget(splitter)
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
        self.scheduler_enabled = QCheckBox("Run daily schedule automatically while this app is open")
        self.scheduler_enabled.setChecked(self.config.scheduler_enabled)
        self.dry_run = QCheckBox("Dry run only, do not send real SMS")
        self.dry_run.setChecked(self.config.dry_run)
        self.statuses = QLineEdit(",".join(str(item) for item in self.config.appointment_statuses))
        sms_form.addRow("Clinic name", self.clinic_name)
        sms_form.addRow("Clinic phone", self.clinic_phone)
        sms_form.addRow("Reminder days ahead", self.days_ahead)
        sms_form.addRow("Daily send time", self.schedule_time)
        sms_form.addRow("Appointment statuses", self.statuses)
        sms_form.addRow("", self.scheduler_enabled)
        sms_form.addRow("", self.dry_run)

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
        self.template_text = QTextEdit()
        self.template_text.setMinimumHeight(220)
        self.default_template_select = QComboBox()
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
        template_layout.addWidget(QLabel("Template key / country"), 1, 0)
        template_layout.addWidget(self.template_name, 1, 1, 1, 3)
        template_layout.addWidget(QLabel("Message"), 2, 0, Qt.AlignTop)
        template_layout.addWidget(self.template_text, 2, 1, 1, 3)
        helper = QLabel("Placeholders: {first_name}, {last_name}, {patient_name}, {date}, {time}, {clinic_name}, {clinic_phone}, {phone}, {apt_num}, {pat_num}")
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
        for key in sorted(self.config.sms_templates):
            label = template_label(key)
            self.template_select.addItem(label, key)
            self.default_template_select.addItem(label, key)
        select_index = max(0, self.template_select.findData(current))
        default_index = max(0, self.default_template_select.findData(self.config.default_template_key))
        self.template_select.setCurrentIndex(select_index)
        self.default_template_select.setCurrentIndex(default_index)
        self.template_select.blockSignals(False)
        self.default_template_select.blockSignals(False)
        self.load_template_into_editor()
        if hasattr(self, "template_edit"):
            self.template_edit.setPlainText(default_template(self.config))

    def current_template_key(self) -> str:
        if not hasattr(self, "template_select"):
            return self.config.default_template_key
        return str(self.template_select.currentData() or self.template_select.currentText() or self.config.default_template_key).strip()

    def load_template_into_editor(self) -> None:
        key = self.current_template_key()
        self.template_name.setText(key)
        self.template_text.setPlainText(self.config.sms_templates.get(key, ""))

    def add_template(self) -> None:
        key, ok = QInputDialog.getText(self, "Add template", "Template key or country, for example FR:")
        if not ok:
            return
        key = key.strip().upper()
        if not key:
            return
        if key in self.config.sms_templates:
            QMessageBox.information(self, "Template exists", "That template already exists.")
            return
        self.config.sms_templates[key] = default_template(self.config)
        self.refresh_template_controls()
        index = self.template_select.findData(key)
        if index >= 0:
            self.template_select.setCurrentIndex(index)

    def save_template(self) -> None:
        old_key = self.current_template_key()
        new_key = self.template_name.text().strip().upper()
        text = self.template_text.toPlainText().strip()
        if not new_key or not text:
            QMessageBox.warning(self, "Template required", "Template key and message are required.")
            return
        if old_key != new_key:
            self.config.sms_templates.pop(old_key, None)
        self.config.sms_templates[new_key] = text
        if old_key == self.config.default_template_key:
            self.config.default_template_key = new_key
        self.config.sms_template = default_template(self.config)
        self.config.save()
        self.refresh_template_controls()
        index = self.template_select.findData(new_key)
        if index >= 0:
            self.template_select.setCurrentIndex(index)
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
        if self.config.default_template_key == key:
            self.config.default_template_key = next(iter(self.config.sms_templates))
        self.config.sms_template = default_template(self.config)
        self.config.save()
        self.refresh_template_controls()
        self.statusBar().showMessage("Template deleted.", 3000)

    def save_settings(self) -> None:
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
        self.config.scheduler_enabled = self.scheduler_enabled.isChecked()
        self.config.dry_run = self.dry_run.isChecked()
        if hasattr(self, "default_template_select"):
            self.config.default_template_key = str(self.default_template_select.currentData() or self.config.default_template_key)
        self.config.sms_template = default_template(self.config)
        self.config.save()
        self.repo = BridgeClient(self.config)
        self.update_dry_run_badge()
        self.refresh_template_controls()
        self.statusBar().showMessage("Settings saved.", 4000)

    def test_bridge_connection(self) -> None:
        self.save_settings()
        try:
            self.repo.health_check()
            QMessageBox.information(self, "Bridge OK", "Connected to the Open Dental bridge.")
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "Bridge error", str(exc))

    def load_appointments(self) -> None:
        self.save_settings()
        target = self.date_edit.date().toPython()
        try:
            self.appointments = self.repo.fetch_appointments(target)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "Load error", str(exc))
            return
        self.render_appointments()
        self.load_logs()
        self.update_dry_run_badge()
        self.statusBar().showMessage(f"Loaded {len(self.appointments)} appointments for {display_date(target)}.", 4000)

    def load_appointments_for_selected_date(self) -> None:
        if self.suppress_auto_load:
            return
        if not self.config.bridge_url or not self.config.api_token:
            return
        self.load_appointments()

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
                "",
                row.get("ProcDescript", ""),
            ]
            for col, value in enumerate(values):
                if col == 8:
                    combo = QComboBox()
                    for key in sorted(self.config.sms_templates):
                        combo.addItem(template_label(key), key)
                    default_index = combo.findData(self.config.default_template_key)
                    combo.setCurrentIndex(default_index if default_index >= 0 else 0)
                    self.appointment_table.setCellWidget(row_index, col, combo)
                    self.row_template_combos[row_index] = combo
                    continue
                item = QTableWidgetItem(str(value or ""))
                if col in {5, 6}:
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

    def appointment_with_template(self, row_index: int) -> dict[str, Any]:
        appointment = dict(self.appointments[row_index])
        combo = self.row_template_combos.get(row_index)
        key = str(combo.currentData() or self.config.default_template_key) if combo else self.config.default_template_key
        appointment["_TemplateKey"] = key
        appointment["_TemplateText"] = self.config.sms_templates.get(key) or default_template(self.config)
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
                    appointment.get("Email"),
                    appointment.get("AptNum"),
                    appointment.get("PatNum"),
                    appointment.get("ReminderStatus") or "not sent",
                    self.config.default_template_key,
                    appointment.get("ProcDescript"),
                )
            ).lower()
            self.appointment_table.setRowHidden(row_index, bool(query and query not in haystack))

    def selected_appointments(self) -> list[dict[str, Any]]:
        rows = sorted({index.row() for index in self.appointment_table.selectedIndexes()})
        return [self.appointment_with_template(row) for row in rows]

    def send_selected(self) -> None:
        selected = self.selected_appointments()
        if not selected:
            QMessageBox.information(self, "No selection", "Please select at least one appointment.")
            return
        self.start_send(selected)

    def preview_selected(self) -> None:
        selected = self.selected_appointments()
        if not selected:
            QMessageBox.information(self, "No selection", "Please select one appointment to preview.")
            return
        appointment = selected[0]
        message = render_message(self.config, appointment, appointment.get("_TemplateText") or default_template(self.config))
        QMessageBox.information(
            self,
            "SMS preview",
            f"To: {patient_name(appointment)}\nPhone: {appointment.get('Phone', '')}\n\n{message}",
        )

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

    def send_all_not_sent(self) -> None:
        pending = [
            self.appointment_with_template(row_index)
            for row_index, row in enumerate(self.appointments)
            if row.get("ReminderStatus") not in {"sent", "dry-run"}
        ]
        if not pending:
            QMessageBox.information(self, "Nothing to send", "There are no pending reminders for this date.")
            return
        self.start_send(pending)

    def start_send(self, appointments: list[dict[str, Any]]) -> None:
        if self.worker and self.worker.isRunning():
            QMessageBox.information(self, "Sending", "A send job is already running.")
            return
        if not self.config.dry_run:
            confirm = QMessageBox.question(
                self,
                "Send real SMS?",
                f"Send {len(appointments)} real SMS messages through Phone Link?",
            )
            if confirm != QMessageBox.Yes:
                return
        self.save_settings()
        self.set_send_enabled(False)
        self.worker = SendWorker(self.config, appointments)
        self.worker.progress.connect(self.append_activity)
        self.worker.finished.connect(self.send_finished)
        self.worker.start()

    def set_send_enabled(self, enabled: bool) -> None:
        self.send_selected_button.setEnabled(enabled)
        self.send_all_button.setEnabled(enabled)
        self.preview_button.setEnabled(enabled)
        self.open_phone_button.setEnabled(enabled)
        self.test_sms_button.setEnabled(enabled)

    def append_activity(self, message: str) -> None:
        self.activity_log.appendPlainText(f"[{datetime.now().strftime('%H:%M:%S')}] {message}")

    def send_finished(self, sent: int, failed: int) -> None:
        self.set_send_enabled(True)
        self.append_activity(f"Done. Sent/dry-run: {sent}. Failed: {failed}.")
        self.load_appointments()

    def load_logs(self) -> None:
        try:
            logs = self.repo.fetch_recent_logs()
        except Exception:
            return
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

    def check_schedule(self) -> None:
        if not self.config.scheduler_enabled:
            return
        if self.worker and self.worker.isRunning():
            return
        now_key = datetime.now().strftime("%Y-%m-%d %H:%M")
        target_time = self.config.scheduled_send_time
        if not now_key.endswith(f" {target_time}"):
            return
        last_run = self.settings.value("last_schedule_run", "")
        if last_run == now_key:
            return
        self.settings.setValue("last_schedule_run", now_key)
        try:
            self.suppress_auto_load = True
            self.date_edit.setDate(QDate.currentDate().addDays(self.config.reminder_days_ahead))
        finally:
            self.suppress_auto_load = False
        self.load_appointments()
        self.send_all_not_sent()


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
QLineEdit, QSpinBox, QDateEdit, QTimeEdit, QTextEdit, QPlainTextEdit {
  border: 1px solid #d5dfe8;
  border-radius: 10px;
  padding: 10px;
  background: #ffffff;
  selection-background-color: #155bd8;
}
QComboBox {
  border: 1px solid #d5dfe8;
  border-radius: 10px;
  padding: 9px 12px;
  background: #ffffff;
}
QComboBox:focus {
  border: 2px solid #23c7e8;
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
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
