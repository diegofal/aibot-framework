import type { Skill, SkillContext } from '../../core/types';

interface BriefConfig {
  format: 'markdown' | 'text' | 'json';
  maxGoals: number;
  timeWindowHours: number;
}

interface Goal {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'completed';
  priority: 'high' | 'medium' | 'low';
  notes?: string;
}

export const handlers: Record<
  string,
  (args: Record<string, unknown>, context: SkillContext) => Promise<unknown>
> = {
  async generate_brief(args: Record<string, unknown>, ctx: SkillContext): Promise<unknown> {
    const config: BriefConfig = {
      format: (args.format as 'markdown' | 'text' | 'json') || 'markdown',
      maxGoals: (args.maxGoals as number) || 5,
      timeWindowHours: (args.timeWindowHours as number) || 48,
    };

    ctx.logger.info({ config }, 'Daily Briefing: generando brief');

    // Obtener goals activos usando manage_goals
    const goalsResult = await ctx.tools.execute?.('manage_goals', { action: 'list' }, ctx);
    const activeGoals: Goal[] = [];

    // Parsear goals del resultado
    if (goalsResult?.success && typeof goalsResult.content === 'string') {
      const lines = goalsResult.content.split('\n');
      let inActiveSection = false;
      for (const line of lines) {
        if (line.includes('## Active')) {
          inActiveSection = true;
        } else if (line.includes('## Completed')) {
          inActiveSection = false;
        } else if (inActiveSection && line.startsWith('- [')) {
          const match = line.match(/- \[([ x])\] (.+)/);
          if (match && match[1] !== 'x') {
            activeGoals.push({
              id: `goal_${activeGoals.length}`,
              text: match[2].split('  -')[0].trim(),
              status: 'pending',
              priority: 'medium',
            });
          }
        }
      }
    }

    // Limitar goals
    const limitedGoals = activeGoals.slice(0, config.maxGoals);

    // Generar contenido según formato
    const temporal = getTemporalContext();
    const headline = generateHeadline(temporal, limitedGoals);

    let content: string;
    if (config.format === 'json') {
      content = JSON.stringify(
        {
          headline,
          goals: limitedGoals,
          temporal,
          generatedAt: new Date().toISOString(),
        },
        null,
        2
      );
    } else if (config.format === 'text') {
      content = formatAsText(headline, limitedGoals, temporal);
    } else {
      content = formatAsMarkdown(headline, limitedGoals, temporal);
    }

    return {
      success: true,
      brief: content,
      metrics: {
        goalsCount: limitedGoals.length,
        highPriorityCount: limitedGoals.filter((g) => g.priority === 'high').length,
      },
    };
  },

  async schedule_brief(args: Record<string, unknown>, ctx: SkillContext): Promise<unknown> {
    const time = (args.time as string) || '07:00';
    const timezone = (args.timezone as string) || 'America/Argentina/Buenos_Aires';
    const enabled = args.enabled !== false;

    ctx.logger.info({ time, timezone, enabled }, 'Daily Briefing: programando');

    if (!enabled) {
      return { success: true, message: 'Brief automático desactivado' };
    }

    // Parsear hora para cron
    const [hour, minute] = time.split(':').map(Number);
    const cronExpr = `${minute} ${hour} * * *`;

    try {
      // Usar cron tool para programar
      const result = await ctx.tools.execute?.(
        'cron',
        {
          action: 'add',
          name: 'Daily Briefing',
          schedule: {
            kind: 'cron',
            expr: cronExpr,
            tz: timezone,
          },
          text: 'daily-briefing scheduled',
        },
        ctx
      );

      return {
        success: true,
        message: `Brief programado para las ${time} (${timezone})`,
        cron: cronExpr,
      };
    } catch (err) {
      ctx.logger.error({ err }, 'Error programando brief');
      return {
        success: false,
        message: `Error: ${String(err)}`,
      };
    }
  },
};

// Helpers
function getTemporalContext() {
  const now = new Date();
  const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const dayOfWeek = dayNames[now.getDay()];
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;
  const daysUntilWeekend = isWeekend ? 0 : 6 - now.getDay();

  return {
    today: now.toISOString().split('T')[0],
    dayOfWeek,
    isWeekend,
    daysUntilWeekend,
  };
}

function generateHeadline(temporal: ReturnType<typeof getTemporalContext>, goals: Goal[]): string {
  const blockedCount = goals.filter((g) => g.status === 'blocked').length;
  const highPriorityCount = goals.filter(
    (g) => g.priority === 'high' && g.status !== 'completed'
  ).length;

  if (blockedCount > 0) {
    return `🚨 Tenés ${blockedCount} ${blockedCount === 1 ? 'bloqueo' : 'bloqueos'} que necesitan atención`;
  }
  if (highPriorityCount > 0) {
    return `🔥 ${highPriorityCount} ${highPriorityCount === 1 ? 'prioridad alta' : 'prioridades altas'} para hoy`;
  }
  if (temporal.isWeekend) {
    return `🌅 Buen ${temporal.dayOfWeek.toLowerCase()}, sin urgencias pendientes`;
  }
  if (temporal.dayOfWeek === 'Viernes') {
    return `🎯 Viernes: ${goals.length} ${goals.length === 1 ? 'tarea' : 'tareas'} para cerrar la semana`;
  }

  return `📋 ${temporal.dayOfWeek}: ${goals.length} ${goals.length === 1 ? 'tarea activa' : 'tareas activas'}`;
}

function formatAsMarkdown(
  headline: string,
  goals: Goal[],
  temporal: ReturnType<typeof getTemporalContext>
): string {
  const lines: string[] = [
    `# 🌅 Daily Brief — ${temporal.today}`,
    '',
    `**${headline}**`,
    '',
    '---',
    '',
    '## 🎯 Goals Activos',
    '',
  ];

  if (goals.length === 0) {
    lines.push('Sin goals pendientes.');
  } else {
    for (const goal of goals) {
      const emoji = goal.status === 'blocked' ? '🔴' : goal.status === 'in_progress' ? '⏳' : '⚪';
      lines.push(`${emoji} ${goal.text}`);
    }
  }

  lines.push('', '---', '', `_Generado: ${new Date().toLocaleString('es-AR')}_`);
  return lines.join('\n');
}

function formatAsText(
  headline: string,
  goals: Goal[],
  temporal: ReturnType<typeof getTemporalContext>
): string {
  const lines: string[] = [`🌅 Daily Brief — ${temporal.today}`, '', headline, '', '🎯 Goals:'];

  if (goals.length === 0) {
    lines.push('  Sin goals pendientes.');
  } else {
    for (const goal of goals) {
      const emoji = goal.status === 'blocked' ? '🔴' : goal.status === 'in_progress' ? '⏳' : '⚪';
      lines.push(`  ${emoji} ${goal.text}`);
    }
  }

  return lines.join('\n');
}

const skill: Skill = {
  id: 'daily-briefing',
  name: 'Daily Briefing',
  version: '1.0.0',
  description: 'Genera resúmenes diarios integrando goals, memoria y contexto temporal',

  async onLoad(ctx: SkillContext) {
    ctx.logger.info('Daily Briefing skill loaded');
  },

  async onUnload() {
    console.log('Daily Briefing skill unloaded');
  },

  commands: {
    brief: {
      description: 'Genera un daily briefing',
      async handler(args: string[], ctx: SkillContext) {
        const format = args.includes('--json')
          ? 'json'
          : args.includes('--text')
            ? 'text'
            : 'markdown';
        const result = await handlers.generate_brief({ format }, ctx);
        return (result as { brief?: string })?.brief || 'Error generando brief';
      },
    },
  },
};

export default skill;
