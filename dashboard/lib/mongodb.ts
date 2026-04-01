import { Db, MongoClient } from 'mongodb'

const globalForMongo = globalThis as typeof globalThis & {
  mongoClientPromise?: Promise<MongoClient>
  mongoIndexesPromise?: Promise<void>
}

function getMongoUri() {
  const uri = process.env.MONGODB_URI
  if (!uri) {
    throw new Error('MONGODB_URI is not set')
  }
  return uri
}

function getMongoDbName() {
  return process.env.MONGODB_DB_NAME || 'qa_dashboard'
}

function getMongoClientPromise() {
  if (!globalForMongo.mongoClientPromise) {
    const client = new MongoClient(getMongoUri())
    globalForMongo.mongoClientPromise = client.connect()
  }
  return globalForMongo.mongoClientPromise
}

async function ensureIndexes(db: Db) {
  if (!globalForMongo.mongoIndexesPromise) {
    globalForMongo.mongoIndexesPromise = Promise.all([
      db.collection('users').createIndex({ email: 1 }, { unique: true }),
      db.collection('user_settings').createIndex({ userId: 1 }, { unique: true }),
      db.collection('workflows').createIndex({ recordedAt: -1 }),
      db.collection('recording_screenshots').createIndex({ workflowId: 1, index: 1 }, { unique: true }),
      db.collection('playback_runs').createIndex({ workflowId: 1, playedAt: -1 }),
      db.collection('playback_checkpoints').createIndex({ runId: 1, index: 1 }, { unique: true }),
    ]).then(() => undefined)
  }

  await globalForMongo.mongoIndexesPromise
}

export async function getMongoDb() {
  const client = await getMongoClientPromise()
  const db = client.db(getMongoDbName())
  await ensureIndexes(db)
  return db
}
