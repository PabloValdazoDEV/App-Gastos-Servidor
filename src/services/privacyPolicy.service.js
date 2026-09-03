import { AppError } from '../errors/AppError.js';

export const PRIVACY_POLICY_ERROR_CODES = Object.freeze({
  acknowledgementRequired: 'PRIVACY_POLICY_ACKNOWLEDGEMENT_REQUIRED',
  notConfigured: 'PRIVACY_POLICY_NOT_CONFIGURED',
  outdated: 'PRIVACY_POLICY_OUTDATED',
});

const policyIsConfigured = (privacy) =>
  privacy?.configured === true &&
  typeof privacy.version === 'string' &&
  privacy.version.length > 0 &&
  typeof privacy.effectiveDate === 'string' &&
  privacy.effectiveDate.length > 0 &&
  typeof privacy.controller?.name === 'string' &&
  privacy.controller.name.length > 0 &&
  typeof privacy.controller?.contactEmail === 'string' &&
  privacy.controller.contactEmail.length > 0;

export const resolveRegistrationPrivacyPolicy = ({
  config,
  privacyPolicyAcknowledged,
  privacyPolicyVersion,
}) => {
  if (!policyIsConfigured(config.privacy)) {
    throw new AppError({
      statusCode: 503,
      code: PRIVACY_POLICY_ERROR_CODES.notConfigured,
      message:
        'El registro no está disponible hasta que se configure la política de privacidad.',
    });
  }

  if (privacyPolicyAcknowledged !== true) {
    throw new AppError({
      statusCode: 400,
      code: PRIVACY_POLICY_ERROR_CODES.acknowledgementRequired,
      message:
        'Debes confirmar que has leído la política de privacidad y que has sido informado para registrarte.',
    });
  }

  if (privacyPolicyVersion !== config.privacy.version) {
    throw new AppError({
      statusCode: 409,
      code: PRIVACY_POLICY_ERROR_CODES.outdated,
      message:
        'La política de privacidad ha cambiado. Revísala y vuelve a confirmar la versión vigente.',
    });
  }

  return config.privacy.version;
};

export const recordRegistrationPrivacyAcceptance = ({
  tx,
  userId,
  documentVersion,
  acceptedAt = new Date(),
}) =>
  tx.legalDocumentAcceptance.create({
    data: {
      userId,
      documentType: 'PRIVACY_POLICY',
      documentVersion,
      acceptedAt,
      source: 'REGISTRATION',
    },
  });
