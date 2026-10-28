/**
 * 极简 XML 读取器（只够读 MusicXML）。
 *
 * 为什么不引 xml2js/fast-xml-parser：只需要「按标签取子节点 + 取属性 + 取文本」，
 * 一个 120 行的扫描器就能覆盖，而且能同时在 Node（单测/自检）与浏览器里跑——
 * 用 DOMParser 会让内核层依赖浏览器，那样 scripts/verify.ts 就跑不起来了。
 *
 * 不支持的：命名空间解析（标签前缀直接剥掉）、实体（除 5 个预定义实体）、DTD 内部子集。
 * MusicXML 用不到这些。
 */

export interface XEl {
  tag: string;
  attrs: Record<string, string>;
  children: XEl[];
  text: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decode(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? m;
  });
}

function stripPrefix(tag: string): string {
  const i = tag.indexOf(":");
  return i >= 0 ? tag.slice(i + 1) : tag;
}

export function parseXml(src: string): XEl {
  const root: XEl = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack: XEl[] = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      stack[stack.length - 1].text += decode(src.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += decode(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      stack[stack.length - 1].text += src.slice(lt + 9, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (src.startsWith("<!", lt)) {
      // DOCTYPE：跳到配对的 '>'，跳过内部子集 [...] 里的 '>'
      let j = lt + 2;
      let depth = 0;
      while (j < src.length) {
        const ch = src[j];
        if (ch === "[") depth++;
        else if (ch === "]") depth--;
        else if (ch === ">" && depth <= 0) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    const gt = src.indexOf(">", lt);
    if (gt < 0) break;
    const raw = src.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith("/")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const spaceIdx = body.search(/\s/);
    const tagName = stripPrefix(spaceIdx < 0 ? body : body.slice(0, spaceIdx));
    const attrs: Record<string, string> = {};
    if (spaceIdx >= 0) {
      const attrRe = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g;
      const attrSrc = body.slice(spaceIdx);
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(attrSrc))) {
        const key = stripPrefix(m[1] ?? m[3] ?? "");
        attrs[key] = decode(m[2] ?? m[4] ?? "");
      }
    }
    const el: XEl = { tag: tagName, attrs, children: [], text: "" };
    stack[stack.length - 1].children.push(el);
    if (!selfClosing) stack.push(el);
  }
  return root;
}

export function child(el: XEl | undefined, tag: string): XEl | undefined {
  return el?.children.find((c) => c.tag === tag);
}

export function children(el: XEl | undefined, tag: string): XEl[] {
  return el?.children.filter((c) => c.tag === tag) ?? [];
}

export function textOf(el: XEl | undefined, tag: string): string | undefined {
  const c = child(el, tag);
  return c ? c.text.trim() : undefined;
}

export function numOf(el: XEl | undefined, tag: string): number | undefined {
  const t = textOf(el, tag);
  if (t === undefined || t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** 深度优先找第一个同名节点 */
export function find(el: XEl | undefined, tag: string): XEl | undefined {
  if (!el) return undefined;
  if (el.tag === tag) return el;
  for (const c of el.children) {
    const hit = find(c, tag);
    if (hit) return hit;
  }
  return undefined;
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === '"' ? "&quot;" : "&apos;",
  );
}
