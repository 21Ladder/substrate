import type { JSX } from "solid-js";

// Schlichte, eigene Linien-Icons (16×16), angelehnt an die Notion-Ikonografie.

type P = JSX.SvgSVGAttributes<SVGSVGElement>;

const base = (children: JSX.Element, props: P = {}) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" {...props}>
    {children}
  </svg>
);

export const IconPage = (p: P) =>
  base(
    <>
      <path d="M4 1.75h5.25L12.5 5v8.5a.75.75 0 0 1-.75.75h-7.5a.75.75 0 0 1-.75-.75V2.5a.75.75 0 0 1 .75-.75z" />
      <path d="M9 1.75V5.25h3.5" />
      <path d="M5.75 8h4.5M5.75 10.5h4.5" />
    </>,
    p,
  );
export const IconPageEmpty = (p: P) =>
  base(
    <>
      <path d="M4 1.75h5.25L12.5 5v8.5a.75.75 0 0 1-.75.75h-7.5a.75.75 0 0 1-.75-.75V2.5a.75.75 0 0 1 .75-.75z" />
      <path d="M9 1.75V5.25h3.5" />
    </>,
    p,
  );
export const IconTable = (p: P) =>
  base(
    <>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.25" />
      <path d="M1.75 6.25h12.5M1.75 9.75h12.5M6 6.25v7" />
    </>,
    p,
  );
export const IconBoard = (p: P) =>
  base(
    <>
      <rect x="1.75" y="2.25" width="3.5" height="11.5" rx="0.8" />
      <rect x="6.25" y="2.25" width="3.5" height="7.5" rx="0.8" />
      <rect x="10.75" y="2.25" width="3.5" height="9.5" rx="0.8" />
    </>,
    p,
  );
export const IconList = (p: P) =>
  base(
    <>
      <path d="M5.5 4h8.5M5.5 8h8.5M5.5 12h8.5" />
      <circle cx="2.5" cy="4" r="0.6" fill="currentColor" />
      <circle cx="2.5" cy="8" r="0.6" fill="currentColor" />
      <circle cx="2.5" cy="12" r="0.6" fill="currentColor" />
    </>,
    p,
  );
export const IconGallery = (p: P) =>
  base(
    <>
      <rect x="1.75" y="1.75" width="5.5" height="5.5" rx="1" />
      <rect x="8.75" y="1.75" width="5.5" height="5.5" rx="1" />
      <rect x="1.75" y="8.75" width="5.5" height="5.5" rx="1" />
      <rect x="8.75" y="8.75" width="5.5" height="5.5" rx="1" />
    </>,
    p,
  );
export const IconCalendar = (p: P) =>
  base(
    <>
      <rect x="1.75" y="2.75" width="12.5" height="11.5" rx="1.25" />
      <path d="M1.75 6.25h12.5M5 1.25v3M11 1.25v3" />
    </>,
    p,
  );
export const IconGraph = (p: P) =>
  base(
    <>
      <circle cx="3.5" cy="4" r="1.75" />
      <circle cx="12.5" cy="3.5" r="1.75" />
      <circle cx="8" cy="12" r="1.75" />
      <circle cx="12.5" cy="10.5" r="1.25" />
      <path d="M5.1 4.9l2.1 5.4M5.2 3.9l5.6-.3M11.6 5l-2.8 5.4M9.7 11.6l1.6-.7" />
    </>,
    p,
  );
export const IconSearch = (p: P) =>
  base(
    <>
      <circle cx="7" cy="7" r="4.75" />
      <path d="M10.5 10.5l3.75 3.75" />
    </>,
    p,
  );
export const IconPlus = (p: P) => base(<path d="M8 2.5v11M2.5 8h11" />, p);
export const IconMore = (p: P) =>
  base(
    <>
      <circle cx="3" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="13" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </>,
    p,
  );
export const IconChevronRight = (p: P) => base(<path d="M6 3.5L10.5 8 6 12.5" />, p);
export const IconChevronDown = (p: P) => base(<path d="M3.5 6L8 10.5 12.5 6" />, p);
export const IconChevronLeft = (p: P) => base(<path d="M10 3.5L5.5 8l4.5 4.5" />, p);
export const IconArrowLeft = (p: P) => base(<path d="M13 8H3M7 4L3 8l4 4" />, p);
export const IconArrowRight = (p: P) => base(<path d="M3 8h10M9 4l4 4-4 4" />, p);
export const IconTrash = (p: P) =>
  base(
    <>
      <path d="M2.5 4h11M6.25 4V2.5h3.5V4M4 4l.6 9.1a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L12 4" />
    </>,
    p,
  );
export const IconStar = (p: P) => base(<path d="M8 1.75l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.5l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />, p);
export const IconStarFilled = (p: P) =>
  base(<path d="M8 1.75l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.5l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="currentColor" />, { ...p, style: "color: rgb(233,177,62)" });
export const IconSidebar = (p: P) =>
  base(
    <>
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.5" />
      <path d="M6 2.25v11.5" />
    </>,
    p,
  );
export const IconDoubleChevronLeft = (p: P) => base(<path d="M8 3.5L3.5 8 8 12.5M12.5 3.5L8 8l4.5 4.5" />, p);
export const IconDoubleChevronRight = (p: P) => base(<path d="M3.5 3.5L8 8l-4.5 4.5M8 3.5L12.5 8 8 12.5" />, p);
export const IconImport = (p: P) =>
  base(
    <>
      <path d="M8 1.75v8.5M4.75 7l3.25 3.25L11.25 7" />
      <path d="M2.25 11v2.25h11.5V11" />
    </>,
    p,
  );
export const IconExport = (p: P) =>
  base(
    <>
      <path d="M8 10.25v-8.5M4.75 5L8 1.75 11.25 5" />
      <path d="M2.25 11v2.25h11.5V11" />
    </>,
    p,
  );
export const IconSettings = (p: P) =>
  base(
    <>
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 1.5v1.75M8 12.75v1.75M14.5 8h-1.75M3.25 8H1.5M12.6 3.4l-1.25 1.25M4.65 11.35L3.4 12.6M12.6 12.6l-1.25-1.25M4.65 4.65L3.4 3.4" />
    </>,
    p,
  );
export const IconClock = (p: P) =>
  base(
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.5V8l2.25 1.5" />
    </>,
    p,
  );
export const IconLink = (p: P) =>
  base(
    <>
      <path d="M6.75 9.25a2.5 2.5 0 0 0 3.5 0l2.5-2.5a2.5 2.5 0 0 0-3.5-3.5l-.75.75" />
      <path d="M9.25 6.75a2.5 2.5 0 0 0-3.5 0l-2.5 2.5a2.5 2.5 0 0 0 3.5 3.5l.75-.75" />
    </>,
    p,
  );
export const IconDuplicate = (p: P) =>
  base(
    <>
      <rect x="5.25" y="5.25" width="9" height="9" rx="1.25" />
      <path d="M10.75 5.25V3a1.25 1.25 0 0 0-1.25-1.25H3A1.25 1.25 0 0 0 1.75 3v6.5A1.25 1.25 0 0 0 3 10.75h2.25" />
    </>,
    p,
  );
export const IconTurnInto = (p: P) =>
  base(
    <>
      <path d="M2.5 5.5h9l-2.5-2.5M13.5 10.5h-9l2.5 2.5" />
    </>,
    p,
  );
export const IconPalette = (p: P) =>
  base(
    <>
      <path d="M8 1.75a6.25 6.25 0 1 0 0 12.5c.9 0 1.25-.6 1.25-1.2 0-.8-.6-1.1-.6-1.8 0-.7.55-1.25 1.25-1.25h1.6a2.75 2.75 0 0 0 2.75-2.75c0-3.1-2.8-5.5-6.25-5.5z" />
      <circle cx="4.75" cy="7.5" r="0.75" fill="currentColor" />
      <circle cx="7" cy="4.75" r="0.75" fill="currentColor" />
      <circle cx="10.25" cy="5.25" r="0.75" fill="currentColor" />
    </>,
    p,
  );
export const IconMove = (p: P) =>
  base(
    <>
      <path d="M2.25 8h8.5M7.5 4.75L10.75 8 7.5 11.25" />
      <path d="M13.75 2.5v11" />
    </>,
    p,
  );
export const IconFilter = (p: P) => base(<path d="M2 3.25h12M4.5 8h7M6.75 12.75h2.5" />, p);
export const IconSort = (p: P) =>
  base(
    <>
      <path d="M4.5 2.5v11M2 11l2.5 2.5L7 11M11.5 13.5v-11M9 5l2.5-2.5L14 5" />
    </>,
    p,
  );
export const IconOpen = (p: P) =>
  base(
    <>
      <path d="M9.5 2h4.5v4.5M14 2L8.5 7.5" />
      <path d="M12 9.5v3.25a1.25 1.25 0 0 1-1.25 1.25h-7.5A1.25 1.25 0 0 1 2 12.75v-7.5A1.25 1.25 0 0 1 3.25 4H6.5" />
    </>,
    p,
  );
export const IconClose = (p: P) => base(<path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />, p);
export const IconCheck = (p: P) => base(<path d="M3 8.5l3.25 3.25L13 4.75" />, p);
export const IconText = (p: P) => base(<path d="M3 3.5h10M8 3.5v10M5.5 13.5h5" />, p);
export const IconHash = (p: P) => base(<path d="M5.75 2l-1.5 12M11.75 2l-1.5 12M2.5 5.5h11.5M2 10.5h11.5" />, p);
export const IconSelect = (p: P) =>
  base(
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.5 7l2.5 2.5L10.5 7" />
    </>,
    p,
  );
export const IconMultiSelect = (p: P) =>
  base(
    <>
      <path d="M5.75 4h8.25M5.75 8h8.25M5.75 12h8.25" />
      <path d="M1.75 3.5l1 1 1.5-1.75M1.75 7.5l1 1 1.5-1.75M1.75 11.5l1 1 1.5-1.75" />
    </>,
    p,
  );
export const IconStatus = (p: P) =>
  base(
    <>
      <circle cx="8" cy="8" r="6.25" stroke-dasharray="2.4 1.6" />
      <path d="M8 4.5A3.5 3.5 0 0 1 8 11.5z" fill="currentColor" />
    </>,
    p,
  );
export const IconCheckbox = (p: P) =>
  base(
    <>
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M5 8.25l2 2 4-4.5" />
    </>,
    p,
  );
export const IconAt = (p: P) =>
  base(
    <>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M10.75 8v1a2 2 0 0 0 4 0V8a6.75 6.75 0 1 0-2.75 5.4" />
    </>,
    p,
  );
export const IconPhone = (p: P) => base(<path d="M5.5 2H3.75A1.75 1.75 0 0 0 2 3.9C2.5 9.5 6.5 13.5 12.1 14a1.75 1.75 0 0 0 1.9-1.75V10.5l-3-1-1.5 1.5a8 8 0 0 1-3-3L8 6.5z" />, p);
export const IconFile = (p: P) => base(<path d="M13 7.5l-5.25 5.25a3.18 3.18 0 0 1-4.5-4.5l5.6-5.6a2.12 2.12 0 0 1 3 3L6.3 11.2a1.06 1.06 0 0 1-1.5-1.5L10 4.5" />, p);
export const IconRelation = (p: P) =>
  base(
    <>
      <path d="M3 13L13 3M7 3h6v6" />
    </>,
    p,
  );
export const IconRollup = (p: P) =>
  base(
    <>
      <path d="M2.5 13.5h11M4 11V7M8 11V3M12 11V5.5" />
    </>,
    p,
  );
export const IconFormula = (p: P) => base(<path d="M11.5 2.5h-3a1.5 1.5 0 0 0-1.5 1.4L6 12.1a1.5 1.5 0 0 1-1.5 1.4H3M4.5 6.5h6M9 9l3.5 4M12.5 9L9 13" />, p);
export const IconTime = IconClock;
export const IconId = (p: P) =>
  base(
    <>
      <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.25" />
      <path d="M4.75 6v4M7.25 6h1.5a2 2 0 0 1 0 4h-1.5z" />
    </>,
    p,
  );
export const IconEye = (p: P) =>
  base(
    <>
      <path d="M1.5 8s2.5-4.75 6.5-4.75S14.5 8 14.5 8 12 12.75 8 12.75 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>,
    p,
  );
export const IconEyeOff = (p: P) =>
  base(
    <>
      <path d="M2 2l12 12M6.6 3.4A6.4 6.4 0 0 1 8 3.25C12 3.25 14.5 8 14.5 8a12 12 0 0 1-1.9 2.5M10.3 10.6A2.9 2.9 0 0 1 8 10a2 2 0 0 1-2-2 2 2 0 0 1 .5-1.3M4.1 4.6A11.4 11.4 0 0 0 1.5 8S4 12.75 8 12.75a6.3 6.3 0 0 0 2.3-.4" />
    </>,
    p,
  );
export const IconDrag = (p: P) => (
  <svg viewBox="0 0 10 16" {...p}>
    <g fill="currentColor">
      <circle cx="3" cy="3" r="1.3" />
      <circle cx="7" cy="3" r="1.3" />
      <circle cx="3" cy="8" r="1.3" />
      <circle cx="7" cy="8" r="1.3" />
      <circle cx="3" cy="13" r="1.3" />
      <circle cx="7" cy="13" r="1.3" />
    </g>
  </svg>
);
export const IconLock = (p: P) =>
  base(
    <>
      <rect x="3" y="7" width="10" height="7.25" rx="1.25" />
      <path d="M5.25 7V5a2.75 2.75 0 0 1 5.5 0v2" />
    </>,
    p,
  );
export const IconRestore = (p: P) =>
  base(
    <>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9L2.5 5.75" />
      <path d="M2.5 2.5v3.25h3.25" />
    </>,
    p,
  );
export const IconHome = (p: P) => base(<path d="M2.25 7L8 2.25 13.75 7M3.75 6v7.75h3v-4h2.5v4h3V6" />, p);
export const IconMoon = (p: P) => base(<path d="M13.5 9.5A5.75 5.75 0 0 1 6.5 2.5a5.75 5.75 0 1 0 7 7z" />, p);
export const IconImage = (p: P) =>
  base(
    <>
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.25" />
      <circle cx="5.5" cy="6" r="1.25" />
      <path d="M14.25 10.5l-3.5-3.5-7.5 6.75" />
    </>,
    p,
  );
export const IconEmoji = (p: P) =>
  base(
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.25 9.5a3.25 3.25 0 0 0 5.5 0" />
      <circle cx="5.75" cy="6.5" r="0.7" fill="currentColor" />
      <circle cx="10.25" cy="6.5" r="0.7" fill="currentColor" />
    </>,
    p,
  );
export const IconBacklink = (p: P) =>
  base(
    <>
      <path d="M6 4.5H3.25A1.25 1.25 0 0 0 2 5.75v7A1.25 1.25 0 0 0 3.25 14h7a1.25 1.25 0 0 0 1.25-1.25V10" />
      <path d="M14 2L7.5 8.5M9 2h5v5" />
    </>,
    p,
  );
