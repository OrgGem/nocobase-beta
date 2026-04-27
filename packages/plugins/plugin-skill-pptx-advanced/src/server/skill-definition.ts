/**
 * Advanced PPTX Export skill definition.
 *
 * Converts SVG slide content to a professional PPTX presentation
 * with native editable DrawingML shapes. Uses the svg_to_pptx package
 * bundled with plugin-skill-hub.
 */

const PPTX_ADVANCED_TEMPLATE = `import os, json, tempfile
from pathlib import Path

title_raw = '''{{title}}'''
title = json.loads(title_raw) if title_raw.startswith('"') else title_raw

slides_raw = '''{{slides_svg}}'''
import re
slides_svg = []
if slides_raw and slides_raw.strip() and slides_raw != '{{' + 'slides_svg}}':
    try:
        parsed = json.loads(slides_raw)
        if isinstance(parsed, list):
            slides_svg = parsed
        elif isinstance(parsed, str):
            slides_svg = re.findall(r'<svg[^>]*>.*?</svg>', parsed, re.IGNORECASE | re.DOTALL)
    except Exception:
        slides_svg = re.findall(r'<svg[^>]*>.*?</svg>', slides_raw, re.IGNORECASE | re.DOTALL)
    if not slides_svg:
        # Fallback if no full SVG matches, maybe the LLM forgot to escape something
        slides_svg = re.findall(r'<svg[^>]*>.*?</svg>', slides_raw, re.IGNORECASE | re.DOTALL)

canvas_raw = '''{{canvas_format}}'''
canvas_format = canvas_raw if canvas_raw != '{{' + 'canvas_format}}' else 'ppt169'

notes_raw = '''{{notes}}'''
notes = json.loads(notes_raw) if notes_raw and notes_raw != '{{' + 'notes}}' else {}

transition_raw = '''{{transition}}'''
transition = transition_raw if transition_raw != '{{' + 'transition}}' else 'fade'
if transition == 'none':
    transition = None

# Write SVG files to temp directory
work_dir = Path(tempfile.mkdtemp())
svg_dir = work_dir / 'svg_output'
svg_dir.mkdir()

if not slides_svg:
    print('Warning: No slides provided (slides_svg is empty). Cannot generate presentation.')
    import sys
    sys.exit(1)

import re

def sanitize_svg(content, idx):
    # Remove XML prolog if any
    content = re.sub(r'<\\?xml.*?\\?>', '', content)
    
    # 1. Extract <svg ... </svg>
    match = re.search(r'<svg[^>]*>.*</svg>', content, re.IGNORECASE | re.DOTALL)
    if match:
        content = match.group(0)
    else:
        match_start = re.search(r'<svg[^>]*>', content, re.IGNORECASE)
        if match_start:
            content = content[match_start.start():] + '</svg>'
            
    # 2. Escape ampersands not already escaped
    content = re.sub(r'&(?![A-Za-z0-9#]+;)', '&amp;', content)
    
    # 3. Fix unclosed void elements (rect, circle, etc. to self-closing)
    void_tags = ['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'image', 'use']
    for tag in void_tags:
        content = re.sub(r'(<' + tag + r'\\b[^>]*?)(?<!/)>', r'\\1/>', content, flags=re.IGNORECASE)
        content = re.sub(r'</' + tag + r'\\s*>', '', content, flags=re.IGNORECASE)
        
    # 4. Balance common container tags
    for tag in ['g', 'text', 'tspan', 'defs', 'clipPath']:
        open_count = len(re.findall(r'<' + tag + r'\\b[^>]*?(?<!/)>', content, flags=re.IGNORECASE))
        close_count = len(re.findall(r'</' + tag + r'\\s*>', content, flags=re.IGNORECASE))
        if open_count > close_count:
            closing_tags = f'</{tag}>' * (open_count - close_count)
            content = re.sub(r'</svg>\\s*$', f'{closing_tags}</svg>', content, flags=re.IGNORECASE)

    # 5. Validate XML
    import xml.etree.ElementTree as ET
    try:
        ET.fromstring(content)
    except ET.ParseError as e:
        print(f"Warning: Slide {idx} still has XML parsing issues after auto-fix: {e}")
        
    return content

svg_files = []
for i, svg_content in enumerate(slides_svg, 1):
    # Auto fix and validate
    svg_content = sanitize_svg(svg_content, i)
    
    # Auto margin to prevent overflow (scale down 10% and center)
    match = re.search(r'(<svg[^>]*>)', svg_content, re.IGNORECASE)
    if match:
        svg_tag = match.group(1)
        inner = svg_content[match.end():]
        inner = re.sub(r'</svg>\\s*$', '', inner, flags=re.IGNORECASE)
        # Assuming 1280x720 standard canvas, scale 0.9 + translate 5% (64, 36)
        svg_content = f"{svg_tag}<g transform='translate(64, 36) scale(0.9)'>{inner}</g></svg>"

    svg_path = svg_dir / f'{i:02d}_slide.svg'
    svg_path.write_text(svg_content, encoding='utf-8')
    svg_files.append(svg_path)

# Map notes from index-based keys to filename stems
notes_mapped = {}
if notes:
    for key, value in notes.items():
        idx = int(key) + 1
        notes_mapped[f'{idx:02d}_slide'] = value

# Convert SVG to PPTX with native DrawingML shapes
from svg_to_pptx import create_pptx_with_native_svg

output_dir = os.environ.get('OUTPUT_DIR', '/output')
safe_title = ''.join(c if c.isalnum() or c in ' _-' else '_' for c in title).strip()
output_path = Path(output_dir) / f'{safe_title}.pptx'

success = create_pptx_with_native_svg(
    svg_files=svg_files,
    output_path=output_path,
    canvas_format=canvas_format,
    use_native_shapes=True,
    verbose=True,
    transition=transition,
    transition_duration=0.4,
    notes=notes_mapped if notes_mapped else None,
    enable_notes=bool(notes_mapped),
)

if success:
    print(f'Generated: {safe_title}.pptx')
else:
    print('Warning: Some slides may have failed conversion')
    print(f'Generated: {safe_title}.pptx')
`;

export const PPTX_ADVANCED_SKILL = {
  name: 'pptx-advanced-export',
  title: 'Advanced PPTX Export (SVG → Native Shapes)',
  description:
    'Convert SVG slide content to a professional PPTX presentation with native editable DrawingML shapes. ' +
    'IMPORTANT FOR AI: You MUST NOT call this tool with an empty input or guess the schema. ' +
    'You MUST generate the raw SVG code yourself and pass it in the `slides_svg` array/string property. ' +
    'Do NOT say you lack the capability to create SVGs—you are fully capable of writing raw SVG XML text code. ' +
    'Use standard SVG tags (<svg viewBox="0 0 1280 720">, <rect>, <text>, <path>) to design each slide creatively before calling this tool. ' +
    'SVG elements are converted to native PowerPoint shapes (editable text, paths, images). ' +
    'Supports speaker notes, slide transitions, and multiple canvas formats (16:9, 4:3, A4, etc.).',
  language: 'python' as const,
  codeTemplate: PPTX_ADVANCED_TEMPLATE,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Presentation title (used for filename)' },
      slides_svg: {
        type: 'string',
        description:
          'ALL SVG slide content joined together as a SINGLE string. You MUST output ALL slides\' raw SVG code directly here, one after another (e.g. <svg>...</svg><svg>...</svg>). ' +
          'Each SVG should use viewBox="0 0 1280 720" for 16:9 format. Auto-margin is applied internally. ' +
          'CRITICAL JSON ENCODING: Because you are passing raw XML inside a JSON string, you MUST use single quotes (\') instead of double quotes (\") for all SVG attributes (e.g. <rect fill=\'red\'>). ' +
          'If you must use double quotes, they MUST be escaped properly like \\\". Newlines inside the SVG must be escaped as \\n or removed. Failure to follow this will break the JSON parser.',
      },
      canvas_format: {
        type: 'string',
        enum: ['ppt169', 'ppt43', 'a4', 'banner', 'moments'],
        description: 'Canvas format (default: ppt169 = 16:9)',
      },
      notes: {
        type: 'object',
        description: 'Optional speaker notes: keys are slide indices (0-based), values are markdown text',
      },
      transition: {
        type: 'string',
        enum: ['fade', 'push', 'wipe', 'none'],
        description: 'Slide transition effect (default: fade)',
      },
    },
    required: ['title', 'slides_svg'],
  },
  packages: ['python-pptx'],
  timeoutSeconds: 120,
  maxOutputSizeMb: 100,
  enabled: true,
  toolScope: 'CUSTOM',
};
