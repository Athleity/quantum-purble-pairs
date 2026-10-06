/**
 * Quantum Purble Pairs - Sound Effects Engine
 * 
 * Supports HTML5 Audio playback for sound files in the "sounds" folder:
 * - click.ogg, start.mp3, flip.ogg, match.ogg, wrong.ogg, land.ogg, win.mp3
 * 
 * Automatically falls back to synthesized Web Audio beeps if audio files
 * are missing or fail to load.
 */

(function (root) {
  'use strict';

  var soundEnabled = true;
  var SFX_FILES = {
    click: 'sounds/click.ogg',
    start: 'sounds/start.mp3',
    flip: 'sounds/flip.ogg',
    match: 'sounds/match.ogg',
    wrong: 'sounds/wrong.ogg',
    land: 'sounds/land.ogg',
    win: 'sounds/win.mp3'
  };

  var audioCtx = null;

  function fallbackBeep(name) {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      var t = audioCtx.currentTime;
      var osc = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      osc.connect(g);
      g.connect(audioCtx.destination);

      var freqs = { click: 800, start: 520, flip: 440, match: 660, wrong: 180, land: 920, win: 880 };
      var durs = { click: 0.04, start: 0.25, flip: 0.08, match: 0.3, wrong: 0.25, land: 0.12, win: 0.5 };
      var f = freqs[name] || 440;
      var d = durs[name] || 0.1;

      osc.type = name === 'wrong' ? 'sawtooth' : (name === 'click' ? 'square' : 'triangle');
      osc.frequency.setValueAtTime(f, t);

      if (name === 'flip' || name === 'start') {
        osc.frequency.exponentialRampToValueAtTime(f * 1.5, t + d);
      }
      if (name === 'wrong') {
        osc.frequency.exponentialRampToValueAtTime(f * 0.7, t + d);
      }
      if (name === 'win') {
        osc.frequency.exponentialRampToValueAtTime(f * 1.8, t + d);
      }

      g.gain.setValueAtTime(0.2, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + d);

      osc.start(t);
      osc.stop(t + d + 0.02);
    } catch (e) {
      // AudioContext unavailable or blocked
    }
  }

  function sfx(name) {
    if (!soundEnabled) return;
    var file = SFX_FILES[name];
    if (!file) return;

    try {
      var snd = new Audio(file);
      snd.volume = 0.7;
      var fellBack = false;

      function fallback() {
        if (!fellBack) {
          fellBack = true;
          fallbackBeep(name);
        }
      }

      snd.onerror = fallback;
      var p = snd.play();
      if (p && p.catch) {
        p.catch(fallback);
      }
    } catch (e) {
      fallbackBeep(name);
    }
  }

  // Export globally
  root.sfx = sfx;
  root.setSoundEnabled = function (enabled) {
    soundEnabled = !!enabled;
  };
  root.isSoundEnabled = function () {
    return soundEnabled;
  };
})(typeof window !== 'undefined' ? window : this);
