"""Convert a Claude Docs read of the Running Plan tab into plain HTML for the app.

Input: either the raw XML (<doc>...</doc>), or the saved JSON result of a Claude Docs
`read` of the tab's node (it holds the XML under data.xml).
Usage: python3 -I tools/xml_to_html.py READ_RESULT > /scratch/plan.html

PRIVACY: write the output outside this repository. It is the plan.
"""
import html, json, sys
import xml.etree.ElementTree as ET

def inline(el):
    out = []
    for t in el:
        if t.tag == 'text':
            s = html.escape(''.join(t.itertext()))
            if t.find('bold') is not None:
                s = '<strong>' + s + '</strong>'
            out.append(s)
    return ''.join(out)

def block(el):
    if el.tag == 'paragraph':
        h = el.get('heading')
        tag = 'h' + h if h else 'p'
        return f'<{tag}>{inline(el)}</{tag}>'
    if el.tag == 'list':
        tag = 'ol' if el.get('kind') == 'ordered' else 'ul'
        items = ''.join('<li>' + ''.join(block(c) for c in li) + '</li>' for li in el)
        return f'<{tag}>{items}</{tag}>'
    if el.tag == 'table':
        rows = []
        for r in el:
            cells = []
            for c in r:
                t = 'th' if c.get('header') == 'true' else 'td'
                cells.append(f'<{t}>' + ' '.join(inline(p) for p in c) + f'</{t}>')
            rows.append('<tr>' + ''.join(cells) + '</tr>')
        return '<table>' + ''.join(rows) + '</table>'
    if el.tag == 'horizontalRule':
        return '<hr>'
    return ''

raw = open(sys.argv[1], encoding='utf-8').read()
if not raw.lstrip().startswith('<'):
    j = json.loads(raw)
    while isinstance(j, dict) and 'xml' not in j:
        j = j.get('data') or j.get('value') or {}
    raw = j['xml']
root = ET.fromstring(raw)
print('<!doctype html><meta charset="utf-8"><title>Running Plan</title>')
print('\n'.join(block(c) for c in root))
