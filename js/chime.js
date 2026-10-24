// A short synthesized bell chime (Web Audio, no audio files). Browsers only
// allow sound after the user interacts, so call unlock() from a click or tap
// (e.g. when the timer is started) and play() later when the timer ends.

let ctx = null;

export function unlock() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  try {
    ctx ??= new AudioCtx();
    if (ctx.state === "suspended") ctx.resume();
  } catch {
    ctx = null;
  }
}

function bell(freq, start, duration = 1.6, volume = 0.35) {
  // Fundamental plus an inharmonic partial gives a bell-like tone.
  for (const [mult, gain] of [
    [1, volume],
    [2.76, volume * 0.25],
  ]) {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq * mult;
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(gain, start + 0.01);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(amp).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.05);
  }
}

/** Three rising notes (E5, G#5, B5). Returns false if sound isn't available. */
export function play() {
  if (!ctx) unlock();
  if (!ctx) return false;
  if (ctx.state === "suspended") ctx.resume();
  const t = ctx.currentTime + 0.05;
  bell(659.25, t);
  bell(830.61, t + 0.22);
  bell(987.77, t + 0.44, 2.2);
  return true;
}
