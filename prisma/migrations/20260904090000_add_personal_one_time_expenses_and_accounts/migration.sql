-- Allow invoices to belong to a person as well as to the household.
ALTER TABLE "UtilityInvoice"
  ADD COLUMN "personalPersonId" UUID,
  ADD COLUMN "scope" "ExpenseScope" NOT NULL DEFAULT 'HOUSEHOLD';

CREATE INDEX "UtilityInvoice_personalPersonId_idx" ON "UtilityInvoice"("personalPersonId");

CREATE TABLE "OneTimeExpense" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "personalPersonId" UUID,
    "name" VARCHAR(120) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "scope" "ExpenseScope" NOT NULL DEFAULT 'HOUSEHOLD',
    "expenseDate" DATE NOT NULL,
    "notes" VARCHAR(2000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OneTimeExpense_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OneTimeExpense_householdId_expenseDate_idx" ON "OneTimeExpense"("householdId", "expenseDate");
CREATE INDEX "OneTimeExpense_categoryId_idx" ON "OneTimeExpense"("categoryId");
CREATE INDEX "OneTimeExpense_personalPersonId_idx" ON "OneTimeExpense"("personalPersonId");

CREATE TABLE "HouseholdAccount" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "personalPersonId" UUID,
    "name" VARCHAR(120) NOT NULL,
    "scope" "ExpenseScope" NOT NULL DEFAULT 'HOUSEHOLD',
    "balanceCents" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HouseholdAccount_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HouseholdAccount_householdId_scope_isActive_idx" ON "HouseholdAccount"("householdId", "scope", "isActive");
CREATE INDEX "HouseholdAccount_personalPersonId_idx" ON "HouseholdAccount"("personalPersonId");

ALTER TABLE "UtilityInvoice"
  ADD CONSTRAINT "UtilityInvoice_personalPersonId_fkey"
  FOREIGN KEY ("personalPersonId") REFERENCES "HouseholdPerson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OneTimeExpense"
  ADD CONSTRAINT "OneTimeExpense_householdId_fkey"
  FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "OneTimeExpense_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "OneTimeExpense_personalPersonId_fkey"
  FOREIGN KEY ("personalPersonId") REFERENCES "HouseholdPerson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HouseholdAccount"
  ADD CONSTRAINT "HouseholdAccount_householdId_fkey"
  FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "HouseholdAccount_personalPersonId_fkey"
  FOREIGN KEY ("personalPersonId") REFERENCES "HouseholdPerson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
