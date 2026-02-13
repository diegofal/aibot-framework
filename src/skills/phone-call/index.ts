import type { Skill, SkillContext } from '../../core/types';

interface PhoneCallConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  toNumber: string;
  maydayMessage: string;
  language: string;
  voice: string;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function twilioCall(config: PhoneCallConfig, message: string, loop: number = 1): Promise<string> {
  const twiml = `<Response><Say language="${config.language}" voice="${config.voice}" loop="${loop}">${escapeXml(message)}</Say></Response>`;

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Calls.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: config.toNumber,
        From: config.fromNumber,
        Twiml: twiml,
      }),
    }
  );

  const data = await response.json() as Record<string, unknown>;

  if (!response.ok) {
    const errorMsg = (data as { message?: string }).message || `HTTP ${response.status}`;
    throw new Error(`Twilio error: ${errorMsg}`);
  }

  return (data as { sid?: string }).sid || 'unknown';
}

const skill: Skill = {
  id: 'phone-call',
  name: 'Phone Call',
  version: '1.0.0',
  description: 'Make phone calls via Twilio',

  async onLoad(ctx: SkillContext) {
    ctx.logger.info('Phone Call skill loaded');
  },

  commands: {
    mayday: {
      description: 'Emergency call with predefined message',
      async handler(_args: string[], ctx: SkillContext) {
        const config = ctx.config as PhoneCallConfig;

        if (!config.accountSid || !config.authToken) {
          return 'Error: Twilio credentials not configured.';
        }

        try {
          const sid = await twilioCall(config, config.maydayMessage, 3);
          const masked = config.toNumber.slice(0, 4) + '...' + config.toNumber.slice(-2);
          ctx.logger.info({ sid, to: config.toNumber }, 'Mayday call initiated');
          return `Llamada de emergencia iniciada a ${masked} (SID: ${sid})`;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          ctx.logger.error({ error }, 'Mayday call failed');
          return `Error al iniciar llamada de emergencia: ${msg}`;
        }
      },
    },

    call: {
      description: 'Call with a custom message: /call <message>',
      async handler(args: string[], ctx: SkillContext) {
        const config = ctx.config as PhoneCallConfig;

        if (!config.accountSid || !config.authToken) {
          return 'Error: Twilio credentials not configured.';
        }

        if (args.length === 0) {
          return 'Uso: /call <mensaje>\n\nEjemplo: /call Hola, esto es una prueba';
        }

        const message = args.join(' ');

        try {
          const sid = await twilioCall(config, message, 1);
          const masked = config.toNumber.slice(0, 4) + '...' + config.toNumber.slice(-2);
          ctx.logger.info({ sid, to: config.toNumber }, 'Call initiated');
          return `Llamando a ${masked}... Mensaje: "${message}" (SID: ${sid})`;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          ctx.logger.error({ error }, 'Call failed');
          return `Error al iniciar llamada: ${msg}`;
        }
      },
    },
  },
};

export default skill;
