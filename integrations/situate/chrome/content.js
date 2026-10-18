(() => {
  let gate, last='', running=false
  const id='balance-situate-gate'
  async function check() {
    if(running) return
    running=true
    try {
      const result=await chrome.runtime.sendMessage({type:'check'})
      if(!result?.blocked?.length) { gate?.remove(); gate=null; last=''; document.documentElement?.removeAttribute('data-situate-blocked'); document.body?.removeAttribute('inert'); if(document.body) document.body.style.removeProperty('visibility'); return }
      const signature=JSON.stringify(result.blocked)
      if(gate?.isConnected && signature===last) return
      last=signature; gate?.remove()
      gate=document.createElement('div'); gate.id=id
      gate.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#101910;color:#eaf0e7;display:grid;place-items:center;font:16px system-ui;'
      const root=gate.attachShadow({mode:'closed'})
      const style=document.createElement('style');style.textContent='section{max-width:440px;padding:32px}h1{font-size:36px}p{line-height:1.6}a{display:block;border:1px solid #8da77d;border-radius:24px;padding:14px 22px;color:inherit;text-decoration:none;margin:12px 0}';root.append(style)
      const section=document.createElement('section');root.append(section)
      const title=document.createElement('h1');title.textContent='A moment to choose.';section.append(title)
      const text=document.createElement('p');text.textContent=result.stale ? 'Open Balance to refresh your Situate rules.' : 'Your Situate boundary is on. Take the quiz in Balance if this is where you intend to be.';section.append(text)
      for(const rule of result.blocked) {
        const link=document.createElement('a');const url=new URL('balance://situate');url.searchParams.set('mode',rule.mode);if(rule.target) url.searchParams.set('target',rule.target)
        link.href=url.href;link.textContent=`Open ${rule.name} quiz`;section.append(link)
      }
      const hide=document.createElement('style');hide.textContent='html[data-situate-blocked] body{visibility:hidden!important}';root.append(hide)
      document.documentElement.setAttribute('data-situate-blocked','')
      if(document.body) { document.body.setAttribute('inert',''); document.body.style.visibility='hidden' }
      ;(document.documentElement || document).appendChild(gate)
      // Pause playback without inspecting media URLs or message text.
      document.querySelectorAll('video,audio').forEach(media => media.pause())
    } catch { /* Browser disconnection leaves an existing gate in place. */ }
    finally { running=false }
  }
  // A local status check also handles Discord client-side navigation.
  void check()
  setInterval(check,1000)
  window.addEventListener('pageshow',check)
  window.addEventListener('popstate',check)
  document.addEventListener('keydown',event => { if(gate?.isConnected && !event.composedPath().includes(gate)) { event.preventDefault();event.stopImmediatePropagation() } },true)
})()
