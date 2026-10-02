ALTER TABLE "UtilityInvoice"
ADD COLUMN "paidAt" DATE;

ALTER TABLE "OneTimeExpense"
ADD COLUMN "paidAt" DATE;

ALTER TABLE "VariableExpenseMonth"
ADD COLUMN "paidAt" DATE;

ALTER TABLE "VariableExpenseEntry"
ADD COLUMN "paidAt" DATE;
