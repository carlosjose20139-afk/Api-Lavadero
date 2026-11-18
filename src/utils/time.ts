const BOGOTA_OFFSET_MS = -5 * 60 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Formatea una fecha como ISO-8601 en zona horaria America/Bogota (-05:00).
 * Colombia no tiene horario de verano (UTC-5 permanente).
 */
export function toIsoBogota(value: Date | string): string {
  const date = toDate(value);
  const shifted = new Date(date.getTime() + BOGOTA_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = pad2(shifted.getUTCMonth() + 1);
  const d = pad2(shifted.getUTCDate());
  const hh = pad2(shifted.getUTCHours());
  const mm = pad2(shifted.getUTCMinutes());
  const ss = pad2(shifted.getUTCSeconds());
  const ms = pad3(shifted.getUTCMilliseconds());
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}.${ms}-05:00`;
}

export function toIsoBogotaNullable(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return toIsoBogota(value);
}

/**
 * Devuelve YYYY-MM-DD en America/Bogota para una fecha dada.
 */
export function toBogotaYmd(value: Date | string): string {
  const date = toDate(value);
  const shifted = new Date(date.getTime() + BOGOTA_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

export function getBogotaHour(value: Date | string): number {
  const date = toDate(value);
  const shifted = new Date(date.getTime() + BOGOTA_OFFSET_MS);
  return shifted.getUTCHours();
}

export function getBogotaMinute(value: Date | string): number {
  const date = toDate(value);
  const shifted = new Date(date.getTime() + BOGOTA_OFFSET_MS);
  return shifted.getUTCMinutes();
}

export function bogotaDateTimeToUtc(ymd: string, hour: number, minute = 0): Date {
  return new Date(`${ymd}T${pad2(hour)}:${pad2(minute)}:00.000-05:00`);
}

export function getBogotaDayOfWeek(ymd: string): number {
  // 0 = Domingo ... 6 = Sábado
  const d = new Date(`${ymd}T12:00:00.000-05:00`);
  return d.getUTCDay();
}

export function bogotaDayBoundsUtc(ymd: string): { start: Date; end: Date } {
  const start = new Date(`${ymd}T00:00:00.000-05:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}
