/*
  Warnings:

  - Added the required column `payment_method_id` to the `payments` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "customer_id" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "payment_method_id" TEXT NOT NULL;
