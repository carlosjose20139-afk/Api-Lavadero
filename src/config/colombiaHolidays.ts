/**
 * Cálculo determinístico de festivos oficiales de Colombia (Ley 51 de 1983 - Ley Emiliani,
 * festivos fijos y festivos móviles basados en Pascua).
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatYmd(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function addUtcDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

/**
 * Mueve al siguiente lunes si la fecha no cae en lunes (Ley Emiliani).
 */
function nextMondayEmiliani(year: number, monthIndex0: number, day: number): Date {
  const date = new Date(Date.UTC(year, monthIndex0, day));
  const dow = date.getUTCDay(); // 0=Dom, 1=Lun ... 6=Sab
  if (dow === 1) return date;
  const delta = dow === 0 ? 1 : 8 - dow;
  return addUtcDays(date, delta);
}

/**
 * Algoritmo gregoriano anónimo para calcular el Domingo de Pascua.
 */
function getEasterSundayUtc(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=Marzo, 4=Abril
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

export interface ColombianHoliday {
  date: string; // YYYY-MM-DD
  name: string;
}

export function getColombianHolidaysForYear(year: number): ColombianHoliday[] {
  const easter = getEasterSundayUtc(year);
  const list: Array<[Date, string]> = [
    // Fijos
    [new Date(Date.UTC(year, 0, 1)), 'Año Nuevo'],
    [new Date(Date.UTC(year, 4, 1)), 'Día del Trabajo'],
    [new Date(Date.UTC(year, 6, 20)), 'Día de la Independencia'],
    [new Date(Date.UTC(year, 7, 7)), 'Batalla de Boyacá'],
    [new Date(Date.UTC(year, 11, 8)), 'Inmaculada Concepción'],
    [new Date(Date.UTC(year, 11, 25)), 'Navidad'],
    // Ley Emiliani
    [nextMondayEmiliani(year, 0, 6), 'Día de los Reyes Magos'],
    [nextMondayEmiliani(year, 2, 19), 'Día de San José'],
    [nextMondayEmiliani(year, 5, 29), 'San Pedro y San Pablo'],
    [nextMondayEmiliani(year, 7, 15), 'Asunción de la Virgen'],
    [nextMondayEmiliani(year, 9, 12), 'Día de la Raza'],
    [nextMondayEmiliani(year, 10, 1), 'Todos los Santos'],
    [nextMondayEmiliani(year, 10, 11), 'Independencia de Cartagena'],
    // Semana Santa y móviles de Pascua
    [addUtcDays(easter, -3), 'Jueves Santo'],
    [addUtcDays(easter, -2), 'Viernes Santo'],
    [addUtcDays(easter, 43), 'Ascensión del Señor'],
    [addUtcDays(easter, 64), 'Corpus Christi'],
    [addUtcDays(easter, 71), 'Sagrado Corazón de Jesús'],
  ];

  return list.map(([d, name]) => ({ date: formatYmd(d), name }));
}

export function getColombianHoliday(ymd: string): ColombianHoliday | null {
  const year = Number(ymd.slice(0, 4));
  if (!Number.isInteger(year)) return null;
  const holidays = getColombianHolidaysForYear(year);
  return holidays.find((h) => h.date === ymd) ?? null;
}
