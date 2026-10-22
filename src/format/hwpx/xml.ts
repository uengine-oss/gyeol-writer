// 접두사(namespace prefix)에 의존하지 않는 XML 탐색 도우미.
import { DOMParser } from '@xmldom/xmldom';

export type XEl = Element;

export function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, 'text/xml') as unknown as Document;
}

export function kids(el: Node | null | undefined, local?: string): XEl[] {
  const out: XEl[] = [];
  if (!el) return out;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!local || (n as XEl).localName === local)) out.push(n as XEl);
  }
  return out;
}

export function kid(el: Node | null | undefined, local: string): XEl | undefined {
  return kids(el, local)[0];
}

/** 하위 전체에서 localName 으로 찾기 */
export function all(el: Node | null | undefined, local: string): XEl[] {
  const out: XEl[] = [];
  const walk = (n: Node) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1) {
        if ((c as XEl).localName === local) out.push(c as XEl);
        walk(c);
      }
    }
  };
  if (el) walk(el);
  return out;
}

export function first(el: Node | null | undefined, local: string): XEl | undefined {
  return all(el, local)[0];
}

export function attr(el: XEl | undefined, name: string): string | undefined {
  if (!el) return undefined;
  const v = el.getAttribute(name);
  return v === null || v === '' ? undefined : v;
}

export function num(el: XEl | undefined, name: string, def = 0): number {
  const v = attr(el, name);
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
