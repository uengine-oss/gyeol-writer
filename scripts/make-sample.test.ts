// 호환성 확인용 샘플 HWPX 생성: GYEOL_OUT=경로 npx vitest run scripts/make-sample.test.ts
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { newDocument } from '../src/model/doc';
import { writeHwpx } from '../src/format/hwpx/writer';

it.skipIf(!process.env.GYEOL_OUT)('샘플 생성', async () => {
  const doc = newDocument();
  doc.meta.title = '결 워드 호환성 시험';
  const t = (text: string, char = {}) => ({ type: 'text' as const, text, char });
  doc.sections[0].blocks = [
    { type: 'paragraph', para: { align: 'center', spaceAfter: 1000 }, runs: [t('결 워드 호환성 시험 문서', { bold: true, size: 2000, color: '#1F4E79' })] },
    { type: 'paragraph', para: {}, runs: [t('보통 글자, '), t('굵게', { bold: true }), t(', '), t('기울임', { italic: true }), t(', '), t('밑줄', { underline: true }), t(', '), t('취소선', { strike: true }), t(', '), t('빨간 글자', { color: '#C00000' }), t(', '), t('형광펜', { highlight: '#FFFF00' }), t('.')] },
    { type: 'paragraph', para: { marginLeft: 2000, indent: -1000, lineSpacing: 200 }, runs: [t('왼쪽 여백 20pt, 내어쓰기 10pt, 줄 간격 200%인 문단입니다. 이 문단은 두 줄 이상이 되도록 충분히 길게 씁니다. 한글에서 열었을 때 둘째 줄부터 들여쓰기가 보여야 합니다.')] },
    { type: 'paragraph', para: { align: 'right' }, runs: [t('오른쪽 정렬'), { type: 'tab' }, t('탭 뒤 글자', { fontHangul: '바탕', fontLatin: '바탕', size: 1200 })] },
    {
      type: 'table', borders: true, rows: [
        { cells: [
          { colSpan: 1, rowSpan: 1, width: 14000, background: '#D9E2F3', blocks: [{ type: 'paragraph', para: { align: 'center' }, runs: [t('항목', { bold: true })] }] },
          { colSpan: 2, rowSpan: 1, width: 28520, background: '#D9E2F3', blocks: [{ type: 'paragraph', para: { align: 'center' }, runs: [t('내용 (두 칸 병합)', { bold: true })] }] },
        ] },
        { cells: [
          { colSpan: 1, rowSpan: 2, width: 14000, blocks: [{ type: 'paragraph', para: {}, runs: [t('세로 병합')] }] },
          { colSpan: 1, rowSpan: 1, width: 14260, blocks: [{ type: 'paragraph', para: {}, runs: [t('A')] }] },
          { colSpan: 1, rowSpan: 1, width: 14260, blocks: [{ type: 'paragraph', para: {}, runs: [t('B')] }] },
        ] },
        { cells: [
          { colSpan: 1, rowSpan: 1, width: 14260, blocks: [{ type: 'paragraph', para: {}, runs: [t('C')] }] },
          { colSpan: 1, rowSpan: 1, width: 14260, blocks: [{ type: 'paragraph', para: {}, runs: [t('D')] }] },
        ] },
      ],
    },
    { type: 'paragraph', para: {}, runs: [t('표 아래 문단.')] },
    { type: 'paragraph', para: {}, pageBreak: true, runs: [t('둘째 쪽 (쪽 나눔)', { size: 1400 })] },
  ];
  writeFileSync(process.env.GYEOL_OUT!, await writeHwpx(doc));
});
