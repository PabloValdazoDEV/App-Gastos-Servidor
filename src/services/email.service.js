import nodemailer from 'nodemailer';

import { renderEmail } from './emailTemplates.js';

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
      const { html, text } = renderEmail({
        preheader: 'Crea una contraseña nueva para tu cuenta.',
        eyebrow: 'Tu cuenta',
        heading: 'Restablece tu contraseña',
        intro: `Hola ${name}, pulsa el botón para crear una contraseña nueva.`,
        cta: { label: 'Crear contraseña nueva', url: resetUrl },
        outro: 'Si no solicitaste este cambio, ignora este mensaje: tu contraseña actual sigue funcionando.',
        footer: { text: 'Si no lo ves en tu bandeja de entrada, revisa la carpeta de spam o correo no deseado.' },
      });

      await mailTransport.sendMail({
        from: {
          name: sanitizeHeaderValue(config.email.fromName),
          address: sanitizeHeaderValue(config.email.fromAddress),
        },
        to: sanitizeHeaderValue(recipient),
        subject: 'Restablece tu contraseña de BudgetApp',
        text,
        html,
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
      const roleLabel = role === 'ADMIN' ? 'administrador' : 'miembro';
      const { html, text } = renderEmail({
        preheader: `Te han invitado a ${householdName} en BudgetApp.`,
        eyebrow: 'Invitación',
        heading: `Únete a «${householdName}»`,
        intro: `Te han invitado a organizar los gastos del hogar «${householdName}» en BudgetApp como ${roleLabel}.`,
        cta: { label: 'Aceptar invitación', url: invitationUrl },
        outro: 'Si no esperabas esta invitación, puedes ignorar este mensaje.',
        footer: { text: 'Si no lo ves en tu bandeja de entrada, revisa la carpeta de spam o correo no deseado.' },
      });

      await mailTransport.sendMail({
        from: {
          name: sanitizeHeaderValue(config.email.fromName),
          address: sanitizeHeaderValue(config.email.fromAddress),
        },
        to: sanitizeHeaderValue(recipient),
        subject: `Invitación para unirte a ${sanitizeHeaderValue(householdName)} en BudgetApp`,
        text,
        html,
        disableFileAccess: true,
        disableUrlAccess: true,
      });

      logger.info('email.invitation.accepted');
      return true;
    },
  });
};
