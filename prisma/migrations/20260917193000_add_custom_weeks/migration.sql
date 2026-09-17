-- Additive migration: no conversion or rewriting of existing expenses.
BEGIN;

ALTER TYPE "ExpenseFrequency" ADD VALUE 'CUSTOM_WEEKS';
ALTER TABLE "RecurringExpense" ADD COLUMN "intervalWeeks" INTEGER;

-- Use text here so the newly added enum value is not consumed before COMMIT.
-- Existing rows have intervalWeeks = NULL and satisfy this constraint unchanged.
ALTER TABLE "RecurringExpense"
  ADD CONSTRAINT "RecurringExpense_intervalWeeks_shape_check" CHECK (
    ("frequency"::text = 'CUSTOM_WEEKS'
      AND "intervalWeeks" IS NOT NULL
      AND "intervalWeeks" BETWEEN 2 AND 520)
    OR ("frequency"::text <> 'CUSTOM_WEEKS' AND "intervalWeeks" IS NULL)
  );

COMMIT;
