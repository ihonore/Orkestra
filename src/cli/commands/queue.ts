/**
 * `gms queue` — show or change which searches run first.
 *
 * With no options it only reports. Any option changes the stored plan, which
 * every later `gms run` — and the dashboard — follows.
 */
import type { ResolvedConfig } from '../../config/schema.js';
import { openDatabaseFromConfig } from '../../db/client.js';
import {
  queueView,
  readQueuePlan,
  setQueuePlan,
  type QueueOrder,
  type QueuePlan,
} from '../../seeds/queue.js';
import { heading, keyValue, style, symbol } from '../output.js';

export interface QueueCommandOptions {
  readonly config: ResolvedConfig;
  readonly order?: QueueOrder;
  /** Comma-separated state codes; an empty string clears them. */
  readonly states?: string;
  readonly only?: boolean;
  readonly json?: boolean;
}

function describePlan(plan: QueuePlan): string {
  const order =
    plan.order === 'spread'
      ? 'spread across states'
      : plan.order === 'chosen'
        ? 'chosen states one after another'
        : 'one state at a time';
  if (plan.states.length === 0) return `${order}, all states`;
  return `${order}, ${plan.only ? 'only' : 'first'}: ${plan.states.join(', ')}`;
}

export function runQueue(options: QueueCommandOptions): void {
  const changing =
    options.order !== undefined || options.states !== undefined || options.only !== undefined;
  const driver = openDatabaseFromConfig(options.config, { readonly: !changing });
  try {
    let changed: ReturnType<typeof setQueuePlan> | null = null;
    if (changing) {
      const current = readQueuePlan(driver);
      changed = setQueuePlan(driver, {
        order: options.order ?? current.order,
        states:
          options.states === undefined
            ? current.states
            : options.states.split(',').filter((s) => s.trim() !== ''),
        only: options.only ?? current.only,
      });
    }

    const view = queueView(driver, 10);
    if (options.json === true) {
      console.log(JSON.stringify({ ...view, ...(changed !== null && { changed }) }, null, 2));
      return;
    }

    if (changed !== null) {
      console.log(
        `${symbol.ok} queue plan saved: ${describePlan(changed.plan)} ` +
          style.grey(
            `(${changed.reordered} reordered, ${changed.statusChanged} paused or resumed)`,
          ),
      );
    } else {
      console.log(keyValue([['plan', describePlan(view.plan)]]));
    }

    console.log(heading('Next up'));
    if (view.next.length === 0) console.log(style.grey('  nothing queued'));
    view.next.forEach((job, i) => {
      console.log(
        `  ${style.grey(String(i + 1).padStart(2))}  ${job.category} in ${job.city}, ${job.stateCode}`,
      );
    });
  } finally {
    driver.close();
  }
}
