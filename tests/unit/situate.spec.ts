import { test, expect } from '@playwright/test'
import { defaults, regenerate, epoch, enableMode, grant, isActive, backOn, headsUp, questions, quizProgress, validate, matches, sunset, upgradePresets, timeZoneLocation } from '../../src/lib/situate/core'
const date = (day:number,hour:number,minute=0) => new Date(2026,9,17+day,hour,minute).getTime()
// Clock times only: sunset would otherwise follow the machine's time zone.
const fixture = (now=date(0,12)) => regenerate(defaults(now), now, null)
test('default modes, reset clocks and device scope', () => {
  const d=fixture();validate(d)
  expect(d.settings.wakeMinutes).toBe(420)
  expect(isActive(d,d.modes[0],'mac',date(0,12))).toBe(true)
  expect(isActive(d,d.modes.find(m=>m.id==='discord')!,'android',date(0,12))).toBe(false)
  expect(isActive(enableMode(d,'discord',date(0,12)),d.modes.find(m=>m.id==='discord')!,'android',date(0,12))).toBe(true)
  expect(isActive(enableMode(d,'discord',date(0,12)),d.modes.find(m=>m.id==='discord')!,'mac',date(0,12))).toBe(false)
})
test('dolo requires a yes and cannot bypass missing answers', () => {
  const now=date(0,12);const d=enableMode(fixture(),'touch-grass',now)
  expect(() => grant(d,'dolo',{},now,now)).toThrow('Complete')
  expect(() => grant(d,'dolo',{thrust:false},now,now)).toThrow('Complete')
  const allowed=grant(d,'dolo',{thrust:true},now,now)
  expect(isActive(allowed,d.modes[0],'mac',now)).toBe(false)
  expect(isActive(allowed,d.modes[1],'mac',now)).toBe(true)
  expect(isActive(allowed,d.modes[0],'mac',date(0,21,30))).toBe(true)
})
test('day planning pass ends at evening, and evening cannot reuse day quiz', () => {
  const d=fixture();const now=date(0,12)
  const allowed=grant(d,'touch-grass',{planned:true},now,now)
  expect(isActive(allowed,d.modes[1],'mac',date(0,21,29))).toBe(false)
  expect(isActive(allowed,d.modes[1],'mac',date(0,21,30))).toBe(true)
  expect(() => grant(d,'touch-grass',{planned:true},now,date(0,21,30))).toThrow('changed')
})
test('an unplanned tomorrow allows only a 5-minute emergency pass', () => {
  const d=fixture();const now=date(0,12)
  expect(quizProgress(questions(d,d.modes[1],now),{planned:false}).next?.id).toBe('emergency')
  expect(quizProgress(questions(d,d.modes[1],now),{planned:false,emergency:false}).denied).toBe(true)
  const allowed=grant(enableMode(d,'touch-grass',now),'touch-grass',{planned:false,emergency:true},now,now)
  expect(allowed.grants[0].until-now).toBe(5*60000)
  expect(isActive(allowed,d.modes[1],'mac',now+5*60000)).toBe(true)
  const legacy=upgradePresets({ ...d, presets:7, modes:d.modes.map(m=>({ ...m, dayQuiz:m.dayQuiz.filter(q=>q.id!=='emergency') })) })
  expect(legacy.modes[1].dayQuiz.map(q=>q.id)).toEqual(['planned','emergency'])
})
test('touch grass turns on only at evening, with heads-ups, and a daytime turn-on lasts until morning', () => {
  const d=fixture();const tg=d.modes[1]
  expect(isActive(d,tg,'mac',date(0,12))).toBe(false)
  expect(isActive(d,tg,'mac',date(0,21,30))).toBe(true)
  expect(isActive(d,tg,'mac',date(1,8))).toBe(false)
  expect(backOn(d,tg,date(0,12))).toBe(date(0,21,30))
  expect([date(0,21,14),date(0,21,15),date(0,21,25),date(0,21,30)].map(t=>headsUp(d,tg,'mac',t))).toEqual([null,15,5,null])
  const night=grant(d,'touch-grass',{peed:true,bed:true},date(0,23),date(0,23))
  expect(headsUp(night,tg,'mac',date(0,23,45))).toBe(15)
  const nightDolo=grant(d,'dolo',{thrust:true},date(0,23),date(0,23))
  expect(backOn(nightDolo,d.modes[0],date(0,23))).toBe(date(1,7))
  const manual=enableMode(d,'touch-grass',date(0,12))
  expect(isActive(manual,tg,'mac',date(0,12))).toBe(true)
  expect(isActive(manual,tg,'mac',date(1,8))).toBe(false)
  const legacy=upgradePresets({ ...d, presets:8, modes:d.modes.map(({ eveningOnly:_e, headsUp:_h, ...m })=>m) })
  expect(legacy.modes[1]).toMatchObject({ eveningOnly:true, headsUp:[15,5] })
  expect(() => validate({ ...d, modes:[{ ...tg, headsUp:[0] }] })).toThrow('Heads-ups')
})
test('night passes last 60 minutes, late passes 30, and never cross wake time', () => {
  const d=fixture();const answers={peed:true,bed:true}
  for(const [now,duration] of [[date(0,23),60],[date(1,2,30),30],[date(1,6,50),10]]) {
    const allowed=grant(d,'touch-grass',answers,now,now)
    expect(allowed.grants[0].until-now).toBe(duration*60000)
    // Touch grass turns on only at evening, so a pass that reaches wake time leaves it off.
    expect(isActive(allowed,d.modes[1],'mac',now+duration*60000)).toBe(now+duration*60000<date(1,7))
  }
})
test('entertainment branches allow work or permitted care only, scoped to one target in every mode', () => {
  const now=date(0,12);const d=enableMode(fixture(),'touch-grass',now);const target='domain:youtube.com'
  expect(quizProgress(questions(d,d.modes[0],now,target),{visual:true}).next?.id).toBe('care')
  expect(() => grant(d,'dolo',{visual:true,care:false},now,now,target)).toThrow('Complete')
  for(const answers of [{visual:false},{visual:true,care:true}]) {
    const allowed=grant(d,'dolo',answers,now,now,target)
    expect(isActive(allowed,d.modes[0],'mac',now,target)).toBe(false)
    expect(isActive(allowed,d.modes[0],'mac',now,'domain:reddit.com')).toBe(true)
    expect(isActive(allowed,d.modes[1],'mac',now,target)).toBe(false)
    expect(isActive(allowed,d.modes[1],'mac',now,'domain:claude.ai')).toBe(true)
    expect(isActive(allowed,d.modes[0],'mac',now+15*60000,target)).toBe(true)
  }
  expect(() => questions(d,d.modes[0],now,'domain:reddit.com')).toThrow('mode quiz')
})
test('modes need a color and at least one device', () => {
  const d=fixture()
  expect(() => validate({ ...d, modes:[{ ...d.modes[0], platforms:[] }] })).toThrow('device')
  expect(() => validate({ ...d, modes:[{ ...d.modes[0], color:'red' }] })).toThrow('color')
})
test('manual reactivation invalidates a quiz in progress and old grants', () => {
  const now=date(0,12);const d=fixture();const allowed=grant(d,'dolo',{thrust:true},now,now)
  const activated=enableMode(allowed,'dolo',now+1)
  expect(isActive(activated,d.modes[0],'mac',now+1)).toBe(true)
  expect(() => grant(activated,'dolo',{thrust:true},now,now+2)).toThrow('changed')
})
test('manual-only mode stays off until explicitly turned on again', () => {
  const now=date(0,12);let d=enableMode(fixture(),'discord',now)
  d=grant(d,'discord',{intentional:true},now,now)
  expect(isActive(d,d.modes.find(m=>m.id==='discord')!,'android',date(1,12))).toBe(false)
  d=enableMode(d,'discord',date(1,12))
  expect(isActive(d,d.modes.find(m=>m.id==='discord')!,'android',date(1,12))).toBe(true)
})
test('conditions may refer only to earlier questions and required no is honored', () => {
  const d=fixture();d.modes[0].dayQuiz=[{id:'a',text:'Working?',required:false},{id:'b',text:'Ready?',required:true,when:{id:'a',answer:false}}]
  validate(d)
  expect(quizProgress(d.modes[0].dayQuiz,{a:true}).denied).toBe(true)
  expect(quizProgress(d.modes[0].dayQuiz,{a:false}).next?.id).toBe('b')
  d.modes[0].dayQuiz[0].when={id:'b',answer:true}
  expect(()=>validate(d)).toThrow('earlier')
})
test('domains use label boundaries, app identifiers use exact equality', () => {
  const t=fixture().modes[0].targets.find(t=>t.value==='reddit.com')!
  expect(matches(t,'domain','old.reddit.com')).toBe(true)
  expect(matches(t,'domain','NOTREDDIT.com')).toBe(false)
  expect(matches(t,'domain','reddit.com.evil.test')).toBe(false)
  expect(matches(t,'app','reddit.com')).toBe(false)
})
test('polar sunset absence uses clock fallback', () => {
  expect(sunset(new Date(2026,5,21),89,0)).toBeNull()
  const projected=regenerate(fixture(),new Date(2026,5,21,12).getTime(),{ name:'Pole', zone:'UTC', latitude:89, longitude:0 })
  expect(new Date(epoch(projected,new Date(2026,5,21,12).getTime())!.end).getHours()).toBe(21)
})
test('sunset location is the largest Canadian city sharing the time zone', () => {
  expect(timeZoneLocation('America/Vancouver',2026)?.name).toBe('Vancouver')
  expect(timeZoneLocation('America/Los_Angeles',2026)?.name).toBe('Vancouver')
  expect(timeZoneLocation('America/New_York',2026)?.name).toBe('Toronto')
  expect(timeZoneLocation('America/Phoenix',2026)?.name).toBe('Whitehorse')
  expect(timeZoneLocation('America/Moncton',2026)?.name).toBe('Halifax')
  expect(timeZoneLocation('Europe/London',2026)).toBeNull()
  expect(timeZoneLocation('Not/AZone',2026)).toBeNull()
})
test('sunset is plausible for Vancouver and later-of rule is respected', () => {
  const day=new Date('2026-10-17T19:00:00Z')
  const actual=sunset(day,49.28,-123.12)!
  expect(new Date(actual).toISOString()).toMatch(/^2026-10-18T01:/)
  const p=regenerate(fixture(),day.getTime(),timeZoneLocation('America/Vancouver'));const e=epoch(p,day.getTime())!
  expect(e.end).toBeGreaterThanOrEqual(actual+240*60000-1000)
})
test('a stale schedule fails closed and regeneration preserves unexpired grants', () => {
  const now=date(0,12);let d=grant(fixture(),'dolo',{thrust:true},now,now)
  d=regenerate(d,now+1);expect(isActive(d,d.modes[0],'mac',now+1)).toBe(false)
  d.epochs=[];d.grants=[];expect(isActive(d,d.modes[0],'mac',now)).toBe(true)
})
test('DST wake resets use local clock dates rather than fixed 24-hour intervals', () => {
  const previous=process.env.TZ
  try {
    process.env.TZ='America/New_York'
    const now=new Date(2025,10,1,22).getTime()
    const d=regenerate(defaults(now),now,null)
    const night=epoch(d,now)!
    expect(new Date(night.end).getHours()).toBe(7)
    expect(night.end-night.at).toBe(10.5*3600000)
    const spring=regenerate(defaults(new Date(2025,2,8,22).getTime()),new Date(2025,2,8,22).getTime(),null)
    const springNight=epoch(spring,new Date(2025,2,8,22).getTime())!
    expect(new Date(springNight.end).getHours()).toBe(7)
    expect(springNight.end-springNight.at).toBe(8.5*3600000)
  } finally { if(previous===undefined) delete process.env.TZ;else process.env.TZ=previous }
})
test('older rules gain messaging apps and colors once, keeping Dolo\'s entertainment quiz for every mode', () => {
  const d=fixture();const [dolo,touch]=d.modes
  const doloQuiz=[{ id:'mine', text:'Mine?', required:true }]
  const { accessQuiz:_accessQuiz, ...unshared }=d
  const legacy={ ...unshared, presets:undefined, enabled:true, settings:{ ...d.settings, accessMinutes:undefined, latitude:49, longitude:-123 }, grants:[{ mode:'dolo', epoch:1, until:2 }],
    modes:[{ ...dolo, color:undefined, description:undefined, accessQuiz:doloQuiz, categories:['social'], targets:dolo.targets.filter(t=>t.value!=='com.whatsapp'&&t.value!=='org.thoughtcrime.securesms') }, { ...touch, accessQuiz:[{ id:'other', text:'Other?', required:true }] }, ...d.modes.slice(2)] } as unknown as typeof d
  const upgraded=upgradePresets(legacy)
  validate(upgraded)
  expect(upgraded.modes[0].targets.filter(t=>t.value==='com.whatsapp')).toHaveLength(1)
  expect(upgraded.modes[0].targets).toHaveLength(dolo.targets.length)
  expect(upgraded.modes[1].targets.some(t=>t.value==='com.whatsapp')).toBe(false)
  expect(upgraded.modes[0].color).toBe(dolo.color)
  expect(upgraded.accessQuiz).toEqual(doloQuiz)
  expect(upgraded.modes.some(m=>'accessQuiz' in m)).toBe(false)
  expect(upgradePresets({ ...legacy, modes:legacy.modes.map(m=>({ ...m, accessQuiz:undefined })) } as typeof d).accessQuiz).toEqual(d.accessQuiz)
  expect(upgraded.modes[0]).not.toHaveProperty('categories')
  expect(upgraded).not.toHaveProperty('enabled')
  expect(upgraded.settings.accessMinutes).toBe(15)
  expect(upgraded.modes[0].description).toBe(dolo.description)
  expect(upgraded.settings).not.toHaveProperty('latitude')
  expect(upgraded.grants).toEqual([{ mode:'dolo', target:'', epoch:1, until:2 }])
  expect(upgradePresets(upgraded)).toBe(upgraded)
})
test('reminder modes follow their daily hours, block nothing and cannot be passed or turned on', () => {
  const d=fixture();const active=d.modes.find(m=>m.id==='active-projects')!;const none=d.modes.find(m=>m.id==='no-active-project')!
  expect(isActive(d,active,'mac',date(0,12))).toBe(true)
  expect(isActive(d,active,'mac',date(0,20,30))).toBe(false)
  expect(isActive(d,none,'mac',date(0,20,30))).toBe(false)
  expect(isActive(d,none,'mac',date(0,23))).toBe(true)
  expect(isActive(d,none,'mac',date(1,6,59))).toBe(true)
  expect(isActive(d,none,'mac',date(1,7))).toBe(false)
  expect(active.targets).toEqual([])
  expect(() => enableMode(d,'active-projects')).toThrow('hours')
  const legacy={ ...d, presets:6, modes:d.modes.filter(m=>!m.reminder) }
  const upgraded=upgradePresets(legacy)
  expect(upgraded.modes.filter(m=>m.reminder).map(m=>m.id)).toEqual(['active-projects','no-active-project'])
  expect(upgradePresets({ ...upgraded, presets:6 }).modes.filter(m=>m.reminder)).toHaveLength(2)
})
