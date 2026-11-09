import json, os, sys, numpy as np, soundfile as sf
# python tts.py <video dir> [--all]
# By default a line whose text is unchanged since the last run keeps its WAV
# (even if its index moved); only new or edited lines are synthesised. --all redoes every line.
V = sys.argv[1]
ALL = '--all' in sys.argv[2:]
SR = 24000
script = json.load(open(f'{V}/script.json'))
old = {}
if not ALL and os.path.exists(f'{V}/vo.json'):
    for s in json.load(open(f'{V}/vo.json')):
        for l in s['lines']:
            if os.path.exists(l['file']):
                old[l['text']] = sf.read(l['file'], dtype='float32')[0]  # load before anything is overwritten
p = None
out = []
for s in script:
    lines = []
    for i, text in enumerate(s['lines']):
        if text in old:
            a, how = old[text], 'kept'
        else:
            if p is None:
                from kokoro import KPipeline
                p = KPipeline(lang_code='a')
            chunks = [a.numpy() if hasattr(a, 'numpy') else a for _, _, a in p(text, voice='af_heart', speed=0.97)]
            a = np.concatenate(chunks).astype(np.float32)
            # trim leading/trailing near-silence
            nz = np.where(np.abs(a) > 0.008)[0]
            a = a[max(0, nz[0] - 600): nz[-1] + 1200] if len(nz) else a
            how = 'new'
        path = f'{V}/vo/{s["id"]}_{i}.wav'
        sf.write(path, a, SR)
        lines.append({'text': text, 'file': path, 'dur': round(len(a) / SR, 3)})
        print(s['id'], i, round(len(a) / SR, 2), how, flush=True)
    out.append({**s, 'lines': lines})
json.dump(out, open(f'{V}/vo.json', 'w'), indent=1)
keep = {l['file'] for s in out for l in s['lines']}
for f in os.listdir(f'{V}/vo'):
    if f.endswith('.wav') and f'{V}/vo/{f}' not in keep:
        os.remove(f'{V}/vo/{f}')  # lines that were cut
