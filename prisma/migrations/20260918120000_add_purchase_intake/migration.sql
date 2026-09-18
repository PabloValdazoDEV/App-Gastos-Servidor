CREATE TABLE "PurchaseDraft" (
  "id" UUID NOT NULL,
  "householdId" UUID NOT NULL,
  "uploadedByUserId" UUID NOT NULL,
  "filename" VARCHAR(255) NOT NULL,
  "contentType" VARCHAR(100) NOT NULL,
  "sizeBytes" INTEGER NOT NULL CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 10485760),
  "content" BYTEA,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "confirmedPurchaseId" UUID,
  "confirmationHash" CHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PurchaseDraft_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurchaseDraft_content_check" CHECK (
    ("confirmedPurchaseId" IS NULL AND "content" IS NOT NULL AND octet_length("content") = "sizeBytes")
    OR ("confirmedPurchaseId" IS NOT NULL AND "content" IS NULL)
  ),
  CONSTRAINT "PurchaseDraft_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PurchaseDraft_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PurchaseDraft_confirmedPurchaseId_fkey" FOREIGN KEY ("confirmedPurchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PurchaseDraft_confirmedPurchaseId_key" ON "PurchaseDraft"("confirmedPurchaseId");
CREATE INDEX "PurchaseDraft_householdId_uploadedByUserId_expiresAt_idx" ON "PurchaseDraft"("householdId", "uploadedByUserId", "expiresAt");
CREATE TABLE "PurchaseDraftAnalysis" (
  "id" UUID NOT NULL,
  "draftId" UUID NOT NULL,
  "provider" VARCHAR(40) NOT NULL,
  "model" VARCHAR(120) NOT NULL,
  "status" "PurchaseDocumentAnalysisStatus" NOT NULL,
  "extractedData" JSONB,
  "inputTokens" INTEGER CHECK ("inputTokens" >= 0),
  "outputTokens" INTEGER CHECK ("outputTokens" >= 0),
  "totalTokens" INTEGER CHECK ("totalTokens" >= 0),
  "failureCode" VARCHAR(100),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PurchaseDraftAnalysis_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurchaseDraftAnalysis_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "PurchaseDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PurchaseDraftAnalysis_draftId_createdAt_idx" ON "PurchaseDraftAnalysis"("draftId", "createdAt");
