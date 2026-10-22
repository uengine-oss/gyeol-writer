import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from './schema';
import { cleanReply, docToMarkdown, markdownToBlocks, replaceWithMarkdown } from './markdown';

const N = schema.nodes;
const p = (text: string, attrs?: Record<string, unknown>) => N.paragraph.create(attrs, text ? schema.text(text) : undefined);
const docOf = (...blocks: ReturnType<typeof p>[]) => N.doc.create(null, blocks);
const texts = (doc: ReturnType<typeof docOf>) => {
  const out: string[] = [];
  doc.forEach((b) => out.push(b.type === N.table ? `[표 ${b.childCount}줄]` : `${b.attrs.style ? `(${b.attrs.style})` : ''}${b.textContent}`));
  return out;
};

describe('마크다운 → 문서', () => {
  it('제목·목록·문단·표를 나눈다', () => {
    const blocks = markdownToBlocks('# 개요\n\n첫 문단입니다.\n\n- 하나\n- **둘**\n\n| 항목 | 값 |\n|---|---|\n| 가 | 1 |\n| 나 | 2 |');
    expect(blocks.map((b) => (b.type === N.table ? `table:${b.childCount}` : `${b.attrs.style ?? ''}:${b.textContent}`))).toEqual([
      '개요 1:개요',
      ':첫 문단입니다.',
      ':• 하나',
      ':• 둘',
      'table:3',
    ]);
    // **둘** 은 굵게
    const bold = blocks[3].child(1);
    expect(bold.text).toBe('둘');
    expect(schema.marks.bold.isInSet(bold.marks)).toBeTruthy();
    // 표 머리글 줄은 배경색
    expect(blocks[4].child(0).child(0).attrs.background).toBe('#EEF2F8');
  });

  it('응답을 감싼 코드 울타리를 걷어 낸다', () => {
    expect(cleanReply('```markdown\n안녕\n```')).toBe('안녕');
  });
});

describe('문서 → 마크다운', () => {
  it('제목·굵게·표를 마크다운으로', () => {
    const doc = docOf(
      p('제목', { style: '개요 1' }),
      N.paragraph.create(null, [schema.text('보통 '), schema.text('굵게', [schema.marks.bold.create()])]),
    );
    expect(docToMarkdown(doc)).toBe('# 제목\n\n보통 **굵게**');
  });
});

describe('넣기·바꾸기', () => {
  const apply = (doc: ReturnType<typeof docOf>, from: number, to: number, md: string) => {
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
    return replaceWithMarkdown(state.tr, from, to, md, 600).doc;
  };

  it('한 문단 응답은 선택한 글자만 바꾼다', () => {
    const doc = docOf(p('가나다라마'));
    expect(texts(apply(doc, 2, 4, '하하'))).toEqual(['가하하라마']);
  });

  it('여러 블록 응답은 문단을 나눠 끼운다', () => {
    const doc = docOf(p('앞글뒤글'));
    // '앞글|뒤글' 사이에 제목 + 문단
    expect(texts(apply(doc, 3, 3, '## 새 제목\n\n새 문단'))).toEqual(['앞글', '(개요 2)새 제목', '새 문단뒤글']);
  });

  it('빈 문단에 넣으면 그 문단을 바꾼다', () => {
    const doc = docOf(p('첫'), p(''), p('끝'));
    // 빈 문단 안쪽 위치: 첫(3) + 1
    expect(texts(apply(doc, 4, 4, '# 제목\n\n본문\n\n| a | b |\n|---|---|\n| 1 | 2 |'))).toEqual(['첫', '(개요 1)제목', '본문', '[표 2줄]', '끝']);
  });
});
