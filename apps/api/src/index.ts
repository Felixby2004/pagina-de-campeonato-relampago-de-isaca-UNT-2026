import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient, Rol, EstadoPartido, TipoEvento, EstadoActa, FaseTorneo } from '../../../node_modules/.prisma/mesa-client-v2/index.js';

const app = express();
const prisma = new PrismaClient();
app.use(cors()); app.use(express.json());
// Express 4 no reenvía automáticamente las promesas rechazadas por handlers async.
// Este adaptador mantiene viva la API y responde JSON si Neon no está sincronizado.
for (const method of ['get','post','put','patch','delete'] as const) {
  const register = app[method].bind(app) as (...args:any[])=>unknown;
  (app as any)[method] = (...args:any[]) => register(...args.map((handler:any) => typeof handler==='function'
    ? (req:any,res:any,next:any) => Promise.resolve(handler(req,res,next)).catch(next)
    : handler));
}
const secret = process.env.JWT_SECRET;
if (!secret) throw new Error('JWT_SECRET requerido');
const realtimeClients = new Set<any>();
function publishTournamentUpdate(matchId?:string){
  const packet=`event: tournament:update\ndata: ${JSON.stringify({matchId,at:Date.now()})}\n\n`;
  for(const client of realtimeClients){try{client.write(packet)}catch{realtimeClients.delete(client)}}
}
app.get('/api/realtime/events', (_req,res) => {
  res.status(200);res.setHeader('Content-Type','text/event-stream; charset=utf-8');res.setHeader('Cache-Control','no-cache, no-transform');res.setHeader('Connection','keep-alive');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();
  realtimeClients.add(res);res.write('retry: 1200\nevent: ready\ndata: {}\n\n');
  const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': keepalive\n\n')},20000);
  res.on('close',()=>{clearInterval(heartbeat);realtimeClients.delete(res)});
});
// Publica una invalidación tras completar cualquier escritura; los clientes consultan el snapshot actualizado por REST.
app.use((req,res,next)=>{res.on('finish',()=>{if(['POST','PUT','PATCH','DELETE'].includes(req.method)&&res.statusCode>=200&&res.statusCode<300&&req.path.startsWith('/api/')&&!req.path.includes('/auth/')){const matchId=req.params?.id;publishTournamentUpdate(typeof matchId==='string'?matchId:undefined)}});next()});
const getClockSeconds = (match: { relojSegundos: number; relojIniciadoEn: Date | null; estado: EstadoPartido }, now = Date.now()) =>
  match.relojSegundos + (match.estado === EstadoPartido.EN_JUEGO && match.relojIniciadoEn ? Math.max(0, Math.floor((now - match.relojIniciadoEn.getTime()) / 1000)) : 0);
const withClock = <T extends { relojSegundos: number; relojIniciadoEn: Date | null; estado: EstadoPartido }>(match: T) => {const serverTime=Date.now();return { ...match, clockSeconds: getClockSeconds(match,serverTime), clockServerTime:serverTime }};
async function withExpiredClockStopped<T extends { id:string; estado:EstadoPartido; relojSegundos:number; relojIniciadoEn:Date|null; periodoActual:number; duracionPrimerTiempo:number; duracionSegundoTiempo:number; primerTiempoTranscurrido:number }>(match:T){
  const now=Date.now(),elapsed=getClockSeconds(match,now),periodElapsed=match.periodoActual===2?elapsed-match.primerTiempoTranscurrido:elapsed,duration=match.periodoActual===2?match.duracionSegundoTiempo:match.duracionPrimerTiempo;
  if(match.estado!==EstadoPartido.EN_JUEGO||duration-periodElapsed>0)return withClock(match);
  const changed=await prisma.partido.updateMany({where:{id:match.id,estado:EstadoPartido.EN_JUEGO},data:{estado:EstadoPartido.DESCANSO,relojSegundos:elapsed,relojIniciadoEn:null,minutoActual:Math.floor(elapsed/60)}});
  if(!changed.count)return withClock(await prisma.partido.findUniqueOrThrow({where:{id:match.id}}));
  return withClock({...match,estado:EstadoPartido.DESCANSO,relojSegundos:elapsed,relojIniciadoEn:null});
}
type Claims = { sub: string; rol: Rol };
const auth = (req: any, res: any, next: any) => {
  try { req.user = jwt.verify((req.headers.authorization || '').replace(/^Bearer /, ''), secret) as Claims; next(); }
  catch { res.status(401).json({ error: 'Sesión inválida' }); }
};
const allow = (...roles: Rol[]) => (req: any, res: any, next: any) => roles.includes(req.user.rol) ? next() : res.status(403).json({ error: 'Sin permisos' });
const operators = [Rol.PLANILLERO, Rol.ADMIN_MESA];
function shootoutWinner(match:{penalesHechosLocal:number;penalesHechosVisita:number;penalesLocal:number;penalesVisita:number;equipoLocalId:string|null;equipoVisitaId:string|null}){
  if(Math.min(match.penalesHechosLocal,match.penalesHechosVisita)<3){
    const remainingLocal=Math.max(0,3-match.penalesHechosLocal),remainingVisit=Math.max(0,3-match.penalesHechosVisita);
    if(match.penalesLocal>match.penalesVisita+remainingVisit)return match.equipoLocalId;
    if(match.penalesVisita>match.penalesLocal+remainingLocal)return match.equipoVisitaId;
  }
  if(match.penalesHechosLocal===match.penalesHechosVisita&&match.penalesHechosLocal>=3&&match.penalesLocal!==match.penalesVisita)return match.penalesLocal>match.penalesVisita?match.equipoLocalId:match.equipoVisitaId;
  return null;
}
function bracketOrder<T extends {numeroEnFase:number;programadoPara:Date|null;cancha:number;id:string}>(matches:T[]){
  const numbers=matches.map(match=>match.numeroEnFase);
  const numbered=new Set(numbers).size===matches.length&&numbers.every(number=>Number.isInteger(number)&&number>=1&&number<=matches.length);
  return [...matches].sort((a,b)=>numbered?a.numeroEnFase-b.numeroEnFase:(a.programadoPara?.getTime()??Number.MAX_SAFE_INTEGER)-(b.programadoPara?.getTime()??Number.MAX_SAFE_INTEGER)||a.cancha-b.cancha||a.id.localeCompare(b.id));
}
async function recalculateScore(matchId: string) {
  const [match, events] = await Promise.all([prisma.partido.findUnique({where:{id:matchId}}), prisma.evento.findMany({where:{partidoId:matchId, tipo:TipoEvento.GOL}})]);
  if (!match || match.esWO) return;
  const local = events.filter(e=>e.equipo===match.equipoLocal).length;
  const visita = events.filter(e=>e.equipo===match.equipoVisita).length;
  await prisma.partido.update({where:{id:matchId},data:{golesLocal:local,golesVisita:visita}});
}

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  const user = await prisma.usuario.findUnique({ where: { username } });
  if (!user?.activo || !await bcrypt.compare(password ?? '', user.passwordHash)) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  const token = jwt.sign({ sub: user.id, rol: user.rol }, secret, { expiresIn: '10h' });
  res.json({ token, user: { id: user.id, username: user.username, rol: user.rol } });
});

app.get('/api/public/live', async (_req, res) => {
  const rows = await prisma.partido.findMany({ orderBy: [{ programadoPara: 'asc' }, { cancha: 'asc' }], include: { eventos: { orderBy: { creadoEn: 'desc' }, select:{id:true,tipo:true,minuto:true,segundo:true,equipo:true,creadoEn:true} }, ganador:{select:{id:true,nombre:true}} } });
  const partidos = await Promise.all(rows.map(withExpiredClockStopped));
  res.setHeader('Cache-Control', 'no-store'); res.json({ partidos });
});
app.get('/api/public/canchas', async (_req,res) => {
  const saved=await prisma.imagenCancha.findMany({orderBy:{cancha:'asc'}});
  res.setHeader('Cache-Control','no-store');res.json([1,2,3,4].map(cancha=>saved.find(item=>item.cancha===cancha)??{cancha,url:null}));
});
app.get('/api/public/canchas/:cancha/image', async (req,res) => {
  const cancha=Number(req.params.cancha);if(![1,2,3,4].includes(cancha))return res.sendStatus(404);
  const saved=await prisma.imagenCancha.findUnique({where:{cancha}});if(!saved?.url)return res.sendStatus(404);
  let id:string|null=null;
  try{const url=new URL(saved.url);if(url.hostname!=='drive.google.com')return res.status(415).json({error:'La imagen guardada no es un enlace de Google Drive.'});id=url.pathname.match(/\/file\/d\/([^/]+)/)?.[1]||url.searchParams.get('id')}catch{return res.status(400).json({error:'El enlace de Drive guardado no es válido.'})}
  if(!id||!/^[\w-]+$/.test(id))return res.status(400).json({error:'No se encontró el identificador del archivo de Drive.'});
  const urls=[`https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}&confirm=t`,`https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w1600`,`https://lh3.googleusercontent.com/d/${encodeURIComponent(id)}`];
  for(const source of urls){
    try{
      const upstream=await fetch(source,{redirect:'follow',headers:{'Accept':'image/avif,image/webp,image/apng,image/*,*/*;q=0.8','User-Agent':'Mozilla/5.0'}});
      if(!upstream.ok)continue;
      const bytes=Buffer.from(await upstream.arrayBuffer());if(!bytes.length||bytes.length>15*1024*1024)continue;
      let contentType=(upstream.headers.get('content-type')||'').split(';')[0].toLowerCase();
      if(!contentType.startsWith('image/')){
        if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)contentType='image/jpeg';
        else if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))contentType='image/png';
        else if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')contentType='image/webp';
        else if(bytes.subarray(0,6).toString().startsWith('GIF8'))contentType='image/gif';
      }
      if(!contentType.startsWith('image/'))continue;
      res.setHeader('Content-Type',contentType);res.setHeader('Cache-Control','public, max-age=300, s-maxage=300');res.setHeader('X-Content-Type-Options','nosniff');return res.send(bytes);
    }catch{}
  }
  res.status(502).json({error:'Drive no entregó el archivo como imagen. Comprueba que sea un JPG/PNG público y guarda de nuevo el enlace.'});
});
app.get('/api/matches/operations', auth, allow(...operators), async (_req,res) => res.json(await Promise.all((await prisma.partido.findMany({orderBy:[{programadoPara:'asc'},{cancha:'asc'}],include:{eventos:{orderBy:{creadoEn:'asc'}}}})).map(withExpiredClockStopped))));
app.get('/api/public/equipos', async (_req,res) => res.json(await prisma.equipo.findMany({where:{activo:true},select:{id:true,nombre:true,delegado:true,eliminado:true},orderBy:{nombre:'asc'}})));
app.post('/api/admin/equipos', auth, allow(Rol.ADMIN_MESA), async (req,res) => {
  const nombre=String(req.body?.nombre??'').trim(),delegado=String(req.body?.delegado??'').trim();
  if(!nombre||nombre.length>60)return res.status(400).json({error:'El nombre debe tener entre 1 y 60 caracteres.'});
  if(!delegado||delegado.length>100)return res.status(400).json({error:'Ingresa el nombre del delegado (máximo 100 caracteres).'});
  if(await prisma.equipo.count({where:{activo:true}})>=32)return res.status(409).json({error:'El torneo ya tiene los 32 equipos registrados.'});
  if(await prisma.partido.count({where:{estado:{in:[EstadoPartido.EN_JUEGO,EstadoPartido.DESCANSO,EstadoPartido.FINALIZADO,EstadoPartido.VALIDADO]}}}))return res.status(409).json({error:'No se inscriben nuevos equipos una vez iniciado el torneo.'});
  try{res.status(201).json(await prisma.equipo.create({data:{nombre,delegado}}));}catch{res.status(409).json({error:'Ya existe un equipo con ese nombre.'});}
});
app.put('/api/admin/canchas/:cancha/image', auth, allow(Rol.ADMIN_MESA), async (req,res) => {
  const cancha=Number(req.params.cancha),raw=String(req.body?.url??'').trim();
  if(![1,2,3,4].includes(cancha))return res.status(400).json({error:'Cancha inválida.'});
  let url:string|null=null;
  if(raw){
    try{
      const parsed=new URL(raw);if(parsed.protocol!=='https:')throw new Error();
      if(parsed.hostname==='drive.google.com'){
        const id=parsed.pathname.match(/\/file\/d\/([^/]+)/)?.[1]||parsed.searchParams.get('id');
        if(!id)return res.status(400).json({error:'Pega un enlace de Drive a un archivo de imagen.'});
        url=`https://drive.google.com/uc?export=view&id=${encodeURIComponent(id)}`;
      }else if(parsed.hostname==='lh3.googleusercontent.com'||parsed.hostname==='drive.googleusercontent.com')url=parsed.toString();
      else return res.status(400).json({error:'Usa un enlace de imagen de Google Drive.'});
    }catch{return res.status(400).json({error:'El enlace debe ser una URL HTTPS válida de Google Drive.'});}
  }
  res.json(await prisma.imagenCancha.upsert({where:{cancha},create:{cancha,url},update:{url}}));
});
app.post('/api/admin/round-of-32', auth, allow(Rol.ADMIN_MESA), async (req,res) => {
  const entries=req.body?.partidos;
  if(!Array.isArray(entries)||entries.length!==16)return res.status(400).json({error:'Debes definir manualmente los 16 partidos de Dieciseisavos.'});
  if(await prisma.partido.count())return res.status(409).json({error:'Ya existe un fixture; no se puede volver a cargar Dieciseisavos.'});
  const teams=await prisma.equipo.findMany({where:{activo:true,eliminado:false},select:{id:true,nombre:true}});
  if(teams.length!==32)return res.status(409).json({error:'Registra exactamente 32 equipos antes de programar Dieciseisavos.'});
  const byId=new Map(teams.map(team=>[team.id,team]));
  const used:string[]=[];
  const normalized:any[]=[];
  for(const [index,row] of entries.entries()){
    const local=byId.get(String(row?.equipoLocalId??'')),visita=byId.get(String(row?.equipoVisitaId??''));
    const cancha=Number(row?.cancha),programadoPara=new Date(row?.programadoPara??'');
    if(!local||!visita||local.id===visita.id)return res.status(400).json({error:`Partido ${index+1}: elige dos equipos distintos del torneo.`});
    if(![1,2,3,4].includes(cancha))return res.status(400).json({error:`Partido ${index+1}: elige una cancha válida.`});
    if(Number.isNaN(programadoPara.getTime()))return res.status(400).json({error:`Partido ${index+1}: indica fecha y hora.`});
    used.push(local.id,visita.id);
    normalized.push({cancha,equipoLocal:local.nombre,equipoVisita:visita.nombre,equipoLocalId:local.id,equipoVisitaId:visita.id,programadoPara,fase:FaseTorneo.RONDA_32,numeroEnFase:index+1});
  }
  if(new Set(used).size!==32)return res.status(400).json({error:'Cada uno de los 32 equipos debe aparecer exactamente una vez en los Dieciseisavos.'});
  for(const cancha of [1,2,3,4]){
    const schedule=normalized.filter(match=>match.cancha===cancha).sort((a,b)=>a.programadoPara.getTime()-b.programadoPara.getTime());
    for(let i=1;i<schedule.length;i++)if(schedule[i].programadoPara.getTime()-schedule[i-1].programadoPara.getTime()<27*60*1000)return res.status(400).json({error:`Cancha ${cancha}: deja al menos 27 minutos entre partidos consecutivos.`});
  }
  const created=await prisma.$transaction(normalized.map(data=>prisma.partido.create({data})));
  res.status(201).json({cantidad:created.length,partidos:created});
});app.get('/api/me', auth, (req:any,res) => res.json(req.user));

app.post('/api/admin/matches', auth, allow(Rol.ADMIN_MESA), async (req,res) => {
  const { programadoPara, fase } = req.body ?? {};
  if(!Object.values(FaseTorneo).includes(fase))return res.status(400).json({error:'Selecciona una fase válida del torneo.'});
  if(fase===FaseTorneo.RONDA_32)return res.status(400).json({error:'Dieciseisavos se carga desde el sorteo manual de 16 partidos.'});
  const scheduled=programadoPara?new Date(programadoPara):null;
  if(!scheduled||Number.isNaN(scheduled.getTime()))return res.status(400).json({error:'Indica el día y la hora del partido.'});
  const matchLimits:Record<string,number>={OCTAVOS:8,CUARTOS:4,SEMIFINAL:2,TERCER_PUESTO:1,FINAL:1};
  const nextNumber=Number(req.body?.numeroEnFase);
  if(!Number.isInteger(nextNumber)||nextNumber<1||nextNumber>matchLimits[fase])return res.status(400).json({error:'El número de partido de la fase no es válido.'});
  const cancha=Number(req.body?.cancha);
  if(!Number.isInteger(cancha)||cancha<1||cancha>4)return res.status(400).json({error:'Selecciona una cancha válida del 1 al 4.'});
  if(await prisma.partido.findFirst({where:{fase,numeroEnFase:nextNumber}}))return res.status(409).json({error:'Ese partido de la fase ya fue programado.'});
  const priorPhase:Record<string,FaseTorneo>={OCTAVOS:FaseTorneo.RONDA_32,CUARTOS:FaseTorneo.OCTAVOS,SEMIFINAL:FaseTorneo.CUARTOS,TERCER_PUESTO:FaseTorneo.SEMIFINAL,FINAL:FaseTorneo.SEMIFINAL};
  const priorExpected:Record<string,number>={RONDA_32:16,OCTAVOS:8,CUARTOS:4,SEMIFINAL:2};
  const prior=bracketOrder(await prisma.partido.findMany({where:{fase:priorPhase[fase]}}));
  if(prior.length!==priorExpected[priorPhase[fase]]||prior.some(m=>m.estado!==EstadoPartido.VALIDADO||!m.ganadorId))return res.status(409).json({error:'Completa y valida todos los partidos de la fase anterior antes de programar esta ronda.'});
  let first:{id:string|null;nombre:string}|undefined,second:{id:string|null;nombre:string}|undefined;
  const teamFromMatch=(match:any,winner:boolean)=>{
    const localWon=match.ganadorId===match.equipoLocalId;
    const useLocal=winner?localWon:!localWon;
    return {id:useLocal?match.equipoLocalId:match.equipoVisitaId,nombre:useLocal?match.equipoLocal:match.equipoVisita};
  };
  if(fase==='FINAL'||fase==='TERCER_PUESTO'){
    const [firstSemi,secondSemi]=prior;
    first=teamFromMatch(firstSemi,fase==='FINAL');second=teamFromMatch(secondSemi,fase==='FINAL');
  }else{
    const left=prior[nextNumber*2-2],right=prior[nextNumber*2-1];
    if(left&&right){first=teamFromMatch(left,true);second=teamFromMatch(right,true)}
  }
  if(!first?.id||!second?.id||!first.nombre||!second.nombre)return res.status(409).json({error:'No se pudieron determinar automáticamente los equipos clasificados de este cruce. Revisa el ganador y los equipos del acta validada.'});
  const courtSchedule=await prisma.partido.findMany({where:{cancha,programadoPara:{not:null}},select:{programadoPara:true,fase:true}});
  const duration=(round:FaseTorneo)=>(['SEMIFINAL','FINAL'].includes(round)?37:27)*60*1000;
  if(courtSchedule.some(p=>Math.abs(p.programadoPara!.getTime()-scheduled.getTime())<Math.max(duration(p.fase),duration(fase))))return res.status(409).json({error:'Deja 2 minutos de margen después de la duración programada del partido en esa cancha.'});
  if(await prisma.partido.findFirst({where:{cancha,programadoPara:scheduled}}))return res.status(409).json({error:'Ya hay un partido programado en esa cancha a esa hora.'});
  const match = await prisma.partido.create({ data: { cancha, equipoLocal: first.nombre, equipoVisita: second.nombre, equipoLocalId:first.id, equipoVisitaId:second.id, programadoPara:scheduled, fase,numeroEnFase:nextNumber } });
  res.status(201).json(match);
});

app.post('/api/matches/:id/events', auth, async (req:any,res) => {
  const match = await prisma.partido.findUnique({ where:{id:req.params.id} });
  if (!match) return res.status(404).json({error:'Partido no encontrado'});
  if (!operators.includes(req.user.rol)) return res.status(403).json({error:'No tienes permiso para registrar eventos'});
  if (match.estado === EstadoPartido.VALIDADO) return res.status(409).json({error:'El acta ya se envió y quedó cerrada.'});
  if (match.esWO) return res.status(409).json({error:'Un partido por W.O. no admite nuevas incidencias.'});
  if (!match.horaInicio) return res.status(409).json({error:'Inicia el partido antes de registrar goles o tarjetas.'});
  const { tipo, minuto, segundo, equipo } = req.body ?? {};
  const jugador = String(req.body?.jugador ?? '').trim() || 'Sin especificar';
  if (!Object.values(TipoEvento).includes(tipo) || tipo === TipoEvento.CAMBIO || !Number.isInteger(minuto) || minuto < 0 || !Number.isInteger(segundo) || segundo < 0 || segundo > 59 || ![match.equipoLocal,match.equipoVisita].includes(equipo)) return res.status(400).json({error:'Evento inválido'});
  const event = await prisma.$transaction(async tx => {
    const created = await tx.evento.create({data:{partidoId:match.id,tipo,minuto,segundo,jugador,equipo}});
    await tx.partido.update({where:{id:match.id},data:{minutoActual:minuto}});
    return created;
  });
  await recalculateScore(match.id);
  res.status(201).json(event);
});
app.patch('/api/matches/:id/events/:eventId', auth, async (req:any,res) => {
  if (!operators.includes(req.user.rol)) return res.sendStatus(403);
  const match=await prisma.partido.findUnique({where:{id:req.params.id}}); if(!match)return res.sendStatus(404);
  if(match.estado===EstadoPartido.VALIDADO)return res.status(409).json({error:'El acta ya fue enviada.'});
  const event=await prisma.evento.findFirst({where:{id:req.params.eventId,partidoId:match.id}});if(!event)return res.sendStatus(404);
  const tipo=req.body?.tipo??event.tipo, equipo=req.body?.equipo??event.equipo, jugador=String(req.body?.jugador??event.jugador).trim()||'Sin especificar';
  const minuto=req.body?.minuto??event.minuto, segundo=req.body?.segundo??event.segundo;
  if(!Object.values(TipoEvento).includes(tipo)||tipo===TipoEvento.CAMBIO||![match.equipoLocal,match.equipoVisita].includes(equipo)||!Number.isInteger(minuto)||minuto<0||!Number.isInteger(segundo)||segundo<0||segundo>59)return res.status(400).json({error:'Incidencia inválida.'});
  const updated=await prisma.evento.update({where:{id:event.id},data:{tipo,equipo,jugador,minuto,segundo}});await recalculateScore(match.id);res.json(updated);
});
app.delete('/api/matches/:id/events/:eventId', auth, async (req:any,res) => {
  if (!operators.includes(req.user.rol)) return res.sendStatus(403);
  const match=await prisma.partido.findUnique({where:{id:req.params.id}});if(!match)return res.sendStatus(404);
  if(match.estado===EstadoPartido.VALIDADO)return res.status(409).json({error:'El acta ya fue enviada.'});
  const event=await prisma.evento.findFirst({where:{id:req.params.eventId,partidoId:match.id}});if(!event)return res.sendStatus(404);
  await prisma.evento.delete({where:{id:event.id}});await recalculateScore(match.id);res.sendStatus(204);
});
app.patch('/api/matches/:id/wo', auth, async (req:any,res) => {
  if(!operators.includes(req.user.rol))return res.sendStatus(403);
  const match=await prisma.partido.findUnique({where:{id:req.params.id}});if(!match)return res.sendStatus(404);
  if(match.estado===EstadoPartido.VALIDADO)return res.status(409).json({error:'El acta ya fue enviada.'});
  const absent=String(req.body?.equipoAusenteId??'');
  if(!match.equipoLocalId||!match.equipoVisitaId||![match.equipoLocalId,match.equipoVisitaId].includes(absent))return res.status(400).json({error:'Selecciona cuál equipo no se presentó.'});
  const localAbsent=absent===match.equipoLocalId,now=new Date();
  const updated=await prisma.$transaction(async tx=>{
    await tx.evento.deleteMany({where:{partidoId:match.id}});
    return tx.partido.update({where:{id:match.id},data:{esWO:true,woAusenteId:absent,ganadorId:localAbsent?match.equipoVisitaId:match.equipoLocalId,golesLocal:0,golesVisita:0,estado:EstadoPartido.FINALIZADO,relojSegundos:getClockSeconds(match,now.getTime()),relojIniciadoEn:null}});
  });
  res.json(withClock(updated));
});
app.patch('/api/matches/:id/durations', auth, async (req:any,res) => {
  if(!operators.includes(req.user.rol))return res.sendStatus(403);
  const match=await prisma.partido.findUnique({where:{id:req.params.id}});if(!match)return res.sendStatus(404);
  if(match.estado===EstadoPartido.EN_JUEGO||match.estado===EstadoPartido.VALIDADO)return res.status(409).json({error:'Pausa el partido antes de cambiar las duraciones.'});
  const first=Number(req.body?.primerTiempoMinutos),second=Number(req.body?.segundoTiempoMinutos);
  if(!Number.isInteger(first)||first<1||first>90||!Number.isInteger(second)||second<1||second>90)return res.status(400).json({error:'Cada tiempo debe durar entre 1 y 90 minutos.'});
  res.json(await prisma.partido.update({where:{id:match.id},data:{duracionPrimerTiempo:first*60,duracionSegundoTiempo:second*60}}));
});
app.patch('/api/matches/:id/state', auth, async (req:any,res) => {
  const match=await prisma.partido.findUnique({where:{id:req.params.id}}); if(!match)return res.sendStatus(404);
  if(![Rol.PLANILLERO,Rol.ADMIN_MESA].includes(req.user.rol))return res.sendStatus(403);
  if(![EstadoPartido.EN_JUEGO,EstadoPartido.DESCANSO,EstadoPartido.FINALIZADO].includes(req.body.estado))return res.status(400).json({error:'Estado inválido'});
  if(match.estado===EstadoPartido.VALIDADO)return res.status(409).json({error:'El acta ya fue enviada y el partido está cerrado.'});
  const now=new Date(); const data:any={estado:req.body.estado};
  const requestedPeriod=req.body.periodoActual===2?2:req.body.periodoActual===1?1:match.periodoActual;
  if(req.body.estado===EstadoPartido.EN_JUEGO&&match.estado!==EstadoPartido.EN_JUEGO){
    data.relojIniciadoEn=now;if(!match.horaInicio)data.horaInicio=now;
    if(!match.horaInicio)data.periodoActual=1;
    else if(requestedPeriod!==match.periodoActual){
      if(requestedPeriod===2&&match.periodoActual===1)data.primerTiempoTranscurrido=getClockSeconds(match,now.getTime());
      data.periodoActual=requestedPeriod;
    }
  }
  if([EstadoPartido.DESCANSO,EstadoPartido.FINALIZADO].includes(req.body.estado)&&match.estado===EstadoPartido.EN_JUEGO){const seconds=getClockSeconds(match,now.getTime());data.relojSegundos=seconds;data.minutoActual=Math.floor(seconds/60);data.relojIniciadoEn=null;}
  res.json(withClock(await prisma.partido.update({where:{id:match.id},data})));
});
app.post('/api/matches/:id/penales', auth, async (req:any,res) => {
  if(!operators.includes(req.user.rol))return res.sendStatus(403);
  const match=await prisma.partido.findUnique({where:{id:req.params.id}});if(!match)return res.sendStatus(404);
  if(match.estado===EstadoPartido.VALIDADO)return res.status(409).json({error:'El acta ya fue enviada.'});
  if(match.estado!==EstadoPartido.FINALIZADO||match.esWO||match.golesLocal!==match.golesVisita)return res.status(409).json({error:'La tanda se registra tras finalizar empatado el tiempo de juego.'});
  if(match.ganadorId||shootoutWinner(match))return res.status(409).json({error:'La tanda ya tiene ganador por diferencia irremontable.'});
  const equipoId=String(req.body?.equipoId??''),local=equipoId===match.equipoLocalId;
  if(!local&&equipoId!==match.equipoVisitaId)return res.status(400).json({error:'Selecciona un equipo del partido.'});
  const attemptsLocal=match.penalesHechosLocal,attemptsAway=match.penalesHechosVisita;
  const goalsLocal=match.penalesLocal,goalsAway=match.penalesVisita;
  if(Math.max(attemptsLocal,attemptsAway)>=3&&Math.min(attemptsLocal,attemptsAway)<3)return res.status(409).json({error:'Completa los tres tiros por equipo antes de la muerte súbita.'});
  if((local&&attemptsLocal>attemptsAway)||(!local&&attemptsAway>attemptsLocal))return res.status(409).json({error:'La tanda debe alternar los tiros entre ambos equipos.'});
  const nextLocal=attemptsLocal+(local?1:0),nextAway=attemptsAway+(local?0:1),converted=Boolean(req.body?.convertido);
  const scoreLocal=goalsLocal+(local&&converted?1:0),scoreAway=goalsAway+(!local&&converted?1:0);
  const winnerId=shootoutWinner({...match,penalesHechosLocal:nextLocal,penalesHechosVisita:nextAway,penalesLocal:scoreLocal,penalesVisita:scoreAway});
  res.json(await prisma.partido.update({where:{id:match.id},data:{penalesHechosLocal:nextLocal,penalesHechosVisita:nextAway,penalesLocal:scoreLocal,penalesVisita:scoreAway,ganadorId:winnerId}}));
});
app.post('/api/matches/:id/submit', auth, async (req:any,res) => {
  const match=await prisma.partido.findUnique({where:{id:req.params.id}}); if(!match)return res.sendStatus(404);
  if(!operators.includes(req.user.rol))return res.sendStatus(403);
  if(match.estado===EstadoPartido.VALIDADO)return res.status(409).json({error:'Este partido ya tiene un acta enviada.'});
  if(match.esWO&&!match.ganadorId)return res.status(409).json({error:'Selecciona el equipo ausente para registrar el ganador por W.O.'});
  const penaltyWinner=!match.esWO&&match.golesLocal===match.golesVisita?shootoutWinner(match):null;
  if(!match.esWO&&match.golesLocal===match.golesVisita&&!match.ganadorId&&!penaltyWinner)return res.status(409).json({error:'El partido está empatado: completa la tanda de penales y, si continúa el empate, la muerte súbita.'});
  const winnerId=match.ganadorId||penaltyWinner||(match.golesLocal>match.golesVisita?match.equipoLocalId:match.equipoVisitaId);
  const loserId=winnerId===match.equipoLocalId?match.equipoVisitaId:match.equipoLocalId;
  const now=new Date(); const seconds=getClockSeconds(match,now.getTime());
  const acta=await prisma.$transaction(async tx=>{
    const saved=await tx.acta.create({data:{partidoId:match.id,usuarioId:req.user.sub,estado:EstadoActa.APROBADA,revisadaEn:now}});
    await tx.partido.update({where:{id:match.id},data:{ganadorId:winnerId,estado:EstadoPartido.VALIDADO,relojSegundos:seconds,minutoActual:Math.floor(seconds/60),relojIniciadoEn:null}});
    if(loserId&&match.fase!=='SEMIFINAL')await tx.equipo.update({where:{id:loserId},data:{eliminado:true}});
    if(match.fase==='TERCER_PUESTO'&&loserId)await tx.equipo.update({where:{id:loserId},data:{eliminado:true}});
    return saved;
  });
  res.status(201).json(acta);
});
app.get('/api/admin/actas', auth, allow(...operators), async (_req,res) => res.json(await prisma.acta.findMany({where:{estado:EstadoActa.ENVIADA},include:{partido:{include:{eventos:true}},usuario:{select:{username:true}}},orderBy:{enviadaEn:'asc'}})));
app.patch('/api/admin/actas/:id', auth, allow(Rol.ADMIN_MESA), async (req,res) => {
  const { decision, comentario }=req.body??{}; if(!['APROBADA','OBSERVADA'].includes(decision))return res.status(400).json({error:'Decisión inválida'});
  const acta=await prisma.acta.update({where:{id:req.params.id},data:{estado:decision,comentario,revisadaEn:new Date()},include:{partido:true}});
  if(decision==='APROBADA')await prisma.partido.update({where:{id:acta.partidoId},data:{estado:EstadoPartido.VALIDADO}});
  res.json(acta);
});

app.use((error:any,_req:any,res:any,_next:any) => {
  const code=String(error?.code||''),message=String(error?.message||'');
  if(code==='P1001'||/Can't reach database server/i.test(message)){
    console.error('Neon no está disponible para la API.');
    return res.status(503).json({error:'No hay conexión con Neon. Revisa que el proyecto/endpoint esté activo y que DATABASE_URL apunte a la rama correcta.'});
  }
  if(code!=='P2021')console.error('API request failed:',code||message||error);
  return res.status(500).json({error:code==='P2021'?'Falta sincronizar el esquema de Prisma con la base configurada.':'Error al consultar la base de datos.'});
});
// En Vercel se exporta el handler Express; localmente mantiene viva la conexión SSE.
if (process.env.VERCEL !== '1') { const port=Number(process.env.PORT)||3000; app.listen(port,()=>console.log(`API lista en :${port} · SSE listo`)); }
export default app;
