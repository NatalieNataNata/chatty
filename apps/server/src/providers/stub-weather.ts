import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WeatherProvider } from '../types.js'
import { dataDir } from '../paths.js'

interface SavedLocation {
  latitude: number
  longitude: number
  city: string
  updatedAt: string
  precise: boolean
}

export interface LiveContextSnapshot extends SavedLocation {
  weather: string
  temperature: number | null
  live: boolean
}

const locationPath = resolve(dataDir, 'location.json')
const defaultLocation: SavedLocation = {
  latitude: 39.9042,
  longitude: 116.4074,
  city: '北京',
  updatedAt: new Date().toISOString(),
  precise: false,
}

const weatherLabels: Record<number, string> = {
  0: '晴', 1: '大部晴朗', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '较强毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨',
  71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 81: '较强阵雨', 82: '强阵雨',
  95: '雷雨', 96: '雷雨伴冰雹', 99: '强雷雨伴冰雹',
}

export class StubWeatherProvider implements WeatherProvider {
  private location = this.readLocation()
  private cached: { at: number; snapshot: LiveContextSnapshot } | null = null

  private readLocation() {
    if (!existsSync(locationPath)) return defaultLocation
    try {
      return { ...defaultLocation, ...JSON.parse(readFileSync(locationPath, 'utf8')) } as SavedLocation
    } catch {
      return defaultLocation
    }
  }

  async updateLocation(latitude: number, longitude: number) {
    const reverseUrl = new URL('https://api.bigdatacloud.net/data/reverse-geocode-client')
    reverseUrl.searchParams.set('latitude', String(latitude))
    reverseUrl.searchParams.set('longitude', String(longitude))
    reverseUrl.searchParams.set('localityLanguage', 'zh')
    let city = '当前位置'
    try {
      const response = await fetch(reverseUrl)
      if (response.ok) {
        const data = await response.json() as { city?: string; locality?: string; principalSubdivision?: string }
        city = data.city || data.locality || data.principalSubdivision || city
      }
    } catch {
      // Coordinates still provide accurate weather if reverse geocoding is unavailable.
    }
    this.location = { latitude, longitude, city, updatedAt: new Date().toISOString(), precise: true }
    writeFileSync(locationPath, JSON.stringify(this.location), { mode: 0o600 })
    this.cached = null
    return this.getSnapshot()
  }

  async getSnapshot(): Promise<LiveContextSnapshot> {
    if (this.cached && Date.now() - this.cached.at < 10 * 60_000) return this.cached.snapshot
    const url = new URL('https://api.open-meteo.com/v1/forecast')
    url.searchParams.set('latitude', String(this.location.latitude))
    url.searchParams.set('longitude', String(this.location.longitude))
    url.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m')
    url.searchParams.set('timezone', 'auto')
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error('Weather request failed')
      const data = await response.json() as { current?: { temperature_2m?: number; relative_humidity_2m?: number; apparent_temperature?: number; weather_code?: number; wind_speed_10m?: number } }
      const current = data.current ?? {}
      const temperature = current.temperature_2m ?? null
      const condition = weatherLabels[current.weather_code ?? -1] ?? '天气变化中'
      const weather = `${condition}，${temperature ?? '--'}°C，体感 ${current.apparent_temperature ?? '--'}°C，湿度 ${current.relative_humidity_2m ?? '--'}%，风速 ${current.wind_speed_10m ?? '--'} km/h`
      const snapshot = { ...this.location, weather, temperature, live: true }
      this.cached = { at: Date.now(), snapshot }
      return snapshot
    } catch {
      return { ...this.location, weather: '实时天气暂时不可用', temperature: null, live: false }
    }
  }

  async getCurrentSummary(): Promise<string> {
    const snapshot = await this.getSnapshot()
    return `${snapshot.city}：${snapshot.weather}`
  }
}
