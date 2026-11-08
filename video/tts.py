import json, sys, numpy as np, soundfile as sf
from kokoro import KPipeline
V = sys.argv[1]
SR = 24000
p = KPipeline(lang_code='a')
script = json.load(open(f'{V}/script.json'))
out = []
for s in script:
    lines = []
    for i, text in enumerate(s['lines']):
        chunks = [a.numpy() if hasattr(a, 'numpy') else a for _, _, a in p(text, voice='af_heart', speed=0.97)]
        a = np.concatenate(chunks).astype(np.float32)
        # trim leading/trailing near-silence
        nz = np.where(np.abs(a) > 0.008)[0]
        a = a[max(0, nz[0] - 600): nz[-1] + 1200] if len(nz) else a
        path = f'{V}/vo/{s["id"]}_{i}.wav'
        sf.write(path, a, SR)
        lines.append({'text': text, 'file': path, 'dur': round(len(a) / SR, 3)})
        print(s['id'], i, round(len(a) / SR, 2), flush=True)
    out.append({**s, 'lines': lines})
json.dump(out, open(f'{V}/vo.json', 'w'), indent=1)
