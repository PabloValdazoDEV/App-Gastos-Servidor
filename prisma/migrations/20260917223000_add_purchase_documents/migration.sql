-- Additive private documents. No existing purchases or financial data change.
CREATE TYPE "PurchaseDocumentType" AS ENUM ('RECEIPT', 'INVOICE', 'WARRANTY', 'OTHER');
ALTER TYPE "AuditAction" ADD VALUE 'PURCHASE_DOCUMENT_ADDED';
ALTER TYPE "AuditAction" ADD VALUE 'PURCHASE_DOCUMENT_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'PURCHASE_DOCUMENT_DELETED';

CREATE TABLE "PurchaseDocument" (
  "id" UUID NOT NULL,
  "purchaseId" UUID NOT NULL,
  "purchaseItemId" UUID,
  "uploadedByUserId" UUID NOT NULL,
  "type" "PurchaseDocumentType" NOT NULL DEFAULT 'OTHER',
  "filename" VARCHAR(255) NOT NULL,
  "contentType" VARCHAR(100) NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PurchaseDocument_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurchaseDocument_size_check" CHECK ("sizeBytes" BETWEEN 1 AND 10485760),
  CONSTRAINT "PurchaseDocument_filename_check" CHECK (length(trim("filename")) > 0),
  CONSTRAINT "PurchaseDocument_type_check" CHECK ("contentType" IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp'))
);
CREATE TABLE "PurchaseDocumentContent" (
  "documentId" UUID NOT NULL,
  "content" BYTEA NOT NULL,
  CONSTRAINT "PurchaseDocumentContent_pkey" PRIMARY KEY ("documentId")
);
CREATE INDEX "PurchaseDocument_purchaseId_createdAt_idx" ON "PurchaseDocument"("purchaseId", "createdAt");
CREATE INDEX "PurchaseDocument_purchaseItemId_idx" ON "PurchaseDocument"("purchaseItemId");
CREATE INDEX "PurchaseDocument_uploadedByUserId_idx" ON "PurchaseDocument"("uploadedByUserId");
ALTER TABLE "PurchaseDocument" ADD CONSTRAINT "PurchaseDocument_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseDocument" ADD CONSTRAINT "PurchaseDocument_purchaseItemId_fkey" FOREIGN KEY ("purchaseItemId") REFERENCES "PurchaseItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PurchaseDocument" ADD CONSTRAINT "PurchaseDocument_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseDocumentContent" ADD CONSTRAINT "PurchaseDocumentContent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "PurchaseDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- These deferred checks allow metadata + bytes to be inserted/deleted in one
-- transaction while prohibiting orphan/missing binaries and cross-purchase items.
CREATE FUNCTION assert_purchase_document_integrity(target_id UUID) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE document "PurchaseDocument"%ROWTYPE; stored_size INTEGER;
BEGIN
  SELECT * INTO document FROM "PurchaseDocument" WHERE "id" = target_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF document."purchaseItemId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "PurchaseItem" WHERE "id" = document."purchaseItemId" AND "purchaseId" = document."purchaseId"
  ) THEN RAISE EXCEPTION 'Purchase document item must belong to purchase' USING ERRCODE = '23514'; END IF;
  SELECT octet_length("content") INTO stored_size FROM "PurchaseDocumentContent" WHERE "documentId" = target_id;
  IF stored_size IS NULL OR stored_size != document."sizeBytes" THEN
    RAISE EXCEPTION 'Purchase document content must exist and match metadata size' USING ERRCODE = '23514';
  END IF;
END;
$$;
CREATE FUNCTION check_purchase_document_integrity() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'PurchaseDocument' THEN
    IF TG_OP != 'DELETE' THEN PERFORM assert_purchase_document_integrity(NEW."id"); END IF;
  ELSE
    IF TG_OP != 'DELETE' THEN PERFORM assert_purchase_document_integrity(NEW."documentId"); END IF;
    IF TG_OP != 'INSERT' THEN PERFORM assert_purchase_document_integrity(OLD."documentId"); END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "PurchaseDocument_integrity" AFTER INSERT OR UPDATE ON "PurchaseDocument" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_purchase_document_integrity();
CREATE CONSTRAINT TRIGGER "PurchaseDocumentContent_integrity" AFTER INSERT OR UPDATE OR DELETE ON "PurchaseDocumentContent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_purchase_document_integrity();

CREATE FUNCTION check_purchase_document_item_move() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE document_id UUID;
BEGIN
  IF NEW."purchaseId" IS DISTINCT FROM OLD."purchaseId" THEN
    FOR document_id IN SELECT "id" FROM "PurchaseDocument" WHERE "purchaseItemId" = NEW."id"
    LOOP PERFORM assert_purchase_document_integrity(document_id); END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "PurchaseDocument_item_purchase_integrity" AFTER UPDATE ON "PurchaseItem" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_purchase_document_item_move();
