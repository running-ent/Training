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
                # Keep each paragraph of a cell separate: a day's cell holds labeled
                # lines (Plan:, Before:, Done:, Review: ...) that the app sorts out.
                cells.append(f'<{t}>' + ''.join(block(p) for p in c) + f'</{t}>')
            rows.append('<tr>' + ''.join(cells) + '</tr>')
        return '<table>' + ''.join(rows) + '</table>'
    if el.tag == 'horizontalRule':
        return '<hr>'
    return ''

raw = open(sys.argv[1], encoding='utf-8').read()
if not raw.lstrip().startswith('<'):
    j = json.loads(raw)
    while isinstance(j, dict) and 'xml' not in j and (j.get('data') or j.get('value')):
        j = j.get('data') or j.get('value')
    if not isinstance(j, dict) or not isinstance(j.get('xml'), str):
        sys.exit('xml_to_html: no doc XML found in this file (expected a Claude Docs read of the tab).')
    raw = j['xml']
root = ET.fromstring(raw)
print('<!doctype html><meta charset="utf-8"><title>Running Plan</title>')
print('\n'.join(block(c) for c in root))
