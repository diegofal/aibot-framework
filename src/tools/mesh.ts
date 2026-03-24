/**
 * Knowledge Mesh tools — lets bots publish/query shared insights.
 * Uses _botId injected by ToolExecutor (same pattern as ask_human).
 */

import type { KnowledgeMesh } from '../bot/knowledge-mesh';
import type { Logger } from '../logger';
import type { Tool, ToolResult } from './types';

type MeshResolver = () => KnowledgeMesh | null;

export function createMeshPublishTool(getMesh: MeshResolver): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'mesh_publish',
        description:
          'Publish an insight or discovery to the shared Knowledge Mesh. ' +
          'Other bots can query and learn from your insights. ' +
          'Use this when you discover something valuable that peer bots could benefit from: ' +
          'effective strategies, patterns, user preferences, domain knowledge.',
        parameters: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              description:
                'Topic keyword(s) for discoverability (e.g., "research strategies", "user preferences")',
            },
            insight: {
              type: 'string',
              description: 'The insight or discovery to share (max 500 chars)',
            },
            confidence: {
              type: 'number',
              description: 'How confident you are in this insight (0.0-1.0, default 0.5)',
            },
            evidence: {
              type: 'string',
              description: 'Optional supporting evidence or context',
            },
          },
          required: ['topic', 'insight'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const mesh = getMesh();
      if (!mesh) {
        return { success: false, content: 'Knowledge mesh is not available.' };
      }

      const topic = args.topic as string;
      const insight = args.insight as string;
      const confidence = (args.confidence as number) ?? 0.5;
      const evidence = args.evidence as string | undefined;
      const botId = args._botId as string;

      if (!topic || !insight) {
        return { success: false, content: 'Both topic and insight are required.' };
      }
      if (!botId) {
        return { success: false, content: 'Missing bot context (_botId).' };
      }

      const entry = mesh.publish(botId, topic, insight, confidence, evidence);

      if (!entry) {
        return { success: true, content: 'Insight already exists in the mesh (deduped).' };
      }

      return {
        success: true,
        content: `Published to Knowledge Mesh:\n- Topic: ${entry.topic}\n- Insight: ${entry.insight}\n- Confidence: ${entry.confidence}\n- ID: ${entry.id}`,
      };
    },
  };
}

export function createMeshQueryTool(getMesh: MeshResolver): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'mesh_query',
        description:
          'Query the shared Knowledge Mesh for insights from peer bots. ' +
          'Returns relevant insights published by other bots on the given topic. ' +
          'Use this to learn from peer discoveries before starting new research.',
        parameters: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              description: 'Topic to search for in the mesh',
            },
            minConfidence: {
              type: 'number',
              description: 'Minimum confidence threshold (0.0-1.0, default 0.2)',
            },
          },
          required: ['topic'],
        },
      },
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const mesh = getMesh();
      if (!mesh) {
        return { success: false, content: 'Knowledge mesh is not available.' };
      }

      const topic = args.topic as string;
      const minConfidence = (args.minConfidence as number) ?? 0.2;
      const botId = args._botId as string;

      if (!topic) {
        return { success: false, content: 'Topic is required.' };
      }

      const results = mesh.query(topic, {
        excludeBotId: botId || undefined,
        minConfidence,
        maxResults: 10,
      });

      if (results.length === 0) {
        return { success: true, content: `No insights found in the mesh for topic "${topic}".` };
      }

      const lines = results.map((r) => {
        const ago = Math.round((Date.now() - r.entry.timestamp) / 3_600_000);
        return `- [${r.entry.sourceBotId}] ${r.entry.insight} (confidence: ${(r.entry.confidence * 100).toFixed(0)}%, ${ago}h ago)`;
      });

      return {
        success: true,
        content: `Knowledge Mesh — ${results.length} insight(s) for "${topic}":\n${lines.join('\n')}`,
      };
    },
  };
}
