// 결 워드 고유 아이콘 (20×20, 선 기반)
const s = (body: string) =>
  `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS: Record<string, string> = {
  new: s('<path d="M5 2.5h6.5L15 6v11.5H5z"/><path d="M11.5 2.5V6H15"/><path d="M10 9v5M7.5 11.5h5"/>'),
  open: s('<path d="M2.5 5.5v10h13l2-7h-13l-2 7"/><path d="M2.5 5.5V4h5l1.5 1.5h6v3"/>'),
  save: s('<path d="M3.5 3.5h10l3 3v10h-13z"/><path d="M6.5 3.5v4h6v-4"/><rect x="6" y="11" width="8" height="5.5"/>'),
  cut: s('<circle cx="6" cy="14.5" r="2.5"/><circle cx="14" cy="14.5" r="2.5"/><path d="M7.5 12.5 14 3M12.5 12.5 6 3"/>'),
  copy: s('<rect x="6.5" y="6.5" width="10" height="10" rx="1"/><path d="M3.5 13V4.5a1 1 0 0 1 1-1H13"/>'),
  paste: s('<rect x="4" y="4" width="12" height="13.5" rx="1"/><path d="M7.5 4V2.5h5V4"/><path d="M7 9h6M7 12h6M7 15h3.5"/>'),
  undo: s('<path d="M6 8H13a4 4 0 0 1 0 8H8"/><path d="M8.5 5 5.5 8l3 3"/>'),
  redo: s('<path d="M14 8H7a4 4 0 0 0 0 8h5"/><path d="M11.5 5l3 3-3 3"/>'),
  table: s('<rect x="2.5" y="3.5" width="15" height="13" rx="1"/><path d="M2.5 8h15M2.5 12.5h15M7.5 3.5v13M12.5 3.5v13"/>'),
  image: s('<rect x="2.5" y="3.5" width="15" height="13" rx="1"/><circle cx="7" cy="8" r="1.5"/><path d="m3 15 4.5-4.5 3 3 2.5-2.5 4.5 4.5"/>'),
  pagebreak: s('<path d="M4.5 2.5v5h11v-5"/><path d="M4.5 17.5v-5h11v5"/><path d="M2 10h2M6 10h2M10 10h2M14 10h2" stroke-dasharray="0"/>'),
  symbol: s('<path d="M10 3.5 11.8 8l4.7.3-3.6 3 1.2 4.6L10 13.4l-4.1 2.5 1.2-4.6-3.6-3L8.2 8z"/>'),
  charshape: s('<path d="M3 16.5 7.5 4h1L13 16.5M4.6 12.5h6.8"/><path d="M14 9.5h3.5M15.75 7.75v3.5"/>'),
  parashape: s('<path d="M3 4h14M6 8h11M3 12h14M6 16h11"/><path d="M3 7.5v2" />'),
  page: s('<path d="M5 2.5h10v15H5z"/><path d="M7.5 5.5h5M7.5 8h5M7.5 10.5h5M7.5 13h3"/>'),
  find: s('<circle cx="8.5" cy="8.5" r="5"/><path d="m12.3 12.3 4.7 4.7"/>'),
  print: s('<path d="M5.5 7V2.5h9V7"/><rect x="2.5" y="7" width="15" height="7" rx="1"/><path d="M5.5 11.5h9v6h-9z"/>'),
  pdf: s('<path d="M5 2.5h6.5L15 6v11.5H5z"/><path d="M11.5 2.5V6H15"/><path d="M7 14.5v-4h1.3a1.2 1.2 0 0 1 0 2.4H7M11 10.5v4h.8a1.6 1.6 0 0 0 1.6-1.6v-.8a1.6 1.6 0 0 0-1.6-1.6z"/>'),
  info: s('<circle cx="10" cy="10" r="7.5"/><path d="M10 9v5M10 6.2v.3"/>'),
  bold: '<b style="font:700 15px/1 system-ui">가</b>',
  italic: '<i style="font:italic 500 15px/1 Georgia,serif">가</i>',
  underline: '<u style="font:500 15px/1 system-ui;text-underline-offset:3px">가</u>',
  strike: '<s style="font:500 15px/1 system-ui">가</s>',
  sup: '<span style="font:500 13px/1 system-ui">x<sup style="font-size:9px">2</sup></span>',
  sub: '<span style="font:500 13px/1 system-ui">x<sub style="font-size:9px">2</sub></span>',
  alignLeft: s('<path d="M3 4.5h14M3 8.5h9M3 12.5h14M3 16.5h9"/>'),
  alignCenter: s('<path d="M3 4.5h14M5.5 8.5h9M3 12.5h14M5.5 16.5h9"/>'),
  alignRight: s('<path d="M3 4.5h14M8 8.5h9M3 12.5h14M8 16.5h9"/>'),
  alignJustify: s('<path d="M3 4.5h14M3 8.5h14M3 12.5h14M3 16.5h14"/>'),
  alignDistribute: s('<path d="M3 4.5h14M3 8.5h14M3 12.5h14M3 16.5h14"/><path d="M5 15l-2 1.5L5 18M15 15l2 1.5-2 1.5"/>'),
  indentMore: s('<path d="M8 4.5h9M8 8.5h9M8 12.5h9M3 16.5h14"/><path d="m3 7 3 2.5L3 12"/>'),
  indentLess: s('<path d="M8 4.5h9M8 8.5h9M8 12.5h9M3 16.5h14"/><path d="M6 7 3 9.5 6 12"/>'),
  textColor: '<span class="swatch-letter">가</span>',
  highlight: s('<path d="m4 16 2.5-.5 9-9-2-2-9 9z"/><path d="M11.5 6.5l2 2"/>'),
  marks: '<span style="font:600 15px/1 system-ui">¶</span>',
  zoomIn: s('<circle cx="8.5" cy="8.5" r="5"/><path d="m12.3 12.3 4.7 4.7M6.5 8.5h4M8.5 6.5v4"/>'),
  zoomOut: s('<circle cx="8.5" cy="8.5" r="5"/><path d="m12.3 12.3 4.7 4.7M6.5 8.5h4"/>'),
  chevron: '<svg viewBox="0 0 10 10" width="8" height="8"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  close: s('<path d="m5 5 10 10M15 5 5 15"/>'),
};

/** 앱 로고: 물결(결) 세 줄 */
export const LOGO = `<svg viewBox="0 0 32 32" width="22" height="22"><rect width="32" height="32" rx="8" fill="#2F6FEB"/><path d="M7 11c3-2.5 6 2.5 9 0s6-2.5 9 0M7 16c3-2.5 6 2.5 9 0s6-2.5 9 0M7 21c3-2.5 6 2.5 9 0s6-2.5 9 0" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>`;
