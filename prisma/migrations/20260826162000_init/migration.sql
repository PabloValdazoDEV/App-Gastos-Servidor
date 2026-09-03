-- CreateEnum
CREATE TYPE "OAuthProvider" AS ENUM ('GOOGLE');

-- CreateEnum
CREATE TYPE "HouseholdRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ContributionMode" AS ENUM ('PERCENTAGE', 'FIXED');

-- CreateEnum
CREATE TYPE "ExpenseScope" AS ENUM ('HOUSEHOLD', 'PERSONAL');

-- CreateEnum
CREATE TYPE "ExpenseFrequency" AS ENUM ('WEEKLY', 'MONTHLY', 'BIMONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'YEARLY', 'CUSTOM_MONTHS', 'ONE_TIME');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PAID', 'SKIPPED');

-- CreateEnum
CREATE TYPE "NextAmountDecision" AS ENUM ('KEEP_PREVIOUS', 'UPDATE_NEXT_AMOUNT');

-- CreateEnum
CREATE TYPE "VariableEntryMode" AS ENUM ('DETAIL', 'SUMMARY');

-- CreateEnum
CREATE TYPE "PlanningFundingStatus" AS ENUM ('PREPARED', 'FUNDED');

-- CreateEnum
CREATE TYPE "FinancialStatus" AS ENUM ('OK', 'ATTENTION', 'DEFICIT', 'PAYMENT_RISK');

-- CreateEnum
CREATE TYPE "RecoveryPlanMode" AS ENUM ('TARGET_MONTHS', 'MAX_MONTHLY', 'RECOMMENDED');

-- CreateEnum
CREATE TYPE "RecoveryPlanStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'WEB_PUSH');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "BalanceSnapshotSource" AS ENUM ('MANUAL', 'MONTHLY_PREPARATION', 'PAYMENT');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('REGISTER', 'LOGIN', 'LOGOUT', 'PASSWORD_CHANGED', 'HOUSEHOLD_CREATED', 'HOUSEHOLD_CHANGED', 'HOUSEHOLD_DELETED', 'OWNERSHIP_TRANSFERRED', 'INVITATION_CREATED', 'INVITATION_REVOKED', 'MEMBER_LINKED', 'ACCESS_CHANGED', 'CATEGORY_CREATED', 'CATEGORY_CHANGED', 'EXPENSE_CREATED', 'EXPENSE_CHANGED', 'EXPENSE_DELETED', 'PAYMENT_REGISTERED', 'BALANCE_CHANGED', 'MONTH_PREPARED', 'RECOVERY_PLAN_CHANGED', 'NOTIFICATION_PREFERENCE_CHANGED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "passwordHash" VARCHAR(255),
    "name" VARCHAR(120) NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Europe/Madrid',
    "locale" VARCHAR(16) NOT NULL DEFAULT 'es-ES',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthAccount" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "OAuthProvider" NOT NULL,
    "providerAccountId" VARCHAR(255) NOT NULL,
    "providerEmail" VARCHAR(320),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "familyId" UUID NOT NULL,
    "rotatedFromSessionId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revocationReason" VARCHAR(120),
    "ipAddressHash" CHAR(64),
    "userAgent" VARCHAR(512),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "requestedIpHash" CHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Household" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Europe/Madrid',
    "locale" VARCHAR(16) NOT NULL DEFAULT 'es-ES',
    "contributionMode" "ContributionMode" NOT NULL DEFAULT 'PERCENTAGE',
    "safetyMarginBps" INTEGER NOT NULL DEFAULT 1000,
    "contributionDay" INTEGER NOT NULL DEFAULT 1,
    "currentBalanceCents" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Household_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HouseholdPerson" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "linkedUserId" UUID,
    "name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(320),
    "contributionBps" INTEGER NOT NULL DEFAULT 0,
    "fixedContributionCents" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HouseholdPerson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HouseholdUserAccess" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "HouseholdRole" NOT NULL DEFAULT 'MEMBER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HouseholdUserAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "householdPersonId" UUID,
    "invitedByUserId" UUID NOT NULL,
    "acceptedByUserId" UUID,
    "email" VARCHAR(320),
    "role" "HouseholdRole" NOT NULL DEFAULT 'MEMBER',
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "tokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "icon" VARCHAR(64) NOT NULL,
    "color" VARCHAR(32) NOT NULL,
    "safetyMarginBps" INTEGER,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringExpense" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "personalPersonId" UUID,
    "name" VARCHAR(120) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "scope" "ExpenseScope" NOT NULL DEFAULT 'HOUSEHOLD',
    "frequency" "ExpenseFrequency" NOT NULL,
    "intervalMonths" INTEGER,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "nextDueDate" DATE NOT NULL,
    "usualDayOfMonth" INTEGER,
    "safetyMarginOverrideBps" INTEGER,
    "remindersEnabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" VARCHAR(2000),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpensePayment" (
    "id" UUID NOT NULL,
    "recurringExpenseId" UUID NOT NULL,
    "recordedByUserId" UUID NOT NULL,
    "dueDate" DATE NOT NULL,
    "expectedAmountCents" INTEGER NOT NULL,
    "actualAmountCents" INTEGER,
    "paymentDate" DATE,
    "status" "PaymentStatus" NOT NULL,
    "nextAmountDecision" "NextAmountDecision" NOT NULL DEFAULT 'KEEP_PREVIOUS',
    "nextExpectedAmountCents" INTEGER,
    "notes" VARCHAR(2000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpensePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UtilityInvoice" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "invoiceDate" DATE NOT NULL,
    "chargeDate" DATE,
    "notes" VARCHAR(2000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UtilityInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariableExpenseMonth" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "personalPersonId" UUID,
    "ownerKey" VARCHAR(40) NOT NULL,
    "scope" "ExpenseScope" NOT NULL DEFAULT 'HOUSEHOLD',
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "entryMode" "VariableEntryMode" NOT NULL,
    "summaryAmountCents" INTEGER,
    "isComplete" BOOLEAN NOT NULL DEFAULT true,
    "notes" VARCHAR(2000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariableExpenseMonth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariableExpenseEntry" (
    "id" UUID NOT NULL,
    "variableExpenseMonthId" UUID NOT NULL,
    "spentOn" DATE NOT NULL,
    "merchant" VARCHAR(120),
    "amountCents" INTEGER NOT NULL,
    "notes" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariableExpenseEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HouseholdBalanceSnapshot" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "recordedByUserId" UUID NOT NULL,
    "monthlyPlanningId" UUID,
    "balanceCents" INTEGER NOT NULL,
    "source" "BalanceSnapshotSource" NOT NULL DEFAULT 'MANUAL',
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HouseholdBalanceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyPlanning" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "preparedByUserId" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "calculationDate" DATE NOT NULL,
    "confirmedBalanceCents" INTEGER NOT NULL,
    "recommendedBudgetCents" INTEGER NOT NULL,
    "householdBudgetCents" INTEGER NOT NULL,
    "theoreticalReserveCents" INTEGER NOT NULL,
    "relevantAvailableBalanceCents" INTEGER NOT NULL,
    "deficitCents" INTEGER NOT NULL,
    "financialStatus" "FinancialStatus" NOT NULL,
    "calculationVersion" VARCHAR(20) NOT NULL DEFAULT 'v1',
    "breakdown" JSONB,
    "fundingStatus" "PlanningFundingStatus" NOT NULL DEFAULT 'PREPARED',
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthlyPlanning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyPlanningContribution" (
    "id" UUID NOT NULL,
    "monthlyPlanningId" UUID NOT NULL,
    "householdPersonId" UUID NOT NULL,
    "personName" VARCHAR(120) NOT NULL,
    "contributionBps" INTEGER NOT NULL,
    "standardHouseholdCents" INTEGER NOT NULL,
    "personalExpenseCents" INTEGER NOT NULL,
    "temporaryAdjustmentCents" INTEGER NOT NULL DEFAULT 0,
    "totalRecommendedCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonthlyPlanningContribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryPlan" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "monthlyPlanningId" UUID,
    "createdByUserId" UUID NOT NULL,
    "mode" "RecoveryPlanMode" NOT NULL,
    "status" "RecoveryPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "initialDeficitCents" INTEGER NOT NULL,
    "remainingDeficitCents" INTEGER NOT NULL,
    "targetMonths" INTEGER,
    "maximumMonthlyCents" INTEGER,
    "monthlyAdjustmentCents" INTEGER NOT NULL,
    "startsOn" DATE NOT NULL,
    "targetCompletionDate" DATE,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoveryPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "inAppEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "webPushEnabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultOffsets" INTEGER[] NOT NULL DEFAULT ARRAY[30, 7, 1]::INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderRule" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "recurringExpenseId" UUID NOT NULL,
    "offsetDays" INTEGER NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReminderRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "recurringExpenseId" UUID NOT NULL,
    "dueDate" DATE NOT NULL,
    "offsetDays" INTEGER NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "message" VARCHAR(1000) NOT NULL,
    "relatedPath" VARCHAR(500),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "lockedBy" VARCHAR(100),
    "sentAt" TIMESTAMP(3),
    "errorCode" VARCHAR(120),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "endpointHash" CHAR(64) NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" VARCHAR(512),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actorUserId" UUID,
    "householdId" UUID,
    "action" "AuditAction" NOT NULL,
    "resourceType" VARCHAR(80),
    "resourceId" VARCHAR(64),
    "metadata" JSONB,
    "ipAddressHash" CHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "OAuthAccount_userId_idx" ON "OAuthAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAccount_provider_providerAccountId_key" ON "OAuthAccount"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAccount_userId_provider_key" ON "OAuthAccount"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshSession_tokenHash_key" ON "RefreshSession"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshSession_rotatedFromSessionId_key" ON "RefreshSession"("rotatedFromSessionId");

-- CreateIndex
CREATE INDEX "RefreshSession_userId_expiresAt_idx" ON "RefreshSession"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "RefreshSession_familyId_revokedAt_idx" ON "RefreshSession"("familyId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_expiresAt_idx" ON "PasswordResetToken"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "Household_ownerUserId_idx" ON "Household"("ownerUserId");

-- CreateIndex
CREATE INDEX "HouseholdPerson_householdId_isActive_idx" ON "HouseholdPerson"("householdId", "isActive");

-- CreateIndex
CREATE INDEX "HouseholdPerson_householdId_email_idx" ON "HouseholdPerson"("householdId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "HouseholdPerson_householdId_linkedUserId_key" ON "HouseholdPerson"("householdId", "linkedUserId");

-- CreateIndex
CREATE INDEX "HouseholdUserAccess_userId_isActive_idx" ON "HouseholdUserAccess"("userId", "isActive");

-- CreateIndex
CREATE INDEX "HouseholdUserAccess_householdId_role_idx" ON "HouseholdUserAccess"("householdId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "HouseholdUserAccess_householdId_userId_key" ON "HouseholdUserAccess"("householdId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_householdId_status_expiresAt_idx" ON "Invitation"("householdId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "Invitation_email_status_idx" ON "Invitation"("email", "status");

-- CreateIndex
CREATE INDEX "Category_householdId_archivedAt_idx" ON "Category"("householdId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Category_householdId_slug_key" ON "Category"("householdId", "slug");

-- CreateIndex
CREATE INDEX "RecurringExpense_householdId_isActive_nextDueDate_idx" ON "RecurringExpense"("householdId", "isActive", "nextDueDate");

-- CreateIndex
CREATE INDEX "RecurringExpense_categoryId_idx" ON "RecurringExpense"("categoryId");

-- CreateIndex
CREATE INDEX "RecurringExpense_personalPersonId_idx" ON "RecurringExpense"("personalPersonId");

-- CreateIndex
CREATE INDEX "ExpensePayment_dueDate_status_idx" ON "ExpensePayment"("dueDate", "status");

-- CreateIndex
CREATE INDEX "ExpensePayment_recordedByUserId_idx" ON "ExpensePayment"("recordedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpensePayment_recurringExpenseId_dueDate_key" ON "ExpensePayment"("recurringExpenseId", "dueDate");

-- CreateIndex
CREATE INDEX "UtilityInvoice_householdId_categoryId_periodEnd_idx" ON "UtilityInvoice"("householdId", "categoryId", "periodEnd");

-- CreateIndex
CREATE INDEX "UtilityInvoice_householdId_chargeDate_idx" ON "UtilityInvoice"("householdId", "chargeDate");

-- CreateIndex
CREATE INDEX "VariableExpenseMonth_householdId_year_month_idx" ON "VariableExpenseMonth"("householdId", "year", "month");

-- CreateIndex
CREATE INDEX "VariableExpenseMonth_personalPersonId_idx" ON "VariableExpenseMonth"("personalPersonId");

-- CreateIndex
CREATE UNIQUE INDEX "VariableExpenseMonth_householdId_categoryId_ownerKey_year_m_key" ON "VariableExpenseMonth"("householdId", "categoryId", "ownerKey", "year", "month");

-- CreateIndex
CREATE INDEX "VariableExpenseEntry_variableExpenseMonthId_spentOn_idx" ON "VariableExpenseEntry"("variableExpenseMonthId", "spentOn");

-- CreateIndex
CREATE UNIQUE INDEX "HouseholdBalanceSnapshot_monthlyPlanningId_key" ON "HouseholdBalanceSnapshot"("monthlyPlanningId");

-- CreateIndex
CREATE INDEX "HouseholdBalanceSnapshot_householdId_recordedAt_idx" ON "HouseholdBalanceSnapshot"("householdId", "recordedAt");

-- CreateIndex
CREATE INDEX "MonthlyPlanning_householdId_preparedAt_idx" ON "MonthlyPlanning"("householdId", "preparedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyPlanning_householdId_year_month_key" ON "MonthlyPlanning"("householdId", "year", "month");

-- CreateIndex
CREATE INDEX "MonthlyPlanningContribution_householdPersonId_idx" ON "MonthlyPlanningContribution"("householdPersonId");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyPlanningContribution_monthlyPlanningId_householdPers_key" ON "MonthlyPlanningContribution"("monthlyPlanningId", "householdPersonId");

-- CreateIndex
CREATE INDEX "RecoveryPlan_householdId_status_idx" ON "RecoveryPlan"("householdId", "status");

-- CreateIndex
CREATE INDEX "RecoveryPlan_monthlyPlanningId_idx" ON "RecoveryPlan"("monthlyPlanningId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_key" ON "NotificationPreference"("userId");

-- CreateIndex
CREATE INDEX "ReminderRule_recurringExpenseId_enabled_idx" ON "ReminderRule"("recurringExpenseId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderRule_userId_recurringExpenseId_offsetDays_channel_key" ON "ReminderRule"("userId", "recurringExpenseId", "offsetDays", "channel");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_householdId_createdAt_idx" ON "Notification"("householdId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_recurringExpenseId_dueDate_offsetDays_key" ON "Notification"("userId", "recurringExpenseId", "dueDate", "offsetDays");

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_nextAttemptAt_idx" ON "NotificationDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_delivery_reminder_key" ON "NotificationDelivery"("notificationId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpointHash_key" ON "PushSubscription"("endpointHash");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_householdId_createdAt_idx" ON "AuditLog"("householdId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "OAuthAccount" ADD CONSTRAINT "OAuthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshSession" ADD CONSTRAINT "RefreshSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshSession" ADD CONSTRAINT "RefreshSession_rotatedFromSessionId_fkey" FOREIGN KEY ("rotatedFromSessionId") REFERENCES "RefreshSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Household" ADD CONSTRAINT "Household_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdPerson" ADD CONSTRAINT "HouseholdPerson_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdPerson" ADD CONSTRAINT "HouseholdPerson_linkedUserId_fkey" FOREIGN KEY ("linkedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdUserAccess" ADD CONSTRAINT "HouseholdUserAccess_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdUserAccess" ADD CONSTRAINT "HouseholdUserAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_householdPersonId_fkey" FOREIGN KEY ("householdPersonId") REFERENCES "HouseholdPerson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringExpense" ADD CONSTRAINT "RecurringExpense_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringExpense" ADD CONSTRAINT "RecurringExpense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringExpense" ADD CONSTRAINT "RecurringExpense_personalPersonId_fkey" FOREIGN KEY ("personalPersonId") REFERENCES "HouseholdPerson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpensePayment" ADD CONSTRAINT "ExpensePayment_recurringExpenseId_fkey" FOREIGN KEY ("recurringExpenseId") REFERENCES "RecurringExpense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpensePayment" ADD CONSTRAINT "ExpensePayment_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtilityInvoice" ADD CONSTRAINT "UtilityInvoice_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtilityInvoice" ADD CONSTRAINT "UtilityInvoice_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariableExpenseMonth" ADD CONSTRAINT "VariableExpenseMonth_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariableExpenseMonth" ADD CONSTRAINT "VariableExpenseMonth_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariableExpenseMonth" ADD CONSTRAINT "VariableExpenseMonth_personalPersonId_fkey" FOREIGN KEY ("personalPersonId") REFERENCES "HouseholdPerson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariableExpenseEntry" ADD CONSTRAINT "VariableExpenseEntry_variableExpenseMonthId_fkey" FOREIGN KEY ("variableExpenseMonthId") REFERENCES "VariableExpenseMonth"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdBalanceSnapshot" ADD CONSTRAINT "HouseholdBalanceSnapshot_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdBalanceSnapshot" ADD CONSTRAINT "HouseholdBalanceSnapshot_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdBalanceSnapshot" ADD CONSTRAINT "HouseholdBalanceSnapshot_monthlyPlanningId_fkey" FOREIGN KEY ("monthlyPlanningId") REFERENCES "MonthlyPlanning"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyPlanning" ADD CONSTRAINT "MonthlyPlanning_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyPlanning" ADD CONSTRAINT "MonthlyPlanning_preparedByUserId_fkey" FOREIGN KEY ("preparedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyPlanningContribution" ADD CONSTRAINT "MonthlyPlanningContribution_monthlyPlanningId_fkey" FOREIGN KEY ("monthlyPlanningId") REFERENCES "MonthlyPlanning"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyPlanningContribution" ADD CONSTRAINT "MonthlyPlanningContribution_householdPersonId_fkey" FOREIGN KEY ("householdPersonId") REFERENCES "HouseholdPerson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryPlan" ADD CONSTRAINT "RecoveryPlan_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryPlan" ADD CONSTRAINT "RecoveryPlan_monthlyPlanningId_fkey" FOREIGN KEY ("monthlyPlanningId") REFERENCES "MonthlyPlanning"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryPlan" ADD CONSTRAINT "RecoveryPlan_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderRule" ADD CONSTRAINT "ReminderRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderRule" ADD CONSTRAINT "ReminderRule_recurringExpenseId_fkey" FOREIGN KEY ("recurringExpenseId") REFERENCES "RecurringExpense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recurringExpenseId_fkey" FOREIGN KEY ("recurringExpenseId") REFERENCES "RecurringExpense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Domain invariants that Prisma 6 cannot express in the schema.
ALTER TABLE "Household"
    ADD CONSTRAINT "Household_safetyMarginBps_check"
        CHECK ("safetyMarginBps" BETWEEN 0 AND 10000),
    ADD CONSTRAINT "Household_contributionDay_check"
        CHECK ("contributionDay" BETWEEN 1 AND 31);

ALTER TABLE "HouseholdPerson"
    ADD CONSTRAINT "HouseholdPerson_contributionBps_check"
        CHECK ("contributionBps" BETWEEN 0 AND 10000),
    ADD CONSTRAINT "HouseholdPerson_fixedContributionCents_check"
        CHECK ("fixedContributionCents" IS NULL OR "fixedContributionCents" >= 0);

ALTER TABLE "Invitation"
    ADD CONSTRAINT "Invitation_role_check"
        CHECK ("role" <> 'OWNER'),
    ADD CONSTRAINT "Invitation_expiry_check"
        CHECK ("expiresAt" > "createdAt"),
    ADD CONSTRAINT "Invitation_status_shape_check"
        CHECK (
            ("status" = 'PENDING'
                AND "acceptedByUserId" IS NULL
                AND "acceptedAt" IS NULL
                AND "revokedAt" IS NULL)
            OR ("status" = 'ACCEPTED'
                AND "acceptedByUserId" IS NOT NULL
                AND "acceptedAt" IS NOT NULL
                AND "revokedAt" IS NULL)
            OR ("status" = 'REVOKED'
                AND "acceptedByUserId" IS NULL
                AND "acceptedAt" IS NULL
                AND "revokedAt" IS NOT NULL)
            OR ("status" = 'EXPIRED'
                AND "acceptedByUserId" IS NULL
                AND "acceptedAt" IS NULL
                AND "revokedAt" IS NULL)
        );

ALTER TABLE "Category"
    ADD CONSTRAINT "Category_safetyMarginBps_check"
        CHECK ("safetyMarginBps" IS NULL OR "safetyMarginBps" BETWEEN 0 AND 10000);

ALTER TABLE "RecurringExpense"
    ADD CONSTRAINT "RecurringExpense_amountCents_check"
        CHECK ("amountCents" > 0),
    ADD CONSTRAINT "RecurringExpense_date_range_check"
        CHECK ("endDate" IS NULL OR "endDate" >= "startDate"),
    ADD CONSTRAINT "RecurringExpense_usualDayOfMonth_check"
        CHECK ("usualDayOfMonth" IS NULL OR "usualDayOfMonth" BETWEEN 1 AND 31),
    ADD CONSTRAINT "RecurringExpense_safetyMarginOverrideBps_check"
        CHECK (
            "safetyMarginOverrideBps" IS NULL
            OR "safetyMarginOverrideBps" BETWEEN 0 AND 10000
        ),
    ADD CONSTRAINT "RecurringExpense_scope_shape_check"
        CHECK (
            ("scope" = 'HOUSEHOLD' AND "personalPersonId" IS NULL)
            OR ("scope" = 'PERSONAL' AND "personalPersonId" IS NOT NULL)
        ),
    ADD CONSTRAINT "RecurringExpense_interval_shape_check"
        CHECK (
            ("frequency" = 'CUSTOM_MONTHS' AND "intervalMonths" >= 1)
            OR ("frequency" <> 'CUSTOM_MONTHS' AND "intervalMonths" IS NULL)
        );

ALTER TABLE "ExpensePayment"
    ADD CONSTRAINT "ExpensePayment_amounts_check"
        CHECK (
            "expectedAmountCents" > 0
            AND ("actualAmountCents" IS NULL OR "actualAmountCents" > 0)
            AND ("nextExpectedAmountCents" IS NULL OR "nextExpectedAmountCents" > 0)
        ),
    ADD CONSTRAINT "ExpensePayment_status_shape_check"
        CHECK (
            ("status" = 'PAID'
                AND "actualAmountCents" IS NOT NULL
                AND "paymentDate" IS NOT NULL)
            OR ("status" = 'SKIPPED'
                AND "actualAmountCents" IS NULL
                AND "paymentDate" IS NULL)
        ),
    ADD CONSTRAINT "ExpensePayment_next_amount_shape_check"
        CHECK (
            ("nextAmountDecision" = 'KEEP_PREVIOUS' AND "nextExpectedAmountCents" IS NULL)
            OR ("nextAmountDecision" = 'UPDATE_NEXT_AMOUNT'
                AND "status" = 'PAID'
                AND "nextExpectedAmountCents" = "actualAmountCents")
        );

ALTER TABLE "UtilityInvoice"
    ADD CONSTRAINT "UtilityInvoice_amountCents_check"
        CHECK ("amountCents" > 0),
    ADD CONSTRAINT "UtilityInvoice_period_check"
        CHECK ("periodEnd" >= "periodStart");

ALTER TABLE "VariableExpenseMonth"
    ADD CONSTRAINT "VariableExpenseMonth_calendar_check"
        CHECK ("year" BETWEEN 2000 AND 2200 AND "month" BETWEEN 1 AND 12),
    ADD CONSTRAINT "VariableExpenseMonth_mode_shape_check"
        CHECK (
            ("entryMode" = 'SUMMARY' AND "summaryAmountCents" IS NOT NULL AND "summaryAmountCents" >= 0)
            OR ("entryMode" = 'DETAIL' AND "summaryAmountCents" IS NULL)
        ),
    ADD CONSTRAINT "VariableExpenseMonth_scope_shape_check"
        CHECK (
            ("scope" = 'HOUSEHOLD'
                AND "personalPersonId" IS NULL
                AND "ownerKey" = 'HOUSEHOLD')
            OR ("scope" = 'PERSONAL'
                AND "personalPersonId" IS NOT NULL
                AND "ownerKey" = "personalPersonId"::text)
        );

ALTER TABLE "VariableExpenseEntry"
    ADD CONSTRAINT "VariableExpenseEntry_amountCents_check"
        CHECK ("amountCents" > 0);

ALTER TABLE "MonthlyPlanning"
    ADD CONSTRAINT "MonthlyPlanning_calendar_check"
        CHECK ("year" BETWEEN 2000 AND 2200 AND "month" BETWEEN 1 AND 12),
    ADD CONSTRAINT "MonthlyPlanning_nonnegative_amounts_check"
        CHECK (
            "recommendedBudgetCents" >= 0
            AND "householdBudgetCents" >= 0
            AND "deficitCents" >= 0
        ),
    ADD CONSTRAINT "MonthlyPlanning_funding_shape_check"
        CHECK (
            ("fundingStatus" = 'PREPARED' AND "fundedAt" IS NULL)
            OR ("fundingStatus" = 'FUNDED' AND "fundedAt" IS NOT NULL)
        );

ALTER TABLE "MonthlyPlanningContribution"
    ADD CONSTRAINT "MonthlyPlanningContribution_bps_check"
        CHECK ("contributionBps" BETWEEN 0 AND 10000),
    ADD CONSTRAINT "MonthlyPlanningContribution_amounts_check"
        CHECK (
            "standardHouseholdCents" >= 0
            AND "personalExpenseCents" >= 0
            AND "temporaryAdjustmentCents" >= 0
            AND "totalRecommendedCents" >= 0
            AND "totalRecommendedCents" =
                "standardHouseholdCents"
                + "personalExpenseCents"
                + "temporaryAdjustmentCents"
        );

ALTER TABLE "RecoveryPlan"
    ADD CONSTRAINT "RecoveryPlan_amounts_check"
        CHECK (
            "initialDeficitCents" > 0
            AND "remainingDeficitCents" >= 0
            AND "remainingDeficitCents" <= "initialDeficitCents"
            AND "monthlyAdjustmentCents" > 0
            AND ("maximumMonthlyCents" IS NULL OR "maximumMonthlyCents" > 0)
            AND ("targetMonths" IS NULL OR "targetMonths" > 0)
        ),
    ADD CONSTRAINT "RecoveryPlan_mode_shape_check"
        CHECK (
            ("mode" = 'TARGET_MONTHS' AND "targetMonths" IS NOT NULL AND "maximumMonthlyCents" IS NULL)
            OR ("mode" = 'MAX_MONTHLY' AND "targetMonths" IS NULL AND "maximumMonthlyCents" IS NOT NULL)
            OR ("mode" = 'RECOMMENDED' AND "targetMonths" IS NULL AND "maximumMonthlyCents" IS NULL)
        ),
    ADD CONSTRAINT "RecoveryPlan_date_range_check"
        CHECK ("targetCompletionDate" IS NULL OR "targetCompletionDate" >= "startsOn"),
    ADD CONSTRAINT "RecoveryPlan_status_shape_check"
        CHECK (
            ("status" = 'ACTIVE' AND "completedAt" IS NULL AND "cancelledAt" IS NULL)
            OR ("status" = 'COMPLETED' AND "completedAt" IS NOT NULL AND "cancelledAt" IS NULL)
            OR ("status" = 'CANCELLED' AND "completedAt" IS NULL AND "cancelledAt" IS NOT NULL)
        );

ALTER TABLE "NotificationPreference"
    ADD CONSTRAINT "NotificationPreference_defaultOffsets_check"
        CHECK (
            array_position("defaultOffsets", NULL) IS NULL
            AND 0 <= ALL ("defaultOffsets")
            AND 365 >= ALL ("defaultOffsets")
        );

ALTER TABLE "ReminderRule"
    ADD CONSTRAINT "ReminderRule_offsetDays_check"
        CHECK ("offsetDays" BETWEEN 0 AND 365);

ALTER TABLE "Notification"
    ADD CONSTRAINT "Notification_offsetDays_check"
        CHECK ("offsetDays" BETWEEN 0 AND 365);

ALTER TABLE "NotificationDelivery"
    ADD CONSTRAINT "NotificationDelivery_attempts_check"
        CHECK ("attempts" >= 0),
    ADD CONSTRAINT "NotificationDelivery_lock_shape_check"
        CHECK (
            ("status" = 'PROCESSING' AND "lockedAt" IS NOT NULL AND "lockedBy" IS NOT NULL)
            OR ("status" <> 'PROCESSING' AND "lockedAt" IS NULL AND "lockedBy" IS NULL)
        ),
    ADD CONSTRAINT "NotificationDelivery_sent_shape_check"
        CHECK (
            ("status" = 'SENT' AND "sentAt" IS NOT NULL)
            OR ("status" <> 'SENT' AND "sentAt" IS NULL)
        );

-- Partial uniqueness prevents duplicate pending invitations and recovery plans.
CREATE UNIQUE INDEX "invitation_pending_email_uq"
    ON "Invitation" ("householdId", "email")
    WHERE "status" = 'PENDING' AND "email" IS NOT NULL;

CREATE UNIQUE INDEX "invitation_pending_person_uq"
    ON "Invitation" ("householdId", "householdPersonId")
    WHERE "status" = 'PENDING' AND "householdPersonId" IS NOT NULL;

CREATE UNIQUE INDEX "recovery_plan_one_active_uq"
    ON "RecoveryPlan" ("householdId")
    WHERE "status" = 'ACTIVE';

-- DETAIL/SUMMARY is also protected against concurrent writes at database level.
CREATE FUNCTION "budgetapp_validate_variable_expense_entry"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    parent_mode "VariableEntryMode";
    parent_year INTEGER;
    parent_month INTEGER;
BEGIN
    SELECT "entryMode", "year", "month"
      INTO parent_mode, parent_year, parent_month
      FROM "VariableExpenseMonth"
     WHERE "id" = NEW."variableExpenseMonthId"
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'The variable-expense month does not exist'
            USING ERRCODE = '23503';
    END IF;

    IF parent_mode <> 'DETAIL' THEN
        RAISE EXCEPTION 'Entries are only allowed for DETAIL variable-expense months'
            USING ERRCODE = '23514';
    END IF;

    IF EXTRACT(YEAR FROM NEW."spentOn")::INTEGER <> parent_year
       OR EXTRACT(MONTH FROM NEW."spentOn")::INTEGER <> parent_month THEN
        RAISE EXCEPTION 'The entry date must belong to its variable-expense month'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "variable_expense_entry_parent_guard"
BEFORE INSERT OR UPDATE OF "variableExpenseMonthId", "spentOn"
ON "VariableExpenseEntry"
FOR EACH ROW
EXECUTE FUNCTION "budgetapp_validate_variable_expense_entry"();

CREATE FUNCTION "budgetapp_validate_variable_expense_month_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."entryMode" = 'SUMMARY'
       AND EXISTS (
           SELECT 1
             FROM "VariableExpenseEntry"
            WHERE "variableExpenseMonthId" = NEW."id"
       ) THEN
        RAISE EXCEPTION 'A variable-expense month with entries cannot use SUMMARY mode'
            USING ERRCODE = '23514';
    END IF;

    IF NEW."entryMode" = 'DETAIL'
       AND (NEW."year", NEW."month") IS DISTINCT FROM (OLD."year", OLD."month")
       AND EXISTS (
           SELECT 1
             FROM "VariableExpenseEntry"
            WHERE "variableExpenseMonthId" = NEW."id"
              AND (
                  EXTRACT(YEAR FROM "spentOn")::INTEGER <> NEW."year"
                  OR EXTRACT(MONTH FROM "spentOn")::INTEGER <> NEW."month"
              )
       ) THEN
        RAISE EXCEPTION 'Existing entries must belong to the updated year and month'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "variable_expense_month_update_guard"
BEFORE UPDATE OF "entryMode", "year", "month"
ON "VariableExpenseMonth"
FOR EACH ROW
EXECUTE FUNCTION "budgetapp_validate_variable_expense_month_update"();
