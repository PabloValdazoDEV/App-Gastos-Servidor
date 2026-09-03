import nodemailer from 'nodemailer';

const escapeHtml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

const sanitizeHeaderValue = (value) =>
  [...String(value)]
    .map((character) =>
      character === '\r' || character === '\n' ? ' ' : character,
    )
    .join('')
    .trim();

export const createEmailService = ({ config, logger, transport }) => {
  const enabled = config.features.email;
  const mailTransport = enabled
    ? (transport ??
      nodemailer.createTransport({
        host: config.email.host,
        port: config.email.port,
        secure: config.email.secure,
        auth: {
          user: config.email.user,
          pass: config.email.password,
        },
        disableFileAccess: true,
        disableUrlAccess: true,
        tls: { rejectUnauthorized: true },
      }))
    : null;

  return Object.freeze({
    enabled,

    async verify() {
      if (!mailTransport) return false;
      await mailTransport.verify();
      return true;
    },

    async sendPasswordReset({ recipient, name, token }) {
      if (!mailTransport) return false;

      const resetUrl = `${config.app.clientUrl}/reset-password#token=${encodeURIComponent(token)}`;
      const safeName = escapeHtml(name);

      await mailTransport.sendMail({
        from: {
          name: sanitizeHeaderValue(config.email.fromName),
          address: sanitizeHeaderValue(config.email.fromAddress),
        },
        to: sanitizeHeaderValue(recipient),
        subject: 'Restablece tu contraseña de BudgetApp',
        text:
          `Hola ${name},\n\n` +
          `Abre este enlace para crear una nueva contraseña:\n${resetUrl}\n\n` +
          'Si no solicitaste este cambio, ignora este mensaje.',
        html:
          `<p>Hola ${safeName},</p>` +
          '<p>Abre el siguiente enlace para crear una nueva contraseña:</p>' +
          `<p><a href="${escapeHtml(resetUrl)}">Restablecer contraseña</a></p>` +
          '<p>Si no solicitaste este cambio, ignora este mensaje.</p>',
        disableFileAccess: true,
        disableUrlAccess: true,
      });

      logger.info('email.password_reset.accepted');
      return true;
    },
  });
};
