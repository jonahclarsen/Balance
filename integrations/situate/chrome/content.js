(() => {
  let gate, last='', running=false, bodyState=null
  const id='balance-situate-gate'
  function hideBody() {
    const body=document.body
    if(!body) return
    if(bodyState?.body!==body) bodyState={body,inert:body.hasAttribute('inert'),visibility:body.style.getPropertyValue('visibility'),priority:body.style.getPropertyPriority('visibility'),display:body.style.getPropertyValue('display'),displayPriority:body.style.getPropertyPriority('display')}
    body.setAttribute('inert',''); body.style.setProperty('visibility','hidden','important'); body.style.setProperty('display','none','important')
  }
  async function check() {
    if(running) return
    running=true
    try {
      const path=location.hostname.endsWith('discord.com') ? location.pathname.split('/') : []
      const parent=path[1]==='channels' && !path[4] ? situateDiscordParent(document,path[3]) : ''
      const result=await chrome.runtime.sendMessage({type:'check',parent})
      if(!result?.blocked?.length) { gate?.remove(); gate=null; last=''; document.documentElement?.removeAttribute('data-situate-blocked'); if(bodyState) { const {body,inert,visibility,priority,display,displayPriority}=bodyState; if(!inert) body.removeAttribute('inert'); body.style.setProperty('visibility',visibility,priority); body.style.setProperty('display',display,displayPriority); bodyState=null } return }
      const signature=JSON.stringify(result.blocked)
      if(gate?.isConnected && signature===last) { hideBody(); return }
      last=signature; gate?.remove()
      gate=document.createElement('div'); gate.id=id
      gate.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#101910;color:#eaf0e7;display:grid;place-items:center;font:16px system-ui;'
      const root=gate.attachShadow({mode:'closed'})
      const style=document.createElement('style');style.textContent='section{max-width:440px;padding:32px}h1{font-size:36px}p{line-height:1.6}a{display:block;border:1px solid #8da77d;border-radius:24px;padding:14px 22px;color:inherit;text-decoration:none;margin:12px 0}';root.append(style)
      const section=document.createElement('section');root.append(section)
      const title=document.createElement('h1');title.textContent='Touch grass.';section.append(title)
      const text=document.createElement('p');text.textContent=result.stale ? 'Open Balance to refresh your Situate rules.' : 'Take the quiz to continue.';section.append(text)
      for(const rule of result.blocked) {
        const link=document.createElement('a');const url=new URL('balance://situate');url.searchParams.set('mode',rule.mode);if(rule.target) url.searchParams.set('target',rule.target)
        link.href=url.href;link.textContent=`Open ${rule.name} quiz`;section.append(link)
      }
      const hide=document.createElement('style');hide.textContent='html[data-situate-blocked] body{visibility:hidden!important}';root.append(hide)
      document.documentElement.setAttribute('data-situate-blocked','')
      hideBody()
      ;(document.documentElement || document).appendChild(gate)
      // Pause playback without inspecting media URLs or message text.
      document.querySelectorAll('video,audio').forEach(media => media.pause())
      if(document.fullscreenElement) void document.exitFullscreen().catch(()=>{})
    } catch { /* Browser disconnection leaves an existing gate in place. */ }
    finally { running=false }
  }
  // A local status check also handles Discord client-side navigation.
  void check()
  // document_start can run before the body exists, and client-side apps may replace it.
  new MutationObserver(() => { if(gate?.isConnected && bodyState?.body!==document.body) hideBody() }).observe(document,{childList:true,subtree:true})
  setInterval(check,1000)
  document.addEventListener('play',event => { if(gate?.isConnected && event.target instanceof HTMLMediaElement) event.target.pause() },true)
  document.addEventListener('fullscreenchange',() => { if(gate?.isConnected && document.fullscreenElement) void document.exitFullscreen().catch(()=>{}) })
  window.addEventListener('pageshow',check)
  window.addEventListener('popstate',check)
  document.addEventListener('keydown',event => {
    if(gate?.isConnected && !event.composedPath().includes(gate)) {
      // Keep browser shortcuts (including moving tabs) without sending keys to the blocked page.
      if(!event.ctrlKey && !event.metaKey && !event.altKey) event.preventDefault()
      event.stopImmediatePropagation()
    }
  },true)
})()
