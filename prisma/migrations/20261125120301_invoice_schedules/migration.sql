-- AlterTable
ALTER TABLE "UtilityInvoice" ADD COLUMN     "scheduleId" UUID;

-- CreateTable
CREATE TABLE "InvoiceSchedule" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "personalPersonId" UUID,
    "name" VARCHAR(120) NOT NULL,
    "scope" "ExpenseScope" NOT NULL DEFAULT 'HOUSEHOLD',
    "frequency" "ExpenseFrequency" NOT NULL,
    "intervalMonths" INTEGER,
    "intervalWeeks" INTEGER,
    "usualDayOfMonth" INTEGER,
    "nextExpectedDate" DATE NOT NULL,
    "endDate" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvoiceSchedule_householdId_isActive_nextExpectedDate_idx" ON "InvoiceSchedule"("householdId", "isActive", "nextExpectedDate");

-- CreateIndex
CREATE INDEX "InvoiceSchedule_categoryId_idx" ON "InvoiceSchedule"("categoryId");

-- CreateIndex
CREATE INDEX "InvoiceSchedule_personalPersonId_idx" ON "InvoiceSchedule"("personalPersonId");

-- CreateIndex
CREATE INDEX "UtilityInvoice_scheduleId_idx" ON "UtilityInvoice"("scheduleId");

-- AddForeignKey
ALTER TABLE "UtilityInvoice" ADD CONSTRAINT "UtilityInvoice_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "InvoiceSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceSchedule" ADD CONSTRAINT "InvoiceSchedule_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceSchedule" ADD CONSTRAINT "InvoiceSchedule_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceSchedule" ADD CONSTRAINT "InvoiceSchedule_personalPersonId_fkey" FOREIGN KEY ("personalPersonId") REFERENCES "HouseholdPerson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
