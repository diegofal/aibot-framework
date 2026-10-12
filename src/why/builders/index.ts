/**
 * Every Why builder, one per surface. `tests/why/contract.test.ts` runs each
 * against a fixture, validates the result with `WhySchema` and renders it with
 * the shared panel; a builder file not listed here fails that test.
 */
import { cycleToWhy } from './cycle';
import { dispatchToWhy } from './dispatch';
import { goalEventToWhy } from './goal-event';
import { idleToWhy } from './idle';
import { karmaEventToWhy } from './karma';
import { postureToWhy } from './posture';
import { proactiveToWhy } from './proactive';

export const WHY_BUILDERS = {
  cycle: cycleToWhy,
  dispatch: dispatchToWhy,
  goalEvent: goalEventToWhy,
  idle: idleToWhy,
  karma: karmaEventToWhy,
  posture: postureToWhy,
  proactive: proactiveToWhy,
} as const;

export type WhyBuilderName = keyof typeof WHY_BUILDERS;
