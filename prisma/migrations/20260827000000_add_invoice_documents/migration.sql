-- CreateTable
CREATE TABLE "InvoiceDocument" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "uploadedByUserId" UUID,
    "filename" VARCHAR(255) NOT NULL,
    "contentType" VARCHAR(64) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceDocument_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InvoiceDocument_size_check"
        CHECK ("sizeBytes" BETWEEN 1 AND 10485760),
    CONSTRAINT "InvoiceDocument_content_length_check"
        CHECK (octet_length("content") = "sizeBytes"),
    CONSTRAINT "InvoiceDocument_content_type_check"
        CHECK (
            "contentType" IN (
                'application/pdf',
                'image/jpeg',
                'image/png',
                'image/webp'
            )
        )
);

-- CreateIndex
CREATE INDEX "InvoiceDocument_invoiceId_createdAt_idx"
    ON "InvoiceDocument"("invoiceId", "createdAt");

-- CreateIndex
CREATE INDEX "InvoiceDocument_uploadedByUserId_idx"
    ON "InvoiceDocument"("uploadedByUserId");

-- AddForeignKey
ALTER TABLE "InvoiceDocument"
    ADD CONSTRAINT "InvoiceDocument_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "UtilityInvoice"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceDocument"
    ADD CONSTRAINT "InvoiceDocument_uploadedByUserId_fkey"
    FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
