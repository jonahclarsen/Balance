// Offline NOAA solar equations, sea-level apparent sunset (solar zenith 90.833°).
// Vancouver city centre: 49.2827° N, 123.1207° W. Times are rounded to the
// nearest minute; terrain, weather and the observer's elevation are not modeled.
// Run with Node to regenerate the committed UTC lookup; no network or timezone
// database is used here. UTC values can exceed 1440 (sunset is the next UTC day).
import { writeFileSync } from 'node:fs'

const rad = Math.PI / 180
const sin = degrees => Math.sin(degrees * rad)
const cos = degrees => Math.cos(degrees * rad)
const tan = degrees => Math.tan(degrees * rad)
const latitude = 49.2827
const longitude = -123.1207

function solarTerms(julianDay) {
  const t = (julianDay - 2451545) / 36525
  const meanLongitude = ((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360 + 360) % 360
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t)
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
  const centre = sin(meanAnomaly) * (1.914602 - t * (0.004817 + 0.000014 * t))
    + sin(2 * meanAnomaly) * (0.019993 - 0.000101 * t) + sin(3 * meanAnomaly) * 0.000289
  const omega = 125.04 - 1934.136 * t
  const apparentLongitude = meanLongitude + centre - 0.00569 - 0.00478 * sin(omega)
  const obliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
    + 0.00256 * cos(omega)
  const declination = Math.asin(sin(obliquity) * sin(apparentLongitude)) / rad
  const y = tan(obliquity / 2) ** 2
  const equationOfTime = 4 / rad * (y * sin(2 * meanLongitude) - 2 * eccentricity * sin(meanAnomaly)
    + 4 * eccentricity * y * sin(meanAnomaly) * cos(2 * meanLongitude)
    - 0.5 * y * y * sin(4 * meanLongitude) - 1.25 * eccentricity ** 2 * sin(2 * meanAnomaly))
  return { declination, equationOfTime }
}

function sunsetMinutes(timestamp) {
  const julianDay = timestamp / 86400000 + 2440587.5
  let minutes = 1440
  for (let iteration = 0; iteration < 4; iteration++) {
    const { declination, equationOfTime } = solarTerms(julianDay + minutes / 1440)
    const hourAngle = Math.acos(cos(90.833) / (cos(latitude) * cos(declination))
      - tan(latitude) * tan(declination)) / rad
    minutes = 720 - 4 * longitude + 4 * hourAngle - equationOfTime
  }
  return Math.round(minutes)
}

const years = []
for (let year = 2000; year <= 2099; year++) {
  const values = []
  for (let date = Date.UTC(year, 0, 1); date < Date.UTC(year + 1, 0, 1); date += 86400000) {
    values.push(sunsetMinutes(date))
  }
  years.push(`  ${year}: [${values.join(',')}],`)
}
writeFileSync(new URL('../src/lib/vancouverSunsets.ts', import.meta.url),
  '// Generated offline by scripts/generate-vancouver-sunsets.mjs.\n'
  + '// UTC minutes from midnight of each Vancouver calendar date, Jan 1 onward.\n'
  + 'export const VANCOUVER_SUNSETS: Readonly<Record<number, readonly number[]>> = {\n'
  + years.join('\n') + '\n}\n')
