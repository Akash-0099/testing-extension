-- AlterTable: add test result fields to playback_runs
ALTER TABLE "playback_runs"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'passed',
  ADD COLUMN "failed_event_index" INTEGER,
  ADD COLUMN "failed_event_type" TEXT,
  ADD COLUMN "failed_event_selector" TEXT;
