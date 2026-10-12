/**
 * Every Why builder, one per surface. `tests/why/contract.test.ts` runs each
 * against a fixture, validates the result with `WhySchema` and renders it with
 * the shared panel; a builder file not listed here fails that test.
 */
import { agentProposalToWhy } from './agent-proposal';
import { askToWhy } from './ask';
import { cycleToWhy } from './cycle';
import { directionToWhy } from './direction';
import { dispatchToWhy } from './dispatch';
import { feedbackToWhy } from './feedback';
import { frontierItemToWhy } from './frontier';
import { goalEventToWhy } from './goal-event';
import { idleToWhy } from './idle';
import { karmaEventToWhy } from './karma';
import { permissionToWhy } from './permission';
import { postureToWhy } from './posture';
import { proactiveToWhy } from './proactive';
import { productionToWhy } from './production';

export const WHY_BUILDERS = {
  cycle: cycleToWhy,
  dispatch: dispatchToWhy,
  ask: askToWhy,
  goalEvent: goalEventToWhy,
  idle: idleToWhy,
  karma: karmaEventToWhy,
  permission: permissionToWhy,
  posture: postureToWhy,
  proactive: proactiveToWhy,
  production: productionToWhy,
  agentProposal: agentProposalToWhy,
  direction: directionToWhy,
  feedback: feedbackToWhy,
  frontier: frontierItemToWhy,
} as const;

export type WhyBuilderName = keyof typeof WHY_BUILDERS;
