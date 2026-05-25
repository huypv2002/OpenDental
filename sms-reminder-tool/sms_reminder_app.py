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

import pymysql
import pyperclip
from dotenv import load_dotenv
from PySide6.QtCore import QDate, QSettings, QThread, QTime, QTimer, Signal, Qt
from PySide6.QtGui import QColor, QFont
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
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
    QVBoxLayout,
    QWidget,
)


APP_DIR = Path(__file__).resolve().parent
CONFIG_PATH = APP_DIR / "sms_config.json"
BRIDGE_ENV_PATH = APP_DIR.parent / ".env"
LOG_TABLE = "luk_sms_reminder_log"
CLINIC_TIME_ZONE_NOTE = "Use this app on the clinic server set to Houston/Central time."


def digits_only(value: str) -> str:
    digits = re.sub(r"\D+", "", value or "")
    return digits[1:] if len(digits) == 11 and digits.startswith("1") else digits


def format_us_phone(value: str) -> str:
    digits = digits_only(value)
    if len(digits) != 10:
        return value.strip()
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


def display_time(value: datetime | str | None) -> str:
    if not value:
        return ""
    if isinstance(value, datetime):
        return value.strftime("%I:%M %p").lstrip("0")
    text = str(value)
    try:
        return datetime.strptime(text[:5], "%H:%M").strftime("%I:%M %p").lstrip("0")
    except ValueError:
        return text


def pattern_minutes(pattern: str | None, fallback: int) -> int:
    minutes = len(str(pattern or "")) * 5
    return minutes if minutes > 0 else fallback


@dataclass
class AppConfig:
    db_host: str = "127.0.0.1"
    db_port: int = 3306
    db_name: str = "opendental"
    db_user: str = "luk_booking_read"
    db_password: str = ""
    clinic_name: str = "LUK Dental"
    clinic_phone: str = "281-760-1357"
    reminder_days_ahead: int = 1
    scheduled_send_time: str = "09:00"
    appointment_statuses: list[int] = field(default_factory=lambda: [1])
    fallback_duration_minutes: int = 30
    dry_run: bool = True
    sms_template: str = (
        "Hi {first_name}, this is {clinic_name} reminding you of your appointment "
        "on {date} at {time}. Please call {clinic_phone} if you need to change anything."
    )

    @classmethod
    def load(cls) -> "AppConfig":
        if CONFIG_PATH.exists():
            with CONFIG_PATH.open("r", encoding="utf-8") as file:
                raw = json.load(file)
            return cls(**{**asdict(cls()), **raw})
        if BRIDGE_ENV_PATH.exists():
            load_dotenv(BRIDGE_ENV_PATH)
        defaults = cls()
        cfg = cls(
            db_host=os.getenv("DB_HOST", defaults.db_host),
            db_port=int(os.getenv("DB_PORT", str(defaults.db_port))),
            db_name=os.getenv("DB_NAME", defaults.db_name),
            db_user=os.getenv("DB_USER", defaults.db_user),
            db_password=os.getenv("DB_PASSWORD", defaults.db_password),
            clinic_name=os.getenv("CLINIC_NAME", defaults.clinic_name),
        )
        cfg.save()
        return cfg

    def save(self) -> None:
        CONFIG_PATH.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")


class OpenDentalRepository:
    def __init__(self, config: AppConfig):
        self.config = config

    def connect(self):
        return pymysql.connect(
            host=self.config.db_host,
            port=self.config.db_port,
            user=self.config.db_user,
            password=self.config.db_password,
            database=self.config.db_name,
            charset="utf8mb4",
            cursorclass=pymysql.cursors.DictCursor,
            autocommit=True,
            connect_timeout=8,
        )

    def ensure_log_table(self) -> None:
        with self.connect() as conn, conn.cursor() as cur:
            cur.execute(
                f"""
                CREATE TABLE IF NOT EXISTS {LOG_TABLE} (
                    ReminderLogNum BIGINT NOT NULL AUTO_INCREMENT,
                    AptNum BIGINT NOT NULL,
                    PatNum BIGINT NOT NULL,
                    Phone VARCHAR(30) NOT NULL,
                    ReminderForDate DATE NOT NULL,
                    Message TEXT NOT NULL,
                    Status VARCHAR(30) NOT NULL,
                    SentAt DATETIME NULL,
                    ErrorMessage TEXT NULL,
                    CreatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (ReminderLogNum),
                    UNIQUE KEY uq_luk_sms_reminder (AptNum, ReminderForDate)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """
            )

    def fetch_appointments(self, target_date: date) -> list[dict[str, Any]]:
        statuses = self.config.appointment_statuses or [1]
        placeholders = ",".join(["%s"] * len(statuses))
        next_date = target_date + timedelta(days=1)
        with self.connect() as conn, conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT
                    a.AptNum,
                    a.PatNum,
                    a.AptDateTime,
                    a.Pattern,
                    a.AptStatus,
                    a.ProcDescript,
                    p.FName,
                    p.LName,
                    p.WirelessPhone,
                    p.HmPhone,
                    p.WkPhone,
                    p.Email,
                    p.Birthdate,
                    COALESCE(l.Status, '') AS ReminderStatus,
                    l.SentAt AS ReminderSentAt,
                    l.ErrorMessage AS ReminderError
                FROM appointment a
                INNER JOIN patient p ON p.PatNum = a.PatNum
                LEFT JOIN {LOG_TABLE} l
                  ON l.AptNum = a.AptNum
                 AND l.ReminderForDate = DATE(a.AptDateTime)
                WHERE a.AptDateTime >= %s
                  AND a.AptDateTime < %s
                  AND a.AptStatus IN ({placeholders})
                ORDER BY a.AptDateTime, p.LName, p.FName
                """,
                [f"{target_date.isoformat()} 00:00:00", f"{next_date.isoformat()} 00:00:00", *statuses],
            )
            rows = cur.fetchall()

        for row in rows:
            row["Phone"] = format_us_phone(row.get("WirelessPhone") or row.get("HmPhone") or row.get("WkPhone") or "")
            row["DurationMinutes"] = pattern_minutes(row.get("Pattern"), self.config.fallback_duration_minutes)
        return rows

    def log_result(self, appointment: dict[str, Any], message: str, status: str, error: str = "") -> None:
        apt_time = appointment["AptDateTime"]
        reminder_date = apt_time.date() if isinstance(apt_time, datetime) else datetime.fromisoformat(str(apt_time)).date()
        with self.connect() as conn, conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO {LOG_TABLE}
                    (AptNum, PatNum, Phone, ReminderForDate, Message, Status, SentAt, ErrorMessage)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                    Phone = VALUES(Phone),
                    Message = VALUES(Message),
                    Status = VALUES(Status),
                    SentAt = VALUES(SentAt),
                    ErrorMessage = VALUES(ErrorMessage)
                """,
                [
                    appointment["AptNum"],
                    appointment["PatNum"],
                    appointment.get("Phone", ""),
                    reminder_date,
                    message,
                    status,
                    datetime.now().strftime("%Y-%m-%d %H:%M:%S") if status in {"sent", "dry-run"} else None,
                    error,
                ],
            )

    def fetch_recent_logs(self, limit: int = 200) -> list[dict[str, Any]]:
        self.ensure_log_table()
        with self.connect() as conn, conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT ReminderLogNum, AptNum, PatNum, Phone, ReminderForDate, Status, SentAt, ErrorMessage, CreatedAt
                FROM {LOG_TABLE}
                ORDER BY ReminderLogNum DESC
                LIMIT %s
                """,
                [limit],
            )
            return cur.fetchall()


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
        time.sleep(1)
        pyperclip.copy(message)
        send_keys("^v")
        send_keys("{ENTER}")
        time.sleep(0.5)


class SendWorker(QThread):
    progress = Signal(str)
    finished = Signal(int, int)

    def __init__(self, config: AppConfig, appointments: list[dict[str, Any]], template: str, demo_mode: bool = False):
        super().__init__()
        self.config = config
        self.appointments = appointments
        self.template = template
        self.demo_mode = demo_mode

    def run(self) -> None:
        repo = OpenDentalRepository(self.config)
        sender = PhoneLinkSender(self.config.dry_run)
        sent = 0
        failed = 0
        if not self.demo_mode:
            repo.ensure_log_table()
        for appointment in self.appointments:
            message = render_message(self.config, appointment, self.template)
            patient = patient_name(appointment)
            phone = appointment.get("Phone", "")
            if not digits_only(phone):
                failed += 1
                if not self.demo_mode:
                    repo.log_result(appointment, message, "failed", "Missing patient phone number.")
                self.progress.emit(f"Failed: {patient} has no phone number.")
                continue
            try:
                sender.send_sms(phone, message)
                status = "dry-run" if self.config.dry_run else "sent"
                if not self.demo_mode:
                    repo.log_result(appointment, message, status)
                sent += 1
                self.progress.emit(f"{status.upper()}: {patient} -> {phone}")
            except Exception as exc:  # noqa: BLE001 - show UI-friendly automation errors
                failed += 1
                if not self.demo_mode:
                    repo.log_result(appointment, message, "failed", str(exc))
                self.progress.emit(f"Failed: {patient} -> {exc}")
        self.finished.emit(sent, failed)


def patient_name(row: dict[str, Any]) -> str:
    return " ".join(str(row.get(key) or "").strip() for key in ("FName", "LName")).strip() or f"Patient #{row.get('PatNum', '')}"


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
        self.repo = OpenDentalRepository(self.config)
        self.appointments: list[dict[str, Any]] = []
        self.worker: SendWorker | None = None
        self.demo_mode = False
        self.settings = QSettings("LUK Dental", "SMS Reminder Tool")

        self.setWindowTitle("LUK Dental SMS Reminder Tool")
        self.resize(1320, 840)
        self.setStyleSheet(APP_STYLES)

        self.tabs = QTabWidget()
        self.tabs.setObjectName("AppTabs")
        self.setCentralWidget(self.tabs)
        self.setStatusBar(QStatusBar())
        self.tabs.addTab(self.build_dashboard_tab(), "Dashboard")
        self.tabs.addTab(self.build_settings_tab(), "Settings")
        self.tabs.addTab(self.build_logs_tab(), "Logs")

        self.scheduler_timer = QTimer(self)
        self.scheduler_timer.timeout.connect(self.check_schedule)
        self.scheduler_timer.start(60_000)
        self.load_appointments()

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
        subtitle = QLabel("Review tomorrow's Open Dental appointments, send reminder texts, and keep a MySQL audit log.")
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
        self.load_button = QPushButton("Load appointments")
        self.load_button.clicked.connect(self.load_appointments)
        self.sample_button = QPushButton("Load local demo")
        self.sample_button.clicked.connect(self.load_sample_appointments)
        self.send_selected_button = QPushButton("Send selected")
        self.send_selected_button.clicked.connect(self.send_selected)
        self.send_all_button = QPushButton("Send all not sent")
        self.send_all_button.setObjectName("PrimaryButton")
        self.send_all_button.clicked.connect(self.send_all_not_sent)
        controls.addWidget(self.date_edit)
        controls.addWidget(self.load_button)
        controls.addWidget(self.sample_button)
        controls.addStretch()
        controls.addWidget(QLabel(CLINIC_TIME_ZONE_NOTE))
        self.preview_button = QPushButton("Preview selected")
        self.preview_button.clicked.connect(self.preview_selected)
        self.open_phone_button = QPushButton("Open Phone Link")
        self.open_phone_button.clicked.connect(self.open_phone_link)
        controls.addWidget(self.preview_button)
        controls.addWidget(self.open_phone_button)
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
        self.appointment_table = QTableWidget(0, 9)
        self.appointment_table.setHorizontalHeaderLabels(
            ["Status", "Time", "Patient", "Phone", "Email", "Apt #", "Pat #", "Reminder", "Procedure"]
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
        template_title = QLabel("SMS template")
        template_title.setObjectName("SectionTitle")
        self.template_edit = QTextEdit()
        self.template_edit.setPlainText(self.config.sms_template)
        self.template_edit.setMinimumHeight(110)
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

        db_box = QGroupBox("Database")
        db_form = QFormLayout(db_box)
        db_form.setContentsMargins(20, 20, 20, 20)
        db_form.setSpacing(12)
        self.db_host = QLineEdit(self.config.db_host)
        self.db_port = QSpinBox()
        self.db_port.setRange(1, 65535)
        self.db_port.setValue(self.config.db_port)
        self.db_name = QLineEdit(self.config.db_name)
        self.db_user = QLineEdit(self.config.db_user)
        self.db_password = QLineEdit(self.config.db_password)
        self.db_password.setEchoMode(QLineEdit.Password)
        db_form.addRow("Host", self.db_host)
        db_form.addRow("Port", self.db_port)
        db_form.addRow("Database", self.db_name)
        db_form.addRow("User", self.db_user)
        db_form.addRow("Password", self.db_password)

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
        self.dry_run = QCheckBox("Dry run only, do not send real SMS")
        self.dry_run.setChecked(self.config.dry_run)
        self.statuses = QLineEdit(",".join(str(item) for item in self.config.appointment_statuses))
        sms_form.addRow("Clinic name", self.clinic_name)
        sms_form.addRow("Clinic phone", self.clinic_phone)
        sms_form.addRow("Reminder days ahead", self.days_ahead)
        sms_form.addRow("Daily send time", self.schedule_time)
        sms_form.addRow("Appointment statuses", self.statuses)
        sms_form.addRow("", self.dry_run)

        buttons = QHBoxLayout()
        self.test_db_button = QPushButton("Test DB connection")
        self.test_db_button.clicked.connect(self.test_db_connection)
        self.save_button = QPushButton("Save settings")
        self.save_button.setObjectName("PrimaryButton")
        self.save_button.clicked.connect(self.save_settings)
        buttons.addStretch()
        buttons.addWidget(self.test_db_button)
        buttons.addWidget(self.save_button)

        layout.addWidget(db_box)
        layout.addWidget(sms_box)
        layout.addLayout(buttons)
        layout.addStretch()
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

    def save_settings(self) -> None:
        try:
            statuses = [int(part.strip()) for part in self.statuses.text().split(",") if part.strip()]
        except ValueError:
            QMessageBox.warning(self, "Invalid statuses", "Appointment statuses must be comma-separated numbers.")
            return
        self.config.db_host = self.db_host.text().strip()
        self.config.db_port = self.db_port.value()
        self.config.db_name = self.db_name.text().strip()
        self.config.db_user = self.db_user.text().strip()
        self.config.db_password = self.db_password.text()
        self.config.clinic_name = self.clinic_name.text().strip()
        self.config.clinic_phone = self.clinic_phone.text().strip()
        self.config.reminder_days_ahead = self.days_ahead.value()
        self.config.scheduled_send_time = self.schedule_time.time().toString("HH:mm")
        self.config.appointment_statuses = statuses or [1]
        self.config.dry_run = self.dry_run.isChecked()
        self.config.sms_template = self.template_edit.toPlainText().strip() or AppConfig().sms_template
        self.config.save()
        self.repo = OpenDentalRepository(self.config)
        self.update_dry_run_badge()
        self.statusBar().showMessage("Settings saved.", 4000)

    def test_db_connection(self) -> None:
        self.save_settings()
        try:
            self.repo.ensure_log_table()
            QMessageBox.information(self, "Database OK", "Connected to Open Dental database and log table is ready.")
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "Database error", str(exc))

    def load_appointments(self) -> None:
        self.demo_mode = False
        self.save_settings()
        target = self.date_edit.date().toPython()
        try:
            self.repo.ensure_log_table()
            self.appointments = self.repo.fetch_appointments(target)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "Load error", str(exc))
            return
        self.render_appointments()
        self.load_logs()
        self.update_dry_run_badge()
        self.statusBar().showMessage(f"Loaded {len(self.appointments)} appointments for {display_date(target)}.", 4000)

    def load_sample_appointments(self) -> None:
        self.demo_mode = True
        self.config.dry_run = True
        if hasattr(self, "dry_run"):
            self.dry_run.setChecked(True)
        target = self.date_edit.date().toPython()
        self.appointments = sample_appointments(target)
        self.render_appointments()
        self.update_dry_run_badge()
        self.activity_log.clear()
        self.append_activity("Loaded local demo appointments. This mode does not connect to Open Dental or Phone Link.")
        self.statusBar().showMessage("Local demo loaded. Dry run only, no server connection.", 5000)

    def render_appointments(self) -> None:
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
                row.get("ProcDescript", ""),
            ]
            for col, value in enumerate(values):
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
                    appointment.get("ProcDescript"),
                )
            ).lower()
            self.appointment_table.setRowHidden(row_index, bool(query and query not in haystack))

    def selected_appointments(self) -> list[dict[str, Any]]:
        rows = sorted({index.row() for index in self.appointment_table.selectedIndexes()})
        return [self.appointments[row] for row in rows]

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
        message = render_message(self.config, appointment, self.template_edit.toPlainText())
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

    def send_all_not_sent(self) -> None:
        pending = [row for row in self.appointments if row.get("ReminderStatus") not in {"sent", "dry-run"}]
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
        self.worker = SendWorker(self.config, appointments, self.template_edit.toPlainText(), self.demo_mode)
        self.worker.progress.connect(self.append_activity)
        self.worker.finished.connect(self.send_finished)
        self.worker.start()

    def set_send_enabled(self, enabled: bool) -> None:
        self.send_selected_button.setEnabled(enabled)
        self.send_all_button.setEnabled(enabled)
        self.preview_button.setEnabled(enabled)
        self.open_phone_button.setEnabled(enabled)
        self.load_button.setEnabled(enabled)
        self.sample_button.setEnabled(enabled)

    def append_activity(self, message: str) -> None:
        self.activity_log.appendPlainText(f"[{datetime.now().strftime('%H:%M:%S')}] {message}")

    def send_finished(self, sent: int, failed: int) -> None:
        self.set_send_enabled(True)
        self.append_activity(f"Done. Sent/dry-run: {sent}. Failed: {failed}.")
        if self.demo_mode:
            for appointment in self.appointments:
                if digits_only(appointment.get("Phone", "")) and appointment.get("ReminderStatus") not in {"sent", "dry-run"}:
                    appointment["ReminderStatus"] = "dry-run"
            self.render_appointments()
            return
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
        self.date_edit.setDate(QDate.currentDate().addDays(self.config.reminder_days_ahead))
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


def sample_appointments(target_date: date) -> list[dict[str, Any]]:
    base = datetime.combine(target_date, datetime.min.time())
    rows = [
        {
            "AptNum": 9001,
            "PatNum": 1073,
            "AptDateTime": base.replace(hour=9, minute=0),
            "Pattern": "XXXXXX",
            "AptStatus": 1,
            "ProcDescript": "New patient exam",
            "FName": "Huy",
            "LName": "Pham",
            "WirelessPhone": "(281) 234-5678",
            "HmPhone": "",
            "WkPhone": "",
            "Email": "huy.demo@example.com",
            "Birthdate": date(1999, 9, 19),
            "ReminderStatus": "",
            "ReminderSentAt": None,
            "ReminderError": "",
        },
        {
            "AptNum": 9002,
            "PatNum": 1088,
            "AptDateTime": base.replace(hour=10, minute=30),
            "Pattern": "XXXXXX",
            "AptStatus": 1,
            "ProcDescript": "Cleaning",
            "FName": "Maria",
            "LName": "Lopez",
            "WirelessPhone": "(832) 372-3958",
            "HmPhone": "",
            "WkPhone": "",
            "Email": "",
            "Birthdate": date(1988, 3, 10),
            "ReminderStatus": "",
            "ReminderSentAt": None,
            "ReminderError": "",
        },
        {
            "AptNum": 9003,
            "PatNum": 1091,
            "AptDateTime": base.replace(hour=14, minute=0),
            "Pattern": "XXXXXX",
            "AptStatus": 1,
            "ProcDescript": "Treatment consult",
            "FName": "No",
            "LName": "Phone",
            "WirelessPhone": "",
            "HmPhone": "",
            "WkPhone": "",
            "Email": "missing.phone@example.com",
            "Birthdate": date(1977, 7, 7),
            "ReminderStatus": "",
            "ReminderSentAt": None,
            "ReminderError": "",
        },
    ]
    for row in rows:
        row["Phone"] = format_us_phone(row.get("WirelessPhone") or row.get("HmPhone") or row.get("WkPhone") or "")
        row["DurationMinutes"] = pattern_minutes(row.get("Pattern"), 30)
    return rows


APP_STYLES = """
QMainWindow, QWidget {
  background: #f4fbff;
  color: #252a31;
  font-family: "Google Sans", "Segoe UI", Arial, sans-serif;
  font-size: 14px;
}
QMainWindow {
  background: #f4fbff;
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
  border-bottom: 1px solid #dce8ef;
}
QTabBar::tab {
  background: transparent;
  color: #657382;
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
  border: 1px solid #d8edf7;
  border-radius: 18px;
  background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #ffffff, stop:0.62 #f8fdff, stop:1 #e7f9ff);
}
#Card, #StatCard, QGroupBox {
  border: 1px solid #dce8ef;
  border-radius: 16px;
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
  border: 1px solid #d3dde7;
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
  border-radius: 12px;
  padding: 10px;
  background: #ffffff;
  selection-background-color: #155bd8;
}
QLineEdit:focus, QSpinBox:focus, QDateEdit:focus, QTimeEdit:focus, QTextEdit:focus, QPlainTextEdit:focus {
  border: 2px solid #23c7e8;
}
QTableWidget {
  border: 0;
  border-radius: 16px;
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
