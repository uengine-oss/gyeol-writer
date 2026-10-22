import { describe, expect, it } from 'vitest';
import { A4, newDocument, type GDocument, type Table } from '../model/doc';
import { puaView } from '../model/pua';
import { readHwpx } from '../format/hwpx/reader';
import { writeHwpx } from '../format/hwpx/writer';
import { columnWidths, modelToPM, pmToModel } from './convert';

const cell = (colSpan: number, width: number, text = '') => ({
  colSpan,
  rowSpan: 1,
  width,
  blocks: [{ type: 'paragraph' as const, para: {}, runs: text ? [{ type: 'text' as const, text, char: {} }] : [] }],
});

describe('표 열 너비 풀이', () => {
  it('줄마다 병합 구성이 다른 표에서 격자 열 너비를 구한다', () => {
    // 실제 자가진단 표 구조: [8260 | 39175(3칸)] / [39930(2칸) | 3705 | 3800]
    const t: Table = {
      type: 'table',
      borders: true,
      rows: [{ cells: [cell(1, 8260), cell(3, 39175)] }, { cells: [cell(2, 39930), cell(1, 3705), cell(1, 3800)] }],
    };
    expect(columnWidths(t)).toEqual([8260, 31670, 3705, 3800]);
  });
});

describe('편집기 변환', () => {
  it('구역과 구역별 용지가 보존된다', () => {
    const doc: GDocument = newDocument();
    const land = { ...structuredClone(A4), width: A4.height, height: A4.width, landscape: true };
    doc.sections = [
      { page: structuredClone(A4), blocks: [{ type: 'paragraph', para: {}, runs: [{ type: 'text', text: '첫 구역', char: {} }] }] },
      { page: land, blocks: [{ type: 'paragraph', para: {}, runs: [{ type: 'text', text: '가로 구역', char: {} }] }] },
    ];
    const { doc: pm, page } = modelToPM(doc);
    const back = pmToModel(pm, page, {});
    expect(back.sections).toHaveLength(2);
    expect(back.sections[1].page).toEqual(land);
  });

  it('한컴 확장 문자(PUA)는 원래 코드로 저장되고 화면에는 대체 글자를 보인다', () => {
    const doc = newDocument();
    doc.sections[0].blocks = [{ type: 'paragraph', para: {}, runs: [{ type: 'text', text: '\u{F02B1} 과제 개요', char: { bold: true } }] }];
    const { doc: pm, page } = modelToPM(doc);
    expect(pm.firstChild!.firstChild!.type.name).toBe('pua');
    const back = pmToModel(pm, page, {});
    const p = back.sections[0].blocks[0];
    expect(p.type === 'paragraph' && p.runs).toEqual([{ type: 'text', text: '\u{F02B1} 과제 개요', char: { bold: true } }]);
    expect(puaView(0xf02b1)).toEqual({ text: '1', boxed: true });
    expect(puaView(0xf0a7).text).toBe('▪');
  });
});

describe('HWPX 표 배치 속성 왕복', () => {
  it('안쪽·바깥 여백, 담은 줄, 쪽 나눔, 빈 문단 글자 크기가 보존된다', async () => {
    const doc = newDocument();
    doc.sections[0].blocks = [
      { type: 'paragraph', para: {}, runs: [], markChar: { size: 1300 } },
      {
        type: 'table',
        borders: true,
        pageBreak: true,
        inMargin: { left: 140, right: 140, top: 140, bottom: 140 },
        outMargin: { left: 140, right: 140, top: 140, bottom: 140 },
        hostLine: { lineSpacing: 160, size: 1600 },
        rows: [{ cells: [{ ...cell(1, 20000, '칸'), margin: { left: 0, right: 0, top: 0, bottom: 0 } }] }],
      },
    ];
    const back = await readHwpx(await writeHwpx(doc));
    const [p, t] = back.sections[0].blocks;
    expect(p).toMatchObject({ type: 'paragraph', markChar: { size: 1300 } });
    expect(t).toMatchObject({
      type: 'table',
      pageBreak: true,
      inMargin: { left: 140, top: 140 },
      outMargin: { top: 140, bottom: 140 },
      hostLine: { lineSpacing: 160, size: 1600 },
    });
    expect(t.type === 'table' && t.rows[0].cells[0].margin).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
  });
});
