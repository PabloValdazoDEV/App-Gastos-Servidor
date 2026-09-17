-- Additive payment model. Existing purchases become unconfirmed UPFRONT only:
-- no dates, paid amounts, installments, or financial movements are invented.
CREATE TYPE "PurchasePaymentMethod" AS ENUM ('UPFRONT', 'FINANCED');
CREATE TYPE "PurchaseInstallmentStatus" AS ENUM ('PLANNED', 'PAID', 'CANCELLED');
ALTER TYPE "AuditAction" ADD VALUE 'PURCHASE_PAYMENT_METHOD_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'PURCHASE_PAYMENT_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'PURCHASE_FINANCING_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PURCHASE_FINANCING_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'PURCHASE_INSTALLMENT_PAID';
ALTER TYPE "AuditAction" ADD VALUE 'PURCHASE_INSTALLMENT_CORRECTED';

ALTER TABLE "Purchase"
  ADD COLUMN "paymentMethod" "PurchasePaymentMethod" NOT NULL DEFAULT 'UPFRONT',
  ADD COLUMN "paymentDate" DATE,
  ADD COLUMN "paidAmountCents" INTEGER,
  ADD CONSTRAINT "Purchase_upfront_payment_check" CHECK (
    ("paymentDate" IS NULL AND "paidAmountCents" IS NULL)
    OR ("paymentMethod" = 'UPFRONT' AND "paymentDate" IS NOT NULL AND "paidAmountCents" IS NOT NULL AND "paidAmountCents" >= 0)
  );

CREATE TABLE "PurchaseFinancing" (
  "id" UUID NOT NULL,
  "purchaseId" UUID NOT NULL,
  "provider" VARCHAR(200),
  "downPaymentCents" INTEGER NOT NULL DEFAULT 0,
  "downPaymentPaidAt" DATE,
  "financedPrincipalCents" INTEGER NOT NULL,
  "installmentCount" INTEGER NOT NULL,
  "installmentAmountCents" INTEGER NOT NULL,
  "firstInstallmentDate" DATE NOT NULL,
  "financingTotalCents" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PurchaseFinancing_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurchaseFinancing_amounts_check" CHECK (
    "downPaymentCents" >= 0 AND "financedPrincipalCents" >= 0
    AND "financingTotalCents" >= "financedPrincipalCents" AND "financingTotalCents" > 0
    AND "installmentAmountCents" > 0 AND "installmentCount" BETWEEN 1 AND 1200
    AND ("downPaymentPaidAt" IS NULL OR "downPaymentCents" > 0)
    AND "financingTotalCents"::BIGINT - ("installmentCount" - 1)::BIGINT * "installmentAmountCents"::BIGINT BETWEEN 1 AND 2147483647
  )
);
CREATE TABLE "PurchaseInstallment" (
  "id" UUID NOT NULL,
  "purchaseFinancingId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "dueDate" DATE NOT NULL,
  "expectedAmountCents" INTEGER NOT NULL,
  "actualAmountCents" INTEGER,
  "paidAt" DATE,
  "status" "PurchaseInstallmentStatus" NOT NULL DEFAULT 'PLANNED',
  "notes" VARCHAR(2000),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PurchaseInstallment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurchaseInstallment_expected_check" CHECK ("sequence" BETWEEN 1 AND 1200 AND "expectedAmountCents" > 0),
  CONSTRAINT "PurchaseInstallment_payment_check" CHECK (
    ("status" = 'PAID' AND "actualAmountCents" IS NOT NULL AND "actualAmountCents" > 0 AND "paidAt" IS NOT NULL)
    OR ("status" != 'PAID' AND "actualAmountCents" IS NULL AND "paidAt" IS NULL)
  )
);
CREATE UNIQUE INDEX "PurchaseFinancing_purchaseId_key" ON "PurchaseFinancing"("purchaseId");
CREATE UNIQUE INDEX "PurchaseInstallment_purchaseFinancingId_sequence_key" ON "PurchaseInstallment"("purchaseFinancingId", "sequence");
CREATE INDEX "PurchaseInstallment_purchaseFinancingId_status_dueDate_idx" ON "PurchaseInstallment"("purchaseFinancingId", "status", "dueDate");
ALTER TABLE "PurchaseFinancing" ADD CONSTRAINT "PurchaseFinancing_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseInstallment" ADD CONSTRAINT "PurchaseInstallment_purchaseFinancingId_fkey" FOREIGN KEY ("purchaseFinancingId") REFERENCES "PurchaseFinancing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION assert_purchase_payment_integrity(target_id UUID) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE p "Purchase"%ROWTYPE; f "PurchaseFinancing"%ROWTYPE; installment_total BIGINT; installments_count INTEGER;
BEGIN
  SELECT * INTO p FROM "Purchase" WHERE "id" = target_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO f FROM "PurchaseFinancing" WHERE "purchaseId" = target_id;
  IF p."paymentMethod" = 'UPFRONT' THEN
    IF FOUND THEN RAISE EXCEPTION 'Upfront purchase cannot have financing' USING ERRCODE = '23514'; END IF;
    RETURN;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Financed purchase requires financing' USING ERRCODE = '23514'; END IF;
  IF f."downPaymentCents"::BIGINT + f."financedPrincipalCents"::BIGINT != p."totalCents"::BIGINT THEN
    RAISE EXCEPTION 'Financing principal must equal purchase price minus down payment' USING ERRCODE = '23514';
  END IF;
  SELECT count(*), coalesce(sum("expectedAmountCents"), 0) INTO installments_count, installment_total
    FROM "PurchaseInstallment" WHERE "purchaseFinancingId" = f."id";
  IF installments_count != f."installmentCount" OR installment_total != f."financingTotalCents" THEN
    RAISE EXCEPTION 'Installments must match financing count and exact total' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "PurchaseInstallment" i WHERE i."purchaseFinancingId" = f."id" AND (
      i."sequence" > f."installmentCount"
      OR i."dueDate" != (f."firstInstallmentDate" + (i."sequence" - 1) * INTERVAL '1 month')::DATE
      OR i."expectedAmountCents" != CASE WHEN i."sequence" = f."installmentCount"
        THEN f."financingTotalCents"::BIGINT - (f."installmentCount" - 1)::BIGINT * f."installmentAmountCents"::BIGINT
        ELSE f."installmentAmountCents"::BIGINT END
    )
  ) THEN RAISE EXCEPTION 'Installment schedule must be anchored and preserve exact cents' USING ERRCODE = '23514'; END IF;
END;
$$;

CREATE FUNCTION check_purchase_payment_integrity() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'Purchase' THEN
    IF TG_OP != 'DELETE' THEN PERFORM assert_purchase_payment_integrity(NEW."id"); END IF;
  ELSIF TG_TABLE_NAME = 'PurchaseFinancing' THEN
    IF TG_OP != 'DELETE' THEN PERFORM assert_purchase_payment_integrity(NEW."purchaseId"); END IF;
    IF TG_OP != 'INSERT' THEN PERFORM assert_purchase_payment_integrity(OLD."purchaseId"); END IF;
  ELSE
    IF TG_OP != 'DELETE' THEN
      SELECT "purchaseId" INTO target_id FROM "PurchaseFinancing" WHERE "id" = NEW."purchaseFinancingId";
      IF FOUND THEN PERFORM assert_purchase_payment_integrity(target_id); END IF;
    END IF;
    IF TG_OP != 'INSERT' THEN
      SELECT "purchaseId" INTO target_id FROM "PurchaseFinancing" WHERE "id" = OLD."purchaseFinancingId";
      IF FOUND THEN PERFORM assert_purchase_payment_integrity(target_id); END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "Purchase_payment_integrity" AFTER INSERT OR UPDATE ON "Purchase" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_purchase_payment_integrity();
CREATE CONSTRAINT TRIGGER "PurchaseFinancing_integrity" AFTER INSERT OR UPDATE OR DELETE ON "PurchaseFinancing" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_purchase_payment_integrity();
CREATE CONSTRAINT TRIGGER "PurchaseInstallment_integrity" AFTER INSERT OR UPDATE OR DELETE ON "PurchaseInstallment" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_purchase_payment_integrity();
