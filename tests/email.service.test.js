import { describe, expect, it, vi } from 'vitest';

import { createEmailService } from '../src/services/email.service.js';

const config = {
  features: { email: true },
  app: { clientUrl: 'https://cuentacasa.example.com/' },
  email: {
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    user: 'no-reply@example.com',
    password: 'smtp-password',
    fromName: 'BudgetApp',
    fromAddress: 'no-reply@example.com',
  },
};

describe('email service', () => {
  it('envía una invitación con el enlace de aceptación', async () => {
    const transport = { sendMail: vi.fn().mockResolvedValue({}) };
    const logger = { info: vi.fn() };
    const service = createEmailService({ config, logger, transport });

    await expect(
      service.sendInvitation({
        householdName: 'Casa <principal>',
        recipient: 'persona@example.com',
        role: 'MEMBER',
        token: 'secure-invitation-token',
      }),
    ).resolves.toBe(true);

    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'persona@example.com',
        subject: 'Invitación para unirte a Casa <principal> en BudgetApp',
        text: expect.stringContaining(
          'https://cuentacasa.example.com/invitaciones/aceptar#token=secure-invitation-token',
        ),
        html: expect.stringContaining('Casa &lt;principal&gt;'),
      }),
    );
    expect(transport.sendMail.mock.calls[0][0].text).toContain(
      'revisa la carpeta de spam o correo no deseado',
    );
    expect(logger.info).toHaveBeenCalledWith('email.invitation.accepted');
  });
});
