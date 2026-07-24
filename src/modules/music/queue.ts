import { loadMusicState, saveMusicState } from '../../db.js';

export interface Track {
  title: string;
  url: string;
  duration: string;
  requestedBy: string;
}

export type LoopMode = 'off' | 'track' | 'queue';

/**
 * Queue state with write-through SQLite persistence — no Discord, voice, or
 * process concerns. Restores the previous run's queue on construction; every
 * mutating method persists so a restart resumes mid-queue.
 */
export class TrackQueue {
  readonly tracks: Track[] = [];
  current: Track | null = null;
  loopMode: LoopMode = 'off';
  autoplay = true; // radio by default — one song seeds a continuous queue

  constructor(private readonly guildId: string) {
    const saved = loadMusicState(guildId);
    if (saved) {
      try {
        this.tracks.push(...(JSON.parse(saved.queue_json) as Track[]));
      } catch {
        // corrupted state — start clean
      }
      if (saved.loop_mode === 'track' || saved.loop_mode === 'queue') this.loopMode = saved.loop_mode;
      // autoplay is not restored — radio-on is the per-session default; a stale
      // saved value shouldn't silence the bot after a restart.
    }
  }

  persist(): void {
    // Current track goes back to the front so a restart resumes with it.
    const toSave = this.current ? [this.current, ...this.tracks] : [...this.tracks];
    saveMusicState(this.guildId, JSON.stringify(toSave), this.loopMode, this.autoplay);
  }

  /**
   * Select the next track per loop mode. Mutates the queue but does not set
   * `current` or persist — the caller decides what to do with the pick.
   */
  pickNext(skipRequested: boolean): { track: Track | undefined; repeated: boolean } {
    if (this.loopMode === 'track' && this.current !== null && !skipRequested) {
      return { track: this.current, repeated: true };
    }
    if (this.loopMode === 'queue' && this.current !== null) this.tracks.push(this.current);
    return { track: this.tracks.shift(), repeated: false };
  }

  push(track: Track): void {
    this.tracks.push(track);
    this.persist();
  }

  shuffle(): void {
    for (let i = this.tracks.length - 1; i > 0; i--) {
      // Shuffle randomness, not crypto.
      // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator
      const j = Math.floor(Math.random() * (i + 1));
      [this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
    }
    this.persist();
  }

  removeAt(position: number): Track | null {
    if (position < 1 || position > this.tracks.length) return null;
    const [removed] = this.tracks.splice(position - 1, 1);
    this.persist();
    return removed;
  }

  move(from: number, to: number): Track | null {
    if (from < 1 || from > this.tracks.length || to < 1 || to > this.tracks.length) return null;
    const [track] = this.tracks.splice(from - 1, 1);
    this.tracks.splice(to - 1, 0, track);
    this.persist();
    return track;
  }

  clear(): number {
    const n = this.tracks.length;
    this.tracks.length = 0;
    this.persist();
    return n;
  }
}
