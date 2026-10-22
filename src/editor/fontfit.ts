// 한글 글꼴이 없는 환경에서 줄바꿈 위치를 한글과 맞추기 위한 글자 폭 보정.
//
// 근거: 실제 HWPX 문서 26개에 한글이 저장한 줄 배치 캐시(lineseg textpos)에서 '꽉 찬 줄' 3,312개를 뽑아,
// 같은 글자를 대체 글꼴로 잰 폭과 비교해 맞췄다(scratch tools/linesamples.py·measure2.js).
//  - 빈칸: 한글은 글꼴 자체 빈칸이 아니라(useFontSpace="0") 글자 크기의 절반(0.5em)을 쓴다.
//  - 글자: 대체 글꼴과의 폭 차이를 글꼴별 자간(em)으로 보정한다.
// 결과: 한글과 같은 위치에서 줄이 바뀌는 비율 약 55% → 83%.

export const SPACE_EM = 0.5;

/** 글꼴별 글자 폭 보정(em) — 표본 30줄 이상인 글꼴만 */
const FIT: Record<string, number> = {
  '맑은 고딕': 0,
  휴먼명조: -0.023,
  함초롬바탕: -0.041,
  한양신명조: -0.01,
  한양중고딕: 0.113,
  바탕: -0.018,
  돋움: 0.107,
  돋움체: 0.102,
};

const SANS = /고딕|돋움|굴림|Gothic|Dotum|Gulim|Sans/i;
const SERIF = /명조|바탕|궁서|Myeongjo|Myungjo|Batang|Gungsuh|Serif|Times|Georgia/i;

/** 표에 없는 글꼴은 같은 계열 평균값 */
export function letterFit(name?: string): number {
  if (!name) return 0;
  if (name in FIT) return FIT[name];
  if (/맑은|Malgun/i.test(name)) return 0;
  if (SANS.test(name)) return 0.1;
  if (SERIF.test(name)) return -0.02;
  return 0;
}

const spaceCache = new Map<string, number>();

/** 실제로 쓰일 글꼴(대체 글꼴 포함)의 빈칸 폭(em) */
function nativeSpaceEm(stack: string): number {
  let v = spaceCache.get(stack);
  if (v !== undefined) return v;
  v = 0.3;
  if (typeof document !== 'undefined') {
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx) {
      ctx.font = `100px ${stack}`;
      v = ctx.measureText(' ').width / 100;
    }
  }
  spaceCache.set(stack, v);
  return v;
}

/** 글꼴 보정 CSS 변수: --fls(자간 보정), --fws(빈칸을 0.5em 으로 맞추는 낱말 간격) */
export function fitVars(stack: string, hangul?: string): string {
  if ((globalThis as { __gyeolNoFit?: boolean }).__gyeolNoFit) return '';
  const ls = letterFit(hangul);
  const ws = SPACE_EM - nativeSpaceEm(stack) - ls;
  return `--fls:${ls.toFixed(3)}em;--fws:${ws.toFixed(3)}em`;
}
