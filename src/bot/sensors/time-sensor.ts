/**
 * TimeSensor — Zero-cost environmental context: time of day, day of week.
 */

import type { Sensor, StimulusEvent } from './types';

export class TimeSensor implements Sensor {
  id = 'time';

  async poll(_botId: string): Promise<StimulusEvent[]> {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay();

    const bucket = getTimeBucket(hour);
    const isWeekend = day === 0 || day === 6;
    const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
      day
    ];

    const summary = `${dayName} ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })} (${bucket}${isWeekend ? ', weekend' : ''})`;

    return [
      {
        sensorId: this.id,
        timestamp: Date.now(),
        category: 'time',
        summary,
        relevance: 0.3,
        data: { hour, day, bucket, isWeekend, dayName },
      },
    ];
  }
}

function getTimeBucket(hour: number): string {
  if (hour >= 6 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 22) return 'evening';
  return 'night';
}
