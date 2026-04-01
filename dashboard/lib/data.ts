import { randomUUID } from 'crypto'
import { Db } from 'mongodb'
import { getMongoDb } from './mongodb'

interface UserDoc {
  _id: string
  email: string
  passwordHash: string
  createdAt: Date
}

interface WorkflowDoc {
  _id: string
  name: string
  recordedAt: Date
  events: unknown[]
  userId?: string | null
}

interface RecordingScreenshotDoc {
  _id: string
  workflowId: string
  index: number
  label: string | null
  url: string | null
  dataUrl: string
  createdAt: Date
}

interface PlaybackRunDoc {
  _id: string
  workflowId: string
  playedAt: Date
  userId?: string | null
  status: string
  failedEventIndex: number | null
  failedEventType: string | null
  failedEventSelector: string | null
}

interface PlaybackCheckpointDoc {
  _id: string
  runId: string
  index: number
  label: string | null
  checkpointType: string | null
  dataUrl: string | null
  capturedData: string | null
  createdAt: Date
}

export interface UserRecord {
  id: string
  email: string
  passwordHash: string
  createdAt: string
}

export interface WorkflowSummary {
  id: string
  name: string
  recordedAt: string
  _count: {
    screenshots: number
    runs: number
  }
}

export interface RecordingScreenshotRecord {
  id: string
  workflowId: string
  index: number
  label: string | null
  url: string | null
  dataUrl: string
  createdAt: string
}

export interface PlaybackRunSummary {
  id: string
  workflowId: string
  playedAt: string
  status: string
  failedEventIndex: number | null
  failedEventType: string | null
  failedEventSelector: string | null
  _count: {
    checkpoints: number
  }
}

export interface WorkflowDetail {
  id: string
  name: string
  recordedAt: string
  events: unknown[]
  screenshots: RecordingScreenshotRecord[]
  runs: PlaybackRunSummary[]
}

export interface PlaybackCheckpointRecord {
  id: string
  runId: string
  index: number
  label: string | null
  checkpointType: string | null
  dataUrl: string | null
  capturedData: string | null
  createdAt: string
}

export interface RunDetail {
  id: string
  workflowId: string
  playedAt: string
  status: string
  failedEventIndex: number | null
  failedEventType: string | null
  failedEventSelector: string | null
  checkpoints: PlaybackCheckpointRecord[]
  workflow: {
    id: string
    name: string
    recordedAt: string
    events: unknown[]
    screenshots: RecordingScreenshotRecord[]
  }
}

interface CreateWorkflowInput {
  name: string
  recordedAt: Date
  events: unknown[]
  screenshots: Array<{
    index: number
    label: string | null
    url: string | null
    dataUrl: string
  }>
}

interface CreateRunInput {
  workflowId: string
  playedAt: Date
  status: string
  failedEventIndex: number | null
  failedEventType: string | null
  failedEventSelector: string | null
  checkpoints: Array<{
    index: number
    label: string | null
    checkpointType: string | null
    dataUrl: string | null
    capturedData: string | null
  }>
}

function iso(value: Date) {
  return value.toISOString()
}

function mapUser(doc: UserDoc): UserRecord {
  return {
    id: doc._id,
    email: doc.email,
    passwordHash: doc.passwordHash,
    createdAt: iso(doc.createdAt),
  }
}

function mapScreenshot(doc: RecordingScreenshotDoc): RecordingScreenshotRecord {
  return {
    id: doc._id,
    workflowId: doc.workflowId,
    index: doc.index,
    label: doc.label ?? null,
    url: doc.url ?? null,
    dataUrl: doc.dataUrl,
    createdAt: iso(doc.createdAt),
  }
}

function mapCheckpoint(doc: PlaybackCheckpointDoc): PlaybackCheckpointRecord {
  return {
    id: doc._id,
    runId: doc.runId,
    index: doc.index,
    label: doc.label ?? null,
    checkpointType: doc.checkpointType ?? null,
    dataUrl: doc.dataUrl ?? null,
    capturedData: doc.capturedData ?? null,
    createdAt: iso(doc.createdAt),
  }
}

function mapRun(doc: PlaybackRunDoc, checkpointCount = 0): PlaybackRunSummary {
  return {
    id: doc._id,
    workflowId: doc.workflowId,
    playedAt: iso(doc.playedAt),
    status: doc.status,
    failedEventIndex: doc.failedEventIndex ?? null,
    failedEventType: doc.failedEventType ?? null,
    failedEventSelector: doc.failedEventSelector ?? null,
    _count: {
      checkpoints: checkpointCount,
    },
  }
}

async function getDb() {
  return getMongoDb()
}

async function getCollections(db?: Db) {
  const database = db ?? (await getDb())
  return {
    db: database,
    users: database.collection<UserDoc>('users'),
    workflows: database.collection<WorkflowDoc>('workflows'),
    recordingScreenshots: database.collection<RecordingScreenshotDoc>('recording_screenshots'),
    playbackRuns: database.collection<PlaybackRunDoc>('playback_runs'),
    playbackCheckpoints: database.collection<PlaybackCheckpointDoc>('playback_checkpoints'),
  }
}

async function getCheckpointCountsByRunId(runIds: string[]) {
  if (runIds.length === 0) return new Map<string, number>()

  const { playbackCheckpoints } = await getCollections()
  const counts = await playbackCheckpoints.aggregate<{ _id: string; count: number }>([
    { $match: { runId: { $in: runIds } } },
    { $group: { _id: '$runId', count: { $sum: 1 } } },
  ]).toArray()

  return new Map(counts.map((entry) => [entry._id, entry.count]))
}

export async function findUserByEmail(email: string) {
  const { users } = await getCollections()
  const user = await users.findOne({ email })
  return user ? mapUser(user) : null
}

export async function createUserRecord(email: string, passwordHash: string) {
  const { users } = await getCollections()
  const existing = await users.findOne({ email })
  if (existing) {
    throw new Error('An account with this email already exists')
  }

  const user: UserDoc = {
    _id: randomUUID(),
    email,
    passwordHash,
    createdAt: new Date(),
  }

  await users.insertOne(user)
  return mapUser(user)
}

export async function listWorkflowSummaries() {
  const { workflows } = await getCollections()
  const docs = await workflows.aggregate<{
    _id: string
    name: string
    recordedAt: Date
    screenshotCount: number
    runCount: number
  }>([
    { $sort: { recordedAt: -1 } },
    {
      $lookup: {
        from: 'recording_screenshots',
        let: { workflowId: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$workflowId', '$$workflowId'] } } },
          { $count: 'count' },
        ],
        as: 'screenshotCounts',
      },
    },
    {
      $lookup: {
        from: 'playback_runs',
        let: { workflowId: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$workflowId', '$$workflowId'] } } },
          { $count: 'count' },
        ],
        as: 'runCounts',
      },
    },
    {
      $project: {
        _id: 1,
        name: 1,
        recordedAt: 1,
        screenshotCount: {
          $ifNull: [{ $arrayElemAt: ['$screenshotCounts.count', 0] }, 0],
        },
        runCount: {
          $ifNull: [{ $arrayElemAt: ['$runCounts.count', 0] }, 0],
        },
      },
    },
  ]).toArray()

  return docs.map<WorkflowSummary>((doc) => ({
    id: doc._id,
    name: doc.name,
    recordedAt: iso(doc.recordedAt),
    _count: {
      screenshots: doc.screenshotCount,
      runs: doc.runCount,
    },
  }))
}

export async function countWorkflows() {
  const { workflows } = await getCollections()
  return workflows.countDocuments()
}

export async function countPlaybackRuns() {
  const { playbackRuns } = await getCollections()
  return playbackRuns.countDocuments()
}

export async function countPlaybackCheckpoints() {
  const { playbackCheckpoints } = await getCollections()
  return playbackCheckpoints.countDocuments()
}

export async function getWorkflowDetail(id: string) {
  const { workflows, recordingScreenshots, playbackRuns } = await getCollections()
  const workflow = await workflows.findOne({ _id: id })
  if (!workflow) return null

  const [screenshots, runs] = await Promise.all([
    recordingScreenshots.find({ workflowId: id }).sort({ index: 1 }).toArray(),
    playbackRuns.find({ workflowId: id }).sort({ playedAt: -1 }).toArray(),
  ])

  const checkpointCounts = await getCheckpointCountsByRunId(runs.map((run) => run._id))

  return {
    id: workflow._id,
    name: workflow.name,
    recordedAt: iso(workflow.recordedAt),
    events: Array.isArray(workflow.events) ? workflow.events : [],
    screenshots: screenshots.map(mapScreenshot),
    runs: runs.map((run) => mapRun(run, checkpointCounts.get(run._id) ?? 0)),
  } satisfies WorkflowDetail
}

export async function getRunDetail(runId: string) {
  const { workflows, recordingScreenshots, playbackRuns, playbackCheckpoints } = await getCollections()
  const run = await playbackRuns.findOne({ _id: runId })
  if (!run) return null

  const [workflow, checkpoints, screenshots] = await Promise.all([
    workflows.findOne({ _id: run.workflowId }),
    playbackCheckpoints.find({ runId }).sort({ index: 1 }).toArray(),
    recordingScreenshots.find({ workflowId: run.workflowId }).sort({ index: 1 }).toArray(),
  ])

  if (!workflow) return null

  return {
    id: run._id,
    workflowId: run.workflowId,
    playedAt: iso(run.playedAt),
    status: run.status,
    failedEventIndex: run.failedEventIndex ?? null,
    failedEventType: run.failedEventType ?? null,
    failedEventSelector: run.failedEventSelector ?? null,
    checkpoints: checkpoints.map(mapCheckpoint),
    workflow: {
      id: workflow._id,
      name: workflow.name,
      recordedAt: iso(workflow.recordedAt),
      events: Array.isArray(workflow.events) ? workflow.events : [],
      screenshots: screenshots.map(mapScreenshot),
    },
  } satisfies RunDetail
}

export async function createWorkflowRecord(input: CreateWorkflowInput) {
  const { workflows, recordingScreenshots } = await getCollections()
  const workflowId = randomUUID()

  const workflow: WorkflowDoc = {
    _id: workflowId,
    name: input.name,
    recordedAt: input.recordedAt,
    events: Array.isArray(input.events) ? input.events : [],
    userId: null,
  }

  await workflows.insertOne(workflow)

  if (input.screenshots.length > 0) {
    const screenshots: RecordingScreenshotDoc[] = input.screenshots.map((screenshot) => ({
      _id: randomUUID(),
      workflowId,
      index: screenshot.index,
      label: screenshot.label ?? null,
      url: screenshot.url ?? null,
      dataUrl: screenshot.dataUrl,
      createdAt: new Date(),
    }))

    await recordingScreenshots.insertMany(screenshots)
  }

  return { id: workflowId }
}

export async function createRunRecord(input: CreateRunInput) {
  const { workflows, playbackRuns, playbackCheckpoints } = await getCollections()
  const workflow = await workflows.findOne({ _id: input.workflowId })
  if (!workflow) {
    throw new Error('Workflow not found')
  }

  const runId = randomUUID()
  const run: PlaybackRunDoc = {
    _id: runId,
    workflowId: input.workflowId,
    playedAt: input.playedAt,
    userId: null,
    status: input.status,
    failedEventIndex: input.failedEventIndex ?? null,
    failedEventType: input.failedEventType ?? null,
    failedEventSelector: input.failedEventSelector ?? null,
  }

  await playbackRuns.insertOne(run)

  if (input.checkpoints.length > 0) {
    const checkpoints: PlaybackCheckpointDoc[] = input.checkpoints.map((checkpoint) => ({
      _id: randomUUID(),
      runId,
      index: checkpoint.index,
      label: checkpoint.label ?? null,
      checkpointType: checkpoint.checkpointType ?? null,
      dataUrl: checkpoint.dataUrl ?? null,
      capturedData: checkpoint.capturedData ?? null,
      createdAt: new Date(),
    }))

    await playbackCheckpoints.insertMany(checkpoints)
  }

  return {
    id: runId,
    status: run.status,
    failedEventIndex: run.failedEventIndex ?? null,
    failedEventType: run.failedEventType ?? null,
    failedEventSelector: run.failedEventSelector ?? null,
  }
}
