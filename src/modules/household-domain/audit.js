export const createAuditLog = (
  database,
  {
    actorUserId,
    householdId,
    action,
    resourceType,
    resourceId,
    metadata,
  },
) =>
  database.auditLog.create({
    data: {
      actorUserId,
      householdId,
      action,
      resourceType,
      resourceId,
      ...(metadata === undefined ? {} : { metadata }),
    },
  });

