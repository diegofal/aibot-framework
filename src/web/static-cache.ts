import type { MiddlewareHandler } from 'hono';

/**
 * The dashboard links its assets without a version query (`/style.css`,
 * `/app.js` in web/index.html), so a browser that caches them keeps rendering
 * the previous UI after a deploy — the change looks like it never landed, and
 * nothing in the logs says otherwise. `no-cache` does not disable caching: it
 * stores the response but revalidates before every reuse, so an unchanged file
 * still costs a 304 while an edited one is picked up on the next load.
 *
 * Applies only to the dashboard shell and its code (HTML/CSS/JS). API JSON is
 * left alone — those routes set their own semantics — and so are images and
 * fonts, which are content-addressed by name in practice. An upstream handler
 * that already declared a Cache-Control wins, so a future fingerprinted bundle
 * can opt into long-lived caching without touching this.
 */
export const dashboardNoCache: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.req.path.startsWith('/api/')) return;
  if (c.res.headers.has('Cache-Control')) return;
  const type = c.res.headers.get('Content-Type') ?? '';
  if (/text\/html|text\/css|javascript/i.test(type)) {
    c.res.headers.set('Cache-Control', 'no-cache');
  }
};
