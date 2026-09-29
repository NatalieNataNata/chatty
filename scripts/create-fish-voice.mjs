import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const apiKey = process.env.FISH_AUDIO_API_KEY
if (!apiKey) {
  throw new Error('请先在 .env 中填写 FISH_AUDIO_API_KEY。')
}

const root = resolve(import.meta.dirname, '..')
const audioPath = resolve(root, 'outputs', 'chatty-noir-reference.wav')
const transcriptPath = resolve(root, 'outputs', 'chatty-noir-reference.txt')
const [audio, transcript] = await Promise.all([readFile(audioPath), readFile(transcriptPath, 'utf8')])

const form = new FormData()
form.append('type', 'tts')
form.append('title', 'Chatty Noir')
form.append('train_mode', 'fast')
form.append('visibility', 'private')
form.append('description', 'Private Chatty radio voice reference.')
form.append('enhance_audio_quality', 'true')
form.append('generate_sample', 'false')
form.append('voices', new Blob([audio], { type: 'audio/wav' }), 'chatty-noir-reference.wav')
form.append('texts', transcript.trim())

const response = await fetch('https://api.fish.audio/model', {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}` },
  body: form,
})

const payload = await response.json()
if (!response.ok) {
  throw new Error(`创建 Fish Audio 声音失败 (${response.status}): ${JSON.stringify(payload)}`)
}

console.log(`FISH_AUDIO_VOICE_ID=${payload._id}`)
console.log('声音已按 private 可见性创建。把上面的 ID 填入 .env 后重启 Chatty。')
