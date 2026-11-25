-- AlterEnum
ALTER TYPE "ContributionMode" ADD VALUE 'INCOME';

-- AlterTable
ALTER TABLE "HouseholdPerson" ADD COLUMN     "annualGrossIncomeCents" INTEGER;
