import { writeFileSync } from 'node:fs'
import { defaults, regenerate, grant, enableMode, isActive, headsUp } from '../src/lib/situate/core.ts'
const now = new Date(2026,9,17,12).getTime()
let base = regenerate(defaults(now), now, null)
base.epochs = base.epochs.filter(e => e.end >= now-86400000 && e.at < now+2*86400000)
base.windows = base.windows.filter(w => w.end >= now-86400000 && w.at < now+2*86400000)
const cases=[]
const documents=[base,grant(base,'dolo',{thrust:true},now,now),grant(base,'dolo',{visual:false},now,now,'domain:youtube.com'),enableMode(base,'discord',now)]
documents.push(grant(base,'touch-grass',{peed:true,bed:true},now+11*3600000,now+11*3600000),enableMode(base,'touch-grass',now))
for(const platform of ['mac','android']) for(const hours of [0,9.25,9.4,9.5,11,11.8,11.95,14.5,19,24,36]) {
 const time=now+hours*3600000
 for(const doc of documents) cases.push({document:documents.indexOf(doc),platform,now:time,expected:doc.modes.filter(m=>m.platforms.includes(platform)).map(m=>({id:m.id,active:isActive(doc,m,platform,time),soon:headsUp(doc,m,platform,time),targets:m.targets.filter(t=>isActive(doc,m,platform,time,t.id)).map(t=>t.id)}))})
}
writeFileSync('tests/fixtures/situate-policy.json',JSON.stringify({documents,cases})+'\n')
