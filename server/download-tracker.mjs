import path from 'node:path';

// A task owns one meter, so concurrent files and ranges share a single speed.
export class DownloadTracker {
  constructor(publish, now = Date.now) {
    this.publish = publish; this.now = now; this.active = new Map();
    this.downloaded = 0; this.history = [{ time: now(), bytes: 0 }]; this.currentFile = '';
  }
  start(file) {
    const id = Symbol(file);
    this.currentFile = path.basename(file);
    this.active.set(id, { fileName: this.currentFile, receivedBytes: 0, totalBytes: 0, connections: 1 });
    this.report(); return id;
  }
  progress(id, bytes, total, connections = 1) {
    const entry = this.active.get(id); if (!entry) return;
    this.downloaded += Math.max(0, bytes - entry.receivedBytes);
    Object.assign(entry, { receivedBytes: bytes, totalBytes: total, connections });
  }
  end(id) { this.active.delete(id); this.report(); }
  report() {
    const time = this.now();
    while (this.history.length > 1 && this.history[1].time <= time - 2000) this.history.shift();
    const first = this.history[0];
    const speed = this.active.size ? (this.downloaded - first.bytes) * 1000 / Math.max(500, time - first.time) : 0;
    if (time > this.history.at(-1).time) this.history.push({ time, bytes: this.downloaded });
    const activeFiles = [...this.active.values()].map(file => ({ ...file }));
    this.publish({ currentFile: activeFiles[0]?.fileName || this.currentFile, activeFiles, downloadedBytes: this.downloaded,
      speedBytesPerSecond: Math.round(speed), connections: activeFiles.reduce((sum, file) => sum + file.connections, 0) });
  }
  finish() { this.active.clear(); this.report(); }
}
