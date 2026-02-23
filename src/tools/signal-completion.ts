import type { Tool, ToolDefinition, ToolResult } from './types';
import type { Logger } from '../logger';

/**
 * Signal that the single deliverable has been completed.
 * This allows the executor to exit early instead of continuing to maxToolRounds.
 */
export interface SignalCompletionArgs {
  /** Brief description of what was completed */
  summary: string;
  /** Whether the deliverable is fully complete (true) or partially done (false) */
  complete: boolean;
}

/**
 * Tool that allows the agent to signal completion of the single deliverable.
 * When called with complete=true, the executor loop will terminate early.
 */
export class SignalCompletionTool implements Tool {
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'signal_completion',
      description: `Signal that the single deliverable has been completed. Use this when:
- The assigned deliverable is fully done (complete=true)
- You've accomplished what was asked and there's nothing more to do
- You want to stop the session early because the work is finished

This is NOT for:
- Taking a break (the session continues)
- Reporting progress (use the final message for that)
- Partial completion unless you need human input to continue

⚠️ When complete=true, the session ENDS immediately. Make sure you actually finished the deliverable.`,
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Brief description of what was completed (1-2 sentences)',
          },
          complete: {
            type: 'boolean',
            description: 'true = deliverable is fully complete, session should end. false = partial progress, should continue.',
          },
        },
        required: ['summary', 'complete'],
      },
    },
  };

  // Static flag that the executor checks after each tool call
  private static completionRequested = false;
  private static completionSummary = '';
  private static completionComplete = false;

  static reset(): void {
    SignalCompletionTool.completionRequested = false;
    SignalCompletionTool.completionSummary = '';
    SignalCompletionTool.completionComplete = false;
  }

  static isCompletionRequested(): boolean {
    return SignalCompletionTool.completionRequested;
  }

  static getCompletionStatus(): { summary: string; complete: boolean } {
    return {
      summary: SignalCompletionTool.completionSummary,
      complete: SignalCompletionTool.completionComplete,
    };
  }

  async execute(args: Record<string, unknown>, _logger: Logger): Promise<ToolResult> {
    const summary = String(args.summary || '');
    const complete = Boolean(args.complete);

    SignalCompletionTool.completionRequested = true;
    SignalCompletionTool.completionSummary = summary;
    SignalCompletionTool.completionComplete = complete;

    if (complete) {
      return {
        success: true,
        content: `✅ Deliverable complete: ${summary}\n\nSession will end now.`,
      };
    } else {
      return {
        success: true,
        content: `⏳ Partial progress: ${summary}\n\nContinuing with remaining work...`,
      };
    }
  }
}

/**
 * Factory function for creating the signal_completion tool.
 * Also resets the static state so each session starts fresh.
 */
export function createSignalCompletionTool(): Tool {
  SignalCompletionTool.reset();
  return new SignalCompletionTool();
}
