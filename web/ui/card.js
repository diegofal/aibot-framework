import { cx, esc } from './escape.js';

/**
 * Surface card.
 *
 * `title` and `subtitle` are escaped text. `body`, `actions` and `footer`
 * are trusted HTML composed by the caller (escape user data before passing
 * it in). `tone` paints a left accent stripe (ok/warn/danger/info/accent).
 */
export function card({
  title,
  subtitle,
  body = '',
  actions = '',
  footer = '',
  tone,
  class: cls,
  id,
  padded = true,
} = {}) {
  const titles =
    title || subtitle
      ? `<div class="ui-card-titles">${
          title ? `<div class="ui-card-title">${esc(title)}</div>` : ''
        }${subtitle ? `<div class="ui-card-subtitle">${esc(subtitle)}</div>` : ''}</div>`
      : '';
  const head =
    titles || actions
      ? `<div class="ui-card-head">${titles}${
          actions ? `<div class="ui-card-actions">${actions}</div>` : ''
        }</div>`
      : '';
  const idAttr = id ? ` id="${esc(id)}"` : '';
  return `<section class="${cx(
    'ui-card',
    tone ? `ui-card-${tone}` : '',
    padded ? '' : 'ui-card-flush',
    cls
  )}"${idAttr}>${head}<div class="ui-card-body">${body}</div>${
    footer ? `<div class="ui-card-foot">${footer}</div>` : ''
  }</section>`;
}
