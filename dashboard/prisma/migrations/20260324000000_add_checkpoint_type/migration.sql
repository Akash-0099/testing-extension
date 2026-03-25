-- AlterTable: make data_url nullable and add checkpoint_type + captured_data columns
ALTER TABLE "playback_checkpoints"
  ALTER COLUMN "data_url" DROP NOT NULL,
  ADD COLUMN "checkpoint_type" TEXT,
  ADD COLUMN "captured_data" TEXT;
