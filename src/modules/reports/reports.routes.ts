import { Router } from 'express';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import type { DbClient } from '../../db/index.js';
import { createAuthMiddleware } from '../../middleware/auth.js';
import { isoDateSchema, validateQuery } from '../../middleware/validate.js';
import { AppError, ok } from '../../utils/response.js';
import {
  bogotaDayBoundsUtc,
  getBogotaHour,
  toBogotaYmd,
} from '../../utils/time.js';

const dashboardQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
});

const exportQuerySchema = z.object({
  format: z.enum(['csv', 'xlsx', 'pdf']),
  from: isoDateSchema,
  to: isoDateSchema,
});

interface ReportMetrics {
  washesToday: number;
  incomeToday: number;
  averageTicket: number;
  occupancyByHour: Record<string, number>;
  topServices: Array<{
    serviceId: string;
    serviceName: string;
    count: number;
    revenue: number;
  }>;
  newCustomers: number;
  recurrentCustomers: number;
}

async function computeDashboardMetrics(
  db: DbClient,
  from: string,
  to: string,
): Promise<ReportMetrics> {
  if (to < from) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      'La fecha final (to) no puede ser menor a la inicial (from)',
    );
  }

  const { start: fromStart } = bogotaDayBoundsUtc(from);
  const { end: toEnd } = bogotaDayBoundsUtc(to);

  const todayYmd = toBogotaYmd(new Date());
  const refDayYmd = from <= todayYmd && todayYmd <= to ? todayYmd : to;
  const { start: dayStart, end: dayEnd } = bogotaDayBoundsUtc(refDayYmd);

  const [
    todayWashesRes,
    todayIncomeRes,
    rangePaidWashesRes,
    topServicesRes,
    newCustomersRes,
    recurrentRes,
    apptsInRangeRes,
    settingsRes,
  ] = await Promise.all([
    db.query<{ cnt: string | number }>(
      `SELECT COUNT(*) AS cnt
       FROM wash_requests
       WHERE status = 'paid' AND completed_at >= $1 AND completed_at < $2`,
      [dayStart, dayEnd],
    ),
    db.query<{ total: string | number }>(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM incomes
       WHERE status <> 'pending' AND occurred_at >= $1 AND occurred_at < $2`,
      [dayStart, dayEnd],
    ),
    db.query<{ cnt: string | number; avg_price: string | number }>(
      `SELECT COUNT(*) AS cnt, COALESCE(AVG(price), 0) AS avg_price
       FROM wash_requests
       WHERE status = 'paid' AND completed_at >= $1 AND completed_at < $2`,
      [fromStart, toEnd],
    ),
    db.query<{
      service_id: string;
      service_name: string;
      cnt: string | number;
      revenue: string | number;
    }>(
      `SELECT wr.service_id, s.name AS service_name,
              COUNT(*) AS cnt, COALESCE(SUM(wr.price), 0) AS revenue
       FROM wash_requests wr
       INNER JOIN services s ON s.id = wr.service_id
       WHERE wr.status = 'paid' AND wr.completed_at >= $1 AND wr.completed_at < $2
       GROUP BY wr.service_id, s.name
       ORDER BY cnt DESC, revenue DESC
       LIMIT 5`,
      [fromStart, toEnd],
    ),
    db.query<{ cnt: string | number }>(
      `SELECT COUNT(*) AS cnt
       FROM users
       WHERE role = 'Cliente' AND created_at >= $1 AND created_at < $2`,
      [fromStart, toEnd],
    ),
    db.query<{ cnt: string | number }>(
      `SELECT COUNT(*) AS cnt FROM (
         SELECT wr.customer_id
         FROM wash_requests wr
         WHERE wr.status = 'paid'
           AND wr.completed_at >= $1 AND wr.completed_at < $2
         GROUP BY wr.customer_id
         HAVING (
           SELECT COUNT(*) FROM wash_requests wr2
           WHERE wr2.customer_id = wr.customer_id AND wr2.status = 'paid'
         ) >= 2
       ) sub`,
      [fromStart, toEnd],
    ),
    db.query<{ start_at: Date | string }>(
      `SELECT start_at
       FROM appointments
       WHERE status IN ('scheduled', 'confirmed', 'completed')
         AND start_at >= $1 AND start_at < $2`,
      [fromStart, toEnd],
    ),
    db.query<{ open_hour: number; close_hour: number; parallel_bays: number }>(
      `SELECT open_hour, close_hour, parallel_bays FROM shop_settings WHERE id = 1`,
    ),
  ]);

  const settings = settingsRes.rows[0] ?? {
    open_hour: 8,
    close_hour: 18,
    parallel_bays: 2,
  };
  const bays = Math.max(1, Number(settings.parallel_bays));
  const daysCount = Math.max(
    1,
    Math.round((toEnd.getTime() - fromStart.getTime()) / (24 * 60 * 60 * 1000)),
  );

  const hourCounts = new Map<number, number>();
  for (let h = Number(settings.open_hour); h < Number(settings.close_hour); h += 1) {
    hourCounts.set(h, 0);
  }
  for (const row of apptsInRangeRes.rows) {
    const h = getBogotaHour(row.start_at);
    hourCounts.set(h, (hourCounts.get(h) ?? 0) + 1);
  }

  const occupancyByHour: Record<string, number> = {};
  for (const [hour, count] of hourCounts.entries()) {
    const label = `${String(hour).padStart(2, '0')}:00`;
    occupancyByHour[label] = Number((count / (bays * daysCount)).toFixed(2));
  }

  return {
    washesToday: Number(todayWashesRes.rows[0]?.cnt ?? 0),
    incomeToday: Number(todayIncomeRes.rows[0]?.total ?? 0),
    averageTicket: Math.round(Number(rangePaidWashesRes.rows[0]?.avg_price ?? 0)),
    occupancyByHour,
    topServices: topServicesRes.rows.map((s) => ({
      serviceId: s.service_id,
      serviceName: s.service_name,
      count: Number(s.cnt),
      revenue: Number(s.revenue),
    })),
    newCustomers: Number(newCustomersRes.rows[0]?.cnt ?? 0),
    recurrentCustomers: Number(recurrentRes.rows[0]?.cnt ?? 0),
  };
}

function buildPdfBuffer(
  metrics: ReportMetrics,
  from: string,
  to: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('Los Malditos - Reporte Operativo y Financiero');
    doc.moveDown(0.5);
    doc.fontSize(11).text(`Periodo: ${from} a ${to} (Zona horaria: America/Bogota | Moneda: COP)`);
    doc.moveDown();

    doc.fontSize(12).text(`Lavadas del día: ${metrics.washesToday}`);
    doc.text(`Ingresos del día (COP): $${metrics.incomeToday.toLocaleString('es-CO')}`);
    doc.text(`Ticket promedio (COP): $${metrics.averageTicket.toLocaleString('es-CO')}`);
    doc.text(`Clientes nuevos: ${metrics.newCustomers}`);
    doc.text(`Clientes recurrentes: ${metrics.recurrentCustomers}`);
    doc.moveDown();

    doc.fontSize(13).text('Servicios más solicitados:');
    if (metrics.topServices.length === 0) {
      doc.fontSize(10).text('Sin servicios pagados en el periodo.');
    } else {
      for (const s of metrics.topServices) {
        doc
          .fontSize(10)
          .text(`- ${s.serviceName}: ${s.count} lavadas | COP $${s.revenue.toLocaleString('es-CO')}`);
      }
    }

    doc.end();
  });
}

export function createReportsRouter(db: DbClient): Router {
  const router = Router();
  const { authenticate, requireRoles } = createAuthMiddleware(db);

  router.get(
    '/dashboard',
    authenticate(),
    requireRoles('Administrador'),
    validateQuery(dashboardQuerySchema),
    async (_req, res, next) => {
      try {
        const { from, to } = res.locals.query as z.infer<
          typeof dashboardQuerySchema
        >;
        const metrics = await computeDashboardMetrics(db, from, to);
        return ok(res, metrics, 'KPIs del dashboard calculados exitosamente');
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/export',
    authenticate(),
    requireRoles('Administrador'),
    validateQuery(exportQuerySchema),
    async (_req, res, next) => {
      try {
        const { format, from, to } = res.locals.query as z.infer<
          typeof exportQuerySchema
        >;
        const metrics = await computeDashboardMetrics(db, from, to);
        const filenameBase = `reporte-los-malditos-${from}-a-${to}`;

        if (format === 'csv') {
          const lines = [
            'Metrica,Valor',
            `Lavadas del dia,${metrics.washesToday}`,
            `Ingresos del dia (COP),${metrics.incomeToday}`,
            `Ticket promedio (COP),${metrics.averageTicket}`,
            `Clientes nuevos,${metrics.newCustomers}`,
            `Clientes recurrentes,${metrics.recurrentCustomers}`,
            '',
            'Servicio,Cantidad,Ingresos (COP)',
            ...metrics.topServices.map(
              (s) => `"${s.serviceName.replace(/"/g, '""')}",${s.count},${s.revenue}`,
            ),
          ];
          const csv = '\uFEFF' + lines.join('\n');
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="${filenameBase}.csv"`,
          );
          return res.status(200).send(csv);
        }

        if (format === 'xlsx') {
          const workbook = new ExcelJS.Workbook();
          const sheet = workbook.addWorksheet('Resumen Los Malditos');
          sheet.addRow(['Periodo', `${from} a ${to}`]);
          sheet.addRow(['Lavadas del día', metrics.washesToday]);
          sheet.addRow(['Ingresos del día (COP)', metrics.incomeToday]);
          sheet.addRow(['Ticket promedio (COP)', metrics.averageTicket]);
          sheet.addRow(['Clientes nuevos', metrics.newCustomers]);
          sheet.addRow(['Clientes recurrentes', metrics.recurrentCustomers]);
          sheet.addRow([]);
          sheet.addRow(['Servicio', 'Cantidad', 'Ingresos (COP)']);
          for (const s of metrics.topServices) {
            sheet.addRow([s.serviceName, s.count, s.revenue]);
          }
          const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
          res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          );
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="${filenameBase}.xlsx"`,
          );
          return res.status(200).send(buffer);
        }

        const pdfBuffer = await buildPdfBuffer(metrics, from, to);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${filenameBase}.pdf"`,
        );
        return res.status(200).send(pdfBuffer);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
