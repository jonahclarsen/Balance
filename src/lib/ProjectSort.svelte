<script lang="ts">
  import { onMount } from 'svelte'
  import type { Project } from './types'
  export let projects: Project[]
  export let onBack: () => void
  type Point = { x: number; y: number }
  type Slip = { id: string; rows: number[][]; center: Point; place?: Point }
  const width = 90, row = 22
  let canvas: HTMLCanvasElement
  let slips: Slip[] = []
  let marks = new Set<number>()
  let previous: Point | null = null
  let touching = false
  let undo: { marks: Set<number>; slips: Slip[] }[] = []
  let dragging = ''
  let offset = { x: 0, y: 0 }
  let viewWidth = 1, viewHeight = 1
  let context: CanvasRenderingContext2D
  let camera = 0, frame = 0, target = 0, fly = 0
  $: arranged = slips.length >= projects.length
  function scale() { return Math.min((viewWidth - 32) / width, 6) }
  function origin() { return (viewWidth - width * scale()) / 2 }
  function title(s: string, x: number, y: number, size: number, max: number) {
    context.font = size + 'px "Bradley Hand", "Segoe Print", "Comic Sans MS", cursive'
    context.fillStyle = '#252733'
    context.textBaseline = 'middle'
    context.fillText(s, x, y, max)
  }
  function dimensions() {
    const cols = Math.ceil(Math.sqrt(projects.length * viewWidth / viewHeight))
    return Math.min(1.9, viewWidth / ((cols || 1) * width), viewHeight / ((Math.ceil(projects.length / (cols || 1)) || 1) * row))
  }
  function position(s: Slip): Point {
    return s.place ? { x:s.place.x * viewWidth, y:s.place.y * viewHeight } : { x: Math.min(viewWidth / 2, 20 + width * dimensions()/2), y:36 }
  }
  function drawSlip(s: Slip, p: Point, zoom: number) {
    context.save()
    context.translate(p.x,p.y)
    context.scale(zoom,zoom)
    context.translate(-s.center.x,-s.center.y)
    context.fillStyle = '#fff9e7'
    for (const [x,y,n] of s.rows) context.fillRect(x,y,n,1.04)
    title(projects.find(a=>a.id===s.id)?.name ?? '',6,s.center.y,5.6,width-12)
    context.restore()
  }
  function paint() {
    cancelAnimationFrame(frame)
    context.clearRect(0,0,viewWidth,viewHeight)
    camera += (target-camera)*0.17
    const z = scale()
    if (!arranged || fly > 0.01) {
      context.save()
      context.translate(origin(),84-camera*z)
      context.scale(z,z)
      context.fillStyle = '#fff9e7'
      context.fillRect(0,0,width,row*projects.length)
      const start = Math.max(0,Math.floor((camera-84/z)/row))
      for(let i=start;i<Math.min(projects.length,start+Math.ceil(viewHeight/z/row)+2);i++){
        title(projects[i].name,6,i*row+row/2,5.6,width-12)
      }
      for(const cell of marks) context.clearRect(cell%width,Math.floor(cell/width),1,1)
      for(const slip of slips) for(const [x,y,n] of slip.rows) context.clearRect(x,y,n,1.02)
      context.restore()
    }
    for(const s of slips) {
      const p = position(s)
      const t = s===slips.at(-1) ? fly : 0
      const small = !s.place && dragging!==s.id ? dimensions()*.64 : dimensions()
      drawSlip(s,{x:p.x*(1-t)+(origin()+s.center.x*z)*t,y:p.y*(1-t)+(84+(s.center.y-camera)*z)*t},small+(z-small)*t)
    }
    fly *= .91
    if(Math.abs(target-camera)>.02 || fly>.005) frame=requestAnimationFrame(paint)
  }
  function cut(touchedRow: number) {
    const height = projects.length*row
    // Only a component separated from the remaining visible titles can leave the sheet.
    const pending = projects.map((p,i)=>({p,i})).filter(({p})=>!slips.some(s=>s.id===p.id))
    context.font = '5.6px "Bradley Hand", "Segoe Print", "Comic Sans MS", cursive'
    const ends = pending.map(({p})=>Math.floor(6+Math.min(width-12,context.measureText(p.name).width)))
    const seeds = pending.map(({i},j)=>(i*row+row/2)*width+Math.floor((6+ends[j])/2))
    const titleCells = new Set(seeds)
    for(const [index,seed] of seeds.entries()){
      if(Math.abs(pending[index].i - touchedRow)>1 || marks.has(seed)) continue
      const cells = new Set([seed]), queue=[seed]
      let large=false
      for(let j=0;j<queue.length;j++){
        const n=queue[j], x=n%width
        if(queue.length>width*row*2 || (n!==seed && titleCells.has(n))){large=true;break}
        for(const next of [x ? n-1:-1,x<width-1?n+1:-1,n-width,n+width]){
          if(next>=0 && next<width*height && !marks.has(next) && !cells.has(next)){cells.add(next);queue.push(next)}
        }
      }
      if(large) continue
      // The final title still needs a separating cut.
      if(pending.length===1 && queue.length + marks.size + slips.reduce((n,s)=>n+s.rows.reduce((a,r)=>a+r[2],0),0)>=width*height) continue
      const {i,p}=pending[index], y=i*row+row/2
      if(![6,ends[index]].every(x=>cells.has(y*width+x))) continue
      const rows:number[][]=[]
      for(const n of queue.sort((a,b)=>a-b)){
        const last=rows.at(-1), x=n%width, cy=Math.floor(n/width)
        if(last && last[1]===cy && last[0]+last[2]===x) last[2]++
        else rows.push([x,cy,1])
      }
      slips=[...slips,{id:p.id,center:{x:width/2,y},rows}]
      fly=1
      target=(projects.findIndex(p=>!slips.some(s=>s.id===p.id)) < 0 ? projects.length : projects.findIndex(p=>!slips.some(s=>s.id===p.id)))*row
      previous=null
      touching=false
      break
    }
  }
  function point(e: PointerEvent){const r=canvas.getBoundingClientRect();return {x:(e.clientX-r.left)*viewWidth/r.width,y:(e.clientY-r.top)*viewHeight/r.height}}
  function move(e: PointerEvent){
    const p=point(e)
    if(dragging){
      slips=slips.map(s=>s.id===dragging?{...s,place:{x:Math.min(1-width*dimensions()/2/viewWidth,Math.max(width*dimensions()/2/viewWidth,(p.x-offset.x)/viewWidth)),y:Math.min(1-row*dimensions()/2/viewHeight,Math.max(row*dimensions()/2/viewHeight,(p.y-offset.y)/viewHeight))}}:s)
    }else if(!arranged && fly<.1){
      const q={x:(p.x-origin())/scale(),y:(p.y-84)/scale()+camera}
      const from=previous??q
      const steps=Math.max(1,Math.ceil(Math.hypot(q.x-from.x,q.y-from.y)*2))
      let changed=false
      for(let i=1;i<=steps;i++){
        const x=Math.floor(from.x+(q.x-from.x)*i/steps), y=Math.floor(from.y+(q.y-from.y)*i/steps)
        if(x<0 || x>=width || y<0 || y>=projects.length*row){touching=false;continue}
        if(slips.some(s=>s.rows.some(([a,b,n])=>b===y && x>=a && x<a+n))){touching=false;continue}
        if(!touching) undo.push({marks:new Set(marks),slips:[...slips]})
        touching=true
        const n=y*width+x
        if(!marks.has(n)){marks.add(n);changed=true}
      }
      previous=q
      if(changed) cut(Math.floor(q.y/row))
    }
    paint()
  }
  function down(e:PointerEvent){
    if(!arranged){move(e);return}
    const p=point(e)
    const s=[...slips].reverse().find(s=>{const c=position(s),z=dimensions()*(s.place?1:.64);return s.rows.some(([x,y,n])=>{const a=(p.x-c.x)/z+s.center.x,b=(p.y-c.y)/z+s.center.y;return a>=x && a<x+n && b>=y && b<y+1})})
    if(!s)return
    dragging=s.id
    const c=position(s)
    offset={x:p.x-c.x,y:p.y-c.y}
    slips=[...slips.filter(a=>a!==s),s]
    canvas.setPointerCapture(e.pointerId)
    move(e)
  }
  onMount(()=>{
    context=canvas.getContext('2d')!
    const resize=new ResizeObserver(()=>{
      viewWidth=canvas.clientWidth;viewHeight=canvas.clientHeight
      const d=devicePixelRatio
      canvas.width=Math.round(viewWidth*d);canvas.height=Math.round(viewHeight*d)
      context.setTransform(d,0,0,d,0,0);paint()
    })
    resize.observe(canvas)
    function key(e:KeyboardEvent){
      if((e.metaKey || e.ctrlKey) && e.key.toLowerCase()==='z'){
        e.preventDefault();e.stopImmediatePropagation()
        const entry=undo.pop()
        if(entry){marks=entry.marks;slips=entry.slips;previous=null;touching=false;fly=0;target=Math.max(0,projects.findIndex(p=>!slips.some(s=>s.id===p.id)))*row;paint()}
      }
    }
    window.addEventListener('keydown',key,true)
    return ()=>{resize.disconnect();cancelAnimationFrame(frame);window.removeEventListener('keydown',key,true)}
  })
</script>
<div class="sort-view">
  <header><button class="ghost" on:click={onBack}>Back</button><h2>Sort</h2><span>{!projects.length?'No open projects':arranged?'Drag pieces from the pile':'Trace around each title'}</span></header>
  <canvas bind:this={canvas} aria-label="Project sorting tabletop" on:pointermove={move} on:pointerdown={down} on:pointerleave={()=>{previous=null;touching=false}} on:lostpointercapture={()=>dragging=''}></canvas>
</div>
<style>
 header {display:flex;align-items:center;gap:12px;margin-bottom:12px}
 header h2 {margin:0} header span {margin-left:auto;font-size:.85em}
 canvas {display:block;width:100%;height:clamp(320px,72dvh,900px);background:radial-gradient(at 35% 15%,#696056,#433e39);border-radius:10px;touch-action:none;cursor:crosshair}
</style>
