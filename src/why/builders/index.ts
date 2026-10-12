/**
 * Every Why builder, one per surface. `tests/why/contract.test.ts` runs each
 * against a fixture, validates the result with `WhySchema` and renders it with
 * the shared panel; a builder file not listed here fails that test.
 */
import { dispatchToWhy } from './dispatch';
import { proactiveToWhy } from './proactive';

export const WHY_BUILDERS = {
  dispatch: dispatchToWhy,
  proactive: proactiveToWhy,
} as const;

export type WhyBuilderName = keyof typeof WHY_BUILDERS;
