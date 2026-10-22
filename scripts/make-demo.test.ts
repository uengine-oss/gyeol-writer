// AI 도우미 시연용 문서 생성: GYEOL_OUT=경로 npx vitest run scripts/make-demo.test.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { newDocument, type Block } from '../src/model/doc';
import { writeHwpx } from '../src/format/hwpx/writer';

it.skipIf(!process.env.GYEOL_OUT)('시연 문서 생성', async () => {
  const doc = newDocument();
  doc.meta.title = '사내 문서 작성 AI 도입 계획(안)';
  const t = (text: string, char = {}) => ({ type: 'text' as const, text, char });
  const p = (text: string, para = {}, char = {}): Block => ({ type: 'paragraph', para, runs: text ? [t(text, char)] : [] });
  const h = (text: string): Block => ({ type: 'paragraph', para: { spaceBefore: 600, spaceAfter: 300 }, style: '개요 1', runs: [t(text, { bold: true, size: 1400 })] } as Block);
  const chart = readFileSync('samples/demo-chart.png');
  doc.sections[0].blocks = [
    p('사내 문서 작성 AI 도입 계획(안)', { align: 'center', spaceAfter: 800 }, { bold: true, size: 2000, color: '#1F3864' }),
    p('2026. 10.  경영지원팀', { align: 'right', spaceAfter: 600 }, { size: 1000, color: '#555555' }),
    h('1. 추진 배경'),
    p('요즘 보고서나 공문 같은 거 쓰는데 시간이 너무 많이 걸리고 있음. 부서마다 양식도 다르고 사람마다 쓰는 방식이 달라서 검토하는 사람도 힘들어하고, 결국 몇 번씩 다시 고치는 일이 계속 생기고 있는 상황이라서 뭔가 개선이 필요하다고 봄.'),
    h('2. 현황'),
    p('부서별로 한 사람이 일주일에 문서 작성에 쓰는 시간을 조사한 결과는 아래와 같다.'),
    { type: 'paragraph', para: { align: 'center' }, runs: [{ type: 'image', data: new Uint8Array(chart), ext: 'png', width: 30000, height: Math.round((30000 * 520) / 900) }] },
    h('3. 추진 일정'),
    p(''),
    h('4. 기대 효과'),
    p('문서 작성 시간 단축, 양식 통일, 검토 부담 감소.'),
  ];
  writeFileSync(process.env.GYEOL_OUT!, await writeHwpx(doc));
});
