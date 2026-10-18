import { test, expect } from '@playwright/test'
import { defaults, regenerate, epoch, enableMode, grant, isActive, questions, quizProgress, validate, matches, sunset } from '../../src/lib/situate/core'
const date = (day:number,hour:number,minute=0) => new Date(2026,9,17+day,hour,minute).getTime()
const fixture = (now=date(0,12)) => ({ ...defaults(now), enabled:true })
test('default modes, reset clocks and device scope', () => {
  const d=fixture();validate(d)
  expect(d.settings.wakeMinutes).toBe(420)
  expect(isActive(d,d.modes[0],'mac',date(0,12))).toBe(true)
  expect(isActive(d,d.modes[2],'android',date(0,12))).toBe(false)
  expect(isActive(enableMode(d,'discord',date(0,12)),d.modes[2],'android',date(0,12))).toBe(true)
  expect(isActive(enableMode(d,'discord',date(0,12)),d.modes[2],'mac',date(0,12))).toBe(false)
})
test('dolo requires a yes and cannot bypass missing answers', () => {
  const d=fixture();const now=date(0,12)
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
test('night passes last 60 minutes, late passes 30, and never cross wake time', () => {
  const d=fixture();const answers={peed:true,bed:true}
  for(const [now,duration] of [[date(0,23),60],[date(1,2,30),30],[date(1,6,50),10]]) {
    const allowed=grant(d,'touch-grass',answers,now,now)
    expect(allowed.grants[0].until-now).toBe(duration*60000)
    expect(isActive(allowed,d.modes[1],'mac',now+duration*60000)).toBe(true)
  }
})
test('entertainment branches allow work or permitted care only, scoped to one target and mode', () => {
  const d=fixture();const now=date(0,12);const target='domain:youtube.com'
  expect(quizProgress(questions(d,d.modes[0],now,target),{visual:true}).next?.id).toBe('care')
  expect(() => grant(d,'dolo',{visual:true,care:false},now,now,target)).toThrow('Complete')
  for(const answers of [{visual:false},{visual:true,care:true}]) {
    const allowed=grant(d,'dolo',answers,now,now,target)
    expect(isActive(allowed,d.modes[0],'mac',now,target)).toBe(false)
    expect(isActive(allowed,d.modes[0],'mac',now,'domain:reddit.com')).toBe(true)
    expect(isActive(allowed,d.modes[1],'mac',now,target)).toBe(true)
    expect(isActive(allowed,d.modes[0],'mac',now+15*60000,target)).toBe(true)
  }
  expect(() => questions(d,d.modes[0],now,'domain:reddit.com')).toThrow('mode quiz')
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
  expect(isActive(d,d.modes[2],'android',date(1,12))).toBe(false)
  d=enableMode(d,'discord',date(1,12))
  expect(isActive(d,d.modes[2],'android',date(1,12))).toBe(true)
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
test('polar sunset absence uses clock fallback and invalid locations are rejected', () => {
  expect(sunset(new Date(2026,5,21),89,0)).toBeNull()
  const d=fixture();d.settings.latitude=89;d.settings.longitude=0
  const projected=regenerate(d,new Date(2026,5,21,12).getTime())
  expect(new Date(epoch(projected,new Date(2026,5,21,12).getTime())!.end).getHours()).toBe(21)
  d.settings.longitude=null;expect(()=>validate(d)).toThrow('both')
})
test('sunset is plausible for Vancouver and later-of rule is respected', () => {
  const day=new Date('2026-10-17T19:00:00Z')
  const actual=sunset(day,49.28,-123.12)!
  expect(new Date(actual).toISOString()).toMatch(/^2026-10-18T01:/)
  const d=fixture(); d.settings.latitude=49.28;d.settings.longitude=-123.12
  const p=regenerate(d,day.getTime());const e=epoch(p,day.getTime())!
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
    process.env.TZ='America/Vancouver'
    const now=new Date(2026,9,31,22).getTime()
    const d=defaults(now)
    const night=epoch(d,now)!
    expect(new Date(night.end).getHours()).toBe(7)
    expect(night.end-night.at).toBe(10.5*3600000)
    const spring=defaults(new Date(2026,2,7,22).getTime())
    const springNight=epoch(spring,new Date(2026,2,7,22).getTime())!
    expect(new Date(springNight.end).getHours()).toBe(7)
    expect(springNight.end-springNight.at).toBe(8.5*3600000)
  } finally { if(previous===undefined) delete process.env.TZ;else process.env.TZ=previous }
})
