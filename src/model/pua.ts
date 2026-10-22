// 사용자 정의 영역(PUA) 문자 표시.
// 문서에는 원래 코드 그대로 두고(저장 시 보존), 화면에만 대체 글자를 보여 준다.

export interface PuaView {
  text: string;
  /** 네모 안에 넣어 표시 */
  boxed?: boolean;
  /** 대응을 모르는 문자 */
  unknown?: boolean;
}

/** PUA 여부: BMP PUA(E000–F8FF), 보조 PUA-A(F0000–FFFFD) */
export function isPua(cp: number): boolean {
  return (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd);
}

// Windows 기호 글꼴(Wingdings)을 U+F0xx 로 옮겨 온 문자 — Word 등에서 붙여 넣은 글머리표.
// 대응은 Wingdings 글리프의 Unicode 표준 대응을 따른다.
const WINGDINGS: Record<number, string> = {
  0x6c: '●', 0x6d: '❍', 0x6e: '■', 0x6f: '□', 0x70: '◻', 0x71: '❑', 0x72: '❒', 0x73: '⬧', 0x74: '⧫',
  0x75: '◆', 0x76: '❖', 0x77: '⬥', 0x9e: '·', 0x9f: '•', 0xa1: '○', 0xa4: '◉', 0xa7: '▪', 0xa8: '◻',
  0xd8: '➢', 0xe0: '➔', 0xe8: '➔', 0xf0: '⇨', 0xfb: '✗', 0xfc: '✓', 0xfd: '☒', 0xfe: '☑',
};

export function puaView(cp: number): PuaView {
  // 한컴 확장 문자: 네모 숫자. U+F02B1 이 네모 1 임을 한글 화면과 대조해 확인했고, 이어지는 코드는 순서대로 가정한다.
  if (cp >= 0xf02b1 && cp <= 0xf02ba) return { text: String(cp - 0xf02b0), boxed: true };
  if (cp >= 0xf020 && cp <= 0xf0ff && WINGDINGS[cp - 0xf000]) return { text: WINGDINGS[cp - 0xf000] };
  return { text: String.fromCodePoint(cp), unknown: true };
}
