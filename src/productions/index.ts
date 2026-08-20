/**
 * Productions barrel.
 *
 * Per docs/architecture-docs/productions-refactor.md §3.3 + §6.5:
 *   - Re-exports `ProductionsService` only.
 *   - Submodules are leaves. Production code goes through the facade.
 *   - Tests deep-import by path; this barrel invites callers to bypass
 *     the facade and the boundary cannot be held by convention alone.
 */

export { ProductionsService } from './service';
