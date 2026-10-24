// A short, soft synthesized chime (Web Audio, no audio files). Browsers only
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

function tone(freq, start, duration = 1.4, volume = 0.12) {
  // A sine with a faint octave, a soft 40 ms fade-in and a long fade-out.
  for (const [mult, gain] of [
    [1, volume],
    [2, volume * 0.15],
  ]) {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq * mult;
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(gain, start + 0.04);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(amp).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.05);
  }
}

/** Two soft notes (D5, A5). Returns false if sound isn't available. */
export function play() {
  if (!ctx) unlock();
  if (!ctx) return false;
  if (ctx.state === "suspended") ctx.resume();
  const t = ctx.currentTime + 0.05;
  tone(587.33, t);
  tone(880, t + 0.28, 1.8);
  return true;
}
