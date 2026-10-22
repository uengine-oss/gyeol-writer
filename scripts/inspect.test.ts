// HWPX/HWP 파일 내용 요약: GYEOL_INSPECT=경로 npx vitest run scripts/inspect.test.ts
import { readFileSync } from 'node:fs';
import { it } from 'vitest';
import { readHwpx } from '../src/format/hwpx/reader';
import type { Block } from '../src/model/doc';

it.skipIf(!process.env.GYEOL_INSPECT)('요약', async () => {
  const doc = await readHwpx(readFileSync(process.env.GYEOL_INSPECT!));
  const show = (blocks: Block[], depth = 0) => {
    for (const b of blocks) {
      const pad = '  '.repeat(depth);
      if (b.type === 'paragraph') {
        const runs = b.runs.map((r) => (r.type === 'text' ? `[${r.text}${r.char.bold ? ' B' : ''}${r.char.italic ? ' I' : ''}]` : `<${r.type}>`)).join('');
        console.log(`${pad}P align=${b.para.align}${b.pageBreak ? ' pageBreak' : ''} ${runs}`);
      } else {
        console.log(`${pad}TABLE ${b.rows.length}x${b.rows[0]?.cells.length} borders=${b.borders}`);
        b.rows.forEach((r) => r.cells.forEach((c) => show(c.blocks, depth + 1)));
      }
    }
  };
  show(doc.sections[0].blocks);
});
