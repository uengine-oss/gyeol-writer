import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { readHwp5, readHwp5Preview } from './reader';
import { plainText, type Block, type GDocument } from '../../model/doc';

// 실제 HWP 문서 사본은 저장소에 넣지 않는다: GYEOL_HWP5_SAMPLES=폴더 로 지정. 없으면 건너뛴다.
const DIR = process.env.GYEOL_HWP5_SAMPLES ?? '';
const SAMPLES: { file: string; tables: boolean }[] = [
  { file: 'memo_preset.hwp', tables: false },
  { file: 'sample1.hwp', tables: true },
  { file: 'sample2.hwp', tables: true },
  { file: 'sample3.hwp', tables: true },
  { file: 'sample4.hwp', tables: true },
  { file: 'sample5.hwp', tables: true },
  { file: 'sample6.hwp', tables: true },
  { file: 'sample7.hwp', tables: true },
  { file: 'sample8.hwp', tables: true },
];

function countTables(doc: GDocument): number {
  let n = 0;
  const walk = (bs: Block[]) => {
    for (const b of bs)
      if (b.type === 'table') {
        n++;
        for (const r of b.rows) for (const c of r.cells) walk(c.blocks);
      }
  };
  for (const s of doc.sections) walk(s.blocks);
  return n;
}

/** 미리보기 앞부분(약 100자)의 낱말들이 본문 텍스트에 순서대로 나타나는지 */
function previewInOrder(preview: string, text: string): { ok: boolean; missing?: string } {
  const body = text.replace(/\s+/g, '');
  const words = preview.split(/[\s<>]+/).filter(Boolean);
  let used = 0;
  let at = 0;
  for (const w of words) {
    if (used >= 100) break;
    used += w.length;
    const i = body.indexOf(w, at);
    if (i < 0) return { ok: false, missing: w };
    at = i + w.length;
  }
  return { ok: used > 0 };
}

describe('readHwp5', () => {
  for (const s of SAMPLES) {
    const path = `${DIR}/${s.file}`;
    it.skipIf(!existsSync(path))(`reads ${s.file}`, async () => {
      const bytes = new Uint8Array(readFileSync(path));
      const doc = await readHwp5(bytes);
      expect(doc.sections.length).toBeGreaterThan(0);
      const text = plainText(doc);
      expect(text.replace(/\s/g, '').length).toBeGreaterThan(20);

      const prv = readHwp5Preview(bytes);
      const r = previewInOrder(prv, text);
      expect(r, `missing "${r.missing}"`).toEqual({ ok: true });

      if (s.tables) expect(countTables(doc)).toBeGreaterThan(0);

      for (const sec of doc.sections) {
        const short = Math.min(sec.page.width, sec.page.height);
        const long = Math.max(sec.page.width, sec.page.height);
        expect(short).toBeGreaterThan(30000);
        expect(long).toBeLessThan(130000);
        expect(sec.page.landscape).toBe(sec.page.width > sec.page.height);
      }
    });
  }

  it.skipIf(!existsSync(`${DIR}/sample4.hwp`))('maps char/para shapes and A4 page', async () => {
    const doc = await readHwp5(new Uint8Array(readFileSync(`${DIR}/sample4.hwp`)));
    const page = doc.sections[0].page;
    expect(Math.abs(page.width - 59528)).toBeLessThan(10);
    expect(Math.abs(page.height - 84186)).toBeLessThan(10);
    const paras = doc.sections[0].blocks.filter((b) => b.type === 'paragraph');
    const run = paras.flatMap((p) => (p.type === 'paragraph' ? p.runs : [])).find((r) => r.type === 'text');
    expect(run && run.type === 'text' && run.char.size).toBeGreaterThan(0);
    expect(run && run.type === 'text' && run.char.color).toMatch(/^#[0-9A-F]{6}$/);
    expect(run && run.type === 'text' && run.char.fontHangul).toBeTruthy();
  });

  it.skipIf(!existsSync(`${DIR}/sample6.hwp`))('extracts embedded images', async () => {
    const doc = await readHwp5(new Uint8Array(readFileSync(`${DIR}/sample6.hwp`)));
    const imgs: { ext: string; data: Uint8Array }[] = [];
    const walk = (bs: Block[]) => {
      for (const b of bs)
        if (b.type === 'table') for (const r of b.rows) for (const c of r.cells) walk(c.blocks);
        else for (const r of b.runs) if (r.type === 'image') imgs.push(r);
    };
    for (const s of doc.sections) walk(s.blocks);
    expect(imgs.length).toBeGreaterThan(0);
    const png = imgs.find((i) => i.ext === 'png');
    if (png) expect([...png.data.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    const bmp = imgs.find((i) => i.ext === 'bmp');
    if (bmp) expect([...bmp.data.subarray(0, 2)]).toEqual([0x42, 0x4d]);
  });

  it('rejects non-HWP input', async () => {
    await expect(readHwp5(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });
});
