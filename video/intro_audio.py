"""Teaser sound: trailer score at 120 BPM + sound design on the picture's cue sheet. No voice."""
import json, sys, math
import numpy as np, soundfile as sf
from scipy.signal import sawtooth
import sfxlib as L
from sfxlib import SR, rng, t_, lp, hp, bp, pan, verb, norm, add, IR_HALL, IR_ROOM, hz

V = sys.argv[1]
DUR = 44.0
N = int((DUR + 2.0) * SR)
BEAT = 0.5
BAR = 2.0
CUES = json.load(open(f'{V}/intro_cues.json'))


def braam(sec=4.0):
    """Trailer 'braam': stacked detuned saws (D1/D2/A2), a filter that opens then closes, distortion, hall."""
    tt = t_(sec)
    notes = [hz('D1'), hz('D2'), hz('A2'), hz('D3')]
    x = sum(sum(sawtooth(2 * np.pi * f * (1 + d) * tt + rng.uniform(0, 6)) for d in (-0.008, 0, 0.007)) for f in notes) / 12
    cut = 180 + 2600 * np.exp(-tt * 1.6) * np.minimum(1, tt * 30)
    y = np.zeros_like(x)
    # block-wise lowpass to follow the cutoff envelope
    blk = 1024
    for i in range(0, len(x), blk):
        y[i:i + blk] = lp(x[max(0, i - 2048):i + blk], float(cut[i]))[-len(x[i:i + blk]):]
    y = np.tanh(y * 3.0) * np.exp(-tt * 0.7) * np.minimum(1, tt * 60)
    sub = np.sin(2 * np.pi * hz('D1') * tt) * np.exp(-tt * 0.8) * 0.8
    st = np.stack([y + sub, np.roll(y, 240) + sub], 1)
    return verb(st, IR_HALL, 0.45)


def snare_roll(sec=2.0):
    out = np.zeros(int(sec * SR) + SR // 4)
    t = 0.0
    while t < sec:
        rate = 4 + 28 * (t / sec) ** 2
        tt = t_(0.08)
        h = bp(rng.standard_normal(len(tt)), 1200, 7000) * np.exp(-tt * 40) * (0.25 + 0.75 * t / sec)
        i = int(t * SR)
        out[i:i + len(h)] += h
        t += 1 / rate
    return verb(pan(out, 0), IR_ROOM, 0.3)


def tom(f=90):
    tt = t_(0.6)
    return np.tanh(np.sin(2 * np.pi * np.cumsum(f + 60 * np.exp(-tt * 18)) / SR) * np.exp(-tt * 6) * 1.5)


def pulse_bass(f, sec, steps=16, g=1.0):
    out = np.zeros(int(sec * SR) + 100)
    for k in range(int(steps * sec / BAR)):
        tt = t_(BAR / steps * 0.9)
        m = (sawtooth(2 * np.pi * f * tt) * 0.6 + np.sin(2 * np.pi * f * tt)) * np.exp(-tt * 9) * np.minimum(1, tt * 300)
        i = int(k * BAR / steps * SR)
        out[i:i + len(m)] += lp(m, 900) * (1 if k % 4 == 0 else 0.7)
    return out * g


PROG = ['Dm', 'Bb', 'F', 'C']


def score():
    mus = np.zeros((N, 2))
    # 0-8: drone + heartbeat + ticking (tension)
    tt = t_(10.5)
    drone = sum(sawtooth(2 * np.pi * hz(n) * (1 + d) * tt) for n in ('D2', 'A2') for d in (-0.005, 0.004)) / 4
    drone = lp(drone, 500) * np.minimum(1, tt / 3) * 0.5
    add(mus, verb(pan(drone, 0), IR_HALL, 0.4), 0.0, 0.5)
    for b in range(16):
        tb = b * BEAT
        if b % 2 == 0:
            add(mus, L.kick() * 0.7, tb, 0.35 if tb < 4 else 0.5)
        if tb >= 4:
            add(mus, pan(L.hat(), 0.4), tb, 0.08)
            add(mus, pan(L.hat(), -0.4), tb + BEAT / 2, 0.05)
    add(mus, snare_roll(2.0), 8.0, 0.5)
    # 10-30: the drop
    for bar in range(10):
        t0 = 10.0 + bar * BAR
        ch = PROG[bar % 4]
        for nm in L.CH[ch][:3]:
            add(mus, L.pad_note(hz(nm), BAR, att=0.05, rel=0.8), t0, 0.12)
        add(mus, pan(pulse_bass(hz(L.ROOT[ch]), BAR), 0), t0, 0.32)
        notes = [hz(n) * 2 for n in L.CH[ch]]
        for k in range(16):
            f = notes[[0, 2, 1, 3, 2, 1, 3, 2][k % 8]] * (2 if k % 8 >= 6 else 1)
            add(mus, pan(L.pluck(f, 0.3), 0.4 * math.sin(k)), t0 + k * BAR / 16, 0.08)
        for k in range(4):
            add(mus, L.kick(), t0 + k * BEAT, 0.6)
            add(mus, pan(L.hat(True), 0.3), t0 + k * BEAT + BEAT / 2, 0.07)
            if k in (1, 3):
                add(mus, pan(L.clap(), 0), t0 + k * BEAT, 0.22)
        if bar % 2 == 1:
            add(mus, pan(tom(110), -0.3), t0 + 1.5, 0.25); add(mus, pan(tom(85), 0.3), t0 + 1.75, 0.25)
    # 30.5-35.5: breakdown (pads + shimmering arp, no kick)
    for bar in range(3):
        t0 = 30.5 + bar * BAR
        ch = ['F', 'C', 'Dm'][bar]
        for nm in L.CH[ch]:
            add(mus, L.pad_note(hz(nm), BAR, att=0.4, rel=1.5), t0, 0.12)
        notes = [hz(n) * 4 for n in L.CH[ch]]
        for k in range(8):
            add(mus, pan(L.pluck(notes[k % 4], 0.6), 0.5 * math.sin(k * 2)), t0 + k * BAR / 8, 0.06)
        add(mus, pan(pulse_bass(hz(L.ROOT[ch]), BAR, 2, 0.6), 0), t0, 0.25)
    # 35.5-39.5: rebuild (kick + toms crescendo)
    for k in range(8):
        tb = 35.5 + k * BEAT
        add(mus, L.kick(), tb, 0.35 + 0.05 * k)
        if k >= 4:
            add(mus, pan(tom(100 - k * 3), 0.2 * (-1) ** k), tb + BEAT / 2, 0.2 + 0.03 * k)
    for bar in range(2):
        for nm in L.CH[['Bb', 'C'][bar]]:
            add(mus, L.pad_note(hz(nm), BAR, att=0.3, rel=1.0), 35.5 + bar * BAR, 0.11)
    add(mus, snare_roll(1.5), 38.0, 0.55)
    # 39.5: end — final chord rings out (D major lift)
    for nm in L.CH['D']:
        add(mus, L.pad_note(hz(nm), 3.0, att=0.02, rel=2.5), 39.5, 0.13)
    # arp delay + hall glue
    d = int(BEAT * 0.75 * SR)
    mus[d:] += mus[:-d][:, ::-1] * 0.12
    wet = verb(mus * 0.5, IR_HALL, 0.5)[:N] - mus * 0.5 * 0.8
    mus = mus + wet * 0.5
    g = np.ones(N); tt = np.arange(N) / SR
    g *= np.minimum(1, tt / 0.4)
    g *= 1 - np.clip((tt - (DUR - 2.5)) / 3.5, 0, 1)
    return mus * g[:, None]


def main():
    sfx = np.zeros((N, 2))
    for t, kind, gain in CUES:
        x = braam() if kind == 'braam' else L.make_sfx(kind)
        add(sfx, x, t, gain)
    mus = norm(score(), 0.9)
    sfx = norm(sfx, 0.9)
    mix = mus * 0.62 + sfx * 0.72
    # gentle bus compression + soft clip
    env = np.sqrt(lp(np.mean(mix ** 2, 1), 8) + 1e-9)
    gain = np.where(env > 0.25, (0.25 / env) ** 0.35, 1)
    mix = mix * gain[:, None]
    mix = np.tanh(mix * 1.2) / np.tanh(1.2)
    mix = np.stack([lp(mix[:, 0], 15000), lp(mix[:, 1], 15000)], 1)  # tame reverb hiss
    sf.write(f'{V}/intro_mix.wav', norm(mix, 0.95), SR, subtype='PCM_24')
    print('ok', round(len(mix) / SR, 1), 's')


main()
