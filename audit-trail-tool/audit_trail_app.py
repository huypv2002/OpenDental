from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import requests
from dotenv import load_dotenv
from PySide6.QtCore import QDate, QSettings, Qt, QTimer
from PySide6.QtGui import QFont, QIcon
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QDateEdit,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QStatusBar,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)


APP_DIR = Path(__file__).resolve().parent
APP_ICON_PATH = APP_DIR / "tooth.ico"
CONFIG_PATH = APP_DIR / "audit_config.json"
BRIDGE_ENV_PATH = APP_DIR.parent / ".env"

ENTRY_COLUMNS = [
    ("SecurityLogNum", "ID", False),
    ("Date", "Date", True),
    ("Time", "Time", True),
    ("Patient", "Patient", False),
    ("UserNum", "User", True),
    ("PermType", "Permission", True),
    ("CompName", "Computer", True),
    ("LogText", "Log Text", True),
    ("LogSource", "Log Source", True),
    ("DateTPrevious", "Last Edit", True),
]


def today_qdate(days: int = 0) -> QDate:
    current = date.today() + timedelta(days=days)
    return QDate(current.year, current.month, current.day)


def now_mysql() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def parse_int(value: Any, fallback: int = 0) -> int:
    try:
        return int(str(value if value is not None else "").strip())
    except ValueError:
        return fallback


def patient_name(row: dict[str, Any]) -> str:
    return " ".join(str(row.get(key) or "").strip() for key in ("FName", "LName")).strip() or f"Patient #{row.get('PatNum', '')}"


def patient_audit_label(row: dict[str, Any]) -> str:
    name = f"{str(row.get('LName') or '').strip()}, {str(row.get('FName') or '').strip()}".strip(", ")
    return f"{row.get('PatNum', '')}-{name}".strip("-")


def patient_filter_blob(row: dict[str, Any]) -> str:
    return " ".join(
        str(row.get(key) or "")
        for key in ("PatNum", "FName", "LName", "PatientName", "Phone", "WirelessPhone", "HmPhone", "WkPhone", "Email", "Birthdate")
    ).lower()


def split_datetime(value: Any) -> tuple[str, str]:
    text = str(value or "").strip().replace("T", " ")
    if not text:
        return "", ""
    if " " not in text:
        return text[:10], ""
    date_part, time_part = text.split(" ", 1)
    return date_part[:10], time_part[:8]


def join_datetime(date_text: str, time_text: str) -> str:
    date_part = str(date_text or "").strip()
    time_part = str(time_text or "").strip()
    if not date_part:
        return now_mysql()
    if not time_part:
        time_part = "00:00:00"
    if len(time_part) == 5:
        time_part = f"{time_part}:00"
    return f"{date_part} {time_part[:8]}"


@dataclass
class AppConfig:
    bridge_url: str = "http://127.0.0.1:3008"
    api_token: str = ""

    @classmethod
    def load(cls) -> "AppConfig":
        if CONFIG_PATH.exists():
            with CONFIG_PATH.open("r", encoding="utf-8") as file:
                raw = json.load(file)
            defaults = asdict(cls())
            return cls(**{**defaults, **{key: value for key, value in raw.items() if key in defaults}})
        if BRIDGE_ENV_PATH.exists():
            load_dotenv(BRIDGE_ENV_PATH)
        cfg = cls(
            bridge_url=os.getenv("BRIDGE_URL", cls.bridge_url),
            api_token=os.getenv("API_TOKEN", cls.api_token),
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

    def request(self, method: str, path: str, **kwargs) -> dict[str, Any]:
        if not self.config.bridge_url.strip():
            raise RuntimeError("Bridge URL is required.")
        if not self.config.api_token.strip():
            raise RuntimeError("Bridge API token is required.")
        response = requests.request(
            method,
            self.endpoint(path),
            headers={"Authorization": f"Bearer {self.config.api_token}"},
            timeout=30,
            **kwargs,
        )
        try:
            payload = response.json()
        except ValueError as exc:
            raise RuntimeError(f"Bridge returned non-JSON response: HTTP {response.status_code}") from exc
        if not response.ok or not payload.get("ok"):
            raise RuntimeError(payload.get("error") or f"Bridge request failed: HTTP {response.status_code}")
        return payload.get("data") or {}

    def test(self) -> None:
        self.request("GET", "/health")

    def fetch_patients(self) -> list[dict[str, Any]]:
        data = self.request("GET", "/api/audit-trail/patients", params={"limit": 5000})
        return data.get("patients") or []

    def fetch_entries(self, pat_num: int, from_date: str, to_date: str, limit: int) -> list[dict[str, Any]]:
        data = self.request(
            "GET",
            "/api/audit-trail/entries",
            params={"patNum": pat_num, "fromDate": from_date, "toDate": to_date, "limit": limit},
        )
        return data.get("entries") or []

    def save_entries(self, pat_num: int, entries: list[dict[str, Any]], delete_ids: list[int]) -> dict[str, Any]:
        return self.request(
            "POST",
            "/api/audit-trail/entries/save",
            json={"patNum": pat_num, "entries": entries, "deleteIds": delete_ids},
        )


class SettingsDialog(QDialog):
    def __init__(self, config: AppConfig, parent: QWidget | None = None):
        super().__init__(parent)
        self.setWindowTitle("Bridge Settings")
        self.setModal(True)
        layout = QVBoxLayout(self)
        form = QFormLayout()
        self.bridge_url = QLineEdit(config.bridge_url)
        self.api_token = QLineEdit(config.api_token)
        self.api_token.setEchoMode(QLineEdit.Password)
        form.addRow("Bridge URL", self.bridge_url)
        form.addRow("API token", self.api_token)
        layout.addLayout(form)
        buttons = QDialogButtonBox(QDialogButtonBox.Save | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)


class AuditTrailWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.config = AppConfig.load()
        self.repo = BridgeClient(self.config)
        self.settings = QSettings("LUK Dental", "Audit Trail Tool")
        self.all_patients: list[dict[str, Any]] = []
        self.filtered_patients: list[dict[str, Any]] = []
        self.current_patient: dict[str, Any] | None = None
        self.entries: list[dict[str, Any]] = []
        self.deleted_ids: list[int] = []
        self.dirty = False
        self.loading_table = False
        self.loading_patients = False
        self.suppress_patient_events = False

        self.setWindowTitle("Audit Trail")
        if APP_ICON_PATH.exists():
            self.setWindowIcon(QIcon(str(APP_ICON_PATH)))
        self.resize(1680, 960)
        self.setStyleSheet(APP_STYLES)
        self.setStatusBar(QStatusBar())
        self.setCentralWidget(self.build_ui())
        QTimer.singleShot(250, self.initial_load)

    def build_ui(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(6, 5, 6, 5)
        layout.setSpacing(4)

        self.title_bar = QLabel("  Audit Trail")
        self.title_bar.setObjectName("TitleBar")
        layout.addWidget(self.title_bar)
        layout.addWidget(self.build_filters())
        layout.addWidget(self.build_table(), 1)
        return page

    def build_filters(self) -> QWidget:
        panel = QFrame()
        panel.setObjectName("FilterPanel")
        grid = QGridLayout(panel)
        grid.setContentsMargins(12, 9, 12, 9)
        grid.setHorizontalSpacing(10)
        grid.setVerticalSpacing(5)

        self.from_date = QDateEdit(today_qdate(-10))
        self.from_date.setCalendarPopup(True)
        self.from_date.setDisplayFormat("MM/dd/yyyy")
        self.to_date = QDateEdit(today_qdate())
        self.to_date.setCalendarPopup(True)
        self.to_date.setDisplayFormat("MM/dd/yyyy")
        self.previous_from_date = QDateEdit(today_qdate(-20))
        self.previous_from_date.setCalendarPopup(True)
        self.previous_from_date.setDisplayFormat("MM/dd/yyyy")
        self.previous_to_date = QDateEdit(today_qdate(-10))
        self.previous_to_date.setCalendarPopup(True)
        self.previous_to_date.setDisplayFormat("MM/dd/yyyy")

        self.permission_combo = QComboBox()
        self.permission_combo.addItems(["All"])
        self.user_combo = QComboBox()
        self.user_combo.addItems(["All"])
        self.log_source_combo = QComboBox()
        self.log_source_combo.addItems(["All"])
        self.limit_rows = QSpinBox()
        self.limit_rows.setRange(1, 10000)
        self.limit_rows.setValue(500)

        self.patient_combo = QComboBox()
        self.patient_combo.setEditable(True)
        self.patient_combo.setMinimumWidth(270)
        self.patient_combo.lineEdit().setPlaceholderText("Patient name, phone, email, #")
        self.patient_combo.lineEdit().textEdited.connect(self.filter_patients_local)
        self.patient_combo.activated.connect(self.patient_combo_activated)

        self.current_button = QPushButton("Current")
        self.current_button.clicked.connect(self.load_current_patient_entries)
        self.find_button = QPushButton("Find")
        self.find_button.clicked.connect(self.find_patient_from_text)
        self.all_button = QPushButton("All")
        self.all_button.clicked.connect(self.show_all_patients)
        self.refresh_button = QPushButton("Refresh")
        self.refresh_button.clicked.connect(self.reload_entries)
        self.print_button = QPushButton("Print")
        self.print_button.clicked.connect(lambda: QMessageBox.information(self, "Print", "Print export is not wired yet."))
        self.add_button = QPushButton("Add")
        self.add_button.clicked.connect(self.add_entry_row)
        self.delete_button = QPushButton("Delete")
        self.delete_button.clicked.connect(self.delete_selected_rows)
        self.save_button = QPushButton("Save")
        self.save_button.setObjectName("PrimaryButton")
        self.save_button.clicked.connect(self.save_entries)
        self.settings_button = QPushButton("Settings")
        self.settings_button.clicked.connect(self.open_settings)
        self.dirty_badge = QLabel("Saved")
        self.dirty_badge.setObjectName("DirtyBadge")
        patient_actions = QWidget()
        patient_actions.setObjectName("InlineActions")
        patient_actions_layout = QHBoxLayout(patient_actions)
        patient_actions_layout.setContentsMargins(0, 0, 0, 0)
        patient_actions_layout.setSpacing(8)
        patient_actions_layout.addWidget(self.current_button)
        patient_actions_layout.addWidget(self.find_button)
        patient_actions_layout.addWidget(self.all_button)
        patient_actions_layout.addStretch()

        grid.addWidget(QLabel("From Date"), 0, 0)
        grid.addWidget(self.from_date, 0, 1)
        grid.addWidget(QLabel("Permission"), 0, 2)
        grid.addWidget(self.permission_combo, 0, 3)
        grid.addWidget(QLabel("Patient"), 0, 4)
        grid.addWidget(self.patient_combo, 0, 5)
        grid.addWidget(QLabel("Previous From Date"), 0, 7)
        grid.addWidget(self.previous_from_date, 0, 8)
        grid.addWidget(self.refresh_button, 0, 9)
        grid.addWidget(self.add_button, 0, 10)
        grid.addWidget(self.delete_button, 0, 11)
        grid.addWidget(self.save_button, 0, 12)

        grid.addWidget(QLabel("To Date"), 1, 0)
        grid.addWidget(self.to_date, 1, 1)
        grid.addWidget(QLabel("User"), 1, 2)
        grid.addWidget(self.user_combo, 1, 3)
        grid.addWidget(patient_actions, 1, 5, 1, 3)
        grid.addWidget(QLabel("To Date"), 1, 8)
        grid.addWidget(self.previous_to_date, 1, 9)
        grid.addWidget(QLabel("Limit Rows"), 1, 10)
        grid.addWidget(self.limit_rows, 1, 11)
        grid.addWidget(self.print_button, 1, 12)

        grid.addWidget(QLabel("LogSource"), 2, 0)
        grid.addWidget(self.log_source_combo, 2, 1)
        grid.addWidget(self.settings_button, 2, 11)
        grid.addWidget(self.dirty_badge, 2, 12)
        grid.setColumnStretch(5, 1)
        return panel

    def build_table(self) -> QWidget:
        panel = QFrame()
        panel.setObjectName("TablePanel")
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        header = QLabel("Audit Trail")
        header.setObjectName("GridTitle")
        header.setAlignment(Qt.AlignCenter)
        layout.addWidget(header)

        self.table = QTableWidget(0, len(ENTRY_COLUMNS))
        self.table.setHorizontalHeaderLabels([label for _key, label, _editable in ENTRY_COLUMNS])
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        self.table.setSelectionMode(QTableWidget.ExtendedSelection)
        self.table.setAlternatingRowColors(False)
        self.table.setShowGrid(True)
        self.table.verticalHeader().setVisible(False)
        self.table.verticalHeader().setDefaultSectionSize(24)
        self.table.verticalHeader().setMinimumSectionSize(22)
        self.table.itemChanged.connect(self.table_item_changed)
        self.configure_columns()
        layout.addWidget(self.table, 1)

        self.footer_text = QLabel("Loading patients...")
        self.footer_text.setObjectName("Footer")
        layout.addWidget(self.footer_text)
        return panel

    def configure_columns(self) -> None:
        widths = [0, 78, 82, 220, 90, 180, 100, 420, 150, 180]
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(QHeaderView.Interactive)
        header.setSectionResizeMode(7, QHeaderView.Stretch)
        for index, width in enumerate(widths):
            self.table.setColumnWidth(index, width)
        self.table.setColumnHidden(0, True)

    def initial_load(self) -> None:
        self.load_patients()

    def set_busy(self, text: str) -> None:
        QApplication.setOverrideCursor(Qt.WaitCursor)
        self.statusBar().showMessage(text)

    def clear_busy(self) -> None:
        QApplication.restoreOverrideCursor()

    def open_settings(self) -> None:
        dialog = SettingsDialog(self.config, self)
        if dialog.exec() != QDialog.Accepted:
            return
        self.config.bridge_url = dialog.bridge_url.text().strip()
        self.config.api_token = dialog.api_token.text().strip()
        self.config.save()
        self.repo = BridgeClient(self.config)
        self.statusBar().showMessage("Settings saved.", 4000)
        self.load_patients()

    def ensure_clean_before_change(self) -> bool:
        if not self.dirty:
            return True
        choice = QMessageBox.question(
            self,
            "Unsaved audit changes",
            "You have unsaved changes in the audit grid. Save before continuing?",
            QMessageBox.Save | QMessageBox.Discard | QMessageBox.Cancel,
            QMessageBox.Save,
        )
        if choice == QMessageBox.Save:
            return self.save_entries()
        if choice == QMessageBox.Discard:
            self.set_dirty(False)
            return True
        return False

    def load_patients(self) -> None:
        if not self.ensure_clean_before_change():
            return
        try:
            self.loading_patients = True
            self.set_busy("Loading patients...")
            self.all_patients = self.repo.fetch_patients()
            self.filtered_patients = list(self.all_patients)
            self.populate_patient_combo(self.filtered_patients)
            self.statusBar().showMessage(f"Loaded {len(self.all_patients)} patient(s). Search filters locally.", 6000)
            self.footer_text.setText(f"Loaded {len(self.all_patients)} patient(s). Select a patient to load audit entries.")
            if self.filtered_patients:
                self.patient_combo.setCurrentIndex(0)
                self.set_current_patient(self.filtered_patients[0], load_entries=True)
        except Exception as exc:
            QMessageBox.warning(self, "Patient load error", str(exc))
            self.footer_text.setText("Patient load failed. Check Settings and bridge connection.")
        finally:
            self.loading_patients = False
            self.clear_busy()

    def populate_patient_combo(self, patients: list[dict[str, Any]], preserve_text: str = "") -> None:
        self.suppress_patient_events = True
        self.patient_combo.clear()
        for patient in patients:
            self.patient_combo.addItem(patient_audit_label(patient), patient)
        if preserve_text:
            self.patient_combo.setEditText(preserve_text)
        self.suppress_patient_events = False

    def filter_patients_local(self, text: str) -> None:
        query = str(text or "").strip().lower()
        self.filtered_patients = [patient for patient in self.all_patients if not query or query in patient_filter_blob(patient)]
        self.populate_patient_combo(self.filtered_patients[:500], preserve_text=text)
        self.footer_text.setText(f"{len(self.filtered_patients)} patient(s) match. Press Find or choose one from the list.")

    def show_all_patients(self) -> None:
        self.patient_combo.lineEdit().clear()
        self.filtered_patients = list(self.all_patients)
        self.populate_patient_combo(self.filtered_patients[:500])
        self.footer_text.setText(f"Showing all loaded patients: {len(self.all_patients)}.")

    def selected_patient_from_combo(self) -> dict[str, Any] | None:
        data = self.patient_combo.currentData()
        return data if isinstance(data, dict) else None

    def patient_combo_activated(self, _index: int) -> None:
        if self.suppress_patient_events or self.loading_patients:
            return
        patient = self.selected_patient_from_combo()
        if patient:
            self.set_current_patient(patient, load_entries=True)

    def find_patient_from_text(self) -> None:
        if not self.filtered_patients:
            QMessageBox.information(self, "No patient", "No loaded patient matches that filter.")
            return
        patient = self.selected_patient_from_combo() or self.filtered_patients[0]
        self.set_current_patient(patient, load_entries=True)

    def load_current_patient_entries(self) -> None:
        patient = self.current_patient or self.selected_patient_from_combo()
        if not patient:
            QMessageBox.information(self, "No patient", "Please select a patient first.")
            return
        self.set_current_patient(patient, load_entries=True)

    def set_current_patient(self, patient: dict[str, Any], load_entries: bool = False) -> None:
        if self.current_patient and self.current_patient.get("PatNum") == patient.get("PatNum") and load_entries:
            self.reload_entries()
            return
        if not self.ensure_clean_before_change():
            return
        self.current_patient = patient
        self.suppress_patient_events = True
        self.patient_combo.setEditText(patient_audit_label(patient))
        self.suppress_patient_events = False
        if load_entries:
            self.reload_entries()

    def current_date_range(self) -> tuple[str, str]:
        return self.from_date.date().toString("yyyy-MM-dd"), self.to_date.date().toString("yyyy-MM-dd")

    def reload_entries(self) -> None:
        if not self.current_patient:
            QMessageBox.information(self, "No patient", "Please select a patient first.")
            return
        if not self.ensure_clean_before_change():
            return
        pat_num = parse_int(self.current_patient.get("PatNum"))
        from_date, to_date = self.current_date_range()
        try:
            self.set_busy("Loading audit trail...")
            self.entries = self.repo.fetch_entries(pat_num, from_date, to_date, self.limit_rows.value())
            self.deleted_ids = []
            self.render_entries()
            self.set_dirty(False)
            self.statusBar().showMessage(f"Loaded {len(self.entries)} audit row(s) for {patient_audit_label(self.current_patient)}.", 6000)
        except Exception as exc:
            QMessageBox.warning(self, "Load error", str(exc))
        finally:
            self.clear_busy()

    def entry_to_display_row(self, entry: dict[str, Any]) -> dict[str, Any]:
        date_text, time_text = split_datetime(entry.get("LogDateTime"))
        return {
            "SecurityLogNum": entry.get("SecurityLogNum", ""),
            "Date": date_text,
            "Time": time_text,
            "Patient": patient_audit_label(self.current_patient or {}),
            "UserNum": entry.get("UserNum", ""),
            "PermType": entry.get("PermType", ""),
            "CompName": entry.get("CompName", ""),
            "LogText": entry.get("LogText", ""),
            "LogSource": entry.get("LogSource", ""),
            "DateTPrevious": entry.get("DateTPrevious", ""),
        }

    def render_entries(self) -> None:
        self.loading_table = True
        self.table.setRowCount(len(self.entries))
        for row_index, entry in enumerate(self.entries):
            display_row = self.entry_to_display_row(entry)
            for col_index, (key, _label, editable) in enumerate(ENTRY_COLUMNS):
                item = QTableWidgetItem(str(display_row.get(key, "") or ""))
                flags = item.flags()
                if not editable:
                    flags &= ~Qt.ItemIsEditable
                item.setFlags(flags)
                self.table.setItem(row_index, col_index, item)
        self.loading_table = False
        patient = patient_audit_label(self.current_patient or {}) or "No patient"
        self.footer_text.setText(f"{len(self.entries)} audit row(s) for {patient}. Deleted pending: {len(self.deleted_ids)}.")

    def row_to_entry(self, row_index: int) -> dict[str, Any]:
        row: dict[str, Any] = {}
        for col_index, (key, _label, _editable) in enumerate(ENTRY_COLUMNS):
            item = self.table.item(row_index, col_index)
            row[key] = item.text().strip() if item else ""
        return {
            "SecurityLogNum": row.get("SecurityLogNum", ""),
            "LogDateTime": join_datetime(row.get("Date", ""), row.get("Time", "")),
            "PermType": row.get("PermType", ""),
            "UserNum": row.get("UserNum", ""),
            "FKey": 0,
            "LogText": row.get("LogText", ""),
            "LogSource": row.get("LogSource", ""),
            "CompName": row.get("CompName", ""),
            "DateTPrevious": row.get("DateTPrevious", ""),
        }

    def add_entry_row(self) -> None:
        if not self.current_patient:
            QMessageBox.information(self, "No patient", "Please select a patient first.")
            return
        self.entries.insert(0, {
            "SecurityLogNum": "",
            "LogDateTime": now_mysql(),
            "PermType": 0,
            "UserNum": 0,
            "FKey": 0,
            "LogText": "",
            "LogSource": "",
            "CompName": os.environ.get("COMPUTERNAME") or os.environ.get("HOSTNAME") or "",
            "DateTPrevious": "",
        })
        self.render_entries()
        self.table.selectRow(0)
        self.table.setCurrentCell(0, 7)
        self.set_dirty(True)

    def delete_selected_rows(self) -> None:
        rows = sorted({index.row() for index in self.table.selectedIndexes()}, reverse=True)
        if not rows:
            QMessageBox.information(self, "No selection", "Please select one or more audit rows to delete.")
            return
        if QMessageBox.question(self, "Delete rows", f"Delete {len(rows)} selected audit row(s)?", QMessageBox.Yes | QMessageBox.No, QMessageBox.No) != QMessageBox.Yes:
            return
        for row in rows:
            entry = self.row_to_entry(row)
            security_log_num = parse_int(entry.get("SecurityLogNum"))
            if security_log_num:
                self.deleted_ids.append(security_log_num)
            if 0 <= row < len(self.entries):
                self.entries.pop(row)
        self.render_entries()
        self.set_dirty(True)

    def table_item_changed(self, _item: QTableWidgetItem) -> None:
        if self.loading_table:
            return
        self.entries = [self.row_to_entry(row) for row in range(self.table.rowCount())]
        self.set_dirty(True)

    def set_dirty(self, value: bool) -> None:
        self.dirty = value
        self.dirty_badge.setText("Unsaved" if value else "Saved")
        self.dirty_badge.setProperty("dirty", "true" if value else "false")
        self.dirty_badge.style().unpolish(self.dirty_badge)
        self.dirty_badge.style().polish(self.dirty_badge)
        if hasattr(self, "footer_text"):
            self.footer_text.setText(f"{self.table.rowCount()} visible audit row(s). Deleted pending: {len(self.deleted_ids)}.")

    def validate_entries(self) -> bool:
        for row_index in range(self.table.rowCount()):
            raw = self.row_to_entry(row_index)
            if not raw.get("LogText", "").strip():
                QMessageBox.warning(self, "Missing Log Text", f"Row {row_index + 1} needs Log Text before saving.")
                self.table.setCurrentCell(row_index, 7)
                return False
            if parse_int(raw.get("PermType"), None) is None:
                QMessageBox.warning(self, "Invalid Permission", f"Row {row_index + 1} Permission must be a number.")
                self.table.setCurrentCell(row_index, 5)
                return False
        return True

    def save_entries(self) -> bool:
        if not self.current_patient:
            QMessageBox.information(self, "No patient", "Please select a patient first.")
            return False
        if not self.validate_entries():
            return False
        pat_num = parse_int(self.current_patient.get("PatNum"))
        entries = [self.row_to_entry(row) for row in range(self.table.rowCount())]
        try:
            self.set_busy("Saving audit trail...")
            result = self.repo.save_entries(pat_num, entries, self.deleted_ids)
            from_date, to_date = self.current_date_range()
            self.entries = self.repo.fetch_entries(pat_num, from_date, to_date, self.limit_rows.value())
            self.deleted_ids = []
            self.render_entries()
            self.set_dirty(False)
            self.statusBar().showMessage(
                f"Saved. Created {result.get('created', 0)}, updated {result.get('updated', 0)}, deleted {result.get('deleted', 0)}.",
                6000,
            )
            return True
        except Exception as exc:
            QMessageBox.warning(self, "Save error", str(exc))
            return False
        finally:
            self.clear_busy()

    def closeEvent(self, event) -> None:  # noqa: N802
        if not self.dirty:
            event.accept()
            return
        choice = QMessageBox.question(
            self,
            "Unsaved audit changes",
            "You have unsaved changes in the audit grid. Save before closing?",
            QMessageBox.Save | QMessageBox.Discard | QMessageBox.Cancel,
            QMessageBox.Save,
        )
        if choice == QMessageBox.Save and self.save_entries():
            event.accept()
        elif choice == QMessageBox.Discard:
            event.accept()
        else:
            event.ignore()


APP_STYLES = """
* {
  background: #f2f4f8;
  color: #111827;
  font-family: "Segoe UI", Arial, sans-serif;
  font-size: 10px;
  font-weight: 400;
}
QMainWindow {
  background: #f2f4f8;
}
#TitleBar {
  background: #385a9e;
  color: #ffffff;
  border: 1px solid #27437a;
  min-height: 22px;
  font-size: 10px;
}
#FilterPanel, #InlineActions {
  background: #f7f8fb;
  border-left: 1px solid #c7cfdb;
  border-right: 1px solid #c7cfdb;
}
QLabel {
  background: transparent;
}
QLineEdit, QComboBox, QDateEdit, QSpinBox {
  border: 1px solid #b8c0ca;
  border-radius: 1px;
  min-height: 20px;
  padding: 1px 5px;
  background: #ffffff;
  color: #111827;
}
QComboBox::drop-down, QDateEdit::drop-down, QSpinBox::up-button, QSpinBox::down-button {
  width: 18px;
  border-left: 1px solid #c9d0d8;
  background: #eef2f7;
}
QPushButton {
  border: 1px solid #9aa7b7;
  border-radius: 3px;
  padding: 3px 12px;
  min-height: 20px;
  background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 #ffffff, stop:1 #e5e9ef);
  color: #111827;
}
QPushButton:hover {
  border-color: #5278b8;
  background: #eef5ff;
}
#PrimaryButton {
  border-color: #4267a8;
  background: #dfeaff;
  color: #0f2f65;
}
#DirtyBadge {
  padding: 3px 10px;
  border: 1px solid #b7d8bd;
  background: #eaf7ed;
  color: #17612a;
}
#DirtyBadge[dirty="true"] {
  border-color: #e4c56a;
  background: #fff7d7;
  color: #8a5b00;
}
#TablePanel {
  background: #ffffff;
  border: 1px solid #8799b8;
}
#GridTitle {
  color: #ffffff;
  background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 #6f8dc7, stop:1 #2f5597);
  border-bottom: 1px solid #2e4778;
  min-height: 18px;
  font-weight: 700;
}
QTableWidget {
  border: 0;
  gridline-color: #d9dde4;
  background: #ffffff;
  alternate-background-color: #ffffff;
  selection-background-color: #b7d4e8;
  selection-color: #111827;
}
QHeaderView::section {
  background: #e9f0f7;
  color: #111827;
  padding: 2px 4px;
  border: 0;
  border-right: 1px solid #c8ced7;
  border-bottom: 1px solid #aeb7c5;
  font-weight: 600;
}
QTableWidget::item {
  padding: 1px 3px;
}
#Footer, QStatusBar {
  background: #eef2f7;
  color: #4b5563;
  border-top: 1px solid #d2d8e1;
  padding: 3px 6px;
}
"""


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("LUK Dental Audit Trail Tool")
    if APP_ICON_PATH.exists():
        app.setWindowIcon(QIcon(str(APP_ICON_PATH)))
    app.setFont(QFont("Segoe UI", 8))
    window = AuditTrailWindow()
    window.showMaximized()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
