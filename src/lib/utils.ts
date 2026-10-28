import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class names with conflict resolution. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a number as a currency amount (default DZD, the local pharma market). */
export function formatCurrency(
  value: number | string | null | undefined,
  currency = "DZD",
  locale = "fr-FR",
) {
  if (value === null || value === undefined || value === "") return "—";
  const num = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(num)) return "—";
  // LE MONTANT EXACT, JAMAIS ARRONDI : « 12 500,50 DZD » reste « 12 500,50 DZD ». Un entier s'écrit
  // sans décimales (« 12 500 DZD ») ; dès qu'il y a des centimes, on les montre tous les deux.
  const entier = Number.isInteger(Math.round(num * 100) / 100);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: entier ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(num);
}

/**
 * Un MONTANT en texte (« 12 500,50 » / « 12 500 »), exact à deux décimales près, sans devise.
 * La plateforme n'arrondit jamais un montant (décision du 05/10/2026) : toute phrase qui en cite
 * un passe par ici ou par `formatCurrency`, jamais par `Math.round(n).toLocaleString(…)`.
 */
export function formatMontant(value: number | null | undefined, locale = "fr-FR"): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const entier = Number.isInteger(Math.round(value * 100) / 100);
  return new Intl.NumberFormat(locale, { minimumFractionDigits: entier ? 0 : 2, maximumFractionDigits: 2 }).format(value);
}

/** Compact number formatting, e.g. 12 500 → 12,5 k. */
export function formatCompact(value: number | null | undefined, locale = "fr-FR") {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatNumber(value: number | null | undefined, locale = "fr-FR") {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat(locale).format(value);
}

/** Format a date in the French locale. */
export function formatDate(
  value: Date | string | null | undefined,
  opts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "short", year: "numeric" },
) {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fr-FR", opts).format(date);
}

/** Taille d'octets lisible (Go / Mo / Ko / o). Server-safe → utilisable côté serveur ET client. */
export function formatBytes(n: number): string {
  const GB = 1024 ** 3;
  return n >= GB ? `${(n / GB).toFixed(2)} Go` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} Mo` : n >= 1024 ? `${(n / 1024).toFixed(0)} Ko` : `${n} o`;
}

export function formatDateTime(value: Date | string | null | undefined) {
  return formatDate(value, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** « 2026-07 » → « juillet 2026 » (mois d'une note de frais, d'un bulletin…). */
export function formatMonth(ym: string | null | undefined): string {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return "—";
  const [y, m] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** Mois suivant d'un « YYYY-MM » (gère le passage d'année). */
export function nextMonthYm(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Relative day delta: negative = overdue, positive = upcoming. */
export function daysUntil(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  const diff = date.getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

/** Initials for avatar chips. */
export function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Safely convert Prisma Decimal | number | string to a JS number. */
export function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  const n = Number(value.toString());
  return Number.isNaN(n) ? 0 : n;
}
