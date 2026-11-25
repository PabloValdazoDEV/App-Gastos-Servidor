import { describe, expect, it } from 'vitest';

import { renderEmail } from '../src/services/emailTemplates.js';
import { reminderEmail } from '../src/jobs/reminder.job.js';

const config = { app: { clientUrl: 'https://cuentacasa.example/' } };

describe('correos con diseño', () => {
  it('escapa cualquier texto del usuario dentro del HTML', () => {
    const { html } = renderEmail({ heading: '<script>alert(1)</script>', details: [['Hogar', 'Casa "A" & B']], cta: { label: 'Ver', url: 'https://x.test/?a=1&b=2' } });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Casa &quot;A&quot; &amp; B');
    expect(html).toContain('href="https://x.test/?a=1&amp;b=2"');
  });

  it('el aviso de pago muestra importe, fecha, hogar y un botón al pago, también en texto plano', () => {
    const { html, text } = reminderEmail({
      title: 'Seguro Kona vence en 7 días',
      message: 'Importe previsto: 604,00 €.',
      dueDate: new Date('2026-12-02T00:00:00.000Z'),
      relatedPath: '/gastos/recurrentes/kona',
      recurringExpense: { name: 'Seguro Kona', amountCents: 60_400, scope: 'HOUSEHOLD', household: { name: 'Fantasia', currency: 'EUR' } },
    }, config);
    expect(html).toContain('Seguro Kona vence en 7 días');
    expect(html).toMatch(/604,00\s€/);
    expect(html).toContain('miércoles, 2 de diciembre de 2026');
    expect(html).toContain('Fantasia');
    expect(html).toContain('href="https://cuentacasa.example/gastos/recurrentes/kona"');
    expect(html).toContain('href="https://cuentacasa.example/notificaciones"');
    expect(text).toContain('Ver el pago: https://cuentacasa.example/gastos/recurrentes/kona');
    expect(text).toMatch(/Importe previsto: 604,00\s€/);
  });

  it('sin datos del gasto sigue enviando el título y el mensaje', () => {
    const { text } = reminderEmail({ title: 'Gym vence hoy', message: 'Importe previsto: 35,00 €.', relatedPath: null }, config);
    expect(text).toContain('Gym vence hoy');
    expect(text).toContain('Importe previsto: 35,00 €.');
  });
});
