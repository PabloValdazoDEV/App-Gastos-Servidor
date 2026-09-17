-- Additive only: existing one-time expenses default to no margin.
-- Invoice/month histories are untouched; absent preferences mean disabled.
ALTER TABLE "OneTimeExpense" ADD COLUMN "applySafetyMargin" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "BudgetMarginExpenseType" AS ENUM ('INVOICE', 'VARIABLE');

CREATE TABLE "BudgetMarginPreference" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "expenseType" "BudgetMarginExpenseType" NOT NULL,
    "scope" "ExpenseScope" NOT NULL DEFAULT 'HOUSEHOLD',
    "personalPersonId" UUID,
    "ownerKey" VARCHAR(40) NOT NULL,
    "applySafetyMargin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BudgetMarginPreference_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BudgetMarginPreference_owner_check" CHECK (
      ("scope" = 'HOUSEHOLD' AND "personalPersonId" IS NULL AND "ownerKey" = 'HOUSEHOLD')
      OR ("scope" = 'PERSONAL' AND "personalPersonId" IS NOT NULL AND "ownerKey" = "personalPersonId"::text)
    )
);

CREATE UNIQUE INDEX "BudgetMarginPreference_group_key" ON "BudgetMarginPreference"("householdId", "expenseType", "categoryId", "ownerKey");
CREATE INDEX "BudgetMarginPreference_categoryId_idx" ON "BudgetMarginPreference"("categoryId");
CREATE INDEX "BudgetMarginPreference_personalPersonId_idx" ON "BudgetMarginPreference"("personalPersonId");

ALTER TABLE "BudgetMarginPreference" ADD CONSTRAINT "BudgetMarginPreference_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BudgetMarginPreference" ADD CONSTRAINT "BudgetMarginPreference_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BudgetMarginPreference" ADD CONSTRAINT "BudgetMarginPreference_personalPersonId_fkey" FOREIGN KEY ("personalPersonId") REFERENCES "HouseholdPerson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
