// A tiny element builder so views can be written as plain functions.

type Child = Node | string | number | null | undefined | false;
type Attributes = Record<string, unknown> & {
  className?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
};

export function h<TagName extends keyof HTMLElementTagNameMap>(
  tagName: TagName,
  attributes: Attributes | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[TagName] {
  const element = document.createElement(tagName);
  if (attributes !== null) {
    for (const [attributeName, attributeValue] of Object.entries(attributes)) {
      if (attributeValue === undefined || attributeValue === null || attributeValue === false) continue;
      if (attributeName === 'className') element.className = String(attributeValue);
      else if (attributeName === 'style' && typeof attributeValue === 'object') Object.assign(element.style, attributeValue);
      else if (attributeName === 'dataset') Object.assign(element.dataset, attributeValue);
      else if (attributeName.startsWith('on') && typeof attributeValue === 'function') {
        element.addEventListener(attributeName.slice(2).toLowerCase(), attributeValue as EventListener);
      } else if (attributeName in element && typeof attributeValue !== 'string') {
        (element as unknown as Record<string, unknown>)[attributeName] = attributeValue;
      } else if (attributeValue === true) element.setAttribute(attributeName, '');
      else element.setAttribute(attributeName, String(attributeValue));
    }
  }
  appendChildren(element, children);
  return element;
}

export function appendChildren(parent: Node, children: (Child | Child[])[]): void {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
}

export function replaceChildren(parent: Element, ...children: (Child | Child[])[]): void {
  parent.replaceChildren();
  appendChildren(parent, children);
}

/** Inline SVG icons, drawn on a 20-unit grid with a 1.6 stroke. */
const iconPaths: Record<string, string> = {
  play: '<path d="M6 4.5v11l9-5.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M6 4.5h2.6v11H6zM11.4 4.5H14v11h-2.6z" fill="currentColor" stroke="none"/>',
  previous: '<path d="M5 4.5v11M15 4.5v11L7.5 10z"/>',
  next: '<path d="M15 4.5v11M5 4.5v11L12.5 10z"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  minus: '<path d="M4 10h12"/>',
  fit: '<path d="M4 8V4h4M12 4h4v4M16 12v4h-4M8 16H4v-4"/>',
  onion: '<circle cx="8" cy="10" r="5"/><circle cx="12" cy="10" r="5" opacity=".55"/>',
  pencil: '<path d="M4 16l1-4 8.5-8.5 3 3L8 15z"/><path d="M11.5 5.5l3 3"/>',
  eraser: '<path d="M8 16h8M4.5 12.5l6-6 4 4-5.5 5.5H7.5z"/>',
  picker: '<path d="M13 4.2a2.2 2.2 0 0 1 3.1 3.1L14.6 8.8l-3.4-3.4z"/><path d="M10.2 6.4l3.4 3.4M12 8.2l-6.8 6.8-1.7.5.5-1.7L10.8 7"/>',
  undo: '<path d="M7 7H4V4"/><path d="M4.5 7A6 6 0 1 1 5 13"/>',
  redo: '<path d="M13 7h3V4"/><path d="M15.5 7A6 6 0 1 0 15 13"/>',
  left: '<path d="M12 4.5L6.5 10l5.5 5.5"/>',
  right: '<path d="M8 4.5l5.5 5.5L8 15.5"/>',
  up: '<path d="M4.5 12L10 6.5l5.5 5.5"/>',
  down: '<path d="M4.5 8L10 13.5 15.5 8"/>',
  trash: '<path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6"/>',
  copy: '<rect x="7" y="7" width="9" height="9" rx="1.5"/><path d="M13 7V4H4v9h3"/>',
  pivot: '<circle cx="10" cy="10" r="2.2"/><path d="M10 3v4M10 13v4M3 10h4M13 10h4"/>',
  grid: '<path d="M4 4h12v12H4zM8 4v12M12 4v12M4 8h12M4 12h12"/>',
  close: '<path d="M5 5l10 10M15 5L5 15"/>',
  back: '<path d="M11.5 4.5L6 10l5.5 5.5"/><path d="M6.5 10H16"/>',
  more: '<circle cx="5" cy="10" r="1.2" fill="currentColor"/><circle cx="10" cy="10" r="1.2" fill="currentColor"/><circle cx="15" cy="10" r="1.2" fill="currentColor"/>',
  import: '<path d="M10 3.5v9M6 9l4 4 4-4M4 16.5h12"/>',
  export: '<path d="M10 13V4M6 7.5l4-4 4 4M4 16.5h12"/>',
  expand: '<path d="M4 4h12v12H4z" stroke-dasharray="2 2"/><path d="M8 8h4v4H8z"/>',
  center: '<path d="M10 3v14M3 10h14"/><rect x="6.5" y="6.5" width="7" height="7" rx="1"/>',
};

export function icon(iconName: keyof typeof iconPaths | string): SVGSVGElement {
  const wrapper = document.createElement('span');
  wrapper.innerHTML = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[iconName] ?? ''}</svg>`;
  return wrapper.firstElementChild as SVGSVGElement;
}

export function iconButton(iconName: string, label: string, onClick: (event: MouseEvent) => void, extraAttributes: Attributes = {}): HTMLButtonElement {
  return h('button', { type: 'button', className: 'icon-button', title: label, 'aria-label': label, onclick: onClick, ...extraAttributes }, icon(iconName));
}

export function slugify(text: string): string {
  const slug = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'sprite' : slug.slice(0, 60);
}

export function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

export function downloadBytes(bytes: Uint8Array | Blob, fileName: string, mimeType: string): void {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = h('a', { href: objectUrl, download: fileName, style: 'display:none' });
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

let toastHideTimer: number | undefined;
export function showToast(message: string, tone: 'info' | 'error' = 'info'): void {
  let toastElement = document.getElementById('toast');
  if (toastElement === null) {
    toastElement = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastElement);
  }
  toastElement.textContent = message;
  toastElement.dataset.tone = tone;
  toastElement.classList.add('is-visible');
  window.clearTimeout(toastHideTimer);
  toastHideTimer = window.setTimeout(() => toastElement?.classList.remove('is-visible'), tone === 'error' ? 6000 : 3000);
}
