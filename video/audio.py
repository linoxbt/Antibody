"""
Sound for the Antibody demo: original sound design + an original score, mixed
under the af_heart voiceover. Everything here is synthesised from scratch
(royalty-free, owned outright). 48 kHz stereo.

  python audio.py <video dir>   ->  vo.wav, music.wav, sfx.wav, mix.wav
"""
import json, sys, math
import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt, fftconvolve, resample_poly, sawtooth

V = sys.argv[1]
SR = 48000
TL = json.load(open(f'{V}/timeline.json'))
CUES = json.load(open(f'{V}/cues.json'))
DUR = TL['duration'] + 0.5
N = int(DUR * SR)
rng = np.random.default_rng(42)


def t_(sec):
    return np.arange(int(sec * SR)) / SR


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], 'band', fs=SR, output='sos'), x)


def lp(x, f, order=2):
    return sosfilt(butter(order, f, 'low', fs=SR, output='sos'), x)


def hp(x, f, order=2):
    return sosfilt(butter(order, f, 'high', fs=SR, output='sos'), x)


def env_ad(n, a, d, curve=4.0):
    """attack (s) linear, decay exponential-ish to the end"""
    e = np.ones(n)
    na = max(1, int(a * SR))
    e[:na] = np.linspace(0, 1, na)
    rest = n - na
    if rest > 0:
        e[na:] = np.exp(-curve * np.linspace(0, 1, rest) * (1 if d <= 0 else (rest / SR) / d))
    return e


def svf_sweep(x, f0, f1, q=2.5, shape=None):
    """State-variable band-pass with a swept centre (per-sample, numpy loop)."""
    n = len(x)
    k = np.linspace(0, 1, n) if shape is None else shape
    fc = f0 * (f1 / f0) ** k
    g = np.tan(np.pi * np.clip(fc, 20, SR * 0.45) / SR)
    r = 1 / q
    y = np.zeros(n)
    s1 = s2 = 0.0
    for i in range(n):
        gi = g[i]
        hp_ = (x[i] - (r + gi) * s1 - s2) / (1 + r * gi + gi * gi)
        bp_ = gi * hp_ + s1
        lp_ = gi * bp_ + s2
        s1 = gi * hp_ + bp_
        s2 = gi * bp_ + lp_
        y[i] = bp_
    return y


def pan(mono, p):
    """p in [-1, 1] (scalar or array): equal-power stereo"""
    a = (np.asarray(p) + 1) * np.pi / 4
    return np.stack([mono * np.cos(a), mono * np.sin(a)], axis=1)


def make_ir(sec=2.6, decay=3.2, bright=6000):
    n = int(sec * SR)
    tt = np.arange(n) / SR
    ir = np.stack([rng.standard_normal(n), rng.standard_normal(n)], 1) * np.exp(-decay * tt)[:, None]
    ir[:, 0] = lp(ir[:, 0], bright)
    ir[:, 1] = lp(ir[:, 1], bright)
    ir[: int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))[:, None]
    return ir / np.sqrt((ir ** 2).sum(0, keepdims=True))


IR_HALL = make_ir(3.2, 2.4, 7000)
IR_ROOM = make_ir(1.0, 6.0, 9000)


def verb(st, ir, wet):
    out = np.stack([fftconvolve(st[:, 0], ir[:, 0])[: len(st) + len(ir) - 1], fftconvolve(st[:, 1], ir[:, 1])[: len(st) + len(ir) - 1]], 1)
    dry = np.zeros_like(out)
    dry[: len(st)] = st
    return dry * (1 - wet * 0.4) + out * wet


def norm(x, peak=0.9):
    m = np.max(np.abs(x)) or 1
    return x / m * peak


# ---------------------------------------------------------------- sound design
def s_boom():
    tt = t_(2.4)
    f = 32 + 70 * np.exp(-tt * 3.2)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-tt * 1.6)
    sub = np.sin(2 * np.pi * 34 * tt) * np.exp(-tt * 1.1) * 0.6
    crack = lp(rng.standard_normal(len(tt)), 300) * np.exp(-tt * 9) * 0.8
    m = np.tanh((body + sub + crack) * 1.6)
    return verb(pan(m, 0), IR_HALL, 0.35)


def s_riser(sec=3.0):
    tt = t_(sec)
    k = tt / sec
    n = svf_sweep(rng.standard_normal(len(tt)), 250, 7000, 3.0, k ** 1.6) * (k ** 2.2)
    tone = sum(sawtooth(2 * np.pi * (110 * 2 ** (2 * k)) * tt * (1 + d)) for d in (-0.004, 0, 0.005)) / 3
    tone = lp(tone, 3000) * k ** 3 * 0.25
    st = np.stack([n + tone, svf_sweep(rng.standard_normal(len(tt)), 260, 7200, 3.0, k ** 1.6) * k ** 2.2 + tone], 1)
    return verb(st, IR_HALL, 0.3)


def s_whoosh(sec=0.85, f0=350, f1=3200, hi=False):
    tt = t_(sec)
    k = tt / sec
    shape = np.sin(np.pi * k) ** 1.5
    sweep = 0.5 - 0.5 * np.cos(np.pi * k)
    x = svf_sweep(rng.standard_normal(len(tt)), f0, f1, 1.6, sweep) * shape
    if hi:
        x = hp(x, 900)
    return verb(pan(x, -0.7 + 1.4 * k), IR_ROOM, 0.25)


def s_impact():
    tt = t_(1.6)
    f = 42 + 110 * np.exp(-tt * 22)
    kick = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 4.5)
    trans = hp(rng.standard_normal(len(tt)), 1800) * np.exp(-tt * 70) * 0.5
    thud = lp(rng.standard_normal(len(tt)), 160) * np.exp(-tt * 10) * 0.9
    m = np.tanh((kick * 1.2 + trans + thud) * 1.4)
    return verb(pan(m, 0), IR_HALL, 0.28)


def s_glitch():
    out = np.zeros(int(0.42 * SR))
    pos = 0
    while pos < len(out) - 800:
        ln = min(int(rng.uniform(0.012, 0.045) * SR), len(out) - pos)
        f = rng.choice([180, 330, 520, 880, 1400, 2600])
        seg = np.sign(np.sin(2 * np.pi * f * np.arange(ln) / SR)) * 0.5 + rng.standard_normal(ln) * 0.4
        seg = np.round(seg * 6) / 6  # bit crush
        seg = np.repeat(seg[:: rng.integers(2, 6)], rng.integers(2, 6))[:ln]
        seg = np.pad(seg, (0, max(0, ln - len(seg))))
        out[pos: pos + ln] += seg * rng.uniform(0.4, 1)
        pos += ln + int(rng.uniform(0, 0.02) * SR)
    out = bp(out, 150, 7000) * 0.7
    return np.stack([out, np.roll(out, 90)], 1)


def s_pop():
    tt = t_(0.18)
    f = 950 * np.exp(-tt * 18) + 380
    m = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 38)
    m += hp(rng.standard_normal(len(tt)), 3000) * np.exp(-tt * 300) * 0.25
    return verb(pan(m * 0.8, rng.uniform(-0.4, 0.4)), IR_ROOM, 0.25)


def s_tick():
    tt = t_(0.06)
    m = bp(rng.standard_normal(len(tt)), 2500, 7000) * np.exp(-tt * 160)
    m += np.sin(2 * np.pi * 2400 * tt) * np.exp(-tt * 120) * 0.4
    return verb(pan(m, rng.uniform(-0.3, 0.3)), IR_ROOM, 0.18)


def s_click():
    out = np.zeros(int(0.12 * SR))
    for off, f in ((0, 1800), (0.035, 1300)):
        tt = t_(0.03)
        c = bp(rng.standard_normal(len(tt)), f * 0.6, f * 2.2) * np.exp(-tt * 260)
        i = int(off * SR)
        out[i: i + len(c)] += c
    return pan(out, 0.1)


def s_typing(sec):
    out = np.zeros(int(sec * SR) + SR // 5)
    t = 0.0
    while t < sec:
        tt = t_(0.035)
        f = rng.uniform(1500, 3800)
        c = bp(rng.standard_normal(len(tt)), f * 0.5, min(f * 1.8, 20000)) * np.exp(-tt * 190) * rng.uniform(0.5, 1)
        c += lp(rng.standard_normal(len(tt)), 400) * np.exp(-tt * 120) * 0.3
        i = int(t * SR)
        out[i: i + len(c)] += c
        t += rng.uniform(0.045, 0.11) * (2.5 if rng.random() < 0.08 else 1)
    return verb(pan(out * 0.8, 0.15), IR_ROOM, 0.15)


def s_stamp():
    tt = t_(0.5)
    thud = np.sin(2 * np.pi * np.cumsum(70 + 60 * np.exp(-tt * 30)) / SR) * np.exp(-tt * 14)
    slap = bp(rng.standard_normal(len(tt)), 900, 4500) * np.exp(-tt * 55) * 0.7
    return verb(pan(np.tanh((thud + slap) * 1.8), 0), IR_ROOM, 0.3)


def s_alarm():
    out = np.zeros(int(0.8 * SR))
    for j, (f, off) in enumerate(((988, 0), (740, 0.16), (988, 0.32))):
        tt = t_(0.13)
        tone = (np.sign(np.sin(2 * np.pi * f * tt)) * 0.4 + np.sin(2 * np.pi * f * tt) * 0.6) * np.minimum(1, (0.13 - tt) * 40) * np.minimum(1, tt * 200)
        i = int(off * SR)
        out[i: i + len(tone)] += lp(tone, 4000)
    return verb(pan(out * 0.55, 0), IR_HALL, 0.25)


def s_denied():
    tt = t_(0.7)
    buzz = (sawtooth(2 * np.pi * 98 * tt) + sawtooth(2 * np.pi * 103.5 * tt)) * 0.5
    buzz = lp(buzz, 1800) * (0.7 + 0.3 * np.sign(np.sin(2 * np.pi * 14 * tt))) * env_ad(len(tt), 0.01, 0.6, 2.5)
    two = np.zeros(len(tt))
    for f, off in ((330, 0), (247, 0.14)):
        x = t_(0.16)
        i = int(off * SR)
        two[i: i + len(x)] += np.sin(2 * np.pi * f * x) * np.exp(-x * 12) * 0.5
    return verb(pan(np.tanh((buzz + two) * 1.3) * 0.8, 0), IR_ROOM, 0.25)


def s_reverse(sec=1.7):
    tt = t_(sec)
    x = hp(rng.standard_normal(len(tt)), 2500) * np.exp(-tt * 3.0)
    x += bp(rng.standard_normal(len(tt)), 400, 2000) * np.exp(-tt * 4) * 0.4
    st = verb(np.stack([x, np.roll(x, 300)], 1), IR_HALL, 0.6)[: len(tt)]
    out = st[::-1] * np.linspace(0.2, 1, len(tt))[:, None]
    f = int(0.004 * SR)
    out[-f:] *= np.linspace(1, 0, f)[:, None]  # no click at the hand-off to the impact
    return out


def s_shimmer():
    out = np.zeros((int(1.8 * SR), 2))
    for _ in range(26):
        f = rng.uniform(2200, 6400)
        off = rng.uniform(0, 1.1)
        tt = t_(0.4)
        p = np.sin(2 * np.pi * f * tt) * np.exp(-tt * rng.uniform(8, 16)) * rng.uniform(0.2, 0.6)
        i = int(off * SR)
        out[i: i + len(tt)] += pan(p, rng.uniform(-0.9, 0.9))
    return verb(out * 0.5, IR_HALL, 0.5)


def bell(f, sec=2.5, ratio=3.5, idx=2.2):
    tt = t_(sec)
    e = np.exp(-tt * 2.2)
    mod = np.sin(2 * np.pi * f * ratio * tt) * idx * np.exp(-tt * 5)
    return np.sin(2 * np.pi * f * tt + mod) * e


def s_chime():
    m = bell(880) * 0.5 + bell(1318.5, ratio=2.0, idx=1.4) * 0.3
    return verb(pan(m, 0), IR_HALL, 0.45)


def s_success():
    out = np.zeros(int(2.4 * SR))
    for j, f in enumerate((1046.5, 1318.5, 1568.0, 2093.0)):
        b = bell(f, 1.8, 2.0, 1.2) * (0.45 - j * 0.05)
        i = int(j * 0.085 * SR)
        out[i: i + len(b)] += b
    return verb(pan(out, 0), IR_HALL, 0.4)


def s_blip():
    tt = t_(0.14)
    f = 900 * 2 ** (tt * 10)
    m = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 26) * np.minimum(1, tt * 400)
    return verb(pan(m * 0.6, rng.uniform(-0.5, 0.5)), IR_ROOM, 0.3)


def s_sweep():
    tt = t_(1.1)
    k = tt / 1.1
    tone = np.sin(2 * np.pi * np.cumsum(2400 * (1 - k) ** 2 + 120) / SR) * np.sin(np.pi * k) * 0.35
    n = svf_sweep(rng.standard_normal(len(tt)), 6000, 300, 2.0, k) * np.sin(np.pi * k) ** 0.8
    return verb(pan(tone + n, -0.6 + 1.2 * k), IR_HALL, 0.35)


def s_lock():
    out = np.zeros(int(0.5 * SR))
    for off, f, a in ((0, 3200, 1), (0.075, 2100, 0.8)):
        tt = t_(0.09)
        c = bp(rng.standard_normal(len(tt)), f * 0.6, f * 1.6) * np.exp(-tt * 140) + np.sin(2 * np.pi * f * tt) * np.exp(-tt * 70) * 0.3
        i = int(off * SR)
        out[i: i + len(tt)] += c * a
    tt = t_(0.3)
    out[int(0.075 * SR): int(0.075 * SR) + len(tt)] += np.sin(2 * np.pi * np.cumsum(60 + 80 * np.exp(-tt * 40)) / SR) * np.exp(-tt * 18) * 0.7
    return verb(pan(out, 0), IR_ROOM, 0.3)


def s_shield():
    tt = t_(2.0)
    vw = np.sin(2 * np.pi * np.cumsum(180 + 40 * np.sin(2 * np.pi * 7 * tt) * np.exp(-tt * 2)) / SR) * np.exp(-tt * 2.2) * 0.6
    vw += bp(rng.standard_normal(len(tt)), 300, 2400) * np.exp(-tt * 6) * 0.3
    imp = s_impact()[: len(tt), 0]
    m = np.tanh((vw + imp * 0.8) * 1.3)
    st = verb(pan(m, 0), IR_HALL, 0.35)
    sh = s_shimmer()
    st[: len(sh)] += sh * 0.5
    return st


def s_data(sec):
    out = np.zeros(int(sec * SR) + SR // 10)
    t = 0.0
    while t < sec:
        tt = t_(0.02)
        f = rng.choice([1200, 1500, 1800, 2400, 3000, 3600])
        c = np.sign(np.sin(2 * np.pi * f * tt)) * np.exp(-tt * 120) * 0.25
        i = int(t * SR)
        out[i: i + len(c)] += c
        t += rng.uniform(0.025, 0.06)
    return verb(pan(lp(out, 6000), rng.uniform(-0.3, 0.3)), IR_ROOM, 0.2)


def make_sfx(kind):
    k, _, arg = kind.partition(':')
    return {
        'boom': s_boom, 'riser': lambda: s_riser(3.0), 'whoosh': s_whoosh, 'swipe': lambda: s_whoosh(0.42, 900, 5200, True), 'impact': s_impact, 'glitch': s_glitch,
        'pop': s_pop, 'tick': s_tick, 'click': s_click, 'typing': lambda: s_typing(float(arg or 1)), 'stamp': s_stamp, 'alarm': s_alarm, 'denied': s_denied,
        'reverse': s_reverse, 'shimmer': s_shimmer, 'chime': s_chime, 'success': s_success, 'blip': s_blip, 'sweep': s_sweep, 'lock': s_lock, 'shield': s_shield,
        'data': lambda: s_data(float(arg or 1)),
    }[k]()


# ---------------------------------------------------------------- score
BPM = 100
BEAT = 60 / BPM
BAR = BEAT * 4
NOTE = {n: i for i, n in enumerate(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'])}


def hz(name):  # e.g. "D3"
    n, o = name[:-1], int(name[-1])
    return 440 * 2 ** ((NOTE[n] + 12 * (o + 1) - 69) / 12)


CH = {
    'Dm': ['D3', 'F3', 'A3', 'D4'], 'Bb': ['A#2', 'D3', 'F3', 'A#3'], 'F': ['F2', 'A2', 'C3', 'F3'], 'C': ['C3', 'E3', 'G3', 'C4'],
    'Gm': ['G2', 'A#2', 'D3', 'G3'], 'A': ['A2', 'C#3', 'E3', 'A3'], 'Dsus': ['D3', 'G3', 'A3', 'D4'], 'D': ['D3', 'F#3', 'A3', 'D4'],
}
ROOT = {'Dm': 'D2', 'Bb': 'A#1', 'F': 'F1', 'C': 'C2', 'Gm': 'G1', 'A': 'A1', 'Dsus': 'D2', 'D': 'D2'}


def sc(id_):
    return next(s for s in TL['scenes'] if s['id'] == id_)


# sections: (start, end, chords per bar, pad level, arp level, drums level, bass level, arp density)
SECTIONS = [
    (0.0, sc('threat')['start'], ['Dm', 'Dm', 'Bb', 'Bb'], 0.55, 0.0, 0.0, 0.35, 0),
    (sc('threat')['start'], sc('threat')['lines'][3]['start'] - 0.2, ['Dm', 'Bb', 'Gm', 'A'], 0.55, 0.25, 0.25, 0.55, 8),
    (sc('threat')['lines'][3]['start'] - 0.2, sc('reveal')['start'] + 0.5, ['Dm'], 0.35, 0.0, 0.0, 0.3, 0),
    (sc('reveal')['start'] + 0.5, sc('lanes')['start'], ['F', 'C', 'Dm', 'Bb'], 0.85, 0.15, 0.0, 0.5, 4),
    (sc('lanes')['start'], sc('attack')['start'], ['Dm', 'Bb', 'F', 'C'], 0.6, 0.45, 0.45, 0.6, 8),
    (sc('attack')['start'], sc('blast')['lines'][1]['start'] + 0.7, ['Dm', 'Dm', 'Bb', 'A'], 0.6, 0.55, 0.6, 0.75, 16),
    (sc('blast')['lines'][1]['start'] + 0.7, sc('learn')['start'], ['Gm', 'Bb', 'F', 'C'], 0.65, 0.25, 0.2, 0.5, 8),
    (sc('learn')['start'], sc('mainnet')['start'], ['Bb', 'F', 'C', 'Dm'], 0.6, 0.45, 0.45, 0.6, 8),
    (sc('mainnet')['start'], sc('close')['start'], ['F', 'C', 'Dm', 'Bb'], 0.75, 0.55, 0.65, 0.75, 16),
    (sc('close')['start'], DUR, ['Bb', 'F', 'Dsus', 'D'], 0.8, 0.12, 0.0, 0.45, 4),
]


def pad_note(f, sec, att=0.6, rel=1.2):
    tt = t_(sec + rel)
    e = np.minimum(1, tt / att) * np.where(tt > sec, np.exp(-(tt - sec) * 3.5 / rel), 1)
    L = sum(sawtooth(2 * np.pi * f * (1 + d) * tt + rng.uniform(0, 6)) for d in (-0.006, 0.0007, 0.0045))
    R = sum(sawtooth(2 * np.pi * f * (1 + d) * tt + rng.uniform(0, 6)) for d in (-0.004, -0.0005, 0.0062))
    return np.stack([L, R], 1) * e[:, None] / 3


def pluck(f, sec=0.5):
    tt = t_(sec)
    m = (np.sin(2 * np.pi * f * tt) + 0.5 * np.sin(4 * np.pi * f * tt) * np.exp(-tt * 9) + 0.25 * np.sin(6 * np.pi * f * tt) * np.exp(-tt * 14)) * np.exp(-tt * 7) * np.minimum(1, tt * 600)
    return m


def kick():
    tt = t_(0.5)
    return np.tanh(np.sin(2 * np.pi * np.cumsum(45 + 120 * np.exp(-tt * 28)) / SR) * np.exp(-tt * 7) * 1.6)


def hat(open_=False):
    tt = t_(0.18 if open_ else 0.05)
    return hp(rng.standard_normal(len(tt)), 7000) * np.exp(-tt * (25 if open_ else 110))


def clap():
    tt = t_(0.35)
    n = bp(rng.standard_normal(len(tt)), 900, 5000)
    e = np.exp(-tt * 22) + 0.6 * np.exp(-np.maximum(0, tt - 0.012) * 30) * (tt > 0.012) + 0.4 * np.exp(-np.maximum(0, tt - 0.024) * 30) * (tt > 0.024)
    return n * e


def add(buf, x, t0, g=1.0):
    i = int(t0 * SR)
    if i >= len(buf):
        return
    if x.ndim == 1:
        x = np.stack([x, x], 1)
    j = min(len(buf), i + len(x))
    buf[i:j] += x[: j - i] * g


def make_music():
    pad = np.zeros((N, 2))
    arp = np.zeros((N, 2))
    drums = np.zeros((N, 2))
    bass = np.zeros((N, 2))
    for (a, b, chords, pl, al, dl, bl, dens) in SECTIONS:
        t = a
        bar = 0
        while t < b - 0.05:
            ch = chords[bar % len(chords)]
            sec = min(BAR, b - t)
            for nm in CH[ch][:3]:
                add(pad, pad_note(hz(nm), sec, att=0.5 if bar else 1.2, rel=1.4), t, pl * 0.16)
            add(pad, pad_note(hz(CH[ch][3]) * 2, sec, att=0.8, rel=1.4), t, pl * 0.05)
            # bass: root on 8ths with soft envelope
            r = hz(ROOT[ch])
            steps = 8 if bl > 0.4 else 2
            for k in range(steps):
                st = t + k * BAR / steps
                if st >= b:
                    break
                tt = t_(BAR / steps * 0.95)
                m = (np.sin(2 * np.pi * r * tt) + 0.3 * lp(sawtooth(2 * np.pi * r * tt), 400)) * np.minimum(1, tt * 80) * np.exp(-tt * (3 if steps > 2 else 0.6))
                add(bass, m, st, bl * 0.35)
            # arpeggio
            if dens and al > 0:
                notes = [hz(n) * 2 for n in CH[ch]]
                for k in range(dens):
                    st = t + k * BAR / dens
                    if st >= b:
                        break
                    f = notes[[0, 1, 2, 3, 2, 1][k % 6] % 4] * (2 if (k // 4) % 2 and dens >= 16 else 1)
                    add(arp, pan(pluck(f, 0.45), 0.35 * math.sin(k * 1.3)), st, al * 0.12)
            # drums
            if dl > 0:
                for k in range(16):
                    st = t + k * BEAT / 4
                    if st >= b:
                        break
                    if k in (0, 8) or (dl > 0.5 and k in (10,)):
                        add(drums, kick(), st, dl * 0.55)
                    if k in (4, 12) and dl > 0.3:
                        add(drums, pan(clap(), 0.05), st, dl * 0.16)
                    if k % 2 == 0:
                        add(drums, pan(hat(k % 8 == 6), 0.3), st, dl * (0.09 if k % 4 else 0.06))
            t += BAR
            bar += 1
    pad = np.stack([lp(pad[:, 0], 2400), lp(pad[:, 1], 2400)], 1)
    # tempo-synced delay on the arp (dotted 8th)
    d = int(BEAT * 0.75 * SR)
    for fb, g in ((1, 0.35), (2, 0.18), (3, 0.08)):
        arp[d * fb:, 0] += arp[: -d * fb, 1] * g
        arp[d * fb:, 1] += arp[: -d * fb, 0] * g
    music = pad + arp + drums + bass
    wet = verb(pad * 0.6 + arp * 0.7, IR_HALL, 0.55)[:N] - (pad * 0.6 + arp * 0.7) * (1 - 0.55 * 0.4)
    music = music + wet * 0.8
    # fades: open swell, threat drop before "Persistent memory…", end
    g = np.ones(N)
    tt = np.arange(N) / SR
    g *= np.minimum(1, tt / 2.5)
    g *= 1 - 0.9 * np.clip((tt - (DUR - 6)) / 6, 0, 1)
    return music * g[:, None]


# ---------------------------------------------------------------- voice
def make_vo():
    vo = np.zeros(N)
    for s in TL['scenes']:
        for l in s['lines']:
            a, sr = sf.read(l['file'])
            a = resample_poly(a, SR, sr) if sr != SR else a
            i = int(l['start'] * SR)
            vo[i: i + len(a)] += a[: max(0, N - i)]
    # light voice polish: high-pass rumble, gentle presence, soft compression
    vo = hp(vo, 80)
    pres = bp(vo, 2500, 6000)
    vo = vo + pres * 0.25
    env = np.sqrt(lp(vo ** 2, 12) + 1e-9)
    gain = np.where(env > 0.12, (0.12 / env) ** 0.45, 1)
    vo = vo * gain
    st = np.stack([vo, vo], 1)
    room = verb(st * 0.5, IR_ROOM, 0.12)[:N] - st * 0.5 * (1 - 0.12 * 0.4)
    return norm(st + room * 0.35, 0.9), vo


def main():
    print('voice…', flush=True)
    vo, vo_mono = make_vo()
    print('sfx…', flush=True)
    sfx = np.zeros((N, 2))
    for t, kind, g in CUES:
        x = make_sfx(kind)
        add(sfx, x, t, g)
    print('music…', flush=True)
    music = norm(make_music(), 0.9)
    # sidechain: duck the music under the voice (-8 dB), sfx slightly (-3 dB)
    env = np.abs(vo_mono)
    att, rel = np.exp(-1 / (0.02 * SR)), np.exp(-1 / (0.45 * SR))
    e = lp(env, 30)
    e = e / (np.percentile(e[e > 1e-4], 95) or 1)
    sm = np.zeros(N)
    acc = 0.0
    for i in range(0, N, 64):  # block-rate follower
        v = min(1.0, e[i])
        acc = att ** 64 * acc + (1 - att ** 64) * v if v > acc else rel ** 64 * acc + (1 - rel ** 64) * v
        sm[i: i + 64] = acc
    duck_m = 1 - 0.6 * np.clip(sm * 1.4, 0, 1)
    duck_s = 1 - 0.3 * np.clip(sm * 1.4, 0, 1)
    sf.write(f'{V}/vo.wav', vo, SR, subtype='PCM_24')
    sf.write(f'{V}/music.wav', music, SR, subtype='PCM_24')
    sf.write(f'{V}/sfx.wav', norm(sfx, 0.9), SR, subtype='PCM_24')
    mix = vo * 1.0 + music * 0.30 * duck_m[:, None] + norm(sfx, 0.9) * 0.55 * duck_s[:, None]
    mix = np.tanh(mix * 1.1) / np.tanh(1.1)  # soft clip safety
    sf.write(f'{V}/mix.wav', norm(mix, 0.95), SR, subtype='PCM_24')
    print('done', round(N / SR, 1), 's')


main()
