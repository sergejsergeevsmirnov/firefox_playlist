export class TaskPool {
  private tasks: (() => Promise<void>)[] = [];
  private running = 0;
  constructor(private limit = 2) {}
  add(task: () => Promise<void>): void { this.tasks.push(task); this.pump(); }
  private pump(): void {
    while (this.running < this.limit && this.tasks.length) {
      const task = this.tasks.shift()!; this.running++;
      void task().catch(error => console.error('Video resolver:', error)).finally(() => { this.running--; this.pump(); });
    }
  }
}
