-- Financial allocation snapshots, not new payments. For already confirmed 6.3
-- payments the only available baseline is ownership/current user links at this
-- migration. Do not infer older ownership, dates, amounts or payment evidence.
ALTER TABLE "Purchase" ADD COLUMN "paymentAllocationSnapshot" JSONB;
ALTER TABLE "PurchaseFinancing" ADD COLUMN "downPaymentAllocationSnapshot" JSONB;
ALTER TABLE "PurchaseInstallment" ADD COLUMN "paymentAllocationSnapshot" JSONB;

CREATE FUNCTION purchase_allocation_snapshot_for_migration(target_id UUID) RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'version', 1, 'householdId', p."householdId", 'ownershipType', p."ownershipType",
    'allocations', CASE p."ownershipType"
      WHEN 'HOUSEHOLD' THEN jsonb_build_array(jsonb_build_object(
        'scope', 'HOUSEHOLD', 'personalPersonId', NULL, 'linkedUserId', NULL, 'shareBps', 10000))
      WHEN 'PERSONAL' THEN jsonb_build_array(jsonb_build_object(
        'scope', 'PERSONAL', 'personalPersonId', p."personalPersonId", 'linkedUserId', hp."linkedUserId", 'shareBps', 10000))
      ELSE (SELECT jsonb_agg(jsonb_build_object(
        'scope', 'PERSONAL', 'personalPersonId', s."householdPersonId", 'linkedUserId', sp."linkedUserId", 'shareBps', s."shareBps")
        ORDER BY s."householdPersonId")
        FROM "PurchaseShare" s JOIN "HouseholdPerson" sp ON sp."id" = s."householdPersonId" WHERE s."purchaseId" = p."id")
    END)
  FROM "Purchase" p LEFT JOIN "HouseholdPerson" hp ON hp."id" = p."personalPersonId" WHERE p."id" = target_id;
$$;

UPDATE "Purchase" p SET "paymentAllocationSnapshot" = purchase_allocation_snapshot_for_migration(p."id")
  WHERE p."paymentMethod" = 'UPFRONT' AND p."paymentDate" IS NOT NULL AND p."paidAmountCents" IS NOT NULL;
UPDATE "PurchaseFinancing" f SET "downPaymentAllocationSnapshot" = purchase_allocation_snapshot_for_migration(f."purchaseId")
  WHERE f."downPaymentPaidAt" IS NOT NULL;
UPDATE "PurchaseInstallment" i SET "paymentAllocationSnapshot" = purchase_allocation_snapshot_for_migration(f."purchaseId")
  FROM "PurchaseFinancing" f WHERE f."id" = i."purchaseFinancingId" AND i."status" = 'PAID';
DROP FUNCTION purchase_allocation_snapshot_for_migration(UUID);

CREATE FUNCTION valid_purchase_allocation_snapshot(snapshot JSONB) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE part JSONB; count_parts INTEGER; total_bps INTEGER := 0; bps INTEGER; personal_ids TEXT[] := '{}'; ownership TEXT;
BEGIN
  IF snapshot IS NULL OR jsonb_typeof(snapshot) IS DISTINCT FROM 'object'
    OR snapshot->'version' IS DISTINCT FROM '1'::JSONB
    OR jsonb_typeof(snapshot->'householdId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(snapshot->'allocations') IS DISTINCT FROM 'array'
  THEN RETURN FALSE; END IF;
  ownership := snapshot->>'ownershipType';
  count_parts := jsonb_array_length(snapshot->'allocations');
  IF ownership IS NULL OR ownership NOT IN ('HOUSEHOLD', 'PERSONAL', 'SPLIT')
    OR count_parts < 1 OR count_parts > 100
    OR (ownership = 'SPLIT' AND count_parts < 2)
    OR (ownership != 'SPLIT' AND count_parts != 1)
  THEN RETURN FALSE; END IF;
  FOR part IN SELECT value FROM jsonb_array_elements(snapshot->'allocations') LOOP
    IF jsonb_typeof(part) IS DISTINCT FROM 'object' OR jsonb_typeof(part->'shareBps') IS DISTINCT FROM 'number'
      OR (part->>'shareBps') !~ '^[0-9]+$'
      OR NOT (part ? 'personalPersonId') OR NOT (part ? 'linkedUserId')
    THEN RETURN FALSE; END IF;
    bps := (part->>'shareBps')::INTEGER;
    IF bps < 1 OR bps > 10000 THEN RETURN FALSE; END IF;
    total_bps := total_bps + bps;
    IF ownership = 'HOUSEHOLD' THEN
      IF part->>'scope' IS DISTINCT FROM 'HOUSEHOLD' OR part->'personalPersonId' IS DISTINCT FROM 'null'::JSONB
        OR part->'linkedUserId' IS DISTINCT FROM 'null'::JSONB THEN RETURN FALSE; END IF;
    ELSE
      IF part->>'scope' IS DISTINCT FROM 'PERSONAL' OR jsonb_typeof(part->'personalPersonId') IS DISTINCT FROM 'string'
        OR length(part->>'personalPersonId') = 0 OR (part->>'personalPersonId') = ANY(personal_ids)
        OR jsonb_typeof(part->'linkedUserId') NOT IN ('string', 'null')
      THEN RETURN FALSE; END IF;
      personal_ids := array_append(personal_ids, part->>'personalPersonId');
    END IF;
  END LOOP;
  RETURN total_bps = 10000;
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END;
$$;

ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_payment_allocation_check" CHECK (
  ("paymentDate" IS NULL AND "paymentAllocationSnapshot" IS NULL)
  OR ("paymentDate" IS NOT NULL AND valid_purchase_allocation_snapshot("paymentAllocationSnapshot")
    AND "paymentAllocationSnapshot"->>'householdId' = "householdId"::TEXT)
);
ALTER TABLE "PurchaseFinancing" ADD CONSTRAINT "PurchaseFinancing_down_payment_allocation_check" CHECK (
  ("downPaymentPaidAt" IS NULL AND "downPaymentAllocationSnapshot" IS NULL)
  OR ("downPaymentPaidAt" IS NOT NULL AND valid_purchase_allocation_snapshot("downPaymentAllocationSnapshot"))
);
ALTER TABLE "PurchaseInstallment" ADD CONSTRAINT "PurchaseInstallment_payment_allocation_check" CHECK (
  ("status" != 'PAID' AND "paymentAllocationSnapshot" IS NULL)
  OR ("status" = 'PAID' AND valid_purchase_allocation_snapshot("paymentAllocationSnapshot"))
);

-- History need not match CURRENT ownership; that difference is intentional.
-- Only the household identity must remain the same for every stored payment.
CREATE FUNCTION check_purchase_allocation_household() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE expected_household UUID; snapshot JSONB;
BEGIN
  IF TG_TABLE_NAME = 'PurchaseFinancing' THEN
    SELECT p."householdId", f."downPaymentAllocationSnapshot" INTO expected_household, snapshot
      FROM "PurchaseFinancing" f JOIN "Purchase" p ON p."id" = f."purchaseId" WHERE f."id" = NEW."id";
  ELSE
    SELECT p."householdId", i."paymentAllocationSnapshot" INTO expected_household, snapshot
      FROM "PurchaseInstallment" i JOIN "PurchaseFinancing" f ON f."id" = i."purchaseFinancingId"
      JOIN "Purchase" p ON p."id" = f."purchaseId" WHERE i."id" = NEW."id";
  END IF;
  IF FOUND AND snapshot IS NOT NULL AND snapshot->>'householdId' IS DISTINCT FROM expected_household::TEXT THEN
    RAISE EXCEPTION 'Payment allocation must remain in its original household' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "PurchaseFinancing_allocation_household" AFTER INSERT OR UPDATE ON "PurchaseFinancing" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_purchase_allocation_household();
CREATE CONSTRAINT TRIGGER "PurchaseInstallment_allocation_household" AFTER INSERT OR UPDATE ON "PurchaseInstallment" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_purchase_allocation_household();
