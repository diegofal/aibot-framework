/**
 * Every Why builder, one per surface. `tests/why/contract.test.ts` runs each
 * against a fixture, validates the result with `WhySchema` and renders it with
 * the shared panel; a builder file not listed here fails that test.
 */
import { dispatchToWhy } from './dispatch';
import { goalEventToWhy } from './goal-event';
import { karmaEventToWhy } from './karma';
import { proactiveToWhy } from './proactive';

export const WHY_BUILDERS = {
  dispatch: dispatchToWhy,
  goalEvent: goalEventToWhy,
  karma: karmaEventToWhy,
  proactive: proactiveToWhy,
} as const;

export type WhyBuilderName = keyof typeof WHY_BUILDERS;
