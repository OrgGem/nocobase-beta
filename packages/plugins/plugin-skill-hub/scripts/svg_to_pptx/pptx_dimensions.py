"""Slide dimensions, format detection, EMU conversion, and constants."""

from __future__ import annotations

import re
from pathlib import Path
from xml.etree import ElementTree as ET

# Standalone CANVAS_FORMATS (no external config dependency)
CANVAS_FORMATS = {
    'ppt169': {'name': 'PPT 16:9', 'dimensions': '1280x720', 'viewbox': '0 0 1280 720'},
    'ppt43': {'name': 'PPT 4:3', 'dimensions': '1024x768', 'viewbox': '0 0 1024 768'},
    'wechat': {'name': 'WeChat Cover', 'dimensions': '900x383', 'viewbox': '0 0 900 383'},
    'xiaohongshu': {'name': 'XiaoHongShu', 'dimensions': '1242x1660', 'viewbox': '0 0 1242 1660'},
    'moments': {'name': 'Moments/Instagram', 'dimensions': '1080x1080', 'viewbox': '0 0 1080 1080'},
    'story': {'name': 'Story/Vertical', 'dimensions': '1080x1920', 'viewbox': '0 0 1080 1920'},
    'banner': {'name': 'Web Banner', 'dimensions': '1920x1080', 'viewbox': '0 0 1920 1080'},
    'a4': {'name': 'A4 Print', 'dimensions': '1240x1754', 'viewbox': '0 0 1240 1754'},
}


def get_project_info(path: str) -> dict:
    """Minimal project info extraction (standalone version)."""
    return {'format': 'unknown', 'name': Path(path).name}


# EMU conversion constants
EMU_PER_INCH = 914400
EMU_PER_PIXEL = EMU_PER_INCH / 96

# XML namespaces
NAMESPACES = {
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'asvg': 'http://schemas.microsoft.com/office/drawing/2016/SVG/main',
}

# Register namespaces for ElementTree output
for prefix, uri in NAMESPACES.items():
    ET.register_namespace(prefix, uri)


def get_slide_dimensions(
    canvas_format: str,
    custom_pixels: tuple[int, int] | None = None,
) -> tuple[int, int]:
    """Get slide dimensions in EMU units."""
    if custom_pixels:
        width_px, height_px = custom_pixels
    else:
        if canvas_format not in CANVAS_FORMATS:
            canvas_format = 'ppt169'

        dimensions = CANVAS_FORMATS[canvas_format]['dimensions']
        match = re.match(r'(\d+)[×x](\d+)', dimensions)
        if match:
            width_px = int(match.group(1))
            height_px = int(match.group(2))
        else:
            width_px, height_px = 1280, 720

    return int(width_px * EMU_PER_PIXEL), int(height_px * EMU_PER_PIXEL)


def get_pixel_dimensions(
    canvas_format: str,
    custom_pixels: tuple[int, int] | None = None,
) -> tuple[int, int]:
    """Get canvas pixel dimensions."""
    if custom_pixels:
        return custom_pixels

    if canvas_format not in CANVAS_FORMATS:
        canvas_format = 'ppt169'

    dimensions = CANVAS_FORMATS[canvas_format]['dimensions']
    match = re.match(r'(\d+)[×x](\d+)', dimensions)
    if match:
        return int(match.group(1)), int(match.group(2))
    return 1280, 720


def get_viewbox_dimensions(svg_path: Path) -> tuple[int, int] | None:
    """Extract pixel dimensions from SVG viewBox."""
    try:
        with open(svg_path, 'r', encoding='utf-8') as f:
            content = f.read(2000)

        match = re.search(r'viewBox="([^"]+)"', content)
        if not match:
            return None

        parts = re.split(r'[\s,]+', match.group(1).strip())
        if len(parts) < 4:
            return None

        width = float(parts[2])
        height = float(parts[3])
        if width <= 0 or height <= 0:
            return None

        return int(round(width)), int(round(height))
    except Exception:
        return None


def detect_format_from_svg(svg_path: Path) -> str | None:
    """Detect canvas format from an SVG file's viewBox."""
    try:
        with open(svg_path, 'r', encoding='utf-8') as f:
            content = f.read(2000)

        match = re.search(r'viewBox="([^"]+)"', content)
        if match:
            viewbox = match.group(1)
            for fmt_key, fmt_info in CANVAS_FORMATS.items():
                if fmt_info['viewbox'] == viewbox:
                    return fmt_key
    except Exception:
        pass
    return None
