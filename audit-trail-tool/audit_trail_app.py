from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import requests
from dotenv import load_dotenv
from PySide6.QtCore import QSettings, Qt, QTimer
from PySide6.QtGui import QFont, QIcon
from PySide6.QtWidgets import (
    QApplication,
    QFrame,
    QFormLayout,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
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
    ("LogDateTime", "Date/time", True),
    ("PermType", "Perm type", True),
    ("UserNum", "User", True),
    ("FKey", "FKey", True),
    ("LogText", "Audit text", True),
    ("CompName", "Computer", True),
    ("DateTPrevious", "Previous date", True),
]


def now_mysql() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def parse_int(value: Any, fallback: int = 0) -> int:
    try:
        return int(str(value or "").strip())
    except ValueError:
        return fallback


def patient_name(row: dict[str, Any]) -> str:
    return " ".join(str(row.get(key) or "").strip() for key in ("FName", "LName")).strip() or f"Patient #{row.get('PatNum', '')}"


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
            timeout=25,
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

    def search_patients(self, query: str) -> list[dict[str, Any]]:
        data = self.request("GET", "/api/audit-trail/patients", params={"q": query.strip(), "limit": 150})
        return data.get("patients") or []

    def fetch_entries(self, pat_num: int) -> list[dict[str, Any]]:
        data = self.request("GET", "/api/audit-trail/entries", params={"patNum": pat_num, "limit": 400})
        return data.get("entries") or []

    def save_entries(self, pat_num: int, entries: list[dict[str, Any]], delete_ids: list[int]) -> dict[str, Any]:
        return self.request(
            "POST",
            "/api/audit-trail/entries/save",
            json={"patNum": pat_num, "entries": entries, "deleteIds": delete_ids},
        )


class AuditTrailWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.config = AppConfig.load()
        self.repo = BridgeClient(self.config)
        self.settings = QSettings("LUK Dental", "Audit Trail Tool")
        self.current_patient: dict[str, Any] | None = None
        self.patients: list[dict[str, Any]] = []
        self.entries: list[dict[str, Any]] = []
        self.deleted_ids: list[int] = []
        self.dirty = False
        self.loading_table = False

        self.setWindowTitle("LUK Dental Audit Trail Tool")
        if APP_ICON_PATH.exists():
            self.setWindowIcon(QIcon(str(APP_ICON_PATH)))
        self.resize(1480, 880)
        self.setStyleSheet(APP_STYLES)
        self.setStatusBar(QStatusBar())
        self.setCentralWidget(self.build_ui())
        QTimer.singleShot(250, self.initial_load)

    def card(self, object_name: str = "Card") -> QFrame:
        frame = QFrame()
        frame.setObjectName(object_name)
        return frame

    def build_ui(self) -> QWidget:
        page = QWidget()
        root = QVBoxLayout(page)
        root.setContentsMargins(14, 12, 14, 12)
        root.setSpacing(9)

        hero = self.card("HeroCard")
        hero_layout = QHBoxLayout(hero)
        hero_layout.setContentsMargins(16, 12, 16, 12)
        title_box = QVBoxLayout()
        eyebrow = QLabel("LUK DENTAL")
        eyebrow.setObjectName("Eyebrow")
        title = QLabel("Audit trail editor")
        title.setObjectName("HeroTitle")
        subtitle = QLabel("Search a patient, edit security log rows in the grid, then save all changes to Open Dental through the bridge.")
        subtitle.setObjectName("HeroSubtitle")
        title_box.addWidget(eyebrow)
        title_box.addWidget(title)
        title_box.addWidget(subtitle)
        hero_layout.addLayout(title_box)
        hero_layout.addStretch()
        self.dirty_badge = QLabel("Saved")
        self.dirty_badge.setObjectName("Badge")
        hero_layout.addWidget(self.dirty_badge)
        root.addWidget(hero)

        body = QHBoxLayout()
        body.setSpacing(12)
        body.addWidget(self.build_patient_panel(), 0)
        body.addWidget(self.build_entry_panel(), 1)
        root.addLayout(body, 1)
        return page

    def build_patient_panel(self) -> QWidget:
        panel = self.card()
        panel.setMinimumWidth(330)
        panel.setMaximumWidth(430)
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(14, 12, 14, 12)
        layout.setSpacing(8)

        heading = QLabel("Patients")
        heading.setObjectName("SectionTitle")
        layout.addWidget(heading)

        search_row = QHBoxLayout()
        self.patient_search = QLineEdit()
        self.patient_search.setPlaceholderText("Name, phone, email, patient #")
        self.patient_search.returnPressed.connect(self.search_patients)
        search_button = QPushButton("Search")
        search_button.setObjectName("PrimaryButton")
        search_button.clicked.connect(self.search_patients)
        search_row.addWidget(self.patient_search)
        search_row.addWidget(search_button)
        layout.addLayout(search_row)

        self.patient_list = QListWidget()
        self.patient_list.setObjectName("PatientList")
        self.patient_list.currentRowChanged.connect(self.patient_selected)
        layout.addWidget(self.patient_list, 1)

        self.patient_detail = QLabel("No patient selected.")
        self.patient_detail.setObjectName("Muted")
        self.patient_detail.setWordWrap(True)
        layout.addWidget(self.patient_detail)

        settings = self.card("InsetCard")
        settings_layout = QFormLayout(settings)
        settings_layout.setContentsMargins(12, 10, 12, 10)
        settings_layout.setSpacing(7)
        self.bridge_url = QLineEdit(self.config.bridge_url)
        self.api_token = QLineEdit(self.config.api_token)
        self.api_token.setEchoMode(QLineEdit.Password)
        settings_layout.addRow("Bridge URL", self.bridge_url)
        settings_layout.addRow("API token", self.api_token)
        settings_buttons = QHBoxLayout()
        test_button = QPushButton("Test")
        test_button.clicked.connect(self.test_bridge)
        save_button = QPushButton("Save settings")
        save_button.clicked.connect(self.save_settings)
        settings_buttons.addStretch()
        settings_buttons.addWidget(test_button)
        settings_buttons.addWidget(save_button)
        settings_layout.addRow(settings_buttons)
        layout.addWidget(settings)
        return panel

    def build_entry_panel(self) -> QWidget:
        panel = self.card()
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        top = QFrame()
        top.setObjectName("Toolbar")
        top_layout = QHBoxLayout(top)
        top_layout.setContentsMargins(12, 10, 12, 10)
        self.entry_title = QLabel("Audit entries")
        self.entry_title.setObjectName("SectionTitle")
        top_layout.addWidget(self.entry_title)
        top_layout.addStretch()
        self.reload_button = QPushButton("Reload")
        self.reload_button.clicked.connect(self.reload_entries)
        self.add_button = QPushButton("Add row")
        self.add_button.clicked.connect(self.add_entry_row)
        self.delete_button = QPushButton("Delete selected")
        self.delete_button.clicked.connect(self.delete_selected_rows)
        self.save_button = QPushButton("Save")
        self.save_button.setObjectName("PrimaryButton")
        self.save_button.clicked.connect(self.save_entries)
        top_layout.addWidget(self.reload_button)
        top_layout.addWidget(self.add_button)
        top_layout.addWidget(self.delete_button)
        top_layout.addWidget(self.save_button)
        layout.addWidget(top)

        self.table = QTableWidget(0, len(ENTRY_COLUMNS))
        self.table.setHorizontalHeaderLabels([label for _key, label, _editable in ENTRY_COLUMNS])
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        self.table.setSelectionMode(QTableWidget.ExtendedSelection)
        self.table.setAlternatingRowColors(True)
        self.table.setShowGrid(False)
        self.table.verticalHeader().setVisible(False)
        self.table.verticalHeader().setDefaultSectionSize(34)
        self.table.verticalHeader().setMinimumSectionSize(30)
        self.table.itemChanged.connect(self.table_item_changed)
        self.configure_columns()
        layout.addWidget(self.table, 1)

        footer = QFrame()
        footer.setObjectName("Footer")
        footer_layout = QHBoxLayout(footer)
        footer_layout.setContentsMargins(12, 8, 12, 8)
        self.footer_text = QLabel("Select a patient to load audit entries.")
        self.footer_text.setObjectName("Muted")
        footer_layout.addWidget(self.footer_text)
        footer_layout.addStretch()
        layout.addWidget(footer)
        return panel

    def configure_columns(self) -> None:
        widths = [62, 135, 78, 64, 64, 420, 110, 135]
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(QHeaderView.Interactive)
        header.setSectionResizeMode(5, QHeaderView.Stretch)
        for index, width in enumerate(widths):
            self.table.setColumnWidth(index, width)
        header.setStretchLastSection(False)

    def set_busy(self, text: str) -> None:
        QApplication.setOverrideCursor(Qt.WaitCursor)
        self.statusBar().showMessage(text)

    def clear_busy(self) -> None:
        QApplication.restoreOverrideCursor()

    def initial_load(self) -> None:
        query = self.patient_search.text().strip()
        if query:
            self.search_patients()

    def ensure_clean_before_change(self) -> bool:
        if not self.dirty:
            return True
        choice = QMessageBox.question(
            self,
            "Unsaved audit changes",
            "You have unsaved changes in the audit grid. Save before changing patient?",
            QMessageBox.Save | QMessageBox.Discard | QMessageBox.Cancel,
            QMessageBox.Save,
        )
        if choice == QMessageBox.Save:
            return self.save_entries()
        if choice == QMessageBox.Discard:
            self.set_dirty(False)
            return True
        return False

    def save_settings(self) -> None:
        self.config.bridge_url = self.bridge_url.text().strip()
        self.config.api_token = self.api_token.text().strip()
        self.config.save()
        self.repo = BridgeClient(self.config)
        self.statusBar().showMessage("Settings saved.", 4000)

    def test_bridge(self) -> None:
        self.save_settings()
        try:
            self.set_busy("Testing bridge...")
            self.repo.test()
            self.statusBar().showMessage("Bridge connection OK.", 5000)
            QMessageBox.information(self, "Bridge OK", "Bridge connection is working.")
        except Exception as exc:
            QMessageBox.warning(self, "Bridge error", str(exc))
        finally:
            self.clear_busy()

    def search_patients(self) -> None:
        if not self.ensure_clean_before_change():
            return
        self.save_settings()
        query = self.patient_search.text().strip()
        try:
            self.set_busy("Searching patients...")
            self.patients = self.repo.search_patients(query)
            self.patient_list.clear()
            for patient in self.patients:
                item = QListWidgetItem(f"{patient_name(patient)}  #{patient.get('PatNum', '')}")
                item.setData(Qt.UserRole, patient)
                item.setToolTip(f"Phone: {patient.get('Phone', '')}\nEmail: {patient.get('Email', '')}")
                self.patient_list.addItem(item)
            self.current_patient = None
            self.entries = []
            self.deleted_ids = []
            self.render_entries()
            self.patient_detail.setText(f"{len(self.patients)} patient(s) found.")
            self.statusBar().showMessage(f"Loaded {len(self.patients)} patient(s).", 5000)
        except Exception as exc:
            QMessageBox.warning(self, "Search error", str(exc))
        finally:
            self.clear_busy()

    def patient_selected(self, row: int) -> None:
        if row < 0 or row >= len(self.patients):
            return
        if self.current_patient and self.current_patient.get("PatNum") == self.patients[row].get("PatNum"):
            return
        if not self.ensure_clean_before_change():
            self.patient_list.blockSignals(True)
            previous = next((idx for idx, patient in enumerate(self.patients) if patient.get("PatNum") == self.current_patient.get("PatNum")), -1) if self.current_patient else -1
            self.patient_list.setCurrentRow(previous)
            self.patient_list.blockSignals(False)
            return
        self.current_patient = self.patients[row]
        self.patient_detail.setText(
            f"{patient_name(self.current_patient)}\n"
            f"PatNum: {self.current_patient.get('PatNum', '')}\n"
            f"Phone: {self.current_patient.get('Phone', '')}\n"
            f"Email: {self.current_patient.get('Email', '')}\n"
            f"DOB: {self.current_patient.get('Birthdate', '')}"
        )
        self.reload_entries()

    def reload_entries(self) -> None:
        if not self.current_patient:
            QMessageBox.information(self, "No patient", "Please select a patient first.")
            return
        if not self.ensure_clean_before_change():
            return
        pat_num = parse_int(self.current_patient.get("PatNum"))
        try:
            self.set_busy("Loading audit entries...")
            self.entries = self.repo.fetch_entries(pat_num)
            self.deleted_ids = []
            self.render_entries()
            self.set_dirty(False)
            self.statusBar().showMessage(f"Loaded {len(self.entries)} audit entrie(s).", 5000)
        except Exception as exc:
            QMessageBox.warning(self, "Load error", str(exc))
        finally:
            self.clear_busy()

    def render_entries(self) -> None:
        self.loading_table = True
        self.table.setRowCount(len(self.entries))
        for row_index, entry in enumerate(self.entries):
            for col_index, (key, _label, editable) in enumerate(ENTRY_COLUMNS):
                value = entry.get(key, "")
                item = QTableWidgetItem(str(value or ""))
                flags = item.flags()
                if not editable:
                    flags &= ~Qt.ItemIsEditable
                item.setFlags(flags)
                self.table.setItem(row_index, col_index, item)
        self.loading_table = False
        name = patient_name(self.current_patient or {}) if self.current_patient else "No patient"
        self.entry_title.setText(f"Audit entries - {name}")
        self.footer_text.setText(f"{len(self.entries)} visible row(s). Deleted pending: {len(self.deleted_ids)}.")

    def row_to_entry(self, row_index: int) -> dict[str, Any]:
        row: dict[str, Any] = {}
        for col_index, (key, _label, _editable) in enumerate(ENTRY_COLUMNS):
            item = self.table.item(row_index, col_index)
            row[key] = item.text().strip() if item else ""
        return row

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
            "CompName": os.environ.get("COMPUTERNAME") or os.environ.get("HOSTNAME") or "",
            "DateTPrevious": "",
        })
        self.render_entries()
        self.table.selectRow(0)
        self.table.setCurrentCell(0, 5)
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
        self.dirty_badge.setText("Unsaved changes" if value else "Saved")
        self.dirty_badge.setProperty("dirty", "true" if value else "false")
        self.dirty_badge.style().unpolish(self.dirty_badge)
        self.dirty_badge.style().polish(self.dirty_badge)
        self.footer_text.setText(f"{self.table.rowCount()} visible row(s). Deleted pending: {len(self.deleted_ids)}.")

    def validate_entries(self) -> bool:
        for row_index in range(self.table.rowCount()):
            entry = self.row_to_entry(row_index)
            if not entry.get("LogText", "").strip():
                QMessageBox.warning(self, "Missing audit text", f"Row {row_index + 1} needs Audit text before saving.")
                self.table.setCurrentCell(row_index, 5)
                return False
            if parse_int(entry.get("PermType"), None) is None:
                QMessageBox.warning(self, "Invalid Perm type", f"Row {row_index + 1} Perm type must be a number.")
                self.table.setCurrentCell(row_index, 2)
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
            self.set_busy("Saving audit entries...")
            result = self.repo.save_entries(pat_num, entries, self.deleted_ids)
            self.entries = self.repo.fetch_entries(pat_num)
            self.deleted_ids = []
            self.render_entries()
            self.set_dirty(False)
            message = f"Saved. Created {result.get('created', 0)}, updated {result.get('updated', 0)}, deleted {result.get('deleted', 0)}."
            self.statusBar().showMessage(message, 6000)
            return True
        except Exception as exc:
            QMessageBox.warning(self, "Save error", str(exc))
            return False
        finally:
            self.clear_busy()

    def closeEvent(self, event) -> None:  # noqa: N802 - Qt override name
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
  background: #f7fbfd;
  color: #202833;
  font-family: "Segoe UI", Arial, sans-serif;
  font-size: 11px;
  font-weight: 400;
}
QMainWindow {
  background: #f7fbfd;
}
QLabel {
  background: transparent;
}
#HeroCard, #Card {
  border: 1px solid #e2edf3;
  border-radius: 8px;
  background: #ffffff;
}
#InsetCard {
  border: 1px solid #e6eef4;
  border-radius: 8px;
  background: #fbfdff;
}
#Toolbar, #Footer {
  background: #ffffff;
  border: 0;
}
#Eyebrow {
  color: #1359d8;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1px;
}
#HeroTitle {
  color: #1f2933;
  font-size: 19px;
  font-weight: 700;
}
#HeroSubtitle, #Muted {
  color: #647381;
  font-size: 11px;
  font-weight: 400;
}
#SectionTitle {
  color: #2f3742;
  font-size: 12px;
  font-weight: 600;
}
#Badge {
  padding: 5px 10px;
  border-radius: 7px;
  background: #e8f8ef;
  color: #0f7b3a;
  font-weight: 600;
}
#Badge[dirty="true"] {
  background: #fff7ed;
  color: #b45309;
}
QPushButton {
  border: 1px solid #d8e2ea;
  border-radius: 7px;
  padding: 6px 11px;
  background: #ffffff;
  font-size: 11px;
  font-weight: 500;
  color: #26323f;
}
QPushButton:hover {
  background: #f0fbff;
  border-color: #25c3e6;
}
#PrimaryButton {
  background: #155bd8;
  border-color: #155bd8;
  color: #ffffff;
  font-weight: 600;
}
#PrimaryButton:hover {
  background: #0f4fc4;
  border-color: #0f4fc4;
}
QLineEdit {
  border: 1px solid #d5dfe8;
  border-radius: 7px;
  min-height: 18px;
  padding: 6px 8px;
  background: #ffffff;
  color: #202833;
  selection-background-color: #155bd8;
  selection-color: #ffffff;
}
QLineEdit:focus {
  border: 2px solid #23c7e8;
}
QListWidget {
  border: 1px solid #e2edf3;
  border-radius: 8px;
  background: #ffffff;
  alternate-background-color: #f8fcff;
  outline: 0;
}
QListWidget::item {
  padding: 8px;
  border-bottom: 1px solid #edf3f7;
  background: #ffffff;
}
QListWidget::item:selected {
  background: #e4f2ff;
  color: #0f3f9c;
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
  padding: 7px;
  border: 0;
  font-size: 11px;
  font-weight: 600;
}
QTableWidget::item {
  padding: 4px;
  border-bottom: 1px solid #edf3f7;
}
QStatusBar {
  background: #ffffff;
  color: #68717d;
  border-top: 1px solid #dce8ef;
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
