import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { Tool, ToolResult } from './types';
import type { Logger } from '../logger';

export interface PhoneCallToolConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  defaultNumber: string;
  language: string;
  voice: string;
  contactsFile: string;
}

type Contacts = Record<string, string>;

function loadContacts(filePath: string): Contacts {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function saveContacts(filePath: string, contacts: Contacts): void {
  writeFileSync(filePath, JSON.stringify(contacts, null, 2) + '\n');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function twilioCall(
  config: PhoneCallToolConfig,
  toNumber: string,
  message: string,
  loop: number,
  logger: Logger
): Promise<string> {
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
        To: toNumber,
        From: config.fromNumber,
        Twiml: twiml,
      }),
    }
  );

  const data = await response.json() as Record<string, unknown>;

  if (!response.ok) {
    const errorMsg = (data as { message?: string }).message || `HTTP ${response.status}`;
    logger.error({ status: response.status, error: errorMsg }, 'Twilio API error');
    throw new Error(errorMsg);
  }

  return (data as { sid?: string }).sid || 'unknown';
}

export function createPhoneCallTool(config: PhoneCallToolConfig): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'phone_call',
        description:
          'Make phone calls to contacts or manage the phonebook. ' +
          'Use action "call" to call someone with a spoken message. ' +
          'Use action "add_contact" to save a new contact. ' +
          'Use action "list_contacts" to see all saved contacts. ' +
          'Use action "remove_contact" to delete a contact.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description: 'The action: "call", "add_contact", "list_contacts", or "remove_contact"',
            },
            contact: {
              type: 'string',
              description: 'Contact name to call or manage (e.g. "pri", "diego"). For "call" action, can also be a phone number directly.',
            },
            message: {
              type: 'string',
              description: 'The message to say in the phone call (for "call" action only)',
            },
            phone_number: {
              type: 'string',
              description: 'Phone number in E.164 format, e.g. "+5491112345678" (for "add_contact" action, or "call" with a direct number)',
            },
            loop: {
              type: 'number',
              description: 'How many times to repeat the message (default: 1, use 3 for emergencies)',
            },
          },
          required: ['action'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const action = String(args.action ?? '').trim();

      if (action === 'list_contacts') {
        const contacts = loadContacts(config.contactsFile);
        const entries = Object.entries(contacts);
        if (entries.length === 0) {
          return { success: true, content: 'No hay contactos guardados.' };
        }
        const list = entries.map(([name, number]) => `- ${name}: ${number}`).join('\n');
        return { success: true, content: `Contactos:\n${list}` };
      }

      if (action === 'add_contact') {
        const name = String(args.contact ?? '').trim().toLowerCase();
        const phone = String(args.phone_number ?? '').trim();
        if (!name) return { success: false, content: 'Falta el nombre del contacto.' };
        if (!phone) return { success: false, content: 'Falta el número de teléfono.' };

        const contacts = loadContacts(config.contactsFile);
        contacts[name] = phone;
        saveContacts(config.contactsFile, contacts);
        logger.info({ name, phone }, 'Contact added');
        return { success: true, content: `Contacto guardado: ${name} → ${phone}` };
      }

      if (action === 'remove_contact') {
        const name = String(args.contact ?? '').trim().toLowerCase();
        if (!name) return { success: false, content: 'Falta el nombre del contacto.' };

        const contacts = loadContacts(config.contactsFile);
        if (!(name in contacts)) {
          return { success: false, content: `No existe el contacto "${name}".` };
        }
        delete contacts[name];
        saveContacts(config.contactsFile, contacts);
        logger.info({ name }, 'Contact removed');
        return { success: true, content: `Contacto "${name}" eliminado.` };
      }

      if (action === 'call') {
        const message = String(args.message ?? '').trim();
        if (!message) return { success: false, content: 'Falta el mensaje para la llamada.' };

        const loop = Number(args.loop) || 1;
        let toNumber = '';

        // Resolve the target number
        const contactArg = String(args.contact ?? '').trim();
        if (contactArg.startsWith('+')) {
          // Direct phone number
          toNumber = contactArg;
        } else if (contactArg) {
          // Look up in contacts
          const contacts = loadContacts(config.contactsFile);
          const key = contactArg.toLowerCase();
          toNumber = contacts[key] ?? '';
          if (!toNumber) {
            const available = Object.keys(contacts);
            const hint = available.length > 0
              ? ` Contactos disponibles: ${available.join(', ')}`
              : ' No hay contactos guardados aún.';
            return {
              success: false,
              content: `No encontré el número de "${contactArg}".${hint} Pedile el número al usuario y guardalo con add_contact.`,
            };
          }
        } else {
          // No contact specified, use default
          toNumber = config.defaultNumber;
        }

        if (!toNumber) {
          return { success: false, content: 'No se especificó un contacto ni hay número por defecto configurado.' };
        }

        try {
          const sid = await twilioCall(config, toNumber, message, loop, logger);
          logger.info({ sid, to: toNumber, message: message.substring(0, 50) }, 'Call initiated via tool');
          return { success: true, content: `Llamada iniciada a ${toNumber} (SID: ${sid}). Mensaje: "${message}"` };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { success: false, content: `Error al llamar: ${msg}` };
        }
      }

      return { success: false, content: `Acción desconocida: "${action}". Usar: call, add_contact, list_contacts, remove_contact.` };
    },
  };
}
