-- Existing purchases retain their original multi-product structure.
ALTER TABLE "Purchase" ADD COLUMN "singleProduct" BOOLEAN NOT NULL DEFAULT false;
