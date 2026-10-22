import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export class JobQueue extends EventEmitter {
  constructor() { super(); this.jobs = []; this.controllers = new Map(); this.tail = Promise.resolve(); }
  public() { return this.jobs.map(({ run, ...job }) => job); }
  add(title, instanceId, run) {
    const job = { id: randomUUID(), title, instanceId, status: 'queued', progress: 0, stage: '等待下载', createdAt: new Date().toISOString() };
    const controller = new AbortController(); this.controllers.set(job.id, controller);
    this.jobs.unshift(job); this.emit('change');
    this.tail = this.tail.then(async () => {
      if (controller.signal.aborted) return;
      job.status = 'running'; this.emit('change');
      const update = (stage, progress, extra = {}) => { Object.assign(job, { stage, progress: Math.min(99, Math.max(0, progress)), ...extra }); this.emit('change'); };
      try { await run({ signal: controller.signal, update, job }); job.status = 'complete'; job.progress = 100; job.stage = '安装完成'; }
      catch (error) { job.status = controller.signal.aborted ? 'cancelled' : 'error'; job.error = controller.signal.aborted ? '任务已取消' : error.message; job.stage = job.error; }
      finally { this.controllers.delete(job.id); this.emit('change'); }
    });
    return job;
  }
  cancel(id) {
    const job = this.jobs.find(j => j.id === id);
    if (!job || !['queued', 'running'].includes(job.status)) throw new Error('任务已结束');
    this.controllers.get(id)?.abort(new Error('任务已取消'));
    if (job.status === 'queued') { job.status = 'cancelled'; this.controllers.delete(id); }
    else job.stage = '正在取消，请稍候…';
    this.emit('change');
  }
  busy(instanceId) { return this.jobs.some(j => j.instanceId === instanceId && ['queued', 'running'].includes(j.status)); }
}
