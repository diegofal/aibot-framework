import { Hono } from 'hono';
import type { SkillRegistry } from '../../core/skill-registry';

export function skillsRoutes(deps: { skillRegistry: SkillRegistry }) {
  const app = new Hono();

  app.get('/', (c) => {
    const skills = deps.skillRegistry.getAll().map((s) => {
      const ctx = deps.skillRegistry.getContext(s.id);
      const cfg = (ctx?.config ?? {}) as Record<string, unknown>;
      return {
        id: s.id,
        name: s.name,
        version: s.version,
        description: s.description,
        commands: s.commands ? Object.keys(s.commands) : [],
        jobs: s.jobs?.map((j) => ({ id: j.id, schedule: j.schedule })) ?? [],
        hasOnMessage: !!s.onMessage,
        llmBackend: (cfg.llmBackend as string) || 'ollama',
      };
    });
    return c.json(skills);
  });

  return app;
}
