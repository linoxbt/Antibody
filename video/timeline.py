import json, sys, re
V = sys.argv[1]
vo = json.load(open(f'{V}/vo.json'))
GAP = 0.7
t = 3.4  # cold-open sting before the first word
scenes = []
for s in vo:
    start = t
    t += s['lead']
    lines = []
    for i, l in enumerate(s['lines']):
        caption = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', l['text']).replace('x four oh two', 'x402').replace('Forty Two', 'Fortytwo').replace('four hundred and fifty dollars', '$450')
        lines.append({'text': caption, 'file': l['file'], 'start': round(t, 3), 'end': round(t + l['dur'], 3)})
        t += l['dur'] + (GAP if i < len(s['lines']) - 1 else 0)
    t += s['tail']
    scenes.append({'id': s['id'], 'start': round(start, 3), 'end': round(t, 3), 'lines': lines})
json.dump({'duration': round(t, 3), 'fps': 30, 'scenes': scenes}, open(f'{V}/timeline.json', 'w'), indent=1)
for s in scenes: print(f"{s['id']:8} {s['start']:7.2f} → {s['end']:7.2f}  ({s['end']-s['start']:.1f}s)")
print('total', round(t, 2), 's =', f'{int(t//60)}:{t%60:04.1f}')
