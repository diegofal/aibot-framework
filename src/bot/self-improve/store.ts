/**
 * `<soulDir>/LESSONS.json`: atomic writes (tmp + rename), readers never throw.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LESSONS_FILE,
  LESSONS_KEEP,
  type Lesson,
  type LessonsFile,
  type SuppressedClass,
  isLessonInPrompt,
} from './types';

export function emptyLessonsFile(): LessonsFile {
  return { version: 1, lessons: [], suppressed: [] };
}

function isLesson(v: unknown): v is Lesson {
  if (!v || typeof v !== 'object') return false;
  const l = v as Record<string, unknown>;
  return (
    typeof l.id === 'string' &&
    typeof l.classKey === 'string' &&
    typeof l.text === 'string' &&
    typeof l.status === 'string' &&
    !!l.baseline &&
    typeof l.baseline === 'object'
  );
}

function isSuppressed(v: unknown): v is SuppressedClass {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as SuppressedClass).classKey === 'string' &&
    typeof (v as SuppressedClass).since === 'string'
  );
}

/** Keep every in-prompt lesson; trim the oldest finished ones past `LESSONS_KEEP`. */
export function pruneLessons(lessons: Lesson[], keep = LESSONS_KEEP): Lesson[] {
  if (lessons.length <= keep) return lessons;
  const live = lessons.filter(isLessonInPrompt);
  const done = lessons
    .filter((l) => !isLessonInPrompt(l))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(0, keep - live.length));
  const kept = new Set([...live, ...done].map((l) => l.id));
  return lessons.filter((l) => kept.has(l.id));
}

export class LessonStore {
  readonly path: string;

  constructor(readonly soulDir: string) {
    this.path = join(soulDir, LESSONS_FILE);
  }

  /** The file, or an empty one when missing or unreadable. Never throws. */
  read(): LessonsFile {
    try {
      if (!existsSync(this.path)) return emptyLessonsFile();
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<LessonsFile>;
      return {
        version: 1,
        lessons: Array.isArray(raw.lessons) ? raw.lessons.filter(isLesson) : [],
        suppressed: Array.isArray(raw.suppressed) ? raw.suppressed.filter(isSuppressed) : [],
      };
    } catch {
      return emptyLessonsFile();
    }
  }

  /** Atomic write; prunes finished lessons past the keep limit. Throws on I/O failure. */
  write(file: LessonsFile): void {
    mkdirSync(this.soulDir, { recursive: true });
    const next: LessonsFile = {
      version: 1,
      lessons: pruneLessons(file.lessons),
      suppressed: file.suppressed,
    };
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.path);
  }

  /** Read, change, write. Returns what was written. */
  update(fn: (file: LessonsFile) => LessonsFile): LessonsFile {
    const next = fn(this.read());
    this.write(next);
    return this.read();
  }

  /** Lessons that go in the prompt, newest first, at most `max`. */
  inPrompt(max: number): Lesson[] {
    return this.read()
      .lessons.filter(isLessonInPrompt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(0, max));
  }
}
