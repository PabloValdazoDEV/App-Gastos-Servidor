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
          'Si no lo ves en tu bandeja de entrada, revisa la carpeta de spam o correo no deseado.\n\n' +
          'Si no solicitaste este cambio, ignora este mensaje.',
        html:
          `<p>Hola ${safeName},</p>` +
          '<p>Abre el siguiente enlace para crear una nueva contraseña:</p>' +
          `<p><a href="${escapeHtml(resetUrl)}">Restablecer contraseña</a></p>` +
          '<p>Si no lo ves en tu bandeja de entrada, revisa la carpeta de spam o correo no deseado.</p>' +
          '<p>Si no solicitaste este cambio, ignora este mensaje.</p>',
        disableFileAccess: true,
        disableUrlAccess: true,
      });

      logger.info('email.password_reset.accepted');
      return true;
    },

    async sendInvitation({ recipient, householdName, role, token }) {
      if (!mailTransport) return false;

      const clientUrl = String(config.app.clientUrl).replace(/\/$/, '');
      const invitationUrl = `${clientUrl}/invitaciones/aceptar#token=${encodeURIComponent(token)}`;
      const safeHouseholdName = escapeHtml(householdName);
      const roleLabel = role === 'ADMIN' ? 'administrador' : 'miembro';

      await mailTransport.sendMail({
        from: {
          name: sanitizeHeaderValue(config.email.fromName),
          address: sanitizeHeaderValue(config.email.fromAddress),
        },
        to: sanitizeHeaderValue(recipient),
        subject: `Invitación para unirte a ${sanitizeHeaderValue(householdName)} en BudgetApp`,
        text:
          `Has recibido una invitación para unirte al hogar "${householdName}" ` +
          `en BudgetApp como ${roleLabel}.\n\n` +
          `Abre este enlace para aceptar la invitación:\n${invitationUrl}\n\n` +
          'Si no lo ves en tu bandeja de entrada, revisa la carpeta de spam o correo no deseado.\n\n' +
          'Si no esperabas esta invitación, puedes ignorar este mensaje.',
        html:
          `<p>Has recibido una invitación para unirte al hogar ` +
          `<strong>${safeHouseholdName}</strong> en BudgetApp como ${roleLabel}.</p>` +
          '<p>Abre el siguiente enlace para aceptar la invitación:</p>' +
          `<p><a href="${escapeHtml(invitationUrl)}">Aceptar invitación</a></p>` +
          '<p>Si no lo ves en tu bandeja de entrada, revisa la carpeta de spam o correo no deseado.</p>' +
          '<p>Si no esperabas esta invitación, puedes ignorar este mensaje.</p>',
        disableFileAccess: true,
        disableUrlAccess: true,
      });

      logger.info('email.invitation.accepted');
      return true;
    },
  });
};
