/**
 * Time-zone helpers for the editable business time zone.
 *
 *  - `isIanaTimeZone`: STRICT validation. `Intl` alone also accepts offsets ("+01:00"), abbreviations ("EST") and case variants; the
 *    editable setting must be a real IANA name ("Area/Location" or "UTC"). The same shape is enforced by the `businesses_timezone_check`
 *    database constraint (keep the two regexes in sync).
 *  - `inferTimeZoneFromPhone`: best-effort US/Canada-free NANP area code -> IANA zone, used to PRE-FILL the zone at signup. It is a hint only:
 *    a mobile number travels, and a few area codes straddle two zones. Anything not in the table (toll free, ambiguous, non-US) is `null`
 *    and the caller keeps the default / asks the owner.
 */
import { areaCodeOf } from './phone';

/** Same pattern as the DB CHECK: 'UTC' or Area/Location[/Sub] with letters, digits, '_', '+', '-'. */
export const IANA_ZONE_SHAPE = /^(?:UTC|[A-Za-z][A-Za-z_-]*(?:\/[A-Za-z0-9_+-]+)+)$/;

export function isIanaTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64 || !IANA_ZONE_SHAPE.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const EASTERN = 'America/New_York';
const CENTRAL = 'America/Chicago';
const MOUNTAIN = 'America/Denver';
const PACIFIC = 'America/Los_Angeles';

const ZONES: Record<string, string> = {
  [EASTERN]: '202 771 203 475 860 959 302 239 305 321 352 386 407 561 645 689 727 754 772 786 813 863 904 941 954 229 404 470 478 678 706 762 770 912 943 '
    + '317 463 574 260 765 812 930 502 606 859 207 339 351 413 508 617 774 781 857 978 240 301 410 443 667 231 248 269 313 517 586 616 734 810 906 947 989 679 '
    + '603 201 551 609 640 732 848 856 862 908 973 212 315 332 347 516 518 585 607 631 646 680 716 718 838 845 914 917 929 934 '
    + '252 336 704 743 828 910 919 980 984 216 220 234 330 380 419 440 513 567 614 740 937 215 223 267 272 412 445 484 570 610 717 724 814 835 878 '
    + '401 803 839 843 854 864 802 276 434 540 571 703 757 804 686 304 681 423 865',
  [CENTRAL]: '205 251 256 334 659 938 479 501 870 217 224 309 312 331 618 630 708 773 779 815 847 872 464 219 319 515 563 641 712 316 620 785 913 270 364 '
    + '225 318 337 504 985 218 320 507 612 651 763 952 228 601 662 769 314 417 573 636 660 816 975 402 531 701 405 539 572 580 918 605 615 629 731 901 931 '
    + '210 214 254 281 325 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 936 940 945 956 972 979 346 262 274 414 534 608 715 920',
  [MOUNTAIN]: '303 719 720 970 983 208 986 406 505 575 385 435 801 307 915',
  'America/Phoenix': '480 520 602 623 928',
  [PACIFIC]: '209 213 279 310 323 341 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747 760 805 818 820 831 840 858 909 916 925 949 951 '
    + '702 725 775 458 503 541 971 206 253 360 425 509 564',
  'America/Anchorage': '907',
  'Pacific/Honolulu': '808',
  'America/Puerto_Rico': '787 939',
  'America/St_Thomas': '340',
  'Pacific/Guam': '671',
};

/** area code -> zone. Deliberately omitted (ambiguous, so `null`): 850/448 (FL panhandle, split Central/Eastern), 308 (NE, split Central/Mountain). */
export const AREA_CODE_TIME_ZONES: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const [zone, codes] of Object.entries(ZONES)) for (const c of codes.split(' ')) if (c) out[c] = zone;
  return Object.freeze(out);
})();

/** IANA zone for an NANP area code ("305" -> "America/New_York"), or null when unknown. */
export function timeZoneForAreaCode(code: string | null | undefined): string | null {
  return typeof code === 'string' ? AREA_CODE_TIME_ZONES[code] ?? null : null;
}

/** Zone for a phone number (any format libphonenumber understands; numbers without '+' are read as `country`, default US). Null when not a US/Canada number or unknown. */
export function inferTimeZoneFromPhone(raw: string | null | undefined, country?: string): string | null {
  return timeZoneForAreaCode(areaCodeOf(raw, country));
}
