-- CreateEnum
CREATE TYPE "LegalDocumentType" AS ENUM ('PRIVACY_POLICY');

-- CreateEnum
CREATE TYPE "LegalAcceptanceSource" AS ENUM ('REGISTRATION');

-- CreateTable
CREATE TABLE "LegalDocumentAcceptance" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "documentType" "LegalDocumentType" NOT NULL,
    "documentVersion" VARCHAR(120) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "LegalAcceptanceSource" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalDocumentAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LegalDocumentAcceptance_userId_documentType_documentVersion_key"
    ON "LegalDocumentAcceptance"("userId", "documentType", "documentVersion");

-- CreateIndex
CREATE INDEX "LegalDocumentAcceptance_userId_acceptedAt_idx"
    ON "LegalDocumentAcceptance"("userId", "acceptedAt");

-- AddForeignKey
ALTER TABLE "LegalDocumentAcceptance"
    ADD CONSTRAINT "LegalDocumentAcceptance_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
