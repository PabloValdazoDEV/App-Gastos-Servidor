ALTER TYPE "AuditAction" ADD VALUE 'PURCHASE_DOCUMENT_ANALYZED';
ALTER TYPE "AuditAction" ADD VALUE 'PURCHASE_DOCUMENT_ANALYSIS_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'PURCHASE_DOCUMENT_ANALYSIS_CONFIRMED';

CREATE TYPE "PurchaseDocumentAnalysisStatus" AS ENUM ('COMPLETED', 'FAILED', 'CONFIRMED');
CREATE TABLE "PurchaseDocumentAnalysis" (
  "id" UUID NOT NULL,
  "purchaseDocumentId" UUID NOT NULL,
  "requestedByUserId" UUID NOT NULL,
  "provider" VARCHAR(40) NOT NULL,
  "model" VARCHAR(120) NOT NULL,
  "status" "PurchaseDocumentAnalysisStatus" NOT NULL,
  "extractedData" JSONB,
  "reviewedData" JSONB,
  "sourcePurchaseVersion" CHAR(64) NOT NULL,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "totalTokens" INTEGER,
  "failureCode" VARCHAR(100),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "confirmedAt" TIMESTAMP(3),
  "confirmedByUserId" UUID,
  CONSTRAINT "PurchaseDocumentAnalysis_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurchaseDocumentAnalysis_usage_check" CHECK (
    ("inputTokens" IS NULL OR "inputTokens" >= 0) AND
    ("outputTokens" IS NULL OR "outputTokens" >= 0) AND
    ("totalTokens" IS NULL OR "totalTokens" >= 0)
  ),
  CONSTRAINT "PurchaseDocumentAnalysis_state_check" CHECK (
    ("status" = 'FAILED' AND "extractedData" IS NULL AND "failureCode" IS NOT NULL AND "reviewedData" IS NULL AND "confirmedAt" IS NULL AND "confirmedByUserId" IS NULL) OR
    ("status" = 'COMPLETED' AND jsonb_typeof("extractedData") = 'object' AND "extractedData" IS NOT NULL AND "failureCode" IS NULL AND "reviewedData" IS NULL AND "confirmedAt" IS NULL AND "confirmedByUserId" IS NULL) OR
    ("status" = 'CONFIRMED' AND jsonb_typeof("extractedData") = 'object' AND "extractedData" IS NOT NULL AND "failureCode" IS NULL AND jsonb_typeof("reviewedData") = 'object' AND "reviewedData" IS NOT NULL AND "confirmedAt" IS NOT NULL AND "confirmedByUserId" IS NOT NULL)
  )
);
CREATE INDEX "PurchaseDocumentAnalysis_purchaseDocumentId_createdAt_idx" ON "PurchaseDocumentAnalysis"("purchaseDocumentId", "createdAt");
CREATE INDEX "PurchaseDocumentAnalysis_requestedByUserId_createdAt_idx" ON "PurchaseDocumentAnalysis"("requestedByUserId", "createdAt");
CREATE INDEX "PurchaseDocumentAnalysis_confirmedByUserId_idx" ON "PurchaseDocumentAnalysis"("confirmedByUserId");
ALTER TABLE "PurchaseDocumentAnalysis" ADD CONSTRAINT "PurchaseDocumentAnalysis_purchaseDocumentId_fkey" FOREIGN KEY ("purchaseDocumentId") REFERENCES "PurchaseDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseDocumentAnalysis" ADD CONSTRAINT "PurchaseDocumentAnalysis_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseDocumentAnalysis" ADD CONSTRAINT "PurchaseDocumentAnalysis_confirmedByUserId_fkey" FOREIGN KEY ("confirmedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
