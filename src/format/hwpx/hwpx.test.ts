import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { newDocument, plainText, type GDocument } from '../../model/doc';
import { readHwpx } from './reader';
import { writeHwpx } from './writer';

// 실제 문서 샘플은 저장소 밖(개인 문서)에 있으므로 환경변수로 위치를 받는다.
const SAMPLES = process.env.GYEOL_HWPX_SAMPLES ?? '';
const samples = SAMPLES && existsSync(SAMPLES) ? readdirSync(SAMPLES).filter((f) => /\.(hwpx|hwtx)$/.test(f)) : [];
const norm = (s: string) => s.replace(/\s+/g, '');

describe('HWPX 쓰기 → 읽기', () => {
  it('서식·표·쪽 나눔이 왕복 보존된다', async () => {
    const doc: GDocument = newDocument();
    doc.meta.title = '왕복 시험';
    doc.sections[0].blocks = [
      {
        type: 'paragraph',
        style: '개요 1',
        para: { align: 'center', lineSpacing: 180, marginLeft: 1500, indent: -500 },
        runs: [
          { type: 'text', text: '굵은 제목 ', char: { bold: true, size: 1600, color: '#1F4E79' } },
          { type: 'text', text: '<기울임 & 밑줄>', char: { italic: true, underline: true } },
          { type: 'tab' },
          { type: 'text', text: '끝', char: {} },
        ],
      },
      {
        type: 'table',
        borders: true,
        rows: [
          { cells: [{ colSpan: 2, rowSpan: 1, blocks: [{ type: 'paragraph', para: {}, runs: [{ type: 'text', text: '병합 칸', char: {} }] }], background: '#F2F2F2' }] },
          {
            cells: [
              { colSpan: 1, rowSpan: 1, blocks: [{ type: 'paragraph', para: {}, runs: [{ type: 'text', text: 'A', char: {} }] }] },
              { colSpan: 1, rowSpan: 1, blocks: [{ type: 'paragraph', para: {}, runs: [{ type: 'text', text: 'B', char: { strike: true } }] }] },
            ],
          },
        ],
      },
      { type: 'paragraph', para: {}, pageBreak: true, runs: [{ type: 'text', text: '둘째 쪽', char: {} }] },
    ];

    const bytes = await writeHwpx(doc);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files)[0]).toBe('mimetype');

    const back = await readHwpx(bytes);
    expect(back.meta.title).toBe('왕복 시험');
    const [p0, t, p2] = back.sections[0].blocks;
    expect(p0.type).toBe('paragraph');
    if (p0.type !== 'paragraph') return;
    expect(p0.style).toBe('개요 1');
    expect(p0.para).toMatchObject({ align: 'center', lineSpacing: 180, marginLeft: 1500, indent: -500 });
    expect(p0.runs[0]).toMatchObject({ type: 'text', text: '굵은 제목 ', char: { bold: true, size: 1600, color: '#1F4E79' } });
    expect(p0.runs[1]).toMatchObject({ text: '<기울임 & 밑줄>', char: { italic: true, underline: true } });
    expect(p0.runs[2]).toEqual({ type: 'tab' });
    expect(t.type).toBe('table');
    if (t.type !== 'table') return;
    expect(t.borders).toBe(true);
    expect(t.rows[0].cells[0]).toMatchObject({ colSpan: 2, background: '#F2F2F2' });
    expect(t.rows[1].cells[1].blocks[0]).toMatchObject({ runs: [{ text: 'B', char: { strike: true } }] });
    expect(p2).toMatchObject({ pageBreak: true });
  });

  it('그림이 BinData 로 저장되고 다시 읽힌다', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const doc = newDocument();
    doc.sections[0].blocks = [{ type: 'paragraph', para: {}, runs: [{ type: 'image', data: png, ext: 'png', width: 14173, height: 7086 }] }];
    const back = await readHwpx(await writeHwpx(doc));
    const p = back.sections[0].blocks[0];
    expect(p.type === 'paragraph' && p.runs[0]).toMatchObject({ type: 'image', ext: 'png', width: 14173, height: 7086 });
  });
});

it('취소선 shape="3D" 는 취소선이 아니다', async () => {
  const doc = newDocument();
  doc.sections[0].blocks = [{ type: 'paragraph', para: {}, runs: [{ type: 'text', text: '가', char: { strike: true } }] }];
  const zip = await JSZip.loadAsync(await writeHwpx(doc));
  const header = (await zip.file('Contents/header.xml')!.async('string')).replaceAll('strikeout shape="SOLID"', 'strikeout shape="3D"');
  zip.file('Contents/header.xml', header);
  const back = await readHwpx(await zip.generateAsync({ type: 'uint8array' }));
  const p = back.sections[0].blocks[0];
  expect(p.type === 'paragraph' && p.runs[0].type === 'text' && p.runs[0].char.strike).toBeFalsy();
});

describe.skipIf(!samples.length)('실제 한글 문서', () => {
  for (const f of samples) {
    it(`${f}: 읽기 → 쓰기 → 읽기에서 본문 텍스트가 같다`, async () => {
      const bytes = readFileSync(join(SAMPLES, f));
      const doc = await readHwpx(bytes);
      const text = plainText(doc);
      // 한글이 저장한 미리보기 텍스트의 앞부분이 본문에 있어야 한다
      const prv = await (await JSZip.loadAsync(bytes)).file('Preview/PrvText.txt')?.async('string');
      if (prv) {
        // 미리보기는 화면 배치 순서라 본문 순서와 다를 수 있다: 줄 단위 재현율로 본다
        const body = norm(text);
        const lines = prv.split(/[\r\n\t]+|<[^>]*>/).map(norm).filter((l) => l.length >= 4);
        const missing = lines.filter((l) => !body.includes(l));
        if (missing.length) console.log(f, 'missing', missing.length, '/', lines.length, missing.slice(0, 5));
        expect(missing.length / Math.max(lines.length, 1)).toBeLessThan(0.1);
      }
      const again = await readHwpx(await writeHwpx(doc));
      expect(norm(plainText(again))).toBe(norm(text));
      expect(again.sections[0].page).toEqual(doc.sections[0].page);
    }, 30000);
  }
});
