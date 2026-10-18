chrome.runtime.sendMessage({type:'status'}).then(s => {
  const node=document.querySelector('#status')
  node.textContent=s.error ?? (s.stale ? 'Rules need refreshing. Open Balance.' : s.modes.filter(m=>m.active).map(m=>m.name).join(', ') || 'All modes are off.')
}).catch(() => { document.querySelector('#status').textContent='Could not connect. Open Balance.' })
