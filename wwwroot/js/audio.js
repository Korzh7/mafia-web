// Синтезатор звуковых эффектов через Web Audio API (без внешних MP3-файлов)
class MafiaAudio {
  constructor() {
    this.ctx = null;
    this.nightOsc = null;
    this.nightGain = null;
    this.muted = false;
  }

  init() {
    if (!this.ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  // Звук тиканья таймера (последние 5 секунд)
  playTick() {
    if (this.muted) return;
    this.init();
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(400, this.ctx.currentTime + 0.05);

    gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.05);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start();
    osc.stop(this.ctx.currentTime + 0.05);
  }

  // Удар молотка (выставление кандидата, переход хода)
  playGavel() {
    if (this.muted) return;
    this.init();
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(200, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, this.ctx.currentTime + 0.2);

    gain.gain.setValueAtTime(0.4, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.25);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start();
    osc.stop(this.ctx.currentTime + 0.25);
  }

  // Выстрел мафии (глухой низкий удар)
  playGunshot() {
    if (this.muted) return;
    this.init();

    // Создаем шумовой буфер
    const bufferSize = this.ctx.sampleRate * 0.4;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (this.ctx.sampleRate * 0.08));
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(600, this.ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(80, this.ctx.currentTime + 0.35);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.6, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.35);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);

    noise.start();
  }

  // Атмосферный фоновый гул ночи
  startNightAmbient() {
    if (this.muted || this.nightOsc) return;
    this.init();

    this.nightOsc = this.ctx.createOscillator();
    this.nightGain = this.ctx.createGain();

    this.nightOsc.type = 'sine';
    this.nightOsc.frequency.setValueAtTime(65, this.ctx.currentTime);

    this.nightGain.gain.setValueAtTime(0.001, this.ctx.currentTime);
    this.nightGain.gain.linearRampToValueAtTime(0.12, this.ctx.currentTime + 2);

    this.nightOsc.connect(this.nightGain);
    this.nightGain.connect(this.ctx.destination);

    this.nightOsc.start();
  }

  stopNightAmbient() {
    if (this.nightOsc && this.nightGain) {
      try {
        this.nightGain.gain.linearRampToValueAtTime(0.001, this.ctx.currentTime + 1);
        setTimeout(() => {
          if (this.nightOsc) {
            this.nightOsc.stop();
            this.nightOsc.disconnect();
            this.nightOsc = null;
            this.nightGain = null;
          }
        }, 1000);
      } catch (e) {
        this.nightOsc = null;
      }
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.muted) this.stopNightAmbient();
    return this.muted;
  }
}

window.mafiaAudio = new MafiaAudio();
