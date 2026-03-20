-- CreateTable
CREATE TABLE "workflows" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "events" JSONB NOT NULL,
    "user_id" TEXT,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recording_screenshots" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "label" TEXT,
    "url" TEXT,
    "data_url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recording_screenshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playback_runs" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "played_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" TEXT,

    CONSTRAINT "playback_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playback_checkpoints" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "label" TEXT,
    "data_url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playback_checkpoints_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "recording_screenshots" ADD CONSTRAINT "recording_screenshots_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playback_runs" ADD CONSTRAINT "playback_runs_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playback_checkpoints" ADD CONSTRAINT "playback_checkpoints_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "playback_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
