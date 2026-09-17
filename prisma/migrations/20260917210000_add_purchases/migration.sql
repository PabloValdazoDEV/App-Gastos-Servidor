-- Additive registry only. No existing financial data is changed or backfilled.
CREATE TYPE "PurchaseOwnershipType" AS ENUM ('HOUSEHOLD', 'PERSONAL', 'SPLIT');
CREATE TYPE "PurchaseWarrantySource" AS ENUM ('DURATION', 'EXPLICIT_DATE');
ALTER TYPE "AuditAction" ADD VALUE 'PURCHASE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PURCHASE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'PURCHASE_ARCHIVED';
ALTER TYPE "AuditAction" ADD VALUE 'PURCHASE_ITEM_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PURCHASE_ITEM_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'PURCHASE_ITEM_DELETED';

CREATE TABLE "Purchase" (
  "id" UUID NOT NULL,
  "householdId" UUID NOT NULL,
  "merchant" VARCHAR(200),
  "purchaseDate" DATE NOT NULL,
  "totalCents" INTEGER NOT NULL,
  "ownershipType" "PurchaseOwnershipType" NOT NULL DEFAULT 'HOUSEHOLD',
  "personalPersonId" UUID,
  "notes" VARCHAR(2000),
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Purchase_total_check" CHECK ("totalCents" >= 0),
  CONSTRAINT "Purchase_owner_check" CHECK (
    ("ownershipType" = 'PERSONAL' AND "personalPersonId" IS NOT NULL)
    OR ("ownershipType" != 'PERSONAL' AND "personalPersonId" IS NULL)
  )
);
CREATE TABLE "PurchaseShare" (
  "id" UUID NOT NULL,
  "purchaseId" UUID NOT NULL,
  "householdPersonId" UUID NOT NULL,
  "shareBps" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PurchaseShare_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurchaseShare_percentage_check" CHECK ("shareBps" > 0 AND "shareBps" <= 10000)
);
CREATE TABLE "PurchaseItem" (
  "id" UUID NOT NULL,
  "purchaseId" UUID NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "brand" VARCHAR(120),
  "model" VARCHAR(120),
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "priceCents" INTEGER,
  "serialNumber" VARCHAR(100),
  "imei" VARCHAR(100),
  "warrantySource" "PurchaseWarrantySource",
  "warrantyDurationMonths" INTEGER,
  "warrantyEndsAt" DATE,
  "notes" VARCHAR(2000),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PurchaseItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurchaseItem_name_check" CHECK (length(trim("name")) > 0),
  CONSTRAINT "PurchaseItem_quantity_check" CHECK ("quantity" BETWEEN 1 AND 10000),
  CONSTRAINT "PurchaseItem_price_check" CHECK ("priceCents" IS NULL OR "priceCents" >= 0),
  CONSTRAINT "PurchaseItem_warranty_check" CHECK (
    ("warrantySource" IS NULL AND "warrantyEndsAt" IS NULL AND "warrantyDurationMonths" IS NULL)
    OR ("warrantySource" IS NOT NULL AND (
      ("warrantySource" = 'EXPLICIT_DATE' AND "warrantyEndsAt" IS NOT NULL AND "warrantyDurationMonths" IS NULL)
      OR ("warrantySource" = 'DURATION' AND "warrantyEndsAt" IS NOT NULL AND "warrantyDurationMonths" IS NOT NULL AND "warrantyDurationMonths" BETWEEN 1 AND 1200)
    ))
  )
);
CREATE INDEX "Purchase_householdId_archivedAt_purchaseDate_idx" ON "Purchase"("householdId", "archivedAt", "purchaseDate");
CREATE INDEX "Purchase_personalPersonId_idx" ON "Purchase"("personalPersonId");
CREATE UNIQUE INDEX "PurchaseShare_purchaseId_householdPersonId_key" ON "PurchaseShare"("purchaseId", "householdPersonId");
CREATE INDEX "PurchaseShare_householdPersonId_idx" ON "PurchaseShare"("householdPersonId");
CREATE INDEX "PurchaseItem_purchaseId_idx" ON "PurchaseItem"("purchaseId");
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_personalPersonId_fkey" FOREIGN KEY ("personalPersonId") REFERENCES "HouseholdPerson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseShare" ADD CONSTRAINT "PurchaseShare_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseShare" ADD CONSTRAINT "PurchaseShare_householdPersonId_fkey" FOREIGN KEY ("householdPersonId") REFERENCES "HouseholdPerson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deferred aggregate checks allow atomic creation and ownership transitions.
-- The service uses Serializable transactions and writes the parent on item edits.
CREATE FUNCTION assert_purchase_integrity(target_id UUID) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE p "Purchase"%ROWTYPE; share_count INTEGER; share_total BIGINT;
BEGIN
  SELECT * INTO p FROM "Purchase" WHERE "id" = target_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF p."personalPersonId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "HouseholdPerson" WHERE "id" = p."personalPersonId" AND "householdId" = p."householdId"
  ) THEN RAISE EXCEPTION 'Purchase person must belong to household' USING ERRCODE = '23514'; END IF;
  IF EXISTS (
    SELECT 1 FROM "PurchaseShare" s JOIN "HouseholdPerson" hp ON hp."id" = s."householdPersonId"
    WHERE s."purchaseId" = p."id" AND hp."householdId" != p."householdId"
  ) THEN RAISE EXCEPTION 'Purchase share person must belong to household' USING ERRCODE = '23514'; END IF;
  SELECT count(*), coalesce(sum("shareBps"), 0) INTO share_count, share_total FROM "PurchaseShare" WHERE "purchaseId" = p."id";
  IF (p."ownershipType" = 'SPLIT' AND (share_count < 2 OR share_total != 10000))
    OR (p."ownershipType" != 'SPLIT' AND share_count != 0)
  THEN RAISE EXCEPTION 'Purchase ownership shares are inconsistent' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "PurchaseItem" WHERE "purchaseId" = p."id")
  THEN RAISE EXCEPTION 'Purchase requires at least one item' USING ERRCODE = '23514'; END IF;
END;
$$;

CREATE FUNCTION check_purchase_integrity() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'Purchase' THEN
    IF TG_OP != 'DELETE' THEN PERFORM assert_purchase_integrity(NEW."id"); END IF;
  ELSE
    IF TG_OP != 'DELETE' THEN PERFORM assert_purchase_integrity(NEW."purchaseId"); END IF;
    IF TG_OP != 'INSERT' THEN PERFORM assert_purchase_integrity(OLD."purchaseId"); END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "Purchase_integrity" AFTER INSERT OR UPDATE ON "Purchase" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_purchase_integrity();
CREATE CONSTRAINT TRIGGER "PurchaseShare_integrity" AFTER INSERT OR UPDATE OR DELETE ON "PurchaseShare" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_purchase_integrity();
CREATE CONSTRAINT TRIGGER "PurchaseItem_integrity" AFTER INSERT OR UPDATE OR DELETE ON "PurchaseItem" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_purchase_integrity();

-- Also prevent moving a referenced person to another household through direct SQL.
CREATE FUNCTION check_purchase_person_household() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE purchase_id UUID;
BEGIN
  IF NEW."householdId" IS DISTINCT FROM OLD."householdId" THEN
    FOR purchase_id IN SELECT "id" FROM "Purchase" WHERE "personalPersonId" = NEW."id"
      UNION SELECT "purchaseId" FROM "PurchaseShare" WHERE "householdPersonId" = NEW."id"
    LOOP PERFORM assert_purchase_integrity(purchase_id); END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "Purchase_person_household_integrity" AFTER UPDATE ON "HouseholdPerson" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_purchase_person_household();
