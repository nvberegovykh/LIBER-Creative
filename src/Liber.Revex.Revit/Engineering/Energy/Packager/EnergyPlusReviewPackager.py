#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EnergyPlus eplustbl.html -> ZIP of reviewer-friendly PDFs (GUI, no browser).

This is meant to be packaged as a Windows EXE via PyInstaller.
"""
from __future__ import annotations
import os, queue, subprocess, tempfile, threading, sys
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from tkinter import font as tkfont

# ---- generator (embedded, simplified import-less) ----
import re, zipfile, html as _html
from bs4 import BeautifulSoup
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Flowable, Preformatted, KeepTogether
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.units import inch
# Optional: end-use chart
try:
    from reportlab.graphics.shapes import Drawing, String
    from reportlab.graphics.charts.piecharts import Pie
    from reportlab.graphics.charts.legends import Legend
    from reportlab.graphics.charts.linecharts import HorizontalLineChart
    from reportlab.graphics.charts.lineplots import LinePlot
    _HAS_GRAPHICS = True
except ImportError:
    _HAS_GRAPHICS = False
    Legend = None  # type: ignore
    HorizontalLineChart = None  # type: ignore
    LinePlot = None  # type: ignore
    String = None  # type: ignore

# Modern theme colors (text on white must be dark)
THEME = {
    "primary": colors.HexColor("#0d7377"),
    "primary_light": colors.HexColor("#32e0c4"),
    "heading": colors.HexColor("#0f766e"),
    "heading_light": colors.HexColor("#134e4a"),
    "header_bg": colors.HexColor("#e0f2f1"),
    "header_fg": colors.HexColor("#0f766e"),
    "row_alt": colors.HexColor("#f8fafc"),
    "total_row": colors.HexColor("#e0f2f1"),
    "border": colors.HexColor("#94a3b8"),
}

# Appendix G virtual utility rates (Con Edison) used when bills are unavailable.
CONED_VIRTUAL_ELEC_RATE_PER_KWH = 0.25
CONED_VIRTUAL_GAS_RATE_PER_THERM = 1.45
GJ_TO_KWH = 277.7777778
GJ_TO_THERM = 9.4781712
GJ_TO_KBTU = 947.817

TABLOID = (11*72, 17*72)
UNIT_TOKEN_RE = re.compile(r"\[([^\]]+)\]")
UNIT_TOKEN_PAREN_RE = re.compile(r"\(([^)]+)\)")  # (W), (m3/s), (C), (m2)
NUM_RE = re.compile(r"^\s*[-+]?\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*$|^\s*[-+]?\d+(?:\.\d+)?\s*$")

# SI → US Imperial conversions (all output in IP)
# Length: 1 m = 3.28084 ft
# U-factor: 1 W/(m²·K) = 0.17612 BTU/(hr·ft²·°F)
# Area: 1 m² = 10.7639 ft²
# Volume: 1 m³ = 35.3147 ft³
# Energy: 1 GJ = 947.817 kBtu, 1 MJ = 0.947817 kBtu
# Energy/Area: 1 MJ/m² = 0.088056 kBtu/ft²
# Power/Area: 1 W/m² = 0.0929 W/ft² (for LPD)
# Flow: 1 m³/s = 2118.88 CFM
UNIT_CONV = {
    "m": ("ft", 3.280839895),  # length (e.g. Maximum X, Ceiling Height)
    "GJ": ("kBtu", 947.817),
    "MJ": ("kBtu", 0.947817),
    "MJ/m2": ("kBtu/ft²", 0.088056),
    "MJ/m²": ("kBtu/ft²", 0.088056),
    "kW": ("kBtu/h", 3.412141633),
    "W": ("Btu/h", 3.412141633),
    "m2": ("ft²", 10.7639104167),
    "m²": ("ft²", 10.7639104167),
    "m3": ("ft³", 35.3147),
    "m³": ("ft³", 35.3147),
    "m3/s": ("CFM", 2118.880003),
    "m³/s": ("CFM", 2118.880003),
    "m3/m2": ("gal/ft²", 24.5424),
    "m³/m²": ("gal/ft²", 24.5424),
    "W/m2": ("W/ft²", 0.092903),
    "W/m²": ("W/ft²", 0.092903),
    "W/m2-K": ("BTU/(hr·ft²·°F)", 0.17612),
    "W/m²-K": ("BTU/(hr·ft²·°F)", 0.17612),
    "W/K": ("Btu/(h·°F)", 1.89563),
    "°C": ("°F", None),
    "C": ("F", None),
}

def norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).replace("\xa0", " ").strip()

def _cardinal_to_nsew(card: str) -> str:
    """Map EnergyPlus cardinal direction (North, East, South, West or N,E,S,W) to N,E,S,W or Other."""
    c = (norm(card) or "").lower()
    if c in ("n", "north") or c.startswith("north"):
        return "N"
    if c in ("e", "east") or c.startswith("east"):
        return "E"
    if c in ("s", "south") or c.startswith("south"):
        return "S"
    if c in ("w", "west") or c.startswith("west"):
        return "W"
    if c and c[0] in "nsew" and len(c) <= 2:
        return c[0].upper()
    return "Other"

def load_soup(path: str) -> BeautifulSoup:
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        return BeautifulSoup(f.read(), "html.parser")

def extract_project_name(soup: BeautifulSoup) -> str:
    for p in soup.find_all("p"):
        t = norm(p.get_text(" ", strip=True))
        if t.lower().startswith("building:"):
            name = t.split(":", 1)[-1].strip()
            if name:
                return name
    if soup.title and soup.title.string:
        t = norm(soup.title.string)
        if t:
            return t
    return "EnergyPlus Project"

def clean_cell_text(td) -> str:
    return norm(td.get_text(" ", strip=True))

def table_to_matrix(table_tag):
    rows = []
    for tr in table_tag.find_all("tr"):
        cells = tr.find_all(["td","th"])
        rows.append([clean_cell_text(c) for c in cells])
    if not rows:
        return rows
    maxlen = max(len(r) for r in rows)
    return [r + [""]*(maxlen-len(r)) for r in rows]

def is_effectively_empty(val: str) -> bool:
    v = norm(val).lower()
    return v in {"", "n/a", "na", "-", "none"}

def drop_empty_rows_cols(data, keep_header=True):
    if not data:
        return data
    header = data[0]
    body = data[1:] if keep_header else data
    body2 = [r for r in body if any(not is_effectively_empty(c) for c in r)]
    data2 = [header] + body2 if keep_header else body2
    if not data2:
        return data2
    ncols = len(data2[0])
    keep_cols = []
    for j in range(ncols):
        col_vals = [row[j] for row in (data2[1:] if keep_header else data2)]
        if any(not is_effectively_empty(v) for v in col_vals):
            keep_cols.append(j)
    if 0 not in keep_cols and ncols > 0:
        keep_cols = [0] + keep_cols
    keep_cols = sorted(set([k for k in keep_cols if k < ncols]))
    trimmed = [[row[j] for j in keep_cols] for row in data2]
    if trimmed and all(is_effectively_empty(c) for c in trimmed[0]):
        return []
    return trimmed

def parse_number(s: str):
    s2 = norm(s).replace(",", "")
    if not s2:
        return None
    if not NUM_RE.match(s):
        return None
    try:
        return float(s2)
    except:
        return None

def c_to_f(x: float) -> float:
    return x * 9.0/5.0 + 32.0

def _extract_unit(header_cell: str):
    """Extract unit from [unit] or (unit) pattern. For parentheses, try all matches and use first known unit."""
    m = UNIT_TOKEN_RE.search(header_cell)
    if m:
        u = m.group(1).strip()
        if u in UNIT_CONV:
            return u, lambda h, u_, nu: UNIT_TOKEN_RE.sub(f"[{nu}]", h, count=1)
    for m in UNIT_TOKEN_PAREN_RE.finditer(header_cell):
        u = m.group(1).strip()
        if u in UNIT_CONV:
            return u, lambda h, u_, nu: re.sub(r"\(" + re.escape(u_) + r"\)", f"({nu})", h, count=1)
    return None, None

def _replace_metric_labels_in_cell(text):
    """Replace metric unit labels in any cell. Returns (new_text, unit_found for value conversion)."""
    if not text or not isinstance(text, str):
        return text, None
    out = text
    unit_found = None
    m = UNIT_TOKEN_RE.search(out)
    if m:
        u = m.group(1).strip()
        if u in UNIT_CONV:
            new_u, _ = UNIT_CONV[u]
            out = UNIT_TOKEN_RE.sub(f"[{new_u}]", out, count=1)
            unit_found = u
            return out, unit_found
    for m in UNIT_TOKEN_PAREN_RE.finditer(out):
        u = m.group(1).strip()
        if u in UNIT_CONV:
            new_u, _ = UNIT_CONV[u]
            out = re.sub(r"\(" + re.escape(u) + r"\)", f"({new_u})", out, count=1)
            unit_found = u
            break
    return out, unit_found

def convert_units_in_table(matrix):
    if not matrix or len(matrix) < 2:
        return matrix
    if not _USE_IMPERIAL:
        return matrix
    header = matrix[0]
    col_units = []
    # Also detect units in first column (row labels like "Gross Wall Area [m2]" or "Height [m]")
    row_unit_pattern = re.compile(r"\[(m2|m²|m3|m³|GJ|MJ|W/m2|W/m²|W/m2-K|W/m²-K|°C|C|m)\s*\]", re.I)
    out_header = []
    for h in header:
        unit, replacer = _extract_unit(h)
        col_units.append(unit)
        if unit and unit in UNIT_CONV:
            new_unit, _ = UNIT_CONV[unit]
            out_header.append(replacer(h, unit, new_unit) if replacer else h)
        else:
            out_header.append(h)
    out = [out_header]
    for r in matrix[1:]:
        rr = []
        row_unit = None
        if r and isinstance(r[0], str):
            m = row_unit_pattern.search(r[0])
            if m:
                u = m.group(1).replace(" ", "")
                if u in UNIT_CONV:
                    row_unit = u
        for j, val in enumerate(r):
            unit = col_units[j] if j < len(col_units) else None
            if not unit and j > 0 and row_unit:
                unit = row_unit
            if unit and unit in UNIT_CONV:
                _, factor = UNIT_CONV[unit]
                num = parse_number(val)
                if num is None:
                    rr.append(val)
                else:
                    if factor is None:
                        rr.append(f"{c_to_f(num):.2f}")
                    else:
                        rr.append(f"{num*factor:.3f}".rstrip("0").rstrip("."))
            else:
                rr.append(val)
        out.append(rr)
    for i, r in enumerate(out):
        row_unit_used = False
        if i > 0 and r and isinstance(r[0], str):
            m = row_unit_pattern.search(r[0])
            if m:
                u = m.group(1).replace(" ", "")
                if u in UNIT_CONV:
                    row_unit_used = True
        for j, cell in enumerate(r):
            new_cell, unit_in_cell = _replace_metric_labels_in_cell(cell)
            if new_cell != cell:
                out[i][j] = new_cell
                if unit_in_cell and unit_in_cell in UNIT_CONV and j + 1 < len(r):
                    col_unit_next = col_units[j + 1] if j + 1 < len(col_units) else None
                    if not col_unit_next or col_unit_next not in UNIT_CONV:
                        if j == 0 and row_unit_used:
                            continue
                        next_val = r[j + 1]
                        num = parse_number(next_val)
                        if num is not None:
                            _, factor = UNIT_CONV[unit_in_cell]
                            if factor is None:
                                out[i][j + 1] = f"{c_to_f(num):.2f}"
                            else:
                                out[i][j + 1] = f"{num*factor:.3f}".rstrip("0").rstrip(".")
    return out

def recalculate_wwr_table_from_areas(matrix):
    """Recalculate WWR percentages and totals from area rows. WWR table areas are source of truth.
    Fixes: percentage rows (fen/wall), total column = sum of directional columns for area rows."""
    if not matrix or len(matrix) < 3:
        return matrix
    hdr = matrix[0]
    row_labels = [norm(str(r[0]) if r else "").lower() for r in matrix[1:]]
    idx_gross = idx_above = idx_fen = idx_gross_pct = idx_above_pct = -1
    for i, label in enumerate(row_labels):
        if "gross wall" in label and "ratio" not in label and "area" in label:
            idx_gross = i + 1
        elif "above ground wall" in label and "ratio" not in label:
            idx_above = i + 1
        elif "window opening" in label and "ratio" not in label:
            idx_fen = i + 1
        elif "gross window-wall ratio" in label or "gross window wall ratio" in label:
            idx_gross_pct = i + 1
        elif "above ground window-wall ratio" in label or "above ground window wall ratio" in label:
            idx_above_pct = i + 1
    if idx_above < 0 or idx_fen < 0:
        return matrix
    idx_total = get_col_index(hdr, ["total", "gross total"])
    if idx_total < 0:
        idx_total = 1 if len(hdr) > 1 else 0
    dir_cols = []
    for j, h in enumerate(hdr):
        if j == 0 or j == idx_total:
            continue
        hlo = norm(str(h)).lower()
        if any(d in hlo for d in ("north", "east", "south", "west", "deg", "315", "45", "135", "225")):
            dir_cols.append(j)
    out = [row[:] for row in matrix]
    for col in [idx_total] + dir_cols:
        if col >= len(hdr):
            continue
        above_vals = []
        fen_vals = []
        gross_vals = []
        for r in dir_cols:
            if r < len(matrix[idx_above]):
                above_vals.append(parse_number(matrix[idx_above][r]) or 0)
            if r < len(matrix[idx_fen]):
                fen_vals.append(parse_number(matrix[idx_fen][r]) or 0)
            if idx_gross >= 0 and r < len(matrix[idx_gross]):
                gross_vals.append(parse_number(matrix[idx_gross][r]) or 0)
        above_col = parse_number(matrix[idx_above][col]) if col < len(matrix[idx_above]) else 0
        fen_col = parse_number(matrix[idx_fen][col]) if col < len(matrix[idx_fen]) else 0
        gross_col = parse_number(matrix[idx_gross][col]) if idx_gross >= 0 and col < len(matrix[idx_gross]) else 0
        if col == idx_total and dir_cols:
            above_sum = sum(parse_number(matrix[idx_above][r]) or 0 for r in dir_cols)
            fen_sum = sum(parse_number(matrix[idx_fen][r]) or 0 for r in dir_cols)
            gross_sum = sum(parse_number(matrix[idx_gross][r]) or 0 for r in dir_cols) if idx_gross >= 0 else above_sum
            if above_sum > 0 or fen_sum > 0:
                out[idx_above][col] = f"{above_sum:.3f}".rstrip("0").rstrip(".") if above_sum else matrix[idx_above][col]
                out[idx_fen][col] = f"{fen_sum:.3f}".rstrip("0").rstrip(".") if fen_sum else matrix[idx_fen][col]
                if idx_gross >= 0 and gross_sum > 0:
                    out[idx_gross][col] = f"{gross_sum:.3f}".rstrip("0").rstrip(".")
                above_col = above_sum
                fen_col = fen_sum
                gross_col = gross_sum
        denom_gross = gross_col if (idx_gross >= 0 and gross_col > 0) else above_col
        denom_above = above_col
        if denom_above > 0 and idx_above_pct >= 0 and idx_above_pct < len(out) and col < len(out[idx_above_pct]):
            pct = 100.0 * fen_col / denom_above
            out[idx_above_pct][col] = f"{pct:.2f}"
        if denom_gross > 0 and idx_gross_pct >= 0 and idx_gross_pct < len(out) and col < len(out[idx_gross_pct]):
            pct = 100.0 * fen_col / denom_gross
            out[idx_gross_pct][col] = f"{pct:.2f}"
    return out

def wrap_header_text(s: str) -> str:
    s = norm(s)
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", s)
    words = s.split(" ")
    lines, cur = [], ""
    limit = 18
    for w in words:
        if not cur:
            cur = w
        elif len(cur) + 1 + len(w) <= limit:
            cur += " " + w
        else:
            lines.append(cur); cur = w
    if cur:
        lines.append(cur)
    if len(lines) > 6:
        lines, cur = [], ""
        limit = 26
        for w in words:
            if not cur:
                cur = w
            elif len(cur) + 1 + len(w) <= limit:
                cur += " " + w
            else:
                lines.append(cur); cur = w
        if cur:
            lines.append(cur)
    return "<br/>".join(_html.escape(l) for l in lines)

def find_tables_by_keywords(soup, keywords):
    keywords = [k.lower() for k in keywords]
    hits = []
    for table in soup.find_all("table"):
        title = ""
        prev = table.previous_sibling
        steps = 0
        while prev and steps < 40:
            steps += 1
            if getattr(prev, "name", None) == "b":
                t = norm(prev.get_text(" ", strip=True))
                if t:
                    title = t
                    break
            prev = prev.previous_sibling
        context = (title + " " + norm(table.get_text(" ", strip=True))[:600]).lower()
        if any(k in context for k in keywords):
            hits.append((title if title else "Table", table))
    seen=set(); out=[]
    for ttitle, tbl in hits:
        if id(tbl) in seen: continue
        seen.add(id(tbl)); out.append((ttitle, tbl))
    return out

def _table_report_name(table):
    """Find nearest preceding 'Report:' heading for a table."""
    prev = table.previous_sibling
    steps = 0
    while prev and steps < 240:
        steps += 1
        if getattr(prev, "name", None) == "p":
            t = norm(prev.get_text(" ", strip=True))
            if t.lower().startswith("report:"):
                return t.split(":", 1)[-1].strip()
        prev = prev.previous_sibling
    return ""

def find_table_by_title_contains(soup, substrings):
    subs = [s.lower() for s in substrings]
    for table in soup.find_all("table"):
        title = ""
        prev = table.previous_sibling
        steps = 0
        while prev and steps < 40:
            steps += 1
            if getattr(prev, "name", None) == "b":
                title = norm(prev.get_text(" ", strip=True))
                break
            prev = prev.previous_sibling
        if title and any(sub in title.lower() for sub in subs):
            return title, table
    return None

def _end_uses_table_matrices(soup):
    """Return annual End Uses energy matrices (exclude peak-power and by-subcategory tables)."""
    def _is_annual_end_uses_energy_table(title_text: str, matrix) -> bool:
        t = norm(title_text or "").lower()
        # Keep only primary "End Uses" tables (not by-subcategory / by-space-type).
        if t != "end uses":
            return False
        if not matrix or len(matrix) < 2:
            return False
        hdr = [norm(x).lower() for x in matrix[0]]
        # Must contain at least one purchased fuel column.
        has_fuel_cols = any(("electricity" in h or "natural gas" in h or h == "gas") for h in hdr)
        if not has_fuel_cols:
            return False
        # Exclude peak-power tables (W), keep energy tables (GJ/MJ/kWh/Btu families).
        has_energy_unit = any(
            ("[gj]" in h or "[mj]" in h or "[kwh]" in h or "[wh]" in h or
             "[therm]" in h or "[mmbtu]" in h or "[mbtu]" in h or
             "[kbtu]" in h or "[k btu]" in h or "[btu]" in h)
            for h in hdr
        )
        has_power_unit = any(("[w]" in h or "[kw]" in h or "[mw]" in h) for h in hdr)
        return has_energy_unit and not has_power_unit

    out = []
    seen = set()
    for table in soup.find_all("table"):
        title = ""
        prev = table.previous_sibling
        steps = 0
        while prev and steps < 60:
            steps += 1
            if getattr(prev, "name", None) == "b":
                t = norm(prev.get_text(" ", strip=True))
                if t:
                    title = t
                    break
            prev = prev.previous_sibling
        if "end uses" not in (title or "").lower():
            continue
        if id(table) in seen:
            continue
        data = table_to_matrix(table)
        if _is_annual_end_uses_energy_table(title, data):
            seen.add(id(table))
            out.append(data)

    # Fallback for non-standard title formatting.
    if not out:
        hits = find_tables_by_keywords(soup, ["end uses"])
        for title, table in hits:
            if id(table) in seen:
                continue
            data = table_to_matrix(table)
            if _is_annual_end_uses_energy_table(title, data):
                seen.add(id(table))
                out.append(data)
    return out

def _energy_value_to_gj(val, header_text: str):
    """Convert an End Uses numeric cell to GJ using its column header unit."""
    if val is None:
        return 0.0
    h = norm(header_text or "").lower()
    # Normalize bracketed unit token (handles variants like [k Btu], [kBtu], [m3/s]).
    unit = ""
    m = UNIT_TOKEN_RE.search(header_text or "")
    if m:
        unit = re.sub(r"[^a-z0-9/]+", "", m.group(1).lower())
    # Ignore non-energy power/flow columns.
    if unit in ("w", "kw", "mw", "m3/s", "m³/s"):
        return 0.0
    if unit == "gj":
        return float(val)
    if unit == "mj":
        return float(val) * 0.001
    if unit == "kwh":
        return float(val) * 0.0036
    if unit == "wh":
        return float(val) * 0.0000036
    if unit == "therm":
        return float(val) * 0.105505585
    if unit in ("mmbtu", "mbtu"):
        return float(val) * 1.055056
    if unit == "kbtu":
        return float(val) / GJ_TO_KBTU
    if unit == "btu":
        return float(val) * 1.055056e-6
    # Most EnergyPlus End Uses tables are already [GJ].
    if "gj" in h:
        return float(val)
    if "mj" in h:
        return float(val) * 0.001
    if "kwh" in h:
        return float(val) * 0.0036
    if "wh" in h:
        return float(val) * 0.0000036
    if "therm" in h:
        return float(val) * 0.105505585
    if "mmbtu" in h or "mbtu" in h:
        return float(val) * 1.055056
    if "kbtu" in h:
        return float(val) / 947.817
    if "btu" in h:
        return float(val) * 1.055056e-6
    # Unknown/non-energy units (e.g., water volume) are excluded from energy totals.
    return 0.0

def _is_energy_fuel_column(header_text: str) -> bool:
    """True for End Uses energy fuel columns; false for water/label/non-energy columns."""
    h = norm(header_text or "").lower()
    if not h:
        return False
    if "water [m3" in h or "water [m³" in h or "water [m3/s" in h or "water [m³/s" in h:
        return False
    if "electricity" in h or "natural gas" in h or " gas " in f" {h} ":
        return True
    return any(u in h for u in ["[gj]", "[mj]", "[kwh]", "[wh]", "[therm]", "[mmbtu]", "[mbtu]", "[kbtu]", "[k btu]", "[btu]"])

def _end_uses_rows_gj(soup):
    """Return [(label, elec_gj, gas_gj, other_gj)] from annual End Uses."""
    matrices = _end_uses_table_matrices(soup)
    if not matrices:
        return []
    data = matrices[0]
    hdr = data[0]
    idx_label = get_col_index(hdr, ["end use", "subcategory", "category", "description"])
    if idx_label < 0:
        idx_label = 0
    idx_elec = get_col_index(hdr, ["electricity"])
    idx_gas = get_col_index(hdr, ["natural gas", "gas"])
    out = []
    for row in data[1:]:
        label = norm(row[idx_label] if idx_label < len(row) else "")
        llo = label.lower()
        if not label or "total" in llo or "end use" in llo:
            continue
        elec_gj = 0.0
        gas_gj = 0.0
        other_gj = 0.0
        for j in range(len(row)):
            if j == idx_label:
                continue
            if j >= len(hdr) or not _is_energy_fuel_column(hdr[j]):
                continue
            v = _energy_value_to_gj(parse_number(row[j]), hdr[j])
            if idx_elec == j:
                elec_gj += v
            elif idx_gas == j:
                gas_gj += v
            else:
                other_gj += v
        if elec_gj > 0 or gas_gj > 0 or other_gj > 0:
            out.append((label, elec_gj, gas_gj, other_gj))
    return out

def extract_end_use_for_chart(soup):
    """Extract end-use categories and energy (kBtu) from End Uses table for diagram. Returns [(label, kBtu), ...]."""
    by_label_gj = {}
    for label, egj, ggj, ogj in _end_uses_rows_gj(soup):
        by_label_gj[label] = by_label_gj.get(label, 0.0) + egj + ggj + ogj
    results = []
    for label, gj in by_label_gj.items():
        total = gj * GJ_TO_KBTU if _USE_IMPERIAL else gj
        results.append((label[:28], total))
    results.sort(key=lambda x: -x[1])
    return results[:12]

def _extract_numeric_sequence(cells):
    vals = []
    for c in cells:
        v = parse_number(c)
        if v is not None:
            vals.append(float(v))
    return vals

def _norm_sched_name(s: str) -> str:
    s = norm(s or "").lower()
    s = re.sub(r"[\[\]\(\)\{\}_\-]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s

def _model_field_token(line: str) -> str:
    """Return cleaned first field token from an OSM/IDF object line."""
    base = re.sub(r"!.*$", "", line or "").strip()
    if not base:
        return ""
    base = base.split(",", 1)[0].strip()
    base = base.rstrip(";").strip()
    return norm(base)

def _iter_idf_object_blocks(model_text: str):
    """Yield complete IDF objects while retaining comments on semicolon lines."""
    current = []
    for line in (model_text or "").splitlines():
        current.append(line)
        code_only = re.sub(r"!.*$", "", line)
        if ";" in code_only:
            block = "\n".join(current).strip()
            if block:
                yield block
            current = []

def extract_used_schedule_names(soup):
    """Collect schedule names referenced in eplustbl schedule-name columns."""
    out = set()
    if not soup:
        return out
    for table in soup.find_all("table"):
        data = table_to_matrix(table)
        if len(data) < 2:
            continue
        hdr = data[0]
        schedule_cols = [i for i, h in enumerate(hdr) if "schedule" in norm(h).lower()]
        if not schedule_cols:
            continue
        for r in data[1:]:
            for j in schedule_cols:
                if j >= len(r):
                    continue
                v = norm(r[j])
                if not v or v in ("-", "N/A", "NA"):
                    continue
                # exclude obvious non-name schedule flags
                if v.lower() in ("yes", "no"):
                    continue
                if parse_number(v) is not None:
                    continue
                out.add(v)
    return out

def extract_used_schedule_refs_from_model(model_path: str):
    """Collect schedule references from model objects (names and handles)."""
    refs = {"names": set(), "handles": set()}
    if not model_path or not os.path.isfile(model_path):
        return refs
    try:
        with open(model_path, "r", encoding="utf-8", errors="ignore") as handle:
            txt = handle.read()
    except Exception:
        return refs
    if not model_path.lower().endswith(".osm"):
        # IDF references are named fields. Ignore Schedule:* definition objects
        # themselves so their internal day/week links do not flood the report
        # with duplicate design-day and helper schedules.
        for block in _iter_idf_object_blocks(txt):
            raw_lines = [line.rstrip() for line in block.splitlines() if line.strip()]
            tokens = _idf_object_tokens(block)
            if not tokens:
                continue
            obj_type = tokens[0].lower()
            if obj_type.startswith("schedule:") or obj_type == "scheduletypelimits":
                continue
            for line in raw_lines[1:]:
                if "!-" not in line:
                    continue
                comment = line.split("!-", 1)[1].lower()
                if "schedule name" not in comment:
                    continue
                token = _model_field_token(line)
                if token and token not in ("-", "N/A", "NA"):
                    refs["names"].add(token)
        return refs
    for blk in re.split(r"(?mi)^\s*(?=OS:)", txt or ""):
        if not blk or not blk.strip():
            continue
        lines = [ln.rstrip() for ln in blk.splitlines() if ln.strip()]
        if not lines:
            continue
        obj_type = norm(lines[0].split(",", 1)[0]).lower()
        if obj_type.startswith("os:schedule:") or obj_type == "os:scheduletypelimits":
            continue
        for ln in lines[1:]:
            low = ln.lower()
            if "schedule" in low and "type limits" not in low:
                token = _model_field_token(ln)
                if not token or token in ("-", "N/A", "NA"):
                    continue
                if token.startswith("{") and token.endswith("}"):
                    refs["handles"].add(token)
                else:
                    refs["names"].add(token)
    return refs

def _build_hourly_from_until_pairs(pairs):
    """Convert [(until_minute, value), ...] to 24 hourly values."""
    if not pairs:
        return []
    # EnergyPlus/OpenStudio "Value Until Time" means:
    # value applies from previous break up to the end of the stated hour.
    # Hour bins are 1..24 (not 0..23 starts), so 06:00 maps through hour 6.
    vals = [0.0] * 24
    clean = sorted(
        [(max(0, min(1440, int(um))), float(v)) for (um, v) in pairs],
        key=lambda x: x[0]
    )
    prev_um = 0
    for um, value in clean:
        if um <= prev_um:
            prev_um = um
            continue
        start_hr = int(prev_um // 60) + 1
        end_hr = int((um + 59) // 60)  # ceil to hour bin
        start_hr = max(1, min(24, start_hr))
        end_hr = max(1, min(24, end_hr))
        for hr in range(start_hr, end_hr + 1):
            vals[hr - 1] = value
        prev_um = um
    # If schedule does not explicitly reach 24:00, carry last value to end of day.
    if clean and prev_um < 1440:
        last_v = clean[-1][1]
        start_hr = max(1, min(24, int(prev_um // 60) + 1))
        for hr in range(start_hr, 25):
            vals[hr - 1] = last_v
    return vals

def _convert_schedule_values_by_unit(vals, unit_type: str):
    u = (unit_type or "").strip().lower()
    if not vals:
        return vals, "value"
    if "temperature" in u:
        return ([c_to_f(v) for v in vals], "F") if _USE_IMPERIAL else (vals, "C")
    if "fraction" in u:
        return vals, "fraction"
    if "on/off" in u or "availability" in u:
        return vals, "on/off"
    if "control" in u:
        return vals, "control"
    return vals, (u if u else "value")

def _extract_osm_schedule_profiles(model_text: str, used_schedule_names=None, used_schedule_handles=None, max_profiles=60, model_name="model.osm"):
    """Parse OSM schedule objects and build 24h curves from OS:Schedule:Day."""
    used_norm = {_norm_sched_name(x) for x in (used_schedule_names or set()) if norm(x)}
    used_handles = set(used_schedule_handles or set())
    day_by_handle = {}
    day_by_name = {}
    type_limits = {}  # handle -> unit type
    rulesets = []  # [(ruleset_handle, ruleset_name, [day_handle,...])]
    constants = []  # [(handle, name, type_limits_handle, value)]
    blocks = re.split(r"(?mi)^\s*(?=OS:)", model_text or "")
    for blk in blocks:
        if not blk or not blk.strip():
            continue
        lines = [ln.rstrip() for ln in blk.splitlines() if ln.strip()]
        if not lines:
            continue
        obj_type = norm(lines[0].split(",", 1)[0]).lower()
        if obj_type == "os:scheduletypelimits":
            h = ""
            u = ""
            for ln in lines[1:]:
                token = _model_field_token(ln)
                cm = ln.lower()
                if "!- handle" in cm:
                    h = token
                elif "!- unit type" in cm:
                    u = token
            if h:
                type_limits[h] = u
        elif obj_type == "os:schedule:day":
            handle = ""
            name = ""
            pairs = []
            cur_h = None
            cur_m = None
            for ln in lines[1:]:
                token = _model_field_token(ln)
                cm = ln.lower()
                if "!- handle" in cm:
                    handle = token
                elif "!- name" in cm:
                    name = token
                elif "!- hour " in cm:
                    v = parse_number(token)
                    cur_h = int(v) if v is not None else None
                elif "!- minute " in cm:
                    v = parse_number(token)
                    cur_m = int(v) if v is not None else None
                elif "!- value until time " in cm:
                    v = parse_number(token)
                    if v is not None and cur_h is not None and cur_m is not None:
                        pairs.append((cur_h * 60 + cur_m, float(v)))
            vals = _build_hourly_from_until_pairs(pairs)
            if name and len(vals) == 24:
                if handle:
                    day_by_handle[handle] = (name, vals)
                day_by_name[_norm_sched_name(name)] = (name, vals)
        elif obj_type == "os:schedule:ruleset":
            rs_handle = ""
            rs_name = ""
            rs_type_handle = ""
            default_day_ref = ""
            other_day_refs = []
            for ln in lines[1:]:
                token = _model_field_token(ln)
                cm = ln.lower()
                if "!- handle" in cm:
                    rs_handle = token
                elif "!- name" in cm:
                    rs_name = token
                elif "schedule type limits name" in cm:
                    rs_type_handle = token
                elif ("schedule day name" in cm or "day schedule name" in cm) and token:
                    if "default day schedule name" in cm:
                        default_day_ref = token
                    else:
                        other_day_refs.append(token)
            # "During the day" charts should represent the default daily profile.
            day_refs = [default_day_ref] if default_day_ref else other_day_refs[:1]
            if rs_name:
                rulesets.append((rs_handle, rs_name, rs_type_handle, day_refs))
        elif obj_type == "os:schedule:constant":
            ch = ""
            cn = ""
            ct = ""
            cv = None
            for ln in lines[1:]:
                token = _model_field_token(ln)
                cm = ln.lower()
                if "!- handle" in cm:
                    ch = token
                elif "!- name" in cm:
                    cn = token
                elif "schedule type limits name" in cm:
                    ct = token
                elif "!- value" in cm:
                    cv = parse_number(token)
            if cn and cv is not None:
                constants.append((ch, cn, ct, float(cv)))

    out = []
    seen = set()
    for rs_handle, rs_name, rs_type_handle, day_refs in rulesets:
        rs_norm = _norm_sched_name(rs_name)
        if used_norm or used_handles:
            refs_norm = {_norm_sched_name(x) for x in day_refs if x}
            refs_handle = set(day_refs)
            if rs_norm not in used_norm and rs_handle not in used_handles and not (refs_norm & used_norm) and not (refs_handle & used_handles):
                continue
        unit_type = type_limits.get(rs_type_handle, "")
        added_any = False
        for ref in day_refs:
            day = day_by_handle.get(ref)
            if not day:
                day = day_by_name.get(_norm_sched_name(ref))
            if not day:
                continue
            dname, vals = day
            dnorm = _norm_sched_name(dname)
            if (
                re.match(r"^schedule day\s*\d+$", dnorm, flags=re.I)
                or dnorm.startswith(rs_norm)
                or "default" in dnorm
            ):
                profile_name = rs_name
            else:
                profile_name = f"{rs_name} - {dname}"
            vals2, unit_lbl = _convert_schedule_values_by_unit(vals, unit_type)
            key = (rs_norm, tuple(round(v, 6) for v in vals2))
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "name": profile_name,
                "vals": vals2,
                "xlabels": [str(i) for i in range(1, 25)],
                "source": f"OS:Schedule:Ruleset ({os.path.basename(model_name)})",
                "unit": unit_lbl,
            })
            added_any = True
            if max_profiles and len(out) >= max_profiles:
                return out
        # fallback: if ruleset matched but no day refs resolved, skip silently
        _ = added_any

    # Include used constant schedules (many "always on"/set constants live here).
    for ch, cn, ct, cv in constants:
        cn_norm = _norm_sched_name(cn)
        if used_norm or used_handles:
            if cn_norm not in used_norm and ch not in used_handles:
                continue
        vals = [cv] * 24
        vals2, unit_lbl = _convert_schedule_values_by_unit(vals, type_limits.get(ct, ""))
        key = (cn_norm, tuple(round(v, 6) for v in vals2))
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "name": cn,
            "vals": vals2,
            "xlabels": [str(i) for i in range(1, 25)],
            "source": f"OS:Schedule:Constant ({os.path.basename(model_name)})",
            "unit": unit_lbl,
        })
        if max_profiles and len(out) >= max_profiles:
            return out
    # Conservative fallback: only include day schedules that directly match used schedule names.
    if not out and day_by_handle and used_norm:
        day_items = list(day_by_handle.values())
        matched = [(n, v) for (n, v) in day_items if (used_norm and _norm_sched_name(n) in used_norm)]
        for dname, vals in matched:
            key = (_norm_sched_name(dname), tuple(round(v, 6) for v in vals))
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "name": dname,
                "vals": vals,
                "xlabels": [str(i) for i in range(1, 25)],
                "source": f"OS:Schedule:Day ({os.path.basename(model_name)})",
            })
            if max_profiles and len(out) >= max_profiles:
                break
    return out

def _idf_object_tokens(block: str):
    """Return comment-free EnergyPlus object fields from one semicolon block."""
    cleaned_lines = [re.sub(r"!.*$", "", line) for line in (block or "").splitlines()]
    cleaned = "\n".join(cleaned_lines).strip()
    if not cleaned:
        return []
    return [norm(token) for token in re.split(r"[,;]", cleaned) if norm(token)]

def _parse_idf_compact_groups(tokens):
    """Return [(period/day label, until-value pairs)] for Schedule:Compact."""
    groups = []
    through = ""
    day_group = ""
    pairs = []

    def finish():
        nonlocal pairs
        if pairs:
            label_parts = [part for part in (through, day_group) if part]
            groups.append((" / ".join(label_parts), pairs))
            pairs = []

    i = 3
    while i < len(tokens):
        token = norm(tokens[i])
        low = token.lower()
        if low.startswith("through:"):
            finish()
            through = norm(token.split(":", 1)[1])
            day_group = ""
            i += 1
            continue
        if low.startswith("for:"):
            finish()
            day_group = norm(token.split(":", 1)[1])
            i += 1
            continue
        if low.startswith("until:") and i + 1 < len(tokens):
            time_text = norm(token.split(":", 1)[1])
            match = re.match(r"^([0-2]?\d):([0-5]\d)$", time_text)
            value = parse_number(tokens[i + 1])
            if match and value is not None:
                pairs.append((int(match.group(1)) * 60 + int(match.group(2)), float(value)))
                i += 2
                continue
        i += 1
    finish()
    return groups

def _extract_idf_schedule_profiles(model_text: str, used_schedule_names=None, max_profiles=60, model_name="in.idf"):
    """Parse EnergyPlus Schedule:* objects into real 24-hour daily curves."""
    used_norm = {_norm_sched_name(x) for x in (used_schedule_names or set()) if norm(x)}
    type_limits = {}
    days = {}
    weeks = {}
    years = []
    constants = []
    compacts = []

    for raw_block in _iter_idf_object_blocks(model_text):
        tokens = _idf_object_tokens(raw_block)
        if len(tokens) < 2:
            continue
        obj_type = tokens[0].lower()
        name = tokens[1]
        if obj_type == "scheduletypelimits":
            # Unit Type is the final optional field. The type-limit name itself
            # is a useful fallback for Temperature/Fraction/OnOff schedules.
            unit_type = tokens[5] if len(tokens) > 5 else name
            type_limits[_norm_sched_name(name)] = unit_type or name
        elif obj_type == "schedule:day:interval" and len(tokens) >= 5:
            type_name = tokens[2]
            pairs = []
            for i in range(4, len(tokens) - 1, 2):
                match = re.match(r"^([0-2]?\d):([0-5]\d)$", tokens[i])
                value = parse_number(tokens[i + 1])
                if match and value is not None:
                    pairs.append((int(match.group(1)) * 60 + int(match.group(2)), float(value)))
            vals = _build_hourly_from_until_pairs(pairs)
            if len(vals) == 24:
                days[_norm_sched_name(name)] = {
                    "name": name,
                    "vals": vals,
                    "type": type_name,
                }
        elif obj_type == "schedule:week:daily" and len(tokens) >= 4:
            # First seven references are Sunday through Saturday.
            weeks[_norm_sched_name(name)] = tokens[2:9]
        elif obj_type == "schedule:year" and len(tokens) >= 4:
            years.append({
                "name": name,
                "type": tokens[2],
                "week": tokens[3],
            })
        elif obj_type == "schedule:constant" and len(tokens) >= 4:
            value = parse_number(tokens[3])
            if value is not None:
                constants.append({"name": name, "type": tokens[2], "value": float(value)})
        elif obj_type == "schedule:compact" and len(tokens) >= 4:
            compacts.append({
                "name": name,
                "type": tokens[2],
                "groups": _parse_idf_compact_groups(tokens),
            })

    out = []
    seen = set()

    def add_profile(name, vals, type_name, source):
        if not vals or len(vals) != 24:
            return
        unit_type = type_limits.get(_norm_sched_name(type_name), type_name)
        vals2, unit_lbl = _convert_schedule_values_by_unit(vals, unit_type)
        key = (_norm_sched_name(name), tuple(round(v, 6) for v in vals2))
        if key in seen:
            return
        seen.add(key)
        out.append({
            "name": name,
            "vals": vals2,
            "xlabels": [str(i) for i in range(1, 25)],
            "source": f"{source} ({os.path.basename(model_name)})",
            "unit": unit_lbl,
        })

    # Top-level Schedule:Year objects are the names referenced by loads/HVAC.
    for year in years:
        if used_norm and _norm_sched_name(year["name"]) not in used_norm:
            continue
        day_refs = weeks.get(_norm_sched_name(year["week"]), [])
        unique_refs = []
        for ref in day_refs:
            ref_norm = _norm_sched_name(ref)
            if ref_norm and ref_norm not in unique_refs:
                unique_refs.append(ref_norm)
        for ref_norm in unique_refs:
            day = days.get(ref_norm)
            if not day:
                continue
            profile_name = year["name"]
            if len(unique_refs) > 1:
                profile_name = f"{year['name']} - {day['name']}"
            add_profile(
                profile_name, day["vals"], year["type"],
                "Schedule:Year → Schedule:Day:Interval",
            )
            if max_profiles and len(out) >= max_profiles:
                return out

    for compact in compacts:
        if used_norm and _norm_sched_name(compact["name"]) not in used_norm:
            continue
        groups = compact["groups"]
        for label, pairs in groups:
            vals = _build_hourly_from_until_pairs(pairs)
            profile_name = compact["name"]
            if len(groups) > 1 and label:
                profile_name = f"{compact['name']} - {label}"
            add_profile(profile_name, vals, compact["type"], "Schedule:Compact")
            if max_profiles and len(out) >= max_profiles:
                return out

    for constant in constants:
        if used_norm and _norm_sched_name(constant["name"]) not in used_norm:
            continue
        add_profile(
            constant["name"], [constant["value"]] * 24,
            constant["type"], "Schedule:Constant",
        )
        if max_profiles and len(out) >= max_profiles:
            return out

    # Direct day schedules are valid model data too. Only include them when the
    # report explicitly references the day name, or as a conservative fallback
    # when no top-level schedule could be resolved.
    for day_norm, day in days.items():
        if used_norm and day_norm not in used_norm:
            continue
        add_profile(day["name"], day["vals"], day["type"], "Schedule:Day:Interval")
        if max_profiles and len(out) >= max_profiles:
            return out
    return out

def extract_model_schedule_profiles(model_path: str, used_schedule_names=None, used_schedule_handles=None, max_profiles=24):
    """Extract complete daily schedule curves from OSM or EnergyPlus IDF text."""
    if not model_path or not os.path.isfile(model_path):
        return []
    try:
        with open(model_path, "r", encoding="utf-8", errors="ignore") as handle:
            txt = handle.read()
    except Exception:
        return []
    if model_path.lower().endswith(".osm"):
        osm_profiles = _extract_osm_schedule_profiles(
            txt, used_schedule_names=used_schedule_names, used_schedule_handles=used_schedule_handles, max_profiles=max_profiles, model_name=model_path
        )
        if osm_profiles:
            return osm_profiles
    return _extract_idf_schedule_profiles(
        txt,
        used_schedule_names=used_schedule_names,
        max_profiles=max_profiles,
        model_name=model_path,
    )

def discover_schedule_model(report_html: str, explicit_model_file: str = "") -> str:
    """Resolve the model that supplied an EnergyPlus HTML report.

    OpenStudio/EnergyPlus run folders normally keep ``in.idf`` beside
    ``eplustbl.html``. Prefer that exact run input and only use a generic model
    candidate when there is exactly one unambiguous file in the folder.
    """
    explicit = os.path.abspath(explicit_model_file) if explicit_model_file else ""
    if explicit and os.path.isfile(explicit):
        return explicit
    if not report_html:
        return ""
    report_path = os.path.abspath(report_html)
    report_dir = os.path.dirname(report_path)
    if not os.path.isdir(report_dir):
        return ""

    def existing_case_insensitive(folder: str, filename: str) -> str:
        try:
            wanted = filename.casefold()
            for entry in os.listdir(folder):
                if entry.casefold() == wanted:
                    candidate = os.path.join(folder, entry)
                    if os.path.isfile(candidate):
                        return candidate
        except OSError:
            pass
        return ""

    # First choice: the translated simulation input in the report's run folder.
    for filename in ("in.idf", "in.imf", "in.osm"):
        candidate = existing_case_insensitive(report_dir, filename)
        if candidate:
            return candidate

    # Common manual-export layout: report and a single model file share a folder.
    try:
        model_files = [
            os.path.join(report_dir, entry)
            for entry in os.listdir(report_dir)
            if os.path.isfile(os.path.join(report_dir, entry))
            and os.path.splitext(entry)[1].casefold() in (".idf", ".imf", ".osm")
        ]
    except OSError:
        model_files = []
    if len(model_files) == 1:
        return model_files[0]

    # Some workflows place the report one level below the translated input.
    parent_dir = os.path.dirname(report_dir)
    if parent_dir and parent_dir != report_dir:
        for filename in ("in.idf", "in.imf", "in.osm"):
            candidate = existing_case_insensitive(parent_dir, filename)
            if candidate:
                return candidate
    return ""

def extract_schedule_profiles(soup, max_profiles=12):
    """Extract only complete 24-hour schedule series from eplustbl tables.

    EnergyPlus schedule summary tables often expose only two representative
    values (for example 11 a.m. and 11 p.m.). Those values are useful summary
    samples but are not a daily curve and must never be stretched over 24 hours.
    """
    if not soup:
        return []
    candidates = []
    seen = set()
    for table in soup.find_all("table"):
        title = ""
        prev = table.previous_sibling
        steps = 0
        while prev and steps < 80:
            steps += 1
            if getattr(prev, "name", None) == "b":
                t = norm(prev.get_text(" ", strip=True))
                if t:
                    title = t
                    break
            prev = prev.previous_sibling
        tlo = (title or "").lower()
        ctx = (title + " " + norm(table.get_text(" ", strip=True))[:500]).lower()
        # Anchor on explicit schedule tables / references (avoids unrelated huge tables).
        if not (
            "schedules-" in tlo
            or "thermostat schedules" in tlo
            or "schedule type" in tlo
            or ("schedule" in tlo and ("setpoint" in tlo or "equivalent" in tlo or "full load" in tlo))
            or ("schedule" in ctx and "first object used" in ctx)
        ):
            continue
        data = table_to_matrix(table)
        if len(data) < 2:
            continue
        hdr = data[0]
        idx_name = get_col_index(hdr, ["first object used", "schedule", "name", "profile", "day schedule", "thermostat"])
        if idx_name < 0:
            idx_name = 0
        # candidate numeric columns by header text (avoid mixed-unit noise like "days with same").
        num_cols = []
        for j, h in enumerate(hdr):
            if j == idx_name:
                continue
            hlo = norm(h).lower()
            if not hlo:
                continue
            if "days with same" in hlo:
                continue
            if any(k in hlo for k in ("[c]", "[f]", "setpoint", "temperature", "hours", "equivalent", "11am", "11pm")):
                num_cols.append(j)
        if not num_cols:
            # fallback: try any numeric columns in row later
            num_cols = [j for j in range(len(hdr)) if j != idx_name]
        for r in data[1:]:
            if not r:
                continue
            name = norm(r[idx_name] if idx_name < len(r) else "")
            if not name:
                continue
            # Add descriptor when available (e.g., Month Assumed) to avoid same-name ambiguity.
            descriptor = ""
            idx_desc = get_col_index(hdr, ["month assumed", "control type name", "control type"])
            if idx_desc >= 0 and idx_desc < len(r):
                d = norm(r[idx_desc])
                if d and d != name and parse_number(d) is None:
                    descriptor = d
            vals = []
            labels = []
            for j in num_cols:
                if j >= len(r):
                    continue
                v = parse_number(r[j])
                if v is None:
                    continue
                vals.append(float(v))
                labels.append(norm(hdr[j]) if j < len(hdr) else f"v{j}")
            if len(vals) != 24:
                continue
            disp_name = f"{name} ({descriptor})" if descriptor else name
            key = ((title or "").lower(), disp_name.lower(), tuple(round(v, 5) for v in vals))
            if key in seen:
                continue
            seen.add(key)
            candidates.append({"name": disp_name, "vals": vals, "xlabels": labels, "source": title or "Schedules"})
            if max_profiles is not None and len(candidates) >= max_profiles:
                return candidates
    return candidates

def _is_complete_daily_schedule(profile) -> bool:
    """Return True only for an explicit, finite 24-value daily schedule."""
    if not isinstance(profile, dict):
        return False
    vals = profile.get("vals")
    if not isinstance(vals, (list, tuple)) or len(vals) != 24:
        return False
    try:
        return all(float(v) == float(v) and abs(float(v)) != float("inf") for v in vals)
    except (TypeError, ValueError):
        return False

def extract_end_uses_fuel_gj(soup):
    """Return annual purchased energy by fuel from End Uses table, in GJ."""
    matrices = _end_uses_table_matrices(soup)
    if not matrices:
        return {"electricity_gj": 0.0, "natural_gas_gj": 0.0}
    total_rows = []
    summed_elec = 0.0
    summed_gas = 0.0
    for data in matrices:
        hdr = data[0]
        idx_elec = get_col_index(hdr, ["electricity"])
        idx_gas = get_col_index(hdr, ["natural gas", "gas"])
        has_total = False
        part_elec = 0.0
        part_gas = 0.0
        for r in data[1:]:
            label = norm(r[0]).lower() if r else ""
            if "total end uses" in label or label == "total":
                has_total = True
                if idx_elec >= 0 and idx_elec < len(r):
                    part_elec = _energy_value_to_gj(parse_number(r[idx_elec]), hdr[idx_elec] if idx_elec < len(hdr) else "")
                if idx_gas >= 0 and idx_gas < len(r):
                    part_gas = _energy_value_to_gj(parse_number(r[idx_gas]), hdr[idx_gas] if idx_gas < len(hdr) else "")
                break
        if has_total:
            total_rows.append((part_elec, part_gas))
            continue
        for r in data[1:]:
            label = norm(r[0]).lower() if r else ""
            if not label or "total" in label or "end use" in label:
                continue
            if idx_elec >= 0 and idx_elec < len(r):
                summed_elec += _energy_value_to_gj(parse_number(r[idx_elec]), hdr[idx_elec] if idx_elec < len(hdr) else "")
            if idx_gas >= 0 and idx_gas < len(r):
                summed_gas += _energy_value_to_gj(parse_number(r[idx_gas]), hdr[idx_gas] if idx_gas < len(hdr) else "")
    # If any table provides Total End Uses, trust the largest total candidate (avoids split-table double counting).
    if total_rows:
        best = max(total_rows, key=lambda x: (x[0] + x[1]))
        return {"electricity_gj": best[0], "natural_gas_gj": best[1]}
    return {"electricity_gj": summed_elec, "natural_gas_gj": summed_gas}

def build_en1_end_use_summary_table(soup):
    """Build EN1-style End Use summary (single model) in imperial units."""
    rows_gj = _end_uses_rows_gj(soup)
    if not rows_gj:
        return None
    header = [
        "End Use",
        "Electric Usage (kWh)",
        "Gas/Steam Usage (Therm)",
        "Other (kBtu)",
        "% Usage",
        "Model Output Location (Report)",
    ]
    body = []
    total_e = total_g = total_o = total_kbtu = 0.0
    for label, egj, ggj, ogj in rows_gj:
        e_kwh = egj * GJ_TO_KWH
        g_th = ggj * GJ_TO_THERM
        o_kbtu = ogj * GJ_TO_KBTU
        row_kbtu = (egj + ggj + ogj) * GJ_TO_KBTU
        total_e += e_kwh
        total_g += g_th
        total_o += o_kbtu
        total_kbtu += row_kbtu
        body.append([label, round(e_kwh, 0), round(g_th, 0), round(o_kbtu, 0), row_kbtu, "BEPU / BEPU-P"])
    out_rows = []
    for r in body:
        pct = (100.0 * r[4] / total_kbtu) if total_kbtu > 0 else 0.0
        out_rows.append([r[0], int(r[1]), int(r[2]), int(r[3]), f"{round(pct, 1)}%", r[5]])
    out_rows.sort(key=lambda x: x[0].lower())
    out_rows.append(["TOTAL", int(round(total_e, 0)), int(round(total_g, 0)), int(round(total_o, 0)), "100.0%", "BEPU / BEPU-P"])
    return [header] + out_rows

def build_appendix_g_cost_summary_table(soup):
    """Build EN1-style Purchased Energy Rates & Cost Summary using Con Edison virtual rates."""
    fuels = extract_end_uses_fuel_gj(soup)
    elec_gj = fuels.get("electricity_gj") or 0.0
    gas_gj = fuels.get("natural_gas_gj") or 0.0
    elec_kwh = elec_gj * GJ_TO_KWH
    gas_therm = gas_gj * GJ_TO_THERM
    elec_cost = elec_kwh * CONED_VIRTUAL_ELEC_RATE_PER_KWH
    gas_cost = gas_therm * CONED_VIRTUAL_GAS_RATE_PER_THERM
    total_cost = elec_cost + gas_cost
    header = [
        "Fuel",
        "Utility Rate Structure",
        "Virtual Utility Rate ($/unit)",
        "Model Energy",
        "Design Total Charge ($)",
        "Provider",
    ]
    rows = [
        [
            "Electric",
            "Appendix G PRM (virtual rates)",
            round(CONED_VIRTUAL_ELEC_RATE_PER_KWH, 4),
            f"{round(elec_kwh, 0)} kWh",
            round(elec_cost, 0),
            "Con Edison",
        ],
        [
            "Gas/Steam",
            "Appendix G PRM (virtual rates)",
            round(CONED_VIRTUAL_GAS_RATE_PER_THERM, 4),
            f"{round(gas_therm, 0)} therm",
            round(gas_cost, 0),
            "Con Edison",
        ],
        ["TOTAL", "", "", "", round(total_cost, 0), ""],
    ]
    return [header] + rows

class _DrawingFlowable(Flowable):
    """Wrap reportlab Drawing for use in Platypus flow."""
    def __init__(self, drawing):
        Flowable.__init__(self)
        self.drawing = drawing
        self.width = drawing.width
        self.height = drawing.height
    def draw(self):
        self.drawing.drawOn(self.canv, 0, 0)

class _SectionMarker(Flowable):
    """Zero-size flowable that records current page when drawn. Used for Document Index section tracking."""
    def __init__(self, section_key: str, section_pages: list):
        Flowable.__init__(self)
        self.section_key = section_key
        self.section_pages = section_pages
        self.height = 0
        self.width = 0

    def draw(self):
        try:
            if hasattr(self, "canv") and self.canv:
                pg = self.canv.getPageNumber()
                self.section_pages.append((self.section_key, pg))
        except Exception:
            pass

def _draw_end_use_chart(data, width=4*inch, height=3*inch):
    """Create ReportLab Drawing with pie chart. data: [(label, value), ...]. Returns Flowable or None.
    Uses distinct colors, legend (no overlapping labels), no slice popout."""
    if not _HAS_GRAPHICS or not data:
        return None
    total = sum(v for _, v in data)
    if total <= 0:
        return None
    drawing = Drawing(width=width, height=height)
    pie = Pie()
    pie.x = 0.3*inch
    pie.y = 0.2*inch
    sz = min(width - 2.2*inch, height - 0.6*inch)
    pie.width = pie.height = sz
    pie.data = [v for _, v in data]
    use_legend = Legend is not None
    pie.labels = [] if use_legend else [lab for lab, _ in data]
    pie.sideLabels = False
    pie.slices.strokeWidth = 0.5
    pie.slices.strokeColor = colors.HexColor("#cccccc")
    for i in range(len(pie.slices)):
        pie.slices[i].popout = 0
    palette = [
        colors.HexColor("#e63946"),
        colors.HexColor("#457b9d"),
        colors.HexColor("#2a9d8f"),
        colors.HexColor("#e9c46a"),
        colors.HexColor("#f4a261"),
        colors.HexColor("#9b5de5"),
        colors.HexColor("#00b4d8"),
        colors.HexColor("#06d6a0"),
        colors.HexColor("#ef476f"),
        colors.HexColor("#118ab2"),
        colors.HexColor("#83c5be"),
        colors.HexColor("#ffd166"),
    ]
    try:
        for i in range(min(len(pie.slices), len(palette))):
            pie.slices[i].fillColor = palette[i % len(palette)]
    except Exception:
        pass
    drawing.add(pie)
    if Legend is not None:
        legend = Legend()
        legend.x = pie.x + sz + 0.18*inch
        legend.y = pie.y + sz - 2
        legend.boxAnchor = "nw"
        legend.fontName = "Helvetica"
        legend.fontSize = 8
        legend.dx = 4
        legend.dy = 4
        legend.dxTextSpace = 4
        legend.deltay = 9
        # columnMaximum is max rows per column; keep high to avoid a single horizontal strip.
        legend.columnMaximum = max(8, len(data))
        legend.alignment = "left"
        pct_fmt = lambda lab, val: f"{lab} ({round(100*val/total, 1)}%)" if total else lab
        legend.colorNamePairs = [
            (pie.slices[i].fillColor if i < len(pie.slices) else palette[i % len(palette)],
             pct_fmt(lab, val))
            for i, (lab, val) in enumerate(data)
        ]
        drawing.add(legend)
    return _DrawingFlowable(drawing)

def _draw_schedule_chart(profile, width=4.4*inch, height=2.2*inch):
    """Draw one schedule profile chart with coordinate axes and grid."""
    if not _HAS_GRAPHICS or not _is_complete_daily_schedule(profile):
        return None
    vals = profile.get("vals") if isinstance(profile, dict) else None
    xlabels = profile.get("xlabels") if isinstance(profile, dict) else None
    unit = profile.get("unit", "value") if isinstance(profile, dict) else "value"
    if not vals:
        return None
    d = Drawing(width, height)
    vmin = min(vals)
    vmax = max(vals)
    if abs(vmax - vmin) < 1e-6:
        vmax = vmin + 1.0
    pad = (vmax - vmin) * 0.12
    # Prefer step-style plot (no implied interpolation ramps between hour bins).
    if LinePlot is not None and len(vals) >= 2:
        lp = LinePlot()
        lp.x = 38
        lp.y = 26
        lp.width = max(120, width - 66)
        lp.height = max(90, height - 54)
        pts = [(1, vals[0])]
        for h in range(1, len(vals)):
            x = h + 1
            pts.append((x, vals[h - 1]))  # horizontal segment end
            pts.append((x, vals[h]))      # vertical step
        lp.data = [pts]
        lp.lines[0].strokeColor = colors.HexColor("#22d3ee")
        lp.lines[0].strokeWidth = 1.8
        lp.joinedLines = 1
        lp.xValueAxis.valueMin = 1
        lp.xValueAxis.valueMax = 24
        lp.xValueAxis.valueStep = 1
        lp.xValueAxis.labels.fontName = "Helvetica"
        lp.xValueAxis.labels.fontSize = 6
        lp.yValueAxis.valueMin = vmin - pad
        lp.yValueAxis.valueMax = vmax + pad
        lp.yValueAxis.labels.fontName = "Helvetica"
        lp.yValueAxis.labels.fontSize = 6
        lp.yValueAxis.visibleGrid = 1
        lp.yValueAxis.gridStrokeColor = colors.HexColor("#334155")
        lp.yValueAxis.gridStrokeWidth = 0.3
        d.add(lp)
        axis_x = lp.x
        axis_y = lp.y
        axis_w = lp.width
        axis_h = lp.height
    else:
        if HorizontalLineChart is None:
            return None
        lc = HorizontalLineChart()
        lc.x = 38
        lc.y = 26
        lc.width = max(120, width - 66)
        lc.height = max(90, height - 54)
        lc.data = [vals]
        lc.joinedLines = 1
        lc.lines[0].strokeColor = colors.HexColor("#22d3ee")
        lc.lines[0].strokeWidth = 1.8
        if xlabels and len(xlabels) == len(vals):
            lc.categoryAxis.categoryNames = [norm(x)[:12] for x in xlabels]
        else:
            lc.categoryAxis.categoryNames = [str(i) for i in range(1, len(vals) + 1)]
        lc.categoryAxis.labels.boxAnchor = "n"
        lc.categoryAxis.labels.fontName = "Helvetica"
        lc.categoryAxis.labels.fontSize = 6
        lc.valueAxis.labels.fontName = "Helvetica"
        lc.valueAxis.labels.fontSize = 6
        lc.valueAxis.visibleGrid = 1
        lc.valueAxis.gridStrokeColor = colors.HexColor("#334155")
        lc.valueAxis.gridStrokeWidth = 0.3
        lc.valueAxis.valueMin = vmin - pad
        lc.valueAxis.valueMax = vmax + pad
        d.add(lc)
        axis_x = lc.x
        axis_y = lc.y
        axis_w = lc.width
        axis_h = lc.height
    if String is not None:
        d.add(String(axis_x + axis_w - 8, 8, "Hour [hr]", fontName="Helvetica", fontSize=7, textAnchor="end"))
        # Keep Y-axis label away from top tick labels to avoid visual overlap.
        d.add(String(2, axis_y + axis_h + 4, f"Y [{unit}]", fontName="Helvetica", fontSize=7))
    return _DrawingFlowable(d)

def get_col_index(header_row, col_names):
    """Return column index for first matching header substring (case-insensitive)."""
    for i, h in enumerate(header_row):
        hlo = norm(h).lower()
        if not hlo:
            continue
        for name in col_names:
            nlo = name.lower()
            if not nlo:
                continue
            if nlo in hlo or hlo in nlo:
                return i
    return -1

def _is_air_side_hvac_name(name: str) -> bool:
    """Exclude non-air-side items: plant pumps, boilers, water loops, design days, generic types."""
    n = (name or "").strip()
    if not n:
        return False
    nlo = n.lower()
    # Design day names (e.g. NEW YORK LAGUARDIA ARPT ANN HTG 99.6% CONDNS DB)
    if "condns" in nlo or "htg 99" in nlo or "design day" in nlo or "ann htg" in nlo:
        return False
    # Plant/water loops and boilers (exclude loop names, not coils like HOT WATER LOOP WATER HTG COIL)
    if any(k in nlo for k in ("service water loop", "plant loop", "condenser loop", "service water heating")):
        return False
    if nlo in ("hot water loop", "hot water loop pump"):
        return False
    if "boiler" in nlo:
        return False
    # Standalone plant pumps (exclude CONST 1SPD PUMP etc.; keep coil/fan/PTAC pumps as part of equipment)
    if "pump" in nlo and not any(k in nlo for k in ("coil", "fan", "ptac", "heat pump", "packaged", "erv", "ahu")):
        return False
    # Too generic
    if nlo == "residential":
        return False
    return True

def get_col_index_excluding(header_row, col_names, exclude_substrings):
    """Like get_col_index but skip headers containing any exclude_substrings (case-insensitive)."""
    ex = [s.lower() for s in exclude_substrings]
    for i, h in enumerate(header_row):
        hlo = norm(h).lower()
        if not hlo or any(e in hlo for e in ex):
            continue
        for name in col_names:
            nlo = name.lower()
            if not nlo:
                continue
            if nlo in hlo or hlo in nlo:
                return i
    return -1

def _is_below_grade_wall(constr_name: str) -> bool:
    """Identify below-grade/ground-contact walls. EN-1 percentages use above-grade only (wall area left after openings)."""
    c = (constr_name or "").lower()
    return any(k in c for k in ("below grade", "belowgrade", "ground", "groundcontact", "ground contact",
                                "cellar", "foundation", "basement", "_gro_", "grade wall"))

def extract_opaque_exterior_aggregated(soup):
    """Aggregate Opaque Exterior by Construction for above-grade walls (tilt=90). Returns dict: construction -> {N,E,S,W areas, U, total}.
    Assumes opaque exterior area already excludes openings (modeling output, not drafting); fenestration is reported separately."""
    hit = find_table_by_title_contains(soup, ["opaque exterior"])
    if not hit:
        return {}
    _, table = hit
    data = table_to_matrix(table)
    if len(data) < 2:
        return {}
    hdr = data[0]
    idx_const = get_col_index(hdr, ["construction"])
    idx_u = get_col_index(hdr, ["u-factor with film", "u-factor"])
    idx_area = get_col_index(hdr, ["gross area", "area"])
    idx_tilt = get_col_index(hdr, ["tilt"])
    idx_card = get_col_index(hdr, ["cardinal direction", "direction"])
    if idx_const < 0 or idx_u < 0 or idx_area < 0:
        return {}
    agg = {}
    for row in data[1:]:
        tilt_str = str(row[idx_tilt]) if idx_tilt >= 0 else ""
        tilt_val = parse_number(tilt_str) or 0
        if abs(tilt_val - 90) > 5:
            continue
        const = norm(row[idx_const])
        if not const:
            continue
        area_val = parse_number(row[idx_area] if idx_area < len(row) else "")
        u_val = parse_number(row[idx_u] if idx_u < len(row) else "")
        card = norm(row[idx_card]) if idx_card >= 0 and idx_card < len(row) else ""
        key = _cardinal_to_nsew(card)
        if const not in agg:
            agg[const] = {"U": u_val or 0, "N": 0, "E": 0, "S": 0, "W": 0, "Other": 0}
        area_m2 = area_val or 0
        agg[const][key] = agg[const].get(key, 0) + area_m2
    return agg

def _get_fenestration_by_parent_m2(soup):
    """Return dict: parent_surface_name -> fenestration area (m2). Used for net opaque calc."""
    hit_fen = find_table_by_title_contains(soup, ["exterior fenestration"])
    if not hit_fen:
        return {}
    _, tbl = hit_fen
    data = table_to_matrix(tbl)
    if len(data) < 2:
        return {}
    hdr = data[0]
    idx_area = get_col_index(hdr, ["area of multiplied openings", "area of openings", "glass area", "gross area", "area"])
    idx_parent = get_col_index(hdr, ["parent surface", "parent", "base surface"])
    if idx_area < 0 or idx_parent < 0:
        return {}
    out = {}
    for row in data[1:]:
        parent = norm(row[idx_parent]) if idx_parent < len(row) else ""
        if parent:
            a = parse_number(row[idx_area]) if idx_area < len(row) else 0
            out[parent] = out.get(parent, 0) + (a or 0)
    return out

def _get_wall_fenestration_m2(soup):
    """Sum fenestration area on above-grade walls only."""
    fen_by_parent = _get_fenestration_by_parent_m2(soup)
    wall_names = set()
    hit_opaque = find_table_by_title_contains(soup, ["opaque exterior"])
    if hit_opaque:
        _, tbl = hit_opaque
        data = table_to_matrix(tbl)
        if len(data) >= 2:
            hdr = data[0]
            idx_surf = get_col_index(hdr, ["surface", "object name", "name"])
            idx_tilt = get_col_index(hdr, ["tilt"])
            if idx_surf < 0:
                idx_surf = 0
            for row in data[1:]:
                tilt_val = parse_number(str(row[idx_tilt])) if idx_tilt >= 0 else 0
                if abs((tilt_val or 0) - 90) <= 5:
                    s = norm(row[idx_surf]) if idx_surf < len(row) else ""
                    if s:
                        wall_names.add(s)
    return sum(fen_by_parent.get(p, 0) for p in wall_names)

def extract_opaque_exterior_aggregated_net(soup):
    """DEPRECATED: Subtracts fenestration from opaque area. Do not use—opaque exterior already excludes openings in EnergyPlus."""
    gross_agg = extract_opaque_exterior_aggregated(soup)
    fen_by_parent = _get_fenestration_by_parent_m2(soup)
    if not fen_by_parent:
        return gross_agg
    hit = find_table_by_title_contains(soup, ["opaque exterior"])
    if not hit:
        return gross_agg
    _, table = hit
    data = table_to_matrix(table)
    if len(data) < 2:
        return gross_agg
    hdr = data[0]
    idx_const = get_col_index(hdr, ["construction"])
    idx_surf = get_col_index(hdr, ["surface", "object name", "name"])
    idx_area = get_col_index(hdr, ["gross area", "area"])
    idx_u = get_col_index(hdr, ["u-factor with film", "u-factor"])
    idx_tilt = get_col_index(hdr, ["tilt"])
    idx_card = get_col_index(hdr, ["cardinal direction", "direction"])
    if idx_const < 0 or idx_area < 0:
        return gross_agg
    if idx_surf < 0:
        idx_surf = 0  # first col typically surface/object name in EnergyPlus Envelope Summary
    net_agg = {}
    for row in data[1:]:
        tilt_val = parse_number(str(row[idx_tilt])) if idx_tilt >= 0 else 0
        if abs((tilt_val or 0) - 90) > 5:
            continue
        const = norm(row[idx_const])
        if not const:
            continue
        surf = norm(row[idx_surf]) if idx_surf < len(row) else ""
        gross = parse_number(row[idx_area]) if idx_area < len(row) else 0
        fen = fen_by_parent.get(surf, 0)
        net = max(0, (gross or 0) - fen)
        if net <= 0:
            continue
        card = norm(row[idx_card]) if idx_card >= 0 and idx_card < len(row) else ""
        key = _cardinal_to_nsew(card)
        u_val = parse_number(row[idx_u]) if idx_u >= 0 and idx_u < len(row) else 0
        if const not in net_agg:
            net_agg[const] = {"U": u_val or 0, "N": 0, "E": 0, "S": 0, "W": 0, "Other": 0}
        net_agg[const][key] = net_agg[const].get(key, 0) + net
    return net_agg if net_agg else gross_agg

def extract_opaque_exterior_roofs(soup):
    """Aggregate Opaque Exterior by Construction for roofs (tilt 0-75). Returns dict: construction -> {area, U}."""
    hit = find_table_by_title_contains(soup, ["opaque exterior"])
    if not hit:
        return {}
    _, table = hit
    data = table_to_matrix(table)
    if len(data) < 2:
        return {}
    hdr = data[0]
    idx_const = get_col_index(hdr, ["construction"])
    idx_u = get_col_index(hdr, ["u-factor with film", "u-factor"])
    idx_area = get_col_index(hdr, ["gross area", "area"])
    idx_tilt = get_col_index(hdr, ["tilt"])
    if idx_const < 0 or idx_u < 0 or idx_area < 0:
        return {}
    agg = {}
    for row in data[1:]:
        tilt_str = str(row[idx_tilt]) if idx_tilt >= 0 else ""
        tilt_val = parse_number(tilt_str) or 0
        if tilt_val > 75 or tilt_val < 0:
            continue
        const = norm(row[idx_const])
        if not const:
            continue
        area_val = parse_number(row[idx_area] if idx_area < len(row) else "")
        u_val = parse_number(row[idx_u] if idx_u < len(row) else "")
        if const not in agg:
            agg[const] = {"U": u_val, "Area_m2": 0}
        if u_val is not None:
            agg[const]["U"] = u_val
        agg[const]["Area_m2"] = agg[const].get("Area_m2", 0) + (area_val or 0)
    return agg

def extract_opaque_exterior_floors(soup):
    """Aggregate Opaque Exterior by Construction for floors (tilt 0 with floor/ground in name, or tilt 180)."""
    hit = find_table_by_title_contains(soup, ["opaque exterior"])
    if not hit:
        return {}
    _, table = hit
    data = table_to_matrix(table)
    if len(data) < 2:
        return {}
    hdr = data[0]
    idx_const = get_col_index(hdr, ["construction"])
    idx_u = get_col_index(hdr, ["u-factor with film", "u-factor"])
    idx_area = get_col_index(hdr, ["gross area", "area"])
    idx_tilt = get_col_index(hdr, ["tilt"])
    if idx_const < 0 or idx_u < 0 or idx_area < 0:
        return {}
    agg = {}
    floor_keywords = ("floor", "ground", "slab", "grade")
    for row in data[1:]:
        tilt_str = str(row[idx_tilt]) if idx_tilt >= 0 else ""
        tilt_val = parse_number(tilt_str) or 0
        const = norm(row[idx_const])
        if not const:
            continue
        is_floor = tilt_val >= 175 or (tilt_val <= 5 and any(k in const.lower() for k in floor_keywords))
        if not is_floor:
            continue
        area_val = parse_number(row[idx_area] if idx_area < len(row) else "")
        u_val = parse_number(row[idx_u] if idx_u < len(row) else "")
        if const not in agg:
            agg[const] = {"U": u_val, "Area_m2": 0}
        if u_val is not None:
            agg[const]["U"] = u_val
        agg[const]["Area_m2"] = agg[const].get("Area_m2", 0) + (area_val or 0)
    return agg

def _is_residential_zone(zone_name: str) -> bool:
    """Classify zone as Residential for Commercial vs Residential fenestration split."""
    z = (zone_name or "").lower()
    res_keywords = ("residential", "dwelling", "apartment", "living", "bedroom", "dining room",
                    "res", "apt", "condo", "multifamily")
    return any(k in z for k in res_keywords)

def extract_fenestration_aggregated(soup):
    """Aggregate Exterior Fenestration by Construction. Returns dict with areas by direction, U, SHGC, VLT.
    When Zone column exists: aggregates by (Category, Construction) for Commercial vs Residential split.
    Keys: construction str (legacy) or ("Commercial", const) / ("Residential", const)."""
    hit = find_table_by_title_contains(soup, ["exterior fenestration"])
    if not hit:
        return {}
    _, table = hit
    data = table_to_matrix(table)
    if len(data) < 2:
        return {}
    hdr = data[0]
    idx_const = get_col_index(hdr, ["construction"])
    idx_u = get_col_index(hdr, ["glass u-factor", "assembly u-factor", "u-factor"])
    idx_shgc = get_col_index(hdr, ["shgc", "glass shgc", "assembly shgc"])
    idx_vlt = get_col_index(hdr, ["visible transmittance", "vlt"])
    idx_area = get_col_index(hdr, ["area of multiplied openings", "glass area", "gross area", "area"])
    idx_card = get_col_index(hdr, ["cardinal direction", "direction"])
    idx_zone = get_col_index(hdr, ["zone name", "zone", "space name", "space"])
    if idx_const < 0 or idx_area < 0:
        return {}
    agg = {}
    for row in data[1:]:
        const = norm(row[idx_const])
        if not const:
            continue
        zone = norm(row[idx_zone]) if idx_zone >= 0 and idx_zone < len(row) else ""
        has_zone = bool(zone)
        is_res = _is_residential_zone(zone) if has_zone else False
        cat = "Residential" if (has_zone and is_res) else "Commercial"
        key = (cat, const) if has_zone else const
        area_val = parse_number(row[idx_area] if idx_area < len(row) else "")
        u_val = parse_number(row[idx_u] if idx_u >= 0 and idx_u < len(row) else "")
        shgc = parse_number(row[idx_shgc] if idx_shgc >= 0 and idx_shgc < len(row) else "")
        vlt = parse_number(row[idx_vlt] if idx_vlt >= 0 and idx_vlt < len(row) else "")
        card = norm(row[idx_card]) if idx_card >= 0 and idx_card < len(row) else ""
        dir_key = _cardinal_to_nsew(card)
        area_m2 = area_val or 0
        if key not in agg:
            agg[key] = {"U": u_val, "SHGC": shgc, "VLT": vlt, "N": 0, "E": 0, "S": 0, "W": 0, "Other": 0}
        if u_val is not None:
            agg[key]["U"] = u_val
        if shgc is not None:
            agg[key]["SHGC"] = shgc
        if vlt is not None:
            agg[key]["VLT"] = vlt
        agg[key][dir_key] = agg[key].get(dir_key, 0) + area_m2
    return agg

def extract_space_type_summary(soup):
    """Extract building area type, area, and LPD from Space Type Summary (for Building Area Method).
    Returns list of dicts: {SpaceType, TotalArea_m2, Lighting_Wm2}. Excludes 'Total' row."""
    hit = find_table_by_title_contains(soup, ["space type summary"])
    if not hit:
        return []
    _, table = hit
    data = table_to_matrix(table)
    if len(data) < 2:
        return []
    hdr = data[0]
    idx_type = get_col_index(hdr, ["space type", "building area", "name"])
    if idx_type < 0:
        idx_type = 0
    idx_area = get_col_index(hdr, ["total area", "conditioned area"])
    idx_lpd = get_col_index(hdr, ["lighting", "w/m2", "lpd"])
    if idx_area < 0:
        idx_area = 1
    rows = []
    for r in data[1:]:
        stype = norm(r[idx_type]) if idx_type < len(r) else ""
        if not stype or stype.lower() == "total":
            continue
        area = parse_number(r[idx_area]) if idx_area < len(r) else None
        lpd = parse_number(r[idx_lpd]) if idx_lpd >= 0 and idx_lpd < len(r) else None
        if area is not None and area > 0:
            rows.append({"SpaceType": stype, "TotalArea_m2": area, "Lighting_Wm2": lpd})
    return rows

def _has_daylighting_controls(soup):
    """Check if Daylighting table has any active controls. Returns (auto_ctrl, daylight_ctrl)."""
    hit = find_table_by_title_contains(soup, ["daylighting"])
    if not hit:
        return False, False
    _, table = hit
    data = table_to_matrix(table)
    if len(data) < 2:
        return False, False
    text = " ".join(" ".join(str(c) for c in r) for r in data).lower()
    has_daylight = "continuous" in text or "step" in text or "control" in text
    return has_daylight, has_daylight

def extract_lighting_space_summary(soup):
    """Extract space-by-space lighting from Space Summary. Returns list of dicts."""
    hit = find_table_by_title_contains(soup, ["space summary"])
    if not hit:
        return []
    _, table = hit
    data = table_to_matrix(table)
    if len(data) < 2:
        return []
    hdr = data[0]
    idx_name = get_col_index(hdr, ["space", "name"])
    if idx_name < 0:
        idx_name = 0
    idx_area = get_col_index(hdr, ["area"])
    idx_lpd = get_col_index(hdr, ["lighting", "w/m2", "lpd"])
    if idx_area < 0:
        idx_area = 1
    rows = []
    for r in data[1:]:
        name = norm(r[idx_name]) if idx_name < len(r) else ""
        area = parse_number(r[idx_area]) if idx_area < len(r) else None
        lpd = parse_number(r[idx_lpd]) if idx_lpd >= 0 and idx_lpd < len(r) else None
        if name and area is not None and area > 0:
            rows.append({"Space": name, "Area_m2": area, "LPD_Wm2": lpd})
    return rows

def extract_hvac_coil_sizing(soup):
    """Extract HVAC coil/system sizing for EN-1. Broad capture: cooling, heating, flow, EER, COP, HSPF, Fan kW."""
    hvac_keywords = ("coil", "component", "equipment", "dx", "unitary", "sizing", "fan", "pump", "boiler",
                     "chiller", "condenser", "cooling tower", "air loop", "zone equipment", "split system",
                     "heat pump", "variable", "single speed")
    out = []
    for table in soup.find_all("table"):
        prev = table.previous_sibling
        title = ""
        for _ in range(30):
            if prev is None:
                break
            if getattr(prev, "name", None) == "b":
                title = norm(prev.get_text(" ", strip=True))
                break
            prev = getattr(prev, "previous_sibling", None)
        tlo = title.lower()
        if not any(kw in tlo for kw in hvac_keywords):
            continue
        data = table_to_matrix(table)
        if len(data) < 2:
            continue
        hdr = data[0]
        if "coil sizing summary" in tlo:
            idx_coil_type = get_col_index(hdr, ["coil type"])
            idx_cap = get_col_index(hdr, ["coil final gross total capacity", "gross total capacity"])
            idx_hvac_name = get_col_index(hdr, ["hvac name", "air loop name", "system name"])
            idx_air_flow = get_col_index_excluding(
                hdr,
                ["reference air volume flow rate", "air volume flow rate", "air flow", "m3/s", "cfm"],
                ["plant fluid", "water"],
            )
            if idx_coil_type >= 0 and idx_cap >= 0:
                for r in data[1:]:
                    coil_name = norm(r[0]) if r and len(r) > 0 else ""
                    system_name = norm(r[idx_hvac_name]) if idx_hvac_name >= 0 and idx_hvac_name < len(r) else ""
                    name = system_name or coil_name
                    if not name or name.lower() in ("total", "sum"):
                        continue
                    coil_type = norm(r[idx_coil_type]) if idx_coil_type < len(r) else ""
                    cap = parse_number(r[idx_cap]) if idx_cap < len(r) else None
                    flow = parse_number(r[idx_air_flow]) if idx_air_flow >= 0 and idx_air_flow < len(r) else None
                    if cap is None:
                        continue
                    ct_lo = coil_type.lower()
                    cool = cap if "cooling" in ct_lo else None
                    heat = cap if "heating" in ct_lo else None
                    if _is_air_side_hvac_name(name):
                        out.append({"Name": name, "Flow_m3s": flow, "Cool_W": cool, "Heat_W": heat, "EER": None, "COP": None, "HSPF": None, "Fan_kW": None})
            continue
        idx_name = get_col_index(hdr, ["name", "object", "coil", "system", "component"])
        if idx_name < 0:
            idx_name = 0
        idx_flow = get_col_index_excluding(hdr, ["air flow", "rated air flow", "design size rated air flow", "flow rate", "m3/s", "cfm"], ["water"])
        idx_cool = get_col_index_excluding(hdr, ["cooling capacity", "total cooling", "gross rated cooling", "gross rated total cooling", "rated capacity", "design cooling"], ["heating"])
        idx_heat = get_col_index_excluding(hdr, ["heating capacity", "gross rated heating", "rated heating", "design heating", "rated capacity", "design size rated capacity"], ["cooling"])
        if "coil:heating" in tlo or "heating:water" in tlo:
            idx_cool = -1
        elif "coil:cooling" in tlo or "cooling:dx" in tlo:
            idx_heat = -1
        idx_eer = get_col_index(hdr, ["eer", "energy efficiency ratio"])
        idx_cop = get_col_index(hdr, ["cop", "coefficient of performance"])
        idx_hspf = get_col_index(hdr, ["hspf", "heating seasonal"])
        idx_fan_kw = get_col_index(hdr, ["fan power", "fan kw", "electric power", "design power"])
        is_plant_only = ("pump" in tlo or "boiler" in tlo or "plant loop" in tlo) and not any(k in tlo for k in ("coil", "fan", "unitary", "dx", "heat pump"))
        if is_plant_only:
            idx_eer = idx_cop = idx_hspf = -1
            idx_flow = -1
        for r in data[1:]:
            name = norm(r[idx_name]) if r and idx_name < len(r) else ""
            if not name or name.lower() in ("total", "sum"):
                continue
            flow = parse_number(r[idx_flow]) if idx_flow >= 0 and idx_flow < len(r) else None
            cool = parse_number(r[idx_cool]) if idx_cool >= 0 and idx_cool < len(r) else None
            heat = parse_number(r[idx_heat]) if idx_heat >= 0 and idx_heat < len(r) else None
            eer = parse_number(r[idx_eer]) if idx_eer >= 0 and idx_eer < len(r) else None
            cop = parse_number(r[idx_cop]) if idx_cop >= 0 and idx_cop < len(r) else None
            hspf = parse_number(r[idx_hspf]) if idx_hspf >= 0 and idx_hspf < len(r) else None
            fan_kw = parse_number(r[idx_fan_kw]) if idx_fan_kw >= 0 and idx_fan_kw < len(r) else None
            if not _is_air_side_hvac_name(name):
                continue
            if flow is not None or cool is not None or heat is not None or eer is not None or cop is not None or hspf is not None or fan_kw is not None:
                out.append({"Name": name, "Flow_m3s": flow, "Cool_W": cool, "Heat_W": heat, "EER": eer, "COP": cop, "HSPF": hspf, "Fan_kW": fan_kw})
    return out

# Units preference: set by generate_package, read by all conversion/formatters
_USE_IMPERIAL = True

def _m2_to_ft2(x):
    return x * 10.7639104167 if x is not None else None

def _w_m2k_to_btu_hr_ft2_f(x):
    return round(x * 0.17612, 3) if x is not None else None

def _w_to_btu_hr(x):
    return round(x * 3.412141633, 1) if x is not None else None

def _m3s_to_cfm(x):
    return round(x * 2118.88, 0) if x is not None else None

def _w_m2_to_w_ft2(x):
    return round(x * 0.092903, 3) if x is not None else None

def _fmt_area(x):
    """Format area: ft² if imperial, m² if metric."""
    if x is None or x == 0 or x == "":
        return ""
    return round(_m2_to_ft2(x), 0) if _USE_IMPERIAL else round(x, 2)

def _fmt_u(x):
    """Format U-factor: Btu/(h·ft²·°F) if imperial, W/(m²·K) if metric."""
    if x is None:
        return ""
    return round(_w_m2k_to_btu_hr_ft2_f(x), 3) if _USE_IMPERIAL else round(x, 4)

def _area_unit():
    return "ft²" if _USE_IMPERIAL else "m²"

def _u_unit():
    return "Btu/(h·ft²·°F)" if _USE_IMPERIAL else "W/(m²·K)"

def _flow_unit():
    return "CFM" if _USE_IMPERIAL else "m³/s"

def _power_unit():
    return "Btu/h" if _USE_IMPERIAL else "W"

def _lpd_unit():
    return "W/ft²" if _USE_IMPERIAL else "W/m²"

def _fmt_flow(x):
    """Format flow: CFM if imperial, m³/s if metric."""
    if x is None:
        return ""
    return _m3s_to_cfm(x) if _USE_IMPERIAL else round(x, 4)

def _fmt_power_btu(x):
    """Format power for HVAC: Btu/h if imperial, W if metric."""
    if x is None:
        return ""
    return round(_w_to_btu_hr(x), 0) if _USE_IMPERIAL else round(x, 0)

def _fmt_lpd(x):
    """Format LPD: W/ft² if imperial, W/m² if metric."""
    if x is None:
        return ""
    return round(_w_m2_to_w_ft2(x), 2) if _USE_IMPERIAL else round(x, 2)

def _units_note():
    return "US imperial" if _USE_IMPERIAL else "metric (SI)"

def _pct_str(v):
    return f"{v}%" if v != "" else ""

def _fen_total_m2(agg):
    """Sum total fenestration area (m2) from extract_fenestration_aggregated output."""
    if not agg:
        return 0
    return sum(sum(v.get(d, 0) for d in "NSEW") + v.get("Other", 0) for v in agg.values() if isinstance(v, dict))

def extract_wwr_table_data(soup):
    """Extract WWR table values directly (source of truth). Prefers Window-Wall Ratio over Conditioned WWR.
    Returns dict with areas (m²) and percentages: above_ground_m2, fenestration_m2, gross_wall_m2,
    above_N/E/S/W, fen_N/E/S/W, gross_N/E/S/W, gross_wwr_pct (total + by dir), above_ground_wwr_pct.
    Report values assumed m² if label contains [m2], else ft² (converted to m² for internal use)."""
    hits = find_tables_by_keywords(soup, ["window-wall ratio", "conditioned window", "above ground wall", "window opening"])
    conditioned = None
    gross = None
    for ttitle, table in hits:
        tlo = (ttitle or "").lower()
        data = table_to_matrix(table)
        if len(data) < 2:
            continue
        hdr = data[0]
        idx_total = get_col_index(hdr, ["total", "gross total"]) if hdr else -1
        if idx_total < 0:
            idx_total = 1 if len(hdr) > 1 else 0
        idx_n = get_col_index(hdr, ["north"])
        idx_e = get_col_index(hdr, ["east"])
        idx_s = get_col_index(hdr, ["south"])
        idx_w = get_col_index(hdr, ["west"])

        def _unit_conv(label):
            lab = (label or "").lower()
            return (1.0 / 10.7639) if "ft" in lab and "m2" not in lab and "m²" not in lab else 1.0

        above_m2, fen_m2, gross_m2 = None, None, None
        above_n, above_e, above_s, above_w = 0, 0, 0, 0
        fen_n, fen_e, fen_s, fen_w = 0, 0, 0, 0
        gross_n, gross_e, gross_s, gross_w = 0, 0, 0, 0
        gross_pct, gross_pct_n, gross_pct_e, gross_pct_s, gross_pct_w = None, None, None, None, None
        above_pct, above_pct_n, above_pct_e, above_pct_s, above_pct_w = None, None, None, None, None

        for row in data[1:]:
            if not row:
                continue
            label = (norm(row[0]) if row else "").lower()
            val_total = parse_number(row[idx_total]) if idx_total < len(row) else None
            if val_total is None and "ratio" not in label:
                continue
            to_m2 = _unit_conv(label)
            conv = lambda v: (v * to_m2 if v is not None else 0) if "%" not in label and "ratio" not in label else (v if v is not None else 0)
            _n = parse_number(row[idx_n]) if idx_n >= 0 and idx_n < len(row) else None
            _e = parse_number(row[idx_e]) if idx_e >= 0 and idx_e < len(row) else None
            _s = parse_number(row[idx_s]) if idx_s >= 0 and idx_s < len(row) else None
            _w = parse_number(row[idx_w]) if idx_w >= 0 and idx_w < len(row) else None
            if "gross wall" in label and "ratio" not in label and "area" in label:
                gross_m2 = conv(val_total)
                gross_n, gross_e, gross_s, gross_w = conv(_n), conv(_e), conv(_s), conv(_w)
            elif "above ground wall" in label and "ratio" not in label:
                above_m2 = conv(val_total)
                above_n, above_e, above_s, above_w = conv(_n), conv(_e), conv(_s), conv(_w)
            elif "window opening" in label and "ratio" not in label:
                fen_m2 = conv(val_total)
                fen_n, fen_e, fen_s, fen_w = conv(_n), conv(_e), conv(_s), conv(_w)
            elif "gross window-wall ratio" in label or "gross window wall ratio" in label:
                gross_pct = val_total
                gross_pct_n, gross_pct_e, gross_pct_s, gross_pct_w = _n, _e, _s, _w
            elif "above ground window-wall ratio" in label or "above ground window wall ratio" in label:
                above_pct = val_total
                above_pct_n, above_pct_e, above_pct_s, above_pct_w = _n, _e, _s, _w
        if above_m2 is not None or fen_m2 is not None or gross_m2 is not None:
            d = {
                "above_ground_m2": above_m2 or 0, "fenestration_m2": fen_m2 or 0, "gross_wall_m2": gross_m2 or 0,
                "above_N": above_n, "above_E": above_e, "above_S": above_s, "above_W": above_w,
                "fen_N": fen_n, "fen_E": fen_e, "fen_S": fen_s, "fen_W": fen_w,
                "gross_N": gross_n, "gross_E": gross_e, "gross_S": gross_s, "gross_W": gross_w,
                "gross_wwr_pct": gross_pct, "gross_wwr_N": gross_pct_n, "gross_wwr_E": gross_pct_e,
                "gross_wwr_S": gross_pct_s, "gross_wwr_W": gross_pct_w,
                "above_ground_wwr_pct": above_pct, "above_wwr_N": above_pct_n, "above_wwr_E": above_pct_e,
                "above_wwr_S": above_pct_s, "above_wwr_W": above_pct_w,
            }
            if "conditioned" in tlo:
                conditioned = d
            else:
                gross = d
    return gross or conditioned

def _harmonize_wwr_areas(prop_wwr, base_wwr):
    """For EN-1 reporting, keep one geometry basis for area fields (use proposed when available)."""
    if not prop_wwr and not base_wwr:
        return prop_wwr, base_wwr
    p = dict(prop_wwr or {})
    b = dict(base_wwr or {})
    master = p if p else b
    area_keys = [
        "above_ground_m2", "fenestration_m2", "gross_wall_m2",
        "above_N", "above_E", "above_S", "above_W",
        "fen_N", "fen_E", "fen_S", "fen_W",
        "gross_N", "gross_E", "gross_S", "gross_W",
    ]
    for k in area_keys:
        if k in master:
            p[k] = master[k]
            b[k] = master[k]
    return p, b

def build_en1_wall_table(base_soup, prop_soup):
    """Build Above-Grade Wall Performance table. Aligns with Opaque Exterior and Fenestration schedules.
    Opaque target area is net opaque = Above Ground Wall Area - Window Opening Area (from WWR).
    Percent columns are based on net opaque wall denominator."""
    base_agg = extract_opaque_exterior_aggregated(base_soup)
    prop_agg = extract_opaque_exterior_aggregated(prop_soup)
    prop_fen = extract_fenestration_aggregated(prop_soup)
    base_fen = extract_fenestration_aggregated(base_soup)
    prop_wwr = extract_wwr_table_data(prop_soup)
    base_wwr = extract_wwr_table_data(base_soup)
    prop_wwr, base_wwr = _harmonize_wwr_areas(prop_wwr, base_wwr)
    prop_fen_tot = prop_wwr["fenestration_m2"] if (prop_wwr and prop_wwr.get("fenestration_m2")) else _fen_total_m2(prop_fen)
    base_fen_tot = base_wwr["fenestration_m2"] if (base_wwr and base_wwr.get("fenestration_m2")) else _fen_total_m2(base_fen)
    all_const = sorted(set(base_agg) | set(prop_agg))
    constructions = [c for c in all_const if not _is_below_grade_wall(c)]
    if not constructions:
        constructions = all_const

    prop_opaque_raw = sum(sum(prop_agg.get(c, {}).get(d, 0) for d in "NSEW") + prop_agg.get(c, {}).get("Other", 0) for c in constructions)
    base_opaque_raw = sum(sum(base_agg.get(c, {}).get(d, 0) for d in "NSEW") + base_agg.get(c, {}).get("Other", 0) for c in constructions)
    prop_above_wall = prop_wwr["above_ground_m2"] if (prop_wwr and prop_wwr.get("above_ground_m2")) else prop_opaque_raw
    base_above_wall = base_wwr["above_ground_m2"] if (base_wwr and base_wwr.get("above_ground_m2")) else base_opaque_raw
    prop_opaque = max(0.0, prop_above_wall - prop_fen_tot)
    base_opaque = max(0.0, base_above_wall - base_fen_tot)
    prop_gross = max(0.001, prop_above_wall)
    base_gross = max(0.001, base_above_wall)
    # Two independent scales:
    # - display scale: area fields shown in table (above-ground wall basis)
    # - percentage scale: numerator for % (net opaque basis)
    prop_scale_display = prop_gross / prop_opaque_raw if prop_opaque_raw and prop_opaque_raw > 0 else 1.0
    base_scale_display = base_gross / base_opaque_raw if base_opaque_raw and base_opaque_raw > 0 else 1.0
    prop_scale_pct = prop_opaque / prop_opaque_raw if prop_opaque_raw and prop_opaque_raw > 0 else 1.0
    base_scale_pct = base_opaque / base_opaque_raw if base_opaque_raw and base_opaque_raw > 0 else 1.0
    prop_sum_ua, prop_sum_a = 0, 0
    base_sum_ua, base_sum_a = 0, 0
    for c in constructions:
        pa, ba = prop_agg.get(c, {}), base_agg.get(c, {})
        a_p = sum(pa.get(d, 0) for d in "NSEW") + pa.get("Other", 0)
        a_b = sum(ba.get(d, 0) for d in "NSEW") + ba.get("Other", 0)
        if pa.get("U") is not None and a_p:
            prop_sum_ua += pa["U"] * a_p
            prop_sum_a += a_p
        if ba.get("U") is not None and a_b:
            base_sum_ua += ba["U"] * a_b
            base_sum_a += a_b
    u_prop_wtd = prop_sum_ua / prop_sum_a if prop_sum_a else 0
    u_base_wtd = base_sum_ua / base_sum_a if base_sum_a else 0

    out_rows = []
    prop_ne, prop_se, prop_sw, prop_nw, prop_other = 0, 0, 0, 0, 0
    base_ne, base_se, base_sw, base_nw, base_other = 0, 0, 0, 0, 0
    for const in constructions:
        pa, ba = prop_agg.get(const, {}), base_agg.get(const, {})
        np, ep, sp, wp = pa.get("N", 0), pa.get("E", 0), pa.get("S", 0), pa.get("W", 0)
        no, nb, eb, sb, wb = pa.get("Other", 0), ba.get("N", 0), ba.get("E", 0), ba.get("S", 0), ba.get("W", 0)
        nbo = ba.get("Other", 0)
        np_s, ep_s, sp_s, wp_s = np * prop_scale_display, ep * prop_scale_display, sp * prop_scale_display, wp * prop_scale_display
        no_s = no * prop_scale_display
        nb_s, eb_s, sb_s, wb_s = nb * base_scale_display, eb * base_scale_display, sb * base_scale_display, wb * base_scale_display
        nbo_s = nbo * base_scale_display
        prop_ne += np_s; prop_se += ep_s; prop_sw += sp_s; prop_nw += wp_s; prop_other += no_s
        base_ne += nb_s; base_se += eb_s; base_sw += sb_s; base_nw += wb_s; base_other += nbo_s
        tot_p = np_s + ep_s + sp_s + wp_s + no_s
        tot_b = nb_s + eb_s + sb_s + wb_s + nbo_s
        # Net opaque numerator for percentage only.
        tot_p_pct = (np + ep + sp + wp + no) * prop_scale_pct
        tot_b_pct = (nb + eb + sb + wb + nbo) * base_scale_pct
        # Denominator is above-ground wall area; numerator is net opaque assembly area.
        pct_p = round(100.0 * tot_p_pct / prop_gross, 1) if prop_gross else ""
        pct_b = round(100.0 * tot_b_pct / base_gross, 1) if base_gross else ""
        out_rows.append([
            const,
            _fmt_area(np_s), _fmt_area(ep_s), _fmt_area(sp_s), _fmt_area(wp_s),
            _fmt_area(tot_p), _pct_str(pct_p),
            _fmt_u(pa.get("U")),
            _fmt_area(nb_s), _fmt_area(eb_s), _fmt_area(sb_s), _fmt_area(wb_s),
            _fmt_area(tot_b), _pct_str(pct_b),
            _fmt_u(ba.get("U")),
        ])
    def _str(v):
        return "" if v is None or v == "" else str(v)
    # Display Total area as above-ground wall area (EN-1 presentation),
    # while net opaque remains internal for percentage math.
    total_prop_area = prop_gross
    total_base_area = base_gross
    # Keep directional totals from the same assembly-scaled path as row values.
    total_prop_n = prop_ne
    total_prop_e = prop_se
    total_prop_s = prop_sw
    total_prop_w = prop_nw
    total_base_n = base_ne
    total_base_e = base_se
    total_base_s = base_sw
    total_base_w = base_nw
    total_pct_p = round(100.0 * prop_opaque / prop_gross, 1) if prop_gross else ""
    total_pct_b = round(100.0 * base_opaque / base_gross, 1) if base_gross else ""
    total_row = [
        "Total",
        _fmt_area(total_prop_n),
        _fmt_area(total_prop_e),
        _fmt_area(total_prop_s),
        _fmt_area(total_prop_w),
        _fmt_area(total_prop_area), _pct_str(total_pct_p), _fmt_u(u_prop_wtd),
        _fmt_area(total_base_n),
        _fmt_area(total_base_e),
        _fmt_area(total_base_s),
        _fmt_area(total_base_w),
        _fmt_area(total_base_area), _pct_str(total_pct_b), _fmt_u(u_base_wtd),
    ]
    header = [
        "Assembly",
        "Prop NE", "Prop SE", "Prop SW", "Prop NW", "Prop Total", "Prop %", "Proposed U",
        "Base NE", "Base SE", "Base SW", "Base NW", "Base Total", "Base %", "Baseline U",
    ]
    return [header] + [[_str(x) for x in r] for r in out_rows] + [[_str(x) for x in total_row]]

def build_en1_roof_table(base_soup, prop_soup):
    """Build Roof Assemblies table. Proposed and baseline calculated separately—no mixing."""
    base_agg = extract_opaque_exterior_roofs(base_soup)
    prop_agg = extract_opaque_exterior_roofs(prop_soup)
    all_const = sorted(set(base_agg) | set(prop_agg))
    if not all_const:
        return []
    prop_tot = sum(prop_agg.get(c, {}).get("Area_m2", 0) or 0 for c in all_const)
    base_tot = sum(base_agg.get(c, {}).get("Area_m2", 0) or 0 for c in all_const)
    prop_sum_ua, prop_sum_a = 0, 0
    base_sum_ua, base_sum_a = 0, 0
    for c in all_const:
        pa, ba = prop_agg.get(c, {}), base_agg.get(c, {})
        a_p = pa.get("Area_m2", 0) or 0
        a_b = ba.get("Area_m2", 0) or 0
        if pa.get("U") is not None and a_p:
            prop_sum_ua += pa["U"] * a_p
            prop_sum_a += a_p
        if ba.get("U") is not None and a_b:
            base_sum_ua += ba["U"] * a_b
            base_sum_a += a_b
    u_prop_wtd = prop_sum_ua / prop_sum_a if prop_sum_a else 0
    u_base_wtd = base_sum_ua / base_sum_a if base_sum_a else 0
    out_rows = []
    for const in all_const:
        pa, ba = prop_agg.get(const, {}), base_agg.get(const, {})
        a_p = pa.get("Area_m2", 0) or 0
        a_b = ba.get("Area_m2", 0) or 0
        pct_p = round(100.0 * a_p / prop_tot, 1) if prop_tot else ""
        pct_b = round(100.0 * a_b / base_tot, 1) if base_tot else ""
        out_rows.append([
            const,
            _fmt_area(a_p), _pct_str(pct_p),
            _fmt_u(pa.get("U")),
            _fmt_area(a_b), _pct_str(pct_b),
            _fmt_u(ba.get("U")),
        ])
    def _str(v):
        return "" if v is None or v == "" else str(v)
    total_row = [
        "Total",
        _fmt_area(prop_tot), "100.0%", _fmt_u(u_prop_wtd),
        _fmt_area(base_tot), "100.0%", _fmt_u(u_base_wtd),
    ]
    header = ["Assembly", f"Prop Area [{_area_unit()}]", "Prop %", "Proposed U", f"Base Area [{_area_unit()}]", "Base %", "Baseline U"]
    return [header] + [[_str(x) for x in r] for r in out_rows] + [[_str(x) for x in total_row]]

def build_en1_floor_table(base_soup, prop_soup):
    """Build Floor Assemblies table. Proposed and baseline calculated separately—no mixing."""
    base_agg = extract_opaque_exterior_floors(base_soup)
    prop_agg = extract_opaque_exterior_floors(prop_soup)
    all_const = sorted(set(base_agg) | set(prop_agg))
    if not all_const:
        return []
    prop_tot = sum(prop_agg.get(c, {}).get("Area_m2", 0) or 0 for c in all_const)
    base_tot = sum(base_agg.get(c, {}).get("Area_m2", 0) or 0 for c in all_const)
    prop_sum_ua, prop_sum_a = 0, 0
    base_sum_ua, base_sum_a = 0, 0
    for c in all_const:
        pa, ba = prop_agg.get(c, {}), base_agg.get(c, {})
        a_p = pa.get("Area_m2", 0) or 0
        a_b = ba.get("Area_m2", 0) or 0
        if pa.get("U") is not None and a_p:
            prop_sum_ua += pa["U"] * a_p
            prop_sum_a += a_p
        if ba.get("U") is not None and a_b:
            base_sum_ua += ba["U"] * a_b
            base_sum_a += a_b
    u_prop_wtd = prop_sum_ua / prop_sum_a if prop_sum_a else 0
    u_base_wtd = base_sum_ua / base_sum_a if base_sum_a else 0
    out_rows = []
    for const in all_const:
        pa, ba = prop_agg.get(const, {}), base_agg.get(const, {})
        a_p = pa.get("Area_m2", 0) or 0
        a_b = ba.get("Area_m2", 0) or 0
        pct_p = round(100.0 * a_p / prop_tot, 1) if prop_tot else ""
        pct_b = round(100.0 * a_b / base_tot, 1) if base_tot else ""
        out_rows.append([
            const,
            _fmt_area(a_p), _pct_str(pct_p),
            _fmt_u(pa.get("U")),
            _fmt_area(a_b), _pct_str(pct_b),
            _fmt_u(ba.get("U")),
        ])
    def _str(v):
        return "" if v is None or v == "" else str(v)
    total_row = [
        "Total",
        _fmt_area(prop_tot), "100.0%", _fmt_u(u_prop_wtd),
        _fmt_area(base_tot), "100.0%", _fmt_u(u_base_wtd),
    ]
    header = ["Assembly", f"Prop Area [{_area_unit()}]", "Prop %", "Proposed U", f"Base Area [{_area_unit()}]", "Base %", "Baseline U"]
    return [header] + [[_str(x) for x in r] for r in out_rows] + [[_str(x) for x in total_row]]

def _get_total_wall_areas_m2(base_soup, prop_soup):
    """Return (prop_opaque, prop_fen, prop_total, base_opaque, base_fen, base_total). Above-grade only. No mixing."""
    base_opaque = extract_opaque_exterior_aggregated(base_soup)
    prop_opaque = extract_opaque_exterior_aggregated(prop_soup)
    base_fen = extract_fenestration_aggregated(base_soup)
    prop_fen = extract_fenestration_aggregated(prop_soup)

    def _opaque_sum(agg):
        s = 0
        for k, v in (agg or {}).items():
            const = k if isinstance(k, str) else (k[1] if len(k) > 1 else "")
            if _is_below_grade_wall(const):
                continue
            if isinstance(v, dict):
                s += sum(v.get(d, 0) for d in "NSEW") + v.get("Other", 0)
        return s

    def _fen_sum(agg):
        s = 0
        for v in (agg or {}).values():
            if isinstance(v, dict):
                s += sum(v.get(d, 0) for d in "NSEW") + v.get("Other", 0)
        return s

    prop_opaque_m2 = _opaque_sum(prop_opaque)
    prop_fen_m2 = _fen_sum(prop_fen)
    prop_total_m2 = prop_opaque_m2 + prop_fen_m2
    base_opaque_m2 = _opaque_sum(base_opaque)
    base_fen_m2 = _fen_sum(base_fen)
    base_total_m2 = base_opaque_m2 + base_fen_m2
    return prop_opaque_m2, prop_fen_m2, prop_total_m2, base_opaque_m2, base_fen_m2, base_total_m2

def _build_fenestration_subtable(base_agg, prop_agg, entries, above_wall_prop_m2, above_wall_base_m2,
                                 prop_fen_scale=1.0, base_fen_scale=1.0):
    """Build one fenestration table. Aligns with Fenestration schedule assemblies; totals must sum to WWR.
    Prop % and Base % = ratio to above-ground wall area (WWR basis).
    Scales assembly areas by prop_fen_scale/base_fen_scale
    so result sums to WWR when schedule sum != WWR (avoids calculation error)."""
    if not entries:
        return None
    prop_section_raw = sum(sum(prop_agg.get(k, {}).get(d, 0) for d in "NSEW") for k, _ in entries)
    base_section_raw = sum(sum(base_agg.get(k, {}).get(d, 0) for d in "NSEW") for k, _ in entries)
    if prop_section_raw <= 0 and base_section_raw <= 0:
        return None
    above_wall_prop_m2 = above_wall_prop_m2 or 1
    above_wall_base_m2 = above_wall_base_m2 or 1
    prop_scale = prop_fen_scale if prop_fen_scale is not None else 1.0
    base_scale = base_fen_scale if base_fen_scale is not None else 1.0

    header = [
        "Assembly",
        "Prop NE", "Prop SE", "Prop SW", "Prop NW", "Prop Total", "Prop % Wall", "Prop U", "Prop SHGC", "Prop VLT",
        "Base NE", "Base SE", "Base SW", "Base NW", "Base Total", "Base % Wall", "Base U", "Base SHGC", "Base VLT",
    ]
    rows = []
    prop_sum_ua, prop_sum_a = 0, 0
    base_sum_ua, base_sum_a = 0, 0
    prop_sum_shgc, base_sum_shgc = 0, 0
    prop_sum_vlt, prop_vlt_a = 0, 0
    base_sum_vlt, base_vlt_a = 0, 0
    p_ne, p_se, p_sw, p_nw = 0, 0, 0, 0
    b_ne, b_se, b_sw, b_nw = 0, 0, 0, 0

    for key, label in entries:
        pb = prop_agg.get(key, {})
        bl = base_agg.get(key, {})
        np, ep, sp, wp = pb.get("N", 0), pb.get("E", 0), pb.get("S", 0), pb.get("W", 0)
        nb, eb, sb, wb = bl.get("N", 0), bl.get("E", 0), bl.get("S", 0), bl.get("W", 0)
        np, ep, sp, wp = np * prop_scale, ep * prop_scale, sp * prop_scale, wp * prop_scale
        nb, eb, sb, wb = nb * base_scale, eb * base_scale, sb * base_scale, wb * base_scale
        tot_p = np + ep + sp + wp
        tot_b = nb + eb + sb + wb
        p_ne += np; p_se += ep; p_sw += sp; p_nw += wp
        b_ne += nb; b_se += eb; b_sw += sb; b_nw += wb

        pct_wall_p = round(100.0 * tot_p / above_wall_prop_m2, 1) if above_wall_prop_m2 else ""
        pct_wall_b = round(100.0 * tot_b / above_wall_base_m2, 1) if above_wall_base_m2 else ""

        u_p, u_b = pb.get("U"), bl.get("U")
        shgc_p, shgc_b = pb.get("SHGC"), bl.get("SHGC")
        vlt_p, vlt_b = pb.get("VLT"), bl.get("VLT")
        if u_p and tot_p:
            prop_sum_ua += u_p * tot_p
            prop_sum_a += tot_p
        if u_b and tot_b:
            base_sum_ua += u_b * tot_b
            base_sum_a += tot_b
        if shgc_p and tot_p:
            prop_sum_shgc += shgc_p * tot_p
        if shgc_b and tot_b:
            base_sum_shgc += shgc_b * tot_b
        if vlt_p and tot_p:
            prop_sum_vlt += vlt_p * tot_p
            prop_vlt_a += tot_p
        if vlt_b and tot_b:
            base_sum_vlt += vlt_b * tot_b
            base_vlt_a += tot_b

        rows.append([
            label,
            _fmt_area(np), _fmt_area(ep), _fmt_area(sp), _fmt_area(wp),
            _fmt_area(tot_p), _pct_str(pct_wall_p),
            _fmt_u(u_p),
            round(shgc_p, 3) if shgc_p is not None else "", round(vlt_p, 3) if vlt_p is not None else "",
            _fmt_area(nb), _fmt_area(eb), _fmt_area(sb), _fmt_area(wb),
            _fmt_area(tot_b), _pct_str(pct_wall_b),
            _fmt_u(u_b),
            round(shgc_b, 3) if shgc_b is not None else "", round(vlt_b, 3) if vlt_b is not None else "",
        ])

    prop_section = p_ne + p_se + p_sw + p_nw
    base_section = b_ne + b_se + b_sw + b_nw
    u_wtd_p = prop_sum_ua / prop_sum_a if prop_sum_a else 0
    u_wtd_b = base_sum_ua / base_sum_a if base_sum_a else 0
    shgc_wtd_p = prop_sum_shgc / prop_sum_a if prop_sum_a else 0
    shgc_wtd_b = base_sum_shgc / base_sum_a if base_sum_a else 0
    vlt_wtd_p = prop_sum_vlt / prop_vlt_a if prop_vlt_a else 0
    vlt_wtd_b = base_sum_vlt / base_vlt_a if base_vlt_a else 0
    pct_wall_tot_p = round(100.0 * prop_section / above_wall_prop_m2, 1) if above_wall_prop_m2 else ""
    pct_wall_tot_b = round(100.0 * base_section / above_wall_base_m2, 1) if above_wall_base_m2 else ""

    total_row = [
        "Total",
        _fmt_area(p_ne), _fmt_area(p_se), _fmt_area(p_sw), _fmt_area(p_nw),
        _fmt_area(prop_section), _pct_str(pct_wall_tot_p),
        _fmt_u(u_wtd_p), round(shgc_wtd_p, 3), round(vlt_wtd_p, 3),
        _fmt_area(b_ne), _fmt_area(b_se), _fmt_area(b_sw), _fmt_area(b_nw),
        _fmt_area(base_section), _pct_str(pct_wall_tot_b),
        _fmt_u(u_wtd_b), round(shgc_wtd_b, 3), round(vlt_wtd_b, 3),
    ]
    def _str(v):
        return "" if v is None or v == "" else str(v)
    return [header] + [[_str(x) for x in r] for r in rows] + [[_str(x) for x in total_row]]

def build_en1_window_wall_ratio_table(base_soup, prop_soup):
    """Build Window-Wall Ratio from WWR tables directly (source of truth). Proposed and Baseline from respective reports."""
    prop_wwr = extract_wwr_table_data(prop_soup)
    base_wwr = extract_wwr_table_data(base_soup)
    prop_wwr, base_wwr = _harmonize_wwr_areas(prop_wwr, base_wwr)
    prop_fen = extract_fenestration_aggregated(prop_soup)
    base_fen = extract_fenestration_aggregated(base_soup)
    au = _area_unit()
    u_unit_str = _u_unit()

    def _area_wtd_fen(agg):
        ua, aa, sa, va, va_a = 0, 0, 0, 0, 0
        for v in (agg or {}).values():
            if not isinstance(v, dict): continue
            a = sum(v.get(d, 0) for d in "NSEW") + v.get("Other", 0)
            if a <= 0: continue
            if v.get("U") is not None: ua += v["U"] * a; aa += a
            if v.get("SHGC") is not None: sa += v["SHGC"] * a
            if v.get("VLT") is not None: va += v["VLT"] * a; va_a += a
        return (ua / aa if aa else None), (sa / aa if aa else None), (va / va_a if va_a else None)

    p_u, p_shgc, p_vlt = _area_wtd_fen(prop_fen)
    b_u, b_shgc, b_vlt = _area_wtd_fen(base_fen)

    def _fmt_pct(v):
        if v is None: return ""
        return f"{round(float(v), 2)}%" if v != "" else ""

    def _wwr_rows(wwr):
        if not wwr: return []
        return [
            [f"Gross Wall Area [{au}]", _fmt_area(wwr.get("gross_wall_m2")), _fmt_area(wwr.get("gross_N")), _fmt_area(wwr.get("gross_E")), _fmt_area(wwr.get("gross_S")), _fmt_area(wwr.get("gross_W"))],
            [f"Above Ground Wall Area [{au}]", _fmt_area(wwr.get("above_ground_m2")), _fmt_area(wwr.get("above_N")), _fmt_area(wwr.get("above_E")), _fmt_area(wwr.get("above_S")), _fmt_area(wwr.get("above_W"))],
            [f"Window Opening Area [{au}]", _fmt_area(wwr.get("fenestration_m2")), _fmt_area(wwr.get("fen_N")), _fmt_area(wwr.get("fen_E")), _fmt_area(wwr.get("fen_S")), _fmt_area(wwr.get("fen_W"))],
            ["Gross Window-Wall Ratio [%]", _fmt_pct(wwr.get("gross_wwr_pct")), _fmt_pct(wwr.get("gross_wwr_N")), _fmt_pct(wwr.get("gross_wwr_E")), _fmt_pct(wwr.get("gross_wwr_S")), _fmt_pct(wwr.get("gross_wwr_W"))],
            ["Above Ground Window-Wall Ratio [%]", _fmt_pct(wwr.get("above_ground_wwr_pct")), _fmt_pct(wwr.get("above_wwr_N")), _fmt_pct(wwr.get("above_wwr_E")), _fmt_pct(wwr.get("above_wwr_S")), _fmt_pct(wwr.get("above_wwr_W"))],
        ]

    header = ["Metric", "Total", "North (315 to 45 deg)", "East (45 to 135 deg)", "South (135 to 225 deg)", "West (225 to 315 deg)"]
    rows = [
        [f"Fenestration U-Factor [{u_unit_str}] (Proposed)", _fmt_u(p_u), "", "", "", ""],
        ["Fenestration SHGC (Proposed)", round(p_shgc, 3) if p_shgc is not None else "", "", "", "", ""],
        ["Fenestration VLT (Proposed)", round(p_vlt, 3) if p_vlt is not None else "", "", "", "", ""],
    ]
    if base_fen:
        rows.extend([
            [f"Fenestration U-Factor [{u_unit_str}] (Baseline)", _fmt_u(b_u), "", "", "", ""],
            ["Fenestration SHGC (Baseline)", round(b_shgc, 3) if b_shgc is not None else "", "", "", "", ""],
            ["Fenestration VLT (Baseline)", round(b_vlt, 3) if b_vlt is not None else "", "", "", "", ""],
        ])
    rows.append(["Wall Areas and WWR (from EnergyPlus tables)", "", "", "", "", ""])
    if prop_wwr:
        rows.append(["— Proposed (Window-Wall Ratio) —", "", "", "", "", ""])
        rows.extend(_wwr_rows(prop_wwr))
    if base_wwr:
        rows.append(["— Baseline (Window-Wall Ratio) —", "", "", "", "", ""])
        rows.extend(_wwr_rows(base_wwr))
    if not rows:
        return None
    return [header] + rows

def build_en1_fenestration_table(base_soup, prop_soup):
    """Build Glass Door Assemblies table(s). Aligns with Fenestration schedule; totals must sum to WWR.
    Prop % and Base % = ratio to above-ground wall area from WWR.
    Scales assembly areas to match WWR when needed."""
    base_agg = extract_fenestration_aggregated(base_soup)
    prop_agg = extract_fenestration_aggregated(prop_soup)
    prop_opaque, prop_fen, prop_total, base_opaque, base_fen, base_total = _get_total_wall_areas_m2(base_soup, prop_soup)
    prop_wwr = extract_wwr_table_data(prop_soup)
    base_wwr = extract_wwr_table_data(base_soup)
    prop_wwr, base_wwr = _harmonize_wwr_areas(prop_wwr, base_wwr)
    prop_above = prop_wwr["above_ground_m2"] if (prop_wwr and prop_wwr.get("above_ground_m2")) else prop_opaque
    base_above = base_wwr["above_ground_m2"] if (base_wwr and base_wwr.get("above_ground_m2")) else base_opaque
    prop_fen_schedule = _fen_total_m2(prop_agg)
    base_fen_schedule = _fen_total_m2(base_agg)
    prop_fen_scale = (prop_wwr["fenestration_m2"] / prop_fen_schedule) if (prop_wwr and prop_wwr.get("fenestration_m2") and prop_fen_schedule > 0) else 1.0
    base_fen_scale = (base_wwr["fenestration_m2"] / base_fen_schedule) if (base_wwr and base_wwr.get("fenestration_m2") and base_fen_schedule > 0) else 1.0

    all_keys = set()
    for d in (base_agg, prop_agg):
        for k in d:
            all_keys.add(k)
    if not all_keys:
        return None

    commercial = []
    residential = []
    combined = []
    for k in all_keys:
        if isinstance(k, tuple):
            cat, const = k
            label = const
            if cat == "Commercial":
                commercial.append((k, label))
            else:
                residential.append((k, label))
        else:
            combined.append((k, k))

    tables = []
    if commercial:
        tbl = _build_fenestration_subtable(base_agg, prop_agg, sorted(commercial, key=lambda x: x[1]),
            prop_above, base_above, prop_fen_scale, base_fen_scale)
        if tbl:
            tables.append(("Commercial", tbl))
    if residential:
        tbl = _build_fenestration_subtable(base_agg, prop_agg, sorted(residential, key=lambda x: x[1]),
            prop_above, base_above, prop_fen_scale, base_fen_scale)
        if tbl:
            tables.append(("Residential", tbl))
    if combined and not (commercial or residential):
        tbl = _build_fenestration_subtable(base_agg, prop_agg, sorted(combined, key=lambda x: x[1]),
            prop_above, base_above, prop_fen_scale, base_fen_scale)
        if tbl:
            tables.append(("Glass Door Assemblies", tbl))

    if not tables:
        return None
    if len(tables) == 1:
        return tables[0][1]
    return tables

def extract_exterior_lighting(soup):
    """Extract exterior lighting data from Exterior Lighting / Site Exterior tables. Returns (fixtures, surfaces, total_W)."""
    fixtures = []
    surfaces = []
    total_w = 0
    if not soup:
        return fixtures, surfaces, total_w
    hits = find_tables_by_keywords(soup, ["exterior lighting", "site exterior", "exterior lights", "lighting summary"])
    for title, table in hits:
        ctx = (title + " " + norm(table.get_text(" ", strip=True))[:800]).lower()
        if "exterior" not in ctx and "site" not in ctx:
            continue
        data = table_to_matrix(table)
        if len(data) < 2:
            continue
        hdr = data[0]
        idx_name = get_col_index(hdr, ["name", "object", "light", "fixture", "luminaire"])
        idx_watt = get_col_index(hdr, ["wattage", "design level", "power", "watts"])
        idx_mult = get_col_index(hdr, ["multiplier", "count", "quantity"])
        idx_surf = get_col_index(hdr, ["surface", "zone"])
        idx_area = get_col_index(hdr, ["area", "length"])
        idx_unit = get_col_index(hdr, ["unit"])
        for r in data[1:]:
            name = norm(r[idx_name]) if idx_name >= 0 and idx_name < len(r) else ""
            if not name:
                continue
            watt = parse_number(r[idx_watt]) if idx_watt >= 0 else None
            mult = parse_number(r[idx_mult]) if idx_mult >= 0 else 1
            surf = norm(r[idx_surf]) if idx_surf >= 0 else ""
            area = parse_number(r[idx_area]) if idx_area >= 0 else None
            unit = norm(r[idx_unit]) if idx_unit >= 0 else ""
            pow_w = (watt or 0) * (mult or 1)
            if watt is not None or pow_w:
                fixtures.append({"Name": name, "Wattage": watt, "Count": mult, "Power_W": pow_w})
            if surf and (area is not None or watt is not None):
                surfaces.append({"Surface": surf, "Area_or_Length": area, "Unit": unit or "SF", "Power_W": pow_w})
            if pow_w:
                total_w += pow_w
    return fixtures, surfaces, total_w

def build_exterior_lighting_tables(base_soup, prop_soup):
    """Build Exterior Lighting reference-format tables: Fixture, Surface, Power Results."""
    base_fix, base_surf, base_w = extract_exterior_lighting(base_soup) if base_soup else ([], [], 0)
    prop_fix, prop_surf, prop_w = extract_exterior_lighting(prop_soup)
    tables = []
    if prop_fix or base_fix:
        header = ["Fixture", "Prop Wattage (W)", "Prop Count", "Base Wattage (W)", "Base Count"]
        rows = []
        fix_map = {}
        for f in prop_fix:
            n = f.get("Name", "")
            if n:
                fix_map[n] = fix_map.get(n, {})
                fix_map[n]["prop_w"] = f.get("Wattage")
                fix_map[n]["prop_c"] = f.get("Count")
        for f in base_fix:
            n = f.get("Name", "")
            if n:
                fix_map[n] = fix_map.get(n, {})
                fix_map[n]["base_w"] = f.get("Wattage")
                fix_map[n]["base_c"] = f.get("Count")
        for n, v in sorted(fix_map.items()):
            pw = v.get("prop_w")
            pc = v.get("prop_c")
            bw = v.get("base_w")
            bc = v.get("base_c")
            rows.append([n, round(pw, 0) if pw else "", pc if pc and pc != 1 else "", round(bw, 0) if bw else "", bc if bc and bc != 1 else ""])
        if rows:
            tables.append(("Exterior Lighting Fixtures", [header] + rows))
    if prop_surf or base_surf:
        header = ["Surface", "Prop Area", "Prop Unit", "Prop Power (W)", "Base Area", "Base Unit", "Base Power (W)"]
        rows = []
        surf_map = {}
        for s in prop_surf:
            n = s.get("Surface", "")
            if n:
                surf_map[n] = surf_map.get(n, {})
                surf_map[n]["prop"] = s.get("Power_W")
                surf_map[n]["prop_area"] = s.get("Area_or_Length")
                surf_map[n]["prop_unit"] = s.get("Unit") or "SF"
        for s in base_surf:
            n = s.get("Surface", "")
            if n:
                surf_map[n] = surf_map.get(n, {})
                surf_map[n]["base"] = s.get("Power_W")
                surf_map[n]["base_area"] = s.get("Area_or_Length")
                surf_map[n]["base_unit"] = s.get("Unit") or "SF"
        for n, v in sorted(surf_map.items()):
            pa = v.get("prop_area")
            pu = v.get("prop_unit", "SF")
            ba = v.get("base_area")
            bu = v.get("base_unit", "SF")
            rows.append([n, round(pa, 0) if pa else "", pu, v.get("prop", ""), round(ba, 0) if ba else "", bu, v.get("base", "")])
        if rows:
            tables.append(("Exterior Lighting by Surface", [header] + rows))
    base_tot = base_w if base_fix or base_surf else 0
    header_pwr = ["Category", "Baseline (W)", "Proposed (W)"]
    pwr_data = [
        header_pwr,
        ["Tradable", base_tot if base_fix else "", prop_w if prop_fix else ""],
        ["Non-tradable", "", ""],
        ["Base Site Allowance", "", ""],
        ["Total", base_tot if base_fix else "", prop_w if prop_fix else ""],
    ]
    tables.append(("Exterior Lighting Power Results", pwr_data))
    return tables

def build_en1_lighting_table(prop_soup):
    """Build EN1-style interior lighting summary (US imperial) - space-by-space. Deprecated for Building Area Method."""
    rows = extract_lighting_space_summary(prop_soup)
    if not rows:
        return None
    total_area_ft2 = 0
    total_power_w = 0
    out_rows = []
    for r in rows:
        area_ft2 = _m2_to_ft2(r["Area_m2"])
        lpd_w_ft2 = _w_m2_to_w_ft2(r["LPD_Wm2"]) if r.get("LPD_Wm2") else None
        power = (r["LPD_Wm2"] * r["Area_m2"]) if r.get("LPD_Wm2") else None
        total_area_ft2 += area_ft2 or 0
        total_power_w += power or 0
        out_rows.append([r["Space"], round(area_ft2, 1) if area_ft2 else "", round(lpd_w_ft2, 2) if lpd_w_ft2 else "", round(power, 0) if power else ""])
    header = ["Space Name", "Area (ft²)", "Prop. LPD (W/ft²)", "Prop. Lighting Power (W)"]
    tot_lpd = total_power_w / total_area_ft2 if total_area_ft2 else 0
    tot_row = ["Total", round(total_area_ft2, 0), round(tot_lpd, 2), round(total_power_w, 0)]
    return [header] + out_rows + [tot_row]

def build_interior_lpd_building_area_method_table(base_soup, prop_soup):
    """Build Interior LPD: Building Area Method table (Appendix G PRM). US imperial."""
    base_rows = extract_space_type_summary(base_soup)
    prop_rows = extract_space_type_summary(prop_soup)
    base_by_type = {r["SpaceType"]: r for r in base_rows}
    prop_by_type = {r["SpaceType"]: r for r in prop_rows}
    space_types = sorted(set(base_by_type) | set(prop_by_type))
    if not space_types:
        return None
    base_auto, base_day = _has_daylighting_controls(base_soup)
    prop_auto, prop_day = _has_daylighting_controls(prop_soup)
    auto_b = "Yes" if base_auto else "No"
    day_b = "Yes" if base_day else "No"
    auto_p = "Yes" if prop_auto else "No"
    day_p = "Yes" if prop_day else "No"
    header = [
        "Building Area Type (Table 9.5.1)",
        f"Base Area ({_area_unit()})",
        f"Prop Area ({_area_unit()})",
        "Baseline Auto.", "Baseline Daylight",
        f"Baseline LPD ({_lpd_unit()})",
        "Proposed Auto.", "Proposed Daylight",
        f"Proposed LPD ({_lpd_unit()})",
    ]
    rows = []
    total_base_area_m2 = 0
    total_prop_area_m2 = 0
    total_base_power = 0
    total_prop_power = 0
    for st in space_types:
        pb = prop_by_type.get(st, {})
        bl = base_by_type.get(st, {})
        area_base_m2 = bl.get("TotalArea_m2") or 0
        area_prop_m2 = pb.get("TotalArea_m2") or 0
        area_base_ft2 = _fmt_area(area_base_m2) if area_base_m2 else ""
        area_prop_ft2 = _fmt_area(area_prop_m2) if area_prop_m2 else ""
        lpd_base = bl.get("Lighting_Wm2")
        lpd_prop = pb.get("Lighting_Wm2")
        lpd_base_ft2 = _fmt_lpd(lpd_base) if lpd_base is not None else ""
        lpd_prop_ft2 = _fmt_lpd(lpd_prop) if lpd_prop is not None else ""
        if lpd_base is not None and area_base_m2:
            total_base_power += lpd_base * area_base_m2
            total_base_area_m2 += area_base_m2
        if lpd_prop is not None and area_prop_m2:
            total_prop_power += lpd_prop * area_prop_m2
            total_prop_area_m2 += area_prop_m2
        rows.append([st, area_base_ft2, area_prop_ft2, auto_b, day_b, lpd_base_ft2, auto_p, day_p, lpd_prop_ft2])
    tot_base_lpd = total_base_power / total_base_area_m2 if total_base_area_m2 else 0
    tot_prop_lpd = total_prop_power / total_prop_area_m2 if total_prop_area_m2 else 0
    tot_base_ft2 = _fmt_area(total_base_area_m2) if total_base_area_m2 else ""
    tot_prop_ft2 = _fmt_area(total_prop_area_m2) if total_prop_area_m2 else ""
    tot_row = [
        "Total",
        tot_base_ft2, tot_prop_ft2,
        "", "",
        _fmt_lpd(tot_base_lpd) if tot_base_lpd else "",
        "", "",
        _fmt_lpd(tot_prop_lpd) if tot_prop_lpd else "",
    ]
    return [header] + rows + [tot_row]

def build_baseline_hvac_eir_hir_table(base_soup):
    """Build Baseline HVAC EIR-HIR table for EN-1. Full reference: System, Cooling, Heating, CFM, EER, EIR, COP, HIR."""
    base_hvac = extract_hvac_coil_sizing(base_soup)
    base_hvac = _deduplicate_hvac_coils(base_hvac)
    if not base_hvac:
        base_hvac = _deduplicate_hvac_coils(extract_hvac_coil_sizing(base_soup))
    if not base_hvac:
        return None
    header = ["System Name", f"Cooling Cap ({_power_unit()})", f"Heating Cap ({_power_unit()})", f"Design {_flow_unit()}", "EER", "EIR", "COP", "HIR"]
    rows = []
    for r in sorted(base_hvac, key=lambda x: x.get("Name", "")):
        name = r.get("Name", "")
        cool_w = r.get("Cool_W")
        heat_w = r.get("Heat_W")
        flow = r.get("Flow_m3s")
        eer = r.get("EER")
        cop = r.get("COP")
        cool_btu = _fmt_power_btu(cool_w) if cool_w else ""
        heat_btu = _fmt_power_btu(heat_w) if heat_w else ""
        flow_cfm = _fmt_flow(flow) if flow else ""
        eer_str = round(eer, 2) if eer is not None else ""
        eir = round(1.0 / eer, 4) if eer and eer > 0 else ""
        cop_str = round(cop, 2) if cop is not None else ""
        hir = round(1.0 / cop, 4) if cop and cop > 0 else ""
        rows.append([name, cool_btu, heat_btu, flow_cfm, eer_str, eir, cop_str, hir])
    return [header] + rows

def _hvac_system_key(name: str) -> str:
    """Canonical key for merging cooling/heating coil pairs (e.g. COIL COOLING DX 1 + COIL HEATING DX 1 -> one row)."""
    s = re.sub(r"\s+", " ", (name or "").upper())
    for tok in ("COOLING", "HEATING", "COOL", "HEAT"):
        s = re.sub(r"\b" + tok + r"\b", "", s, flags=re.I)
    return re.sub(r"\s+", " ", s).strip() or name

def _is_generic_hvac_type_name(name: str) -> bool:
    n = (name or "").strip()
    if not n:
        return True
    nlo = n.lower()
    return nlo.startswith("coil:") or nlo.startswith("fan:") or nlo.startswith("pump:") or nlo.startswith("boiler:")

def _attach_generic_efficiency_rows(rows):
    """Attach EER/COP/HSPF from generic type rows to nearest named system by capacity."""
    named = [r for r in rows if not _is_generic_hvac_type_name(r.get("Name", ""))]
    generic = [r for r in rows if _is_generic_hvac_type_name(r.get("Name", ""))]
    for g in generic:
        if g.get("EER") is None and g.get("COP") is None and g.get("HSPF") is None:
            continue
        gcap = g.get("Cool_W") if g.get("Cool_W") is not None else g.get("Heat_W")
        best = None
        best_diff = None
        for n in named:
            ncap = n.get("Cool_W") if n.get("Cool_W") is not None else n.get("Heat_W")
            if gcap is None or ncap is None:
                continue
            diff = abs(float(ncap) - float(gcap))
            if best_diff is None or diff < best_diff:
                best = n
                best_diff = diff
        if best is not None and gcap is not None:
            tol = max(abs(float(gcap)) * 0.05, 5000.0)
            if (best_diff or 0) <= tol:
                # EN1-facing summaries should prefer rated-capacity rows when available
                # (same rows that carry EER/COP), over sizing-summary capacities.
                if g.get("Cool_W") is not None:
                    if best.get("Cool_W") is None or float(g["Cool_W"]) > float(best["Cool_W"]):
                        best["Cool_W"] = g["Cool_W"]
                if g.get("Heat_W") is not None:
                    if best.get("Heat_W") is None or float(g["Heat_W"]) > float(best["Heat_W"]):
                        best["Heat_W"] = g["Heat_W"]
                if g.get("EER") is not None and (best.get("EER") is None or float(g["EER"]) > float(best["EER"])):
                    best["EER"] = g["EER"]
                if g.get("COP") is not None and (best.get("COP") is None or float(g["COP"]) > float(best["COP"])):
                    best["COP"] = g["COP"]
                if g.get("HSPF") is not None and (best.get("HSPF") is None or float(g["HSPF"]) > float(best["HSPF"])):
                    best["HSPF"] = g["HSPF"]
                continue
        named.append(g)
    return named

def _summary_hvac_rows(rows):
    """Summary rows should represent system-level EN1 fields (capacity and/or efficiency)."""
    out = []
    for r in rows:
        has_capacity = r.get("Cool_W") is not None or r.get("Heat_W") is not None
        has_eff = r.get("EER") is not None or r.get("COP") is not None or r.get("HSPF") is not None
        if has_capacity or has_eff:
            out.append(r)
    # Prefer system-level names over coil-level names when values are duplicated.
    def _is_coil_name(n: str) -> bool:
        return "coil" in (n or "").lower()
    pruned = []
    for r in out:
        n = r.get("Name", "")
        if not _is_coil_name(n):
            pruned.append(r)
            continue
        rc = r.get("Cool_W")
        rh = r.get("Heat_W")
        duplicate_system = False
        matched_system = None
        for s in out:
            sn = s.get("Name", "")
            if s is r or _is_coil_name(sn):
                continue
            sc = s.get("Cool_W")
            sh = s.get("Heat_W")
            cool_match = True if (rc is None or sc is None) else (abs(float(rc) - float(sc)) <= max(abs(float(rc)) * 0.05, 5000.0))
            heat_match = True if (rh is None or sh is None) else (abs(float(rh) - float(sh)) <= max(abs(float(rh)) * 0.05, 5000.0))
            if cool_match and heat_match:
                duplicate_system = True
                matched_system = s
                break
        if not duplicate_system:
            pruned.append(r)
        else:
            # Preserve EN1-relevant fields when removing duplicate coil rows.
            if matched_system is not None:
                # If the dropped row is a rated-performance row, carry its capacities too.
                if (r.get("EER") is not None or r.get("COP") is not None or r.get("HSPF") is not None):
                    if r.get("Cool_W") is not None:
                        matched_system["Cool_W"] = r["Cool_W"]
                    if r.get("Heat_W") is not None:
                        matched_system["Heat_W"] = r["Heat_W"]
                if matched_system.get("EER") is None and r.get("EER") is not None:
                    matched_system["EER"] = r["EER"]
                if matched_system.get("COP") is None and r.get("COP") is not None:
                    matched_system["COP"] = r["COP"]
                if matched_system.get("HSPF") is None and r.get("HSPF") is not None:
                    matched_system["HSPF"] = r["HSPF"]
                if matched_system.get("Fan_kW") is None and r.get("Fan_kW") is not None:
                    matched_system["Fan_kW"] = r["Fan_kW"]
    return pruned

def _apply_rated_perf_preference(merged_rows, raw_rows):
    """Prefer rated-capacity rows (with EER/COP/HSPF) for EN1 summary capacities/efficiencies."""
    perf_rows = [
        r for r in (raw_rows or [])
        if _is_generic_hvac_type_name(r.get("Name", "")) and (r.get("EER") is not None or r.get("COP") is not None or r.get("HSPF") is not None)
    ]
    if not perf_rows:
        return merged_rows
    for m in merged_rows:
        if _is_generic_hvac_type_name(m.get("Name", "")):
            continue
        mc = m.get("Cool_W")
        mh = m.get("Heat_W")
        cool_candidates = []
        heat_candidates = []
        for p in perf_rows:
            pc = p.get("Cool_W")
            ph = p.get("Heat_W")
            if pc is not None:
                if mc is None or abs(float(pc) - float(mc)) <= max(abs(float(pc)) * 0.10, 12000.0):
                    cool_candidates.append(p)
            if ph is not None:
                if mh is None or abs(float(ph) - float(mh)) <= max(abs(float(ph)) * 0.10, 12000.0):
                    heat_candidates.append(p)
        if cool_candidates:
            best_c = max(cool_candidates, key=lambda r: float(r.get("Cool_W") or 0))
            m["Cool_W"] = best_c.get("Cool_W")
            if best_c.get("EER") is not None:
                m["EER"] = best_c["EER"]
            if best_c.get("COP") is not None:
                m["COP"] = best_c["COP"]
        if heat_candidates:
            best_h = max(heat_candidates, key=lambda r: float(r.get("Heat_W") or 0))
            m["Heat_W"] = best_h.get("Heat_W")
            if best_h.get("COP") is not None:
                m["COP"] = best_h["COP"]
            if best_h.get("HSPF") is not None:
                m["HSPF"] = best_h["HSPF"]
        # When HSPF exists in any matched perf row, keep the max reported value.
        matched_hspf = [r.get("HSPF") for r in perf_rows if r.get("HSPF") is not None]
        if matched_hspf:
            m["HSPF"] = max(float(x) for x in matched_hspf)
    return merged_rows

def _attach_fan_power_rows(merged_rows, raw_rows):
    """Attach fan power rows to nearest system by airflow."""
    fan_rows = [
        r for r in (raw_rows or [])
        if (r.get("Fan_kW") is not None) and r.get("Cool_W") is None and r.get("Heat_W") is None
    ]
    if not fan_rows:
        return merged_rows
    systems = [r for r in merged_rows if not _is_generic_hvac_type_name(r.get("Name", ""))]
    for f in fan_rows:
        fp = f.get("Fan_kW")
        if fp is None:
            continue
        # Some report tables provide fan power in W; normalize to kW.
        fp_kw = (float(fp) / 1000.0) if float(fp) > 20 else float(fp)
        ff = f.get("Flow_m3s")
        best = None
        best_diff = None
        for s in systems:
            sf = s.get("Flow_m3s")
            if ff is None or sf is None:
                continue
            d = abs(float(ff) - float(sf))
            if best_diff is None or d < best_diff:
                best = s
                best_diff = d
        if best is not None and (best.get("Fan_kW") is None or fp_kw > float(best.get("Fan_kW") or 0)):
            best["Fan_kW"] = round(fp_kw, 3)
    return merged_rows

def _deduplicate_hvac_coils(hvac_list):
    """Merge cooling/heating coil pairs into one row per system. Prefer cooling coil as primary name."""
    by_key = {}
    for r in hvac_list:
        name = r.get("Name", "")
        key = _hvac_system_key(name)
        if key not in by_key:
            by_key[key] = {"Name": name, "Cool_W": None, "Heat_W": None, "Flow_m3s": None, "EER": None, "COP": None, "HSPF": None, "Fan_kW": None}
        row = by_key[key]
        if r.get("Cool_W") is not None:
            row["Cool_W"] = r["Cool_W"]
            row["Name"] = name
        if r.get("Heat_W") is not None:
            row["Heat_W"] = r["Heat_W"]
        if r.get("Flow_m3s") is not None:
            curr = row.get("Flow_m3s")
            newv = r["Flow_m3s"]
            row["Flow_m3s"] = max(curr, newv) if curr is not None and newv is not None else (newv if newv is not None else curr)
        if r.get("EER") is not None:
            row["EER"] = r["EER"]
        if r.get("COP") is not None:
            row["COP"] = r["COP"]
        if r.get("HSPF") is not None:
            row["HSPF"] = r["HSPF"]
        if r.get("Fan_kW") is not None:
            row["Fan_kW"] = r["Fan_kW"]
    merged = list(by_key.values())
    merged = _attach_generic_efficiency_rows(merged)
    merged = _summary_hvac_rows(merged)
    merged = _apply_rated_perf_preference(merged, hvac_list)
    merged = _attach_fan_power_rows(merged, hvac_list)
    return merged

def build_proposed_hvac_summary_table(prop_soup):
    """Build Proposed HVAC summary for EN-1: all systems with Cooling, Heating, CFM, EER, COP, HSPF, Fan kW."""
    prop_hvac = extract_hvac_coil_sizing(prop_soup)
    prop_hvac_filtered = [r for r in prop_hvac if "prm" not in (r.get("Name") or "").lower() and "baseline" not in (r.get("Name") or "").lower()]
    merged = _deduplicate_hvac_coils(prop_hvac_filtered)
    if not merged:
        merged = _deduplicate_hvac_coils(prop_hvac) if prop_hvac else []
    if not merged:
        return None
    rows = []
    for r in sorted(merged, key=lambda x: x.get("Name", "")):
        cool_btu = _fmt_power_btu(r.get("Cool_W")) if r.get("Cool_W") else ""
        heat_btu = _fmt_power_btu(r.get("Heat_W")) if r.get("Heat_W") else ""
        flow_cfm = _fmt_flow(r.get("Flow_m3s")) if r.get("Flow_m3s") else ""
        eer = round(r.get("EER"), 2) if r.get("EER") is not None else ""
        cop = round(r.get("COP"), 2) if r.get("COP") is not None else ""
        hspf = round(r.get("HSPF"), 2) if r.get("HSPF") is not None else ""
        fan_kw = round(r.get("Fan_kW"), 2) if r.get("Fan_kW") is not None else ""
        rows.append([r.get("Name", ""), cool_btu, heat_btu, flow_cfm, eer, cop, hspf, fan_kw])
    header = ["System Name", f"Cooling Cap ({_power_unit()})", f"Heating Cap ({_power_unit()})", f"Design {_flow_unit()}", "EER", "COP", "HSPF", "Fan kW"]
    return [header] + rows

def build_en1_hvac_table(base_soup, prop_soup):
    """Build EN1-style HVAC system details. Proposed and baseline from respective models only—no mixing."""
    base_hvac = extract_hvac_coil_sizing(base_soup)
    prop_hvac = extract_hvac_coil_sizing(prop_soup)
    names = sorted(set(r["Name"] for r in base_hvac + prop_hvac))
    if not names:
        return None
    rows = []
    for n in names:
        pb = next((r for r in prop_hvac if r["Name"] == n), {})
        bl = next((r for r in base_hvac if r["Name"] == n), {})
        cool_p = pb.get("Cool_W")
        heat_p = pb.get("Heat_W")
        flow_p = pb.get("Flow_m3s")
        cool_b = bl.get("Cool_W")
        heat_b = bl.get("Heat_W")
        flow_b = bl.get("Flow_m3s")
        cool_p_btu = _fmt_power_btu(cool_p) if cool_p else ""
        heat_p_btu = _fmt_power_btu(heat_p) if heat_p else ""
        flow_p_cfm = _fmt_flow(flow_p) if flow_p else ""
        cool_b_btu = _fmt_power_btu(cool_b) if cool_b else ""
        heat_b_btu = _fmt_power_btu(heat_b) if heat_b else ""
        flow_b_cfm = _fmt_flow(flow_b) if flow_b else ""
        rows.append([n, cool_p_btu, heat_p_btu, flow_p_cfm, cool_b_btu, heat_b_btu, flow_b_cfm])
    header = ["System Name", f"Prop Cool ({_power_unit()})", f"Prop Heat ({_power_unit()})", f"Prop {_flow_unit()}", f"Base Cool ({_power_unit()})", f"Base Heat ({_power_unit()})", f"Base {_flow_unit()}"]
    return [header] + rows

def split_wide(data, key_cols=1, chunk_cols=12):
    if not data:
        return []
    ncols = len(data[0])
    if ncols <= key_cols + chunk_cols:
        return [data]
    parts = []
    start = key_cols
    while start < ncols:
        end = min(ncols, start + chunk_cols)
        cols = list(range(key_cols)) + list(range(start, end))
        parts.append([[r[i] for i in cols] for r in data])
        start = end
    return parts

def doc_template(path):
    return SimpleDocTemplate(
        path,
        pagesize=landscape(TABLOID),
        leftMargin=0.55*inch, rightMargin=0.55*inch,
        topMargin=0.55*inch, bottomMargin=0.55*inch
    )

def make_styles():
    ss = getSampleStyleSheet()
    H1 = ParagraphStyle("H1", parent=ss["Heading1"], fontSize=22, spaceAfter=12, spaceBefore=4, textColor=THEME["heading"])
    H2 = ParagraphStyle("H2", parent=ss["Heading2"], fontSize=14, spaceBefore=14, spaceAfter=8, textColor=THEME["primary"])
    H3 = ParagraphStyle("H3", parent=ss["Heading3"], fontSize=11, spaceBefore=10, spaceAfter=5, textColor=THEME["heading_light"])
    NOTE = ParagraphStyle("NOTE", parent=ss["Normal"], fontSize=8.5, textColor=colors.HexColor("#64748b"), leading=11)
    BODY = ParagraphStyle("BODY", parent=ss["Normal"], fontSize=9.5, leading=12, textColor=colors.HexColor("#334155"))
    HEADER_CELL = ParagraphStyle("HEADER_CELL", parent=ss["Normal"], fontSize=6.5, leading=7.5, alignment=1)
    BODY_CELL = ParagraphStyle("BODY_CELL", parent=ss["Normal"], fontSize=6.5, leading=7.5)
    return H1,H2,H3,NOTE,BODY,HEADER_CELL,BODY_CELL

def make_table(matrix, usable_w, header_cell, body_cell):
    if not matrix or len(matrix) < 2:
        return None
    ncols = len(matrix[0])
    min_w = 0.62*inch
    col_w = max(min_w, usable_w / ncols)
    widths = [col_w]*ncols
    if sum(widths) > usable_w:
        scale = usable_w / sum(widths)
        widths = [w*scale for w in widths]
    header_h = 0.5*inch
    header = [Paragraph(wrap_header_text(c), header_cell) for c in matrix[0]]
    def _cell_text(c):
        if c is None or c == "":
            return ""
        s = str(c) if not isinstance(c, str) else c
        return _html.escape(s)
    body = [[Paragraph(_cell_text(c), body_cell) for c in r] for r in matrix[1:]]
    tbl = Table([header] + body, colWidths=widths, repeatRows=1, rowHeights=[header_h] + [None]*len(body), cornerRadii=[8, 8, 8, 8])
    nrows = len(matrix)
    cmds = [
        ("LINEBELOW", (0, 0), (-1, 0), 1.5, THEME["primary"]),
        ("BACKGROUND", (0, 0), (-1, 0), THEME["header_bg"]),
        ("TEXTCOLOR", (0, 0), (-1, 0), THEME["header_fg"]),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("GRID", (0, 0), (-1, -1), 0.5, THEME["border"]),
    ]
    for i in range(1, nrows):
        if i % 2 == 0:
            cmds.append(("BACKGROUND", (0, i), (-1, i), THEME["row_alt"]))
    if nrows > 1 and norm(str(matrix[-1][0])).lower() == "total":
        cmds.append(("BACKGROUND", (0, nrows - 1), (-1, nrows - 1), THEME["total_row"]))
        cmds.append(("LINEABOVE", (0, nrows - 1), (-1, nrows - 1), 1, THEME["primary"]))
    tbl.setStyle(TableStyle(cmds))
    return tbl

def add_cover(flow, project_title, model_label, soup, H1,H2,NOTE,BODY):
    flow.append(Spacer(1, 0.3*inch))
    flow.append(Paragraph(project_title, H1))
    flow.append(Spacer(1, 0.08*inch))
    flow.append(Paragraph(model_label, H2))
    flow.append(Spacer(1, 0.2*inch))
    meta = []
    for p in soup.find_all("p"):
        t = norm(p.get_text(" ", strip=True))
        if "Program Version" in t: meta.append(t); break
    for p in soup.find_all("p"):
        t = norm(p.get_text(" ", strip=True))
        if t.startswith("Building:"): meta.append(t)
        if t.startswith("Environment:"): meta.append(t)
    for line in meta:
        flow.append(Paragraph(line, BODY))
    flow.append(Spacer(1, 0.2*inch))
    flow.append(Paragraph(
        "Energy modeling review package. Tables from EnergyPlus eplustbl.html; "
        f"Units: {_units_note()}. Data unchanged.",
        NOTE
    ))
    flow.append(PageBreak())

def add_top_summary_annual(flow, soup, H2, H3, NOTE, usable_w, header_cell, body_cell, schedule_profiles=None):
    flow.append(Paragraph("Annual Summary", H2))
    flow.append(Paragraph(f"All units in {_units_note()}.", NOTE))
    en1_end_use = build_en1_end_use_summary_table(soup)
    if en1_end_use and len(en1_end_use) >= 2:
        flow.append(Spacer(1, 0.08*inch))
        flow.append(Paragraph("Energy Modeling Usage Summary", H3))
        tbl = make_table(en1_end_use, usable_w, header_cell, body_cell)
        if tbl:
            flow.append(tbl)
            flow.append(Spacer(1, 0.12*inch))
    cost = build_appendix_g_cost_summary_table(soup)
    if cost and len(cost) >= 2:
        flow.append(Spacer(1, 0.08*inch))
        flow.append(Paragraph("Appendix G Purchased Energy Rates & Cost Summary", H3))
        flow.append(Paragraph(
            "Method: Annual model energy from End Uses table is converted to billing units "
            "(Electricity: GJ x 277.7778 = kWh; Gas: GJ x 9.4782 = therm) and multiplied by "
            f"Con Edison virtual rates (${CONED_VIRTUAL_ELEC_RATE_PER_KWH}/kWh electric, "
            f"${CONED_VIRTUAL_GAS_RATE_PER_THERM}/therm gas). This is an Appendix G virtual-cost estimate.",
            NOTE
        ))
        tbl = make_table(cost, usable_w, header_cell, body_cell)
        if tbl:
            flow.append(tbl)
            flow.append(Spacer(1, 0.12*inch))
    flow.append(Spacer(1, 0.1*inch))
    end_use_data = extract_end_use_for_chart(soup)
    if end_use_data and _HAS_GRAPHICS:
        chart = _draw_end_use_chart(end_use_data, width=usable_w * 0.45, height=2.8*inch)
        if chart:
            unit_label = "kBtu" if _USE_IMPERIAL else "GJ"
            flow.append(Paragraph(f"End Use Distribution ({unit_label})", H3))
            flow.append(chart)
            flow.append(Spacer(1, 0.15*inch))
    schedules = schedule_profiles if schedule_profiles is not None else extract_schedule_profiles(soup, max_profiles=12)
    schedules = [profile for profile in schedules if _is_complete_daily_schedule(profile)]
    if schedules:
        for index, profile in enumerate(schedules):
            sch_chart = _draw_schedule_chart(profile, width=min(usable_w * 0.72, 6.9*inch), height=2.4*inch)
            if sch_chart:
                # Name under each chart as requested
                src = _html.escape(profile.get("source", "Schedules"))
                nm = _html.escape(profile.get("name", "Schedule"))
                chart_group = []
                if index == 0:
                    chart_group.extend([
                        Paragraph("Schedule Profiles (Daily)", H3),
                        Paragraph("Hourly schedule curves (0-24h).", NOTE),
                    ])
                chart_group.extend([
                    sch_chart,
                    Paragraph(f"<b>{nm}</b> <font color='#64748b'>(from {src})</font>", NOTE),
                    Spacer(1, 0.08*inch),
                ])
                flow.append(KeepTogether(chart_group))
        flow.append(Spacer(1, 0.08*inch))
    else:
        flow.append(Paragraph("Schedule Profiles (Daily)", H3))
        flow.append(Paragraph(
            "No complete 24-hour schedule series was available. The report packager "
            "does not convert the two-point schedule summaries in eplustbl.html into "
            "hourly curves. Select the corresponding OSM/IDF model, or keep in.idf "
            "beside eplustbl.html so it can be detected automatically.",
            NOTE
        ))
        flow.append(Spacer(1, 0.08*inch))
    targets = [
        ("Annual Building Utility Performance Summary", ["annual building utility", "utility performance", "site and source energy", "end uses"]),
        ("End Uses", ["end uses"]),
        ("Building Area", ["building area"]),
    ]
    added = False
    for friendly, subs in targets:
        hit = find_table_by_title_contains(soup, subs)
        if hit is None:
            hits = find_tables_by_keywords(soup, subs)
            hit = hits[0] if hits else None
        if not hit:
            continue
        _, table = hit
        matrix = convert_units_in_table(drop_empty_rows_cols(table_to_matrix(table), True))
        if not matrix or len(matrix) < 2:
            continue
        flow.append(Paragraph(friendly, H3))
        parts = split_wide(matrix, 1, 12)
        for i, part in enumerate(parts):
            if len(parts) > 1:
                flow.append(Paragraph(f"{friendly} (part {i+1}/{len(parts)})", NOTE))
            tbl = make_table(part, usable_w, header_cell, body_cell)
            if tbl:
                flow.append(tbl)
                flow.append(Spacer(1, 0.12*inch))
                added = True
    if not added:
        flow.append(Paragraph("(No summary tables found in source.)", NOTE))
    flow.append(PageBreak())

def _add_air_side_hvac_tables_from_report(flow, soup, H2, H3, NOTE, usable_w, header_cell, body_cell):
    """Add Air-Side HVAC tables from EnergyPlus report (source of truth). Includes Baseline/Proposed comparison format."""
    air_side_keywords = ["air-side", "air side", "hvac system", "baseline design", "proposed design",
                        "system name in model", "total cooling capacity", "fan control", "supply airflow",
                        "exhaust air energy recovery", "fan brake horsepower", "supporting doc", "model output report"]
    hits = find_tables_by_keywords(soup, air_side_keywords)
    added = False
    for ttitle, table in hits:
        tlo = (ttitle or "").lower()
        content = norm(table.get_text(" ", strip=True))[:800].lower() if table else ""
        if not (("air-side" in tlo or "air side" in tlo or "hvac system" in tlo) or
                ("baseline design" in content and "proposed design" in content) or
                ("system name in model" in content or "total cooling capacity" in content)):
            continue
        matrix = convert_units_in_table(drop_empty_rows_cols(table_to_matrix(table), True))
        if not matrix or len(matrix) < 2:
            continue
        flow.append(Paragraph(ttitle or "Air-Side HVAC", H2))
        for i, part in enumerate(split_wide(matrix, 1, 14)):
            if i > 0:
                flow.append(Paragraph(f"{ttitle or 'Air-Side HVAC'} (part {i+1})", NOTE))
            tbl = make_table(part, usable_w, header_cell, body_cell)
            if tbl:
                flow.append(tbl)
                flow.append(Spacer(1, 0.12*inch))
        flow.append(Spacer(1, 0.15*inch))
        added = True
    return added

def add_top_summary_hvac(flow, soup, H2, H3, NOTE, usable_w, header_cell, body_cell, proposed_only=False):
    flow.append(Paragraph("Summary", H2))
    flow.append(Paragraph(f"All units in {_units_note()}.", NOTE))
    flow.append(Paragraph("PRM Formulas: EER = Cooling Capacity (Btu/h) / Electric Input (W). EIR = 1/EER. COP = EER/3.412 (cooling) or Heating Output / Electric Input. HIR = 1/COP.", NOTE))
    have_air_side = _add_air_side_hvac_tables_from_report(flow, soup, H2, H3, NOTE, usable_w, header_cell, body_cell)
    data = build_proposed_hvac_summary_table(soup) if proposed_only else build_en1_hvac_table(soup, soup)
    if data:
        flow.append(Paragraph("HVAC Summary", H3))
        tbl = make_table(data, usable_w, header_cell, body_cell)
        if tbl:
            flow.append(tbl)
    flow.append(PageBreak())

def add_top_summary_hvac_baseline(flow, soup, H2, H3, NOTE, usable_w, header_cell, body_cell):
    flow.append(Paragraph("Baseline HVAC", H2))
    flow.append(Paragraph(f"EIR=1/EER, HIR=1/COP. All units in {_units_note()}.", NOTE))
    have_air_side = _add_air_side_hvac_tables_from_report(flow, soup, H2, H3, NOTE, usable_w, header_cell, body_cell)
    data = build_baseline_hvac_eir_hir_table(soup)
    if data:
        flow.append(Paragraph("HVAC Summary", H3))
        tbl = make_table(data, usable_w, header_cell, body_cell)
        if tbl:
            flow.append(tbl)
    flow.append(PageBreak())

def add_top_summary_walls(flow, base_soup, prop_soup, H2, H3, NOTE, usable_w, header_cell, body_cell):
    flow.append(Paragraph("Summary", H2))
    flow.append(Paragraph(f"All units in {_units_note()}.", NOTE))
    data = build_en1_wall_table(base_soup, prop_soup)
    if data:
        tbl = make_table(data, usable_w, header_cell, body_cell)
        if tbl:
            flow.append(tbl)
    flow.append(PageBreak())

def build_envelope_performance_summary(base_soup, prop_soup):
    """One-table summary: Walls, Roofs, Floors, Fenestration with area-weighted U-Factor. Proposed vs Baseline.
    Uses WWR tables as source of truth for wall/fenestration areas when available."""
    u_unit = f" [{_u_unit()}]"
    au = f" [{_area_unit()}]"
    header = ["Component", f"Prop Area{au}", f"Prop U{u_unit}", f"Base Area{au}", f"Base U{u_unit}"]

    prop_wwr = extract_wwr_table_data(prop_soup)
    base_wwr = extract_wwr_table_data(base_soup)
    prop_wwr, base_wwr = _harmonize_wwr_areas(prop_wwr, base_wwr)
    wall_tbl = build_en1_wall_table(base_soup, prop_soup)

    def _wall_totals_from_table():
        if not wall_tbl or len(wall_tbl) < 2:
            return None
        hdr = wall_tbl[0]
        tot = wall_tbl[-1]
        i_pt = get_col_index(hdr, ["prop total"])
        i_bt = get_col_index(hdr, ["base total"])
        i_pu = get_col_index(hdr, ["proposed u"])
        i_bu = get_col_index(hdr, ["baseline u"])
        if min(i_pt, i_bt, i_pu, i_bu) < 0:
            return None
        pa = parse_number(tot[i_pt]) if i_pt < len(tot) else None
        up = parse_number(tot[i_pu]) if i_pu < len(tot) else None
        ba = parse_number(tot[i_bt]) if i_bt < len(tot) else None
        ub = parse_number(tot[i_bu]) if i_bu < len(tot) else None
        # Table values are display-units; convert back to internal SI for summary formatting pipeline.
        if _USE_IMPERIAL:
            pa = (pa / 10.7639104167) if pa is not None else None
            ba = (ba / 10.7639104167) if ba is not None else None
            up = (up / 0.17612) if up is not None else None
            ub = (ub / 0.17612) if ub is not None else None
        return (pa, up, ba, ub)

    def _wall_vals():
        from_tbl = _wall_totals_from_table()
        if from_tbl:
            pa, up, ba, ub = from_tbl
            return pa or 0, up, ba or 0, ub
        base_agg = extract_opaque_exterior_aggregated(base_soup)
        prop_agg = extract_opaque_exterior_aggregated(prop_soup)
        all_const = sorted(set(base_agg) | set(prop_agg))
        constructions = [c for c in all_const if not _is_below_grade_wall(c)] or all_const
        prop_tot = sum(sum(prop_agg.get(c, {}).get(d, 0) for d in "NSEW") + prop_agg.get(c, {}).get("Other", 0) for c in constructions)
        base_tot = sum(sum(base_agg.get(c, {}).get(d, 0) for d in "NSEW") + base_agg.get(c, {}).get("Other", 0) for c in constructions)
        prop_ua, prop_a, base_ua, base_a = 0, 0, 0, 0
        for c in constructions:
            pa, ba = prop_agg.get(c, {}), base_agg.get(c, {})
            ap = sum(pa.get(d, 0) for d in "NSEW") + pa.get("Other", 0)
            ab = sum(ba.get(d, 0) for d in "NSEW") + ba.get("Other", 0)
            if pa.get("U") and ap: prop_ua += pa["U"] * ap; prop_a += ap
            if ba.get("U") and ab: base_ua += ba["U"] * ab; base_a += ab
        u_p = prop_ua / prop_a if prop_a else None
        u_b = base_ua / base_a if base_a else None
        if prop_wwr and prop_wwr.get("above_ground_m2"):
            prop_tot = prop_wwr["above_ground_m2"]
        if base_wwr and base_wwr.get("above_ground_m2"):
            base_tot = base_wwr["above_ground_m2"]
        return prop_tot, u_p, base_tot, u_b

    def _fen_vals():
        """Fenestration area and performance for EN-1 (U, SHGC, VLT)."""
        prop_fen = extract_fenestration_aggregated(prop_soup)
        base_fen = extract_fenestration_aggregated(base_soup)
        p_ua, p_a, p_shgc_a, p_shgc_area, p_vlt_a, p_vlt_area = 0, 0, 0, 0, 0, 0
        b_ua, b_a, b_shgc_a, b_shgc_area, b_vlt_a, b_vlt_area = 0, 0, 0, 0, 0, 0
        for v in (prop_fen or {}).values():
            if isinstance(v, dict):
                a = sum(v.get(d, 0) for d in "NSEW") + v.get("Other", 0)
                if a <= 0:
                    continue
                if v.get("U") is not None:
                    p_ua += v["U"] * a
                    p_a += a
                if v.get("SHGC") is not None:
                    p_shgc_a += v["SHGC"] * a
                    p_shgc_area += a
                if v.get("VLT") is not None:
                    p_vlt_a += v["VLT"] * a
                    p_vlt_area += a
        for v in (base_fen or {}).values():
            if isinstance(v, dict):
                a = sum(v.get(d, 0) for d in "NSEW") + v.get("Other", 0)
                if a <= 0:
                    continue
                if v.get("U") is not None:
                    b_ua += v["U"] * a
                    b_a += a
                if v.get("SHGC") is not None:
                    b_shgc_a += v["SHGC"] * a
                    b_shgc_area += a
                if v.get("VLT") is not None:
                    b_vlt_a += v["VLT"] * a
                    b_vlt_area += a
        p_tot = sum(sum(v.get(d, 0) for d in "NSEW") + v.get("Other", 0) for v in (prop_fen or {}).values() if isinstance(v, dict))
        b_tot = sum(sum(v.get(d, 0) for d in "NSEW") + v.get("Other", 0) for v in (base_fen or {}).values() if isinstance(v, dict))
        if prop_wwr and prop_wwr.get("fenestration_m2"):
            p_tot = prop_wwr["fenestration_m2"]
        if base_wwr and base_wwr.get("fenestration_m2"):
            b_tot = base_wwr["fenestration_m2"]
        u_p = p_ua / p_a if p_a else None
        u_b = b_ua / b_a if b_a else None
        shgc_p = p_shgc_a / p_shgc_area if p_shgc_area else None
        shgc_b = b_shgc_a / b_shgc_area if b_shgc_area else None
        vlt_p = p_vlt_a / p_vlt_area if p_vlt_area else None
        vlt_b = b_vlt_a / b_vlt_area if b_vlt_area else None
        return p_tot, u_p, b_tot, u_b, shgc_p, shgc_b, vlt_p, vlt_b

    def _roof_vals():
        base_agg = extract_opaque_exterior_roofs(base_soup)
        prop_agg = extract_opaque_exterior_roofs(prop_soup)
        all_const = sorted(set(base_agg) | set(prop_agg))
        if not all_const: return 0, None, 0, None
        prop_tot = sum(prop_agg.get(c, {}).get("Area_m2", 0) or 0 for c in all_const)
        base_tot = sum(base_agg.get(c, {}).get("Area_m2", 0) or 0 for c in all_const)
        prop_ua, prop_a, base_ua, base_a = 0, 0, 0, 0
        for c in all_const:
            pa, ba = prop_agg.get(c, {}), base_agg.get(c, {})
            ap = pa.get("Area_m2", 0) or 0
            ab = ba.get("Area_m2", 0) or 0
            if pa.get("U") and ap: prop_ua += pa["U"] * ap; prop_a += ap
            if ba.get("U") and ab: base_ua += ba["U"] * ab; base_a += ab
        return prop_tot, (prop_ua / prop_a if prop_a else None), base_tot, (base_ua / base_a if base_a else None)

    def _floor_vals():
        base_agg = extract_opaque_exterior_floors(base_soup)
        prop_agg = extract_opaque_exterior_floors(prop_soup)
        all_const = sorted(set(base_agg) | set(prop_agg))
        if not all_const: return 0, None, 0, None
        prop_tot = sum(prop_agg.get(c, {}).get("Area_m2", 0) or 0 for c in all_const)
        base_tot = sum(base_agg.get(c, {}).get("Area_m2", 0) or 0 for c in all_const)
        prop_ua, prop_a, base_ua, base_a = 0, 0, 0, 0
        for c in all_const:
            pa, ba = prop_agg.get(c, {}), base_agg.get(c, {})
            ap = pa.get("Area_m2", 0) or 0
            ab = ba.get("Area_m2", 0) or 0
            if pa.get("U") and ap: prop_ua += pa["U"] * ap; prop_a += ap
            if ba.get("U") and ab: base_ua += ba["U"] * ab; base_a += ab
        return prop_tot, (prop_ua / prop_a if prop_a else None), base_tot, (base_ua / base_a if base_a else None)

    rows = []
    for label, fn in [("Above-Grade Walls", _wall_vals), ("Roofs", _roof_vals), ("Floors", _floor_vals)]:
        pa, up, ba, ub = fn()
        rows.append([label, _fmt_area(pa), _fmt_u(up), _fmt_area(ba), _fmt_u(ub)])
    fen_res = _fen_vals()
    p_fa, u_fp, b_fa, u_fb = fen_res[0], fen_res[1], fen_res[2], fen_res[3]
    if p_fa or b_fa:
        rows.append(["Fenestration (Windows)", _fmt_area(p_fa), _fmt_u(u_fp), _fmt_area(b_fa), _fmt_u(u_fb)])
    return [header] + rows

def add_top_summary_envelope(flow, base_soup, prop_soup, H2, H3, NOTE, usable_w, header_cell, body_cell):
    """Top summary for opaque envelope: Walls, Roofs, Floors, Fenestration, Window-Wall Ratio."""
    flow.append(Paragraph("Summary – Opaque Envelope", H2))
    flow.append(Paragraph(f"All units in {_units_note()}.", NOTE))
    perf = build_envelope_performance_summary(base_soup, prop_soup)
    if perf and len(perf) >= 2:
        flow.append(Paragraph("Envelope Performance Summary (U-Factor)", H3))
        tbl = make_table(perf, usable_w, header_cell, body_cell)
        if tbl:
            flow.append(tbl)
        flow.append(Spacer(1, 0.12*inch))
    for section_title, builder in [
        ("Above-Grade Walls", build_en1_wall_table),
        ("Roof Assemblies", build_en1_roof_table),
        ("Floor Assemblies", build_en1_floor_table),
    ]:
        data = builder(base_soup, prop_soup)
        if data:
            flow.append(Paragraph(section_title, H3))
            tbl = make_table(data, usable_w, header_cell, body_cell)
            if tbl:
                flow.append(tbl)
            flow.append(Spacer(1, 0.12*inch))
    flow.append(PageBreak())

def add_top_summary_windows(flow, base_soup, prop_soup, H2, H3, NOTE, usable_w, header_cell, body_cell):
    """Windows PDF summary: fenestration assemblies."""
    flow.append(Paragraph("Summary - Windows / Fenestration", H2))
    flow.append(Paragraph(
        f"All units in {_units_note()}. Values come from EnergyPlus fenestration tables.",
        NOTE
    ))
    flow.append(Paragraph("Vertical Fenestration", H3))
    fen_data = build_en1_fenestration_table(base_soup, prop_soup)
    if fen_data:
        if isinstance(fen_data, list) and fen_data and isinstance(fen_data[0], tuple):
            for sect, data in fen_data:
                flow.append(Paragraph(str(sect), H3))
                tbl = make_table(data, usable_w, header_cell, body_cell)
                if tbl:
                    flow.append(tbl)
                flow.append(Spacer(1, 0.08*inch))
        else:
            tbl = make_table(fen_data, usable_w, header_cell, body_cell)
            if tbl:
                flow.append(tbl)
            flow.append(Spacer(1, 0.08*inch))

    flow.append(PageBreak())

def add_top_summary_exterior_lighting(flow, base_soup, prop_soup, H2, H3, NOTE, usable_w, header_cell, body_cell):
    flow.append(Paragraph("Exterior Lighting Summary", H2))
    flow.append(Paragraph(f"Fixture, surface, and power results. All units in {_units_note()}.", NOTE))
    tables = build_exterior_lighting_tables(base_soup or prop_soup, prop_soup)
    for title, data in tables:
        if data and len(data) >= 2:
            flow.append(Paragraph(title, H3))
            tbl = make_table(data, usable_w, header_cell, body_cell)
            if tbl:
                flow.append(tbl)
            flow.append(Spacer(1, 0.08*inch))
    flow.append(PageBreak())

def add_top_summary_lighting(flow, prop_soup, H2, H3, NOTE, usable_w, header_cell, body_cell, base_soup=None):
    flow.append(Paragraph("Interior LPD: Building Area Method", H2))
    flow.append(Paragraph(f"Compliance based on Appendix G PRM. All units in {_units_note()}.", NOTE))
    base = base_soup if base_soup is not None else prop_soup
    data = build_interior_lpd_building_area_method_table(base, prop_soup)
    if data:
        tbl = make_table(data, usable_w, header_cell, body_cell)
        if tbl:
            flow.append(tbl)
    flow.append(PageBreak())

def _section_key_to_category(key: str) -> str:
    """Map Report/section key to index category: annual, hvac, envelope, lighting."""
    k = (key or "").lower()
    if k == "__start__":
        return "annual"
    if any(x in k for x in ("annual", "output:variable", "end use", "utility", "site and source")):
        return "annual"
    if any(x in k for x in ("sizing", "component", "coil", "system", "hvac", "equipment", "dx", "pump", "boiler")):
        return "hvac"
    if any(x in k for x in ("opaque", "envelope", "fenestration", "construction", "wall", "roof", "floor")):
        return "envelope"
    if any(x in k for x in ("lighting", "lpd")):
        return "lighting"
    return ""

def _section_pages_to_ranges(section_pages: list, total_pages: int) -> dict:
    """Convert [(key, page), ...] to {category: [(start_page, end_page), ...]} using all matching pages."""
    if not section_pages:
        return {}
    cat_to_pages = {}
    for key, pg in sorted(section_pages, key=lambda x: x[1]):
        cat = _section_key_to_category(key)
        if not cat:
            continue
        if not isinstance(pg, int) or pg <= 0:
            continue
        if total_pages and pg > total_pages:
            continue
        cat_to_pages.setdefault(cat, set()).add(pg)

    out = {}
    for cat, pages_set in cat_to_pages.items():
        pages = sorted(pages_set)
        if not pages:
            continue
        ranges = []
        start = prev = pages[0]
        for p in pages[1:]:
            if p == prev + 1:
                prev = p
            else:
                ranges.append((start, prev))
                start = prev = p
        ranges.append((start, prev))
        out[cat] = ranges
    return out

def build_pdf_all_tables(soup, out_path, project_title, label, schedule_profiles=None):
    """Build full reports PDF. Returns (out_path, section_ranges) for Document Index."""
    H1,H2,H3,NOTE,BODY,HEADER_CELL,BODY_CELL = make_styles()
    doc = doc_template(out_path)
    page_w = landscape(TABLOID)[0]
    usable_w = page_w - 1.1*inch
    flow = []
    section_pages = []

    add_cover(flow, project_title, f"{label} – Full Tabular Reports", soup, H1,H2,NOTE,BODY)
    flow.append(_SectionMarker("__start__", section_pages))
    add_top_summary_annual(flow, soup, H2,H3,NOTE, usable_w, HEADER_CELL, BODY_CELL, schedule_profiles=schedule_profiles)

    for tag in soup.body.find_all(["p","b","table"], recursive=True):
        if tag.name == "p":
            t = norm(tag.get_text(" ", strip=True))
            if t.startswith("Report:"):
                report_name = t.replace("Report:", "").strip()
                flow.append(_SectionMarker(report_name, section_pages))
                flow.append(Paragraph(report_name, H2))
        elif tag.name == "b":
            bt = norm(tag.get_text(" ", strip=True))
            if bt and len(bt) < 90:
                flow.append(Paragraph(bt, H3))
        elif tag.name == "table":
            matrix = convert_units_in_table(drop_empty_rows_cols(table_to_matrix(tag), True))
            if not matrix or len(matrix) < 2:
                continue
            matrix = recalculate_wwr_table_from_areas(matrix)
            if all(is_effectively_empty(c) for c in matrix[0]):
                continue
            for i, part in enumerate(split_wide(matrix, 1, 12)):
                if i>0:
                    flow.append(Paragraph(f"Table continuation (part {i+1})", NOTE))
                tbl = make_table(part, usable_w, HEADER_CELL, BODY_CELL)
                if tbl:
                    flow.append(tbl); flow.append(Spacer(1, 0.12*inch))
    doc.build(flow)
    total = _get_pdf_page_count(out_path) or 0
    section_ranges = _section_pages_to_ranges(section_pages, total)
    return out_path, section_ranges

def build_pdf_subset(soup, out_path, project_title, label, keyword_groups, base_soup=None, top_summary="annual"):
    """top_summary: annual | hvac | hvac_baseline | envelope | walls | windows | lighting"""
    H1,H2,H3,NOTE,BODY,HEADER_CELL,BODY_CELL = make_styles()
    doc = doc_template(out_path)
    page_w = landscape(TABLOID)[0]
    usable_w = page_w - 1.1*inch
    flow=[]
    add_cover(flow, project_title, label, soup, H1,H2,NOTE,BODY)
    if top_summary == "hvac_baseline":
        add_top_summary_hvac_baseline(flow, soup, H2,H3,NOTE, usable_w, HEADER_CELL, BODY_CELL)
    elif top_summary == "hvac":
        add_top_summary_hvac(flow, soup, H2,H3,NOTE, usable_w, HEADER_CELL, BODY_CELL, proposed_only=True)
    elif top_summary == "envelope" and base_soup is not None:
        add_top_summary_envelope(flow, base_soup, soup, H2,H3,NOTE, usable_w, HEADER_CELL, BODY_CELL)
    elif top_summary == "walls" and base_soup is not None:
        add_top_summary_walls(flow, base_soup, soup, H2,H3,NOTE, usable_w, HEADER_CELL, BODY_CELL)
    elif top_summary == "windows" and base_soup is not None:
        add_top_summary_windows(flow, base_soup, soup, H2,H3,NOTE, usable_w, HEADER_CELL, BODY_CELL)
    elif top_summary == "lighting":
        add_top_summary_lighting(flow, soup, H2,H3,NOTE, usable_w, HEADER_CELL, BODY_CELL, base_soup=base_soup)
    elif top_summary == "exterior_lighting":
        add_top_summary_exterior_lighting(flow, base_soup, soup, H2,H3,NOTE, usable_w, HEADER_CELL, BODY_CELL)
    else:
        add_top_summary_annual(flow, soup, H2,H3,NOTE, usable_w, HEADER_CELL, BODY_CELL)

    allowed_cat = {
        "annual": "annual",
        "hvac": "hvac",
        "hvac_baseline": "hvac",
        "envelope": "envelope",
        "walls": "envelope",
        "windows": "envelope",
        "lighting": "lighting",
        "exterior_lighting": "lighting",
    }.get((top_summary or "").lower(), "")

    for group_title, keywords in keyword_groups:
        flow.append(Paragraph(group_title, H2))
        hits = find_tables_by_keywords(soup, keywords)
        seen=set()
        for ttitle, table in hits:
            if id(table) in seen: continue
            seen.add(id(table))
            # Keep category PDFs focused: include tables only from matching report sections.
            if allowed_cat:
                report_name = _table_report_name(table)
                report_cat = _section_key_to_category(report_name)
                if report_cat and report_cat != allowed_cat:
                    continue
            if ttitle and ttitle != "Table":
                flow.append(Paragraph(ttitle, H3))
            matrix = convert_units_in_table(drop_empty_rows_cols(table_to_matrix(table), True))
            if not matrix or len(matrix) < 2:
                continue
            tlo = (ttitle or "").lower()
            if "window-wall ratio" in tlo or "conditioned window" in tlo:
                matrix = recalculate_wwr_table_from_areas(matrix)
            for i, part in enumerate(split_wide(matrix, 1, 12)):
                if i>0:
                    flow.append(Paragraph(f"{ttitle} (part {i+1})", NOTE))
                tbl = make_table(part, usable_w, HEADER_CELL, BODY_CELL)
                if tbl:
                    flow.append(tbl); flow.append(Spacer(1, 0.12*inch))
        flow.append(PageBreak())
    doc.build(flow)

def _get_pdf_page_count(path: str) -> int:
    """Return page count of PDF using pypdf, or 0 if unreadable. Install: pip install pypdf"""
    try:
        from pypdf import PdfReader
        return len(PdfReader(path).pages)
    except Exception:
        return 0

def build_pdf_document_index(out_path: str, project_title: str,
                             baseline_path: str, baseline_ranges: dict,
                             proposed_path: str, proposed_ranges: dict) -> None:
    """Build Document Index. One row per category; both Baseline and Proposed columns filled.
    Shows all matching page ranges for each category in the full report."""
    H1, H2, _, NOTE = make_styles()[:4]
    doc = SimpleDocTemplate(out_path, pagesize=letter, leftMargin=0.5*inch, rightMargin=0.5*inch,
                            topMargin=0.5*inch, bottomMargin=0.5*inch)
    flow = []

    flow.append(Paragraph("Document Index (Page Numbers)", H1))
    flow.append(Paragraph(project_title, H2))
    flow.append(Paragraph("Page reference for reports in this package. Lists all matching page ranges for each category.", NOTE))
    flow.append(Spacer(1, 0.2*inch))

    def _range_str(path: str, ranges: dict, cat_key: str) -> str:
        if not path or not os.path.isfile(path):
            return "—"
        r = (ranges or {}).get(cat_key)
        if not r:
            return "—"
        if isinstance(r, tuple) and len(r) >= 2:
            r = [r]
        if not isinstance(r, list):
            return "—"
        parts = []
        for pair in r:
            if not isinstance(pair, (tuple, list)) or len(pair) < 2:
                continue
            start, end = int(pair[0]), int(pair[1])
            if start <= 0:
                continue
            if end < start:
                end = start
            parts.append(str(start) if start == end else f"{start}-{end}")
        if not parts:
            return "—"
        return "Pages " + ", ".join(parts)

    index_categories = [
        ("BEPU / BEPU-P", "Annual", "annual"),
        ("SV-A / SV-A-P", "HVAC", "hvac"),
        ("ERV / ERV-W", "Envelope", "envelope"),
        ("LV-C / LV-D", "Lighting", "lighting"),
    ]
    rows = [["Model Output Location (Report)", "Category", "Baseline Reports File", "Proposed Reports File"]]
    for code, cat_display, cat_key in index_categories:
        bl_pages = _range_str(baseline_path, baseline_ranges, cat_key)
        prop_pages = _range_str(proposed_path, proposed_ranges, cat_key)
        rows.append([code, cat_display, bl_pages, prop_pages])

    tbl = Table(rows, colWidths=[2.0*inch, 1.2*inch, 2.0*inch, 2.0*inch], cornerRadii=[8, 8, 8, 8])
    tbl.setStyle(TableStyle([
        ("GRID", (0,0), (-1,-1), 0.5, THEME["border"]),
        ("BACKGROUND", (0,0), (-1,0), THEME["header_bg"]),
        ("TEXTCOLOR", (0,0), (-1,0), THEME["header_fg"]),
        ("FONTSIZE", (0,0), (-1,-1), 9),
        ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
    ]))
    flow.append(tbl)
    doc.build(flow)

def build_modeling_notes_pdf(out_path: str, project_title: str, notes_text: str) -> None:
    """Build optional Modeling Notes PDF from user-entered text."""
    H1, H2, _, NOTE = make_styles()[:4]
    doc = SimpleDocTemplate(out_path, pagesize=letter, leftMargin=0.6*inch, rightMargin=0.6*inch,
                            topMargin=0.6*inch, bottomMargin=0.6*inch)
    flow = []
    flow.append(Paragraph("Modeling Notes", H1))
    flow.append(Paragraph(project_title, H2))
    flow.append(Paragraph("User-provided assumptions, formulas, and notes.", NOTE))
    flow.append(Spacer(1, 0.2*inch))
    body = ParagraphStyle("NotesBody", parent=getSampleStyleSheet()["BodyText"], fontName="Courier", fontSize=9, leading=12)
    flow.append(Preformatted((notes_text or "").replace("\r\n", "\n"), body))
    doc.build(flow)

def generate_package(baseline_html: str, proposed_html: str, outdir: str, project_override: str="", use_imperial: bool = True, progress_callback=None, standard_version: str = "", modeling_notes: str = "", baseline_model_file: str = "", proposed_model_file: str = "") -> str:
    def prog(pct: int, msg: str):
        if progress_callback:
            progress_callback(pct, msg)

    global _USE_IMPERIAL
    _USE_IMPERIAL = use_imperial
    os.makedirs(outdir, exist_ok=True)
    prog(2, "Parsing HTML…")
    base_soup = load_soup(baseline_html)
    prop_soup = load_soup(proposed_html)
    # Prefer explicit models, otherwise use the translated input beside eplustbl.
    baseline_model_file = discover_schedule_model(baseline_html, baseline_model_file)
    proposed_model_file = discover_schedule_model(proposed_html, proposed_model_file)
    base_sched_names = extract_used_schedule_names(base_soup)
    prop_sched_names = extract_used_schedule_names(prop_soup)
    base_refs = extract_used_schedule_refs_from_model(baseline_model_file) if baseline_model_file else {"names": set(), "handles": set()}
    prop_refs = extract_used_schedule_refs_from_model(proposed_model_file) if proposed_model_file else {"names": set(), "handles": set()}
    base_used_names = set(base_sched_names) | set(base_refs.get("names", set()))
    prop_used_names = set(prop_sched_names) | set(prop_refs.get("names", set()))
    base_model_profiles = extract_model_schedule_profiles(
        baseline_model_file, used_schedule_names=base_used_names,
        used_schedule_handles=base_refs.get("handles", set()), max_profiles=120
    ) if baseline_model_file else None
    prop_model_profiles = extract_model_schedule_profiles(
        proposed_model_file, used_schedule_names=prop_used_names,
        used_schedule_handles=prop_refs.get("handles", set()), max_profiles=120
    ) if proposed_model_file else None
    project = project_override.strip() or extract_project_name(prop_soup) or extract_project_name(base_soup)
    project_title = f"{project} – Energy Modeling Review Package (EnergyPlus PRM)"

    prog(5, "Building Baseline Reports…")
    f_base_reports = os.path.join(outdir, f"{project} - Baseline Reports.pdf")
    f_prop_reports = os.path.join(outdir, f"{project} - Proposed Reports.pdf")
    f_doc_index = os.path.join(outdir, f"{project} - Document Index.pdf")
    f_base_hvac = os.path.join(outdir, f"{project} - Baseline HVAC.pdf")
    f_prop_hvac = os.path.join(outdir, f"{project} - Proposed HVAC.pdf")
    f_envelope = os.path.join(outdir, f"{project} - Envelope Performance (Opaque).pdf")
    f_windows = os.path.join(outdir, f"{project} - Envelope Performance_Windows.pdf")
    f_int = os.path.join(outdir, f"{project} - Interior Lighting Calculations.pdf")
    f_ext = os.path.join(outdir, f"{project} - Exterior Lighting Calculations.pdf")
    f_notes = os.path.join(outdir, f"{project} - Modeling Notes.pdf")

    baseline_subtitle = f"BASELINE ({standard_version} Appendix G PRM)" if standard_version else "BASELINE (Appendix G PRM)"
    proposed_subtitle = f"PROPOSED DESIGN ({standard_version} Appendix G PRM)" if standard_version else "PROPOSED DESIGN (Appendix G PRM)"
    _, baseline_ranges = build_pdf_all_tables(base_soup, f_base_reports, project_title, baseline_subtitle, schedule_profiles=base_model_profiles)
    prog(15, "Building Proposed Reports…")
    _, proposed_ranges = build_pdf_all_tables(prop_soup, f_prop_reports, project_title, proposed_subtitle, schedule_profiles=prop_model_profiles)

    prog(25, "Building Baseline HVAC…")
    hvac_groups = [
        ("HVAC System & Component Sizing", ["coil sizing summary", "component sizing summary", "coil sizing", "component sizing"]),
        ("HVAC Equipment & DX Systems", ["pump", "boiler", "fan", "chiller", "condenser", "cooling tower", "dx", "unitary", "split system", "heat pump"]),
        ("Air Distribution", ["air terminals", "air loop", "zone equipment", "fan coil", "air handler"]),
        ("Plant & Loops", ["plant loop", "condenser loop", "demand side"]),
        ("Outdoor Air & Ventilation", ["outdoor air", "ventilation", "minimum outdoor", "design outdoor", "mechanical ventilation"]),
        ("Performance & Unmet Hours", ["unmet", "setpoint not met", "hours any zone", "throttling range"]),
    ]
    env_groups_envelope = [
        ("Opaque Envelope / Constructions", ["opaque", "construction", "u-factor", "r-value", "wall", "roof", "floor"]),
    ]
    env_groups_windows = [
        ("Fenestration / Window Performance", ["fenestration", "window", "glazing", "shgc", "u-factor", "frame", "fenestration u-factor"]),
    ]
    light_groups_int = [("Interior Lighting", ["interior lighting", "lighting power", "lpd", "lighting summary"])]
    light_groups_ext = [("Exterior Lighting", ["exterior lighting", "site exterior", "exterior lights"])]

    build_pdf_subset(base_soup, f_base_hvac, project_title, "BASELINE – HVAC", hvac_groups, top_summary="hvac_baseline")
    prog(35, "Building Proposed HVAC…")
    build_pdf_subset(prop_soup, f_prop_hvac, project_title, "PROPOSED – HVAC", hvac_groups, top_summary="hvac")
    prog(45, "Building Interior Lighting…")
    build_pdf_subset(prop_soup, f_int, project_title, "PROPOSED – Interior Lighting Calculations", light_groups_int, base_soup=base_soup, top_summary="lighting")
    prog(52, "Building Exterior Lighting…")
    build_pdf_subset(prop_soup, f_ext, project_title, "PROPOSED – Exterior Lighting Calculations", light_groups_ext, base_soup=base_soup, top_summary="exterior_lighting")
    prog(60, "Building Envelope (Opaque)…")
    build_pdf_subset(prop_soup, f_envelope, project_title, "PROPOSED – Envelope Performance (Opaque: Walls, Roofs, Floors)", env_groups_envelope, base_soup=base_soup, top_summary="envelope")
    prog(68, "Building Envelope (Windows)…")
    build_pdf_subset(prop_soup, f_windows, project_title, "PROPOSED – Envelope Performance (Windows)", env_groups_windows, base_soup=base_soup, top_summary="windows")

    prog(78, "Building Document Index…")
    build_pdf_document_index(f_doc_index, project_title,
                             f_base_reports, baseline_ranges, f_prop_reports, proposed_ranges)

    notes_clean = (modeling_notes or "").strip()
    if notes_clean:
        prog(82, "Building Modeling Notes…")
        build_modeling_notes_pdf(f_notes, project_title, notes_clean)

    zip_path = os.path.join(outdir, f"{project}_ReviewPackage.zip")
    zip_files = [f_doc_index, f_base_reports, f_prop_reports, f_base_hvac, f_prop_hvac, f_envelope, f_windows, f_int, f_ext]
    if notes_clean and os.path.isfile(f_notes):
        zip_files.append(f_notes)
    prog(85, "Creating ZIP…")
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for i, f in enumerate(zip_files):
            z.write(f, arcname=os.path.basename(f))
            prog(85 + int((i + 1) * 15 / len(zip_files)), "Creating ZIP…")
    prog(100, "Done")
    return zip_path

# ---- GUI ----
_tkinterdnd = None
_ctk = None

def _ensure_tkinterdnd():
    global _tkinterdnd
    try:
        from tkinterdnd2 import DND_FILES, TkinterDnD
        _tkinterdnd = (DND_FILES, TkinterDnD)
        return True
    except Exception:
        pass
    import sys
    import subprocess
    for cmd in [[sys.executable, "-m", "pip", "install", "tkinterdnd2"], ["py", "-m", "pip", "install", "tkinterdnd2"]]:
        try:
            subprocess.run(cmd, capture_output=True, timeout=120, check=True)
            break
        except Exception:
            continue
    try:
        from tkinterdnd2 import DND_FILES, TkinterDnD
        _tkinterdnd = (DND_FILES, TkinterDnD)
        return True
    except Exception:
        return False

def _ensure_customtkinter():
    global _ctk
    try:
        import customtkinter as ctk
        _ctk = ctk
        return True
    except Exception:
        pass
    for cmd in [[sys.executable, "-m", "pip", "install", "customtkinter"], ["py", "-m", "pip", "install", "customtkinter"]]:
        try:
            subprocess.run(cmd, capture_output=True, timeout=120, check=True)
            break
        except Exception:
            continue
    try:
        import customtkinter as ctk
        _ctk = ctk
        return True
    except Exception:
        _ctk = None
        return False

_ensure_tkinterdnd()
_ensure_customtkinter()

def _set_windows_app_user_model_id():
    if sys.platform != "win32":
        return
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
            "LIBER.EnergyPlusReviewPackager"
        )
    except Exception:
        pass

class App(tk.Tk if _tkinterdnd is None else _tkinterdnd[1].Tk):
    def __init__(self):
        super().__init__()
        self.title("EnergyPlus → ZIP of PDF Reports")
        self._apply_app_icon()
        self._setup_theme_and_fonts()
        self._use_ctk = _ctk is not None
        screen_w = max(1200, int(self.winfo_screenwidth()))
        screen_h = max(800, int(self.winfo_screenheight()))
        init_w = min(1180, int(screen_w * 0.72))
        init_h = min(900, int(screen_h * 0.84))
        self.geometry(f"{init_w}x{init_h}")
        self.minsize(860, 640)
        self.resizable(True, True)
        self.configure(bg=self._colors["bg"])
        try:
            self.attributes("-alpha", 0.0)
        except Exception:
            pass
        self.after(10, self._apply_window_corner_preference)

        self.baseline_path = tk.StringVar()
        self.proposed_path = tk.StringVar()
        self.baseline_model_path = tk.StringVar()
        self.proposed_model_path = tk.StringVar()
        self.project_name = tk.StringVar()
        self.status = tk.StringVar(value="Choose baseline + proposed eplustbl.html and click Generate.")
        self.header_text = "EnergyPlus eplustbl.html -> ZIP of reviewer-friendly PDFs"
        self.header_var = tk.StringVar(value="")
        self.out_zip = None

        main = ttk.Frame(self, padding=18, style="Card.TFrame")
        main.pack(fill="both", expand=True)

        title_row = ttk.Frame(main, style="Card.TFrame")
        title_row.pack(fill="x")
        self.title_label = tk.Label(
            title_row, textvariable=self.header_var, bg=self._colors["panel"], fg=self._colors["text"],
            font=self.font_title, anchor="w"
        )
        self.title_label.pack(side="left", anchor="w")
        self.help_btn = tk.Button(
            title_row, text="?", command=self._show_quick_help,
            bg=self._colors["button"], fg=self._colors["text"], activebackground=self._colors["button_hover"],
            activeforeground=self._colors["text"], relief="flat", bd=0, padx=9, pady=2,
            cursor="hand2", font=(self.font_title[0], 10, "bold")
        )
        self.help_btn.pack(side="right")

        info = f"Creates PDFs by category (Annual, HVAC, Envelope, Lighting) with Summary at the top of each."
        self.info_label = tk.Label(
            main, text=info, bg=self._colors["panel"], fg=self._colors["muted"],
            font=self.font_body, justify="left", anchor="w"
        )
        self.info_label.pack(anchor="w", pady=(6, 14))

        grid = ttk.Frame(main, style="Card.TFrame")
        grid.pack(fill="both", expand=True)

        def _parse_dropped_paths(data):
            """Parse Windows drag-drop data: {C:\\path} or {a} {b} -> list of paths."""
            if not data:
                return []
            s = str(data).strip()
            paths = []
            i = 0
            while i < len(s):
                if s[i] == "{":
                    j = s.find("}", i)
                    if j >= 0:
                        paths.append(s[i+1:j].strip())
                        i = j + 1
                    else:
                        break
                else:
                    i += 1
            return [p for p in paths if p and os.path.isfile(p)]

        def row(label, var, cmd):
            r = ttk.Frame(grid, style="Card.TFrame")
            r.pack(fill="x", pady=4)
            lbl = label + (" (or drop)" if _tkinterdnd else "")
            ttk.Label(r, text=lbl, width=28, anchor="w", style="Muted.TLabel").pack(side="left")
            if self._use_ctk:
                _ctk.CTkEntry(
                    r, textvariable=var, corner_radius=12, height=30,
                    fg_color=self._colors["input"], border_color=self._colors["border"],
                    text_color=self._colors["text"]
                ).pack(side="left", fill="x", expand=True, padx=(0, 8))
                _ctk.CTkButton(
                    r, text="Browse...", command=cmd, corner_radius=12, height=30, width=96,
                    fg_color=self._colors["button"], hover_color=self._colors["button_hover"],
                    text_color=self._colors["text"]
                ).pack(side="left")
            else:
                ttk.Entry(r, textvariable=var, style="Dark.TEntry").pack(side="left", fill="x", expand=True, padx=(0,8))
                ttk.Button(r, text="Browse...", command=cmd, width=12, style="Secondary.TButton").pack(side="left")
            return r

        r1 = row("Baseline HTML", self.baseline_path, self.pick_baseline)
        r2 = row("Proposed HTML", self.proposed_path, self.pick_proposed)
        r1m = row("Baseline model (auto: in.idf)", self.baseline_model_path, self.pick_baseline_model)
        r2m = row("Proposed model (auto: in.idf)", self.proposed_model_path, self.pick_proposed_model)

        if _tkinterdnd:
            DND_FILES, _ = _tkinterdnd
            def on_drop_baseline(e):
                paths = _parse_dropped_paths(e.data)
                if paths:
                    self._set_report_and_discover_model(
                        self.baseline_path, self.baseline_model_path, paths[0]
                    )
            def on_drop_proposed(e):
                paths = _parse_dropped_paths(e.data)
                if paths:
                    self._set_report_and_discover_model(
                        self.proposed_path, self.proposed_model_path, paths[0]
                    )
            r1.drop_target_register(DND_FILES)
            r1.dnd_bind("<<Drop>>", on_drop_baseline)
            r2.drop_target_register(DND_FILES)
            r2.dnd_bind("<<Drop>>", on_drop_proposed)
            def on_drop_baseline_model(e):
                paths = _parse_dropped_paths(e.data)
                if paths:
                    self.baseline_model_path.set(paths[0])
            def on_drop_proposed_model(e):
                paths = _parse_dropped_paths(e.data)
                if paths:
                    self.proposed_model_path.set(paths[0])
            r1m.drop_target_register(DND_FILES)
            r1m.dnd_bind("<<Drop>>", on_drop_baseline_model)
            r2m.drop_target_register(DND_FILES)
            r2m.dnd_bind("<<Drop>>", on_drop_proposed_model)

        r3 = ttk.Frame(grid, style="Card.TFrame")
        r3.pack(fill="x", pady=4)
        ttk.Label(r3, text="Project name", width=28, anchor="w", style="Muted.TLabel").pack(side="left")
        if self._use_ctk:
            _ctk.CTkEntry(
                r3, textvariable=self.project_name, corner_radius=12, height=30,
                fg_color=self._colors["input"], border_color=self._colors["border"],
                text_color=self._colors["text"]
            ).pack(side="left", fill="x", expand=True)
        else:
            ttk.Entry(r3, textvariable=self.project_name, style="Dark.TEntry").pack(side="left", fill="x", expand=True)

        r3b = ttk.Frame(grid, style="Card.TFrame")
        r3b.pack(fill="x", pady=4)
        ttk.Label(r3b, text="Standard version", width=28, anchor="w", style="Muted.TLabel").pack(side="left")
        self.standard_version = tk.StringVar()
        if self._use_ctk:
            _ctk.CTkEntry(
                r3b, textvariable=self.standard_version, corner_radius=12, height=30,
                fg_color=self._colors["input"], border_color=self._colors["border"],
                text_color=self._colors["text"]
            ).pack(side="left", fill="x", expand=True)
        else:
            ttk.Entry(r3b, textvariable=self.standard_version, style="Dark.TEntry").pack(side="left", fill="x", expand=True)
        ttk.Label(r3b, text="(e.g. 90.1-2019 - optional)", style="Muted.TLabel").pack(side="left", padx=(8, 0))

        r4 = ttk.Frame(grid, style="Card.TFrame")
        r4.pack(fill="x", pady=4)
        ttk.Label(r4, text="Units", width=28, anchor="w", style="Muted.TLabel").pack(side="left")
        self.units_var = tk.StringVar(value="imperial")
        units_wrap = tk.Frame(r4, bg=self._colors["panel"])
        units_wrap.pack(side="left", padx=(2, 0))
        self.units_btn_imp = tk.Button(
            units_wrap, text="US Imperial", relief="flat", bd=0, padx=14, pady=7, cursor="hand2",
            font=self.font_body, command=lambda: self._set_units_mode("imperial")
        )
        self.units_btn_imp.pack(side="left", padx=(0, 8))
        self.units_btn_met = tk.Button(
            units_wrap, text="Metric (SI)", relief="flat", bd=0, padx=14, pady=7, cursor="hand2",
            font=self.font_body, command=lambda: self._set_units_mode("metric")
        )
        self.units_btn_met.pack(side="left")
        self._set_units_mode("imperial")
        self.units_btn_imp.bind("<Enter>", lambda e: self._on_units_hover("imperial", True))
        self.units_btn_imp.bind("<Leave>", lambda e: self._on_units_hover("imperial", False))
        self.units_btn_met.bind("<Enter>", lambda e: self._on_units_hover("metric", True))
        self.units_btn_met.bind("<Leave>", lambda e: self._on_units_hover("metric", False))

        r5 = ttk.Frame(grid, style="Card.TFrame")
        r5.pack(fill="both", expand=True, pady=4)
        ttk.Label(r5, text="Modeling notes (optional)", style="Muted.TLabel").pack(anchor="w")
        notes_box = ttk.Frame(r5, style="Card.TFrame")
        notes_box.pack(fill="both", expand=True, pady=(4, 0))
        self.notes_text = tk.Text(
            notes_box, wrap="word", height=8, font=self.font_mono,
            bg=self._colors["input"], fg=self._colors["text"], insertbackground=self._colors["accent"],
            relief="flat", bd=0, highlightthickness=1, highlightbackground=self._colors["border"], highlightcolor=self._colors["accent"]
        )
        self.notes_text.pack(side="left", fill="both", expand=True)
        self._init_notes_scroll_indicator(notes_box)
        ttk.Label(r5, text="Include assumptions, equations, and modeling logic. Generated only when non-empty.", style="Muted.TLabel").pack(anchor="w", pady=(4, 0))

        btns = ttk.Frame(main, style="Card.TFrame")
        btns.pack(fill="x", pady=(12,6))
        if self._use_ctk:
            self.gen_btn = _ctk.CTkButton(
                btns, text="Generate ZIP (PDFs)", command=self.generate_clicked, corner_radius=14, height=34,
                fg_color=self._colors["accent"], hover_color="#67e8f9", text_color="#001018",
                font=(self.font_title[0], 11, "bold")
            )
        else:
            self.gen_btn = tk.Button(
                btns, text="Generate ZIP (PDFs)", command=self.generate_clicked,
                bg=self._colors["accent"], fg="#001018", activebackground="#67e8f9", activeforeground="#001018",
                relief="flat", bd=0, padx=16, pady=9, cursor="hand2", font=(self.font_title[0], 10, "bold")
            )
        self.gen_btn.pack(side="left")
        if self._use_ctk:
            self.open_btn = _ctk.CTkButton(
                btns, text="Show ZIP...", command=self.show_zip, state="disabled", corner_radius=14, height=34,
                fg_color=self._colors["button"], hover_color=self._colors["button_hover"], text_color=self._colors["text"],
                font=self.font_body
            )
        else:
            self.open_btn = tk.Button(
                btns, text="Show ZIP...", command=self.show_zip, state="disabled",
                bg=self._colors["button"], fg=self._colors["text"], activebackground=self._colors["button_hover"],
                activeforeground=self._colors["text"], disabledforeground="#64748b",
                relief="flat", bd=0, padx=12, pady=9, cursor="hand2", font=self.font_body
            )
        self.open_btn.pack(side="left", padx=8)
        if self._use_ctk:
            self.copy_btn = _ctk.CTkButton(
                btns, text="Copy path", command=self.copy_zip_path, state="disabled", corner_radius=14, height=34,
                fg_color=self._colors["button"], hover_color=self._colors["button_hover"], text_color=self._colors["text"],
                font=self.font_body
            )
        else:
            self.copy_btn = tk.Button(
                btns, text="Copy path", command=self.copy_zip_path, state="disabled",
                bg=self._colors["button"], fg=self._colors["text"], activebackground=self._colors["button_hover"],
                activeforeground=self._colors["text"], disabledforeground="#64748b",
                relief="flat", bd=0, padx=12, pady=9, cursor="hand2", font=self.font_body
            )
        self.copy_btn.pack(side="left", padx=4)
        if not self._use_ctk:
            self._hover_anim_bind(self.gen_btn, self._colors["accent"], "#67e8f9")
            self._hover_anim_bind(self.open_btn, self._colors["button"], self._colors["button_hover"])
            self._hover_anim_bind(self.copy_btn, self._colors["button"], self._colors["button_hover"])
            self._hover_anim_bind(self.help_btn, self._colors["button"], self._colors["button_hover"])

        self.progress_frame = ttk.Frame(main, style="Card.TFrame")
        self.progress_bar = ttk.Progressbar(self.progress_frame, mode="determinate", maximum=100, style="Modern.Horizontal.TProgressbar")
        self.progress_bar.pack(fill="x")
        self.progress_frame.pack_forget()  # hidden until generation starts

        self.status_label = tk.Label(
            main, textvariable=self.status, bg=self._colors["panel"], fg=self._colors["accent_soft"],
            font=self.font_mono, anchor="w"
        )
        self.status_label.pack(anchor="w", pady=(8,0), fill="x")

        ttk.Label(main, text="by LIBER Creative", style="Muted.TLabel").pack(anchor="e", pady=(12,0))

        self.after(120, self._animate_window_in)
        self.after(220, self._animate_header_typewriter)
        self.after(400, self._pulse_status_label)

    def _setup_theme_and_fonts(self):
        """Configure a modern dark UI theme and font fallbacks."""
        self._colors = {
            "bg": "#0b1220",
            "panel": "#111827",
            "text": "#e5e7eb",
            "muted": "#94a3b8",
            "accent": "#22d3ee",
            "accent_soft": "#67e8f9",
            "input": "#0f172a",
            "border": "#334155",
            "button": "#1f2937",
            "button_hover": "#374151",
        }
        families = set(tkfont.families())
        ui_family = "Montserrat" if "Montserrat" in families else ("Segoe UI" if "Segoe UI" in families else "Arial")
        mono_family = "Courier New" if "Courier New" in families else ("Consolas" if "Consolas" in families else "Courier")
        self.font_title = (ui_family, 14, "bold")
        self.font_body = (ui_family, 10)
        self.font_mono = (mono_family, 10)

        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except Exception:
            pass
        style.configure(".", background=self._colors["panel"], foreground=self._colors["text"], font=self.font_body)
        style.configure("Card.TFrame", background=self._colors["panel"])
        style.configure("TLabel", background=self._colors["panel"], foreground=self._colors["text"], font=self.font_body)
        style.configure("Muted.TLabel", background=self._colors["panel"], foreground=self._colors["muted"], font=self.font_body)
        style.configure("Dark.TEntry",
                        fieldbackground=self._colors["input"], foreground=self._colors["text"], padding=6)
        style.map("Dark.TEntry", fieldbackground=[("disabled", "#0b1220")], foreground=[("disabled", "#64748b")])
        style.configure("Dark.TRadiobutton", background=self._colors["panel"], foreground=self._colors["text"])
        style.map("Dark.TRadiobutton",
                  background=[("active", self._colors["panel"])],
                  foreground=[("active", self._colors["accent_soft"])])
        style.configure("Accent.TButton",
                        background=self._colors["accent"], foreground="#001018",
                        padding=(12, 8), font=(ui_family, 10, "bold"))
        style.map("Accent.TButton",
                  background=[("active", "#67e8f9"), ("disabled", "#155e75")],
                  foreground=[("disabled", "#94a3b8")])
        style.configure("Secondary.TButton",
                        background=self._colors["button"], foreground=self._colors["text"],
                        padding=(10, 8), font=self.font_body)
        style.map("Secondary.TButton",
                  background=[("active", self._colors["button_hover"]), ("disabled", "#1e293b")],
                  foreground=[("disabled", "#64748b")])
        style.configure("Modern.Horizontal.TProgressbar",
                        troughcolor=self._colors["input"],
                        background=self._colors["accent"])

    def _show_quick_help(self):
        msg = (
            "Quick Help\n\n"
            "1) Select Baseline and Proposed eplustbl.html files.\n"
            "2) The matching in.idf is detected automatically when it is beside each HTML.\n"
            "   Otherwise select the Baseline/Proposed model files for complete schedule charts.\n"
            "3) (Optional) Enter Modeling Notes.\n"
            "4) Click 'Generate ZIP (PDFs)'.\n\n"
            "Release download:\n"
            "- Open this project's GitHub page -> Releases.\n"
            "- Download the latest EXE from Assets.\n"
            "- Run the EXE (or verify SHA256 first if hash is provided).\n\n"
            "Note: only complete 24-hour model schedules are charted; two-point HTML "
            "summary samples are never presented as daily curves."
        )
        messagebox.showinfo("How to Use", msg)

    def _hex_to_rgb(self, color_hex: str):
        c = (color_hex or "").lstrip("#")
        return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)

    def _rgb_to_hex(self, rgb):
        return "#%02x%02x%02x" % tuple(max(0, min(255, int(v))) for v in rgb)

    def _blend_hex(self, from_hex: str, to_hex: str, t: float) -> str:
        fr, fg, fb = self._hex_to_rgb(from_hex)
        tr, tg, tb = self._hex_to_rgb(to_hex)
        return self._rgb_to_hex((fr + (tr - fr) * t, fg + (tg - fg) * t, fb + (tb - fb) * t))

    def _hover_anim_bind(self, widget, base_color: str, hover_color: str):
        def animate(to_hover=True, step=0, steps=6):
            t = step / steps
            if not to_hover:
                t = 1 - t
            c = self._blend_hex(base_color, hover_color, t)
            try:
                widget.configure(bg=c, activebackground=c)
            except Exception:
                return
            if step < steps:
                self.after(16, lambda: animate(to_hover, step + 1, steps))
        widget.bind("<Enter>", lambda e: animate(True))
        widget.bind("<Leave>", lambda e: animate(False))

    def _animate_widget_bg(self, widget, from_color: str, to_color: str, step=0, steps=6):
        t = step / steps
        c = self._blend_hex(from_color, to_color, t)
        try:
            widget.configure(bg=c, activebackground=c)
        except Exception:
            return
        if step < steps:
            self.after(16, lambda: self._animate_widget_bg(widget, from_color, to_color, step + 1, steps))

    def _set_units_mode(self, mode: str):
        self.units_var.set(mode)
        active_bg = self._colors["accent"]
        active_fg = "#001018"
        idle_bg = self._colors["button"]
        idle_fg = self._colors["text"]
        for btn, value in ((self.units_btn_imp, "imperial"), (self.units_btn_met, "metric")):
            is_active = (mode == value)
            btn.configure(
                bg=(active_bg if is_active else idle_bg),
                fg=(active_fg if is_active else idle_fg),
                activebackground=(active_bg if is_active else self._colors["button_hover"]),
                activeforeground=(active_fg if is_active else idle_fg),
            )

    def _on_units_hover(self, mode: str, entering: bool):
        """Hover animation for units switcher without breaking active selection highlight."""
        current = self.units_var.get()
        btn = self.units_btn_imp if mode == "imperial" else self.units_btn_met
        if mode == current:
            # Active option stays highlighted.
            self._set_units_mode(current)
            return
        if entering:
            self._animate_widget_bg(btn, self._colors["button"], self._colors["button_hover"])
        else:
            self._animate_widget_bg(btn, self._colors["button_hover"], self._colors["button"])
            self.after(110, lambda: self._set_units_mode(current))

    def _init_notes_scroll_indicator(self, parent):
        """Create a thin auto-fading scroll indicator for notes text."""
        self.notes_indicator_canvas = tk.Canvas(
            parent, width=4, highlightthickness=0, bd=0,
            bg=self._colors["input"]
        )
        self.notes_indicator_canvas.pack(side="right", fill="y", padx=(3, 1))
        self.notes_indicator_line = self.notes_indicator_canvas.create_rectangle(
            1, 1, 3, 30, fill=self._colors["accent"], outline=self._colors["accent"]
        )
        self.notes_indicator_level = 0.0
        self.notes_indicator_fade_job = None

        self.notes_text.configure(yscrollcommand=self._on_notes_text_scroll)
        self.notes_text.bind("<MouseWheel>", self._on_notes_user_scroll, add="+")
        self.notes_text.bind("<Button-4>", self._on_notes_user_scroll, add="+")
        self.notes_text.bind("<Button-5>", self._on_notes_user_scroll, add="+")
        self.notes_text.bind("<KeyRelease-Up>", self._on_notes_user_scroll, add="+")
        self.notes_text.bind("<KeyRelease-Down>", self._on_notes_user_scroll, add="+")
        self.notes_text.bind("<KeyRelease-Prior>", self._on_notes_user_scroll, add="+")
        self.notes_text.bind("<KeyRelease-Next>", self._on_notes_user_scroll, add="+")
        self.notes_text.bind("<Configure>", self._on_notes_user_scroll, add="+")
        self.notes_indicator_canvas.bind("<Configure>", self._on_notes_user_scroll, add="+")
        self._on_notes_text_scroll("0.0", "1.0")
        self._set_notes_indicator_level(0.0)

    def _on_notes_user_scroll(self, _event=None):
        self._flash_notes_indicator()

    def _on_notes_text_scroll(self, first, last):
        """Update indicator geometry whenever notes yview changes."""
        self._update_notes_indicator_geometry(first, last)

    def _update_notes_indicator_geometry(self, first, last):
        try:
            f = float(first)
            l = float(last)
        except Exception:
            f, l = 0.0, 1.0
        h = max(8, int(self.notes_indicator_canvas.winfo_height()))
        y1 = int(f * h)
        y2 = int(max(y1 + 14, l * h))
        y2 = min(h - 1, y2)
        self.notes_indicator_canvas.coords(self.notes_indicator_line, 1, y1, 3, y2)

    def _set_notes_indicator_level(self, level: float):
        level = max(0.0, min(1.0, level))
        self.notes_indicator_level = level
        c = self._blend_hex(self._colors["input"], self._colors["accent"], level)
        state = "hidden" if level <= 0.02 else "normal"
        self.notes_indicator_canvas.itemconfigure(
            self.notes_indicator_line, fill=c, outline=c, state=state
        )

    def _flash_notes_indicator(self):
        self._set_notes_indicator_level(1.0)
        if self.notes_indicator_fade_job:
            try:
                self.after_cancel(self.notes_indicator_fade_job)
            except Exception:
                pass
        self.notes_indicator_fade_job = self.after(220, self._fade_notes_indicator_step)

    def _fade_notes_indicator_step(self):
        nxt = self.notes_indicator_level - 0.12
        self._set_notes_indicator_level(nxt)
        if nxt > 0.02:
            self.notes_indicator_fade_job = self.after(34, self._fade_notes_indicator_step)
        else:
            self.notes_indicator_fade_job = None

    def _animate_window_in(self, alpha=0.0):
        try:
            if alpha >= 0.99:
                self.attributes("-alpha", 1.0)
                return
            self.attributes("-alpha", alpha)
            self.after(18, lambda: self._animate_window_in(alpha + 0.07))
        except Exception:
            pass

    def _animate_header_typewriter(self, idx=0):
        if idx > len(self.header_text):
            return
        self.header_var.set(self.header_text[:idx])
        self.after(16, lambda: self._animate_header_typewriter(idx + 1))

    def _pulse_status_label(self, phase=0):
        try:
            colors = (self._colors["accent_soft"], self._colors["accent"], "#7dd3fc")
            self.status_label.configure(fg=colors[phase % len(colors)])
            self.after(850, lambda: self._pulse_status_label(phase + 1))
        except Exception:
            pass

    def _apply_window_corner_preference(self):
        """Request fully rounded corners on Windows 11 (not small-radius variant)."""
        if sys.platform != "win32":
            return
        try:
            import ctypes
            DWMWA_WINDOW_CORNER_PREFERENCE = 33
            DWMWCP_ROUND = 2
            hwnd = ctypes.c_void_p(self.winfo_id())
            pref = ctypes.c_int(DWMWCP_ROUND)
            ctypes.windll.dwmapi.DwmSetWindowAttribute(
                hwnd,
                ctypes.c_uint(DWMWA_WINDOW_CORNER_PREFERENCE),
                ctypes.byref(pref),
                ctypes.sizeof(pref),
            )
        except Exception:
            pass

    def _apply_app_icon(self):
        """Apply icon for window/taskbar in script and PyInstaller one-file modes."""
        try:
            _set_windows_app_user_model_id()
            base_dir = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
            candidates = [
                # In one-file mode, icon can often be loaded directly from EXE resource.
                sys.executable if getattr(sys, "frozen", False) else "",
                os.environ.get("ENERGYPLUS_REVIEW_PACKAGER_ICON", ""),
                os.path.join(base_dir, "EnergyPlusReviewPackager.ico"),
                os.path.join(os.path.dirname(os.path.abspath(__file__)), "EnergyPlusReviewPackager.ico"),
            ]
            for icon_path in candidates:
                if os.path.isfile(icon_path):
                    try:
                        self.iconbitmap(default=icon_path)
                        # Re-apply on idle for some Windows shells/taskbar refresh timing.
                        self.after(0, lambda p=icon_path: self.iconbitmap(default=p))
                        break
                    except Exception:
                        continue
        except Exception:
            pass

    def pick_baseline(self):
        p = filedialog.askopenfilename(filetypes=[("HTML files","*.html;*.htm"),("All files","*.*")])
        if p:
            self._set_report_and_discover_model(
                self.baseline_path, self.baseline_model_path, p
            )

    def pick_proposed(self):
        p = filedialog.askopenfilename(filetypes=[("HTML files","*.html;*.htm"),("All files","*.*")])
        if p:
            self._set_report_and_discover_model(
                self.proposed_path, self.proposed_model_path, p
            )

    def _set_report_and_discover_model(self, report_var, model_var, report_path):
        report_var.set(report_path)
        if not model_var.get().strip():
            detected = discover_schedule_model(report_path)
            if detected:
                model_var.set(detected)

    def pick_baseline_model(self):
        p = filedialog.askopenfilename(filetypes=[("Model files","*.idf;*.imf;*.osm;*.txt"),("All files","*.*")])
        if p:
            self.baseline_model_path.set(p)

    def pick_proposed_model(self):
        p = filedialog.askopenfilename(filetypes=[("Model files","*.idf;*.imf;*.osm;*.txt"),("All files","*.*")])
        if p:
            self.proposed_model_path.set(p)

    def generate_clicked(self):
        base = self.baseline_path.get().strip()
        prop = self.proposed_path.get().strip()
        if not base or not os.path.isfile(base):
            messagebox.showerror("Missing baseline", "Please select baseline eplustbl.html")
            return
        if not prop or not os.path.isfile(prop):
            messagebox.showerror("Missing proposed", "Please select proposed eplustbl.html")
            return

        initialdir = os.path.dirname(prop) if prop and os.path.dirname(prop) else None
        save_to = filedialog.asksaveasfilename(
            defaultextension=".zip", filetypes=[("ZIP","*.zip")], initialfile="EnergyPlus_ReviewPackage.zip",
            initialdir=initialdir
        )
        if not save_to:
            return

        self.status.set("Generating PDFs…")
        self.gen_btn.configure(state="disabled")
        self.open_btn.configure(state="disabled")
        self.copy_btn.configure(state="disabled")
        self.progress_bar["value"] = 0
        self.progress_frame.pack(fill="x", pady=(6,0), before=self.status_label)
        self.update_idletasks()

        use_imperial = self.units_var.get() == "imperial"
        proj = self.project_name.get()
        prog_queue = queue.Queue()

        def work():
            try:
                def on_progress(pct: int, msg: str):
                    try:
                        prog_queue.put_nowait((pct, msg))
                    except queue.Full:
                        pass

                with tempfile.TemporaryDirectory() as td:
                    outdir = os.path.join(td, "out")
                    std = self.standard_version.get().strip()
                    notes = self.notes_text.get("1.0", "end-1c")
                    bmodel = self.baseline_model_path.get().strip()
                    pmodel = self.proposed_model_path.get().strip()
                    zip_path = generate_package(
                        base, prop, outdir, proj, use_imperial=use_imperial,
                        progress_callback=on_progress, standard_version=std, modeling_notes=notes,
                        baseline_model_file=bmodel, proposed_model_file=pmodel
                    )
                    # copy to user-selected location
                    with open(zip_path, "rb") as fsrc, open(save_to, "wb") as fdst:
                        fdst.write(fsrc.read())
                prog_queue.put_nowait(("done", save_to))
            except Exception as e:
                prog_queue.put_nowait(("error", str(e)))

        def poll_progress():
            try:
                while True:
                    item = prog_queue.get_nowait()
                    if item[0] == "done":
                        self.out_zip = item[1]
                        self.status.set(f"Done: {item[1]}")
                        self.progress_bar["value"] = 100
                        self.progress_frame.pack_forget()
                        self.open_btn.configure(state="normal")
                        self.copy_btn.configure(state="normal")
                        self.gen_btn.configure(state="normal")
                        self.update_idletasks()
                        return
                    elif item[0] == "error":
                        self.status.set("ERROR: " + str(item[1]))
                        self.progress_frame.pack_forget()
                        self.gen_btn.configure(state="normal")
                        self.update_idletasks()
                        messagebox.showerror("Generation failed", str(item[1]))
                        return
                    else:
                        pct, msg = item
                        self.progress_bar["value"] = pct
                        self.status.set(msg)
                    self.update_idletasks()
            except queue.Empty:
                pass
            self.after(80, poll_progress)

        def start():
            threading.Thread(target=work, daemon=True).start()
            self.after(80, poll_progress)

        start()

    def show_zip(self):
        if not self.out_zip:
            return
        try:
            path = os.path.normpath(os.path.abspath(self.out_zip))
            folder = os.path.dirname(path) or os.getcwd()
            if os.name == "nt":
                path_escaped = path.replace('"', '""')
                subprocess.run(f'explorer /select,"{path_escaped}"', shell=True, timeout=5)
            else:
                if hasattr(os, "startfile"):
                    os.startfile(folder)
                else:
                    subprocess.run(["xdg-open", folder], check=False, timeout=5)
        except Exception:
            messagebox.showinfo("ZIP location", self.out_zip)

    def copy_zip_path(self):
        """Copy folder path to clipboard so user can paste in open Explorer address bar (avoids new window)."""
        if not self.out_zip:
            return
        try:
            path = os.path.normpath(os.path.abspath(self.out_zip))
            folder = os.path.dirname(path) or os.getcwd()
            self.clipboard_clear()
            self.clipboard_append(folder)
            self.update()
            self.status.set("Folder path copied. Paste in Explorer address bar to jump without new window.")
        except Exception:
            messagebox.showinfo("ZIP location", self.out_zip)

if __name__ == "__main__":
    import sys
    _set_windows_app_user_model_id()
    if sys.platform == "win32":
        try:
            import ctypes
            hwnd = ctypes.windll.kernel32.GetConsoleWindow()
            if hwnd:
                ctypes.windll.user32.ShowWindow(hwnd, 0)
        except Exception:
            pass
    try:
        from tkinter import Tk  # noqa
    except Exception as e:
        raise
    app = App()
    app.mainloop()
