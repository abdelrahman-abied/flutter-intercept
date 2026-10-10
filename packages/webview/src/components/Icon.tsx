// Tiny inline SVG icon set (no icon font → no font-src needed in the CSP).
const PATHS = {
  chevronRight: 'M6 3.5 10.5 8 6 12.5',
  chevronDown: 'M3.5 6 8 10.5 12.5 6',
  close: 'M4 4l8 8M12 4l-8 8',
  plus: 'M8 3v10M3 8h10',
  up: 'M8 13V3M4 7l4-4 4 4',
  down: 'M8 3v10M4 9l4 4 4-4',
  clear: 'M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.5h6.6l.7-8.5',
  play: 'M5 3.5v9l7-4.5z',
  pause: 'M5.5 3.5v9M10.5 3.5v9',
  stop: 'M3.5 3.5h9v9h-9z',
  edit: 'M10.5 2.5l3 3L6 13H3v-3z',
  copy: 'M5.5 5.5h7v8h-7zM3.5 10.5v-8h7',
  grip: 'M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01',
  export: 'M8 2.5v8M5 5.5l3-3 3 3M3 10.5v3h10v-3',
  window: 'M7 3.5H3.5v9h9V9M9.5 2.5h4v4M13.5 2.5 8 8',
  timing: 'M2.5 4h5M4.5 8h7M7.5 12h6',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg class={`icon icon-${name}`} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} fill={name === 'play' ? 'currentColor' : 'none'} stroke="currentColor"
        stroke-width={name === 'grip' ? 2.2 : 1.4} stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
