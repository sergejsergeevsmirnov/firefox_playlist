import { it, expect } from 'vitest';
import { TaskPool } from '../src/task-pool';
it('never checks more than two sources concurrently and drains its queue', async () => {
  const pool = new TaskPool(2); let running = 0; let peak = 0; let finished = 0;
  await new Promise<void>(resolve => {
    for (let i = 0; i < 6; i++) pool.add(async () => {
      running++; peak = Math.max(peak, running); await new Promise(r => setTimeout(r, 5)); running--; finished++;
      if (finished === 6) resolve();
    });
  });
  expect(peak).toBe(2); expect(finished).toBe(6);
});
