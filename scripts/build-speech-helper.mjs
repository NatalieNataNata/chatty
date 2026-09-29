import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const source = resolve(root, 'apps/desktop/speech-recognition.swift')
const output = resolve(root, 'apps/desktop/speech-recognition')
const result = spawnSync('swiftc', [source, '-o', output, '-framework', 'Speech', '-framework', 'AVFoundation'], { stdio: 'inherit' })

if (result.status !== 0) process.exit(result.status ?? 1)
