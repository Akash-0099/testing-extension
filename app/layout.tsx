import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'QA Workflow Dashboard',
  description: 'Record, replay, and compare workflow checkpoints',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
