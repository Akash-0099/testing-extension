import { neon } from '@neondatabase/serverless'

export function createNeonClient() {
  return neon(process.env.DATABASE_URL!)
}
