import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '@interlock/shared';
import type { EventRecord, InterlockEvent } from '@interlock/shared';
import { EventBus } from './event-bus.js';

const at = '2026-01-01T00:00:00.000Z';

function daemonStarted(): InterlockEvent {
  return { type: 'daemon.started', repoId: null, at, version: '0.0.0', pid: 1 };
}

describe('EventBus', () => {
  it('delivers to type-specific and wildcard subscribers', async () => {
    const bus = new EventBus({ logger: silentLogger });
    const specific = vi.fn();
    const any = vi.fn();
    bus.on('daemon.started', specific);
    bus.onAny(any);

    await bus.publish(daemonStarted());

    expect(specific).toHaveBeenCalledTimes(1);
    expect(any).toHaveBeenCalledTimes(1);
  });

  it('does not deliver to unrelated subscribers', async () => {
    const bus = new EventBus({ logger: silentLogger });
    const other = vi.fn();
    bus.on('finding.raised', other);

    await bus.publish(daemonStarted());

    expect(other).not.toHaveBeenCalled();
  });

  it('isolates a throwing subscriber from the others', async () => {
    const bus = new EventBus({ logger: silentLogger });
    const healthy = vi.fn();
    bus.onAny(() => {
      throw new Error('boom');
    });
    bus.onAny(healthy);

    await expect(bus.publish(daemonStarted())).resolves.toBeTypeOf('string');
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('records the causing event id on events published from a handler', async () => {
    const records: EventRecord[] = [];
    const bus = new EventBus({ logger: silentLogger, onRecord: (r) => records.push(r) });

    bus.on('daemon.started', async () => {
      await bus.publish({
        type: 'infra.failure',
        repoId: null,
        at,
        component: 'sandbox',
        code: 'SANDBOX_UNAVAILABLE',
        message: 'docker not running',
      });
    });

    const rootId = await bus.publish(daemonStarted());

    expect(records).toHaveLength(2);
    expect(records[0]?.causedBy).toBeNull();
    expect(records[1]?.causedBy).toBe(rootId);
  });

  it('stops delivering after unsubscribe', async () => {
    const bus = new EventBus({ logger: silentLogger });
    const handler = vi.fn();
    const subscription = bus.onAny(handler);

    subscription.unsubscribe();
    await bus.publish(daemonStarted());

    expect(handler).not.toHaveBeenCalled();
    expect(bus.handlerCount).toBe(0);
  });
});
